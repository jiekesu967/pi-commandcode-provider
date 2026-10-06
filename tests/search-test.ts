/**
 * Tests for the Command Code web tools (`search.ts`).
 *
 * Everything here runs against an injected `fetch`, so no key and no network
 * are needed. The most valuable assertion is the first one: the request
 * headers must be exactly what `cliHeaders()` produces, because a drift
 * between this file and the CLI's first-party header set is what silently
 * turns a working search into a 403 nobody can explain.
 *
 *   node --experimental-strip-types search-test.ts
 */
import assert from "node:assert/strict";

import {
	buildFetchBody,
	buildSearchBody,
	classifyHttpStatus,
	cleanDomains,
	clampNumResults,
	CommandCodeSearchError,
	describeSearchError,
	MAX_NUM_RESULTS,
	MIN_NUM_RESULTS,
	parseFetchPayload,
	parseSearchPayload,
	readSettings,
	renderSearchText,
	SearchClient,
	truncateContent,
	TtlCache,
	type SearchDeps,
} from "../search.ts";
import { cliHeaders } from "../wire.ts";

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

// ---------------------------------------------------------------------------
// A fetch double: records every request, answers from a scripted queue.
// ---------------------------------------------------------------------------

interface Captured {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

function fakeResponse(status: number, payload: unknown, headers: Record<string, string> = {}): Response {
	const body = typeof payload === "string" ? payload : JSON.stringify(payload);
	return new Response(body, {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

function scriptedFetch(responses: (Response | (() => Response))[]): {
	fetchImpl: typeof fetch;
	captured: Captured[];
	remaining: () => number;
} {
	const queue = [...responses];
	const captured: Captured[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
			headers[key.toLowerCase()] = value;
		}
		captured.push({
			url,
			method: init?.method ?? "GET",
			headers,
			body: JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>,
		});
		const next = queue.shift();
		if (next === undefined) throw new Error("unexpected request: the scripted queue is empty");
		return typeof next === "function" ? next() : next;
	}) as unknown as typeof fetch;
	return { fetchImpl, captured, remaining: () => queue.length };
}

const SEARCH_OK = {
	query: "pi coding agent",
	results: [
		{ title: "Pi", url: "https://pi.dev/", snippet: "coding agent" },
		{ title: "Duplicate", url: "https://pi.dev/", snippet: "same url again" },
		{ title: "No URL at all" },
		{ title: "Docs", url: "https://example.com/docs", snippet: "" },
	],
	formatted: "Search results for: pi coding agent\n\n1. **Pi**\n   https://pi.dev/\n   coding agent",
};

const ACCOUNTS = [
	{ key: "user_first", slotId: "COMMANDCODE_API_KEY" },
	{ key: "user_second", slotId: "COMMANDCODE_API_KEY_2" },
];

function deps(overrides: Partial<SearchDeps> & { fetchImpl: typeof fetch }): {
	deps: SearchDeps;
	rejected: { key: string; rejection: string }[];
	resolved: (string | undefined)[];
} {
	const rejected: { key: string; rejection: string }[] = [];
	const resolved: (string | undefined)[] = [];
	let index = 0;
	const base: SearchDeps = {
		apiBase: () => "https://api.commandcode.ai",
		cliVersion: () => "1.53.0",
		workingDir: () => "G:/Work/my-project",
		resolveAccount: async (options) => {
			resolved.push(options?.exclude);
			const pool = ACCOUNTS.filter((account) => account.key !== options?.exclude);
			const account = pool[index % pool.length];
			index += 1;
			return account;
		},
		markRejected: (key, rejection) => {
			rejected.push({ key, rejection });
		},
		cacheTtlMs: () => 600_000,
		timeoutMs: () => 60_000,
		maxContentChars: () => 20_000,
		...overrides,
	};
	return { deps: base, rejected, resolved };
}

// ---------------------------------------------------------------------------

console.log("\nsearch.ts · shaping");

await test("clamps numResults into the server's 1–10 window", () => {
	assert.equal(clampNumResults(undefined), 5);
	assert.equal(clampNumResults(0), MIN_NUM_RESULTS);
	assert.equal(clampNumResults(-3), MIN_NUM_RESULTS);
	assert.equal(clampNumResults(50), MAX_NUM_RESULTS, "the server answers 400 above 10");
	assert.equal(clampNumResults(10), 10);
	assert.equal(clampNumResults(7.4), 7);
	assert.equal(clampNumResults(Number.NaN), 5);
	assert.equal(clampNumResults(undefined, 3), 3);
});

await test("cleans and deduplicates domain lists", () => {
	assert.equal(cleanDomains(undefined), undefined);
	assert.equal(cleanDomains([]), undefined);
	assert.equal(cleanDomains(["", "   "]), undefined);
	assert.deepEqual(cleanDomains([" a.com", "a.com", "b.com "]), ["a.com", "b.com"]);
});

await test("builds the search body the CLI sends", () => {
	assert.deepEqual(buildSearchBody({ query: "latest model 2026" }), {
		query: "latest model 2026",
		numResults: 5,
	});
	assert.deepEqual(buildSearchBody({ query: "q", numResults: 50 }), { query: "q", numResults: 10 });
	const withDomains = buildSearchBody({
		query: "q",
		numResults: 2,
		allowedDomains: ["docs.rs"],
		blockedDomains: ["zhihu.com"],
	});
	assert.deepEqual(withDomains, {
		query: "q",
		numResults: 2,
		allowedDomains: ["docs.rs"],
		blockedDomains: ["zhihu.com"],
	});
	// Empty domain arrays must not be sent at all: the server validates them.
	assert.deepEqual(buildSearchBody({ query: "q", allowedDomains: [] }), { query: "q", numResults: 5 });
	assert.deepEqual(buildFetchBody("https://example.com"), { url: "https://example.com" });
});

await test("parses a search payload: trims, drops rows without a URL, deduplicates", () => {
	const parsed = parseSearchPayload(SEARCH_OK);
	assert.equal(parsed.sources.length, 2, "the duplicate and the URL-less row are dropped");
	assert.deepEqual(parsed.sources[0], { url: "https://pi.dev/", title: "Pi", snippet: "coding agent" });
	assert.deepEqual(parsed.sources[1], { url: "https://example.com/docs", title: "Docs" }, "empty snippet dropped");
	assert.equal(typeof parsed.formatted, "string");
});

await test("rejects a payload without a results array", () => {
	assert.throws(
		() => parseSearchPayload({ error: "nope" }),
		(error: unknown) => error instanceof CommandCodeSearchError && error.kind === "protocol",
	);
});

await test("renders the server's formatted block and appends missing URLs", () => {
	const parsed = parseSearchPayload(SEARCH_OK);
	const text = renderSearchText(parsed, "pi coding agent");
	assert.ok(text.includes("1. **Pi**"), "keeps the server's rendering");
	assert.ok(text.includes("来源:"), "appends the sources the body never mentioned");
	assert.ok(text.includes("https://example.com/docs"));
	assert.equal(text.includes("- https://pi.dev/"), false, "does not repeat a URL already present");
});

await test("builds its own listing when the server sends no formatted block", () => {
	const parsed = parseSearchPayload({ results: [{ title: "T", url: "https://a.test/", snippet: "s" }] });
	const text = renderSearchText(parsed, "q");
	assert.ok(text.startsWith("Search results for: q"));
	assert.ok(text.includes("1. T"));
	assert.ok(text.includes("https://a.test/"));
});

await test("parses and truncates fetched content client-side", () => {
	const parsed = parseFetchPayload({ content: "hello", url: "https://example.com/", status: 200 });
	assert.deepEqual(parsed, { content: "hello", url: "https://example.com/", status: 200 });
	assert.throws(
		() => parseFetchPayload({ url: "https://example.com/" }),
		(error: unknown) => error instanceof CommandCodeSearchError && error.kind === "protocol",
	);

	// The endpoint ignores maxChars, so the cut has to happen here.
	const long = "x".repeat(120);
	const cut = truncateContent(long, 100);
	assert.equal(cut.truncated, true);
	assert.ok(cut.text.startsWith("x".repeat(100)));
	assert.ok(cut.text.includes("120"));
	assert.deepEqual(truncateContent("short", 100), { text: "short", truncated: false });
	assert.deepEqual(truncateContent(long, 0), { text: long, truncated: false });
});

await test("classifies HTTP failures the way the adapter does", () => {
	assert.equal(classifyHttpStatus(401, "{}"), "invalid-key");
	assert.equal(classifyHttpStatus(429, "{}"), "rate-limit");
	assert.equal(classifyHttpStatus(400, "{}"), "bad-request");
	assert.equal(classifyHttpStatus(500, "{}"), "server");
	assert.equal(classifyHttpStatus(403, "upgrade to goat or higher"), "forbidden");
	// A stale client is reported with the SAME error code as the plan gate;
	// retrying another account cannot cure it, so it must be classified apart.
	const outdated = JSON.stringify({
		error: { code: "upgrade_required", message: "Your Command Code CLI is out of date.", minVersion: "0.18.10" },
	});
	assert.equal(classifyHttpStatus(403, outdated), "outdated-client");
	const described = describeSearchError(new CommandCodeSearchError("outdated-client", "out of date", { hint: undefined }));
	assert.ok(described.text.includes("out of date"));
});

console.log("\nsearch.ts · client");

await test("sends the CLI's own first-party headers to the real route", async () => {
	const { fetchImpl, captured } = scriptedFetch([fakeResponse(200, SEARCH_OK)]);
	const { deps: injected } = deps({ fetchImpl });
	const client = new SearchClient(injected);
	const outcome = await client.search({ query: "pi coding agent", numResults: 3 });

	assert.equal(captured.length, 1);
	assert.equal(captured[0].url, "https://api.commandcode.ai/alpha/web-search");
	assert.equal(captured[0].method, "POST");
	// The whole point: search rides the same credential chain and header set
	// as the model transport, so nothing extra has to be configured.
	assert.deepEqual(captured[0].headers, toLower(cliHeaders("user_first", "G:/Work/my-project", "1.53.0")));
	assert.deepEqual(captured[0].body, { query: "pi coding agent", numResults: 3 });
	assert.equal(outcome.sources.length, 2);
	assert.equal(outcome.cached, false);
	assert.equal(outcome.account, "COMMANDCODE_API_KEY");
});

await test("a base URL with a trailing slash does not double up", async () => {
	const { fetchImpl, captured } = scriptedFetch([fakeResponse(200, SEARCH_OK)]);
	const { deps: injected } = deps({ fetchImpl, apiBase: () => "https://api.commandcode.ai/" });
	await new SearchClient(injected).search({ query: "q" });
	assert.equal(captured[0].url, "https://api.commandcode.ai/alpha/web-search");
});

await test("rotates to the next account on 401 and remembers the rejection", async () => {
	const { fetchImpl, captured } = scriptedFetch([
		fakeResponse(401, { error: { code: "UNAUTHORIZED" } }),
		fakeResponse(200, SEARCH_OK),
	]);
	const { deps: injected, rejected, resolved } = deps({ fetchImpl });
	const outcome = await new SearchClient(injected).search({ query: "q" });

	assert.equal(captured.length, 2, "one retry, on the other account");
	assert.equal(captured[1].headers.authorization, "Bearer user_second");
	assert.deepEqual(rejected, [{ key: "user_first", rejection: "invalid-credential" }]);
	assert.equal(resolved[1], "user_first", "the rejected key is excluded");
	assert.equal(outcome.account, "COMMANDCODE_API_KEY_2");
});

await test("rotates on 429 too, with the retry-after advice", async () => {
	const { fetchImpl, captured } = scriptedFetch([
		fakeResponse(429, { error: { code: "RATE_LIMIT" } }, { "retry-after": "30" }),
		fakeResponse(200, SEARCH_OK),
	]);
	const { deps: injected, rejected } = deps({ fetchImpl });
	await new SearchClient(injected).search({ query: "q" });
	assert.equal(captured.length, 2);
	assert.deepEqual(rejected, [{ key: "user_first", rejection: "rate-limit" }]);
});

await test("stops after trying every account and reports the last rejection", async () => {
	const { fetchImpl, captured } = scriptedFetch([
		fakeResponse(401, { error: { code: "UNAUTHORIZED" } }),
		fakeResponse(401, { error: { code: "UNAUTHORIZED" } }),
		fakeResponse(401, { error: { code: "UNAUTHORIZED" } }),
	]);
	const { deps: injected } = deps({ fetchImpl, maxAccountAttempts: 3 });
	await assert.rejects(
		() => new SearchClient(injected).search({ query: "q" }),
		(error: unknown) => error instanceof CommandCodeSearchError && error.kind === "invalid-key",
	);
	assert.equal(captured.length, 3, "bounded: one attempt per account");
});

await test("does not rotate on a bad request or a stale client", async () => {
	for (const response of [
		fakeResponse(400, { error: { code: "BAD_REQUEST" } }),
		fakeResponse(403, JSON.stringify({ error: { code: "upgrade_required", message: "CLI is out of date", minVersion: "9.9.9" } })),
	]) {
		const { fetchImpl, captured } = scriptedFetch([response]);
		const { deps: injected, rejected } = deps({ fetchImpl });
		await assert.rejects(() => new SearchClient(injected).search({ query: "q" }));
		assert.equal(captured.length, 1, "no second account is spent on a non-credential failure");
		assert.equal(rejected.length, 0);
	}
});

await test("reports a missing key without making a request", async () => {
	const { fetchImpl, captured } = scriptedFetch([]);
	const { deps: injected } = deps({ fetchImpl, resolveAccount: async () => undefined });
	await assert.rejects(
		() => new SearchClient(injected).search({ query: "q" }),
		(error: unknown) => error instanceof CommandCodeSearchError && error.kind === "no-key",
	);
	assert.equal(captured.length, 0);
});

await test("serves an identical query from cache and clamps the cache off", async () => {
	const { fetchImpl, captured, remaining } = scriptedFetch([fakeResponse(200, SEARCH_OK)]);
	const { deps: injected } = deps({ fetchImpl });
	const client = new SearchClient(injected);

	const first = await client.search({ query: "q", numResults: 5 });
	const second = await client.search({ query: "q", numResults: 5 });
	assert.equal(captured.length, 1, "the second call never hit the network");
	assert.equal(second.cached, true);
	assert.equal(typeof second.cacheAgeMs, "number");
	assert.equal(first.cached, false);
	assert.equal(remaining(), 0);

	// A different cap is a different query as far as the cache is concerned.
	await assert.rejects(() => client.search({ query: "q", numResults: 7 }));
	assert.equal(captured.length, 2);
});

await test("respects a zero TTL, which disables caching", async () => {
	const { fetchImpl, captured } = scriptedFetch([
		fakeResponse(200, SEARCH_OK),
		fakeResponse(200, SEARCH_OK),
	]);
	const { deps: injected } = deps({ fetchImpl, cacheTtlMs: () => 0 });
	const client = new SearchClient(injected);
	await client.search({ query: "q" });
	await client.search({ query: "q" });
	assert.equal(captured.length, 2);
	assert.equal(client.cacheSize, 0);
});

await test("fetches a page through the server and truncates it", async () => {
	const { fetchImpl, captured } = scriptedFetch([
		fakeResponse(200, { content: "y".repeat(500), url: "https://example.com/", status: 200 }),
	]);
	const { deps: injected } = deps({ fetchImpl });
	const outcome = await new SearchClient(injected).fetchPage({ url: "https://example.com", maxChars: 100 });

	assert.equal(captured[0].url, "https://api.commandcode.ai/alpha/web-fetch");
	assert.deepEqual(captured[0].body, { url: "https://example.com" });
	assert.equal(outcome.truncated, true);
	assert.ok(outcome.text.startsWith("y".repeat(100)));
	assert.equal(outcome.status, 200);
});

await test("surfaces a timeout instead of hanging, and an abort as an abort", async () => {
	const stall = (async (_input: unknown, init?: RequestInit) => {
		return await new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		});
	}) as unknown as typeof fetch;

	// A server that never answers must fail as a timeout, not hang forever.
	const { deps: timedOut } = deps({ fetchImpl: stall, timeoutMs: () => 20 });
	await assert.rejects(
		() => new SearchClient(timedOut).search({ query: "q" }),
		(error: unknown) => error instanceof CommandCodeSearchError && error.kind === "timeout",
	);

	// An already-aborted caller never reaches the network at all.
	const { fetchImpl, captured } = scriptedFetch([fakeResponse(200, SEARCH_OK)]);
	const { deps: injected } = deps({ fetchImpl });
	const aborted = new AbortController();
	aborted.abort();
	await assert.rejects(
		() => new SearchClient(injected).search({ query: "q" }, aborted.signal),
		(error: unknown) => error instanceof CommandCodeSearchError && error.kind === "aborted",
	);
	assert.equal(captured.length, 0);

	// Aborting mid-flight also reports as an abort, not as a network error.
	const { deps: live } = deps({ fetchImpl: stall, timeoutMs: () => 60_000 });
	const controller = new AbortController();
	const pending = new SearchClient(live).search({ query: "q" }, controller.signal);
	controller.abort();
	await assert.rejects(
		() => pending,
		(error: unknown) => error instanceof CommandCodeSearchError && error.kind === "aborted",
	);
});

await test("classifies a network failure", async () => {
	const { deps: injected } = deps({
		fetchImpl: (async () => {
			throw new TypeError("fetch failed");
		}) as unknown as typeof fetch,
	});
	await assert.rejects(
		() => new SearchClient(injected).search({ query: "q" }),
		(error: unknown) => error instanceof CommandCodeSearchError && error.kind === "network",
	);
});

await test("the TTL cache expires entries and reports its size", async () => {
	let ttl = 1_000;
	const cache = new TtlCache<number>(() => ttl);
	cache.set("a", 1);
	assert.equal(cache.size, 1);
	assert.equal(cache.get("a")?.value, 1);
	ttl = 0;
	assert.equal(cache.get("a"), undefined, "ttl 0 disables reads");
	assert.equal(cache.get("missing"), undefined);
});

await test("reads settings without throwing on a missing or broken file", () => {
	// Whatever this machine happens to have configured, the reader must
	// return an object and never throw.
	const settings = readSettings();
	assert.equal(typeof settings, "object");
});

function toLower(headers: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

console.log(`\n${passed} check(s) passed`);
