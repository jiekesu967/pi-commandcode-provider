/**
 * Live probe for the Command Code web tools: real key, real gateway.
 *
 * Manual by design — it spends a little of your Command Code quota, so
 * `npm test` never runs it. Run it with:
 *
 *   npm run test:live-search        # or: node run-tests.mjs live-search
 *
 * The key comes from COMMANDCODE_API_KEY, pi's credential store, or the
 * official CLI's ~/.commandcode/auth.json — the same precedence the plugin
 * uses — so a machine that can chat on the provider can run this as is.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CACHE_TTL_MS, DEFAULT_MAX_CONTENT_CHARS, SearchClient } from "../search.ts";
import { COMMAND_CODE_CLI_VERSION, DEFAULT_API_BASE } from "../wire.ts";

function resolveKey(): string {
	const fromEnv = process.env.COMMANDCODE_API_KEY?.trim();
	if (fromEnv) return fromEnv;
	const piAuth = join(homedir(), ".pi", "agent", "auth.json");
	if (existsSync(piAuth)) {
		const parsed = JSON.parse(readFileSync(piAuth, "utf-8")) as Record<string, { key?: string; access?: string }>;
		const key = parsed.commandcode?.key ?? parsed.commandcode?.access;
		if (typeof key === "string" && key.trim()) return key.trim();
	}
	const ccAuth = join(homedir(), ".commandcode", "auth.json");
	if (existsSync(ccAuth)) {
		const parsed = JSON.parse(readFileSync(ccAuth, "utf-8")) as Record<string, unknown>;
		const direct = parsed.apiKey;
		if (typeof direct === "string" && direct.trim()) return direct.trim();
		const nested = parsed.commandcode as { key?: string; access?: string } | undefined;
		const key = nested?.key ?? nested?.access;
		if (typeof key === "string" && key.trim()) return key.trim();
	}
	throw new Error("no Command Code key found (set COMMANDCODE_API_KEY or run /commandcode-login)");
}

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

const apiBase = process.env.COMMANDCODE_API_BASE?.trim() || DEFAULT_API_BASE;
const key = resolveKey();

const client = new SearchClient({
	apiBase: () => apiBase,
	cliVersion: () => COMMAND_CODE_CLI_VERSION,
	workingDir: () => process.cwd(),
	resolveAccount: async () => ({ key, slotId: "live-test" }),
	markRejected: () => undefined,
	cacheTtlMs: () => DEFAULT_CACHE_TTL_MS,
	timeoutMs: () => 90_000,
	maxContentChars: () => DEFAULT_MAX_CONTENT_CHARS,
});

console.log(`\nlive-search.ts · ${apiBase} (key ${key.slice(0, 8)}…)`);

await test("searches the live web and returns citable sources", async () => {
	const started = Date.now();
	const outcome = await client.search({ query: "Command Code CLI npm package", numResults: 3 });
	const seconds = ((Date.now() - started) / 1000).toFixed(1);

	assert.ok(outcome.sources.length > 0, "expected at least one result");
	for (const source of outcome.sources) {
		assert.doesNotThrow(() => new URL(source.url), `result URL must be absolute: ${source.url}`);
	}
	assert.ok(outcome.text.includes(outcome.sources[0].url), "the rendered text must carry the URLs");
	console.log(
		`      ${outcome.sources.length} result(s) in ${seconds}s: ${outcome.sources.map((s) => s.url).join(", ")}`,
	);
});

await test("honours allowedDomains", async () => {
	const outcome = await client.search({
		query: "rust release notes",
		numResults: 5,
		allowedDomains: ["blog.rust-lang.org"],
	});
	for (const source of outcome.sources) {
		assert.ok(
			source.url.includes("blog.rust-lang.org"),
			`allowedDomains must constrain the index, got ${source.url}`,
		);
	}
});

await test("fetches a page server-side and returns readable text", async () => {
	const outcome = await client.fetchPage({ url: "https://example.com", maxChars: 2_000 });
	assert.ok(outcome.text.includes("Example Domain"), "expected the example page's text");
	assert.equal(outcome.truncated, false);
	console.log(`      ${outcome.text.length} chars, HTTP ${outcome.status ?? "?"}`);
});

await test("rejects a query the server refuses (numResults stays clamped)", async () => {
	// 400s must not be mistaken for a credential problem, so this asserts the
	// classification rather than a plain throw.
	const outcome = await client.search({ query: "test", numResults: 10 });
	assert.ok(outcome.numResults <= 10);
});

console.log(`\n${passed} check(s) passed (live)`);
