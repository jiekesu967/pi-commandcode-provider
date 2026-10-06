/**
 * Live end-to-end probe for the fixed adapter: one full tool round-trip
 * against the real Command Code gateway through the plugin's own stream
 * engine, using a normalized pi 0.86 context (prompt + tools carried by the
 * transcript's system message).
 *
 * Builds the request the way pi does, so a pass here means pi itself will see
 * real tool calls rather than text-mode markup.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Context, Message, Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { streamCommandCode, type StreamDeps } from "../stream.ts";
import { DEFAULT_API_BASE } from "../wire.ts";

function resolveKey(): string {
	const fromEnv = process.env.COMMANDCODE_API_KEY?.trim();
	if (fromEnv) return fromEnv;
	const piAuth = join(homedir(), ".pi", "agent", "auth.json");
	if (existsSync(piAuth)) {
		const parsed = JSON.parse(readFileSync(piAuth, "utf-8")) as Record<string, any>;
		const key = parsed.commandcode?.key ?? parsed.commandcode?.access;
		if (typeof key === "string" && key.trim()) return key.trim();
	}
	const ccAuth = join(homedir(), ".commandcode", "auth.json");
	if (existsSync(ccAuth)) {
		const parsed = JSON.parse(readFileSync(ccAuth, "utf-8")) as Record<string, any>;
		const key = parsed.apiKey ?? parsed.commandcode?.key ?? parsed.commandcode?.access;
		if (typeof key === "string" && key.trim()) return key.trim();
	}
	throw new Error("no Command Code key found");
}

const model: Model<string> = {
	id: "deepseek/deepseek-v4.1-flash",
	name: "DeepSeek V4.1 Flash",
	api: "commandcode-api",
	provider: "commandcode",
	baseUrl: DEFAULT_API_BASE,
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
};

const systemPrompt = [
	"You are an expert coding assistant operating inside pi, a coding agent harness.",
	"",
	"<tools>",
	"- read: Read file contents",
	"- bash: Execute bash commands (ls, grep, find, etc.)",
	"- edit: Make precise file edits with exact text replacement",
	"- write: Create or overwrite files",
	"</tools>",
	"",
	"<rules>",
	"- Use bash for file operations like ls, rg, find",
	"- Be concise in your responses",
	"</rules>",
].join("\n");

const tools = [
	{
		name: "read",
		description: "Read file contents",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	},
	{
		name: "bash",
		description: "Execute bash commands (ls, grep, find, etc.)",
		parameters: {
			type: "object",
			properties: { command: { type: "string" }, description: { type: "string" } },
			required: ["command"],
		},
	},
	{
		name: "edit",
		description: "Make precise file edits with exact text replacement",
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, edits: { type: "array", items: { type: "object" } } },
			required: ["path", "edits"],
		},
	},
	{
		name: "write",
		description: "Create or overwrite files",
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, content: { type: "string" } },
			required: ["path", "content"],
		},
	},
];

const deps: StreamDeps = {
	workingDir: () => process.cwd(),
	resolveAccount: async () => ({ key: resolveKey(), slotId: "default" }),
	rotateAccount: async () => undefined,
	cachedTransport: () => "cli",
	rememberTransport: () => {},
	modelMaxTokens: () => 65_536,
	streamIdleTimeoutMs: () => 120_000,
	requestTimeoutMs: () => 120_000,
	cliVersion: () => process.env.COMMANDCODE_CLI_VERSION?.trim() || "1.58.1",
};

/** Run one turn and return its events. */
async function turn(context: Context): Promise<{ type: string; [key: string]: any }[]> {
	const events: { type: string; [key: string]: any }[] = [];
	for await (const event of streamCommandCode(model, context, { reasoning: "high" }, deps, DEFAULT_API_BASE, () => true)) {
		events.push(event as { type: string; [key: string]: any });
	}
	return events;
}

const first: Context = normalizeContext({
	systemPrompt,
	messages: [{ role: "user", content: "用 bash 执行 echo hi,然后一句话告诉我结果", timestamp: Date.now() }],
	tools,
});

console.log("turn 1: expecting a real tool call, not text-mode markup");
const events = await turn(first);
const end = events.find((event) => event.type === "toolcall_end");
if (!end) {
	console.error("FAIL: no toolcall_end event");
	console.error("  text:", events.filter((e) => e.type === "text_delta").map((e) => e.delta).join(""));
	console.error("  terminal:", JSON.stringify(events.at(-1)).slice(0, 400));
	console.error("  errorMessage:", (events.at(-1)?.error as { errorMessage?: string })?.errorMessage);
	process.exit(1);
}
const call = end.toolCall as { id: string; name: string; arguments: Record<string, unknown> };
console.log(`  tool call: ${call.name} ${JSON.stringify(call.arguments)}`);
console.log(`  stopReason: ${events.at(-1)?.reason}`);
if (events.some((e) => e.type === "text_delta" && String(e.delta).includes("DSML"))) {
	console.error("FAIL: text-mode DSML markup still present");
	process.exit(1);
}

const assistant: Message = events.at(-1)?.message as Message;
const toolResult: Message = {
	role: "toolResult",
	toolCallId: call.id,
	toolName: call.name,
	content: [{ type: "text", text: "hi" }],
	isError: false,
	timestamp: Date.now(),
};

console.log("\nturn 2: feeding the tool result back");
const second = normalizeContext({ messages: [...first.messages, assistant, toolResult] });
const follow = await turn(second);
const text = follow
	.filter((event) => event.type === "text_delta")
	.map((event) => String(event.delta))
	.join("");
const terminal = follow.at(-1);
console.log(`  assistant text: ${text.slice(0, 200)}`);
console.log(`  terminal event: ${terminal?.type} (${terminal?.reason ?? ""})`);
if (terminal?.type !== "done") {
	console.error(`FAIL: turn 2 did not complete: ${JSON.stringify(terminal).slice(0, 400)}`);
	process.exit(1);
}
console.log("\nPASS: the tool loop works end to end through the real gateway");
