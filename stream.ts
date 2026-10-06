/**
 * The streaming engine: turns one pi request into a Command Code request
 * and emits pi's `AssistantMessageEvent`s back.
 *
 * The one non-obvious behaviour is the transport fallback. Command Code
 * grants Provider API access to every plan *except Go*; a Go account gets
 * HTTP 403 `upgrade_required` from `/provider/v1/*` and is only entitled to
 * the CLI gateway. So a request first tries the documented Provider API and,
 * on exactly that rejection, is rebuilt for `/alpha/generate` and replayed.
 * No other status triggers the fallback — that would mask real errors.
 */
import {
	calculateCost,
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type Usage,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { systemTextFor, toCliMessages, toOpenAiMessages, toolsFor } from "./convert.ts";
import {
	buildCliBody,
	buildOpenAiBody,
	cliHeaders,
	CLI_MAX_OUTPUT_TOKENS,
	CommandCodeHttpError,
	endpointFor,
	isRecord,
	isUpgradeRequiredError,
	MAX_ACCOUNT_ROTATIONS,
	mapFinishReason,
	numberValue,
	openAiHeaders,
	parseRetryAfterMs,
	parseStreamLine,
	stringValue,
	type CliMessage,
	type OpenAiMessage,
	type RequestFacts,
	type Transport,
} from "./wire.ts";

/** Everything the engine needs from the plugin at request time. */
export interface StreamDeps {
	/** Current working directory, reported to the CLI gateway. */
	workingDir: () => string;
	/** Resolve a usable API key, honouring the account pool. */
	resolveAccount: (model: string) => Promise<{ key: string; slotId: string }>;
	/** Record a rejection and return the next key to try, if any. */
	rotateAccount: (
		rejectedKey: string,
		rejection: "invalid-credential" | "rate-limit",
		model: string,
	) => Promise<{ key: string; slotId: string } | undefined>;
	/** Cached transport decision for a key, if still fresh. */
	cachedTransport: (key: string) => Transport | undefined;
	/** Remember the transport that worked for a key. */
	rememberTransport: (key: string, transport: Transport) => void;
	/** Model metadata from the live catalog (max output tokens). */
	modelMaxTokens: (model: string) => number | undefined;
	/** Stream idle timeout in milliseconds. */
	streamIdleTimeoutMs: () => number;
	/** Head-of-request timeout in milliseconds. */
	requestTimeoutMs: () => number;
	/** The `x-command-code-version` value to send; refreshed from npm. */
	cliVersion: () => string;
}

/** Mutable accumulator while a stream is assembled. */
interface Assembler {
	nextIndex: number;
	textIndex: number;
	textContent: string;
	reasoningIndex: number;
	reasoningContent: string;
	sawContent: boolean;
	openAiToolCalls: { index: number; id?: string; name: string; arguments: string }[];
	usage: Usage | undefined;
	stopReason: "stop" | "length" | "toolUse" | undefined;
}

function createAssembler(): Assembler {
	return {
		nextIndex: 0,
		textIndex: -1,
		textContent: "",
		reasoningIndex: -1,
		reasoningContent: "",
		sawContent: false,
		openAiToolCalls: [],
		usage: undefined,
		stopReason: undefined,
	};
}

/**
 * Optional wire capture for debugging. `COMMANDCODE_DEBUG_DUMP=<dir>` appends
 * every request body (`request-<pid>.json`) and every raw stream line
 * (`stream-<pid>.ndjson`) to that directory. Without it the only evidence of
 * a bad response is pi's decoded message, which cannot distinguish "the
 * gateway sent no tool call" from "the adapter dropped one".
 */
const DEBUG_DUMP_DIR = process.env.COMMANDCODE_DEBUG_DUMP?.trim();

function capture(name: string, text: string): void {
	if (!DEBUG_DUMP_DIR) return;
	try {
		mkdirSync(DEBUG_DUMP_DIR, { recursive: true });
		appendFileSync(join(DEBUG_DUMP_DIR, name), text.endsWith("\n") ? text : `${text}\n`);
	} catch {
		// Capture is diagnostic only: it must never break a request.
	}
}

/** Empty usage record so partial messages always have a complete shape. */
function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * Resolve which transport to try first. A remembered decision wins; a Go
 * account (detected from cached billing) is known to be CLI-only; anything
 * unknown starts on the documented Provider API and falls back on demand.
 */
export function initialTransport(deps: StreamDeps, apiKey: string, isGoTier: boolean): Transport {
	const cached = deps.cachedTransport(apiKey);
	if (cached !== undefined) return cached;
	if (isGoTier) return "cli";
	return "openai";
}

/**
 * Run one request against one transport, returning the live response once
 * its headers have arrived. A non-2xx response is returned as facts rather
 * than thrown, because the caller has to classify it (the Go-plan gate is a
 * 403 that means "retry the other transport", not "fail").
 */
async function connect(
	deps: StreamDeps,
	apiKey: string,
	transport: Transport,
	body: Record<string, unknown>,
	apiBase: string,
	signal: AbortSignal | undefined,
): Promise<{ response: Response } | { status: number; bodyText: string; retryAfterMs?: number }> {
	const endpoint = endpointFor(transport, apiBase);
	const connectAbort = new AbortController();
	let connectTimedOut = false;
	const timeoutMs = deps.requestTimeoutMs();
	const timer = setTimeout(() => {
		connectTimedOut = true;
		connectAbort.abort(new Error(`Command Code API 请求超时（${timeoutMs}ms）`));
	}, timeoutMs);
	const onCallerAbort = () => connectAbort.abort(signal?.reason);
	if (signal) {
		if (signal.aborted) onCallerAbort();
		else signal.addEventListener("abort", onCallerAbort, { once: true });
	}
	const cleanup = () => {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onCallerAbort);
	};

	let response: Response;
	try {
		response = await fetch(endpoint, {
			method: "POST",
			headers:
				transport === "cli"
					? cliHeaders(apiKey, deps.workingDir(), deps.cliVersion())
					: openAiHeaders(apiKey),
			body: JSON.stringify(body),
			signal: connectAbort.signal,
		});
		clearTimeout(timer);
	} catch (error) {
		cleanup();
		if (signal?.aborted) throw error;
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(
			connectTimedOut
				? `Command Code API 请求 ${endpoint} 在 ${timeoutMs}ms 内未收到响应（超时）：${reason}；request to ${endpoint} timed out`
				: `Command Code API 请求 ${endpoint} 连接失败：${reason}；request to ${endpoint} failed`,
		);
	}

	if (!response.ok) {
		const bodyText = await response.text().catch(() => "");
		cleanup();
		const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
		return retryAfterMs === undefined
			? { status: response.status, bodyText }
			: { status: response.status, bodyText, retryAfterMs };
	}
	return { response };
}

/** Map a CLI `finish` event's usage block onto pi's `Usage`. */
function usageFromCli(totalUsage: Record<string, unknown>): Usage {
	const details = isRecord(totalUsage.inputTokenDetails) ? totalUsage.inputTokenDetails : undefined;
	const totalInput = numberValue(totalUsage.inputTokens) ?? 0;
	const cacheRead = numberValue(details?.cacheReadTokens) ?? 0;
	const cacheWrite = numberValue(details?.cacheWriteTokens) ?? 0;
	const output = numberValue(totalUsage.outputTokens) ?? 0;
	const input = numberValue(details?.noCacheTokens) ?? Math.max(0, totalInput - cacheRead - cacheWrite);
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		reasoning: numberValue(totalUsage.reasoningTokens),
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Map an OpenAI Chat Completions usage block onto pi's `Usage`. */
function usageFromOpenAi(raw: Record<string, unknown>): Usage {
	const promptTokens = numberValue(raw.prompt_tokens) ?? 0;
	const output = numberValue(raw.completion_tokens) ?? 0;
	const promptDetails = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : undefined;
	const cacheRead = numberValue(promptDetails?.cached_tokens) ?? 0;
	const cacheWrite = numberValue(promptDetails?.cache_creation_input_tokens) ?? 0;
	const completionDetails = isRecord(raw.completion_tokens_details)
		? raw.completion_tokens_details
		: undefined;
	const reasoning = numberValue(completionDetails?.reasoning_tokens);
	const input = Math.max(0, promptTokens - cacheRead - cacheWrite);
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		reasoning,
		totalTokens: numberValue(raw.total_tokens) ?? input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * Fold one parsed CLI (`/alpha/generate`) event into the assembler,
 * pushing the corresponding pi events. Content blocks are opened lazily so
 * a response that starts with reasoning then switches to text produces the
 * right block sequence.
 */
function handleCliEvent(
	asm: Assembler,
	event: Record<string, unknown>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const closeText = () => {
		if (asm.textIndex < 0) return;
		stream.push({
			type: "text_end",
			contentIndex: asm.textIndex,
			content: asm.textContent,
			partial: output,
		});
		asm.textIndex = -1;
		asm.textContent = "";
	};
	const closeReasoning = () => {
		if (asm.reasoningIndex < 0) return;
		stream.push({
			type: "thinking_end",
			contentIndex: asm.reasoningIndex,
			content: asm.reasoningContent,
			partial: output,
		});
		asm.reasoningIndex = -1;
		asm.reasoningContent = "";
	};

	switch (event.type) {
		case "text-delta": {
			closeReasoning();
			if (asm.textIndex < 0) {
				asm.textIndex = asm.nextIndex++;
				output.content.push({ type: "text", text: "" });
				stream.push({ type: "text_start", contentIndex: asm.textIndex, partial: output });
			}
			const delta = stringValue(event.text) ?? "";
			asm.textContent += delta;
			asm.sawContent = true;
			const block = output.content[asm.textIndex];
			if (block?.type === "text") block.text = asm.textContent;
			stream.push({ type: "text_delta", contentIndex: asm.textIndex, delta, partial: output });
			break;
		}
		case "reasoning-delta": {
			closeText();
			if (asm.reasoningIndex < 0) {
				asm.reasoningIndex = asm.nextIndex++;
				output.content.push({ type: "thinking", thinking: "" });
				stream.push({ type: "thinking_start", contentIndex: asm.reasoningIndex, partial: output });
			}
			const delta = stringValue(event.text) ?? "";
			asm.reasoningContent += delta;
			const block = output.content[asm.reasoningIndex];
			if (block?.type === "thinking") block.thinking = asm.reasoningContent;
			stream.push({ type: "thinking_delta", contentIndex: asm.reasoningIndex, delta, partial: output });
			break;
		}
		case "reasoning-start":
			closeText();
			break;
		case "reasoning-end":
			closeReasoning();
			break;
		case "tool-call": {
			// The CLI transport delivers whole tool calls, not fragments, so a
			// start/delta/end triple is synthesized to match pi's protocol.
			closeText();
			closeReasoning();
			const id = stringValue(event.toolCallId) ?? randomUUID();
			const name = stringValue(event.toolName) ?? "";
			const argsRecord = isRecord(event.input)
				? event.input
				: isRecord(event.args)
					? event.args
					: isRecord(event.arguments)
						? event.arguments
						: {};
			const argsJson = JSON.stringify(argsRecord);
			const index = asm.nextIndex++;
			asm.sawContent = true;
			const toolCall = { type: "toolCall" as const, id, name, arguments: argsRecord };
			output.content.push(toolCall);
			stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
			stream.push({ type: "toolcall_delta", contentIndex: index, delta: argsJson, partial: output });
			stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
			break;
		}
		case "finish": {
			closeText();
			closeReasoning();
			const totalUsage = isRecord(event.totalUsage) ? event.totalUsage : undefined;
			if (totalUsage !== undefined) asm.usage = usageFromCli(totalUsage);
			asm.stopReason = mapFinishReason(stringValue(event.finishReason));
			break;
		}
		case "error": {
			const detail = isRecord(event.error)
				? (stringValue(event.error.message) ?? JSON.stringify(event.error))
				: (stringValue(event.error) ?? stringValue(event.message) ?? "Command Code 流错误");
			throw new Error(`Command Code 流错误：${detail}`);
		}
		default:
			break;
	}
}

/**
 * Fold one parsed Provider API SSE chunk into the assembler. Unlike the CLI
 * transport this one streams tool calls as fragments, so they are buffered
 * and flushed when `finish_reason` arrives.
 */
function handleOpenAiEvent(
	asm: Assembler,
	event: Record<string, unknown>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const closeText = () => {
		if (asm.textIndex < 0) return;
		stream.push({
			type: "text_end",
			contentIndex: asm.textIndex,
			content: asm.textContent,
			partial: output,
		});
		asm.textIndex = -1;
		asm.textContent = "";
	};
	const closeReasoning = () => {
		if (asm.reasoningIndex < 0) return;
		stream.push({
			type: "thinking_end",
			contentIndex: asm.reasoningIndex,
			content: asm.reasoningContent,
			partial: output,
		});
		asm.reasoningIndex = -1;
		asm.reasoningContent = "";
	};
	const emitToolCalls = () => {
		for (const call of asm.openAiToolCalls) {
			const id = call.id ?? randomUUID();
			const index = asm.nextIndex++;
			asm.sawContent = true;
			let args: Record<string, unknown> = {};
			try {
				const parsed: unknown = JSON.parse(call.arguments || "{}");
				if (isRecord(parsed)) args = parsed;
			} catch {
				// Malformed argument JSON is surfaced as empty arguments rather
				// than aborting a response that is otherwise usable.
			}
			const toolCall = { type: "toolCall" as const, id, name: call.name, arguments: args };
			output.content.push(toolCall);
			stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
			stream.push({
				type: "toolcall_delta",
				contentIndex: index,
				delta: call.arguments,
				partial: output,
			});
			stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
		}
		asm.openAiToolCalls.length = 0;
	};

	// A usage-only chunk (sent when the stream requests stream_options.include_usage)
	// carries no choices.
	const choices = event.choices;
	if (!Array.isArray(choices) || choices.length === 0) {
		if (isRecord(event.usage)) asm.usage = usageFromOpenAi(event.usage);
		return;
	}
	const choice = isRecord(choices[0]) ? choices[0] : {};
	const delta = isRecord(choice.delta) ? choice.delta : {};

	const reasoningDelta = stringValue(delta.reasoning) ?? stringValue(delta.reasoning_content) ?? "";
	if (reasoningDelta !== "") {
		closeText();
		if (asm.reasoningIndex < 0) {
			asm.reasoningIndex = asm.nextIndex++;
			output.content.push({ type: "thinking", thinking: "" });
			stream.push({ type: "thinking_start", contentIndex: asm.reasoningIndex, partial: output });
		}
		asm.reasoningContent += reasoningDelta;
		const block = output.content[asm.reasoningIndex];
		if (block?.type === "thinking") block.thinking = asm.reasoningContent;
		stream.push({ type: "thinking_delta", contentIndex: asm.reasoningIndex, delta: reasoningDelta, partial: output });
	}

	const contentDelta = stringValue(delta.content) ?? "";
	if (contentDelta !== "") {
		closeReasoning();
		if (asm.textIndex < 0) {
			asm.textIndex = asm.nextIndex++;
			output.content.push({ type: "text", text: "" });
			stream.push({ type: "text_start", contentIndex: asm.textIndex, partial: output });
		}
		asm.textContent += contentDelta;
		asm.sawContent = true;
		const block = output.content[asm.textIndex];
		if (block?.type === "text") block.text = asm.textContent;
		stream.push({ type: "text_delta", contentIndex: asm.textIndex, delta: contentDelta, partial: output });
	}

	if (Array.isArray(delta.tool_calls)) {
		asm.sawContent = true;
		for (const rawCall of delta.tool_calls) {
			if (!isRecord(rawCall)) continue;
			const callIndex = numberValue(rawCall.index) ?? 0;
			const fn = isRecord(rawCall.function) ? rawCall.function : undefined;
			const id = stringValue(rawCall.id);
			const name = fn === undefined ? undefined : stringValue(fn.name);
			const argDelta = fn === undefined ? undefined : (stringValue(fn.arguments) ?? "");
			let existing = asm.openAiToolCalls.find((call) => call.index === callIndex);
			if (existing === undefined) {
				existing = { index: callIndex, name: name ?? "", arguments: argDelta ?? "" };
				if (id !== undefined) existing.id = id;
				asm.openAiToolCalls.push(existing);
			} else {
				if (id !== undefined && existing.id === undefined) existing.id = id;
				if (name !== undefined && existing.name === "") existing.name = name;
				if (argDelta !== undefined) existing.arguments += argDelta;
			}
		}
	}

	if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
		closeText();
		closeReasoning();
		emitToolCalls();
		asm.stopReason = mapFinishReason(stringValue(choice.finish_reason));
	}
}

/** Shared abort/idle plumbing around the response body reader. */
async function* readLines(
	response: Response,
	signal: AbortSignal | undefined,
	idleTimeoutMs: number,
): AsyncGenerator<string> {
	if (!response.body) throw new Error("Command Code API 返回了空响应体；the API returned no response body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let idleTimer: NodeJS.Timeout | undefined;
	let idleFired = false;
	const armIdle = () => {
		if (idleTimer !== undefined) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			idleFired = true;
			void reader.cancel().catch(() => undefined);
		}, idleTimeoutMs);
		idleTimer.unref?.();
	};
	const clearIdle = () => {
		if (idleTimer !== undefined) {
			clearTimeout(idleTimer);
			idleTimer = undefined;
		}
	};
	try {
		for (;;) {
			armIdle();
			let read: ReadableStreamReadResult<Uint8Array>;
			try {
				read = await reader.read();
			} catch (error) {
				if (signal?.aborted) throw error;
				throw new Error(
					`Command Code API 流式响应中途断开：${error instanceof Error ? error.message : String(error)}；` +
						"the stream dropped mid-response (usually a network hiccup — retrying normally recovers)",
				);
			} finally {
				clearIdle();
			}
			if (read.done) {
				if (idleFired) {
					throw new Error(
						`Command Code API 流式响应已 ${idleTimeoutMs}ms 无任何事件，判定为死连接 —— ` +
							"长思考模型可在设置中调大 streamIdleTimeoutMs；the stream was idle and treated as dead",
					);
				}
				if (buffer.trim()) yield buffer;
				break;
			}
			buffer += decoder.decode(read.value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) yield line;
		}
	} finally {
		clearIdle();
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

/**
 * Stream one completion, trying the Provider API first and falling back to
 * the CLI gateway only on Command Code's Go-plan gate.
 */
export function streamCommandCode(
	model: Model<string>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	deps: StreamDeps,
	apiBase: string,
	isGoTier: (key: string) => boolean,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	void (async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			const account = await deps.resolveAccount(model.id);
			let apiKey = account.key;
			let transport = initialTransport(deps, apiKey, isGoTier(apiKey));

			const modelMax = deps.modelMaxTokens(model.id) ?? model.maxTokens;
			const maxTokens = Math.min(options?.maxTokens ?? model.maxTokens, modelMax);
			const effort = options?.reasoning && options.reasoning !== "off" ? options.reasoning : undefined;
			// `/alpha/generate` caps output tokens well below the Provider API.
			const cliMaxTokens = Math.min(maxTokens, CLI_MAX_OUTPUT_TOKENS);
			const facts: RequestFacts = {
				maxTokens,
				reasoningEffort: effort,
				systemText: systemTextFor(context),
				workingDir: deps.workingDir(),
			};
			const tools = toolsFor(context);
			const cliMessages: CliMessage[] = toCliMessages(context.messages);
			const openAiMessages: OpenAiMessage[] = toOpenAiMessages(context.messages);
			const threadId = randomUUID();

			const buildBody = (target: Transport): Record<string, unknown> =>
				target === "cli"
					? buildCliBody(model.id, cliMessages, tools, { ...facts, maxTokens: cliMaxTokens }, threadId)
					: buildOpenAiBody(model.id, facts.systemText, openAiMessages, tools, facts);

			const tried = new Set<string>();
			let connected: { response: Response } | undefined;

			for (;;) {
				tried.add(apiKey);
				const requestBody = buildBody(transport);
				capture(
					`request-${process.pid}.json`,
					JSON.stringify(
						{
							transport,
							endpoint: endpointFor(transport, apiBase),
							// The resolved request options are captured too: a
							// missing reasoning level is otherwise invisible on
							// the wire, since an absent `reasoning_effort` field
							// looks the same as a provider that never asked.
							options: { reasoning: options?.reasoning, maxTokens: options?.maxTokens },
							body: requestBody,
						},
						null,
						2,
					),
				);
				const attempt = await connect(deps, apiKey, transport, requestBody, apiBase, options?.signal);
				if ("response" in attempt) {
					connected = attempt;
					break;
				}

				// The Go-plan gate: the account is fine, it just has no Provider
				// API access. Rebuild for the CLI gateway and retry immediately.
				if (transport === "openai" && isUpgradeRequiredError(attempt.status, attempt.bodyText)) {
					transport = "cli";
					deps.rememberTransport(apiKey, "cli");
					continue;
				}

				if (
					(attempt.status === 429 || attempt.status === 401) &&
					options?.signal?.aborted !== true &&
					tried.size < MAX_ACCOUNT_ROTATIONS
				) {
					const next = await deps.rotateAccount(
						apiKey,
						attempt.status === 429 ? "rate-limit" : "invalid-credential",
						model.id,
					);
					if (next !== undefined && !tried.has(next.key)) {
						apiKey = next.key;
						transport = initialTransport(deps, apiKey, isGoTier(apiKey));
						continue;
					}
				}

				throw new CommandCodeHttpError(attempt.status, attempt.bodyText, attempt.retryAfterMs);
			}

			if (connected === undefined) throw new Error("Command Code API 连接失败；the connection failed");

			stream.push({ type: "start", partial: output });
			deps.rememberTransport(apiKey, transport);

			const asm = createAssembler();
			for await (const line of readLines(connected.response, options?.signal, deps.streamIdleTimeoutMs())) {
				capture(`stream-${process.pid}.ndjson`, line);
				const event = parseStreamLine(line);
				if (event === undefined) continue;
				if (transport === "cli") handleCliEvent(asm, event, output, stream);
				else handleOpenAiEvent(asm, event, output, stream);
			}

			if (asm.usage !== undefined) {
				output.usage = asm.usage;
				calculateCost(model, output.usage);
			}
			if (!asm.sawContent) {
				throw new Error("Command Code 返回了空响应，重试通常可恢复；Command Code returned an empty response");
			}
			output.stopReason = asm.stopReason ?? "stop";
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}
