/**
 * Verification for per-model account routing (`modelAccountRules`), the one
 * DSH feature added after the main suites were written.
 *
 *   node --experimental-strip-types routing-test.ts
 */
import assert from "node:assert/strict";
import { AccountPool, matchModelRule, selectAccountForModel } from "../accounts.ts";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
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

console.log("\nper-model account routing");

await test("matches the first rule that lists the model", () => {
	const rules = [
		{ models: ["m-pro", "m-flash"], account: "B" },
		{ models: ["m-pro"], account: "C" },
	];
	assert.equal(matchModelRule("m-pro", rules)?.account, "B", "first match wins");
	assert.equal(matchModelRule("m-flash", rules)?.account, "B");
	assert.equal(matchModelRule("m-other", rules), undefined);
	assert.equal(matchModelRule("m-pro", []), undefined);
});

await test("selectAccountForModel respects usability", () => {
	const accounts = [
		{ slot: { id: "A", label: "A", allowAuthFile: false }, key: "ka", state: undefined },
		{
			slot: { id: "B", label: "B", allowAuthFile: false },
			key: "kb",
			state: { kind: "disabled" as const, reason: "401" },
		},
	];
	// A rule pointing at a healthy account resolves.
	assert.equal(selectAccountForModel(accounts, "m", [{ models: ["m"], account: "A" }])?.key, "ka");
	// A rule pointing at a disabled account yields undefined so the caller
	// falls back to normal rotation instead of failing.
	assert.equal(selectAccountForModel(accounts, "m", [{ models: ["m"], account: "B" }]), undefined);
	// A rule naming an unknown slot is ignored too.
	assert.equal(selectAccountForModel(accounts, "m", [{ models: ["m"], account: "ZZ" }]), undefined);
});

await test("pinned models use their account; unpinned ones rotate normally", async () => {
	process.env.CC_TEST_KEY_R1 = "key-r1";
	process.env.CC_TEST_KEY_R2 = "key-r2";
	const pool = new AccountPool(
		() => [
			{ id: "A", label: "A", apiKeyEnv: "CC_TEST_KEY_R1", allowAuthFile: false },
			{ id: "B", label: "B", apiKeyEnv: "CC_TEST_KEY_R2", allowAuthFile: false },
		],
		() => undefined,
		async () => ({ exceeded: true, resetAt: Date.now() + 60_000 }),
		() => [{ models: ["m-pinned"], account: "B" }],
	);

	// The pinned model uses B even though A is first in rotation order.
	assert.equal((await pool.resolveKey({ model: "m-pinned" }))?.key, "key-r2");
	// An unpinned model still follows rotation order.
	assert.equal((await pool.resolveKey({ model: "m-other" }))?.key, "key-r1");
	// With no model supplied, rotation order applies.
	assert.equal((await pool.resolveKey())?.key, "key-r1");

	delete process.env.CC_TEST_KEY_R1;
	delete process.env.CC_TEST_KEY_R2;
});

await test("falls back to rotation when the pinned account is exhausted", async () => {
	process.env.CC_TEST_KEY_R3 = "key-r3";
	process.env.CC_TEST_KEY_R4 = "key-r4";
	const pool = new AccountPool(
		() => [
			{ id: "A", label: "A", apiKeyEnv: "CC_TEST_KEY_R3", allowAuthFile: false },
			{ id: "B", label: "B", apiKeyEnv: "CC_TEST_KEY_R4", allowAuthFile: false },
		],
		() => undefined,
		async () => ({ exceeded: true, resetAt: Date.now() + 60_000 }),
		() => [{ models: ["m-pinned"], account: "B" }],
	);

	assert.equal((await pool.resolveKey({ model: "m-pinned" }))?.key, "key-r4");
	// A 429 on the pinned account must not break the request: the next
	// resolution falls back to another usable account.
	pool.markRejected("key-r4", "rate-limit");
	assert.equal((await pool.resolveKey({ model: "m-pinned" }))?.key, "key-r3");

	delete process.env.CC_TEST_KEY_R3;
	delete process.env.CC_TEST_KEY_R4;
});

await test("an explicit prefer-account still applies to unpinned models", async () => {
	process.env.CC_TEST_KEY_R5 = "key-r5";
	process.env.CC_TEST_KEY_R6 = "key-r6";
	const pool = new AccountPool(
		() => [
			{ id: "A", label: "A", apiKeyEnv: "CC_TEST_KEY_R5", allowAuthFile: false },
			{ id: "B", label: "B", apiKeyEnv: "CC_TEST_KEY_R6", allowAuthFile: false },
		],
		() => "B",
		async () => ({ exceeded: true, resetAt: Date.now() + 60_000 }),
		() => [],
	);
	assert.equal((await pool.resolveKey({ model: "anything" }))?.key, "key-r6");
	delete process.env.CC_TEST_KEY_R5;
	delete process.env.CC_TEST_KEY_R6;
});

console.log(`\n${passed} passed${failed ? `, ${failed} failed` : ""}\n`);
