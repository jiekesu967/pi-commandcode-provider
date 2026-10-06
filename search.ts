/**
 * Command Code web tools for pi: `cc_search` and `cc_fetch`.
 *
 * The official Command Code CLI has two built-in web tools, and both are
 * reachable with the SAME subscription key the model already uses — no
 * separate search key, endpoint or model:
 *
 * | Route | Body | Response |
 * |---|---|---|
 * | `POST {apiBase}/alpha/web-search` | `{ query, numResults, allowedDomains?, blockedDomains? }` | `{ results: [{ title, url, snippet }], formatted }` |
 * | `POST {apiBase}/alpha/web-fetch`  | `{ url }` | `{ content, url, status }` |
 *
 * This is the same seam the dsh plugin (`@mars-sea/dsh-commandcode-provider`)
 * plugs into, but pi has no pluggable search backend and no built-in
 * `web_search` tool, so here the capability has to arrive as ordinary tools
 * registered by an extension. They live in their own entry file so the
 * search tools can be disabled independently of the model provider.
 *
 * Verified live against the production gateway with a Go-plan key: search
 * answers in ~3.5s, `allowedDomains` is honoured, `numResults` above 10 is
 * rejected with 400 (hence the clamp), a bad key gives 401, and `web-fetch`
 * ignores `maxChars` (hence the client-side truncation).
 *
 * Configuration lives in `~/.pi/agent/settings.json` under
 * `commandcode.search`:
 *
 * ```json
 * {
 *   "commandcode": {
 *     "search": {
 *       "enabled": true,
 *       "fetchEnabled": true,
 *       "toolName": "cc_search",
 *       "fetchToolName": "cc_fetch",
 *       "activeByDefault": true,
 *       "numResults": 5,
 *       "allowedDomains": [],
 *       "blockedDomains": [],
 *       "cacheTtlMs": 600000,
 *       "maxContentChars": 20000,
 *       "timeoutMs": 60000
 *     }
 *   }
 * }
 * ```
 */
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type, type Static } from "typebox";

import { AccountPool, slotsFromConfig, type AccountConfig, type ModelAccountRule } from "./accounts.ts";
import { UsageClient } from "./usage.ts";
import {
	cliHeaders,
	COMMAND_CODE_CLI_VERSION,
	commandCodeErrorMessage,
	DEFAULT_API_BASE,
	fetchCliVersion,
	isCliOutOfDateError,
	isRecord,
	parseRetryAfterMs,
	stringValue,
} from "./wire.ts";

/** The private CLI routes the official client's web tools post to. */
export const SEARCH_ROUTE = "/alpha/web-search";
export const FETCH_ROUTE = "/alpha/web-fetch";

/** Command Code's bounds on `numResults`, taken from the CLI's tool schema. */
export const MIN_NUM_RESULTS = 1;
export const MAX_NUM_RESULTS = 10;
/** What the CLI sends when the caller names no cap. */
export const DEFAULT_NUM_RESULTS = 5;

export const DEFAULT_CACHE_TTL_MS = 10 * 60_000;
export const DEFAULT_MAX_CONTENT_CHARS = 20_000;
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Default tool names: deliberately NOT `web_search`/`web_fetch`. */
const DEFAULT_SEARCH_TOOL = "cc_search";
const DEFAULT_FETCH_TOOL = "cc_fetch";

/**
 * Providers whose models already run a server-side search themselves, so a
 * search tool call would just spend a second round-trip on the same result.
 */
const NATIVE_SEARCH_PROVIDERS = ["deepseek-responses"];

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** The `commandcode.search` block. */
export interface SearchSettings {
	enabled?: boolean;
	fetchEnabled?: boolean;
	toolName?: string;
	fetchToolName?: string;
	activeByDefault?: boolean;
	numResults?: number;
	allowedDomains?: string[];
	blockedDomains?: string[];
	cacheTtlMs?: number;
	maxContentChars?: number;
	timeoutMs?: number;
	nativeSearchProviders?: string[];
}

/** The whole `commandcode` block, as far as the web tools need it. */
interface CommandCodeSettings {
	apiBase?: string;
	apiKeyEnv?: string;
	accounts?: AccountConfig[];
	activeAccount?: string;
	modelAccountRules?: ModelAccountRule[];
	workingDir?: string;
	search?: SearchSettings;
}

/** Read the `commandcode` settings block, tolerating a missing or malformed file. */
export function readSettings(): CommandCodeSettings {
	try {
		const raw: unknown = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf-8"));
		if (!isRecord(raw)) return {};
		const block = raw.commandcode;
		if (!isRecord(block)) return {};
		const search = isRecord(block.search) ? (block.search as SearchSettings) : undefined;
		return { ...(block as CommandCodeSettings), ...(search !== undefined ? { search } : {}) };
	} catch {
		return {};
	}
}

// ---------------------------------------------------------------------------
// Request shaping (pure, and therefore directly testable)
// ---------------------------------------------------------------------------

/**
 * Clamp a requested result count into Command Code's 1–10 window, falling
 * back to the CLI default when the caller named none. The server rejects
 * anything above 10 with a bare 400, so this must happen client-side.
 */
export function clampNumResults(value: number | undefined, fallback = DEFAULT_NUM_RESULTS): number {
	const base = value === undefined || !Number.isFinite(value) ? fallback : value;
	return Math.max(MIN_NUM_RESULTS, Math.min(MAX_NUM_RESULTS, Math.round(base)));
}

/** Trim, drop blanks, and deduplicate a domain list; undefined when empty. */
export function cleanDomains(value: string[] | undefined): string[] | undefined {
	const cleaned = (value ?? []).map((entry) => entry.trim()).filter((entry) => entry !== "");
	return cleaned.length === 0 ? undefined : [...new Set(cleaned)];
}

/** One search request, as the tool receives it. */
export interface SearchRequest {
	query: string;
	numResults?: number;
	allowedDomains?: string[];
	blockedDomains?: string[];
}

/** Build the `/alpha/web-search` body. */
export function buildSearchBody(request: SearchRequest): Record<string, unknown> {
	const body: Record<string, unknown> = {
		query: request.query,
		numResults: clampNumResults(request.numResults),
	};
	const allowed = cleanDomains(request.allowedDomains);
	if (allowed !== undefined) body.allowedDomains = allowed;
	const blocked = cleanDomains(request.blockedDomains);
	if (blocked !== undefined) body.blockedDomains = blocked;
	return body;
}

/** Build the `/alpha/web-fetch` body: one URL per call; an array is rejected. */
export function buildFetchBody(url: string): Record<string, unknown> {
	return { url };
}

/** One result row, as handed back to the model. */
export interface SearchSource {
	url: string;
	title?: string;
	snippet?: string;
}

/** A parsed `/alpha/web-search` response. */
export interface SearchPayload {
	sources: SearchSource[];
	/** The server's own ready-to-read rendering, when it supplied one. */
	formatted: string | undefined;
}

/**
 * Parse a search response: keep rows with a usable URL, drop duplicates
 * (the gateway can repeat a source across query variants), and trim the
 * optional fields away when they are empty rather than carrying `""`.
 */
export function parseSearchPayload(payload: unknown): SearchPayload {
	const record = isRecord(payload) ? payload : undefined;
	const results = record?.results;
	if (!Array.isArray(results)) {
		throw new CommandCodeSearchError(
			"protocol",
			"Command Code 联网检索没有返回 results 数组（服务端可能拒绝了该查询）",
		);
	}
	const sources: SearchSource[] = [];
	const seen = new Set<string>();
	for (const item of results) {
		if (!isRecord(item)) continue;
		const url = stringValue(item.url)?.trim();
		if (url === undefined || url === "") continue;
		if (seen.has(url)) continue;
		seen.add(url);
		const title = stringValue(item.title)?.trim();
		const snippet = stringValue(item.snippet)?.trim();
		sources.push({
			url,
			...(title !== undefined && title !== "" ? { title } : {}),
			...(snippet !== undefined && snippet !== "" ? { snippet } : {}),
		});
	}
	return { sources, formatted: stringValue(record?.formatted)?.trim() || undefined };
}

/**
 * Turn a payload into what the model reads: the server's `formatted` block
 * when present (it already numbers the results), otherwise a list rebuilt
 * from the structured rows. Any source URL the body does not mention is
 * appended, so the model always ends up holding citable links.
 */
export function renderSearchText(payload: SearchPayload, query: string): string {
	const lines = payload.sources.map((source, index) => {
		const title = source.title ?? source.url;
		const snippet = source.snippet !== undefined ? `\n   ${source.snippet}` : "";
		return `${index + 1}. ${title}\n   ${source.url}${snippet}`;
	});
	let body = payload.formatted ?? `Search results for: ${query}\n\n${lines.join("\n\n")}`;
	const missing = payload.sources.filter((source) => !body.includes(source.url));
	if (missing.length > 0) {
		body += `\n\n来源:\n${missing.map((source) => `- ${source.url}`).join("\n")}`;
	}
	return body.trim();
}

/** A parsed `/alpha/web-fetch` response. */
export interface FetchPayload {
	content: string;
	url: string | undefined;
	status: number | undefined;
}

/** Parse a fetched-page response; `content` is the only required field. */
export function parseFetchPayload(payload: unknown): FetchPayload {
	const record = isRecord(payload) ? payload : undefined;
	const content = stringValue(record?.content);
	if (content === undefined) {
		throw new CommandCodeSearchError("protocol", "Command Code 网页抓取没有返回 content 字段");
	}
	return {
		content,
		url: stringValue(record?.url),
		status: typeof record?.status === "number" ? record.status : undefined,
	};
}

/** Fail fast when the caller's signal is already aborted. */
function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) {
		throw new CommandCodeSearchError("aborted", "Command Code 请求已取消；request aborted");
	}
}

/** Truncate server content: the endpoint ignores `maxChars` and can return 35KB+. */
export function truncateContent(content: string, maxChars: number): { text: string; truncated: boolean } {
	if (maxChars <= 0 || content.length <= maxChars) return { text: content, truncated: false };
	return {
		text: `${content.slice(0, maxChars)}\n\n[已截断：原文 ${content.length} 字符，仅显示前 ${maxChars} 字符；可用更大 max_chars 重试]`,
		truncated: true,
	};
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** What went wrong, in terms the tool can turn into advice. */
export type SearchErrorKind =
	| "no-key"
	| "invalid-key"
	| "rate-limit"
	| "outdated-client"
	| "forbidden"
	| "bad-request"
	| "server"
	| "network"
	| "timeout"
	| "aborted"
	| "protocol";

/** A classified web-tool failure. Never carries the API key. */
export class CommandCodeSearchError extends Error {
	readonly kind: SearchErrorKind;
	readonly status: number | undefined;
	readonly hint: string | undefined;

	constructor(
		kind: SearchErrorKind,
		message: string,
		options?: { status?: number; hint?: string; cause?: unknown },
	) {
		super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
		this.name = "CommandCodeSearchError";
		this.kind = kind;
		this.status = options?.status;
		this.hint = options?.hint;
	}
}

/** Map an HTTP status onto a failure kind. */
export function classifyHttpStatus(status: number, bodyText: string): SearchErrorKind {
	if (status === 401) return "invalid-key";
	if (status === 429) return "rate-limit";
	// A 403 with a version complaint is NOT the plan gate: retrying another
	// account cannot cure a stale client (the same trap the adapter handles).
	if (status === 403) return isCliOutOfDateError(bodyText) ? "outdated-client" : "forbidden";
	if (status === 400) return "bad-request";
	if (status >= 500) return "server";
	return "protocol";
}

/** Actionable, bilingual advice for a failure kind. */
export function hintFor(kind: SearchErrorKind, bodyText = "", retryAfterMs?: number): string | undefined {
	switch (kind) {
		case "no-key":
			return "运行 /commandcode-login，或用 COMMANDCODE_API_KEY 环境变量 / ~/.commandcode/auth.json 提供 Command Code 密钥；run /commandcode-login or set COMMANDCODE_API_KEY";
		case "invalid-key":
			return "Command Code 密钥无效或已过期 —— 运行 /commandcode-login 重新登录；the API key was rejected (401)";
		case "rate-limit":
			return `用量/速率限额（429）${
				retryAfterMs !== undefined && retryAfterMs > 0 ? `，建议等待约 ${Math.ceil(retryAfterMs / 1000)}s` : "，窗口重置后会自动恢复"
			}；usage or rate limit reached (429)`;
		case "outdated-client": {
			const minVersion = /"minVersion"\s*:\s*"([^"]+)"/.exec(bodyText)?.[1];
			return `网关认为客户端过旧${minVersion !== undefined ? `（要求至少 ${minVersion}）` : ""} —— 运行 pi update 或 npm i -g command-code 后再试；the gateway rejected this client version`;
		}
		case "forbidden":
			return "该套餐可能未开通此端点（Go 套餐可用，实测通过）；the plan may not include this endpoint";
		case "bad-request":
			return "检查参数：num_results 必须在 1–10 之间，query 不能为空；check the request parameters";
		case "server":
			return "Command Code 服务端错误，稍后重试；the Command Code service failed — retry later";
		case "network":
			return "无法连接 Command Code —— 检查网络或 commandcode.apiBase；check the network or commandcode.apiBase";
		case "timeout":
			return "可提高 commandcode.search.timeoutMs 后重试；raise commandcode.search.timeoutMs and retry";
		case "aborted":
			return undefined;
		default:
			return "响应体与预期不符（端点契约可能已变化）；the response did not match the expected contract";
	}
}

/** Render a failure for the model: message plus its advice, never a stack. */
export function describeSearchError(error: unknown): { text: string; kind: SearchErrorKind | "unknown" } {
	if (error instanceof CommandCodeSearchError) {
		const hint = error.hint ?? hintFor(error.kind);
		return { text: hint === undefined ? error.message : `${error.message}\n提示：${hint}`, kind: error.kind };
	}
	const message = error instanceof Error ? error.message : String(error);
	return { text: message, kind: "unknown" };
}

// ---------------------------------------------------------------------------
// Result cache
// ---------------------------------------------------------------------------

/** A tiny TTL cache: identical queries within the window cost no quota. */
export class TtlCache<T> {
	private readonly entries = new Map<string, { at: number; value: T }>();
	private readonly ttlMs: () => number;

	constructor(ttlMs: () => number) {
		this.ttlMs = ttlMs;
	}

	get(key: string): { value: T; ageMs: number } | undefined {
		const ttl = this.ttlMs();
		if (ttl <= 0) return undefined;
		const hit = this.entries.get(key);
		if (hit === undefined) return undefined;
		const ageMs = Date.now() - hit.at;
		if (ageMs >= ttl) {
			this.entries.delete(key);
			return undefined;
		}
		return { value: hit.value, ageMs };
	}

	set(key: string, value: T): void {
		if (this.ttlMs() <= 0) return;
		this.entries.set(key, { at: Date.now(), value });
	}

	clear(): void {
		this.entries.clear();
	}

	get size(): number {
		return this.entries.size;
	}
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** Everything the client needs from the extension, injected for testing. */
export interface SearchDeps {
	apiBase: () => string;
	cliVersion: () => string;
	workingDir: () => string;
	/** Resolve a usable account, excluding one already rejected in this call. */
	resolveAccount: (options?: { exclude?: string }) => Promise<{ key: string; slotId: string } | undefined>;
	markRejected: (key: string, rejection: "invalid-credential" | "rate-limit") => void;
	cacheTtlMs: () => number;
	timeoutMs: () => number;
	maxContentChars: () => number;
	fetchImpl?: typeof fetch;
	/** How many accounts one call may try before giving up. */
	maxAccountAttempts?: number;
}

/** What a completed search reports back. */
export interface SearchOutcome {
	text: string;
	sources: SearchSource[];
	numResults: number;
	elapsedMs: number;
	cached: boolean;
	/** Cache age when served from cache. */
	cacheAgeMs: number | undefined;
	account: string | undefined;
}

/** What a completed fetch reports back. */
export interface FetchOutcome {
	text: string;
	url: string;
	status: number | undefined;
	truncated: boolean;
	elapsedMs: number;
	cached: boolean;
	cacheAgeMs: number | undefined;
	account: string | undefined;
}

/**
 * The two web endpoints, with Command Code's credential chain, header set
 * and error taxonomy behind them.
 *
 * A 401 or 429 marks that account and the call moves to the next one, which
 * is what makes several Go subscriptions useful here too.
 */
export class SearchClient {
	private readonly deps: SearchDeps;
	private readonly searchCache: TtlCache<SearchPayload>;
	private readonly fetchCache: TtlCache<FetchPayload>;

	constructor(deps: SearchDeps) {
		this.deps = deps;
		this.searchCache = new TtlCache(deps.cacheTtlMs);
		this.fetchCache = new TtlCache(deps.cacheTtlMs);
	}

	/** Cached entry count, for the status command. */
	get cacheSize(): number {
		return this.searchCache.size + this.fetchCache.size;
	}

	clearCache(): void {
		this.searchCache.clear();
		this.fetchCache.clear();
	}

	async search(request: SearchRequest, signal?: AbortSignal): Promise<SearchOutcome> {
		throwIfAborted(signal);
		const query = request.query.trim();
		const numResults = clampNumResults(request.numResults);
		const allowedDomains = cleanDomains(request.allowedDomains);
		const blockedDomains = cleanDomains(request.blockedDomains);
		const cacheKey = JSON.stringify({ query, numResults, allowedDomains, blockedDomains });

		const cached = this.searchCache.get(cacheKey);
		if (cached !== undefined) {
			return {
				text: renderSearchText(cached.value, query),
				sources: cached.value.sources,
				numResults,
				elapsedMs: 0,
				cached: true,
				cacheAgeMs: cached.ageMs,
				account: undefined,
			};
		}

		const startedAt = Date.now();
		const { payload, account } = await this.withAccount(async (key, slotId) => {
			const body = buildSearchBody({ query, numResults, allowedDomains, blockedDomains });
			const response = await this.post(SEARCH_ROUTE, body, key, signal);
			return { payload: parseSearchPayload(response), account: slotId };
		}, signal);

		this.searchCache.set(cacheKey, payload);
		return {
			text: renderSearchText(payload, query),
			sources: payload.sources,
			numResults,
			elapsedMs: Date.now() - startedAt,
			cached: false,
			cacheAgeMs: undefined,
			account,
		};
	}

	async fetchPage(request: { url: string; maxChars?: number }, signal?: AbortSignal): Promise<FetchOutcome> {
		throwIfAborted(signal);
		const url = request.url.trim();
		const maxChars = request.maxChars ?? this.deps.maxContentChars();
		const cached = this.fetchCache.get(url);

		const startedAt = Date.now();
		let payload: FetchPayload;
		let account: string | undefined;
		if (cached !== undefined) {
			payload = cached.value;
		} else {
			const result = await this.withAccount(async (key, slotId) => {
				const response = await this.post(FETCH_ROUTE, buildFetchBody(url), key, signal);
				return { payload: parseFetchPayload(response), account: slotId };
			}, signal);
			payload = result.payload;
			account = result.account;
			this.fetchCache.set(url, payload);
		}

		const { text, truncated } = truncateContent(payload.content, maxChars);
		return {
			text,
			url: payload.url ?? url,
			status: payload.status,
			truncated,
			elapsedMs: Date.now() - startedAt,
			cached: cached !== undefined,
			cacheAgeMs: cached?.ageMs,
			account,
		};
	}

	/**
	 * Run one request against the first usable account, rotating on a 401 or
	 * a 429 exactly the way the model transport does.
	 */
	private async withAccount<T>(
		run: (key: string, slotId: string) => Promise<{ payload: T; account?: string }>,
		signal?: AbortSignal,
	): Promise<{ payload: T; account: string | undefined }> {
		const attempts = Math.max(1, this.deps.maxAccountAttempts ?? 3);
		let excluded: string | undefined;
		let last: CommandCodeSearchError | undefined;
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			throwIfAborted(signal);
			const account = await this.deps.resolveAccount(excluded !== undefined ? { exclude: excluded } : undefined);
			if (account === undefined) {
				throw new CommandCodeSearchError(
					"no-key",
					"Command Code：未找到可用的 API 密钥；no Command Code API key found",
					{ hint: hintFor("no-key") },
				);
			}
			try {
				const result = await run(account.key, account.slotId);
				return { payload: result.payload, account: result.account ?? account.slotId };
			} catch (error) {
				if (
					error instanceof CommandCodeSearchError &&
					(error.kind === "invalid-key" || error.kind === "rate-limit")
				) {
					this.deps.markRejected(account.key, error.kind === "invalid-key" ? "invalid-credential" : "rate-limit");
					excluded = account.key;
					last = error;
					continue;
				}
				throw error;
			}
		}
		throw (
			last ??
			new CommandCodeSearchError("no-key", "Command Code：没有可用账户；no usable Command Code account", {
				hint: hintFor("no-key"),
			})
		);
	}

	/** One authenticated POST, classified on failure. */
	private async post(route: string, body: Record<string, unknown>, key: string, signal?: AbortSignal): Promise<unknown> {
		throwIfAborted(signal);
		const base = this.deps.apiBase().replace(/\/+$/, "");
		if (!URL.canParse(base)) {
			throw new CommandCodeSearchError("protocol", `commandcode.apiBase 不是合法 URL：${this.deps.apiBase()}`);
		}
		const timeoutMs = this.deps.timeoutMs();
		const controller = new AbortController();
		// Deliberately NOT unref'd: the timeout is the only thing guaranteeing
		// that a stalled request settles, and it is always cleared in `finally`.
		const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
		const forwardAbort = () => controller.abort();
		signal?.addEventListener("abort", forwardAbort, { once: true });

		try {
			let response: Response;
			try {
				response = await (this.deps.fetchImpl ?? fetch)(`${base}${route}`, {
					method: "POST",
					// The CLI's own first-party header set, so the gateway treats
					// this exactly like the client's built-in web tool.
					headers: cliHeaders(key, this.deps.workingDir(), this.deps.cliVersion()),
					body: JSON.stringify(body),
					signal: controller.signal,
				});
			} catch (error) {
				if (signal?.aborted === true) {
					throw new CommandCodeSearchError("aborted", "Command Code 请求已取消；request aborted");
				}
				if (controller.signal.aborted) {
					throw new CommandCodeSearchError("timeout", `Command Code 请求超时（${timeoutMs}ms）`, {
						hint: hintFor("timeout"),
						cause: error,
					});
				}
				throw new CommandCodeSearchError(
					"network",
					`无法连接 Command Code：${error instanceof Error ? error.message : String(error)}`,
					{ hint: hintFor("network"), cause: error },
				);
			}

			const bodyText = await response.text().catch(() => "");
			if (!response.ok) {
				const kind = classifyHttpStatus(response.status, bodyText);
				const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
				throw new CommandCodeSearchError(kind, commandCodeErrorMessage(response.status, bodyText), {
					status: response.status,
					hint: hintFor(kind, bodyText, retryAfterMs),
				});
			}
			try {
				return JSON.parse(bodyText) as unknown;
			} catch (error) {
				throw new CommandCodeSearchError("protocol", "Command Code 返回了无法解析的响应体", { cause: error });
			}
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", forwardAbort);
		}
	}
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const SEARCH_PARAMETERS = Type.Object({
	query: Type.String({
		description:
			"Search query or question to look up on the live web. Natural language is fine; write it in the language you want the results in.",
	}),
	num_results: Type.Optional(
		Type.Number({ description: "How many results to ask for (1–10). Default: 5. Values above 10 are rejected by the server." }),
	),
	allowed_domains: Type.Optional(
		Type.Array(Type.String(), {
			description: "Restrict results to these domains (e.g. [\"docs.rs\", \"github.com\"]). Omit to search the whole web.",
		}),
	),
	blocked_domains: Type.Optional(
		Type.Array(Type.String(), { description: "Never return results from these domains." }),
	),
});

const FETCH_PARAMETERS = Type.Object({
	url: Type.String({ description: "Absolute http(s) URL to read." }),
	max_chars: Type.Optional(
		Type.Number({ description: "Maximum characters to return. Default: 20000. The server sends the whole page, so this truncates client-side." }),
	),
});

type SearchParams = Static<typeof SEARCH_PARAMETERS>;
type FetchParams = Static<typeof FETCH_PARAMETERS>;

const text = (value: string) => [{ type: "text" as const, text: value }];

/** Whether the active provider already searches server-side. */
function nativeSearchNote(ctx: ExtensionToolContext | undefined): string | undefined {
	const provider = ctx?.model?.provider;
	if (provider === undefined) return undefined;
	const extra = readSettings().search?.nativeSearchProviders;
	const providers = extra ?? NATIVE_SEARCH_PROVIDERS;
	if (!providers.includes(provider)) return undefined;
	return (
		`跳过：当前 provider（${provider}）已在服务端自带原生联网搜索，直接回答即可，无需再调用本工具。` +
		`Skipped: the current provider already runs a server-side web search.`
	);
}

export default function (pi: ExtensionAPI) {
	const settings = readSettings();
	const search = settings.search ?? {};
	const searchTool = (search.toolName ?? "").trim() || DEFAULT_SEARCH_TOOL;
	const fetchTool = (search.fetchToolName ?? "").trim() || DEFAULT_FETCH_TOOL;
	const searchEnabled = search.enabled ?? true;
	const fetchEnabled = search.fetchEnabled ?? true;
	const activeByDefault = search.activeByDefault ?? true;

	/** Resolved once on first use, so startup never waits on the npm registry. */
	let cliVersion = COMMAND_CODE_CLI_VERSION;
	let versionProbe: Promise<void> | undefined;
	const ensureCliVersion = (): Promise<void> => {
		versionProbe ??= fetchCliVersion()
			.then((version) => {
				if (version !== undefined) cliVersion = version;
			})
			.catch(() => undefined);
		return versionProbe;
	};

	const apiBase = () => readSettings().apiBase ?? DEFAULT_API_BASE;
	const workingDir = () => readSettings().workingDir ?? process.cwd();
	const usageClient = new UsageClient(apiBase, () => cliVersion);
	const pool = new AccountPool(
		() => slotsFromConfig(readSettings().accounts, readSettings().apiKeyEnv ?? "COMMANDCODE_API_KEY", "默认账户"),
		() => readSettings().activeAccount,
		(key) => usageClient.probeFiveHourWindow(key),
		() => readSettings().modelAccountRules ?? [],
	);

	const client = new SearchClient({
		apiBase,
		cliVersion: () => cliVersion,
		workingDir,
		resolveAccount: async (options) => {
			const account = await pool.resolveKey(options);
			return account === undefined ? undefined : { key: account.key, slotId: account.slot.id };
		},
		markRejected: (key, rejection) => pool.markRejected(key, rejection),
		cacheTtlMs: () => readSettings().search?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
		timeoutMs: () => readSettings().search?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		maxContentChars: () => readSettings().search?.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS,
	});

	/** Last call, for `/commandcode-search`. */
	let lastCall: { tool: string; ok: boolean; detail: string; at: number } | undefined;

	if (searchEnabled) {
		pi.registerTool({
			name: searchTool,
			label: "Command Code 联网检索",
			description:
				"Search the live web through your Command Code subscription, using the same API key as the model. " +
				"Returns real search results — titles, URLs and snippets — from Command Code's search backend. " +
				"Fast (typically 1–5s) and read-only. This is raw retrieval, not a synthesized answer: " +
				`follow up with \`${fetchTool}\` (or web_fetch) to read a promising URL in full. ` +
				"Use it for anything time-sensitive or checkable: releases, versions, prices, availability, dates, " +
				"people and company facts, docs you do not already have a URL for.",
			promptSnippet: `${searchTool}: live web search via Command Code — raw results with citable URLs (fast, needs no extra key)`,
			promptGuidelines: [
				`Prefer \`${searchTool}\` when you need current information or a source URL; it returns the sources themselves and is much faster than a synthesis-style search.`,
				`After \`${searchTool}\`, read the one or two most relevant results with \`${fetchTool}\` instead of searching again.`,
			],
			parameters: SEARCH_PARAMETERS,
			defaultActive: activeByDefault,
			annotations: { readOnlyHint: true, openWorldHint: true },
			async execute(_id, params: SearchParams, signal, onUpdate, ctx) {
				const query = params.query?.trim();
				if (!query) {
					return { content: text(`${searchTool}: query 不能为空`), details: { error: "empty-query" }, isError: true };
				}
				const skipped = nativeSearchNote(ctx);
				if (skipped !== undefined) {
					return { content: text(skipped), details: { skipped: true, reason: "provider-has-native-search" } };
				}

				const configured = readSettings().search;
				await ensureCliVersion();
				onUpdate?.({ content: text(`Command Code 联网检索中…「${query}」`), details: { query } });

				const startedAt = Date.now();
				try {
					const outcome = await client.search(
						{
							query,
							numResults: params.num_results ?? configured?.numResults,
							allowedDomains: params.allowed_domains ?? configured?.allowedDomains,
							blockedDomains: params.blocked_domains ?? configured?.blockedDomains,
						},
						signal,
					);
					lastCall = {
						tool: searchTool,
						ok: true,
						detail: `${outcome.sources.length} 条结果 / ${(outcome.elapsedMs / 1000).toFixed(1)}s${outcome.cached ? "（缓存）" : ""}`,
						at: Date.now(),
					};
					return {
						content: text(outcome.text),
						details: {
							query,
							numResults: outcome.numResults,
							results: outcome.sources,
							count: outcome.sources.length,
							elapsedMs: outcome.elapsedMs,
							cached: outcome.cached,
							cacheAgeMs: outcome.cacheAgeMs,
							account: outcome.account,
						},
					};
				} catch (error) {
					const { text: message, kind } = describeSearchError(error);
					lastCall = { tool: searchTool, ok: false, detail: `${kind}: ${message.split("\n")[0]}`, at: Date.now() };
					return {
						content: text(`${searchTool} 失败：${message}`),
						details: { query, error: kind, elapsedMs: Date.now() - startedAt },
						isError: true,
					};
				}
			},
		});
	}

	if (fetchEnabled) {
		pi.registerTool({
			name: fetchTool,
			label: "Command Code 网页抓取",
			description:
				"Fetch one URL and get its text back, rendered server-side by Command Code (HTML converted to readable " +
				"markdown-style text). Uses the same subscription key as the model. More reliable than a local fetch for " +
				"JavaScript-heavy, gated or oddly encoded pages, and it never exposes your network to the site. " +
				"Read-only; one URL per call.",
			promptSnippet: `${fetchTool}: read one URL as clean text via Command Code (server-side fetch)`,
			promptGuidelines: [
				`Use \`${fetchTool}\` to read a concrete URL — typically a result of \`${searchTool}\` — instead of re-searching.`,
			],
			parameters: FETCH_PARAMETERS,
			defaultActive: activeByDefault,
			annotations: { readOnlyHint: true, openWorldHint: true },
			async execute(_id, params: FetchParams, signal, onUpdate) {
				const url = params.url?.trim();
				if (!url) {
					return { content: text(`${fetchTool}: url 不能为空`), details: { error: "empty-url" }, isError: true };
				}
				let parsed: URL;
				try {
					parsed = new URL(url);
				} catch {
					return { content: text(`${fetchTool}: 不是合法的 URL：${url}`), details: { error: "bad-url" }, isError: true };
				}
				if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
					return {
						content: text(`${fetchTool}: 只支持 http(s) URL（收到 ${parsed.protocol}）`),
						details: { error: "bad-scheme" },
						isError: true,
					};
				}

				await ensureCliVersion();
				onUpdate?.({ content: text(`Command Code 抓取中…${url}`), details: { url } });
				try {
					const outcome = await client.fetchPage({ url, maxChars: params.max_chars }, signal);
					lastCall = {
						tool: fetchTool,
						ok: true,
						detail: `${outcome.text.length} 字符${outcome.truncated ? "（已截断）" : ""}${outcome.cached ? "（缓存）" : ""}`,
						at: Date.now(),
					};
					return {
						content: text(outcome.text),
						details: {
							url: outcome.url,
							status: outcome.status,
							chars: outcome.text.length,
							truncated: outcome.truncated,
							cached: outcome.cached,
							cacheAgeMs: outcome.cacheAgeMs,
						},
					};
				} catch (error) {
					const { text: message, kind } = describeSearchError(error);
					lastCall = { tool: fetchTool, ok: false, detail: `${kind}: ${message.split("\n")[0]}`, at: Date.now() };
					return {
						content: text(`${fetchTool} 失败：${message}`),
						details: { url, error: kind },
						isError: true,
					};
				}
			},
		});
	}

	// ---------------------------------------------------------------------
	// /commandcode-search
	// ---------------------------------------------------------------------
	const toolNames = [searchEnabled ? searchTool : undefined, fetchEnabled ? fetchTool : undefined].filter(
		(name): name is string => name !== undefined,
	);

	const statusLines = (): string[] => {
		const configured = readSettings().search ?? {};
		const active = new Set(pi.getActiveTools());
		return [
			"Command Code 联网检索",
			`  注册:          ${searchEnabled ? `是（${searchTool}）` : "否（settings 中 commandcode.search.enabled=false）"}`,
			`  网页抓取:      ${fetchEnabled ? `是（${fetchTool}）` : "否"}`,
			`  会话内激活:    ${toolNames.map((name) => `${name}=${active.has(name) ? "开" : "关"}`).join(" · ") || "无"}`,
			`  端点:          ${apiBase()}${SEARCH_ROUTE} · ${FETCH_ROUTE}`,
			`  默认结果数:    ${clampNumResults(configured.numResults)}（1–10）`,
			`  缓存:          ${client.cacheSize} 条 / TTL ${(configured.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS) / 1000}s`,
			`  最近调用:      ${
				lastCall === undefined
					? "尚未调用"
					: `${lastCall.tool} ${lastCall.ok ? "成功" : "失败"} · ${lastCall.detail} · ${new Date(lastCall.at).toLocaleTimeString()}`
			}`,
			"用法: /commandcode-search on | off | fetch on | fetch off | status",
		];
	};

	/** Activate or deactivate one tool for this session. */
	const setToolActive = (name: string, on: boolean): boolean => {
		if (!toolNames.includes(name)) return false;
		const active = pi.getActiveTools();
		if (on) {
			if (!active.includes(name)) pi.setActiveTools([...active, name]);
		} else {
			pi.setActiveTools(active.filter((entry) => entry !== name));
		}
		return true;
	};

	pi.registerCommand("commandcode-search", {
		description: "查看 / 切换 Command Code 联网检索与网页抓取工具",
		handler: async (args, ctx) => {
			const [first = "", second = ""] = args.trim().toLowerCase().split(/\s+/);
			if (first === "status" || first === "") {
				ctx.ui.notify(statusLines().join("\n"), "info");
				return;
			}
			if (first === "clear" || first === "cache") {
				client.clearCache();
				ctx.ui.notify("Command Code 联网检索缓存已清空。", "info");
				return;
			}
			if (first === "fetch" && (second === "on" || second === "off")) {
				if (!setToolActive(fetchTool, second === "on")) {
					ctx.ui.notify(`网页抓取工具未注册（commandcode.search.fetchEnabled=false）`, "warning");
					return;
				}
				ctx.ui.notify(`${fetchTool} 已${second === "on" ? "启用" : "停用"}（本会话）`, "info");
				return;
			}
			if (first === "on" || first === "off") {
				const touched = toolNames.filter((name) => setToolActive(name, first === "on"));
				ctx.ui.notify(
					touched.length > 0
						? `${touched.join("、")} 已${first === "on" ? "启用" : "停用"}（本会话）`
						: "没有已注册的联网工具可切换：检查 commandcode.search.enabled / fetchEnabled",
					touched.length > 0 ? "info" : "warning",
				);
				return;
			}
			ctx.ui.notify(statusLines().join("\n"), "info");
		},
	});
}
