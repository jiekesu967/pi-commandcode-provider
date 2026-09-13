/**
 * Command Code account endpoints: usage, billing, and plan detection.
 *
 * All of these are the undocumented `/alpha/*` endpoints the official CLI
 * uses. They are read-only and independent: a failure on one never blanks
 * the rest of the report.
 */
import {
	ACTIVE_SUBSCRIPTION_STATUSES,
	BILLING_ACCESS_TTL_MS,
	CONTROL_TIMEOUT_MS,
	GO_TIER_WEIGHT,
	isRecord,
	numberValue,
	stringValue,
} from "./wire.ts";
import { subscriptionPlanInfo } from "./capabilities.ts";

/** Account endpoints fetched by one usage run. */
const USAGE_ENDPOINT_COUNT = 4;

/** One 5-hour or weekly usage window. */
export interface WindowLimit {
	used: number;
	cap: number;
	exceeded: boolean;
	resetAt: number;
}

/** Credit and window limits for an account. */
export interface CreditLimits {
	monthlyCredits: number | null;
	purchasedCredits: number;
	freeCredits: number;
	fiveHour: WindowLimit | null;
	weekly: WindowLimit | null;
}

/** Aggregated request/token/spend totals. */
export interface UsageTotals {
	requests: number;
	failedRequests: number;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	credits: number;
}

/** Subscription facts for an account. */
export interface PlanInfo {
	planId: string;
	name: string;
	status: string;
	monthlyCredits: number | null;
	currentPeriodEnd: number;
}

/** One account's usage report, with per-endpoint failures listed. */
export interface UsageReport {
	account?: string;
	orgId?: string;
	usage?: UsageTotals;
	credits?: CreditLimits;
	plan?: PlanInfo;
	failures: string[];
	blocked?: "invalid-key" | "service-unavailable" | "network";
}

/** Billing facts behind the picker's plan filter. */
export interface BillingAccess {
	tierWeight: number | undefined;
	onDemandCredits: number;
}

/** Headers shared by every authenticated account endpoint. */
function accountHeaders(apiKey: string, cliVersion: string): Record<string, string> {
	return {
		Authorization: `Bearer ${apiKey}`,
		"x-command-code-version": cliVersion,
		"x-cli-environment": "production",
	};
}

/** Parse an ISO string or epoch-millis value into millis; 0 when absent. */
function periodEndValue(value: unknown): number {
	const asNumber = numberValue(value);
	if (asNumber !== undefined) return asNumber;
	const asString = stringValue(value);
	if (asString === undefined) return 0;
	const parsed = Date.parse(asString);
	return Number.isNaN(parsed) ? 0 : parsed;
}

function parseUsageTotals(usage: unknown): UsageTotals | undefined {
	if (!isRecord(usage)) return undefined;
	const data = isRecord(usage.data) ? usage.data : usage;
	return {
		requests: numberValue(data.requests) ?? numberValue(data.totalRequests) ?? 0,
		failedRequests: numberValue(data.failedRequests) ?? 0,
		inputTokens: numberValue(data.inputTokens) ?? 0,
		outputTokens: numberValue(data.outputTokens) ?? 0,
		costUsd: numberValue(data.costUsd) ?? numberValue(data.cost) ?? 0,
		credits: numberValue(data.credits) ?? 0,
	};
}

function parseWindowLimit(value: unknown): WindowLimit | null {
	if (!isRecord(value)) return null;
	return {
		used: numberValue(value.used) ?? numberValue(value.current) ?? 0,
		cap: numberValue(value.limit) ?? numberValue(value.cap) ?? 0,
		exceeded: value.exceeded === true,
		resetAt: numberValue(value.resetAt) ?? 0,
	};
}

function parseCreditLimits(credits: unknown): CreditLimits | undefined {
	if (!isRecord(credits)) return undefined;
	const data = isRecord(credits.credits) ? credits.credits : undefined;
	const windowLimits = isRecord(credits.windowLimits) ? credits.windowLimits : undefined;
	if (data === undefined && windowLimits === undefined) return undefined;
	return {
		monthlyCredits: numberValue(data?.monthlyCredits) ?? numberValue(data?.planCredits) ?? null,
		purchasedCredits: numberValue(data?.purchasedCredits) ?? 0,
		freeCredits: numberValue(data?.freeCredits) ?? 0,
		fiveHour: windowLimits ? parseWindowLimit(windowLimits.fiveHour) : null,
		weekly: windowLimits ? parseWindowLimit(windowLimits.weekly) : null,
	};
}

/** Extract the account label and org id from a `/alpha/whoami` payload. */
export function parseAccountIdentity(whoami: unknown): { account?: string; orgId?: string } {
	if (!isRecord(whoami)) return {};
	const user = isRecord(whoami.user) ? whoami.user : undefined;
	const org = isRecord(whoami.org) ? whoami.org : undefined;
	const account =
		stringValue(user?.email) ?? stringValue(user?.name) ?? stringValue(user?.id) ?? stringValue(whoami.email);
	const orgId = stringValue(org?.id);
	return {
		...(account !== undefined ? { account } : {}),
		...(orgId !== undefined ? { orgId } : {}),
	};
}

const BLOCKED_CODES = new Set(["invalid-key", "service-unavailable", "network"]);

/**
 * Classify a TOTAL failure. When every endpoint failed the same way, the
 * per-endpoint list would bury the root cause behind "partial data" — name
 * it instead.
 */
function classifyTotalFailure(
	failures: string[],
	failedStatuses: (number | undefined)[],
): UsageReport["blocked"] {
	if (failures.length !== USAGE_ENDPOINT_COUNT) return undefined;
	const codes = failedStatuses.filter((status): status is number => status !== undefined);
	if (codes.length === USAGE_ENDPOINT_COUNT && codes.every((code) => code === 401)) return "invalid-key";
	if (codes.length === USAGE_ENDPOINT_COUNT && codes.every((code) => code >= 500)) {
		return "service-unavailable";
	}
	if (codes.length === 0) return "network";
	return undefined;
}

/** The Command Code account/usage client for one API base. */
export class UsageClient {
	private readonly apiBase: () => string;
	private readonly cliVersion: () => string;

	constructor(apiBase: () => string, cliVersion: () => string) {
		this.apiBase = apiBase;
		this.cliVersion = cliVersion;
	}

	private async fetchJson(
		path: string,
		apiKey: string,
	): Promise<{ status: number; record?: Record<string, unknown> }> {
		const base = this.apiBase().replace(/\/+$/, "");
		const response = await fetch(`${base}${path}`, {
			headers: accountHeaders(apiKey, this.cliVersion()),
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});
		if (!response.ok) return { status: response.status };
		const parsed: unknown = await response.json();
		return { status: response.status, ...(isRecord(parsed) ? { record: parsed } : {}) };
	}

	/** Full usage report for one account. Degrades per endpoint. */
	async getUsage(apiKey: string): Promise<UsageReport> {
		const failures: string[] = [];
		const failedStatuses: (number | undefined)[] = [];
		const getJson = async (path: string): Promise<Record<string, unknown> | undefined> => {
			try {
				const { status, record } = await this.fetchJson(path, apiKey);
				if (record === undefined) {
					failures.push(`${path}: HTTP ${status}`);
					failedStatuses.push(status);
					return undefined;
				}
				return record;
			} catch (error) {
				failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
				failedStatuses.push(undefined);
				return undefined;
			}
		};

		const report: UsageReport = { failures };
		const identity = parseAccountIdentity(await getJson("/alpha/whoami"));
		if (identity.account !== undefined) report.account = identity.account;
		if (identity.orgId !== undefined) report.orgId = identity.orgId;

		const [usage, credits, subscription] = await Promise.all([
			getJson("/alpha/usage/summary"),
			getJson("/alpha/billing/credits"),
			getJson(
				identity.orgId === undefined
					? "/alpha/billing/subscriptions"
					: `/alpha/billing/subscriptions?orgId=${encodeURIComponent(identity.orgId)}`,
			),
		]);

		const totals = parseUsageTotals(usage);
		if (totals !== undefined) report.usage = totals;
		const limits = parseCreditLimits(credits);
		if (limits !== undefined) report.credits = limits;

		const subData = subscription !== undefined && isRecord(subscription.data) ? subscription.data : undefined;
		const creditsData = credits !== undefined && isRecord(credits.credits) ? credits.credits : undefined;
		const planId = stringValue(subData?.planId) ?? stringValue(creditsData?.planId);
		if (subData !== undefined || planId !== undefined) {
			const info = planId === undefined ? undefined : subscriptionPlanInfo(planId);
			report.plan = {
				planId: planId ?? "",
				name: info?.name ?? planId ?? "",
				status: stringValue(subData?.status) ?? "",
				monthlyCredits: info?.monthlyCredits ?? null,
				currentPeriodEnd: periodEndValue(subData?.currentPeriodEnd),
			};
		}

		const blocked = classifyTotalFailure(failures, failedStatuses);
		if (blocked !== undefined && BLOCKED_CODES.has(blocked)) report.blocked = blocked;
		return report;
	}

	/** The plan id for one account, or undefined when it cannot be read. */
	async fetchPlanId(apiKey: string): Promise<string | undefined> {
		try {
			const whoami = (await this.fetchJson("/alpha/whoami", apiKey)).record;
			const orgId = parseAccountIdentity(whoami).orgId;
			const subscription = (
				await this.fetchJson(
					orgId === undefined
						? "/alpha/billing/subscriptions"
						: `/alpha/billing/subscriptions?orgId=${encodeURIComponent(orgId)}`,
					apiKey,
				)
			).record;
			const credits = (await this.fetchJson("/alpha/billing/credits", apiKey)).record;
			const subData = subscription !== undefined && isRecord(subscription.data) ? subscription.data : undefined;
			const creditsData = credits !== undefined && isRecord(credits.credits) ? credits.credits : undefined;
			if (subData !== undefined) {
				const status = stringValue(subData.status);
				if (status !== undefined && ACTIVE_SUBSCRIPTION_STATUSES.has(status)) {
					return stringValue(subData.planId);
				}
			}
			return stringValue(creditsData?.planId);
		} catch {
			return undefined;
		}
	}

	/**
	 * Probe one account's 5-hour window. The pool calls this when every
	 * account looks exhausted: an account whose window no longer reports
	 * `exceeded` is revived. A failed probe returns undefined and never
	 * changes pool state.
	 */
	async probeFiveHourWindow(apiKey: string): Promise<{ exceeded: boolean; resetAt: number } | undefined> {
		try {
			const response = await fetch(`${this.apiBase().replace(/\/+$/, "")}/alpha/billing/credits`, {
				headers: accountHeaders(apiKey, this.cliVersion()),
				signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
			});
			if (!response.ok) return undefined;
			const parsed: unknown = await response.json();
			if (!isRecord(parsed)) return undefined;
			const windowLimits = isRecord(parsed.windowLimits) ? parsed.windowLimits : undefined;
			const fiveHour = windowLimits !== undefined && isRecord(windowLimits.fiveHour) ? windowLimits.fiveHour : undefined;
			if (fiveHour === undefined) return undefined;
			return {
				exceeded: fiveHour.exceeded === true,
				resetAt: numberValue(fiveHour.resetAt) ?? 0,
			};
		} catch {
			return undefined;
		}
	}
}

/**
 * The billing facts behind the plan filter, cached for
 * {@link BILLING_ACCESS_TTL_MS} per key. `undefined` means "unknown — show
 * everything" (fail-open); the server stays the final gate.
 */
export class BillingAccessCache {
	private readonly cache = new Map<string, { value: BillingAccess | undefined; at: number }>();
	private readonly client: UsageClient;

	constructor(client: UsageClient) {
		this.client = client;
	}

	async get(apiKey: string): Promise<BillingAccess | undefined> {
		const hit = this.cache.get(apiKey);
		if (hit !== undefined && Date.now() - hit.at < BILLING_ACCESS_TTL_MS) return hit.value;
		const value = await this.fetch(apiKey);
		this.cache.set(apiKey, { value, at: Date.now() });
		return value;
	}

	/** Fresh cached tier weight for a key, or undefined when stale/unknown. */
	tierWeight(apiKey: string): number | undefined {
		const hit = this.cache.get(apiKey);
		if (hit === undefined || Date.now() - hit.at >= BILLING_ACCESS_TTL_MS) return undefined;
		return hit.value?.tierWeight;
	}

	/**
	 * Whether the key belongs to the Go tier. This is what lets the plugin
	 * skip the doomed Provider API attempt and go straight to the CLI
	 * gateway — the same shortcut the DSH plugin takes.
	 */
	async isGoTier(apiKey: string): Promise<boolean> {
		const access = await this.get(apiKey);
		return access?.tierWeight === GO_TIER_WEIGHT;
	}

	private async fetch(apiKey: string): Promise<BillingAccess | undefined> {
		try {
			const planId = await this.client.fetchPlanId(apiKey);
			if (planId === undefined) return undefined;
			const info = subscriptionPlanInfo(planId);
			return { tierWeight: info?.tierWeight, onDemandCredits: 0 };
		} catch {
			return undefined;
		}
	}
}
