/**
 * Verify the two usage panels' bars land in the same DISPLAY column.
 *
 * The OpenCode Go panel renders a row as:
 *   padToWidth(label, 16) + " " + percent.padStart(4) + " " + bar
 * so its bar begins at display column 22. This checks the Command Code panel
 * does the same, so the two widgets line up when stacked.
 *
 * Column positions must be measured in terminal CELLS, not string indices:
 * CJK glyphs occupy two cells each, so indexOf() on a mixed-script row gives a
 * misleading answer.
 *
 *   node --experimental-strip-types align-test.ts
 */
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
	try {
		fn();
		passed += 1;
		console.log(`  ok  ${name}`);
	} catch (error) {
		failed += 1;
		console.error(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}

function padToWidth(text: string, width: number): string {
	const current = visibleWidth(text);
	return current >= width ? text : text + " ".repeat(width - current);
}

/** Strip ANSI colour codes so measurement sees text only. */
function plain(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Display column at which the bar begins (0-based, in terminal cells). */
function barColumn(row: string): number {
	const text = plain(row);
	const index = text.indexOf("█");
	assert.notEqual(index, -1, `no bar in "${text}"`);
	return visibleWidth(text.slice(0, index));
}

// --- the two renderers under test -------------------------------------------

const METRIC_LABEL_WIDTH = 16;

/** Mirror of index.ts's metricRow (Command Code panel), minus colouring. */
function commandCodeRow(label: string, percent: number): string {
	const padded = padToWidth(label, METRIC_LABEL_WIDTH);
	const pct = `${percent}%`.padStart(4);
	return `${padded} ${pct} ${"█".repeat(20)}`;
}

/** Mirror of opencode-go-usage.ts's fmtBucket (OpenCode Go panel). */
function openCodeRow(label: string, percent: number): string {
	const padded = padToWidth(label, 16);
	const num = `${percent}%`.padStart(4);
	return `${padded} ${num} ${"█".repeat(20)}`;
}

console.log("\npanel alignment\n");

test("both panels begin their bar at display column 22", () => {
	const cc = barColumn(commandCodeRow("5 小时", 18));
	const oc = barColumn(openCodeRow("滚动用量 (5h)", 18));
	assert.equal(cc, oc, `Command Code bar at cell ${cc}, OpenCode Go bar at cell ${oc}`);
	assert.equal(cc, 22, "expected the OpenCode Go layout (16 + 1 + 4 + 1)");
});

test("CC metric rows align with each other across differing label scripts", () => {
	const columns = [
		barColumn(commandCodeRow("5 小时", 18)),
		barColumn(commandCodeRow("每周", 26)),
		barColumn(commandCodeRow("请求", 0)),
		barColumn(commandCodeRow("Token", 0)),
	];
	assert.equal(new Set(columns).size, 1, `rows disagreed: ${columns.join(", ")}`);
});

test("a 3-digit percentage does not shift the bar", () => {
	assert.equal(
		barColumn(commandCodeRow("5 小时", 18)),
		barColumn(commandCodeRow("5 小时", 100)),
		"18% and 100% must align",
	);
});

test("labels pad to exactly 16 cells regardless of script", () => {
	for (const label of ["5 小时", "每周", "请求", "Token", "滚动用量 (5h)"]) {
		assert.equal(visibleWidth(padToWidth(label, 16)), 16, `${label} padded wrong`);
	}
});

test("bars are 20 cells wide", () => {
	const row = plain(commandCodeRow("每周", 26));
	const index = row.indexOf("█");
	assert.equal(visibleWidth(row.slice(index)), 20);
});

test("CC and OpenCode rows have the same total width for the same bar", () => {
	assert.equal(
		visibleWidth(plain(commandCodeRow("5 小时", 18))),
		visibleWidth(plain(openCodeRow("滚动用量 (5h)", 18))),
	);
});

console.log(`\n${passed} passed${failed ? `, ${failed} failed` : ""}\n`);
