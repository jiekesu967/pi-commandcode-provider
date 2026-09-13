/**
 * End-to-end test for the browser login flow.
 *
 * Drives the REAL loopback server over real HTTP and plays the part of the
 * Studio page: it POSTs credentials to the callback exactly as the browser
 * does. No browser and no network are needed, and no real credential is
 * touched — the auth file is redirected into a temp directory.
 *
 *   node --experimental-strip-types login-test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LoginFlow,
	buildAuthUrl,
	loginFailureMessage,
	runBrowserLogin,
	storeKeyToAuthFile,
	storeKeyToPiAuth,
	studioBaseForApiBase,
	validateApiKey,
	type LoginStatus,
} from "../login.ts";

const tmp = mkdtempSync(join(tmpdir(), "cc-login-test-"));
const AUTH_PATH = join(tmp, "auth.json");
const PI_AUTH_PATH = join(tmp, "pi-auth.json");

/** A fetch double: only `/alpha/whoami` is answered. */
function fakeFetch(status: number): typeof fetch {
	return (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.includes("/alpha/whoami")) {
			return new Response(status === 200 ? "{}" : "nope", { status });
		}
		throw new Error(`unexpected fetch: ${url}`);
	}) as typeof fetch;
}

/** POST to a callback URL, as the Studio page does. */
async function postCallback(
	port: number,
	body: unknown,
	options?: { method?: string },
): Promise<{ status: number; json: Record<string, unknown> }> {
	const response = await fetch(`http://127.0.0.1:${port}/callback`, {
		method: options?.method ?? "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const text = await response.text();
	let json: Record<string, unknown> = {};
	try {
		json = JSON.parse(text) as Record<string, unknown>;
	} catch {
		// Non-JSON is fine; the status is what matters.
	}
	return { status: response.status, json };
}

/** The port and state an attempt bound, read from its authorization URL. */
function attemptTarget(status: LoginStatus): { port: number; state: string } {
	assert.equal(status.state, "waiting", "expected a waiting attempt");
	const url = new URL((status as { authUrl: string }).authUrl);
	const callback = url.searchParams.get("callback");
	const state = url.searchParams.get("state");
	assert.ok(callback, "the auth URL must carry a callback");
	assert.ok(state, "the auth URL must carry a state token");
	return { port: Number(new URL(callback).port), state };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** Build a LoginFlow wired to the temp auth file. */
function makeFlow(overrides: Partial<ConstructorParameters<typeof LoginFlow>[0]> = {}) {
	return new LoginFlow({
		apiBase: () => "https://api.commandcode.ai",
		fetchImpl: fakeFetch(200),
		randomToken: () => "test-state-token",
		storeKey: async () => {},
		openBrowser: () => {},
		timeoutMs: 5_000,
		...overrides,
	});
}

console.log("\nbrowser login\n");

await test("builds the Studio URL and maps the API base", () => {
	const url = buildAuthUrl({ studioBase: "https://commandcode.ai", port: 5959, state: "abc" });
	assert.ok(url.startsWith("https://commandcode.ai/studio/auth/cli?"));
	assert.ok(url.includes("callback=http%3A%2F%2Flocalhost%3A5959%2Fcallback"));
	assert.ok(url.includes("state=abc"));
	assert.equal(studioBaseForApiBase("https://api.commandcode.ai"), "https://commandcode.ai");
	assert.equal(studioBaseForApiBase("https://staging-api.commandcode.ai"), "https://staging.commandcode.ai");
	assert.equal(studioBaseForApiBase("http://localhost:8787"), "http://localhost:3000");
});

await test("opens the browser with the authorization URL", async () => {
	const opened: string[] = [];
	const flow = makeFlow({
		openBrowser: (url) => opened.push(url),
		randomToken: () => "s1",
		startPort: 5961,
	});
	const status = await flow.begin();
	const { port } = attemptTarget(status);
	assert.equal(port, 5961);
	assert.equal(opened.length, 1, "the browser should be launched once");
	assert.ok(opened[0].includes("state=s1"));
	flow.dispose();
});

await test("completes a login end-to-end and writes the key", async () => {
	rmSync(AUTH_PATH, { force: true });
	let announced = "";
	const flow = makeFlow({
		randomToken: () => "e2e-state",
		startPort: 5970,
		fetchImpl: fakeFetch(200),
		storeKey: async (credentials) => {
			await storeKeyToAuthFile(credentials, AUTH_PATH);
		},
	});
	const status = await flow.begin();
	announced = (status as { authUrl: string }).authUrl;
	const { port, state } = attemptTarget(status);

	// Play the Studio page.
	const accepted = await postCallback(port, {
		apiKey: "user_e2e_key",
		state,
		userId: "u1",
		userName: "tester",
		keyName: "pi key",
	});
	assert.equal(accepted.status, 200);
	assert.deepEqual(accepted.json, { success: true });

	// The whoami check and the write happen after the callback answers.
	await wait(300);
	assert.equal(flow.status().state, "success");
	const stored = JSON.parse(readFileSync(AUTH_PATH, "utf-8")) as { apiKey?: string };
	assert.equal(stored.apiKey, "user_e2e_key", "the delivered key is persisted");
	assert.ok(announced.includes("/studio/auth/cli"), "the Studio URL was announced");
	flow.dispose();
});

await test("rejects a callback whose state token does not match", async () => {
	const flow = makeFlow({ randomToken: () => "expected-state", startPort: 5980 });
	const status = await flow.begin();
	const { port } = attemptTarget(status);

	const forged = await postCallback(port, {
		apiKey: "user_attacker",
		state: "wrong-state",
		userId: "u",
		userName: "n",
		keyName: "k",
	});
	assert.equal(forged.status, 403, "a forged state must be refused");
	flow.dispose();
});

await test("rejects a callback missing required fields", async () => {
	const flow = makeFlow({ randomToken: () => "s", startPort: 5990 });
	const status = await flow.begin();
	const { port } = attemptTarget(status);
	const bad = await postCallback(port, { apiKey: "user_x", state: "s" });
	assert.equal(bad.status, 400, "incomplete credentials must be refused");
	flow.dispose();
});

await test("answers 405 to a GET on the callback", async () => {
	// Note: stay off ports a client refuses to connect to (6000 is on the
	// browser unsafe-port blocklist), or fetch fails before reaching us.
	const flow = makeFlow({ randomToken: () => "s", startPort: 6075 });
	const status = await flow.begin();
	const { port } = attemptTarget(status);
	const response = await fetch(`http://127.0.0.1:${port}/callback`, { method: "GET" });
	assert.equal(response.status, 405);
	flow.dispose();
});

await test("answers 404 for an unknown callback path", async () => {
	const flow = makeFlow({ randomToken: () => "s", startPort: 6080 });
	const status = await flow.begin();
	const { port } = attemptTarget(status);
	const response = await fetch(`http://127.0.0.1:${port}/not-the-callback`, { method: "POST" });
	assert.equal(response.status, 404);
	flow.dispose();
});

await test("does not store a key the server rejects", async () => {
	const storeCalls: string[] = [];
	const flow = makeFlow({
		randomToken: () => "s",
		startPort: 6010,
		fetchImpl: fakeFetch(401), // whoami says the key is invalid
		storeKey: async (credentials) => {
			storeCalls.push(credentials.apiKey);
		},
	});
	const status = await flow.begin();
	const { port, state } = attemptTarget(status);
	await postCallback(port, { apiKey: "user_bad", state, userId: "u", userName: "n", keyName: "k" });

	await wait(300);
	assert.equal(storeCalls.length, 0, "an invalid key must never be stored");
	assert.equal(flow.status().state, "failed");
	assert.equal((flow.status() as { reason: string }).reason, "invalid-key");
	flow.dispose();
});

await test("surfaces a browser-side denial", async () => {
	const flow = makeFlow({ randomToken: () => "s", startPort: 6020 });
	const status = await flow.begin();
	const { port, state } = attemptTarget(status);
	await postCallback(port, { error: "access_denied", error_description: "user said no", state });
	await wait(200);
	assert.equal(flow.status().state, "failed");
	assert.equal((flow.status() as { reason: string }).reason, "denied");
	flow.dispose();
});

await test("times out when no callback ever arrives", async () => {
	const flow = makeFlow({ randomToken: () => "s", startPort: 6030, timeoutMs: 150 });
	await flow.begin();
	await wait(400);
	assert.equal(flow.status().state, "failed");
	assert.equal((flow.status() as { reason: string }).reason, "timeout");
	flow.dispose();
});

await test("cancel stops a waiting attempt", async () => {
	const flow = makeFlow({ randomToken: () => "s", startPort: 6040 });
	await flow.begin();
	flow.cancel();
	assert.equal(flow.status().state, "failed");
	assert.equal((flow.status() as { reason: string }).reason, "cancelled");
	flow.dispose();
});

await test("skips a port that is already taken", async () => {
	const { createServer } = await import("node:http");
	const blocker = createServer();
	await new Promise<void>((resolve) => blocker.listen(6050, "127.0.0.1", resolve));
	const flow = makeFlow({ randomToken: () => "s", startPort: 6050 });
	const status = await flow.begin();
	const { port } = attemptTarget(status);
	assert.equal(port, 6051, "the flow must move past a busy port");
	blocker.close();
	flow.dispose();
});

await test("validates a key against whoami", async () => {
	assert.deepEqual(await validateApiKey(fakeFetch(200), "https://api.commandcode.ai", "k"), { valid: true });
	assert.deepEqual(await validateApiKey(fakeFetch(401), "https://api.commandcode.ai", "k"), {
		valid: false,
		error: "invalid_key",
	});
	assert.deepEqual(await validateApiKey(fakeFetch(500), "https://api.commandcode.ai", "k"), {
		valid: false,
		error: "server_error",
	});
	const network = (async () => {
		throw new Error("ENOTFOUND");
	}) as unknown as typeof fetch;
	assert.deepEqual(await validateApiKey(network, "https://api.commandcode.ai", "k"), {
		valid: false,
		error: "network_error",
	});
});

await test("merges into an existing auth file instead of clobbering it", async () => {
	const path = join(tmp, "merge.json");
	writeFileSync(path, JSON.stringify({ apiKey: "old", kept: "value" }), "utf-8");
	await storeKeyToAuthFile({ apiKey: "new", userName: "u", keyName: "k" }, path);
	const stored = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
	assert.equal(stored.apiKey, "new");
	assert.equal(stored.kept, "value", "unrelated fields survive");
	assert.equal(stored.userName, "u");
});

await test("maps every failure reason to a helpful message", () => {
	for (const reason of ["timeout", "cancelled", "denied", "invalid-key", "network", "unavailable", "error"] as const) {
		assert.ok(loginFailureMessage(reason).length > 0, `${reason} needs a message`);
	}
	assert.match(loginFailureMessage("invalid-key"), /401/);
	assert.match(loginFailureMessage("timeout"), /超时/);
});

await test("runBrowserLogin resolves with the delivered key", async () => {
	rmSync(AUTH_PATH, { force: true });
	let target: { port: number; state: string } | undefined;
	const pending = runBrowserLogin({
		apiBase: () => "https://api.commandcode.ai",
		callbacks: {
			onAuth: (info) => {
				const url = new URL(info.url);
				target = {
					port: Number(new URL(url.searchParams.get("callback") ?? "").port),
					state: url.searchParams.get("state") ?? "",
				};
			},
		},
		authPath: AUTH_PATH,
		// Redirect pi's store as well, so tests never touch the real
		// ~/.pi/agent/auth.json.
		piAuthPath: PI_AUTH_PATH,
		openBrowserImpl: () => {},
		fetchImpl: fakeFetch(200),
		randomToken: () => "wrap-state",
		startPort: 6060,
		timeoutMs: 5_000,
	});

	// Wait for onAuth to publish the target, then play the Studio page.
	for (let i = 0; i < 50 && target === undefined; i += 1) await wait(20);
	assert.ok(target, "onAuth must publish the authorization URL");
	const accepted = await postCallback(target.port, {
		apiKey: "user_wrapped_key",
		state: target.state,
		userId: "u",
		userName: "n",
		keyName: "k",
	});
	assert.equal(accepted.status, 200);

	const credentials = await pending;
	assert.equal(credentials.access, "user_wrapped_key");
	assert.equal(credentials.refresh, "user_wrapped_key");
});

await test("writes the key into pi's own credential store as well", async () => {
	// This is the fix for the provider showing up as "unconfigured": pi reads
	// ITS auth.json to decide whether a provider has auth. Writing only the
	// Command Code file left /model empty even though requests would have
	// worked.
	rmSync(AUTH_PATH, { force: true });
	rmSync(PI_AUTH_PATH, { force: true });

	let target: { port: number; state: string } | undefined;
	const pending = runBrowserLogin({
		apiBase: () => "https://api.commandcode.ai",
		callbacks: {
			onAuth: (info) => {
				const url = new URL(info.url);
				target = {
					port: Number(new URL(url.searchParams.get("callback") ?? "").port),
					state: url.searchParams.get("state") ?? "",
				};
			},
		},
		authPath: AUTH_PATH,
		piAuthPath: PI_AUTH_PATH,
		openBrowserImpl: () => {},
		fetchImpl: fakeFetch(200),
		randomToken: () => "pi-store-state",
		startPort: 6090,
		timeoutMs: 5_000,
	});

	for (let i = 0; i < 50 && target === undefined; i += 1) await wait(20);
	assert.ok(target, "onAuth must publish the authorization URL");
	await postCallback(target.port, {
		apiKey: "user_pi_store",
		state: target.state,
		userId: "u",
		userName: "n",
		keyName: "k",
	});
	await pending;

	// The Command Code file keeps the CLI-compatible flat shape...
	const cc = JSON.parse(readFileSync(AUTH_PATH, "utf-8")) as { apiKey?: string };
	assert.equal(cc.apiKey, "user_pi_store");

	// ...while pi's store uses its own provider-keyed credential shape.
	const pi = JSON.parse(readFileSync(PI_AUTH_PATH, "utf-8")) as Record<string, { type?: string; key?: string }>;
	assert.equal(pi.commandcode?.type, "api_key", "pi needs a typed credential record");
	assert.equal(pi.commandcode?.key, "user_pi_store");
});

await test("pi store write preserves other providers", async () => {
	writeFileSync(
		PI_AUTH_PATH,
		JSON.stringify({ other: { type: "api_key", key: "keep-me" } }),
		"utf-8",
	);
	await storeKeyToPiAuth({ apiKey: "user_second" }, "commandcode", PI_AUTH_PATH);
	const pi = JSON.parse(readFileSync(PI_AUTH_PATH, "utf-8")) as Record<string, { key?: string }>;
	assert.equal(pi.commandcode?.key, "user_second");
	assert.equal(pi.other?.key, "keep-me", "an unrelated provider must survive");
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed${failed ? `, ${failed} failed` : ""}\n`);
