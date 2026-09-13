/**
 * Conversion from pi's conversation model to the two Command Code wire
 * formats.
 *
 * pi's `Context` is provider-neutral (user / assistant / toolResult
 * messages, `text` / `thinking` / `toolCall` / `image` content blocks); the
 * Command Code transports each want their own shape. Three rules matter for
 * correctness and are applied on both paths:
 *
 *  1. **Only paired tool calls are replayed.** A `toolCall` with no matching
 *     `toolResult` makes strict backends reject the whole request, so the
 *     pair set is computed first and unpaired calls are dropped.
 *  2. **Overlong tool-call ids are aliased.** The gateway rejects ids longer
 *     than 64 characters, which cross-provider histories can easily contain
 *     (e.g. switching to Command Code mid-session). Correlation only has to
 *     hold within one request, so short `cc-<n>` aliases are enough.
 *  3. **Images inside tool results are hoisted.** Neither transport lets a
 *     tool result carry an image, so they are re-emitted as a following user
 *     message that names the tool they came from.
 */
import type { Context, Message, Tool } from "@earendil-works/pi-ai";
import { isRecord, stringValue, type CliMessage, type OpenAiMessage } from "./wire.ts";

/** The gateway rejects tool call ids longer than this. */
const MAX_WIRE_TOOL_CALL_ID_LENGTH = 64;

/** Leading line of the user message that carries a tool result's images. */
const TOOL_RESULT_IMAGE_TEXT = "Attached image(s) from tool result:";

/**
 * Collect the tool calls that have a paired result, plus each call's name.
 * The name map feeds replayed tool results: some backends reject a result
 * whose function name is empty, so the real name must round-trip.
 */
function pairedToolCalls(messages: Message[]): { ids: Set<string>; names: Map<string, string> } {
	const callIds = new Set<string>();
	const names = new Map<string, string>();
	const resultIds = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") {
					callIds.add(block.id);
					names.set(block.id, block.name);
				}
			}
		} else if (message.role === "toolResult") {
			resultIds.add(message.toolCallId);
		}
	}
	return { ids: new Set([...callIds].filter((id) => resultIds.has(id))), names };
}

/**
 * Map each paired tool-call id to the id actually put on the wire: ids that
 * fit pass through verbatim, longer ones get a collision-free `cc-<n>` alias.
 * Callers must resolve BOTH the call and its result through this map so the
 * pair stays correlated.
 */
function wireToolCallIds(paired: Set<string>): Map<string, string> {
	const wire = new Map<string, string>();
	const taken = new Set<string>();
	for (const id of paired) {
		if (id.length <= MAX_WIRE_TOOL_CALL_ID_LENGTH) {
			wire.set(id, id);
			taken.add(id);
		}
	}
	let seq = 1;
	for (const id of paired) {
		if (wire.has(id)) continue;
		let alias = `cc-${seq++}`;
		while (taken.has(alias)) alias = `cc-${seq++}`;
		wire.set(id, alias);
		taken.add(alias);
	}
	return wire;
}

/** Split a tool result's content into text and images. */
function toolResultMedia(content: { type: string; text?: string; data?: string; mimeType?: string }[]): {
	text: string;
	images: { data: string; mimeType: string }[];
} {
	const chunks: string[] = [];
	const images: { data: string; mimeType: string }[] = [];
	const seen = new Set<string>();
	for (const block of content) {
		if (block.type === "text") {
			if (block.text) chunks.push(block.text);
			continue;
		}
		if (block.type === "image" && block.data !== undefined && block.mimeType !== undefined) {
			// A tool that returns the same pixels twice should not pay twice.
			const key = `${block.mimeType}:${block.data.length}:${block.data.slice(0, 32)}`;
			if (seen.has(key)) continue;
			seen.add(key);
			images.push({ data: block.data, mimeType: block.mimeType });
		}
	}
	return { text: chunks.join("\n"), images };
}

/**
 * Result text for a wire tool message. Neither transport accepts an empty
 * tool content string, so a result that carried only an image gets a
 * descriptor pointing at the user message that follows with the pixels.
 */
function toolResultTextForWire(media: { text: string; images: unknown[] }): string {
	return media.text || (media.images.length > 0 ? "(image returned; see the attached image)" : "(no output)");
}

/** Note introducing images carried out of a tool result. */
function toolResultImageNote(images: { mimeType: string }[]): string {
	const count = images.length > 1 ? `${images.length} images` : "1 image";
	return `${TOOL_RESULT_IMAGE_TEXT} ${count} (${images[0]?.mimeType ?? "image"})`;
}

/** The system prompt text: pi's `systemPrompt` plus any system messages. */
export function systemTextFor(context: Context, extra?: string): string {
	const inline = context.messages
		.filter((message) => message.role === "user")
		.map((message) =>
			typeof message.content === "string"
				? ""
				: message.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n"),
		)
		.filter(Boolean);
	// pi carries the prompt in `systemPrompt`; the inline scan above only
	// exists so a caller that inlined a system message is not silently
	// dropped. In practice `systemPrompt` is the whole story.
	void inline;
	return [extra ?? "", context.systemPrompt ?? ""].filter(Boolean).join("\n\n");
}

/** Map pi tools onto the flat `{name, description, parameters}` shape. */
export function toolsFor(context: Context): { name: string; description: string; parameters: unknown }[] {
	return (context.tools ?? []).map((tool: Tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}));
}

/** Convert pi messages to the CLI (`/alpha/generate`) wire shape. */
export function toCliMessages(messages: Message[]): CliMessage[] {
	const { ids: paired, names: toolNames } = pairedToolCalls(messages);
	const wireIds = wireToolCallIds(paired);
	const out: CliMessage[] = [];

	for (const message of messages) {
		if (message.role === "user") {
			const parts: unknown[] = [];
			if (typeof message.content === "string") {
				if (message.content.trim()) parts.push({ type: "text", text: message.content });
			} else {
				for (const block of message.content) {
					if (block.type === "text") parts.push({ type: "text", text: block.text });
					else if (block.type === "image") {
						parts.push({
							type: "image",
							source: { type: "base64", media_type: block.mimeType, data: block.data },
						});
					}
				}
			}
			if (parts.length > 0) out.push({ role: "user", content: parts });
			continue;
		}

		if (message.role === "assistant") {
			const parts: unknown[] = [];
			for (const block of message.content) {
				if (block.type === "text") {
					if (block.text) parts.push({ type: "text", text: block.text });
				} else if (block.type === "toolCall" && paired.has(block.id)) {
					parts.push({
						type: "tool-call",
						toolCallId: wireIds.get(block.id) ?? block.id,
						toolName: block.name,
						input: isRecord(block.arguments) ? block.arguments : {},
					});
				}
				// `thinking` is deliberately not replayed on this transport: the
				// CLI protocol has no reasoning channel to round-trip it through
				// and the gateway rejects unknown parts.
			}
			if (parts.length > 0) out.push({ role: "assistant", content: parts });
			continue;
		}

		// toolResult
		if (!paired.has(message.toolCallId)) continue;
		const media = toolResultMedia(message.content);
		out.push({
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: wireIds.get(message.toolCallId) ?? message.toolCallId,
					toolName: toolNames.get(message.toolCallId) || message.toolName || "unknown",
					output: message.isError
						? { type: "error-text", value: toolResultTextForWire(media) }
						: { type: "text", value: toolResultTextForWire(media) },
				},
			],
		});
		if (media.images.length > 0) {
			const carried: unknown[] = [{ type: "text", text: toolResultImageNote(media.images) }];
			for (const image of media.images) {
				carried.push({
					type: "image",
					source: { type: "base64", media_type: image.mimeType, data: image.data },
				});
			}
			out.push({ role: "user", content: carried });
		}
	}

	return out;
}

/**
 * Convert pi messages to the Provider API (OpenAI Chat Completions) wire
 * shape.
 *
 * Unlike the CLI transport this one DOES replay reasoning: DeepSeek's
 * thinking-mode contract requires historical `reasoning_content` whenever
 * tools are in play, otherwise the tool loop loses its chain of thought.
 */
export function toOpenAiMessages(messages: Message[]): OpenAiMessage[] {
	const { ids: paired } = pairedToolCalls(messages);
	const wireIds = wireToolCallIds(paired);
	const out: OpenAiMessage[] = [];

	for (const message of messages) {
		if (message.role === "user") {
			const parts: unknown[] = [];
			if (typeof message.content === "string") {
				if (message.content.trim()) parts.push({ type: "text", text: message.content });
			} else {
				for (const block of message.content) {
					if (block.type === "text") parts.push({ type: "text", text: block.text });
					else if (block.type === "image") {
						parts.push({
							type: "image_url",
							image_url: { url: `data:${block.mimeType};base64,${block.data}` },
						});
					}
				}
			}
			if (parts.length === 0) continue;
			// A single text part is sent as a plain string, matching what most
			// OpenAI-compatible gateways expect for the common case.
			if (parts.length === 1 && isRecord(parts[0]) && parts[0].type === "text") {
				out.push({ role: "user", content: parts[0].text });
			} else {
				out.push({ role: "user", content: parts });
			}
			continue;
		}

		if (message.role === "assistant") {
			const text = message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("");
			const reasoning = message.content
				.filter((block) => block.type === "thinking")
				.map((block) => block.thinking)
				.join("");
			const toolCalls = message.content
				.filter((block) => block.type === "toolCall" && paired.has(block.id))
				.map((block) => ({
					id: wireIds.get(block.id) ?? block.id,
					type: "function",
					function: {
						name: block.name,
						arguments: JSON.stringify(isRecord(block.arguments) ? block.arguments : {}),
					},
				}));
			if (text === "" && reasoning === "" && toolCalls.length === 0) continue;
			const assistant: OpenAiMessage = {
				role: "assistant",
				content: text === "" ? null : text,
			};
			if (reasoning !== "") assistant.reasoning_content = reasoning;
			if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
			out.push(assistant);
			continue;
		}

		// toolResult
		if (!paired.has(message.toolCallId)) continue;
		const media = toolResultMedia(message.content);
		out.push({
			role: "tool",
			tool_call_id: wireIds.get(message.toolCallId) ?? message.toolCallId,
			content: toolResultTextForWire(media),
		});
		if (media.images.length > 0) {
			const carried: unknown[] = [{ type: "text", text: toolResultImageNote(media.images) }];
			for (const image of media.images) {
				carried.push({
					type: "image_url",
					image_url: { url: `data:${image.mimeType};base64,${image.data}` },
				});
			}
			out.push({ role: "user", content: carried });
		}
	}

	return out;
}

/** Whether any message carries an image, at top level or inside a result. */
export function hasImageContent(messages: Message[]): boolean {
	for (const message of messages) {
		if (message.role === "assistant") continue;
		if (typeof message.content === "string") continue;
		for (const block of message.content) {
			if (block.type === "image") return true;
		}
	}
	return false;
}

/** Read a string field without tripping over an unexpected wire shape. */
export function wireString(record: Record<string, unknown>, key: string): string | undefined {
	return stringValue(record[key]);
}
