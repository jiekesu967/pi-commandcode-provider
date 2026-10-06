/**
 * Command Code provider for pi.
 *
 * Registers a `commandcode` provider backed by a custom stream handler that
 * speaks both Command Code transports: the documented Provider API, and the
 * CLI gateway (`/alpha/generate`) that the **Go plan** is entitled to. A Go
 * account is refused by the Provider API with `403 upgrade_required`, so the
 * handler detects exactly that rejection and replays the request through the
 * CLI transport. Almost the entire feature set of the official CLI — model
 * catalog, usage windows, plan detection — is reachable from here.
 *
 * Modelled on @mars-sea/dsh-commandcode-provider for DeepSeek Harness
 * (MIT), which is itself ported from patlux/pi-commandcode-provider (MIT).
 *
 * Configuration lives in `~/.pi/agent/settings.json` under `commandcode`:
 *
 * ```json
 * {
 *   "commandcode": {
 *     "apiBase": "https://api.commandcode.ai",
 *     "apiKeyEnv": "COMMANDCODE_API_KEY",
 *     "accounts": [{ "label": "Go #2", "apiKeyEnv": "COMMANDCODE_API_KEY_2" }],
 *     "activeAccount": "COMMANDCODE_API_KEY_2",
 *     "modelAccountRules": [
 *       { "models": ["deepseek/deepseek-v4-pro"], "account": "COMMANDCODE_API_KEY_2" }
 *     ],
 *     "filterModelsByPlan": true,
 *     "visibleModels": [],
 *     "requestTimeoutMs": 60000,
 *     "streamIdleTimeoutMs": 300000
 *   }
 * }
 * ```
 */
import type { ExtensionAPI, ExtensionContext, Theme, TUI } from "@earendil-works/pi-coding-agent";
import {
	Key,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

import { AccountPool, slotsFromConfig, type AccountConfig, type ModelAccountRule } from "./accounts.ts";
import {
	ensurePiHasKey,
	loginFailureMessage,
	runBrowserLogin,
	storeKeyToAuthFile,
	storeKeyToPiAuth,
} from "./login.ts";
import {
	CatalogClient,
	capabilityDescription,
	compareByPlan,
	DEFAULT_CACHE_PATH,
	modelVisibleInPlan,
} from "./catalog.ts";
import { streamCommandCode } from "./stream.ts";
import { BillingAccessCache, UsageClient, type UsageReport } from "./usage.ts";
import {
	COMMANDCODE_API,
	COMMAND_CODE_CLI_VERSION,
	DEFAULT_API_BASE,
	fetchCliVersion,
} from "./wire.ts";

/** The provider id models are registered under. */
const PROVIDER = "commandcode";

/** Footer/widget key for the usage panel. */
const WIDGET_KEY = "commandcode-usage";

/** How often the panel re-polls usage while visible. */
const REFRESH_MS = 60_000;

/**
 * How long startup waits for the plan-tier probe before registering anyway.
 * The billing endpoint is a network call; waiting for it unconditionally used
 * to add seconds to every TUI start. When the probe lands after this budget,
 * `refreshTier()` re-registers and the plan filter converges afterwards.
 */
const TIER_BOOT_BUDGET_MS = 400;

/** Plugin configuration, as stored in settings.json. */
interface CommandCodeConfig {
	apiBase?: string;
	apiKeyEnv?: string;
	accounts?: AccountConfig[];
	activeAccount?: string;
	/** Pin specific models to a specific account slot. */
	modelAccountRules?: ModelAccountRule[];
	modelsCachePath?: string;
	filterModelsByPlan?: boolean;
	visibleModels?: string[];
	requestTimeoutMs?: number;
	streamIdleTimeoutMs?: number;
	workingDir?: string;
}

const DEFAULTS = {
	apiBase: DEFAULT_API_BASE,
	apiKeyEnv: "COMMANDCODE_API_KEY",
	filterModelsByPlan: true,
	requestTimeoutMs: 60_000,
	streamIdleTimeoutMs: 300_000,
} as const;

/** Read the plugin's settings block, tolerating a missing/!malformed file. */
function readConfig(): CommandCodeConfig {
	try {
		const raw: unknown = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf-8"));
		if (typeof raw !== "object" || raw === null) return {};
		const block = (raw as Record<string, unknown>)[PROVIDER];
		return typeof block === "object" && block !== null ? (block as CommandCodeConfig) : {};
	} catch {
		return {};
	}
}

const GREEN = (s: string) => `\x1b[38;5;40m${s}\x1b[39m`;
const YELLOW = (s: string) => `\x1b[38;5;226m${s}\x1b[39m`;
const ORANGE = (s: string) => `\x1b[38;5;208m${s}\x1b[39m`;
const RED = (s: string) => `\x1b[38;5;196m${s}\x1b[39m`;

/** Four-band alert colouring, shared by the percentage and the bar. */
function levelColor(percent: number, text: string): string {
	if (percent <= 40) return GREEN(text);
	if (percent <= 60) return YELLOW(text);
	if (percent <= 80) return ORANGE(text);
	return RED(text);
}

/** Pad to a visible column width (CJK glyphs occupy two columns). */
function padToWidth(text: string, width: number): string {
	const current = visibleWidth(text);
	return current >= width ? text : text + " ".repeat(width - current);
}

/** A 20-cell usage bar, coloured by the same bands as the number. */
function bar(percent: number, length = 20): string {
	const filled = Math.round((percent / 100) * length);
	return levelColor(percent, "█".repeat(filled) + "░".repeat(Math.max(0, length - filled)));
}

/** Local `MM-DD HH:mm` rendering of a reset timestamp. */
function formatResetTime(epochMs: number): string {
	if (!epochMs) return "未知";
	const date = new Date(epochMs);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Percentage of a window that has been consumed. */
function windowPercent(used: number, cap: number): number {
	if (cap <= 0) return 0;
	return Math.min(100, Math.round((used / cap) * 100));
}

/**
 * Column at which every metric row's value starts, counting the indent.
 *
 * Matches the OpenCode Go usage panel (which pads its labels to 16 visible
 * columns), so the two widgets stack with their values in one column
 * instead of each drifting to its own offset.
 */
const METRIC_LABEL_WIDTH = 16;

/**
 * One metric row: an indented fixed-width label, a right-aligned percentage,
 * then the usage bar.
 *
 * Padding by VISIBLE width rather than string length is what actually keeps
 * bars aligned: CJK glyphs occupy two terminal cells each, so "5 小时" and
 * "每周" differ in width, and a percentage crossing 100% ("18%" -> "100%")
 * would otherwise shift the bar one column right.
 */
function metricRow(
	fg: (color: string, text: string) => string,
	label: string,
	percent: number,
	suffix = "",
): string {
	const padded = padToWidth(`  ${label}`, METRIC_LABEL_WIDTH);
	const pct = levelColor(percent, `${percent}%`.padStart(4));
	return `${fg("muted", padded)} ${pct} ${bar(percent)}${suffix}`;
}

/** Render one account's usage report into panel lines. */
function renderReport(
	theme: Theme | undefined,
	label: string,
	report: UsageReport | undefined,
	error: string | undefined,
): string[] {
	// The panel supplies a real theme; command output renders without one, so
	// every colour call goes through this shim.
	const fg = (color: string, text: string) => (theme === undefined ? text : theme.fg(color as never, text));
	const lines: string[] = [];
	const head = fg("accent", `▦ ${label}`);
	if (error !== undefined) return [`${head} ${fg("error", `查询失败: ${error}`)}`];
	if (report === undefined) return [`${head} ${fg("dim", "无数据")}`];

	const plan = report.plan;
	const planText =
		plan !== undefined && plan.name !== ""
			? `${fg("text", plan.name)}${plan.status ? fg("dim", ` (${plan.status})`) : ""}`
			: fg("dim", "未知");
	lines.push(`${head}  ${fg("muted", "套餐")} ${planText}`);

	const fiveHour = report.credits?.fiveHour ?? null;
	if (fiveHour !== null && fiveHour.cap > 0) {
		const percent = windowPercent(fiveHour.used, fiveHour.cap);
		const warn = fiveHour.exceeded ? fg("error", "  超限!") : "";
		lines.push(metricRow(fg, "5 小时", percent, warn));
		lines.push(`${fg("dim", `      重置 ${formatResetTime(fiveHour.resetAt)}`)}`);
	}
	const weekly = report.credits?.weekly ?? null;
	if (weekly !== null && weekly.cap > 0) {
		const percent = windowPercent(weekly.used, weekly.cap);
		const warn = weekly.exceeded ? fg("error", "  超限!") : "";
		lines.push(metricRow(fg, "每周", percent, warn));
		lines.push(`${fg("dim", `      重置 ${formatResetTime(weekly.resetAt)}`)}`);
	}

	const usage = report.usage;
	if (usage !== undefined) {
		const successRate =
			usage.requests > 0 ? Math.round(((usage.requests - usage.failedRequests) / usage.requests) * 100) : 100;
		lines.push(
			`${fg("muted", padToWidth("  请求", METRIC_LABEL_WIDTH))} ` +
				`${usage.requests} 次 / 失败 ${usage.failedRequests}  成功率 ${successRate}%`,
		);
		lines.push(
			`${fg("muted", padToWidth("  Token", METRIC_LABEL_WIDTH))} ` +
				`${usage.inputTokens} 入 / ${usage.outputTokens} 出`,
		);
	}
	if (report.failures.length > 0) {
		lines.push(fg("dim", `  部分端点失败: ${report.failures.join("; ")}`));
	}
	if (report.blocked === "invalid-key") {
		lines.push(fg("error", "  API 密钥无效或已过期（401）"));
	} else if (report.blocked === "service-unavailable") {
		lines.push(fg("error", "  Command Code 服务暂时不可用（5xx）"));
	} else if (report.blocked === "network") {
		lines.push(fg("error", "  无法连接 Command Code —— 请检查网络或 apiBase"));
	}
	return lines;
}

export default async function (pi: ExtensionAPI) {
	const config = readConfig();
	const apiBase = () => readConfig().apiBase ?? DEFAULTS.apiBase;
	const workingDir = () => config.workingDir ?? process.cwd();

	// ---------------------------------------------------------------------
	// Wiring
	// ---------------------------------------------------------------------
	const catalog = new CatalogClient(apiBase, () => readConfig().modelsCachePath ?? DEFAULT_CACHE_PATH);

	/**
	 * The `x-command-code-version` value to send. The gateway refuses stale
	 * clients on the CLI transport (the one the Go plan depends on), so the
	 * released version is refreshed from npm instead of trusted to a
	 * hardcoded constant. Until it resolves, the bundled constant is used.
	 */
	let cliVersion = COMMAND_CODE_CLI_VERSION;
	const usageClient = new UsageClient(apiBase, () => cliVersion);
	const billing = new BillingAccessCache(usageClient);
	const pool = new AccountPool(
		() => slotsFromConfig(readConfig().accounts, readConfig().apiKeyEnv ?? DEFAULTS.apiKeyEnv, "默认账户"),
		() => readConfig().activeAccount,
		(key) => usageClient.probeFiveHourWindow(key),
		() => readConfig().modelAccountRules ?? [],
	);

	/** Remembered transport per key, so a Go account is not re-probed. */
	const transportCache = new Map<string, { transport: "openai" | "cli"; at: number }>();
	const transportTtlMs = 15 * 60_000;

	/** Keys known to be Go-tier, refreshed alongside the billing cache. */
	const goTierKeys = new Set<string>();

	const resolveAccount = async (model: string) => {
		const account = await pool.resolveKey({ model });
		if (account === undefined) {
			throw new Error(
				"Command Code：未找到可用的 API 密钥 —— 请运行 /commandcode-login，或用 COMMANDCODE_API_KEY 环境变量、" +
					"config.apiKey、或官方 CLI 的 ~/.commandcode/auth.json 提供密钥；" +
					"no Command Code API key found",
			);
		}
		return { key: account.key, slotId: account.slot.id };
	};

	const rotateAccount = async (rejectedKey: string, rejection: "invalid-credential" | "rate-limit", model: string) => {
		pool.markRejected(rejectedKey, rejection);
		const next = await pool.resolveKey({ exclude: rejectedKey, model });
		return next === undefined ? undefined : { key: next.key, slotId: next.slot.id };
	};

	/**
	 * Whether a key is known to belong to the Go tier. Answering yes lets the
	 * engine skip an attempt that is guaranteed to be refused.
	 */
	const isGoTier = (key: string): boolean => {
		if (goTierKeys.has(key)) return true;
		if (transportCache.get(key)?.transport === "cli") return true;
		// Kick off a background probe; the next request benefits.
		void billing.isGoTier(key).then((isGo) => {
			if (isGo) goTierKeys.add(key);
		}).catch(() => undefined);
		return false;
	};

	const streamDeps = {
		workingDir,
		resolveAccount,
		rotateAccount,
		cachedTransport: (key: string) => {
			const hit = transportCache.get(key);
			if (hit === undefined || Date.now() - hit.at >= transportTtlMs) return undefined;
			return hit.transport;
		},
		rememberTransport: (key: string, transport: "openai" | "cli") => {
			transportCache.set(key, { transport, at: Date.now() });
		},
		modelMaxTokens: (model: string) => catalog.maxTokensFor(model),
		streamIdleTimeoutMs: () => readConfig().streamIdleTimeoutMs ?? DEFAULTS.streamIdleTimeoutMs,
		requestTimeoutMs: () => readConfig().requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
		cliVersion: () => cliVersion,
	};

	// ---------------------------------------------------------------------
	// Provider registration
	// ---------------------------------------------------------------------

	/**
	 * The active account's plan tier weight, when the billing cache knows
	 * it. Kept in a variable because model registration is synchronous while
	 * the billing lookup is not; the value is refreshed on session start and
	 * after a rejection, then the provider is re-registered.
	 */
	let currentTierWeight: number | undefined;

	const buildModels = () => {
		const configured = readConfig();
		const filterByPlan = configured.filterModelsByPlan ?? DEFAULTS.filterModelsByPlan;
		const visible = configured.visibleModels?.filter((id) => typeof id === "string" && id !== "") ?? [];
		const allow = visible.length > 0 ? new Set(visible) : undefined;
		return catalog
			.current()
			.slice()
			.sort(compareByPlan)
			.filter((model) => {
				if (allow !== undefined && !allow.has(model.id)) return false;
				if (filterByPlan && !modelVisibleInPlan(model.id, currentTierWeight)) return false;
				return true;
			})
			.map((model) => ({
				id: model.id,
				name: model.name,
				reasoning: model.efforts !== undefined && model.efforts.length > 0,
				input: (model.vision ? ["text", "image"] : ["text"]) as ("text" | "image")[],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
			}));
	};

	/** (Re)register the provider with the models known right now. */
	const register = () => {
		const models = buildModels();
		if (models.length === 0) return;
		pi.registerProvider(PROVIDER, {
			name: "Command Code",
			baseUrl: apiBase(),
			// The engine resolves keys itself through the account pool, so this
			// is only the fallback that makes pi consider the provider
			// configured when nothing else is present.
			apiKey: "$COMMANDCODE_API_KEY",
			api: COMMANDCODE_API as Api,
			models,
			// Browser login. The Go plan is the reason this exists: it has no
			// Provider API access, so the account key obtained here is the only
			// credential the CLI transport accepts. The key is returned as the
			// OAuth "access" token, which is what pi stores and what
			// `getApiKey` hands to requests; `resolvePiStoredKey` reads it back
			// for the account pool.
			oauth: {
				name: "Command Code（浏览器登录）",
				isSubscription: true,
				login: (callbacks) =>
					runBrowserLogin({
						apiBase,
						callbacks,
						onStored: () => {
							goTierKeys.clear();
							transportCache.clear();
						},
					}),
				// Command Code issues a long-lived key rather than a refreshable
				// token, so there is nothing to refresh.
				refreshToken: async (credentials) => credentials,
				getApiKey: (credentials) => credentials.access,
			},
			streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
				streamCommandCode(model as Model<string>, context, options, streamDeps, apiBase(), isGoTier),
		});
	};

	/** Refresh the cached plan tier, then re-register if it changed. */
	const refreshTier = async () => {
		try {
			const account = await pool.resolveKey();
			if (account === undefined) return;
			const before = currentTierWeight;
			currentTierWeight = await billing.get(account.key).then((access) => access?.tierWeight);
			if (currentTierWeight !== before) register();
		} catch {
			// Leave the previous filter in place; the server remains the gate.
		}
	};

	// Startup must never wait on the network: a slow catalog endpoint used to
	// delay the TUI by several seconds. Prime the catalog from the on-disk cache
	// (milliseconds) so `pi --list-models` and startup model selection still see
	// a full catalog, then refresh live in the background. A failure keeps the
	// cached catalog and surfaces a warning once a session starts.
	await catalog.preloadFromCache();
	void catalog
		.load({ force: true })
		.then(() => register())
		.catch((error: unknown) => {
			pi.on("session_start", (_event, ctx) => {
				ctx.ui.notify(
					`Command Code 模型目录加载失败：${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			});
		});
	// The gateway refuses a stale CLI version on the transport the Go plan
	// depends on, so resolve the current release rather than trusting the
	// bundled constant. A failure just keeps the bundled value.
	void fetchCliVersion().then((version) => {
		if (version !== undefined) cliVersion = version;
	});

	// pi decides whether this provider is configured from its OWN credential
	// store. A key that only exists in ~/.commandcode/auth.json — put there by
	// a login from before this store was written, or by the official `cmd` CLI
	// — would leave pi reporting the provider as unconfigured and `/model`
	// empty. Migrate it once so an existing login starts working without the
	// user having to log in again.
	const migrated = await ensurePiHasKey(PROVIDER, {
		envName: readConfig().apiKeyEnv ?? DEFAULTS.apiKeyEnv,
	});
	if (migrated) {
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify("Command Code：已把现有密钥同步到 pi 凭据库，/model 中的模型已可用。", "info");
		});
	}

	// Resolve the account's plan tier so the plan filter applies from the very
	// first registration, but cap the wait: a slow billing endpoint must not
	// hold the TUI hostage. A timeout leaves the tier unknown, which fails open
	// — deliberately, since the server is the final gate — and the probe keeps
	// running in the background, re-registering if the tier turns out different.
	await Promise.race([
		refreshTier(),
		new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, TIER_BOOT_BUDGET_MS);
			timer.unref?.();
		}),
	]);
	register();

	// ---------------------------------------------------------------------
	// Usage panel
	// ---------------------------------------------------------------------
	interface PanelState {
		expanded: boolean;
		reports: { label: string; report?: UsageReport; error?: string }[];
		loading: boolean;
	}
	const state: PanelState = { expanded: false, reports: [], loading: false };
	let tui: TUI | null = null;
	let timer: NodeJS.Timeout | undefined;

	const refresh = async () => {
		state.loading = true;
		tui?.requestRender();
		try {
			const accounts = await pool.describeAccounts();
			const reports = await Promise.all(
				accounts.map(async (account) => {
					try {
						return { label: account.slot.label, report: await usageClient.getUsage(account.key) };
					} catch (error) {
						return { label: account.slot.label, error: error instanceof Error ? error.message : String(error) };
					}
				}),
			);
			state.reports =
				reports.length > 0
					? reports
					: [{ label: "默认账户", error: "未配置 API 密钥 —— 运行 /commandcode-login" }];
		} finally {
			state.loading = false;
			tui?.requestRender();
		}
	};

	const renderWidget = (theme: Theme): string[] => {
		const label = theme.fg("accent", "▦ Command Code");
		if (!state.expanded) {
			// Collapsed: one line with the first account's 5-hour window.
			const first = state.reports[0]?.report;
			const fiveHour = first?.credits?.fiveHour ?? null;
			if (fiveHour !== null && fiveHour.cap > 0) {
				const percent = windowPercent(fiveHour.used, fiveHour.cap);
				return [
					`${label} · 5h ${levelColor(percent, `${percent}%`)} ${bar(percent, 12)}${theme.fg("dim", "  (alt+c 展开)")}`,
				];
			}
			const planName = first?.plan?.name;
			if (planName !== undefined && planName !== "") {
				return [`${label} · ${theme.fg("text", planName)}${theme.fg("dim", "  (alt+c 展开)")}`];
			}
			return [`${label} · ${state.loading ? theme.fg("dim", "加载中…") : theme.fg("dim", "无数据 (alt+c 展开)")}`];
		}

		const header = `${label} ${theme.fg("dim", "用量  (alt+c 收起)")}`;
		const lines = [header];
		for (const entry of state.reports) {
			lines.push(...renderReport(theme, entry.label, entry.report, entry.error));
		}
		return lines;
	};

	const toggle = (ctx: ExtensionContext): void => {
		state.expanded = !state.expanded;
		if (state.expanded) void refresh();
		tui?.requestRender();
		ctx.ui.setStatus(WIDGET_KEY, state.expanded ? "Command Code 用量已展开" : undefined);
	};

	pi.registerShortcut(Key.alt("c"), {
		description: "展开/收起 Command Code 用量面板",
		handler: async (ctx) => toggle(ctx),
	});

	pi.on("session_start", async (_event, ctx) => {
		state.expanded = false;
		state.reports = [];
		// The catalog and the account's plan tier may both have changed since
		// startup; refresh them so /model reflects reality.
		void catalog
			.load({ force: catalog.current().length === 0 })
			.then(() => refreshTier())
			.catch(() => undefined);
		ctx.ui.setWidget(
			WIDGET_KEY,
			(widgetTui, theme) => {
				tui = widgetTui;
				return {
					render: (width: number) => renderWidget(theme).map((line) => truncateToWidth(line, width)),
					invalidate: () => {},
					dispose: () => {
						if (timer) clearInterval(timer);
						timer = undefined;
						tui = null;
					},
				};
			},
			{ placement: "belowEditor" },
		);
		void refresh();
		timer = setInterval(() => void refresh(), REFRESH_MS);
		timer.unref?.();
	});

	pi.on("session_shutdown", async () => {
		if (timer) clearInterval(timer);
		timer = undefined;
		tui = null;
	});

	// Keep the number current the moment a turn settles.
	pi.on("agent_settled", async () => {
		void refresh();
	});

	// ---------------------------------------------------------------------
	// Commands
	// ---------------------------------------------------------------------
	pi.registerCommand("commandcode", {
		description: "显示 Command Code 各账户用量 / 套餐",
		handler: async (_args, ctx) => {
			await refresh();
			const blocks = state.reports.map((entry) =>
				renderReport(undefined, entry.label, entry.report, entry.error).join("\n"),
			);
			ctx.ui.notify(blocks.join("\n\n"), "info");
		},
	});

	pi.registerCommand("commandcode-models", {
		description: "刷新 Command Code 模型目录",
		handler: async (_args, ctx) => {
			try {
				const models = await catalog.load({ force: true });
				register();
				ctx.ui.notify(`Command Code 模型目录已刷新：${models.length} 个模型`, "info");
			} catch (error) {
				ctx.ui.notify(
					`刷新失败：${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("commandcode-status", {
		description: "显示 Command Code 账户与传输状态",
		handler: async (_args, ctx) => {
			const accounts = await pool.describeAccounts();
			const lines = accounts.map((account) => {
				const transport = transportCache.get(account.key)?.transport ?? "自动";
				const stateText =
					account.state === undefined
						? "可用"
						: account.state.kind === "disabled"
							? "密钥无效"
							: account.state.kind === "cooldown"
								? `冷却至 ${formatResetTime(account.state.until)}`
								: "已达限额";
				return `  ${account.slot.label} (${account.slot.id}): ${stateText} · 传输 ${transport}`;
			});
			ctx.ui.notify(
				[
					`Command Code 状态`,
					`  API 地址: ${apiBase()}`,
					`  目录: ${catalog.current().length} 个模型`,
					...lines,
				].join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("commandcode-login", {
		description: "浏览器登录 Command Code，或手工粘贴 API 密钥",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("需要在交互模式下运行；或手工设置 COMMANDCODE_API_KEY", "error");
				return;
			}

			// Offer the browser flow first (it is what `cmd login` does and it
			// is the only way to obtain a Go-plan key without leaving pi), with
			// manual paste as the fallback for headless or remote setups.
			const method = await ctx.ui.select("Command Code 登录方式:", [
				"浏览器登录（推荐，自动获取密钥）",
				"手工粘贴 API 密钥",
			]);
			if (method === undefined) return;

			if (method.startsWith("浏览器")) {
				ctx.ui.notify("正在启动本地回调服务并打开浏览器…", "info");
				try {
					const credentials = await runBrowserLogin({
						apiBase,
						callbacks: {
							onAuth: (info) => {
								ctx.ui.notify(
									`${info.instructions ?? "请在浏览器中完成登录"}\n${info.url}`,
									"info",
								);
							},
							onProgress: (message) => ctx.ui.notify(message, "info"),
						},
						onStored: () => {
							goTierKeys.clear();
							transportCache.clear();
						},
					});
					ctx.ui.notify(`登录成功：${credentials.access.slice(0, 12)}… 已保存`, "info");
					await refreshTier();
					void refresh();
				} catch (error) {
					ctx.ui.notify(
						`浏览器登录失败：${error instanceof Error ? error.message : String(error)}\n` +
							"可重试，或改用「手工粘贴 API 密钥」。",
						"error",
					);
				}
				return;
			}

			const key = await ctx.ui.input("粘贴 Command Code API 密钥:", { placeholder: "user_..." });
			if (key === undefined || key.trim() === "") return;
			try {
				const authPath = join(homedir(), ".commandcode", "auth.json");
				await storeKeyToAuthFile({ apiKey: key.trim() }, authPath);
				// pi reads its own store to decide whether this provider is
				// configured; without this entry it would keep treating the
				// provider as unconfigured and /model would list nothing.
				await storeKeyToPiAuth({ apiKey: key.trim() }, PROVIDER);
				goTierKeys.clear();
				transportCache.clear();
				ctx.ui.notify(`密钥已保存到 ${authPath}（pi 凭据库已同步）`, "info");
				await refreshTier();
			} catch (error) {
				ctx.ui.notify(
					`保存失败：${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});
}

