/**
 * Wire types and pure helpers for the Command Code API.
 *
 * Two transports are modelled here, mirroring the official `command-code`
 * CLI (command-code@1.53.0):
 *
 *  - `openai` — the documented Provider API
 *    (`POST {base}/provider/v1/chat/completions`). Flat OpenAI Chat
 *    Completions body, `text/event-stream` SSE reply.
 *  - `cli` — the CLI gateway (`POST {base}/alpha/generate`). The CLI's own
 *    envelope (`{config, memory, taste, skills, params, threadId}`), NDJSON
 *    reply.
 *
 * The `cli` transport exists here for one reason: **Command Code withholds
 * Provider API access from the Go plan** ("every plan except the Go plan has
 * API access"). A Go account gets HTTP 403 `upgrade_required` on
 * `/provider/v1/*`, so `/alpha/generate` is the only route that serves it.
 */

/** The one API id this plugin owns; models are registered under it. */
export const COMMANDCODE_API = "commandcode-api";

/** Default API origin. Overridable so a self-hosted reverse proxy can be used. */
export const DEFAULT_API_BASE = "https://api.commandcode.ai";

/** Which wire protocol a request used. */
export type Transport = "openai" | "cli";

/**
 * The CLI version stamped into `x-command-code-version`. Kept in sync with
 * the released `command-code` CLI: the gateway gates on it, and an outdated
 * value is refused with `403 upgrade_required` — the same code as the Go-plan
 * gate, which is why {@link isCliOutOfDateError} exists to tell them apart.
 *
 * This is only the fallback used before the live value is resolved;
 * `index.ts` refreshes it from the npm registry at startup.
 */
export const COMMAND_CODE_CLI_VERSION = "1.53.0";

/** The npm package whose released version this header must track. */
export const COMMAND_CODE_PACKAGE = "command-code";

/** `/alpha/generate` accepts at most this many output tokens. */
export const CLI_MAX_OUTPUT_TOKENS = 64_000;

/** Catalog ceiling for a model's `maxTokens` when the entry omits one. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 65_536;

/** Hard cap on account rotations inside one request (one attempt per key). */
export const MAX_ACCOUNT_ROTATIONS = 16;

/** Timeout for the catalog/usage endpoints, which should answer quickly. */
export const CONTROL_TIMEOUT_MS = 10_000;

/** How long a resolved protocol decision is trusted before re-probing. */
export const PROTOCOL_CACHE_TTL_MS = 15 * 60_000;

/** How long the billing tier behind the picker filter stays cached. */
export const BILLING_ACCESS_TTL_MS = 5 * 60_000;

/** The entry tier: a `go` subscription has no Provider API access. */
export const GO_TIER_WEIGHT = 0;

/** Subscription statuses that grant the plan's tier (the CLI's rule). */
export const ACTIVE_SUBSCRIPTION_STATUSES = new Set([
	"active",
	"trialing",
	"past_due",
	"incomplete",
	"paused",
]);

// ---------------------------------------------------------------------------
// SSE / NDJSON parsing
// ---------------------------------------------------------------------------

/**
 * Parse one line of a streamed response into a JSON event, or `undefined`
 * for lines that carry no payload (blanks, `:` comments, `event:` names,
 * `data: [DONE]`). Both transports frame events one per line, so a single
 * parser serves the CLI's NDJSON and the Provider API's SSE.
 */
export function parseStreamLine(line: string): Record<string, unknown> | undefined {
	let trimmed = line.trim();
	if (!trimmed || trimmed.startsWith(":") || trimmed.startsWith("event:")) return undefined;
	if (trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim();
	if (!trimmed || trimmed === "[DONE]") return undefined;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function booleanValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

// ---------------------------------------------------------------------------
// HTTP errors
// ---------------------------------------------------------------------------

/**
 * True when a 403 is Command Code refusing an OUTDATED CLI, not refusing the
 * plan. The gateway reports both conditions with `error.code ===
 * "upgrade_required"`, so the two must be told apart by their text: this one
 * carries a `minVersion` and tells the user to update.
 *
 * The distinction matters twice over. Retrying the other transport cannot
 * help a version problem, so this must NOT trigger the Go-plan fallback; and
 * the user needs "update the client", not "your plan lacks API access".
 */
export function isCliOutOfDateError(bodyText: string): boolean {
	const lower = bodyText.toLowerCase();
	if (lower.includes("out of date") || lower.includes("minversion")) return true;
	if (lower.includes("cmd update") || lower.includes("npm i -g command-code")) return true;
	return false;
}

/**
 * True when a Provider API rejection is Command Code's Go-plan gate. Only
 * this exact class of 403 should fall back to the CLI transport; treating
 * every 403 as "try the CLI" would mask real plan/model errors.
 *
 * The gateway has spelled this several ways over time, so both the
 * machine-readable `error.code` and the human messages are matched. An
 * outdated-CLI rejection is explicitly excluded: it shares the
 * `upgrade_required` code but is a client-version problem that switching
 * transports would only reproduce.
 */
export function isUpgradeRequiredError(status: number, bodyText: string): boolean {
	if (status !== 403) return false;
	if (isCliOutOfDateError(bodyText)) return false;
	const lower = bodyText.toLowerCase();
	if (lower.includes("upgrade_required")) return true;
	if (lower.includes("go plan") && lower.includes("api access")) return true;
	if (lower.includes("only plan without api access")) return true;
	if (lower.includes("upgrade to goat or higher")) return true;
	try {
		const parsed: unknown = JSON.parse(bodyText);
		if (isRecord(parsed)) {
			const error = isRecord(parsed.error) ? parsed.error : parsed;
			const code = (stringValue(error.code) ?? stringValue(error.type))?.toLowerCase();
			if (code === "upgrade_required") return true;
			const message = (stringValue(error.message) ?? "").toLowerCase();
			if (message.includes("go plan") && message.includes("api access")) return true;
		}
	} catch {
		// Not JSON — the substring checks above already had their chance.
	}
	return false;
}

/**
 * A pre-stream HTTP rejection from either transport, carrying the facts the
 * rotation loop and the error message need.
 */
export class CommandCodeHttpError extends Error {
	readonly status: number;
	readonly bodyText: string;
	readonly retryAfterMs: number | undefined;

	constructor(status: number, bodyText: string, retryAfterMs?: number) {
		super(commandCodeErrorMessage(status, bodyText));
		this.name = "CommandCodeHttpError";
		this.status = status;
		this.bodyText = bodyText;
		this.retryAfterMs = retryAfterMs;
	}
}

/**
 * Build the user-facing message for a failed Command Code request. Prefers
 * the machine-readable `error.code` when the gateway supplies one, because
 * a bare status cannot distinguish plan limits from a bad key.
 */
export function commandCodeErrorMessage(status: number, bodyText: string): string {
	let providerCode: string | undefined;
	try {
		const parsed: unknown = JSON.parse(bodyText);
		if (isRecord(parsed)) {
			const error = isRecord(parsed.error) ? parsed.error : undefined;
			providerCode = stringValue(error?.code);
		}
	} catch {
		// Body is not JSON; fall back to the status alone.
	}
	const detail = providerCode ?? `HTTP ${status}`;
	if (status === 401) {
		return `Command Code API 返回 401（${detail}）：API 密钥缺失或无效 —— 请用 /commandcode-login 重新登录，或检查 ~/.commandcode/auth.json；Command Code API returned 401 (${detail}): the API key is missing or invalid`;
	}
	if (status === 403 && isCliOutOfDateError(bodyText)) {
		const minVersion = /"minVersion"\s*:\s*"([^"]+)"/.exec(bodyText)?.[1];
		return (
			`Command Code 拒绝了过期客户端：${bodyText.slice(0, 200)}` +
			(minVersion ? `（网关要求至少 ${minVersion}）` : "") +
			"；Command Code rejected this plugin as outdated — update the CLI version header or install a newer command-code"
		);
	}
	if (status === 403) {
		return `Command Code API 返回 403（${detail}）：套餐无权访问该模型或该端点（Go 套餐不含 Provider API，会自动改用 CLI 传输）；Command Code API returned 403 (${detail}): the plan cannot access this model or endpoint — ${bodyText.slice(0, 300)}`;
	}
	if (status === 429) {
		return `Command Code API 返回 429（${detail}）：已达用量/速率限额，窗口重置后会自动恢复；Command Code API returned 429 (${detail}): usage or rate limit reached — ${bodyText.slice(0, 300)}`;
	}
	return `Command Code API 错误 ${status}${detail === `HTTP ${status}` ? "" : `（${detail}）`}：${bodyText.slice(0, 500)}`;
}

/**
 * Parse an HTTP `Retry-After` value (delay-seconds or HTTP-date) into
 * milliseconds. Returns `undefined` when absent or unparseable; a date in
 * the past yields 0, which callers drop because a retry delay must be > 0.
 */
export function parseRetryAfterMs(value: string | null, now = Date.now()): number | undefined {
	if (value === null) return undefined;
	const trimmed = value.trim();
	if (trimmed === "") return undefined;
	const seconds = Number(trimmed);
	if (Number.isFinite(seconds) && seconds >= 0) {
		const ms = seconds * 1_000;
		return Number.isFinite(ms) ? Math.round(ms) : undefined;
	}
	const date = Date.parse(trimmed);
	if (!Number.isNaN(date)) return Math.max(0, date - now);
	return undefined;
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

/** Facts both body builders need, resolved once per request. */
export interface RequestFacts {
	maxTokens: number;
	reasoningEffort: string | undefined;
	systemText: string;
	workingDir: string;
}

/** CLI wire message: content parts plus the tool-call/tool-result shapes. */
export type CliMessage =
	| { role: "user"; content: unknown[] }
	| { role: "assistant"; content: unknown[] }
	| { role: "tool"; content: unknown[] };

/** OpenAI wire message. */
export type OpenAiMessage = Record<string, unknown>;

/**
 * Build the legacy CLI (`/alpha/generate`) request body. The `config` block
 * mirrors what the real CLI reports; `x-project-slug` and the config fields
 * are what make the gateway treat this as first-party traffic, which is
 * exactly what the Go plan is entitled to.
 */
export function buildCliBody(
	model: string,
	messages: CliMessage[],
	tools: { name: string; description: string; parameters: unknown }[],
	facts: RequestFacts,
	threadId: string,
): Record<string, unknown> {
	return {
		config: {
			workingDir: facts.workingDir,
			date: new Date().toISOString().split("T")[0],
			environment: `${process.platform}-${process.arch}, Node.js ${process.version}`,
			structure: [],
			isGitRepo: false,
			currentBranch: "",
			mainBranch: "",
			gitStatus: "",
			recentCommits: [],
		},
		memory: null,
		taste: null,
		skills: null,
		params: {
			model,
			messages,
			tools: tools.map((tool) => ({
				type: "function",
				name: tool.name,
				description: tool.description,
				input_schema: tool.parameters,
			})),
			system: facts.systemText,
			max_tokens: facts.maxTokens,
			temperature: 0.3,
			stream: true,
			...(facts.reasoningEffort ? { reasoning_effort: facts.reasoningEffort } : {}),
		},
		threadId,
	};
}

/** Build the documented Provider API Chat Completions body. */
export function buildOpenAiBody(
	model: string,
	systemText: string,
	messages: OpenAiMessage[],
	tools: { name: string; description: string; parameters: unknown }[],
	facts: RequestFacts,
): Record<string, unknown> {
	return {
		model,
		messages: [...(systemText ? [{ role: "system", content: systemText }] : []), ...messages],
		...(tools.length > 0
			? {
					tools: tools.map((tool) => ({
						type: "function",
						function: {
							name: tool.name,
							description: tool.description,
							parameters: tool.parameters,
						},
					})),
				}
			: {}),
		max_tokens: facts.maxTokens,
		temperature: 0.3,
		stream: true,
		...(facts.reasoningEffort ? { reasoning_effort: facts.reasoningEffort } : {}),
	};
}

/**
 * Header set for the CLI transport. Mirrors the real CLI so the gateway
 * accepts the request as first-party (this is what makes Go work).
 *
 * `cliVersion` is passed in rather than read from the constant so the caller
 * can supply a version refreshed from npm — a stale value here is refused by
 * the gateway with an `upgrade_required` 403.
 */
export function cliHeaders(
	apiKey: string,
	workingDir: string,
	cliVersion: string = COMMAND_CODE_CLI_VERSION,
): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${apiKey}`,
		"x-command-code-version": cliVersion,
		"x-cli-environment": "production",
		"x-project-slug": projectSlugFromPath(workingDir),
		"x-taste-learning": "true",
		"x-co-flag": "false",
	};
}

/** Header set for the Provider API transport. */
export function openAiHeaders(apiKey: string): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${apiKey}`,
		Accept: "text/event-stream",
	};
}

/**
 * Derive a stable `x-project-slug` from a working directory, the way the
 * CLI does: the last path segment, lowercased, non-alphanumerics collapsed
 * to single dashes. Falls back to `project` for a path with no usable tail.
 */
export function projectSlugFromPath(pathName: string): string {
	const tail = pathName.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
	const slug = tail
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "project";
}

/**
 * The endpoint a transport POSTs to. Splitting this out keeps the URL shape
 * in one place, since `apiBase` is user-configurable for reverse proxies.
 */
export function endpointFor(transport: Transport, apiBase: string): string {
	const base = apiBase.replace(/\/+$/, "");
	return transport === "cli" ? `${base}/alpha/generate` : `${base}/provider/v1/chat/completions`;
}

/** Map a provider finish reason onto pi's `StopReason`. */
export function mapFinishReason(reason: string | undefined): "stop" | "length" | "toolUse" {
	if (reason === "tool-calls" || reason === "tool_calls" || reason === "tool_use") return "toolUse";
	if (
		reason === "length" ||
		reason === "max_tokens" ||
		reason === "max-tokens" ||
		reason === "max_output_tokens"
	) {
		return "length";
	}
	return "stop";
}

/**
 * Fetch the released `command-code` version from the npm registry.
 *
 * The gateway compares `x-command-code-version` against a minimum and
 * refuses stale clients, so hardcoding this constant would silently break
 * every CLI-transport request (including all Go-plan traffic) after the next
 * Command Code release. Resolving it at startup removes that time bomb;
 * callers fall back to the built-in constant when the lookup fails.
 */
export async function fetchCliVersion(timeoutMs = CONTROL_TIMEOUT_MS): Promise<string | undefined> {
	try {
		const response = await fetch(`https://registry.npmjs.org/${COMMAND_CODE_PACKAGE}/latest`, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) return undefined;
		const parsed: unknown = await response.json();
		const version = isRecord(parsed) ? stringValue(parsed.version) : undefined;
		return version !== undefined && /^\d+\.\d+\.\d+/.test(version) ? version : undefined;
	} catch {
		return undefined;
	}
}
