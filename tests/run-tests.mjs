/**
 * Run the extension's test suites.
 *
 * `stream-test.ts` and `live-gateway-test.ts` import `@earendil-works/pi-ai`
 * for its types and helpers. At runtime pi injects those packages, but a bare
 * `node` invocation cannot resolve them, so this script links them into a
 * local `node_modules` for the duration of the run and removes it afterwards.
 * Nothing here ships with the plugin — it exists so the tests are
 * reproducible without hand-managing junctions.
 *
 *   node run-tests.mjs            # all suites
 *   node run-tests.mjs smoke      # one suite by prefix
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(HERE);
const LINK_ROOT = join(PROJECT_ROOT, "node_modules", "@earendil-works");

/** pi's bundled copies of the core packages, which extensions borrow. */
const PI_PACKAGE_ROOT = join(
	process.env.APPDATA ?? join(process.env.USERPROFILE ?? "", "AppData", "Roaming"),
	"npm",
	"node_modules",
	"@earendil-works",
	"pi-coding-agent",
);
const PI_PACKAGES = join(PI_PACKAGE_ROOT, "node_modules", "@earendil-works");

const SUITES = [
	{ prefix: "smoke", file: "smoke-test.ts", needsLink: false },
	{ prefix: "routing", file: "routing-test.ts", needsLink: false },
	{ prefix: "login", file: "login-test.ts", needsLink: false },
	{ prefix: "migration", file: "migration-test.ts", needsLink: false },
	{ prefix: "align", file: "align-test.ts", needsLink: true },
	{ prefix: "stream", file: "stream-test.ts", needsLink: true },
	{ prefix: "search", file: "search-test.ts", needsLink: true },
	{ prefix: "live", file: "live-gateway-test.ts", needsLink: true },
	// Opt-in: talks to the real gateway with your own key and spends quota, so
	// it runs only when named explicitly (`node run-tests.mjs loop`).
	{ prefix: "loop", file: "loop-live.ts", needsLink: true, manual: true },
	// Same, for the web tools: `node run-tests.mjs live-search`.
	{ prefix: "live-search", file: "live-search-test.ts", needsLink: true, manual: true },
];

const filter = process.argv[2];
const selected = SUITES.filter((suite) =>
	filter === undefined ? suite.manual !== true : suite.prefix.startsWith(filter),
);

if (selected.length === 0) {
	console.error(`no suite matches "${filter}" (available: ${SUITES.map((s) => s.prefix).join(", ")})`);
	process.exit(1);
}

const needsLink = selected.some((suite) => suite.needsLink);
let createdRoot = false;

if (needsLink) {
	if (!existsSync(PI_PACKAGES)) {
		console.error(`cannot find pi's packages at ${PI_PACKAGES}`);
		process.exit(1);
	}
	mkdirSync(LINK_ROOT, { recursive: true });
	createdRoot = true;
	for (const name of ["pi-ai", "pi-tui"]) {
		const link = join(LINK_ROOT, name);
		if (existsSync(link)) continue;
		const target = join(PI_PACKAGES, name);
		if (!existsSync(target)) continue;
		// A junction needs no elevation on Windows and is what npm/pnpm use.
		symlinkSync(target, link, "junction");
	}
	// `typebox` is host-provided like the pi packages, but it is unscoped, so
	// it needs its own link at the node_modules root — `search.ts` imports
	// `Type` from it to declare the tool parameter schemas.
	const typeboxLink = join(PROJECT_ROOT, "node_modules", "typebox");
	const typeboxTarget = join(PI_PACKAGE_ROOT, "node_modules", "typebox");
	if (!existsSync(typeboxLink) && existsSync(typeboxTarget)) {
		symlinkSync(typeboxTarget, typeboxLink, "junction");
	}
}

let failures = 0;
try {
	for (const suite of selected) {
		console.log(`\n=== ${suite.file} ===`);
		const result = spawnSync(process.execPath, ["--experimental-strip-types", suite.file], {
			cwd: HERE,
			stdio: "inherit",
		});
		if (result.status !== 0) failures += 1;
	}
} finally {
	if (createdRoot) {
		try {
			rmSync(join(PROJECT_ROOT, "node_modules"), { recursive: true, force: true });
		} catch {
			console.log("(note: could not remove the temporary node_modules link)");
		}
	}
}

console.log(failures === 0 ? "\nall suites passed\n" : `\n${failures} suite(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
