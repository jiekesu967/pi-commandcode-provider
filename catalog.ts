/**
 * The live Command Code model catalog.
 *
 * `GET {base}/provider/v1/models` answers without a key, so the picker
 * works before login. The response carries only `id`, `name`, and
 * `context_length`; everything else the UI wants (plan tier, reasoning
 * efforts, vision support, peak pricing) comes from the capability snapshot
 * in `capabilities.ts`.
 *
 * A successful fetch is cached to disk so a cold start behind a flaky
 * network still lists models.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONTROL_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_TOKENS, isRecord, numberValue, stringValue } from "./wire.ts";
import {
	KNOWN_DEALS,
	KNOWN_EFFORTS,
	KNOWN_IMAGE_MODELS,
	KNOWN_PEAK_PRICING,
	KNOWN_PLANS,
	PLAN_LABELS,
	PLAN_ORDER,
	type PlanTier,
} from "./capabilities.ts";

/** Bumped when the cached shape changes so stale files are ignored. */
const CACHE_VERSION = 1;

/** Default cache location, matching the DSH plugin's convention. */
export const DEFAULT_CACHE_PATH = join(homedir(), ".commandcode", "models-cache.json");

/** One catalog entry: what the API advertises plus what we know about it. */
export interface CatalogModel {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	/** Minimum subscription tier, when the snapshot knows it. */
	tier?: PlanTier;
	/** Selectable reasoning efforts, when the snapshot knows them. */
	efforts?: string[];
	/** Whether the model accepts image input. */
	vision: boolean;
}

const IMAGE_MODELS = new Set(KNOWN_IMAGE_MODELS);
const PEAK_PRICING = new Set(KNOWN_PEAK_PRICING);

/** Whether the snapshot marks this model as free to call. */
export function isFreeModel(modelId: string): boolean {
	return KNOWN_DEALS[modelId]?.free === true;
}

/** Whether the model is billed at peak rates right now (UTC, Mon–Fri). */
export function peakPricingState(modelId: string, now = Date.now()): "peak" | "off-peak" | undefined {
	if (!PEAK_PRICING.has(modelId)) return undefined;
	const at = new Date(now);
	const day = at.getUTCDay();
	if (day === 0 || day === 6) return "off-peak";
	const hour = at.getUTCHours();
	return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10) ? "peak" : "off-peak";
}

/** The display label for a model's minimum plan. */
export function planLabel(modelId: string): string | undefined {
	const tier = KNOWN_PLANS[modelId];
	return tier === undefined ? undefined : PLAN_LABELS[tier];
}

/** The deal badge for a model (discount / FREE), when one applies. */
export function dealLabel(modelId: string): string | undefined {
	return KNOWN_DEALS[modelId]?.label;
}

/** Compact context-window rendering (`1M`, `200K`). */
export function formatContext(contextWindow: number): string {
	if (contextWindow >= 1_000_000) return `${(contextWindow / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	if (contextWindow >= 1_000) return `${Math.round(contextWindow / 1_000)}K`;
	return String(contextWindow);
}

/**
 * The one-line capability summary shown as a model's secondary label:
 * plan tier, deal, peak/off-peak pricing, image support, context size.
 */
export function capabilityDescription(modelId: string, contextWindow: number, now = Date.now()): string {
	const parts: string[] = [];
	const plan = planLabel(modelId);
	if (plan !== undefined) parts.push(plan);
	const deal = dealLabel(modelId);
	if (deal !== undefined) parts.push(deal);
	const peak = peakPricingState(modelId, now);
	if (peak === "peak") parts.push("Peak");
	else if (peak === "off-peak" && PEAK_PRICING.has(modelId)) parts.push("Half");
	if (IMAGE_MODELS.has(modelId)) parts.push("Image");
	parts.push(formatContext(contextWindow));
	return parts.join(" · ");
}

/**
 * Model ordering for the picker: free models first (usable by every
 * account), then by ascending plan tier, then name, then id.
 */
export function compareByPlan(a: CatalogModel, b: CatalogModel): number {
	const freeDelta = Number(isFreeModel(b.id)) - Number(isFreeModel(a.id));
	if (freeDelta !== 0) return freeDelta;
	const pa = a.tier === undefined ? Number.MAX_SAFE_INTEGER : PLAN_ORDER[a.tier];
	const pb = b.tier === undefined ? Number.MAX_SAFE_INTEGER : PLAN_ORDER[b.tier];
	if (pa !== pb) return pa - pb;
	const nameDiff = a.name.localeCompare(b.name);
	return nameDiff !== 0 ? nameDiff : a.id.localeCompare(b.id);
}

/**
 * Whether the picker should list a model for an account whose tier weight
 * is known. Fails open at every uncertainty — unknown billing data, unknown
 * plan, or a model outside the snapshot all stay visible, because the
 * server remains the final gate.
 */
export function modelVisibleInPlan(modelId: string, tierWeight: number | undefined): boolean {
	if (tierWeight === undefined || !Number.isFinite(tierWeight)) return true;
	const tier = KNOWN_PLANS[modelId];
	if (tier === undefined) return true;
	const weight = PLAN_ORDER[tier];
	if (weight === undefined) return true;
	return weight <= tierWeight;
}

/**
 * Parse a `/provider/v1/models` payload into catalog entries. Entries
 * missing an id, a name, or a positive context length are skipped rather
 * than guessed at.
 */
export function parseCatalogResponse(value: unknown): CatalogModel[] {
	if (!isRecord(value) || !Array.isArray(value.data)) {
		throw new Error("Command Code 模型目录响应格式异常；unexpected models response shape");
	}
	const models: CatalogModel[] = [];
	for (const entry of value.data) {
		if (!isRecord(entry)) continue;
		const id = stringValue(entry.id);
		const name = stringValue(entry.name);
		const contextLength = numberValue(entry.context_length);
		if (!id || !name || !contextLength || contextLength <= 0) continue;
		const tier = KNOWN_PLANS[id];
		const efforts = KNOWN_EFFORTS[id];
		models.push({
			id,
			name,
			contextWindow: contextLength,
			maxTokens: Math.min(contextLength, DEFAULT_MAX_OUTPUT_TOKENS),
			...(tier !== undefined ? { tier } : {}),
			...(efforts !== undefined ? { efforts } : {}),
			vision: IMAGE_MODELS.has(id),
		});
	}
	if (models.length === 0) {
		throw new Error("Command Code 返回了空的模型目录；the model catalog was empty");
	}
	return models;
}

/** pi/CC reasoning levels, ordered from least to most effort. */
const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** The pi `thinkingLevelMap` shape, narrowed to what this plugin emits. */
export type ThinkingLevelMap = Partial<Record<"off" | (typeof EFFORT_ORDER)[number], string | null>>;

/**
 * Build pi's `thinkingLevelMap` for one model from the CLI's own effort list.
 *
 * Levels Command Code does not accept are marked `null`, which is how pi is
 * told to hide them; accepted levels map to themselves because the CLI and
 * pi spell the levels identically. `off` is omitted on purpose: it means
 * "send no reasoning_effort", which every model tolerates, so it must stay
 * selectable. `undefined` means the snapshot knows nothing — offer pi's
 * defaults rather than hiding everything.
 */
export function thinkingLevelMapFor(modelId: string): ThinkingLevelMap | undefined {
	const efforts = KNOWN_EFFORTS[modelId];
	if (efforts === undefined || efforts.length === 0) return undefined;
	const accepted = new Set(efforts);
	const map: ThinkingLevelMap = {};
	for (const level of EFFORT_ORDER) map[level] = accepted.has(level) ? level : null;
	return map;
}

/**
 * Clamp a requested effort onto what a model accepts, mirroring pi's
 * `clampThinkingLevel`: try the same level, then higher ones, then lower
 * ones. This matters when the model changes mid-session (the picker's level
 * was chosen for the previous model) — without it the plugin would send an
 * effort the model silently ignores.
 *
 * Returns `undefined` when the snapshot knows nothing about the model, which
 * makes the caller omit `reasoning_effort` and let the server choose.
 */
export function clampEffort(modelId: string, requested: string): string | undefined {
	const efforts = KNOWN_EFFORTS[modelId];
	if (efforts === undefined || efforts.length === 0) return undefined;
	if (efforts.includes(requested)) return requested;
	const order: readonly string[] = EFFORT_ORDER;
	const index = order.indexOf(requested);
	if (index === -1) return undefined;
	for (let i = index; i < order.length; i += 1) {
		const candidate = order[i];
		if (candidate !== undefined && efforts.includes(candidate)) return candidate;
	}
	for (let i = index - 1; i >= 0; i -= 1) {
		const candidate = order[i];
		if (candidate !== undefined && efforts.includes(candidate)) return candidate;
	}
	return undefined;
}

/** Read a cached catalog, or undefined when absent/corrupt/outdated. */
export async function readCatalogCache(cachePath: string): Promise<CatalogModel[] | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(cachePath, "utf-8"));
		if (!isRecord(parsed) || parsed.version !== CACHE_VERSION || !Array.isArray(parsed.models)) {
			return undefined;
		}
		return parsed.models as CatalogModel[];
	} catch {
		return undefined;
	}
}

/** Write the catalog cache atomically, so a crash cannot leave it torn. */
export async function writeCatalogCache(cachePath: string, models: CatalogModel[]): Promise<void> {
	await mkdir(dirname(cachePath), { recursive: true });
	const tmp = `${cachePath}.${process.pid}.tmp`;
	try {
		await writeFile(tmp, `${JSON.stringify({ version: CACHE_VERSION, models }, null, 2)}\n`, {
			encoding: "utf-8",
			mode: 0o600,
		});
		await rename(tmp, cachePath);
	} finally {
		await rm(tmp, { force: true }).catch(() => undefined);
	}
}

/** The catalog client: fetches live, falls back to the on-disk cache. */
export class CatalogClient {
	private models: CatalogModel[] = [];
	private readonly apiBase: () => string;
	private readonly cachePath: () => string;
	private readonly fetchImpl: typeof fetch;

	constructor(apiBase: () => string, cachePath: () => string, fetchImpl?: typeof fetch) {
		this.apiBase = apiBase;
		this.cachePath = cachePath;
		// The catalog is on the same origin as the model requests, so it goes
		// through the same pinned transport rather than system DNS.
		this.fetchImpl = fetchImpl ?? fetch;
	}

	/** The last successfully loaded catalog, synchronously. */
	current(): CatalogModel[] {
		return this.models;
	}

	/**
	 * Prime the in-memory catalog from the on-disk cache without touching the
	 * network. Startup uses this so a slow or unreachable catalog endpoint
	 * cannot delay the TUI; {@link load} refreshes it in the background.
	 */
	async preloadFromCache(): Promise<CatalogModel[]> {
		if (this.models.length > 0) return this.models;
		const cached = await readCatalogCache(this.cachePath());
		if (cached !== undefined) this.models = cached;
		return this.models;
	}

	/** Load the catalog: network first, then the cache. */
	async load(options?: { force?: boolean; signal?: AbortSignal }): Promise<CatalogModel[]> {
		const cachePath = this.cachePath();
		if (!options?.force && this.models.length > 0) return this.models;
		try {
			const base = this.apiBase().replace(/\/+$/, "");
			const response = await this.fetchImpl(`${base}/provider/v1/models`, {
				headers: { accept: "application/json" },
				signal: options?.signal ?? AbortSignal.timeout(CONTROL_TIMEOUT_MS),
			});
			if (!response.ok) throw new Error(`模型目录返回 HTTP ${response.status}`);
			this.models = parseCatalogResponse(await response.json());
			await writeCatalogCache(cachePath, this.models).catch(() => undefined);
		} catch (error) {
			if (options?.signal?.aborted) throw error;
			const cached = await readCatalogCache(cachePath);
			if (cached !== undefined) this.models = cached;
			else if (this.models.length === 0) throw error;
		}
		return this.models;
	}

	/** Look up one model's max output tokens. */
	maxTokensFor(modelId: string): number | undefined {
		return this.models.find((model) => model.id === modelId)?.maxTokens;
	}

	/** Whether the catalog marks this model as vision-capable. */
	isVision(modelId: string): boolean {
		return this.models.find((model) => model.id === modelId)?.vision ?? IMAGE_MODELS.has(modelId);
	}
}
