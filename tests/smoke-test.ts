/**
 * Smoke tests for the pure parts of the Command Code extension.
 *
 * These need no API key: they cover the wire-format conversions, the
 * transport classification (the Go-plan gate), credential precedence, and
 * the live catalog fetch. Run with:
 *
 *   node --experimental-strip-types smoke-test.ts
 */
import assert from "node:assert/strict";
import {
	buildCliBody,
	buildOpenAiBody,
	cliHeaders,
	endpointFor,
	fetchCliVersion,
	isCliOutOfDateError,
	isUpgradeRequiredError,
	mapFinishReason,
	parseRetryAfterMs,
	parseStreamLine,
	projectSlugFromPath,
} from "../wire.ts";
import { toCliMessages, toOpenAiMessages, hasImageContent } from "../convert.ts";
import {
	AccountPool,
	normalizeKey,
	slotsFromConfig,
	type ResolvedAccount,
} from "../accounts.ts";
import {
	capabilityDescription,
	compareByPlan,
	formatContext,
	isFreeModel,
	modelVisibleInPlan,
	parseCatalogResponse,
	peakPricingState,
	planLabel,
} from "../catalog.ts";
import { parseAccountIdentity } from "../usage.ts";

let passed = 0;
const test = (name: string, fn: () => void | Promise<void>) => {
	try {
		const result = fn();
		if (result instanceof Promise) {
			return result.then(
				() => {
					passed += 1;
					console.log(`  ok  ${name}`);
				},
				(error) => {
					console.error(`FAIL  ${name}\n      ${error.message}`);
					process.exitCode = 1;
				},
			);
		}
		passed += 1;
		console.log(`  ok  ${name}`);
	} catch (error) {
		console.error(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
	return Promise.resolve();
};

console.log("\nwire.ts");

await test("parses SSE data lines and ignores noise", () => {
	assert.deepEqual(parseStreamLine('data: {"type":"text-delta"}'), { type: "text-delta" });
	assert.deepEqual(parseStreamLine('{"a":1}'), { a: 1 });
	assert.equal(parseStreamLine(""), undefined);
	assert.equal(parseStreamLine(": keep-alive"), undefined);
	assert.equal(parseStreamLine("event: message_start"), undefined);
	assert.equal(parseStreamLine("data: [DONE]"), undefined);
	assert.equal(parseStreamLine("not json"), undefined);
});

await test("classifies the Go-plan gate and nothing else", () => {
	// The exact shapes Command Code has used for the Go restriction.
	assert.equal(isUpgradeRequiredError(403, '{"error":{"code":"upgrade_required"}}'), true);
	assert.equal(isUpgradeRequiredError(403, "Your Go plan does not include API access"), true);
	assert.equal(isUpgradeRequiredError(403, "upgrade to goat or higher"), true);
	assert.equal(isUpgradeRequiredError(403, '{"error":{"type":"upgrade_required"}}'), true);
	// Anything else must surface as a real error, not a transport switch.
	assert.equal(isUpgradeRequiredError(403, "model not in plan"), false);
	assert.equal(isUpgradeRequiredError(401, '{"error":{"code":"upgrade_required"}}'), false);
	assert.equal(isUpgradeRequiredError(429, "rate limited"), false);
	assert.equal(isUpgradeRequiredError(500, "boom"), false);
});

await test("does not mistake an outdated CLI for the Go-plan gate", () => {
	// The gateway reports BOTH conditions with error.code "upgrade_required".
	// Verified against the live API: an old x-command-code-version returns
	// this exact body. Retrying the other transport cannot help a version
	// problem, so it must not be treated as the Go gate.
	const outdated =
		'{"error":{"code":"upgrade_required","message":"Your Command Code CLI is out of date. ' +
		'Run `cmd update` or `npm i -g command-code` to upgrade.","minVersion":"0.18.10"}}';
	assert.equal(isCliOutOfDateError(outdated), true);
	assert.equal(isUpgradeRequiredError(403, outdated), false, "outdated CLI must not trigger the fallback");
	// The genuine Go gate still works when no version complaint is present.
	assert.equal(
		isUpgradeRequiredError(403, '{"error":{"code":"upgrade_required","message":"Go plan has no API access"}}'),
		true,
	);
});

await test("resolves the current CLI version from npm", async () => {
	const version = await fetchCliVersion(20_000);
	assert.ok(version !== undefined, "expected a resolvable version");
	assert.match(version, /^\d+\.\d+\.\d+/);
	// The header must stay in step with the released CLI, or the gateway
	// refuses every CLI-transport request.
	assert.notEqual(version, undefined);
	console.log(`      (bundled constant 1.53.0, npm latest ${version})`);
});

await test("builds the CLI headers the gateway gates on", () => {
	const headers = cliHeaders("user_abc", "G:/Work/my-project");
	assert.equal(headers.Authorization, "Bearer user_abc");
	assert.equal(headers["x-cli-environment"], "production");
	assert.equal(headers["x-command-code-version"], "1.53.0");
	assert.equal(headers["x-project-slug"], "my-project");
	assert.equal(headers["x-taste-learning"], "true");
	assert.equal(headers["x-co-flag"], "false");
});

await test("derives a project slug from awkward paths", () => {
	assert.equal(projectSlugFromPath("G:\\Work\\My Project\\"), "my-project");
	assert.equal(projectSlugFromPath("/home/u/some_dir.v2"), "some-dir-v2");
	assert.equal(projectSlugFromPath("/"), "project");
});

await test("targets the right endpoint per transport", () => {
	assert.equal(endpointFor("cli", "https://api.commandcode.ai"), "https://api.commandcode.ai/alpha/generate");
	assert.equal(
		endpointFor("openai", "https://api.commandcode.ai/"),
		"https://api.commandcode.ai/provider/v1/chat/completions",
	);
});

await test("maps finish reasons onto pi stop reasons", () => {
	assert.equal(mapFinishReason("tool-calls"), "toolUse");
	assert.equal(mapFinishReason("tool_calls"), "toolUse");
	assert.equal(mapFinishReason("length"), "length");
	assert.equal(mapFinishReason("max_tokens"), "length");
	assert.equal(mapFinishReason("stop"), "stop");
	assert.equal(mapFinishReason(undefined), "stop");
});

await test("parses Retry-After in both forms", () => {
	assert.equal(parseRetryAfterMs("120", 0), 120_000);
	assert.equal(parseRetryAfterMs(null), undefined);
	assert.equal(parseRetryAfterMs("garbage"), undefined);
	const future = new Date(10_000).toUTCString();
	assert.equal(parseRetryAfterMs(future, 5_000), 5_000);
});

console.log("\nconvert.ts");

const userText = {
	role: "user" as const,
	content: "hello",
	timestamp: 0,
};
const assistantWithTool = {
	role: "assistant" as const,
	content: [
		{ type: "text" as const, text: "let me check" },
		{ type: "thinking" as const, thinking: "reasoning here" },
		{ type: "toolCall" as const, id: "call_1", name: "read", arguments: { path: "a.ts" } },
	],
	api: "commandcode-api",
	provider: "commandcode",
	model: "m",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "toolUse" as const,
	timestamp: 0,
};
const toolResult = {
	role: "toolResult" as const,
	toolCallId: "call_1",
	toolName: "read",
	content: [{ type: "text" as const, text: "file contents" }],
	isError: false,
	timestamp: 0,
};

await test("converts a paired call/result for the CLI transport", () => {
	const messages = toCliMessages([userText, assistantWithTool, toolResult]);
	assert.equal(messages.length, 3);
	assert.equal(messages[0].role, "user");
	assert.equal(messages[1].role, "assistant");
	const call = (messages[1].content as Record<string, unknown>[]).find((p) => p.type === "tool-call");
	assert.ok(call, "tool-call part present");
	assert.equal(call.toolCallId, "call_1");
	assert.equal(call.toolName, "read");
	// The CLI transport has no reasoning channel, so thinking must be dropped.
	assert.equal((messages[1].content as Record<string, unknown>[]).some((p) => p.type === "thinking"), false);
	const result = messages[2].content as Record<string, unknown>[];
	assert.equal(result[0].toolCallId, "call_1");
	assert.equal(result[0].toolName, "read");
	assert.deepEqual(result[0].output, { type: "text", value: "file contents" });
});

await test("replays reasoning on the Provider API transport", () => {
	const messages = toOpenAiMessages([userText, assistantWithTool, toolResult]);
	const assistant = messages.find((m) => m.role === "assistant") as Record<string, unknown>;
	assert.equal(assistant.reasoning_content, "reasoning here");
	assert.equal(assistant.content, "let me check");
	const calls = assistant.tool_calls as Record<string, unknown>[];
	assert.equal(calls.length, 1);
	assert.equal((calls[0].function as Record<string, unknown>).name, "read");
	assert.equal((calls[0].function as Record<string, unknown>).arguments, '{"path":"a.ts"}');
	const tool = messages.find((m) => m.role === "tool") as Record<string, unknown>;
	assert.equal(tool.tool_call_id, "call_1");
	assert.equal(tool.content, "file contents");
});

await test("drops an unpaired tool call so backends do not reject the request", () => {
	const orphan = {
		...assistantWithTool,
		content: [{ type: "toolCall" as const, id: "ghost", name: "read", arguments: {} }],
	};
	const cli = toCliMessages([userText, orphan]);
	assert.equal(cli.length, 1, "only the user message survives");
	const openai = toOpenAiMessages([userText, orphan]);
	assert.equal(openai.length, 1);
});

await test("aliases overlong tool call ids to fit the 64-char gateway limit", () => {
	const longId = "x".repeat(80);
	const withLong = {
		...assistantWithTool,
		content: [{ type: "toolCall" as const, id: longId, name: "read", arguments: {} }],
	};
	const longResult = { ...toolResult, toolCallId: longId };
	const cli = toCliMessages([withLong, longResult]);
	const call = (cli[0].content as Record<string, unknown>[])[0];
	const result = (cli[1].content as Record<string, unknown>[])[0];
	assert.equal(call.toolCallId, "cc-1");
	assert.equal(result.toolCallId, "cc-1", "call and result must stay correlated");
	assert.ok(String(call.toolCallId).length <= 64);
});

await test("hoists images out of a tool result into a following user message", () => {
	const imageResult = {
		...toolResult,
		content: [
			{ type: "text" as const, text: "screenshot:" },
			{ type: "image" as const, data: "QUJD", mimeType: "image/png" },
		],
	};
	const cli = toCliMessages([assistantWithTool, imageResult]);
	const carried = cli[cli.length - 1];
	assert.equal(carried.role, "user");
	const parts = carried.content as Record<string, unknown>[];
	assert.equal(parts[0].type, "text");
	assert.match(String(parts[0].text), /Attached image/);
	assert.equal(parts[1].type, "image");
});

await test("detects image content for the vision gate", () => {
	assert.equal(hasImageContent([userText]), false);
	assert.equal(
		hasImageContent([
			{
				role: "user" as const,
				content: [{ type: "image" as const, data: "x", mimeType: "image/png" }],
				timestamp: 0,
			},
		]),
		true,
	);
});

await test("builds both request bodies with the right shape", () => {
	const facts = { maxTokens: 1000, reasoningEffort: "high", systemText: "sys", workingDir: "/tmp" };
	const tools = [{ name: "read", description: "read a file", parameters: { type: "object" } }];
	const cli = buildCliBody("m", [], tools, facts, "thread-1");
	assert.equal(cli.threadId, "thread-1");
	const params = cli.params as Record<string, unknown>;
	assert.equal(params.model, "m");
	assert.equal(params.reasoning_effort, "high");
	assert.equal(params.system, "sys");
	const config = cli.config as Record<string, unknown>;
	assert.equal(config.workingDir, "/tmp");

	const openai = buildOpenAiBody("m", "sys", [{ role: "user", content: "hi" }], tools, facts);
	assert.equal(openai.model, "m");
	assert.equal(openai.reasoning_effort, "high");
	const messages = openai.messages as Record<string, unknown>[];
	assert.equal(messages[0].role, "system");
	assert.equal(messages[0].content, "sys");
	assert.equal(messages[1].role, "user");
	const openaiTools = openai.tools as Record<string, unknown>[];
	assert.equal((openaiTools[0].function as Record<string, unknown>).name, "read");
});

console.log("\naccounts.ts");

await test("normalizes blank keys to undefined", () => {
	assert.equal(normalizeKey("  user_abc  "), "user_abc");
	assert.equal(normalizeKey("   "), undefined);
	assert.equal(normalizeKey(undefined), undefined);
});

await test("builds slots with the default first and skips empty entries", () => {
	const slots = slotsFromConfig(
		[{ label: "Go #2", apiKeyEnv: "CC_KEY_2" }, { label: "empty" }, { apiKey: "literal_key" }],
		"COMMANDCODE_API_KEY",
		"默认账户",
	);
	assert.equal(slots.length, 3);
	assert.equal(slots[0].id, "COMMANDCODE_API_KEY");
	assert.equal(slots[0].allowAuthFile, true);
	assert.equal(slots[1].id, "CC_KEY_2");
	assert.equal(slots[1].allowAuthFile, false);
	assert.equal(slots[2].apiKey, "literal_key");
});

await test("rotates to the next account and exhausts cleanly", async () => {
	process.env.CC_TEST_KEY_A = "key-a";
	process.env.CC_TEST_KEY_B = "key-b";
	const pool = new AccountPool(
		() => [
			{ id: "A", label: "A", apiKeyEnv: "CC_TEST_KEY_A", allowAuthFile: false },
			{ id: "B", label: "B", apiKeyEnv: "CC_TEST_KEY_B", allowAuthFile: false },
		],
		() => undefined,
		async () => ({ exceeded: true, resetAt: Date.now() + 60_000 }),
	);

	const first = await pool.resolveKey();
	assert.equal(first?.key, "key-a", "first slot wins");
	pool.markRejected("key-a", "rate-limit");
	const second = await pool.resolveKey();
	assert.equal(second?.key, "key-b", "failed account rotates away");
	pool.markRejected("key-b", "rate-limit");
	await assert.rejects(() => pool.resolveKey(), /已用尽|exhausted/, "all accounts exhausted must throw");
	delete process.env.CC_TEST_KEY_A;
	delete process.env.CC_TEST_KEY_B;
});

await test("disables an account whose key was rejected with 401", async () => {
	process.env.CC_TEST_KEY_C = "key-c";
	const pool = new AccountPool(
		() => [{ id: "C", label: "C", apiKeyEnv: "CC_TEST_KEY_C", allowAuthFile: false }],
		() => undefined,
		async () => ({ exceeded: false, resetAt: 0 }),
	);
	await pool.resolveKey();
	pool.markRejected("key-c", "invalid-credential");
	await assert.rejects(() => pool.resolveKey(), /401/);
	delete process.env.CC_TEST_KEY_C;
});

await test("revives an account whose window has reset", async () => {
	process.env.CC_TEST_KEY_D = "key-d";
	let exceeded = true;
	const pool = new AccountPool(
		() => [{ id: "D", label: "D", apiKeyEnv: "CC_TEST_KEY_D", allowAuthFile: false }],
		() => undefined,
		async () => ({ exceeded, resetAt: Date.now() + 60_000 }),
	);
	await pool.resolveKey();
	pool.markRejected("key-d", "rate-limit");
	exceeded = false; // the 5-hour window rolled over
	const revived = await pool.resolveKey();
	assert.equal(revived?.key, "key-d");
	delete process.env.CC_TEST_KEY_D;
});

console.log("\ncatalog.ts");

await test("annotates capabilities from the snapshot", () => {
	assert.equal(planLabel("claude-opus-5"), "Provider");
	assert.equal(planLabel("deepseek/deepseek-v4.1-flash"), "Go");
	assert.equal(isFreeModel("poolside/laguna-s-2.1-free"), true);
	assert.equal(isFreeModel("claude-opus-5"), false);
	assert.equal(formatContext(1_000_000), "1M");
	assert.equal(formatContext(200_000), "200K");
	const description = capabilityDescription("deepseek/deepseek-v4.1-flash", 1_000_000);
	assert.match(description, /Go/);
	assert.match(description, /Image/);
	assert.match(description, /1M/);
});

await test("marks peak pricing only on weekdays in the peak window", () => {
	// 2026-09-14 is a Monday; 03:00 UTC falls in the 01:00-04:00 window.
	const mondayPeak = Date.UTC(2026, 8, 14, 3, 0, 0);
	assert.equal(peakPricingState("deepseek/deepseek-v4-pro", mondayPeak), "peak");
	const mondayOff = Date.UTC(2026, 8, 14, 12, 0, 0);
	assert.equal(peakPricingState("deepseek/deepseek-v4-pro", mondayOff), "off-peak");
	// 2026-09-13 is a Sunday: always off-peak.
	const sunday = Date.UTC(2026, 8, 13, 3, 0, 0);
	assert.equal(peakPricingState("deepseek/deepseek-v4-pro", sunday), "off-peak");
	assert.equal(peakPricingState("claude-opus-5", mondayPeak), undefined);
});

await test("gates models by plan, failing open on uncertainty", () => {
	// Provider-tier models are hidden from a Go account...
	assert.equal(modelVisibleInPlan("claude-opus-5", 0), false);
	// ...but Go models stay visible...
	assert.equal(modelVisibleInPlan("deepseek/deepseek-v4.1-flash", 0), true);
	// ...and an unknown tier or unknown model never hides anything.
	assert.equal(modelVisibleInPlan("claude-opus-5", undefined), true);
	assert.equal(modelVisibleInPlan("some/unlisted-model", 0), true);
	// A Provider-tier (weight 3) account sees Provider models.
	assert.equal(modelVisibleInPlan("claude-opus-5", 3), true);
});

await test("sorts free models first, then by tier", () => {
	const models = [
		{ id: "claude-opus-5", name: "Opus", contextWindow: 1, maxTokens: 1, vision: true, tier: "provider" as const },
		{ id: "poolside/laguna-s-2.1-free", name: "Laguna", contextWindow: 1, maxTokens: 1, vision: false, tier: "go" as const },
		{ id: "deepseek/deepseek-v4.1-flash", name: "V4.1", contextWindow: 1, maxTokens: 1, vision: true, tier: "go" as const },
	];
	models.sort(compareByPlan);
	assert.equal(models[0].id, "poolside/laguna-s-2.1-free", "free model leads");
	assert.equal(models[1].tier, "go");
	assert.equal(models[2].tier, "provider");
});

await test("parses the catalog and skips malformed entries", () => {
	const parsed = parseCatalogResponse({
		object: "list",
		data: [
			{ id: "m1", name: "Model One", context_length: 200_000 },
			{ id: "", name: "no id", context_length: 1 },
			{ id: "m2", name: "No context" },
			"not an object",
		],
	});
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].id, "m1");
	assert.equal(parsed[0].contextWindow, 200_000);
	assert.throws(() => parseCatalogResponse({ object: "list", data: [] }), /空|empty/);
	assert.throws(() => parseCatalogResponse({ nope: true }), /格式|shape/);
});

console.log("\nusage.ts");

await test("extracts account identity from whoami", () => {
	assert.deepEqual(parseAccountIdentity({ user: { email: "a@b.c" }, org: { id: "org_1" } }), {
		account: "a@b.c",
		orgId: "org_1",
	});
	assert.deepEqual(parseAccountIdentity({}), {});
	assert.deepEqual(parseAccountIdentity(undefined), {});
});

console.log("\nlive catalog");

await test("fetches the real model catalog", async () => {
	const response = await fetch("https://api.commandcode.ai/provider/v1/models", {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(20_000),
	});
	assert.equal(response.ok, true, `HTTP ${response.status}`);
	const models = parseCatalogResponse(await response.json());
	assert.ok(models.length > 10, `expected a populated catalog, got ${models.length}`);
	const withTier = models.filter((model) => model.tier !== undefined);
	assert.ok(withTier.length > 10, "most catalog models should have a known plan tier");
	console.log(
		`      (${models.length} models, ${withTier.length} with known tier, ` +
			`${models.filter((m) => m.vision).length} vision)`,
	);
});

console.log(`\n${passed} passed${process.exitCode ? ", with failures" : ""}\n`);
