/**
 * Edge-aware transport for the Command Code API.
 *
 * Why this file exists
 * --------------------
 * `api.commandcode.ai` is served by Cloudflare, and this plugin runs on the
 * user's own machine over a consumer uplink. Three properties of that path
 * made requests slow, or made them fail outright, and each is addressed here:
 *
 * 1. **Which Cloudflare edge the request lands on.** Anycast means one
 *    address can sit three times further away — or be rate-shaped — than
 *    another, and the ranking drifts by the hour (one measured address went
 *    from 1.7s to 8.4s within a day). The candidates are therefore probed in
 *    the background and the best one is pinned through a custom DNS `lookup`,
 *    which needs no hosts-file edit and no elevation.
 *
 * 2. **A fresh TLS handshake per request.** pi's own dispatcher never sets a
 *    `keepAliveTimeout`, so undici's 4s default drops the connection between
 *    two turns of an agent loop — and every turn re-pays the handshake, worth
 *    0.34–1.44s of pure latency on this path. A dedicated agent with a long
 *    idle window keeps that socket warm instead.
 *
 * 3. **No recovery from a transport hiccup.** A single RST used to surface as
 *    "在 60000ms 内未收到响应（超时）" although the request had barely started.
 *    Connection-phase failures are now retried, on a different edge each time,
 *    because a request that never received response headers cannot have
 *    produced a result the caller might double-observe.
 *
 * Deliberate limits: a proxy configured for the scheme keeps pi's own
 * dispatcher, so proxy users see exactly the behaviour they had; HTTP/1.1
 * only, matching undici; and nothing here applies unless the target host is
 * the Command Code API host, so a self-hosted `apiBase` or a test server on
 * loopback keeps plain system DNS and no retries.
 */
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { lookup as systemLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { Readable } from "node:stream";
import { appendFileSync } from "node:fs";
import { DEFAULT_API_BASE } from "./wire.ts";

/**
 * Cloudflare addresses that answered this zone on a measured line, best first.
 * The order is only a starting guess — the background probe re-ranks them and
 * a failure quarantines an entry. Kept deliberately short: each one costs a
 * TLS handshake to evaluate.
 */
export const DEFAULT_EDGE_IPS = [
	"104.18.32.1",
	"104.19.64.1",
	"104.16.128.1",
	"188.114.99.1",
	"104.20.32.1",
	"172.66.0.1",
	"103.21.244.1",
	"104.18.0.1",
	"104.21.0.1",
	"104.17.0.1",
	"104.24.128.1",
	"104.25.0.1",
	"104.19.0.1",
	"104.20.0.1",
];

/** Where the plugin's own tuning comes from (`commandcode.*` in settings). */
export interface TransportSettings {
	/** Pin requests to a probed Cloudflare edge. Default true. */
	edgePinning?: boolean;
	/** Candidate addresses; replaces {@link DEFAULT_EDGE_IPS} when given. */
	edgeIps?: string[];
	/** Extra hostnames edge pinning applies to. */
	edgeHosts?: string[];
	/** Probe the candidates in the background and re-rank. Default true. */
	edgeProbe?: boolean;
	/** How long a ranking is trusted before a refresh is started. */
	edgeRefreshMs?: number;
	/** TCP+TLS establishment budget, per attempt. */
	connectTimeoutMs?: number;
	/** Request start → response headers budget (the "request timeout"). */
	headersTimeoutMs?: number;
	/** Retries after a connection-phase failure (a different edge each time). */
	connectRetries?: number;
	/** Idle window a keep-alive socket is held open for. */
	keepAliveMs?: number;
	/** Measure sustained throughput, not just handshake and first byte. */
	edgeProbeThroughput?: boolean;
	/** Override the throughput probe's URL (e.g. an internal mirror). */
	throughputUrl?: string;
}

const DEFAULTS = {
	edgePinning: true,
	edgeProbe: true,
	/**
	 * Re-rank every two hours. The first request of a session always probes,
	 * so this only bounds the cost of a long-running one: three ~256KB
	 * measurements per round, a few megabytes a day, and never on the
	 * request path.
	 */
	edgeRefreshMs: 2 * 60 * 60_000,
	connectTimeoutMs: 15_000,
	connectRetries: 2,
	keepAliveMs: 5 * 60_000,
	/** A candidate slower than this is not worth pinning. */
	probeBudgetMs: 8_000,
	/** Consecutive failures before an address is set aside. */
	failureLimit: 2,
	/** How long a failed address stays out of rotation. */
	quarantineMs: 5 * 60_000,
	/** How many candidates are offered to Node's happy-eyeballs race. */
	raceWidth: 3,
	/** How many of the fastest candidates get a throughput measurement. */
	throughputCandidates: 3,
	/** Bytes a throughput measurement transfers. */
	throughputBytes: 262_144,
	/**
	 * Assumed rate for a candidate whose throughput could not be measured.
	 * Deliberately pessimistic: an unverified address has to look *clearly*
	 * better on first byte before it outranks a measured one, because the
	 * expensive failure mode is a shaped path, not a slow handshake.
	 */
	assumedThroughputBps: 150_000,
	/** A measured rate below this cannot be pinned at all. */
	minThroughputBps: 120_000,
	/**
	 * Cloudflare's own speed endpoint. Measured through the candidate address
	 * (same anycast edge as the API, different hostname) because a 17KB API
	 * response is too small to reveal a shaped or lossy path — the failure
	 * mode that matters: one measured edge delivered 122KB/s where another
	 * delivered 4MB/s, which is minutes of difference on a long answer.
	 */
	throughputUrl: "https://speed.cloudflare.com/__down?bytes=262144",
} as const;

/** The hostnames edge pinning is allowed to touch. */
function edgeHostsFor(settings: TransportSettings, extra?: string): Set<string> {
	const hosts = new Set<string>([new URL(DEFAULT_API_BASE).hostname]);
	for (const host of [...(settings.edgeHosts ?? []), extra]) {
		if (typeof host === "string" && host.trim() !== "") hosts.add(host.trim());
	}
	return hosts;
}

/** The `commandcode` settings block, as far as the transport cares. */
export interface TransportSettingsSource {
	edgePinning?: boolean;
	edgeIps?: string[];
	edgeHosts?: string[];
	edgeProbe?: boolean;
	edgeRefreshMs?: number;
	connectTimeoutMs?: number;
	connectRetries?: number;
	keepAliveMs?: number;
	edgeProbeThroughput?: boolean;
	throughputUrl?: string;
	/** Maps onto the header budget, so one setting keeps its old meaning. */
	requestTimeoutMs?: number;
}

/**
 * Map the plugin's settings block onto transport tuning, so both entry points
 * (the model provider and the web tools) read the same keys.
 */
export function transportSettingsFrom(source: TransportSettingsSource): TransportSettings {
	return {
		edgePinning: source.edgePinning,
		edgeIps: source.edgeIps,
		edgeHosts: source.edgeHosts,
		edgeProbe: source.edgeProbe,
		edgeRefreshMs: source.edgeRefreshMs,
		connectTimeoutMs: source.connectTimeoutMs,
		connectRetries: source.connectRetries,
		keepAliveMs: source.keepAliveMs,
		edgeProbeThroughput: source.edgeProbeThroughput,
		throughputUrl: source.throughputUrl,
		headersTimeoutMs: source.requestTimeoutMs,
	};
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type TransportErrorKind = "connect-timeout" | "headers-timeout" | "network" | "aborted";

/**
 * A transport-level failure, kept apart from HTTP status failures so the
 * caller can choose between "retry" and "report". `code` carries the syscall
 * or TLS error (`ECONNRESET`, `ERR_SSL_...`) when there was one.
 */
export class CommandCodeTransportError extends Error {
	readonly kind: TransportErrorKind;
	readonly code: string | undefined;
	readonly endpoint: string;

	constructor(kind: TransportErrorKind, message: string, options: { code?: string; endpoint: string; cause?: unknown }) {
		super(message);
		this.name = "CommandCodeTransportError";
		this.kind = kind;
		this.code = options.code;
		this.endpoint = options.endpoint;
		if (options.cause !== undefined) this.cause = options.cause;
	}
}

/**
 * Whether a connection-phase failure is worth another attempt.
 *
 * Only failures that happened before any response byte arrived qualify: the
 * server cannot have produced a result the caller has seen, so a replay cannot
 * duplicate one. A header timeout is deliberately excluded — the request may
 * well be generating a long answer, and replaying it would pay for two.
 */
export function isRetryableTransportError(error: unknown): boolean {
	if (!(error instanceof CommandCodeTransportError)) return false;
	if (error.kind === "aborted") return false;
	if (error.kind === "connect-timeout") return true;
	if (error.kind !== "network") return false;
	const code = error.code ?? "";
	if (
		[
			"ECONNRESET",
			"ECONNREFUSED",
			"EPIPE",
			"ETIMEDOUT",
			"EHOSTUNREACH",
			"ENETUNREACH",
			"EAI_AGAIN",
			"ENOTFOUND",
			"ERR_SOCKET_CONNECTION_TIMEOUT",
			"ERR_SSL_WRONG_VERSION_NUMBER",
			"ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE",
		].includes(code)
	) {
		return true;
	}
	return /socket hang up|other side closed|handshake|TLS|ECONNRESET|EPIPE|timed? ?out/i.test(error.message);
}

// ---------------------------------------------------------------------------
// Edge selection
// ---------------------------------------------------------------------------

interface EdgeHealth {
	failures: number;
	badUntil: number;
}

/** Everything the transport remembers between requests. */
interface TransportState {
	rankedIps: string[];
	health: Map<string, EdgeHealth>;
	lastProbeAt: number;
	probeInFlight: boolean;
	/** Signature of the last explicitly configured candidate list. */
	configuredIps: string | undefined;
	agents: Map<string, AgentEntry>;
}

/**
 * The state lives on `globalThis`, not in module scope.
 *
 * pi loads each extension entry through its own jiti instance with
 * `moduleCache: false`, so `index.ts` and `search.ts` each evaluate this module
 * separately. Module-scope state would mean two edge rankings, two background
 * probes, and — worse — two socket pools for the same origin, when sharing one
 * pool is the entire point (a `cc_search` and the next model request should
 * ride the same warm socket).
 */
const STATE_KEY = Symbol.for("pi-commandcode-provider.net.state");

function state(): TransportState {
	const holder = globalThis as unknown as Record<symbol, TransportState | undefined>;
	let current = holder[STATE_KEY];
	if (current === undefined) {
		current = {
			rankedIps: [...DEFAULT_EDGE_IPS],
			health: new Map(),
			lastProbeAt: 0,
			probeInFlight: false,
			configuredIps: undefined,
			agents: new Map(),
		};
		holder[STATE_KEY] = current;
	}
	return current;
}

/** The current order, best first, with quarantined addresses filtered out. */
export function activeEdges(now = Date.now()): string[] {
	const current = state();
	const alive = current.rankedIps.filter((ip) => {
		const edge = current.health.get(ip);
		return edge === undefined || edge.badUntil <= now;
	});
	// Never leave the rotation empty: with everything quarantined, fall back to
	// the ranked order rather than to system DNS, which has no better idea.
	if (alive.length > 0) return alive;
	return current.rankedIps.length > 0 ? [...current.rankedIps] : [];
}

/** The address to connect to right now, or `undefined` for system DNS. */
export function nextEdge(now = Date.now()): string | undefined {
	return activeEdges(now)[0];
}

/** Ordered candidates for one attempt: the pin, then the alternates. */
export function edgeCandidates(limit = DEFAULTS.raceWidth, now = Date.now()): string[] {
	return activeEdges(now).slice(0, Math.max(1, limit));
}

/** Record a connection-level failure, setting the address aside once it repeats. */
export function quarantineEdge(ip: string, now = Date.now()): void {
	const current = state();
	const edge = current.health.get(ip) ?? { failures: 0, badUntil: 0 };
	edge.failures += 1;
	if (edge.failures >= DEFAULTS.failureLimit) {
		edge.badUntil = now + DEFAULTS.quarantineMs;
		edge.failures = 0;
		// Move it to the back so the fallback order stays meaningful.
		current.rankedIps = [...current.rankedIps.filter((candidate) => candidate !== ip), ip];
	}
	current.health.set(ip, edge);
}

/** Forget a failure once an address has proved itself again. */
export function clearEdgeFailure(ip: string): void {
	state().health.delete(ip);
}

/** Replace the ranking wholesale (used by the probe and by tests). */
export function setEdgeRanking(ips: string[]): void {
	const unique = [...new Set(ips.filter((ip) => typeof ip === "string" && ip.trim() !== ""))];
	if (unique.length > 0) state().rankedIps = unique;
}

/**
 * Honour an explicitly configured candidate list.
 *
 * Without this, `edgeIps` would only narrow what the *probe* measures, so a
 * user who set it — or who turned the probe off — would keep dialling the
 * built-in order. Applied once per distinct list, not per request.
 */
function applyConfiguredIps(ips: string[] | undefined): void {
	const current = state();
	const configured = ips?.filter((ip) => typeof ip === "string" && ip.trim() !== "");
	if (configured === undefined || configured.length === 0) {
		current.configuredIps = undefined;
		return;
	}
	const signature = configured.join(",");
	if (current.configuredIps === signature) return;
	current.configuredIps = signature;
	setEdgeRanking(configured);
}

/** Test/reset hook: drop ranking and probe bookkeeping. */
export function resetEdgeState(): void {
	const current = state();
	current.rankedIps = [...DEFAULT_EDGE_IPS];
	current.health = new Map();
	current.lastProbeAt = 0;
	current.probeInFlight = false;
	current.configuredIps = undefined;
}

/** What the pinning is doing right now, for the diagnostics panel. */
export function edgeStatus(now = Date.now()): {
	ranking: string[];
	quarantined: string[];
	lastProbeAt: number;
	probing: boolean;
} {
	const current = state();
	return {
		ranking: [...current.rankedIps],
		quarantined: current.rankedIps.filter((ip) => {
			const edge = current.health.get(ip);
			return edge !== undefined && edge.badUntil > now;
		}),
		lastProbeAt: current.lastProbeAt,
		probing: current.probeInFlight,
	};
}

/** Pooled socket counts per transport pool, for the diagnostics panel. */
export function transportDiagnostics(): { pool: string; active: number; free: number }[] {
	const count = (groups: Record<string, unknown[]> | undefined) =>
		Object.values(groups ?? {}).reduce((total, list) => total + (Array.isArray(list) ? list.length : 0), 0);
	return [...state().agents.entries()].map(([pool, entry]) => ({
		pool,
		active: count((entry.agent as unknown as { sockets?: Record<string, unknown[]> }).sockets),
		free: count((entry.agent as unknown as { freeSockets?: Record<string, unknown[]> }).freeSockets),
	}));
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

/**
 * Time one TLS handshake plus the first byte of a response — exactly what a
 * request would pay. The body is never read, so a probe costs a couple of
 * kilobytes and no API quota.
 */
export function probeEdge(
	ip: string,
	host: string,
	timeoutMs = DEFAULTS.probeBudgetMs,
): Promise<{ ip: string; tlsMs: number; ttfbMs: number }> {
	return new Promise((resolve, reject) => {
		const started = process.hrtime.bigint();
		const elapsed = () => Number(process.hrtime.bigint() - started) / 1e6;
		let settled = false;
		let tlsMs = 0;
		let socket: TLSSocket | undefined;

		const finish = (error?: Error, ttfbMs?: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				socket?.destroy();
			} catch {
				// The socket is being torn down either way.
			}
			if (error !== undefined) reject(error);
			else resolve({ ip, tlsMs, ttfbMs: ttfbMs ?? 0 });
		};

		const timer = setTimeout(() => finish(new Error(`probe timed out after ${timeoutMs}ms`)), timeoutMs);
		timer.unref?.();

		try {
			socket = tlsConnect({
				host: ip,
				port: 443,
				servername: host,
				ALPNProtocols: ["http/1.1"],
				rejectUnauthorized: false,
				timeout: timeoutMs,
			});
		} catch (error) {
			finish(error as Error);
			return;
		}
		socket.once("secureConnect", () => {
			tlsMs = elapsed();
			socket?.write(`HEAD / HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: pi-commandcode-provider\r\nConnection: close\r\n\r\n`);
		});
		socket.once("data", () => finish(undefined, elapsed()));
		socket.once("error", (error) => finish(error as Error));
		socket.once("timeout", () => finish(new Error("probe socket timeout")));
		socket.once("close", () => finish(new Error("probe closed before a response")));
	});
}

/**
 * Rank candidates by median time to first byte, measured with a little
 * concurrency. More than one sample matters: a single reading cannot tell a
 * good address from a lucky one.
 */
export async function rankEdges(
	ips: string[],
	host: string,
	options: {
		samples?: number;
		concurrency?: number;
		budgetMs?: number;
		throughput?: boolean;
		throughputUrl?: string;
		throughputCandidates?: number;
	} = {},
): Promise<string[]> {
	const samples = Math.max(1, options.samples ?? 2);
	const concurrency = Math.max(1, options.concurrency ?? 6);
	const budgetMs = options.budgetMs ?? DEFAULTS.probeBudgetMs;
	const measured = new Map<string, number[]>();

	let cursor = 0;
	const worker = async () => {
		for (;;) {
			const ip = ips[cursor++];
			if (ip === undefined) return;
			const times: number[] = [];
			for (let sample = 0; sample < samples; sample += 1) {
				try {
					const result = await probeEdge(ip, host, budgetMs);
					times.push(result.ttfbMs);
				} catch {
					// An address that refuses to answer is simply not a candidate.
				}
			}
			if (times.length > 0) measured.set(ip, times);
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, ips.length)) }, worker));

	const median = (values: number[]) => {
		const sorted = [...values].sort((a, b) => a - b);
		const middle = sorted.length >> 1;
		return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
	};

	// Reachability first, cheapest measurement first: a dead or slow-to-answer
	// address is dropped before anything is downloaded through it.
	const reachable = [...measured.entries()]
		.map(([ip, times]) => ({ ip, ttfbMs: median(times) }))
		.filter((entry) => entry.ttfbMs <= budgetMs)
		.sort((a, b) => a.ttfbMs - b.ttfbMs);

	// Then the ones that could actually win get a sustained-throughput
	// measurement, because first-byte time says nothing about whether the path
	// delivers bytes — measured spread between two edges was 122KB/s against
	// 4MB/s, i.e. minutes on a long answer.
	const finalists = reachable.slice(0, Math.max(1, options.throughputCandidates ?? DEFAULTS.throughputCandidates));
	const scored: EdgeMeasurement[] = reachable.map((entry) => ({ ...entry }));
	if (options.throughput !== false) {
		const url = options.throughputUrl ?? DEFAULTS.throughputUrl;
		await Promise.all(
			scored.slice(0, finalists.length).map(async (entry) => {
				try {
					entry.bps = await probeThroughput(entry.ip, url);
				} catch {
					// Left unmeasured; the scoring treats that explicitly.
				}
			}),
		);
	}

	const ranked = rankEdgeMeasurements(scored, DEFAULTS.throughputBytes, DEFAULTS.assumedThroughputBps)
		.filter((entry) => entry.bps === undefined || entry.bps >= DEFAULTS.minThroughputBps)
		.map((entry) => entry.ip);

	// Keep the rest in their configured order: an address that lost one round
	// may be the only reachable one later.
	return [...ranked, ...ips.filter((ip) => !ranked.includes(ip))];
}

/** One candidate's measurements. `bps` is absent when it was not measured. */
export interface EdgeMeasurement {
	ip: string;
	ttfbMs: number;
	bps?: number;
}

/**
 * Pure scoring: the predicted time to move {@link payloadBytes} through a
 * candidate, first byte included. Unmeasured candidates are charged the
 * {@link assumedBps} rate, so an unknown never outranks a measured-good edge.
 */
export function rankEdgeMeasurements(
	measurements: EdgeMeasurement[],
	payloadBytes: number,
	assumedBps: number,
): EdgeMeasurement[] {
	const transferMs = (bps: number) => (bps <= 0 ? Number.POSITIVE_INFINITY : (payloadBytes / bps) * 1000);
	return [...measurements]
		.map((entry) => ({ entry, score: entry.ttfbMs + transferMs(entry.bps ?? assumedBps) }))
		.sort((a, b) => a.score - b.score)
		.map((scored) => scored.entry);
}

/**
 * Measure sustained download rate through one candidate address.
 *
 * The request goes to {@link DEFAULTS.throughputUrl}'s hostname over the
 * candidate's IP, so it measures the path to that edge rather than a property
 * of the API. Rejects when nothing measurable arrived, which the caller reads
 * as "unknown" rather than "zero".
 */
export function probeThroughput(
	ip: string,
	url = DEFAULTS.throughputUrl,
	timeoutMs = 10_000,
): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const target = new URL(url);
		const agent = new HttpsAgent({ keepAlive: false, noDelay: true, lookup: edgeLookup([ip]) });
		let firstByteAt = 0;
		let bytes = 0;
		let settled = false;

		const finish = (error?: Error, bps?: number) => {
			if (settled) return;
			settled = true;
			try {
				request?.destroy();
			} catch {
				// Torn down either way.
			}
			agent.destroy();
			if (error !== undefined) reject(error);
			else resolve(bps ?? 0);
		};

		let request: ReturnType<typeof httpsRequest> | undefined;
		try {
			request = httpsRequest(
				{
					host: target.hostname,
					servername: target.hostname,
					port: target.port === "" ? 443 : Number(target.port),
					path: `${target.pathname}${target.search}`,
					method: "GET",
					agent,
					headers: { host: target.hostname, "user-agent": "pi-commandcode-provider" },
				},
				(response) => {
					if ((response.statusCode ?? 0) !== 200) {
						response.resume();
						finish(new Error(`throughput probe got HTTP ${response.statusCode ?? 0}`));
						return;
					}
					response.on("data", (chunk: Buffer) => {
						if (firstByteAt === 0) firstByteAt = Date.now();
						bytes += chunk.length;
						// Enough to judge the rate; no reason to pull the rest.
						if (bytes >= DEFAULTS.throughputBytes * 1.5) response.destroy();
					});
					response.on("end", () => {
						const elapsed = Date.now() - firstByteAt;
						finish(undefined, elapsed <= 0 ? bytes * 1000 : (bytes / elapsed) * 1000);
					});
					response.on("close", () => {
						const elapsed = Date.now() - firstByteAt;
						if (bytes === 0 || firstByteAt === 0) {
							finish(new Error("throughput probe transferred nothing"));
							return;
						}
						finish(undefined, elapsed <= 0 ? bytes * 1000 : (bytes / elapsed) * 1000);
					});
					response.on("error", (error) => finish(error as Error));
				},
			);
		} catch (error) {
			finish(error as Error);
			return;
		}

		request.setTimeout(timeoutMs, () => {
			const elapsed = Date.now() - firstByteAt;
			if (bytes > 0 && firstByteAt > 0 && elapsed > 0) finish(undefined, (bytes / elapsed) * 1000);
			else finish(new Error(`throughput probe timed out after ${timeoutMs}ms`));
		});
		request.on("error", (error) => finish(error as Error));
		request.end();
	});
}

/**
 * Start a background re-ranking when the current one has gone stale. Never
 * blocks: the caller is served from the ranking that already exists.
 */
export function maybeRefreshEdges(settings: TransportSettings, host: string): void {
	const current = state();
	const refreshMs = settings.edgeRefreshMs ?? DEFAULTS.edgeRefreshMs;
	if (!(settings.edgeProbe ?? DEFAULTS.edgeProbe)) return;
	if (current.probeInFlight) return;
	if (current.lastProbeAt !== 0 && Date.now() - current.lastProbeAt < refreshMs) return;

	const configured = settings.edgeIps?.filter((ip) => typeof ip === "string" && ip.trim() !== "");
	const candidates = configured !== undefined && configured.length > 0 ? configured : current.rankedIps;
	const firstProbe = current.lastProbeAt === 0;
	current.probeInFlight = true;
	current.lastProbeAt = Date.now();
	void rankEdges(candidates, host, {
		samples: firstProbe ? 2 : 1,
		throughput: settings.edgeProbeThroughput ?? true,
		throughputUrl: settings.throughputUrl,
	})
		.then((ranking) => {
			setEdgeRanking(ranking);
		})
		.catch(() => undefined)
		.finally(() => {
			state().probeInFlight = false;
		});
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

type LookupCallback = (error: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void;

/**
 * A resolver answering with the pinned addresses, in the shape the caller
 * asked for. Node 20+ enables `autoSelectFamily`, which asks with
 * `{ all: true }` and expects an array — answering with a bare string there
 * fails with `ERR_INVALID_IP_ADDRESS`. Offering the alternates too lets
 * Node's own happy-eyeballs race them, so a dead edge costs milliseconds
 * instead of a timeout.
 */
export function edgeLookup(ips: string[]): typeof systemLookup {
	return ((hostname: string, options: LookupOptions, callback: LookupCallback) => {
		if (ips.length === 0) {
			systemLookup(hostname, options, callback as never);
			return;
		}
		if (options?.all === true) {
			callback(
				null,
				ips.map((address) => ({ address, family: 4 })),
			);
			return;
		}
		callback(null, ips[0], 4);
	}) as typeof systemLookup;
}

interface AgentEntry {
	agent: HttpAgent;
	active: number;
}

/**
 * One shared, keep-alive agent per (scheme, pinning) pair. Pinned and
 * unpinned traffic get separate pools on purpose: only the pinned pool may
 * override DNS, so a self-hosted `apiBase` can never be sent to an edge.
 */
function agents(): Map<string, AgentEntry> {
	return state().agents;
}

/** The pinned pool: every new socket is dialled at the current best edge. */
function pinnedAgent(protocol: string, keepAliveMs: number): AgentEntry {
	const key = `${protocol}|pinned`;
	const existing = agents().get(key);
	if (existing !== undefined) return existing;

	const pinnedLookup = ((hostname: string, options: LookupOptions, callback: LookupCallback) => {
		// Resolved per connection, never cached in the agent, so a re-ranking
		// or a quarantine takes effect on the very next socket.
		const candidates = edgeCandidates();
		if (candidates.length === 0) {
			systemLookup(hostname, options, callback as never);
			return;
		}
		if (options?.all === true) {
			callback(
				null,
				candidates.map((address) => ({ address, family: 4 })),
			);
			return;
		}
		callback(null, candidates[0], 4);
	}) as typeof systemLookup;

	const common = {
		keepAlive: true,
		keepAliveMsecs: keepAliveMs,
		maxSockets: 8,
		maxFreeSockets: 4,
		scheduling: "lifo" as const,
		noDelay: true,
		autoSelectFamilyAttemptTimeout: 250,
		lookup: pinnedLookup,
	};
	const entry: AgentEntry = { agent: protocol === "https:" ? new HttpsAgent(common) : new HttpAgent(common), active: 0 };
	agents().set(key, entry);
	// A dead keep-alive socket must never crash the process; the request that
	// was handed it is the one that reports the failure.
	entry.agent.on("error", () => undefined);
	return entry;
}

/** The plain pool: system DNS, still keep-alive. */
function directAgent(protocol: string, keepAliveMs: number): AgentEntry {
	const key = `${protocol}|direct`;
	const existing = agents().get(key);
	if (existing !== undefined) return existing;
	const entry: AgentEntry = {
		agent:
			protocol === "https:"
				? new HttpsAgent({ keepAlive: true, keepAliveMsecs: keepAliveMs, noDelay: true, maxFreeSockets: 4 })
				: new HttpAgent({ keepAlive: true, keepAliveMsecs: keepAliveMs, noDelay: true, maxFreeSockets: 4 }),
		active: 0,
	};
	agents().set(key, entry);
	entry.agent.on("error", () => undefined);
	return entry;
}

/** Drop a shared agent once nothing is streaming through it. */
function retireSharedAgents(protocol: string): void {
	for (const [key, entry] of [...agents()]) {
		if (!key.startsWith(`${protocol}|`) || entry.active > 0) continue;
		entry.agent.destroy();
		agents().delete(key);
	}
}

function headerPairs(headers: IncomingMessage["headers"]): [string, string][] {
	const pairs: [string, string][] = [];
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) for (const item of value) pairs.push([name, item]);
		else pairs.push([name, value]);
	}
	return pairs;
}

function normalizedHeaders(init: RequestInit): Record<string, string> {
	const source = init.headers;
	const headers: Record<string, string> = {};
	if (source === undefined) return headers;
	if (typeof Headers !== "undefined" && source instanceof Headers) {
		for (const [name, value] of source.entries()) headers[name] = value;
		return headers;
	}
	if (Array.isArray(source)) {
		for (const [name, value] of source) headers[String(name)] = String(value);
		return headers;
	}
	for (const [name, value] of Object.entries(source as Record<string, string>)) {
		if (value !== undefined) headers[name] = String(value);
	}
	return headers;
}

function requestBodyOf(init: RequestInit): string | Buffer | Uint8Array | undefined {
	const body = init.body;
	if (body === undefined || body === null) return undefined;
	if (typeof body === "string" || Buffer.isBuffer(body) || body instanceof Uint8Array) return body;
	throw new CommandCodeTransportError(
		"network",
		"只支持字符串或字节请求体；only string or byte request bodies are supported",
		{ endpoint: "" },
	);
}

interface AttemptResult {
	response: Response;
	/** True when the request rode an already-open socket (no new handshake). */
	reused: boolean;
	/** Request start → socket established: the handshake this request paid. */
	connectMs: number;
}

/**
 * Optional per-request transport log: `COMMANDCODE_TRANSPORT_LOG=<file>`
 * appends one JSON line per attempt (`edge`, `reused`, `ms`, or the failure
 * kind). Without it nothing is written and no file is touched.
 *
 * It exists because "is the pin/keep-alive actually working in the app?" is
 * otherwise unanswerable from the outside: the socket state is process-local.
 */
function logAttempt(entry: Record<string, unknown>): void {
	const file = process.env.COMMANDCODE_TRANSPORT_LOG?.trim();
	if (!file) return;
	try {
		appendFileSync(file, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
	} catch {
		// Diagnostics must never break a request.
	}
}

/**
 * How one attempt gets its socket: the shared pool on the happy path, or a
 * throwaway pool with an explicit pin after a failure, so a dead address
 * cannot be handed straight back out of the socket pool.
 */
type Dial =
	| { kind: "shared"; protocol: string; pin: boolean; keepAliveMs: number }
	| { kind: "fresh"; ips: string[] };

/**
 * One attempt, resolving as soon as the response headers arrive.
 */
function attempt(
	endpoint: string,
	dial: Dial,
	init: RequestInit,
	options: { connectTimeoutMs: number; headersTimeoutMs?: number },
): Promise<AttemptResult> {
	const url = new URL(endpoint);
	const caller = init.signal ?? undefined;

	return new Promise<AttemptResult>((resolve, reject) => {
		let settled = false;
		let entry: AgentEntry | undefined;
		let dedicated: HttpAgent | undefined;
		let connectTimer: NodeJS.Timeout | undefined;
		let headersTimer: NodeJS.Timeout | undefined;
		let reused = false;
		let connectMs = 0;
		const startedAt = Date.now();

		const finish = (error?: Error, result?: AttemptResult) => {
			if (settled) return;
			settled = true;
			if (connectTimer !== undefined) clearTimeout(connectTimer);
			if (headersTimer !== undefined) clearTimeout(headersTimer);
			caller?.removeEventListener("abort", onCallerAbort);
			if (error === undefined && result !== undefined) {
				resolve(result);
				return;
			}
			release();
			reject(error ?? new Error("unknown transport failure"));
		};

		const release = () => {
			if (entry !== undefined) {
				entry.active = Math.max(0, entry.active - 1);
				entry = undefined;
			}
			if (dedicated !== undefined) {
				dedicated.destroy();
				dedicated = undefined;
			}
		};

		const onCallerAbort = () =>
			finish(
				new CommandCodeTransportError("aborted", "Command Code 请求已取消；request aborted", {
					endpoint,
					cause: caller?.reason,
				}),
			);

		connectTimer = setTimeout(() => {
			finish(
				new CommandCodeTransportError(
					"connect-timeout",
					`连接 Command Code 超时（${options.connectTimeoutMs}ms）；the connection was not established in time`,
					{ endpoint },
				),
			);
		}, options.connectTimeoutMs);
		connectTimer.unref?.();

		if (options.headersTimeoutMs !== undefined) {
			const budget = options.headersTimeoutMs;
			headersTimer = setTimeout(() => {
				finish(
					new CommandCodeTransportError(
						"headers-timeout",
						`Command Code API 请求 ${endpoint} 在 ${budget}ms 内未收到响应（超时）` +
							`；request to ${endpoint} timed out`,
						{ endpoint },
					),
				);
			}, budget);
			headersTimer.unref?.();
		}

		let request;
		let body: string | Buffer | Uint8Array | undefined;
		try {
			body = requestBodyOf(init);
			if (dial.kind === "shared") {
				entry = dial.pin ? pinnedAgent(dial.protocol, dial.keepAliveMs) : directAgent(dial.protocol, dial.keepAliveMs);
				entry.active += 1;
			} else {
				dedicated =
					url.protocol === "https:"
						? new HttpsAgent({ keepAlive: false, noDelay: true, lookup: edgeLookup(dial.ips) })
						: new HttpAgent({ keepAlive: false, noDelay: true, lookup: edgeLookup(dial.ips) });
			}

			const send = url.protocol === "https:" ? httpsRequest : httpRequest;
			const agent = dedicated ?? entry?.agent;
			request = send(
				{
					protocol: url.protocol,
					hostname: url.hostname,
					port: url.port === "" ? undefined : Number(url.port),
					path: `${url.pathname}${url.search}`,
					method: init.method ?? "GET",
					headers: normalizedHeaders(init),
					agent,
				},
				(response) => {
					const status = response.statusCode ?? 0;
					// 204/304 and 1xx carry no body; the Response constructor
					// rejects a body for them, so the stream is dropped there.
					const hasBody = status >= 200 && status !== 204 && status !== 304;
					const wrapped = new Response(hasBody ? (Readable.toWeb(response) as ReadableStream<Uint8Array>) : null, {
						status: status >= 200 && status <= 599 ? status : 200,
						statusText: response.statusMessage ?? "",
						headers: headerPairs(response.headers),
					});
					// The throwaway agent lives exactly as long as its socket.
					response.once("close", release);
					finish(undefined, { response: wrapped, reused, connectMs });
				},
			);
		} catch (error) {
			finish(
				new CommandCodeTransportError(
					"network",
					`${error instanceof Error ? error.message : String(error)}；the request could not be created`,
					{ endpoint, cause: error },
				),
			);
			return;
		}

		if (caller !== undefined) {
			if (caller.aborted) onCallerAbort();
			else caller.addEventListener("abort", onCallerAbort, { once: true });
		}

		request.once("socket", (socket) => {
			const established = () => {
				connectMs = Date.now() - startedAt;
				clearTimeout(connectTimer);
			};
			const event = url.protocol === "https:" ? "secureConnect" : "connect";
			if (socket.connecting === false) {
				// A reused keep-alive socket is already past the handshake, so
				// this request pays none of it — the whole point of the pool.
				reused = true;
				established();
				return;
			}
			socket.once(event, established);
		});
		request.once("error", (error: NodeJS.ErrnoException) => {
			if (caller?.aborted === true) {
				onCallerAbort();
				return;
			}
			const code = typeof error.code === "string" ? error.code : undefined;
			finish(
				new CommandCodeTransportError(
					"network",
					`Command Code API 请求 ${endpoint} 连接失败：${error.message}；request to ${endpoint} failed`,
					{ code, endpoint, cause: error },
				),
			);
		});
		if (body !== undefined) request.end(body);
		else request.end();
	});
}

/** Whether a proxy is configured for this scheme; then pi's dispatcher is used. */
function proxyFor(url: URL): string | undefined {
	const env = process.env;
	const candidates =
		url.protocol === "https:"
			? [env.HTTPS_PROXY, env.https_proxy, env.HTTP_PROXY, env.http_proxy, env.ALL_PROXY, env.all_proxy]
			: [env.HTTP_PROXY, env.http_proxy, env.ALL_PROXY, env.all_proxy];
	return candidates.find((value) => typeof value === "string" && value.trim() !== "");
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A `fetch`-shaped request against the Command Code API with edge pinning,
 * keep-alive and bounded connection-phase retries. It returns a real
 * `Response`, so callers read status, headers and the body exactly as before.
 *
 * `host` adds one more hostname to the pinned set (used by the search tools,
 * which talk to the same origin).
 */
export function createCommandCodeFetch(settings: () => TransportSettings, host?: string): typeof fetch {
	return (async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
		const endpoint = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const url = new URL(endpoint);
		const configured = settings();
		const headersTimeoutMs = configured.headersTimeoutMs;

		// A proxy the user configured keeps working exactly as before: pi's own
		// dispatcher already knows how to tunnel through it. The header budget
		// is still enforced, so both paths time out the same way.
		const proxy = proxyFor(url);
		if (proxy !== undefined) {
			return proxiedFetch(endpoint, init, headersTimeoutMs);
		}

		const pinned =
			(configured.edgePinning ?? DEFAULTS.edgePinning) &&
			url.protocol === "https:" &&
			edgeHostsFor(configured, host).has(url.hostname);

		// Retries cover connection-phase failures only, and they apply to any
		// host: a self-hosted relay suffers the same transients.
		const retries = Math.max(0, configured.connectRetries ?? DEFAULTS.connectRetries);
		const connectTimeoutMs = configured.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs;
		const keepAliveMs = configured.keepAliveMs ?? DEFAULTS.keepAliveMs;

		if (pinned) {
			applyConfiguredIps(configured.edgeIps);
			maybeRefreshEdges(configured, url.hostname);
		}

		let lastError: unknown;
		for (let attemptIndex = 0; attemptIndex <= retries; attemptIndex += 1) {
			const ip = pinned ? nextEdge() : undefined;
			const startedAt = Date.now();
			try {
				const dial: Dial =
					attemptIndex === 0 || !pinned
						? { kind: "shared", protocol: url.protocol, pin: pinned, keepAliveMs }
						: { kind: "fresh", ips: edgeCandidates() };
				const result = await attempt(endpoint, dial, init, { connectTimeoutMs, headersTimeoutMs });
				if (ip !== undefined) clearEdgeFailure(ip);
				logAttempt({
					endpoint,
					edge: ip ?? "system-dns",
					attempt: attemptIndex + 1,
					outcome: "ok",
					reused: result.reused,
					connectMs: result.connectMs,
					ms: Date.now() - startedAt,
				});
				return result.response;
			} catch (error) {
				lastError = error;
				const kind = error instanceof CommandCodeTransportError ? error.kind : "unknown";
				const code = error instanceof CommandCodeTransportError ? error.code : undefined;
				const retryable = isRetryableTransportError(error);
				logAttempt({
					endpoint,
					edge: ip ?? "system-dns",
					attempt: attemptIndex + 1,
					outcome: "error",
					kind,
					code,
					retryable,
					ms: Date.now() - startedAt,
				});
				if (init.signal?.aborted === true) throw error;
				if (ip !== undefined) quarantineEdge(ip);
				if (attemptIndex >= retries || !retryable) throw error;
				// The failed pin's pooled sockets are suspect now; dropping them
				// keeps the next attempt from picking a corpse back up.
				retireSharedAgents(url.protocol);
				await wait(120 * (attemptIndex + 1));
			}
		}
		throw lastError instanceof Error
			? lastError
			: new CommandCodeTransportError("network", `Command Code API 请求 ${endpoint} 失败`, { endpoint });
	}) as typeof fetch;
}

/**
 * The proxy path: hand the request to pi's dispatcher, but keep the same
 * header budget and the same error vocabulary, so a user behind a proxy reads
 * the same message as a user without one.
 */
async function proxiedFetch(endpoint: string, init: RequestInit, headersTimeoutMs?: number): Promise<Response> {
	const caller = init.signal ?? undefined;
	if (headersTimeoutMs === undefined) return globalThis.fetch(endpoint, init);

	const controller = new AbortController();
	let timedOut = false;
	const forward = () => controller.abort(caller?.reason);
	if (caller !== undefined) {
		if (caller.aborted) forward();
		else caller.addEventListener("abort", forward, { once: true });
	}
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort(new Error("headers timeout"));
	}, headersTimeoutMs);
	timer.unref?.();

	try {
		return await globalThis.fetch(endpoint, { ...init, signal: controller.signal });
	} catch (error) {
		if (caller?.aborted === true) {
			throw new CommandCodeTransportError("aborted", "Command Code 请求已取消；request aborted", {
				endpoint,
				cause: caller.reason,
			});
		}
		if (timedOut) {
			throw new CommandCodeTransportError(
				"headers-timeout",
				`Command Code API 请求 ${endpoint} 在 ${headersTimeoutMs}ms 内未收到响应（超时）` +
					`；request to ${endpoint} timed out`,
				{ endpoint, cause: error },
			);
		}
		throw new CommandCodeTransportError(
			"network",
			`Command Code API 请求 ${endpoint} 连接失败：${error instanceof Error ? error.message : String(error)}` +
				`；request to ${endpoint} failed`,
			{ endpoint, cause: error },
		);
	} finally {
		clearTimeout(timer);
		caller?.removeEventListener("abort", forward);
	}
}
