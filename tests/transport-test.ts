/**
 * Transport tests for `net.ts` — the edge-pinned, keep-alive, retrying path
 * that the model requests and the web tools go through.
 *
 * The three behaviours that matter are exactly the ones a local mock can
 * prove: a second request reuses the first one's socket instead of paying a
 * new handshake, a connection that dies before any response byte is replayed
 * rather than reported as a timeout, and a request that never answers still
 * settles instead of hanging. No network access and no API key are required.
 *
 *   node --experimental-strip-types transport-test.ts
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import {
	CommandCodeTransportError,
	DEFAULT_EDGE_IPS,
	clearEdgeFailure,
	createCommandCodeFetch,
	edgeCandidates,
	edgeLookup,
	isRetryableTransportError,
	nextEdge,
	quarantineEdge,
	rankEdgeMeasurements,
	resetEdgeState,
	setEdgeRanking,
	type TransportSettings,
} from "../net.ts";

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
					console.error(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
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

/** No proxy during the direct-transport tests, whatever the shell exports. */
const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] as const;
const savedProxy = new Map<string, string | undefined>();
for (const key of PROXY_KEYS) {
	savedProxy.set(key, process.env[key]);
	delete process.env[key];
}
process.on("exit", () => {
	for (const [key, value] of savedProxy) if (value !== undefined) process.env[key] = value;
});

/** Settings with the plugin's defaults except for what a test overrides. */
function settings(overrides: Partial<TransportSettings> = {}): () => TransportSettings {
	return () => ({
		edgePinning: false,
		edgeProbe: false,
		connectTimeoutMs: 3_000,
		connectRetries: 2,
		keepAliveMs: 60_000,
		...overrides,
	});
}

// ---------------------------------------------------------------------------
// A mock gateway that can be told to behave badly.
// ---------------------------------------------------------------------------

interface MockState {
	handler: (request: number) => "respond" | "reset" | "silent";
	status: number;
	headers: Record<string, string>;
	body: string;
}

const mock: MockState = {
	handler: () => "respond",
	status: 200,
	headers: { "content-type": "text/event-stream" },
	body: "data: hello\n\n",
};

let requests = 0;
let connections = 0;
const sockets = new Set<Socket>();

const server: Server = createServer((req, res) => {
	requests += 1;
	const behaviour = mock.handler(requests);
	if (behaviour === "reset") {
		req.socket.destroy();
		return;
	}
	if (behaviour === "silent") return;
	res.writeHead(mock.status, mock.headers);
	res.end(mock.body);
});
server.on("connection", (socket) => {
	connections += 1;
	sockets.add(socket);
	socket.on("close", () => sockets.delete(socket));
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const port = typeof address === "object" && address !== null ? address.port : 0;
const API = `http://127.0.0.1:${port}`;

const reset = () => {
	requests = 0;
	connections = 0;
	mock.handler = () => "respond";
	mock.status = 200;
	mock.headers = { "content-type": "text/event-stream" };
	mock.body = "data: hello\n\n";
};

// ---------------------------------------------------------------------------

console.log("\nnet.ts transport");

await test("reuses one socket across sequential requests (keep-alive)", async () => {
	reset();
	const fetchImpl = createCommandCodeFetch(settings());
	for (let i = 0; i < 3; i += 1) {
		const response = await fetchImpl(`${API}/provider/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ping: i }),
		});
		assert.equal(response.status, 200);
		assert.equal(await response.text(), "data: hello\n\n");
	}
	assert.equal(requests, 3, "every call must reach the mock");
	assert.equal(connections, 1, "a keep-alive agent must not dial again");
});

await test("replays a connection that dies before any response byte", async () => {
	reset();
	// The first attempt is killed mid-flight; only the replay can answer.
	mock.handler = (request) => (request === 1 ? "reset" : "respond");
	const fetchImpl = createCommandCodeFetch(settings());
	const response = await fetchImpl(`${API}/x`, { method: "POST", body: "{}" });
	assert.equal(response.status, 200);
	assert.equal(await response.text(), "data: hello\n\n");
	assert.equal(requests, 2, "the dead attempt must be retried exactly once");
});

await test("stops retrying once a response has been delivered", async () => {
	reset();
	const fetchImpl = createCommandCodeFetch(settings());
	const response = await fetchImpl(`${API}/x`, { method: "POST", body: "{}" });
	await response.text();
	assert.equal(requests, 1);
});

await test("does not retry a header timeout, which may be a slow model", async () => {
	reset();
	mock.handler = () => "silent";
	const fetchImpl = createCommandCodeFetch(settings({ headersTimeoutMs: 150, connectRetries: 3 }));
	await assert.rejects(
		() => fetchImpl(`${API}/x`, { method: "POST", body: "{}" }),
		(error: unknown) => {
			assert.ok(error instanceof CommandCodeTransportError);
			assert.equal(error.kind, "headers-timeout");
			assert.match(error.message, /未收到响应（超时）/);
			return true;
		},
	);
	assert.equal(requests, 1, "a slow answer must not be paid for twice");
});

await test("fails a connect timeout with the actionable message", async () => {
	// 10.255.255.1 is a black hole: the handshake neither completes nor errors.
	const fetchImpl = createCommandCodeFetch(settings({ connectTimeoutMs: 250, connectRetries: 0 }));
	await assert.rejects(
		() => fetchImpl("http://10.255.255.1:81/x", { method: "POST", body: "{}" }),
		(error: unknown) => {
			assert.ok(error instanceof CommandCodeTransportError);
			assert.equal(error.kind, "connect-timeout");
			assert.match(error.message, /连接 Command Code 超时/);
			return true;
		},
	);
});

await test("refuses a connection and retries on a different attempt", async () => {
	reset();
	// Nothing listens on this port: ECONNREFUSED is retryable, so the caller
	// sees the last failure only after the attempts are spent.
	const fetchImpl = createCommandCodeFetch(settings({ connectRetries: 1, connectTimeoutMs: 2_000 }));
	await assert.rejects(
		() => fetchImpl("http://127.0.0.1:1/x", { method: "POST", body: "{}" }),
		(error: unknown) => {
			assert.ok(error instanceof CommandCodeTransportError);
			assert.equal(error.kind, "network");
			return true;
		},
	);
});

await test("passes status, headers and body of a rejection through", async () => {
	reset();
	mock.status = 403;
	mock.headers = { "content-type": "application/json", "retry-after": "30" };
	mock.body = JSON.stringify({ error: { code: "upgrade_required" } });
	const fetchImpl = createCommandCodeFetch(settings());
	const response = await fetchImpl(`${API}/provider/v1/chat/completions`, { method: "POST", body: "{}" });
	assert.equal(response.ok, false);
	assert.equal(response.status, 403);
	assert.equal(response.headers.get("retry-after"), "30");
	assert.match(await response.text(), /upgrade_required/);
});

await test("propagates an abort without retrying it", async () => {
	reset();
	mock.handler = () => "silent";
	const controller = new AbortController();
	const fetchImpl = createCommandCodeFetch(settings({ connectRetries: 3 }));
	const pending = fetchImpl(`${API}/x`, { method: "POST", body: "{}", signal: controller.signal });
	setTimeout(() => controller.abort(new Error("user cancelled")), 60);
	await assert.rejects(pending, (error: unknown) => {
		assert.ok(error instanceof CommandCodeTransportError);
		assert.equal(error.kind, "aborted");
		return true;
	});
	assert.equal(requests, 1);
});

await test("hands a configured proxy back to pi's own dispatcher", async () => {
	const original = globalThis.fetch;
	const before = requests;
	let delegated = 0;
	globalThis.fetch = (async () => {
		delegated += 1;
		return new Response("proxied", { status: 200 });
	}) as typeof fetch;
	process.env.HTTP_PROXY = "http://127.0.0.1:7897";
	try {
		const fetchImpl = createCommandCodeFetch(settings());
		const response = await fetchImpl(`${API}/x`, { method: "POST", body: "{}" });
		assert.equal(await response.text(), "proxied");
		assert.equal(delegated, 1, "a configured proxy must be used");
		assert.equal(requests, before, "nothing may go direct while a proxy is set");
	} finally {
		globalThis.fetch = original;
		delete process.env.HTTP_PROXY;
	}
});

// ---------------------------------------------------------------------------
// Edge selection
// ---------------------------------------------------------------------------

console.log("\nedge selection");

await test("answers a multi-address lookup with an array", async () => {
	const lookup = edgeLookup(["104.18.32.1", "104.19.64.1"]);
	const all = await new Promise<unknown>((resolve) => {
		lookup("api.commandcode.ai", { all: true }, (_error, addresses) => resolve(addresses));
	});
	assert.deepEqual(all, [
		{ address: "104.18.32.1", family: 4 },
		{ address: "104.19.64.1", family: 4 },
	]);
	const single = await new Promise<unknown>((resolve) => {
		lookup("api.commandcode.ai", {}, (_error, address, family) => resolve([address, family]));
	});
	assert.deepEqual(single, ["104.18.32.1", 4]);
});

await test("quarantines an address after two failures and demotes it", () => {
	resetEdgeState();
	const first = nextEdge();
	assert.ok(first);
	quarantineEdge(first);
	assert.equal(nextEdge(), first, "one failure is not enough to set it aside");
	quarantineEdge(first);
	assert.notEqual(nextEdge(), first, "a repeated failure must leave the rotation");
	assert.equal(
		edgeCandidates(50).includes(first),
		false,
		"a quarantined address is not offered while healthy ones remain",
	);
	// A demoted address is not promoted back by forgetting the failure alone:
	// only the next probe re-ranks it, which keeps a flapping edge from
	// immediately winning again.
	clearEdgeFailure(first);
	assert.notEqual(nextEdge(), first);
	setEdgeRanking([first, ...edgeCandidates(50)]);
	assert.equal(nextEdge(), first, "a fresh ranking puts the fastest address back in front");
	resetEdgeState();
});

await test("keeps a configured candidate order but never invents one", () => {
	setEdgeRanking([]);
	// An empty ranking must not silently disable pinning.
	assert.equal(edgeCandidates().length > 0, true);
	setEdgeRanking(["1.1.1.1", "1.1.1.1", "2.2.2.2"]);
	assert.deepEqual(edgeCandidates(), ["1.1.1.1", "2.2.2.2"]);
	resetEdgeState();
});

await test("shares state across separately evaluated module instances", async () => {
	// pi gives every extension entry its own jiti instance, so `index.ts` and
	// `search.ts` each evaluate net.ts. The ranking and the socket pool must not
	// fork: a second instance has to see the first one's pin.
	resetEdgeState();
	const second = await import("../net.ts?second-entry");
	setEdgeRanking(["9.9.9.9"]);
	assert.equal(second.nextEdge(), "9.9.9.9");
	assert.equal(nextEdge(), "9.9.9.9");
	resetEdgeState();
	assert.equal(second.edgeStatus().ranking[0], DEFAULT_EDGE_IPS[0]);
});

await test("classifies retryable failures", () => {
	const error = (kind: "connect-timeout" | "headers-timeout" | "network" | "aborted", code?: string) =>
		new CommandCodeTransportError(kind, "msg", { endpoint: "e", code });
	assert.equal(isRetryableTransportError(error("connect-timeout")), true);
	assert.equal(isRetryableTransportError(error("network", "ECONNRESET")), true);
	assert.equal(isRetryableTransportError(error("network", "EPIPE")), true);
	assert.equal(isRetryableTransportError(error("network", "EACCES")), false);
	assert.equal(isRetryableTransportError(error("headers-timeout")), false);
	assert.equal(isRetryableTransportError(error("aborted")), false);
	assert.equal(isRetryableTransportError(new Error("plain")), false);
});

await test("scores throughput, not just first byte", () => {
	const payload = 262_144;
	const assumed = 150_000;
	const ranked = rankEdgeMeasurements(
		[
			// The trap this guards against: the best handshake on the line can
			// be the worst path for bytes (122KB/s measured against 4MB/s).
			{ ip: "fast-handshake-slow-path", ttfbMs: 200, bps: 122_000 },
			{ ip: "measured-good", ttfbMs: 460, bps: 3_500_000 },
			{ ip: "unmeasured", ttfbMs: 300 },
		],
		payload,
		assumed,
	);
	assert.deepEqual(
		ranked.map((entry) => entry.ip),
		["measured-good", "unmeasured", "fast-handshake-slow-path"],
	);
});

await test("lets a much faster handshake beat an unmeasured assumption", () => {
	const ranked = rankEdgeMeasurements(
		[
			{ ip: "unknown-but-quick", ttfbMs: 150 },
			{ ip: "measured-mediocre", ttfbMs: 600, bps: 200_000 },
		],
		262_144,
		150_000,
	);
	assert.deepEqual(
		ranked.map((entry) => entry.ip),
		["unknown-but-quick", "measured-mediocre"],
	);
});

// ---------------------------------------------------------------------------

server.close();
for (const socket of sockets) socket.destroy();
console.log(`\n${passed} passed${process.exitCode === 1 ? ", some failed" : ""}\n`);
