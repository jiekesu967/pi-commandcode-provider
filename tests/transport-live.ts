/**
 * Live A/B for the transport, measured against the real gateway with your own
 * key. Opt-in, because it spends quota (a handful of one-token completions).
 *
 *   node --experimental-strip-types transport-live.ts
 *   node run-tests.mjs transport-live
 *
 * It answers the two questions the fix has to be judged on:
 *
 *   1. Does the pin + keep-alive actually beat what pi did before? The
 *      baseline is `globalThis.fetch`, i.e. pi's own dispatcher, whose
 *      keep-alive window is undici's 4s default. Each arm spaces its requests
 *      past that window, exactly as an agent loop does.
 *   2. Does the socket really get reused? Reported from the pool itself
 *      (`transportDiagnostics`), not inferred from the timings.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createCommandCodeFetch, edgeStatus, transportDiagnostics } from "../net.ts";
import { COMMAND_CODE_CLI_VERSION, DEFAULT_API_BASE } from "../wire.ts";

const MODEL = process.env.CC_BENCH_MODEL ?? "deepseek/deepseek-v4.1-flash";
const ROUNDS = Number(process.env.CC_BENCH_ROUNDS ?? 4);
/** Longer than undici's 4s keep-alive window, like a real turn boundary. */
const GAP_MS = Number(process.env.CC_BENCH_GAP_MS ?? 6_000);

/** The key, from the plugin's own store or the official CLI's file. */
function apiKey(): string {
	const candidates = [join(homedir(), ".pi", "agent", "auth.json"), join(homedir(), ".commandcode", "auth.json")];
	for (const path of candidates) {
		try {
			const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
			const direct = parsed.apiKey;
			if (typeof direct === "string" && direct !== "") return direct;
			const nested = parsed.commandcode as { key?: unknown } | undefined;
			if (nested !== undefined && typeof nested.key === "string" && nested.key !== "") return nested.key;
		} catch {
			// Try the next location.
		}
	}
	throw new Error("没有找到 Command Code API 密钥；no Command Code API key found");
}

const key = apiKey();
const endpoint = `${DEFAULT_API_BASE}/provider/v1/chat/completions`;

/** One tiny streaming completion; returns time to the first body byte. */
async function timed(
	fetchImpl: typeof fetch,
	label: string,
): Promise<{ ttfb: number; total: number; status: number }> {
	const started = Date.now();
	const response = await fetchImpl(endpoint, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${key}`,
			accept: "text/event-stream",
			"x-command-code-version": COMMAND_CODE_CLI_VERSION,
		},
		body: JSON.stringify({
			model: MODEL,
			messages: [{ role: "user", content: "Reply with the single word: ok" }],
			max_tokens: 16,
			stream: true,
		}),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`${label}: HTTP ${response.status} ${text.slice(0, 200)}`);
	}
	const reader = response.body?.getReader();
	let ttfb = 0;
	let bytes = 0;
	if (reader !== undefined) {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			if (ttfb === 0) ttfb = Date.now() - started;
			bytes += chunk.value?.length ?? 0;
		}
	}
	return { ttfb: ttfb === 0 ? Date.now() - started : ttfb, total: Date.now() - started, status: response.status };
}

const median = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = sorted.length >> 1;
	return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

async function arm(label: string, fetchImpl: typeof fetch): Promise<number[]> {
	const times: number[] = [];
	for (let round = 0; round < ROUNDS; round += 1) {
		if (round > 0) await new Promise((resolve) => setTimeout(resolve, GAP_MS));
		const result = await timed(fetchImpl, label);
		times.push(result.ttfb);
		const pooled = transportDiagnostics()
			.map((pool) => `${pool.pool} active=${pool.active} free=${pool.free}`)
			.join("  |  ");
		console.log(
			`  ${label} #${round + 1}  ttfb=${String(result.ttfb).padStart(5)}ms  total=${String(result.total).padStart(5)}ms`,
			pooled === "" ? "" : `\n      pools: ${pooled}`,
		);
	}
	console.log(`  ${label} median ttfb=${median(times)}ms  all=[${times.join(", ")}]`);
	return times;
}

console.log(`\ntransport A/B against ${DEFAULT_API_BASE}`);
console.log(`model=${MODEL} rounds=${ROUNDS} gap=${GAP_MS}ms\n`);

const pinned = createCommandCodeFetch(() => ({ headersTimeoutMs: 120_000, connectTimeoutMs: 15_000 }));
const status = edgeStatus();
const bestEdge = status.ranking[0];
console.log(`pin: ${status.ranking.slice(0, 3).join(" > ")}`);
console.log(`quarantined: ${status.quarantined.join(", ") || "(none)"}\n`);

console.log("arm A — this plugin's transport (edge pin + keep-alive + retries)");
const improved = await arm("pin", pinned);

// The baseline resolves through the system resolver, which may itself be
// pinned (a hosts entry, for instance). Forcing our transport onto that same
// address separates "a better edge" from "a warm socket".
const systemIp = await new Promise<string | undefined>((resolve) => {
	void import("node:dns").then(({ lookup }) =>
		lookup(new URL(DEFAULT_API_BASE).hostname, { family: 4 }, (error, address) =>
			resolve(error ? undefined : address),
		),
	);
});
let sameEdge: number[] = [];
if (systemIp !== undefined) {
	console.log(`\narm B — this plugin's transport, pinned to the system resolver's address (${systemIp})`);
	const forced = createCommandCodeFetch(() => ({
		headersTimeoutMs: 120_000,
		connectTimeoutMs: 15_000,
		edgeIps: [systemIp],
		edgeProbe: false,
	}));
	sameEdge = await arm("same-edge", forced);
}

console.log("\narm C — globalThis.fetch (what pi used before: undici defaults)");
const baseline = await arm("base", ((input: string | URL | Request, init?: RequestInit) =>
	globalThis.fetch(input, init)) as typeof fetch);

const delta = median(baseline) - median(improved);
const ratio = median(improved) === 0 ? 0 : median(baseline) / median(improved);
console.log(
	`\nmedian: pin ${median(improved)}ms vs baseline ${median(baseline)}ms  →  ` +
		`${delta >= 0 ? "-" : "+"}${Math.abs(delta)}ms (${ratio.toFixed(2)}x)`,
);
if (sameEdge.length > 0) {
		console.log(
		`split:  edge choice ${median(sameEdge) - median(improved)}ms (${systemIp} → ${bestEdge}),  ` +
			`keep-alive ${median(baseline) - median(sameEdge)}ms (same address, warm socket)`,
	);
}
console.log(ratio >= 1 ? "the pinned transport is faster on this run.\n" : "no gain on this run — re-run at a different hour.\n");
