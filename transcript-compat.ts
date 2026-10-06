/**
 * pi-ai transcript helpers，带本地兜底实现。
 *
 * 背景
 * ----
 * pi 1.0.0 的**打包发行版**（npm 安装的 pi-coding-agent / 编译产物）通过「虚拟模块」把
 * `@earendil-works/pi-ai` 暴露给扩展，而其 compat 入口只带 100 个导出，**缺少**
 * `getCurrentSystemPrompt` 与 `getCurrentTools`（磁盘上的 `dist/compat.js` 有 127 个导出）。
 * 同时 `@earendil-works/pi-ai/utils/transcript` 子路径在虚拟模块表中未注册，无法解析。
 *
 * 于是从根命名空间取这两个函数会得到 `undefined`，请求时抛
 * `getCurrentSystemPrompt is not a function`，provider 完全不可用。
 *
 * 策略
 * ----
 * 运行时优先使用上游实现（源码运行、旧版本 pi、以及未来恢复导出时都自动跟随），
 * 取不到时回退到本地等价实现。本地实现严格对齐 pi-ai
 * `dist/utils/transcript.js` 与 `dist/utils/text.js` 的语义：
 *  - system message 的 `content` 逐条拼接（`"\n\n"`），`sections` 按名覆盖（`null` 删除）；
 *  - 工具集按 `toolsAdded` / `toolsRemoved` 顺序折叠。
 */
import * as piAi from "@earendil-works/pi-ai";
import type { Message, Tool } from "@earendil-works/pi-ai";

interface SystemMessageLike {
	role: string;
	content?: unknown;
	sections?: Record<string, string | null>;
	toolsAdded?: Tool[];
	toolsRemoved?: { name: string }[];
}

const upstream = piAi as unknown as {
	getCurrentSystemPrompt?: (messages: readonly Message[]) => string;
	getCurrentTools?: (messages: readonly Message[]) => Tool[];
};

function isSystemMessage(message: unknown): message is SystemMessageLike {
	return typeof message === "object" && message !== null && (message as { role?: unknown }).role === "system";
}

/** 与 pi-ai `utils/text.js` 的 `contentText` 一致（不传 separator 时用 `"\n"`）。 */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const typed = block as { type?: unknown; text?: unknown };
		if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
	}
	return parts.join("\n");
}

function localGetCurrentTools(messages: readonly Message[]): Tool[] {
	const tools = new Map<string, Tool>();
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;
		for (const removed of message.toolsRemoved ?? []) tools.delete(removed.name);
		for (const added of message.toolsAdded ?? []) tools.set(added.name, added);
	}
	return [...tools.values()];
}

function localGetCurrentSystemPrompt(messages: readonly Message[]): string {
	const parts: string[] = [];
	const sections = new Map<string, string>();
	let sawSystemMessage = false;

	for (const message of messages) {
		if (!isSystemMessage(message)) continue;
		sawSystemMessage = true;
		const text = contentText(message.content);
		if (text.length > 0) parts.push(text);
		for (const [name, value] of Object.entries(message.sections ?? {})) {
			if (value === null) sections.delete(name);
			else sections.set(name, value);
		}
	}

	if (!sawSystemMessage && localGetCurrentTools(messages).length === 0) return "";
	for (const text of sections.values()) parts.push(text);
	return parts.filter((part) => part.length > 0).join("\n\n");
}

/** 当前生效的 system prompt（等价于 pi-ai `getCurrentSystemPrompt`）。 */
export function getCurrentSystemPrompt(messages: readonly Message[]): string {
	const fn = upstream.getCurrentSystemPrompt;
	if (typeof fn === "function") {
		try {
			return fn(messages);
		} catch {
			/* 上游存在但不可用时回退 */
		}
	}
	return localGetCurrentSystemPrompt(messages);
}

/** 当前生效的工具集（等价于 pi-ai `getCurrentTools`）。 */
export function getCurrentTools(messages: readonly Message[]): Tool[] {
	const fn = upstream.getCurrentTools;
	if (typeof fn === "function") {
		try {
			return fn(messages);
		} catch {
			/* 上游存在但不可用时回退 */
		}
	}
	return localGetCurrentTools(messages);
}
