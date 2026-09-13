/**
 * Credential resolution and multi-account rotation for Command Code.
 *
 * One account is the common case; several Go subscriptions (each with its
 * own 5-hour window) are the reason this exists. Rotation state is keyed by
 * the *resolved key* rather than by slot, so two slots pointing at the same
 * credential share one mark, and changing a key in a settings file starts
 * that account with a clean slate.
 *
 * Credential precedence for a slot: literal key → environment variable →
 * (default slot only) the official CLI's `~/.commandcode/auth.json`.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord, stringValue } from "./wire.ts";

/** One resolvable account slot. */
export interface AccountSlot {
	/** Stable id used in config and status output. */
	id: string;
	/** Human label shown in the status panel. */
	label: string;
	/** Literal key from config. */
	apiKey?: string;
	/** Environment variable holding the key. */
	apiKeyEnv?: string;
	/** Whether `~/.commandcode/auth.json` may supply this slot's key. */
	allowAuthFile: boolean;
}

/** How a key was last judged by the gateway. */
export type AccountState =
	| { kind: "disabled"; reason: string }
	| { kind: "cooldown"; reason: string; until: number }
	| { kind: "unknown"; reason: string };

/** A slot paired with its resolved key and rotation state. */
export interface ResolvedAccount {
	slot: AccountSlot;
	key: string;
	state: AccountState | undefined;
}

/** One configured account as written in the config file. */
export interface AccountConfig {
	label?: string;
	apiKey?: string;
	apiKeyEnv?: string;
}

/** One slot's key: literal → environment → pi's store → CLI auth file. */
/**
 * Read a credential pi itself stored for this provider, from
 * `~/.pi/agent/auth.json`. Browser login writes here through pi's own OAuth
 * mechanism, so without this source a freshly logged-in account would be
 * invisible to the pool (which resolves keys independently).
 */
export function resolvePiStoredKey(providerId: string): string | undefined {
	const authPath = join(homedir(), ".pi", "agent", "auth.json");
	try {
		if (!existsSync(authPath)) return undefined;
		const parsed: unknown = JSON.parse(readFileSync(authPath, "utf-8"));
		if (!isRecord(parsed)) return undefined;
		const record = parsed[providerId];
		if (!isRecord(record)) return undefined;
		// `key` for an api_key credential, `access` for an OAuth one.
		return stringValue(record.key) ?? stringValue(record.access);
	} catch {
		return undefined;
	}
}

/**
 * Read the API key out of the official CLI's auth file. The CLI has used
 * several shapes over time (`apiKey`, a nested `{type,key}` record under
 * `commandcode` / `command-code`), so each is accepted.
 */
export function resolveAuthFileApiKey(): string | undefined {
	const authPath = join(homedir(), ".commandcode", "auth.json");
	try {
		if (!existsSync(authPath)) return undefined;
		const parsed: unknown = JSON.parse(readFileSync(authPath, "utf-8"));
		if (!isRecord(parsed)) return undefined;
		const direct = stringValue(parsed.apiKey) ?? stringValue(parsed.commandcode);
		if (direct) return direct;
		return (
			apiKeyFromCredentialRecord(parsed.commandcode) ?? apiKeyFromCredentialRecord(parsed["command-code"])
		);
	} catch {
		return undefined;
	}
}

/** Extract the key from the CLI's nested credential records. */
function apiKeyFromCredentialRecord(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	const type = stringValue(value.type);
	if (type === "api") return stringValue(value.key);
	if (type === "oauth") return stringValue(value.access);
	return stringValue(value.key) ?? stringValue(value.access);
}

/**
 * Normalize a resolved credential. Only whitespace is trimmed: a value that
 * is blank after trimming means "no key", while characters an HTTP header
 * cannot carry are left for the request to reject with its own message.
 */
export function normalizeKey(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

/**
 * Whether a stored state lets the account serve a request right now.
 *
 * `unknown` (a 429 with no reset time yet) counts as NOT usable. That is
 * deliberate: without it, the next request would pick the exhausted account
 * again and waste a round-trip before rotating, so a multi-account setup
 * would only fail over *within* a request rather than across requests. The
 * revival probe in {@link AccountPool.resolveKey} is what brings an account
 * back once its window actually resets.
 */
export function accountUsable(state: AccountState | undefined): boolean {
	if (state === undefined) return true;
	if (state.kind === "disabled" || state.kind === "unknown") return false;
	return state.until === 0 || state.until <= Date.now();
}

/**
 * Pick the account to use: the configured preferred one when usable,
 * otherwise the first usable account in rotation order.
 */
export function selectActiveAccount(
	accounts: ResolvedAccount[],
	preferredId: string | undefined,
): ResolvedAccount | undefined {
	const usable = accounts.filter((account) => accountUsable(account.state));
	if (usable.length === 0) return undefined;
	if (preferredId !== undefined) {
		const preferred = usable.find((account) => account.slot.id === preferredId);
		if (preferred !== undefined) return preferred;
	}
	return usable[0];
}

/** One per-model account rule: models routed to a specific account. */
export interface ModelAccountRule {
	/** Catalog model ids this rule matches. */
	models: string[];
	/** Slot id to route them to. */
	account: string;
}

/** The first rule matching a model, or undefined when none does. */
export function matchModelRule(model: string, rules: ModelAccountRule[]): ModelAccountRule | undefined {
	return rules.find((rule) => rule.models.includes(model));
}

/**
 * The account a model is pinned to, when a rule matches AND that account is
 * usable. A pinned account that is exhausted falls through to normal
 * rotation rather than failing the request.
 */
export function selectAccountForModel(
	accounts: ResolvedAccount[],
	model: string,
	rules: ModelAccountRule[],
): ResolvedAccount | undefined {
	const rule = matchModelRule(model, rules);
	if (rule === undefined) return undefined;
	const pinned = accounts.find((account) => account.slot.id === rule.account);
	if (pinned === undefined || !accountUsable(pinned.state)) return undefined;
	return pinned;
}

/**
 * The account pool. Holds the slots, resolves their keys, remembers which
 * ones the gateway rejected, and probes exhausted windows for revival.
 */
export class AccountPool {
	/** Rotation state by resolved API key. Never logged. */
	private readonly states = new Map<string, AccountState>();
	private readonly slots: () => AccountSlot[];
	private readonly preferredId: () => string | undefined;
	private readonly probeWindow: (key: string) => Promise<{ exceeded: boolean; resetAt: number } | undefined>;
	private readonly modelRules: () => ModelAccountRule[];
	private readonly providerId: () => string;

	constructor(
		slots: () => AccountSlot[],
		preferredId: () => string | undefined,
		probeWindow: (key: string) => Promise<{ exceeded: boolean; resetAt: number } | undefined>,
		modelAccountRules: () => ModelAccountRule[] = () => [],
		providerId: () => string = () => "commandcode",
	) {
		this.slots = slots;
		this.preferredId = preferredId;
		this.probeWindow = probeWindow;
		this.modelRules = modelAccountRules;
		this.providerId = providerId;
	}

	/** The configured per-model routing rules. */
	private modelAccountRules(): ModelAccountRule[] {
		return this.modelRules();
	}

	/**
	 * Resolve every slot's key, deduplicated by key (first slot wins).
	 * Slots with no resolvable key are omitted: they still appear in status
	 * output as unconfigured, they just cannot serve a request.
	 */
	async resolvedAccounts(): Promise<ResolvedAccount[]> {
		return this.collect(false);
	}

	/**
	 * Every slot with a resolved key and its rotation state, NOT
	 * deduplicated — two slots sharing one credential both appear so the
	 * status view can report them individually.
	 */
	async describeAccounts(): Promise<ResolvedAccount[]> {
		return this.collect(true);
	}

	private async collect(keepDuplicates: boolean): Promise<ResolvedAccount[]> {
		const out: ResolvedAccount[] = [];
		const seen = new Set<string>();
		for (const slot of this.slots()) {
			const key = this.resolveSlotKey(slot);
			if (key === undefined) continue;
			if (!keepDuplicates) {
				if (seen.has(key)) continue;
				seen.add(key);
			}
			out.push({ slot, key, state: this.states.get(key) });
		}
		return out;
	}

	/**
	 * One slot's key: literal → environment → pi's credential store → the
	 * official CLI's auth file (default slot only).
	 *
	 * Normalizing at this single entry point is what keeps resolution,
	 * probing, marking, and the request path agreeing on one string — file
	 * and environment sources routinely carry trailing whitespace.
	 */
	private resolveSlotKey(slot: AccountSlot): string | undefined {
		const literal = normalizeKey(slot.apiKey);
		if (literal !== undefined) return literal;
		if (slot.apiKeyEnv !== undefined) {
			const fromEnv = normalizeKey(process.env[slot.apiKeyEnv]);
			if (fromEnv !== undefined) return fromEnv;
		}
		if (slot.allowAuthFile) {
			const fromPi = normalizeKey(resolvePiStoredKey(this.providerId()));
			if (fromPi !== undefined) return fromPi;
			return normalizeKey(resolveAuthFileApiKey());
		}
		return undefined;
	}

	/**
	 * Hand out the key for a request: a model-pinned account when a rule
	 * matches and that account is usable, else the preferred account when
	 * usable, else the first usable one. When every account is marked
	 * exhausted, each is probed against the billing endpoint and any whose
	 * window has reset is revived before giving up.
	 *
	 * `options.model` is the request's model id; rules are re-read per
	 * resolution, so a config change applies to the next request.
	 *
	 * Throws a classified error when accounts exist but none can serve.
	 */
	async resolveKey(options?: { exclude?: string; model?: string }): Promise<ResolvedAccount | undefined> {
		const accounts = await this.resolvedAccounts();
		if (accounts.length === 0) return undefined;

		const pinned = selectAccountForModel(accounts, options?.model ?? "", this.modelAccountRules());
		if (pinned !== undefined) return pinned;

		const chosen = selectActiveAccount(accounts, this.preferredId());
		if (chosen !== undefined) return chosen;

		// Everything looks exhausted. Ask the gateway whether any window has
		// actually reset, so a long session recovers without a restart.
		await Promise.all(
			accounts.map(async (account) => {
				if (account.state?.kind === "disabled") return;
				if (options?.exclude !== undefined && account.key === options.exclude) return;
				let probe: { exceeded: boolean; resetAt: number } | undefined;
				try {
					probe = await this.probeWindow(account.key);
				} catch {
					return;
				}
				if (probe === undefined) return;
				if (!probe.exceeded) {
					this.states.delete(account.key);
				} else {
					this.states.set(account.key, {
						kind: "cooldown",
						reason: account.state?.reason ?? "rate limited (429)",
						until: probe.resetAt,
					});
				}
			}),
		);

		const revived = selectActiveAccount(await this.resolvedAccounts(), this.preferredId());
		if (revived !== undefined) return revived;

		const latest = await this.resolvedAccounts();
		const allDisabled =
			latest.length > 0 && latest.every((account) => account.state?.kind === "disabled");
		if (allDisabled) {
			throw new Error(
				`Command Code：全部 ${latest.length} 个账户的 API 密钥均被拒绝（401）—— 请重新登录或检查密钥配置；` +
					`all ${latest.length} configured Command Code account(s) were rejected with 401 — check the stored keys`,
			);
		}
		const resets = latest
			.map((account) => account.state)
			.filter((state): state is Extract<AccountState, { kind: "cooldown" }> => state?.kind === "cooldown")
			.map((state) => state.until)
			.filter((until) => until > 0);
		const earliest = resets.length > 0 ? Math.min(...resets) : 0;
		throw new Error(
			`Command Code：已用尽全部 ${latest.length} 个账户的用量窗口` +
				(earliest > 0 ? `，最早的重置时间为 ${new Date(earliest).toLocaleString()}` : "") +
				` —— 窗口重置后会自动恢复；all ${latest.length} Command Code account(s) exhausted their usage window`,
		);
	}

	/**
	 * Record a rejection against one key. A 401 disables the key until the
	 * stored credential changes; a 429 marks it exhausted with an unknown
	 * reset that the revival probe fills in later.
	 */
	markRejected(key: string, rejection: "invalid-credential" | "rate-limit"): void {
		this.states.set(
			key,
			rejection === "invalid-credential"
				? { kind: "disabled", reason: "invalid API key (401)" }
				: { kind: "unknown", reason: "rate limited (429)" },
		);
	}

	/** Forget the marks on one key (used after a successful re-login). */
	clear(key: string): void {
		this.states.delete(key);
	}
}

/**
 * Build the slot list from plugin config, default slot first. The default
 * slot always exists so that the auth file alone is enough to get started.
 */
export function slotsFromConfig(
	accounts: AccountConfig[] | undefined,
	defaultEnvName: string,
	defaultLabel: string,
): AccountSlot[] {
	const slots: AccountSlot[] = [
		{
			id: defaultEnvName,
			label: defaultLabel,
			apiKeyEnv: defaultEnvName,
			allowAuthFile: true,
		},
	];
	for (const [index, account] of (accounts ?? []).entries()) {
		const envName = account.apiKeyEnv?.trim();
		const literal = account.apiKey !== undefined && account.apiKey !== "" ? account.apiKey : undefined;
		if (!envName && literal === undefined) continue;
		slots.push({
			id: envName ?? `account-${index + 2}`,
			label: account.label?.trim() || `账户 ${index + 2}`,
			...(literal !== undefined ? { apiKey: literal } : {}),
			...(envName ? { apiKeyEnv: envName } : {}),
			allowAuthFile: false,
		});
	}
	return slots;
}
