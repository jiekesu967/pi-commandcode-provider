/**
 * Browser login for Command Code, mirroring the official `cmd login` flow.
 *
 * The Go plan is the reason this matters: it has no Provider API access, and
 * the only credential that works on the CLI gateway is the account's own API
 * key. This flow obtains exactly that key the same way the CLI does:
 *
 *  1. Bind a loopback server on 127.0.0.1, first free port from 5959 upward.
 *  2. Open the Studio authorization page with a random `state` token.
 *  3. The page POSTs `{ apiKey, state, userId, userName, keyName }` back to
 *     the loopback callback; the `state` must match, or the request is
 *     rejected as forgery.
 *  4. Validate the delivered key against `GET {apiBase}/alpha/whoami` before
 *     storing anything, so a bad key never lands on disk.
 *
 * Everything external (fetch, ports, randomness, clock) is injectable so the
 * whole flow is testable without a browser.
 *
 * @module commandcode/login
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONTROL_TIMEOUT_MS, isRecord, stringValue } from "./wire.ts";

/** Give up on the browser after this long without a callback. */
export const LOGIN_TIMEOUT_MS = 120_000;

/** First loopback port the flow tries. */
export const LOGIN_START_PORT = 5959;

/** How many consecutive ports to try from {@link LOGIN_START_PORT}. */
export const LOGIN_MAX_PORT_ATTEMPTS = 10;

/** Reject callback bodies larger than this. */
export const LOGIN_BODY_LIMIT_BYTES = 10_000;

/** Studio origins allowed to POST credentials to the loopback server. */
export const LOGIN_ALLOWED_ORIGINS = [
	"http://localhost:3000",
	"https://staging.commandcode.ai",
	"https://commandcode.ai",
];

/** The Studio route that performs the browser-side login. */
const STUDIO_AUTH_PATH = "/studio/auth/cli";

/** The credential payload the Studio page delivers. */
export interface LoginCredentials {
	apiKey: string;
	state: string;
	userId: string;
	userName: string;
	keyName: string;
}

/** Where the login attempt currently stands. */
export type LoginStatus =
	| { state: "idle" }
	| { state: "waiting"; authUrl: string }
	| { state: "success"; userName: string; keyName: string }
	| { state: "failed"; reason: LoginFailureReason; message?: string };

/** Why a login attempt ended unsuccessfully. */
export type LoginFailureReason =
	| "timeout"
	| "cancelled"
	| "denied"
	| "invalid-key"
	| "network"
	| "unavailable"
	| "error";

/** Dependencies, all injectable for tests. */
export interface LoginFlowDeps {
	/** Resolve the current API base (user-configurable). */
	apiBase: () => string;
	/** Persist the validated key. */
	storeKey: (credentials: { apiKey: string; userName: string; keyName: string }) => Promise<void>;
	/**
	 * Open the authorization URL in the user's browser once the loopback
	 * server is listening. Best-effort: a failure here still leaves the URL
	 * visible in the UI.
	 */
	openBrowser?: (url: string) => void;
	/** Override the overall timeout. */
	timeoutMs?: number;
	/** Override the first port tried. */
	startPort?: number;
	/** Override how many ports are probed. */
	maxPortAttempts?: number;
	/** Injectable fetch, for tests. */
	fetchImpl?: typeof fetch;
	/** Injectable randomness, for tests. */
	randomToken?: (bytes: number) => string;
}

/** The default auth-file location for the official CLI. */
export function defaultAuthPath(): string {
	return join(homedir(), ".commandcode", "auth.json");
}

/**
 * Open a URL in the platform browser.
 *
 * Deliberately never goes through a shell: on Windows `cmd /c start`
 * re-parses metacharacters before `start` runs, which would make the
 * authorization URL (which contains `&`) an injection vector. This mirrors
 * pi's own `openBrowser` helper.
 */
export function openBrowser(target: string): void {
	const [cmd, args]: [string, string[]] =
		process.platform === "darwin"
			? ["open", [target]]
			: process.platform === "win32"
				? ["rundll32", ["url.dll,FileProtocolHandler", target]]
				: ["xdg-open", [target]];
	void import("node:child_process").then(({ spawn }) => {
		spawn(cmd, args, { stdio: "ignore", detached: true })
			.on("error", () => undefined)
			.unref();
	});
}

/** Compose the Studio authorization URL. */
export function buildAuthUrl(options: { studioBase: string; port: number; state: string }): string {
	const callback = `http://localhost:${options.port}/callback`;
	return `${options.studioBase}${STUDIO_AUTH_PATH}?callback=${encodeURIComponent(callback)}&state=${encodeURIComponent(options.state)}`;
}

/** Map an API base onto the Studio base that pairs with it. */
export function studioBaseForApiBase(apiBase: string): string {
	if (/^https:\/\/staging-api\.commandcode\.ai/i.test(apiBase)) return "https://staging.commandcode.ai";
	if (/^http:\/\/localhost(:\d+)?$/i.test(apiBase)) return "http://localhost:3000";
	return "https://commandcode.ai";
}

/**
 * Validate a candidate key against `/alpha/whoami`. Mirrors the CLI's
 * verdicts so the caller can report a precise reason.
 */
export async function validateApiKey(
	fetchImpl: typeof fetch,
	apiBase: string,
	apiKey: string,
): Promise<{ valid: true } | { valid: false; error: "invalid_key" | "server_error" | "network_error" }> {
	try {
		const response = await fetchImpl(`${apiBase.replace(/\/+$/, "")}/alpha/whoami`, {
			method: "GET",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});
		if (response.status === 401) return { valid: false, error: "invalid_key" };
		if (response.ok) return { valid: true };
		return { valid: false, error: "server_error" };
	} catch {
		return { valid: false, error: "network_error" };
	}
}

/** Whether a callback body carries every credential field the CLI requires. */
function isCallbackCredentials(value: unknown): value is LoginCredentials {
	return (
		isRecord(value) &&
		typeof value.apiKey === "string" &&
		value.apiKey !== "" &&
		typeof value.state === "string" &&
		typeof value.userId === "string" &&
		typeof value.userName === "string" &&
		typeof value.keyName === "string"
	);
}

/** Whether one loopback port is free right now. */
function checkPortAvailable(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = createServer();
		probe.once("error", () => resolve(false));
		probe.once("listening", () => probe.close(() => resolve(true)));
		probe.listen(port, "127.0.0.1");
	});
}

/** A tagged settle failure carrying a stable reason. */
class LoginSettleError extends Error {
	readonly reason: LoginFailureReason;
	constructor(reason: LoginFailureReason, message: string) {
		super(message);
		this.reason = reason;
		this.name = "LoginSettleError";
	}
}

/** Echo the Origin header only when the Studio allowlist contains it. */
function corsOrigin(origin: string | undefined): string {
	return origin !== undefined && LOGIN_ALLOWED_ORIGINS.includes(origin) ? origin : "";
}

/**
 * One browser-login attempt machine. Single-flight: `begin()` while an
 * attempt is waiting returns that attempt's status instead of starting a
 * second one. A terminal state makes the next `begin()` start fresh.
 */
export class LoginFlow {
	private readonly deps: LoginFlowDeps;
	private readonly fetchImpl: typeof fetch;
	private listeners = new Set<() => void>();
	private statusValue: LoginStatus = { state: "idle" };
	private server: Server | undefined;
	private timer: NodeJS.Timeout | undefined;
	private settle: { resolve: (value: LoginCredentials) => void; reject: (error: Error) => void } | undefined;
	/**
	 * Attempt generation. A delivered callback keeps validating the key
	 * asynchronously, and the user may cancel during that window; the
	 * generation lets a late completion notice it no longer owns the status
	 * face and stop, rather than storing a key the user cancelled.
	 */
	private attemptSeq = 0;
	private disposed = false;

	constructor(deps: LoginFlowDeps) {
		this.deps = deps;
		this.fetchImpl = deps.fetchImpl ?? fetch;
	}

	/** Subscribe to state transitions. Returns the disposer. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** The current attempt's status. */
	status(): LoginStatus {
		return this.statusValue;
	}

	/**
	 * Start an attempt (or rejoin the live one) and resolve with its status —
	 * `waiting` carrying the Studio URL once the loopback server is up.
	 * Rejects only when the flow cannot start at all.
	 */
	async begin(): Promise<LoginStatus> {
		if (this.disposed) throw new Error("login flow has been disposed");
		if (this.statusValue.state === "waiting" && this.server !== undefined) return this.statusValue;
		this.teardown();
		const attempt = ++this.attemptSeq;
		const port = await this.findPort();
		const expectedState = this.deps.randomToken?.(32) ?? randomBytes(32).toString("base64url");
		const settled = new Promise<LoginCredentials>((resolve, reject) => {
			this.settle = { resolve, reject };
		});
		await this.bindServer(port, expectedState);
		const authUrl = buildAuthUrl({
			studioBase: studioBaseForApiBase(this.readApiBase()),
			port,
			state: expectedState,
		});
		this.setStatus({ state: "waiting", authUrl });
		// Launch the browser now that the callback port is actually listening,
		// so a fast sign-in cannot race the server start.
		try {
			this.deps.openBrowser?.(authUrl);
		} catch {
			// Best-effort: the caller still shows the URL.
		}
		this.timer = setTimeout(() => {
			this.teardown();
			this.setStatus({ state: "failed", reason: "timeout", message: "等待浏览器回调超时。" });
		}, this.deps.timeoutMs ?? LOGIN_TIMEOUT_MS);
		this.timer.unref?.();
		settled.then(
			(credentials) => void this.complete(attempt, credentials),
			(failure: unknown) => this.failFrom(attempt, failure),
		);
		return this.statusValue;
	}

	/** Cancel a waiting attempt; terminal states are untouched. */
	cancel(): void {
		if (this.disposed || this.statusValue.state !== "waiting") return;
		this.teardown();
		this.setStatus({ state: "failed", reason: "cancelled" });
	}

	/** Stop everything; a waiting attempt ends cancelled. Idempotent. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		const wasWaiting = this.statusValue.state === "waiting";
		this.teardown();
		if (wasWaiting) this.setStatus({ state: "failed", reason: "cancelled" });
	}

	private readApiBase(): string {
		return this.deps.apiBase() || "https://api.commandcode.ai";
	}

	private setStatus(next: LoginStatus): void {
		this.statusValue = next;
		for (const listener of [...this.listeners]) listener();
	}

	/** First free port among the consecutive candidates. */
	private async findPort(): Promise<number> {
		const startPort = this.deps.startPort ?? LOGIN_START_PORT;
		const attempts = this.deps.maxPortAttempts ?? LOGIN_MAX_PORT_ATTEMPTS;
		for (let index = 0; index < attempts; index += 1) {
			const candidate = startPort + index;
			if (await checkPortAvailable(candidate)) return candidate;
		}
		throw new Error(`从端口 ${startPort} 起尝试 ${attempts} 次均无可用端口`);
	}

	/**
	 * Bind the attempt's loopback server, resolving once the port is live.
	 * A pre-bind failure rejects (surfacing from `begin()`); a later server
	 * error settles the live attempt as a tagged failure instead.
	 */
	private bindServer(port: number, expectedState: string): Promise<void> {
		return new Promise((resolve, reject) => {
			let binding = true;
			const server = createServer((request, response) =>
				this.handleCallback(request, response, expectedState),
			);
			this.server = server;
			server.once("error", (error: Error & { code?: string }) => {
				if (this.server !== server) return;
				this.server = undefined;
				const tagged = new LoginSettleError(
					"error",
					`无法在端口 ${port} 绑定登录回调服务：${error.code ?? error.message}`,
				);
				if (binding) {
					binding = false;
					reject(tagged);
				} else {
					this.settle?.reject(tagged);
				}
			});
			server.listen(port, "127.0.0.1", () => {
				if (!binding) return;
				binding = false;
				resolve();
			});
		});
	}

	/** One request against the attempt's callback endpoint (CLI-mirrored). */
	private handleCallback(request: IncomingMessage, response: ServerResponse, expectedState: string): void {
		response.setHeader("Connection", "close");
		response.setHeader("Access-Control-Allow-Origin", corsOrigin(request.headers.origin));
		response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
		response.setHeader("Access-Control-Allow-Headers", "Content-Type");
		response.setHeader("Content-Type", "application/json");
		const json = (code: number, body: unknown) => {
			response.writeHead(code);
			response.end(JSON.stringify(body));
		};

		if (request.method === "OPTIONS") {
			response.writeHead(204);
			response.end();
			return;
		}
		if ((request.url?.split("?")[0] ?? "/") !== "/callback") {
			json(404, { success: false, error: "Not found" });
			return;
		}
		if (request.method !== "POST") {
			json(405, { success: false, error: "Method not allowed. Use POST." });
			return;
		}

		let bodyBytes = 0;
		let body = "";
		request.on("data", (chunk: Buffer) => {
			bodyBytes += chunk.length;
			body += chunk.toString();
			if (bodyBytes > LOGIN_BODY_LIMIT_BYTES) request.destroy();
		});
		request.on("end", () => {
			if (request.destroyed) return;
			let payload: unknown;
			try {
				payload = JSON.parse(body);
			} catch {
				json(400, { success: false, error: "Invalid JSON" });
				return;
			}

			// The page can report a refusal instead of credentials.
			if (isRecord(payload) && "error" in payload) {
				if (payload.state !== expectedState) {
					json(403, { success: false, error: "Invalid state token" });
					return;
				}
				const description =
					stringValue(payload.error_description) ?? stringValue(payload.error) ?? "授权失败";
				this.settleAttempt(
					json,
					200,
					{ success: true },
					new LoginSettleError(payload.error === "access_denied" ? "denied" : "error", description),
				);
				return;
			}

			if (!isCallbackCredentials(payload)) {
				json(400, { success: false, error: "Missing required fields" });
				return;
			}
			// The state check is the anti-forgery measure: without it any local
			// process could POST an arbitrary key.
			if (payload.state !== expectedState) {
				json(403, { success: false, error: "Invalid state token" });
				return;
			}
			this.settleAttempt(json, 200, { success: true }, undefined, { ...payload });
		});
		request.on("error", () => undefined);
	}

	/** Answer a decisive callback, stop listening, and settle the attempt. */
	private settleAttempt(
		json: (code: number, body: unknown) => void,
		code: number,
		body: unknown,
		failure?: LoginSettleError,
		credentials?: LoginCredentials,
	): void {
		json(code, body);
		const settle = this.settle;
		this.teardown();
		if (settle === undefined) return;
		if (failure !== undefined) settle.reject(failure);
		else if (credentials !== undefined) settle.resolve(credentials);
	}

	/** Whether an attempt still owns the status face. */
	private ownsAttempt(attempt: number): boolean {
		return !this.disposed && this.attemptSeq === attempt && this.statusValue.state === "waiting";
	}

	/**
	 * Post-validation completion: whoami check, then hand the key to storage.
	 * Every step re-checks ownership first, because the whoami round-trip and
	 * the write are awaits during which the user may cancel.
	 */
	private async complete(attempt: number, credentials: LoginCredentials): Promise<void> {
		if (!this.ownsAttempt(attempt)) return;
		const validation = await validateApiKey(this.fetchImpl, this.readApiBase(), credentials.apiKey);
		if (!this.ownsAttempt(attempt)) return;
		if (!validation.valid) {
			const reason: LoginFailureReason =
				validation.error === "invalid_key"
					? "invalid-key"
					: validation.error === "network_error"
						? "network"
						: "error";
			this.setStatus({
				state: "failed",
				reason,
				message: `/alpha/whoami 拒绝了该密钥（${validation.error}）。`,
			});
			return;
		}
		try {
			await this.deps.storeKey({
				apiKey: credentials.apiKey,
				userName: credentials.userName,
				keyName: credentials.keyName,
			});
		} catch (error) {
			if (!this.ownsAttempt(attempt)) return;
			this.setStatus({
				state: "failed",
				reason: "unavailable",
				message: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		if (!this.ownsAttempt(attempt)) return;
		this.clearTimer();
		this.setStatus({ state: "success", userName: credentials.userName, keyName: credentials.keyName });
	}

	/** Map a tagged settle rejection onto the status face. */
	private failFrom(attempt: number, failure: unknown): void {
		if (!(failure instanceof LoginSettleError)) return;
		if (!this.ownsAttempt(attempt)) return;
		this.setStatus({ state: "failed", reason: failure.reason, message: failure.message });
	}

	private clearTimer(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	/** Close the server and watchdog without touching the published status. */
	private teardown(): void {
		this.clearTimer();
		this.server?.close();
		this.server = undefined;
		this.settle = undefined;
	}
}

/**
 * Human-readable message for a failed login attempt.
 */
export function loginFailureMessage(reason: LoginFailureReason, message?: string): string {
	const base: Record<LoginFailureReason, string> = {
		timeout: "等待浏览器回调超时（120 秒）—— 请重试，或改用「手工粘贴 API 密钥」。",
		cancelled: "登录已取消。",
		denied: "你在浏览器中拒绝了本次授权。",
		"invalid-key": "服务端拒绝了该密钥（/alpha/whoami 返回 401）—— 请确认登录的是正确的 Command Code 账号。",
		network: "无法连接 Command Code —— 请检查网络或代理设置。",
		unavailable: "无法保存密钥。",
		error: "登录流程出错。",
	};
	return message !== undefined && message !== "" ? `${base[reason]}（${message}）` : base[reason];
}

/** The callback surface the browser flow needs from its caller. */
export interface BrowserLoginCallbacks {
	/** Announce the authorization URL so the UI can show it. */
	onAuth?: (info: { url: string; instructions?: string }) => void;
	/** Transient progress updates. */
	onProgress?: (message: string) => void;
}

/** Options for {@link runBrowserLogin}. */
export interface BrowserLoginOptions {
	apiBase: () => string;
	callbacks?: BrowserLoginCallbacks;
	/** Called after the key was successfully stored. */
	onStored?: () => void;
	/** Injection points for tests. */
	fetchImpl?: typeof fetch;
	randomToken?: (bytes: number) => string;
	timeoutMs?: number;
	startPort?: number;
	maxPortAttempts?: number;
	/** Where to persist the key; defaults to the CLI's auth file. */
	authPath?: string;
	/** Provider id to register the key under in pi's store. */
	providerId?: string;
	/** pi's credential store path; defaults to ~/.pi/agent/auth.json. */
	piAuthPath?: string;
	/** Override browser launching (tests pass a no-op). */
	openBrowserImpl?: (url: string) => void;
}

/**
 * Run one browser login to completion and return the key as OAuth-shaped
 * credentials.
 *
 * This is the single entry point both `/commandcode-login` and the provider's
 * `oauth.login` use, so the two paths cannot drift apart. The returned
 * `access` field carries the API key, matching what `getApiKey` hands to
 * requests.
 */
export async function runBrowserLogin(
	options: BrowserLoginOptions,
): Promise<{ refresh: string; access: string; expires: number }> {
	const callbacks = options.callbacks;
	const flow = new LoginFlow({
		apiBase: options.apiBase,
		fetchImpl: options.fetchImpl,
		randomToken: options.randomToken,
		timeoutMs: options.timeoutMs,
		startPort: options.startPort,
		maxPortAttempts: options.maxPortAttempts,
		openBrowser: options.openBrowserImpl ?? openBrowser,
		storeKey: async (credentials) => {
			// Two stores, two readers. pi decides whether the provider is
			// configured from its own auth.json, so without an entry there the
			// provider stays "unconfigured" and /model lists none of its models.
			// The plugin's account pool (and the official `cmd` CLI) read the
			// Command Code auth file instead, so both are written.
			await storeKeyToAuthFile(credentials, options.authPath ?? defaultAuthPath());
			await storeKeyToPiAuth(credentials, options.providerId ?? "commandcode", options.piAuthPath);
			options.onStored?.();
		},
	});

	return await new Promise((resolve, reject) => {
		let settled = false;
		const unsubscribe = flow.onChange(() => {
			const current = flow.status();
			if (current.state === "success") {
				if (settled) return;
				settled = true;
				unsubscribe();
				// The key itself is not in the status; re-read it from the store
				// so the caller gets the real credential.
				const key = readStoredKey(options.authPath ?? defaultAuthPath());
				if (key === undefined) {
					reject(new Error("登录成功但未能读回密钥。"));
					return;
				}
				resolve({ refresh: key, access: key, expires: Number.MAX_SAFE_INTEGER });
			} else if (current.state === "failed") {
				if (settled) return;
				settled = true;
				unsubscribe();
				reject(new Error(loginFailureMessage(current.reason, current.message)));
			}
		});

		void flow
			.begin()
			.then((status) => {
				if (status.state === "waiting") {
					callbacks?.onAuth?.({
						url: status.authUrl,
						instructions: "请在浏览器中完成 Command Code 登录（登录后会自动回到 pi）。",
					});
					callbacks?.onProgress?.(`本地回调服务已启动，等待浏览器授权…`);
					return;
				}
				if (status.state === "failed") {
					if (settled) return;
					settled = true;
					unsubscribe();
					reject(new Error(loginFailureMessage(status.reason, status.message)));
				}
			})
			.catch((error: unknown) => {
				if (settled) return;
				settled = true;
				unsubscribe();
				reject(error instanceof Error ? error : new Error(String(error)));
			});
	});
}

/** Read a key back from the auth file after a successful login. */
function readStoredKey(authPath: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(authPath, "utf-8"));
		return isRecord(parsed) ? stringValue(parsed.apiKey) : undefined;
	} catch {
		return undefined;
	}
}

/** Where pi keeps its own credential store. */
export function defaultPiAuthPath(): string {
	return join(homedir(), ".pi", "agent", "auth.json");
}

/**
 * Write the key into PI's credential store as well as the CLI's auth file.
 *
 * Both are needed, for different readers:
 *  - pi reads `~/.pi/agent/auth.json` (or `$COMMANDCODE_API_KEY`) when deciding
 *    whether a provider is configured. Without an entry here the provider stays
 *    "unconfigured", and `/model` lists none of its models at all.
 *  - this plugin's account pool reads `~/.commandcode/auth.json`, and the
 *    official `cmd` CLI shares that file.
 *
 * pi caches its credential store in memory, so a provider that was
 * unconfigured at startup needs `/reload` (or a restart) before its models
 * appear.
 */
export async function storeKeyToPiAuth(
	credentials: { apiKey: string },
	providerId = "commandcode",
	authPath: string = defaultPiAuthPath(),
): Promise<void> {
	let existing: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(authPath, "utf-8"));
		if (isRecord(parsed)) existing = parsed;
	} catch {
		// No readable existing file — start fresh.
	}
	const next = {
		...existing,
		[providerId]: { type: "api_key", key: credentials.apiKey },
	};
	await mkdir(dirname(authPath), { recursive: true });
	await writeFile(authPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
}

/**
 * Make sure pi's own credential store has this provider's key.
 *
 * pi decides whether a provider is configured by reading ITS auth.json (or an
 * env var). A key living only in `~/.commandcode/auth.json` — which is where
 * the official `cmd` CLI and this plugin's account pool look — leaves pi
 * treating the provider as unconfigured, so `/model` lists none of its models
 * even though requests would have worked fine.
 *
 * This runs at startup so an account logged in BEFORE this store existed (or
 * set up by the `cmd` CLI directly) starts working without a re-login. It is
 * a no-op once pi's store already has a key for the provider, so a key the
 * user deliberately set in pi is never overwritten.
 *
 * @returns true when a key was migrated.
 */
export async function ensurePiHasKey(
	providerId: string,
	options?: { piAuthPath?: string; cliAuthPath?: string; envName?: string },
): Promise<boolean> {
	const piPath = options?.piAuthPath ?? defaultPiAuthPath();
	const cliPath = options?.cliAuthPath ?? defaultAuthPath();

	// An env var already satisfies pi, so there is nothing to migrate.
	const envName = options?.envName;
	if (envName !== undefined && (process.env[envName] ?? "").trim() !== "") return false;

	// Already configured in pi's store → leave the user's choice alone.
	try {
		const parsed: unknown = JSON.parse(readFileSync(piPath, "utf-8"));
		if (isRecord(parsed)) {
			const record = parsed[providerId];
			if (isRecord(record) && (stringValue(record.key) ?? stringValue(record.access)) !== undefined) {
				return false;
			}
		}
	} catch {
		// No pi store yet — the migration below creates it.
	}

	// Pull the key from the Command Code auth file, if any.
	let key: string | undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(cliPath, "utf-8"));
		if (isRecord(parsed)) {
			key = stringValue(parsed.apiKey) ?? stringValue(parsed.commandcode);
		}
	} catch {
		return false;
	}
	if (key === undefined || key.trim() === "") return false;

	try {
		await storeKeyToPiAuth({ apiKey: key.trim() }, providerId, piPath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Write a key to the CLI's auth file, which is one of the credential sources
 * the request path already reads. Merges with any existing file so unrelated
 * fields are preserved.
 */
export async function storeKeyToAuthFile(
	credentials: { apiKey: string; userName?: string; keyName?: string },
	authPath: string = defaultAuthPath(),
): Promise<void> {
	let existing: Record<string, unknown> = {};
	try {
		const { readFileSync } = await import("node:fs");
		const parsed: unknown = JSON.parse(readFileSync(authPath, "utf-8"));
		if (isRecord(parsed)) existing = parsed;
	} catch {
		// No readable existing file — start fresh.
	}
	const next = {
		...existing,
		apiKey: credentials.apiKey,
		...(credentials.userName !== undefined ? { userName: credentials.userName } : {}),
		...(credentials.keyName !== undefined ? { keyName: credentials.keyName } : {}),
	};
	await mkdir(dirname(authPath), { recursive: true });
	await writeFile(authPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
}
