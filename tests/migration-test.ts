/**
 * Verify the startup migration that syncs an existing Command Code key into
 * pi's credential store.
 *
 * Everything runs against temp paths — the developer's real
 * ~/.pi/agent/auth.json and ~/.commandcode/auth.json are never touched.
 *
 *   node --experimental-strip-types migration-test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePiHasKey } from "../login.ts";

const tmp = mkdtempSync(join(tmpdir(), "cc-migration-test-"));
const PI_AUTH = join(tmp, "pi-auth.json");
const CLI_AUTH = join(tmp, "cli-auth.json");

const ENV_NAME = "CC_MIGRATION_TEST_KEY";
delete process.env[ENV_NAME];

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

function reset(options?: { pi?: unknown; cli?: unknown }) {
	rmSync(PI_AUTH, { force: true });
	rmSync(CLI_AUTH, { force: true });
	if (options?.pi !== undefined) writeFileSync(PI_AUTH, JSON.stringify(options.pi), "utf-8");
	if (options?.cli !== undefined) writeFileSync(CLI_AUTH, JSON.stringify(options.cli), "utf-8");
}

const opts = { piAuthPath: PI_AUTH, cliAuthPath: CLI_AUTH, envName: ENV_NAME };

console.log("\nstartup key migration\n");

await test("migrates a key that only exists in the Command Code file", async () => {
	reset({ cli: { apiKey: "user_from_cli" } });
	const migrated = await ensurePiHasKey("commandcode", opts);
	assert.equal(migrated, true, "should report a migration");
	const pi = JSON.parse(readFileSync(PI_AUTH, "utf-8")) as Record<string, { type?: string; key?: string }>;
	assert.equal(pi.commandcode?.type, "api_key");
	assert.equal(pi.commandcode?.key, "user_from_cli");
});

await test("is a no-op when pi already has the key", async () => {
	reset({
		pi: { commandcode: { type: "api_key", key: "user_in_pi" } },
		cli: { apiKey: "user_from_cli" },
	});
	const migrated = await ensurePiHasKey("commandcode", opts);
	assert.equal(migrated, false, "must not overwrite the user's pi key");
	const pi = JSON.parse(readFileSync(PI_AUTH, "utf-8")) as Record<string, { key?: string }>;
	assert.equal(pi.commandcode?.key, "user_in_pi", "pi's key wins");
});

await test("is a no-op when the env var already supplies the key", async () => {
	reset({ cli: { apiKey: "user_from_cli" } });
	process.env[ENV_NAME] = "user_from_env";
	const migrated = await ensurePiHasKey("commandcode", opts);
	assert.equal(migrated, false, "an env var already satisfies pi");
	delete process.env[ENV_NAME];
});

await test("does nothing when there is no key anywhere", async () => {
	reset();
	const migrated = await ensurePiHasKey("commandcode", opts);
	assert.equal(migrated, false);
});

await test("preserves unrelated providers in pi's store", async () => {
	reset({
		pi: { other: { type: "api_key", key: "keep-me" } },
		cli: { apiKey: "user_new" },
	});
	await ensurePiHasKey("commandcode", opts);
	const pi = JSON.parse(readFileSync(PI_AUTH, "utf-8")) as Record<string, { key?: string }>;
	assert.equal(pi.commandcode?.key, "user_new");
	assert.equal(pi.other?.key, "keep-me");
});

await test("treats a blank key as no key", async () => {
	reset({ cli: { apiKey: "   " } });
	assert.equal(await ensurePiHasKey("commandcode", opts), false);
});

await test("survives a corrupt Command Code file", async () => {
	reset();
	writeFileSync(CLI_AUTH, "{ not json", "utf-8");
	assert.equal(await ensurePiHasKey("commandcode", opts), false);
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed${failed ? `, ${failed} failed` : ""}\n`);
