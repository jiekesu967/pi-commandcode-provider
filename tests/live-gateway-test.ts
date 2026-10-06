/**
 * Live-gateway test: exercises the real Command Code production endpoints
 * through the plugin's own transport code.
 *
 * A deliberately INVALID key is used, so no credential is needed. That is
 * still a meaningful test: it proves the endpoints, request shape, and header
 * handling are real, and that the error classification (401 → credential
 * problem, not a silent failure) behaves against the actual service rather
 * than a mock.
 *
 *   node --experimental-strip-types live-gateway-test.ts
 *
 * The authenticated success path cannot be tested here; it needs a real key.
 */
import assert from "node:assert/strict";
import type { Context, Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { streamCommandCode, type StreamDeps } from "../stream.ts";
import { DEFAULT_API_BASE, buildCliBody, cliHeaders, endpointFor, openAiHeaders } from "../wire.ts";

const INVALID_KEY = "user_0000000000000000000000000000000000000000";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>) {
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

console.log(`\nproduction gateway: ${DEFAULT_API_BASE}\n`);

await test("the model catalog is reachable without a key", async () => {
	const response = await fetch(`${DEFAULT_API_BASE}/provider/v1/models`, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(20_000),
	});
	assert.equal(response.ok, true, `expected 200, got ${response.status}`);
	const payload = (await response.json()) as { data?: unknown[] };
	assert.ok(Array.isArray(payload.data) && payload.data.length > 0, "a populated catalog");
});

await test("the Provider API endpoint exists and requires auth", async () => {
	const response = await fetch(endpointFor("openai", DEFAULT_API_BASE), {
		method: "POST",
		headers: openAiHeaders(INVALID_KEY),
		body: JSON.stringify({
			model: "deepseek/deepseek-v4.1-flash",
			messages: [{ role: "user", content: "hi" }],
			max_tokens: 16,
			stream: true,
		}),
		signal: AbortSignal.timeout(30_000),
	});
	// 401 proves the route is real and the key was actually checked.
	assert.ok(
		response.status === 401 || response.status === 403,
		`expected an auth rejection, got ${response.status}: ${(await response.text()).slice(0, 200)}`,
	);
	console.log(`      (Provider API answered ${response.status} for an invalid key)`);
});

await test("the CLI gateway accepts our request shape (rejects only the key)", async () => {
	// Build the body with the plugin's own builder. This is the meaningful
	// assertion: the gateway validates `config.*` strictly, so reaching a 401
	// proves the CLI envelope is well-formed. A hand-rolled body that omits
	// `config.structure` etc. is rejected with 400 instead.
	const body = buildCliBody(
		"deepseek/deepseek-v4.1-flash",
		[{ role: "user", content: [{ type: "text", text: "hi" }] }],
		[],
		{ maxTokens: 16, reasoningEffort: undefined, systemText: "test", workingDir: "G:/Work" },
		"00000000-0000-0000-0000-000000000000",
	);
	const response = await fetch(endpointFor("cli", DEFAULT_API_BASE), {
		method: "POST",
		headers: cliHeaders(INVALID_KEY, "G:/Work"),
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});
	const text = await response.text();
	assert.notEqual(response.status, 400, `the CLI envelope was rejected as malformed: ${text.slice(0, 300)}`);
	assert.ok(
		response.status === 401 || response.status === 403,
		`expected an auth rejection, got ${response.status}: ${text.slice(0, 200)}`,
	);
	console.log(`      (CLI gateway accepted the envelope, answered ${response.status} for the key)`);
});

await test("the engine classifies a real invalid key as a credential error", async () => {
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
	// A provider only ever sees the normalized transcript, so build it the way
	// pi does rather than with the `systemPrompt`/`tools` shorthand.
	const context: Context = normalizeContext({
		systemPrompt: "test",
		messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
	});
	const deps: StreamDeps = {
		workingDir: () => process.cwd(),
		resolveAccount: async () => ({ key: INVALID_KEY, slotId: "default" }),
		rotateAccount: async () => undefined,
		cachedTransport: () => undefined,
		rememberTransport: () => {},
		modelMaxTokens: () => 65_536,
		streamIdleTimeoutMs: () => 30_000,
		requestTimeoutMs: () => 30_000,
	};

	const events: { type: string; [key: string]: unknown }[] = [];
	for await (const event of streamCommandCode(model, context, undefined, deps, DEFAULT_API_BASE, () => false)) {
		events.push(event as { type: string; [key: string]: unknown });
	}

	// The real gateway rejected the key, so the engine must surface a real
	// error rather than hanging or reporting a bogus success.
	assert.equal(events.at(-1)?.type, "error", "an invalid key must produce an error");
	const message = String((events.at(-1)?.error as { errorMessage: string }).errorMessage);
	assert.match(message, /401|403|密钥|key/i, `unhelpful message: ${message}`);
	console.log(`      (engine surfaced: ${message.slice(0, 120)}…)`);
});

console.log(`\n${passed} passed${failed ? `, ${failed} failed` : ""}\n`);
console.log("NOTE: the authenticated success path still needs a real API key.\n");
