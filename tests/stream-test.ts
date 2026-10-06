/**
 * Integration tests for the streaming engine, driven against a local mock of
 * the Command Code gateway.
 *
 * This is where the plugin's defining behaviour is verified: a Go-plan
 * account is refused by the Provider API with `403 upgrade_required`, and the
 * engine must transparently replay the same turn through `/alpha/generate`
 * instead. The mock records every request so the test can assert which
 * endpoints were hit, with which headers and bodies.
 *
 * No API key and no network access are required.
 *
 *   node --experimental-strip-types stream-test.ts
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { streamCommandCode, type StreamDeps } from "../stream.ts";

interface Captured {
	path: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

const captured: Captured[] = [];

/** Read a request body and record the request. */
async function capture(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const text = Buffer.concat(chunks).toString("utf8");
	const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
	captured.push({
		path: req.url ?? "",
		headers: Object.fromEntries(
			Object.entries(req.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(",") : String(value ?? "")]),
		),
		body,
	});
	return body;
}

function sse(res: ServerResponse, events: unknown[], done = true) {
	res.writeHead(200, { "Content-Type": "text/event-stream" });
	for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
	if (done) res.write("data: [DONE]\n\n");
	res.end();
}

function ndjson(res: ServerResponse, events: unknown[]) {
	res.writeHead(200, { "Content-Type": "application/x-ndjson" });
	for (const event of events) res.write(`${JSON.stringify(event)}\n`);
	res.end();
}

/** The gateway behaviour each test wants. */
type Handler = (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void;

let handler: Handler = (_req, res) => res.writeHead(404).end();

const server: Server = createServer((req, res) => {
	void capture(req).then((body) => handler(req, res, body));
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const port = typeof address === "object" && address !== null ? address.port : 0;
const API_BASE = `http://127.0.0.1:${port}`;

console.log(`mock gateway on ${API_BASE}\n`);

const model: Model<string> = {
	id: "deepseek/deepseek-v4.1-flash",
	name: "DeepSeek V4.1 Flash",
	api: "commandcode-api",
	provider: "commandcode",
	baseUrl: API_BASE,
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
};

/**
 * The context a provider actually receives. pi folds `systemPrompt` and
 * `tools` into a leading system message with `normalizeContext()` before
 * calling the provider, so a test that skipped that step would exercise a
 * shape no real request ever has.
 */
function makeContext(): Context {
	return normalizeContext({
		systemPrompt: "You are a coding agent.",
		messages: [{ role: "user", content: "list the files", timestamp: Date.now() }],
		tools: [
			{
				name: "bash",
				description: "run a command",
				parameters: { type: "object", properties: { command: { type: "string" } } },
			},
		],
	});
}

function makeDeps(overrides: Partial<StreamDeps> = {}): StreamDeps {
	return {
		workingDir: () => "G:/Work/demo",
		resolveAccount: async () => ({ key: "user_test_key", slotId: "default" }),
		rotateAccount: async () => undefined,
		cachedTransport: () => undefined,
		rememberTransport: () => {},
		modelMaxTokens: () => 65_536,
		streamIdleTimeoutMs: () => 5_000,
		requestTimeoutMs: () => 5_000,
		cliVersion: () => "1.53.1",
		...overrides,
	};
}

/** Collect every pi event a stream produces, or the terminal error. */
async function collect(options?: SimpleStreamOptions, deps: StreamDeps = makeDeps()) {
	const stream = streamCommandCode(model, makeContext(), options, deps, API_BASE, () => false);
	const events: { type: string; [key: string]: unknown }[] = [];
	for await (const event of stream) events.push(event as { type: string; [key: string]: unknown });
	return events;
}

/** Join the text deltas of a completed stream. */
function textOf(events: { type: string; [key: string]: unknown }[]): string {
	return events
		.filter((event) => event.type === "text_delta")
		.map((event) => String(event.delta))
		.join("");
}

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>) {
	captured.length = 0;
	try {
		await fn();
		passed += 1;
		console.log(`  ok  ${name}`);
	} catch (error) {
		failed += 1;
		console.error(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}

// ---------------------------------------------------------------------------

console.log("Provider API transport");

await test("streams text from /provider/v1/chat/completions", async () => {
	handler = (_req, res) =>
		sse(res, [
			{ choices: [{ delta: { content: "hello " } }] },
			{ choices: [{ delta: { content: "world" } }] },
			{ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
		]);
	const events = await collect();
	assert.equal(captured.length, 1);
	assert.equal(captured[0].path, "/provider/v1/chat/completions");
	assert.equal(textOf(events), "hello world");
	assert.equal(events[0].type, "start");
	assert.equal(events.at(-1)?.type, "done");
});

await test("sends the system prompt and tools in the OpenAI body", async () => {
	handler = (_req, res) => sse(res, [{ choices: [{ delta: { content: "x" }, finish_reason: "stop" }] }]);
	await collect();
	const body = captured[0].body;
	const messages = body.messages as Record<string, unknown>[];
	assert.equal(messages[0].role, "system");
	assert.equal(messages[0].content, "You are a coding agent.");
	const tools = body.tools as Record<string, unknown>[];
	assert.equal((tools[0].function as Record<string, unknown>).name, "bash");
});

await test("carries the prompt and tools on the CLI transport too", async () => {
	// The regression this guards: pi 0.86 hands the prompt and the tool
	// declarations to a provider inside the transcript's system message, and
	// an adapter that reads `Context.systemPrompt` / `Context.tools` instead
	// sends `system: ""` with `tools: []`. The gateway then substitutes its
	// own harness prompt, the model answers with text-mode tool calls, and
	// the turn ends without ever running a tool.
	handler = (req, res) => {
		if (req.url?.startsWith("/provider/v1")) {
			res.writeHead(403).end(JSON.stringify({ error: { code: "upgrade_required" } }));
			return;
		}
		ndjson(res, [{ type: "text-delta", text: "ok" }, { type: "finish", finishReason: "stop" }]);
	};
	await collect();
	const params = captured[1].body.params as Record<string, unknown>;
	assert.equal(params.system, "You are a coding agent.", "the system prompt must reach the CLI transport");
	const tools = params.tools as Record<string, unknown>[];
	assert.equal(tools.length, 1, "the tool declarations must reach the CLI transport");
	assert.equal(tools[0].name, "bash");
	assert.ok(tools[0].input_schema, "tools keep a JSON schema");
});

await test("parses streamed tool calls", async () => {
	handler = (_req, res) =>
		sse(res, [
			{ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "bash" } }] } }] },
			{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":' } }] } }] },
			{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } }] },
			{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
		]);
	const events = await collect();
	const end = events.find((event) => event.type === "toolcall_end");
	assert.ok(end, "a toolcall_end event is emitted");
	const call = end.toolCall as { name: string; arguments: Record<string, unknown> };
	assert.equal(call.name, "bash");
	assert.deepEqual(call.arguments, { command: "ls" });
	assert.equal(events.at(-1)?.reason, "toolUse");
});

await test("maps thinking deltas onto thinking events", async () => {
	handler = (_req, res) =>
		sse(res, [
			{ choices: [{ delta: { reasoning_content: "pondering" } }] },
			{ choices: [{ delta: { content: "answer" } }] },
			{ choices: [{ delta: {}, finish_reason: "stop" }] },
		]);
	const events = await collect();
	assert.equal(events.some((event) => event.type === "thinking_delta"), true);
	assert.equal(events.some((event) => event.type === "text_delta"), true);
});

// ---------------------------------------------------------------------------

console.log("\nGo-plan fallback");

await test("falls back to /alpha/generate on 403 upgrade_required", async () => {
	handler = (req, res) => {
		if (req.url?.startsWith("/provider/v1")) {
			res.writeHead(403, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: { code: "upgrade_required" } }));
			return;
		}
		ndjson(res, [
			{ type: "text-delta", text: "via CLI" },
			{ type: "finish", finishReason: "stop" },
		]);
	};
	const events = await collect();
	assert.equal(captured.length, 2, "both transports should be attempted");
	assert.equal(captured[0].path, "/provider/v1/chat/completions");
	assert.equal(captured[1].path, "/alpha/generate");
	assert.equal(textOf(events), "via CLI");
	assert.equal(events.at(-1)?.type, "done");
});

await test("the CLI retry carries the CLI envelope and headers", async () => {
	handler = (req, res) => {
		if (req.url?.startsWith("/provider/v1")) {
			res.writeHead(403).end(JSON.stringify({ error: { code: "upgrade_required" } }));
			return;
		}
		ndjson(res, [{ type: "text-delta", text: "ok" }, { type: "finish", finishReason: "stop" }]);
	};
	await collect();
	const cli = captured[1];
	assert.equal(cli.headers["x-cli-environment"], "production");
	assert.equal(cli.headers["x-project-slug"], "demo");
	assert.equal(cli.headers["x-command-code-version"] !== undefined, true);
	// The CLI protocol wraps the turn in its own envelope.
	const params = cli.body.params as Record<string, unknown>;
	assert.equal(params.model, "deepseek/deepseek-v4.1-flash");
	assert.equal(params.stream, true);
	assert.ok(cli.body.threadId, "a threadId is generated");
	assert.ok(cli.body.config, "the config block is present");
});

await test("remembers the transport so the next turn skips the refused endpoint", async () => {
	handler = (req, res) => {
		if (req.url?.startsWith("/provider/v1")) {
			res.writeHead(403).end(JSON.stringify({ error: { code: "upgrade_required" } }));
			return;
		}
		ndjson(res, [{ type: "text-delta", text: "ok" }, { type: "finish", finishReason: "stop" }]);
	};
	const remembered = new Map<string, "openai" | "cli">();
	const deps = makeDeps({
		cachedTransport: (key) => remembered.get(key),
		rememberTransport: (key, transport) => remembered.set(key, transport),
	});
	await collect(undefined, deps);
	assert.equal(remembered.get("user_test_key"), "cli");
	captured.length = 0;
	// A second turn should go straight to the CLI endpoint.
	await collect(undefined, deps);
	assert.equal(captured.length, 1);
	assert.equal(captured[0].path, "/alpha/generate");
});

await test("parses CLI tool calls into pi toolcall events", async () => {
	handler = (req, res) => {
		if (req.url?.startsWith("/provider/v1")) {
			res.writeHead(403).end(JSON.stringify({ error: { code: "upgrade_required" } }));
			return;
		}
		ndjson(res, [
			{ type: "reasoning-delta", text: "thinking" },
			{ type: "text-delta", text: "running" },
			{ type: "tool-call", toolCallId: "t1", toolName: "bash", input: { command: "ls" } },
			{ type: "finish", finishReason: "tool-calls", totalUsage: { inputTokens: 5, outputTokens: 3 } },
		]);
	};
	const events = await collect();
	assert.equal(events.some((event) => event.type === "thinking_delta"), true);
	const end = events.find((event) => event.type === "toolcall_end");
	assert.ok(end);
	assert.deepEqual((end.toolCall as { arguments: unknown }).arguments, { command: "ls" });
	assert.equal(events.at(-1)?.reason, "toolUse");
});

// ---------------------------------------------------------------------------

console.log("\nerror handling");

await test("does NOT fall back on an ordinary 403", async () => {
	handler = (_req, res) => {
		res.writeHead(403, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: { code: "model_not_in_plan" } }));
	};
	const events = await collect();
	assert.equal(captured.length, 1, "only the Provider API should be tried");
	assert.equal(events.at(-1)?.type, "error");
	assert.match(String((events.at(-1)?.error as { errorMessage: string }).errorMessage), /403/);
});

await test("surfaces a 401 with an actionable message", async () => {
	handler = (_req, res) => {
		res.writeHead(401, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: { code: "invalid_key" } }));
	};
	const events = await collect();
	const last = events.at(-1);
	assert.equal(last?.type, "error");
	assert.match(String((last?.error as { errorMessage: string }).errorMessage), /401/);
	assert.match(String((last?.error as { errorMessage: string }).errorMessage), /密钥|key/i);
});

await test("rotates to another account on 429", async () => {
	const tried: string[] = [];
	handler = (req, res) => {
		const auth = String(req.headers.authorization ?? "");
		tried.push(auth);
		if (auth.includes("key_limited")) {
			res.writeHead(429, { "Retry-After": "30" }).end("rate limited");
			return;
		}
		sse(res, [{ choices: [{ delta: { content: "second account" }, finish_reason: "stop" }] }]);
	};
	const deps = makeDeps({
		resolveAccount: async () => ({ key: "key_limited", slotId: "A" }),
		rotateAccount: async () => ({ key: "key_fresh", slotId: "B" }),
	});
	const events = await collect(undefined, deps);
	assert.equal(tried.length, 2);
	assert.match(tried[0], /key_limited/);
	assert.match(tried[1], /key_fresh/);
	assert.equal(textOf(events), "second account");
});

await test("reports exhaustion when every account is rate limited", async () => {
	handler = (_req, res) => res.writeHead(429).end("nope");
	const deps = makeDeps({ rotateAccount: async () => ({ key: "same", slotId: "A" }) });
	const events = await collect(undefined, deps);
	const last = events.at(-1);
	assert.equal(last?.type, "error");
	assert.match(String((last?.error as { errorMessage: string }).errorMessage), /429|限额/);
});

await test("fails clearly when no API key is configured", async () => {
	const deps = makeDeps({
		resolveAccount: async () => {
			throw new Error("no Command Code API key found");
		},
	});
	const events = await collect(undefined, deps);
	const last = events.at(-1);
	assert.equal(last?.type, "error");
	assert.match(String((last?.error as { errorMessage: string }).errorMessage), /no Command Code API key/);
});

await test("treats an empty response as an error rather than a silent success", async () => {
	handler = (_req, res) => sse(res, []);
	const events = await collect();
	const last = events.at(-1);
	assert.equal(last?.type, "error");
	assert.match(String((last?.error as { errorMessage: string }).errorMessage), /空响应|empty/i);
});

// ---------------------------------------------------------------------------

console.log("\nrequest shaping");

await test("caps output tokens at the CLI limit on that transport", async () => {
	handler = (req, res) => {
		if (req.url?.startsWith("/provider/v1")) {
			res.writeHead(403).end(JSON.stringify({ error: { code: "upgrade_required" } }));
			return;
		}
		ndjson(res, [{ type: "text-delta", text: "ok" }, { type: "finish", finishReason: "stop" }]);
	};
	await collect({ maxTokens: 100_000 });
	const providerBody = captured[0].body;
	assert.equal(providerBody.max_tokens, 65_536, "Provider API keeps the model ceiling");
	const cliParams = captured[1].body.params as Record<string, unknown>;
	assert.equal(cliParams.max_tokens, 64_000, "CLI transport is capped at 64000");
});

await test("forwards the selected reasoning effort", async () => {
	handler = (_req, res) => sse(res, [{ choices: [{ delta: { content: "x" }, finish_reason: "stop" }] }]);
	await collect({ reasoning: "high" });
	assert.equal(captured[0].body.reasoning_effort, "high");
});

await test("omits reasoning_effort when thinking is off", async () => {
	handler = (_req, res) => sse(res, [{ choices: [{ delta: { content: "x" }, finish_reason: "stop" }] }]);
	await collect({ reasoning: "off" });
	assert.equal("reasoning_effort" in captured[0].body, false);
});

await test("sends the refreshed CLI version, not a stale constant", async () => {
	// The gateway refuses an outdated x-command-code-version with a 403 that
	// reuses the Go-plan error code, so a stale value would break every
	// CLI-transport request. The header must come from the injected getter.
	handler = (req, res) => {
		if (req.url?.startsWith("/provider/v1")) {
			res.writeHead(403).end(JSON.stringify({ error: { code: "upgrade_required" } }));
			return;
		}
		ndjson(res, [{ type: "text-delta", text: "ok" }, { type: "finish", finishReason: "stop" }]);
	};
	await collect(undefined, makeDeps({ cliVersion: () => "9.9.9" }));
	assert.equal(captured[1].headers["x-command-code-version"], "9.9.9");
});

await test("surfaces an outdated-CLI rejection instead of switching transport", async () => {
	handler = (_req, res) => {
		res.writeHead(403, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				error: {
					code: "upgrade_required",
					message: "Your Command Code CLI is out of date. Run `cmd update`.",
					minVersion: "0.18.10",
				},
			}),
		);
	};
	const events = await collect();
	// Retrying via the CLI transport cannot fix a version problem, so only
	// the Provider API should have been tried.
	assert.equal(captured.length, 1, "must not attempt the CLI transport");
	const last = events.at(-1);
	assert.equal(last?.type, "error");
	assert.match(String((last?.error as { errorMessage: string }).errorMessage), /过期|outdated/i);
});

// ---------------------------------------------------------------------------

server.close();
console.log(`\n${passed} passed${failed ? `, ${failed} failed` : ""}\n`);
