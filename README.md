# Command Code provider for pi

**English** · [中文](./README.zh-CN.md)

Brings [Command Code](https://commandcode.ai) into pi — the models, browser login, usage panels and
Command Code's own web tools (web search and page fetching) — including the **Go plan**, which has no
Provider API access and can therefore only reach the service through the CLI gateway.

Modelled on DeepSeek Harness's [`@mars-sea/dsh-commandcode-provider`](https://github.com/Mars-Sea/dsh-commandcode-provider) (MIT),
which in turn was ported from [`patlux/pi-commandcode-provider`](https://github.com/patlux/pi-commandcode-provider) (MIT).

Install it as a pi package (`pi install`); after changing the sources, hot-reload with `/reload`.

## What's new in 0.2.0

- **Web search and page fetching** — `cc_search` / `cc_fetch`, running on the same subscription key
  the model already uses, with `commandcode.search` settings and the `/commandcode-search` command.
  They live in a **second extension entry** (`search.ts`) so they can be disabled independently of the
  model provider. See [Web search and page fetching](#web-search-and-page-fetching).
- **The prompt and the tools reach the gateway again** (pi 0.86/1.0): both message shapes are
  understood, and a local fallback covers the two transcript helpers that pi 1.0's packaged build
  fails to export. This is the fix for "the model answers with text tool-calls and no tool ever runs".
- **Startup no longer waits on the network**: the catalog is primed from the on-disk cache and the
  plan-tier probe is capped at 400 ms, both converging in the background.
- **`COMMANDCODE_DEBUG_DUMP`** appends every request body and raw stream line to a directory — the
  capture that pinned the transcript bug, and free when unset.
- **New suites**: `npm run test:search` (mock, offline) plus the manual
  `npm run test:live-search` and `npm run test:loop` (real gateway, spends quota).

## Quick start

```
/commandcode-login        # pick "browser login" to fetch a key automatically, or paste one by hand
/model commandcode/deepseek/deepseek-v4.1-flash
```

### Browser login

`/commandcode-login` prefers **browser login**, following the same flow as the official `cmd login`:

1. Find a free port starting at 5959 on `127.0.0.1` and bind a loopback callback server;
2. Generate a random `state` token and open `commandcode.ai/studio/auth/cli?callback=…&state=…`;
   once the user authorises on that page, it POSTs `{ apiKey, state, userId, userName, keyName }`
   back to the local callback;
3. Verify the `state` matches (anti-forgery — otherwise any local process could push a key in);
4. Call `GET /alpha/whoami` and **only persist the key after it is proven valid**, writing to
   `~/.commandcode/auth.json`.

The browser is opened for you (on Windows via `rundll32 url.dll,FileProtocolHandler` rather than a
shell — the authorisation URL contains `&`, which `cmd /c start` would re-parse as metacharacters;
macOS uses `open`, Linux `xdg-open`). The URL is also shown in the dialog so headless and remote
setups can copy it out. **Pasting a key by hand** always remains available as a fallback.

> `oauth` is registered on the provider too, so pi's `/login commandcode` works as well.

#### The Go plan, and the "no API key" misconception

One thing is worth stating plainly: **the Go plan does not lack an API key — it lacks Provider API
access.**

- The official Provider API docs say it outright: *"Every plan except the Go plan has API access."*
- A Go account requesting `/provider/v1/*` gets `403 upgrade_required`;
- but the CLI gateway `/alpha/generate` **accepts the very same API key**, so Go users are fine.

So browser login hands you an ordinary `user_...` key; it simply has to travel over the CLI
transport — which is precisely what this plugin does for you.
(Observed live while building this: an invalid key against `/alpha/generate` returns
`401 UNAUTHORIZED`, proving that endpoint really does authenticate the bearer token rather than
using a separate subscription credential.)

**Login takes effect immediately**: `/commandcode-login` and the provider's `oauth.login` share one
`runBrowserLogin` path, and on success it clears the transport and plan caches, re-queries the
billing plan, and re-registers the provider at the new plan — so models the Go plan cannot use drop
out of `/model` by themselves (see `filterModelsByPlan`).

### Two credential stores, both required (a pitfall found the hard way)

| File | Who reads it | Purpose |
|---|---|---|
| `~/.pi/agent/auth.json` | **pi itself** | decides whether this provider counts as "configured" |
| `~/.commandcode/auth.json` | this plugin's account pool, and the official `cmd` CLI | the key actually sent with requests |

Writing only the latter produces **the most confusing failure mode there is**: requests work
perfectly, but pi considers the provider unconfigured, so **not a single Command Code model appears
in `/model`** (`pi --list-models` is empty too).

Login therefore writes **both** files. On top of that the plugin performs a **one-time migration**
at startup: if an account was logged in before this logic existed (or was logged in directly by the
`cmd` CLI), the key is synced into pi's credential store automatically — **no re-login needed**. The
migration is a no-op when pi already holds a key, or when `COMMANDCODE_API_KEY` supplies one, so it
never overrides your choice.

### When plan filtering runs, and why startup no longer waits for it

The plan filter has to be right **at the first registration**, and startup also has to stay fast.
Both used to sit on the critical path — the catalog fetch and the billing probe each added their
network round-trip to every TUI start — so the work was split:

1. `catalog.preloadFromCache()` primes the in-memory catalog from `models-cache.json` in
   milliseconds, so `pi --list-models` and startup `--model` resolution see the whole catalog with
   **no network at all**;
2. the live catalog refresh runs in the background and re-registers the provider when it lands;
3. the plan-tier probe races a **400 ms** budget (`TIER_BOOT_BUDGET_MS`). If it answers in time, the
   filter applies to the very first registration; if it does not, registration proceeds with the tier
   unknown — which fails open **deliberately**, since the server is the final gate — and
   `refreshTier()` re-registers once the answer arrives.

The tier still matters, because paths that never fire a session event (`pi --list-models`) would
otherwise register with "plan unknown", and unknown fails open, listing models the subscription
cannot use. Measured on a Go account once the tier is known: 69 → **44 visible**, the Provider-tier
`claude-opus-5` hidden, the Go-tier `deepseek/deepseek-v4.1-flash` kept.

> Pitfall found while adding the preload: the cache file carries a `version`, and one written by a
> different build (a v3 file from another plugin, say) fails the `CACHE_VERSION` check, so preloading
> yields *nothing* and `/model` stays empty until the background refresh finishes. If the model list
> is ever empty, suspect that file first — `~/.commandcode/models-cache.json`; one
> `catalog.load({ force: true })` rewrites it in the current shape.

### Usage panel alignment

The two usage panels (this plugin's and `opencode-go-usage.ts`) are stacked, so their metric bars
have to start in the same column. Both pad labels to 16 columns by **visible width**, not character
count: CJK glyphs occupy two terminal cells, so `"5 小时"` and `"每周"` differ in both character and
display width; a percentage crossing into three digits (`18%` → `100%`) would also shove the bar one
cell right, so percentages are `padStart(4)`. The alignment is asserted by `align-test.ts` — both
bars start at column 22.

## Dual transport: why the Go plan works

Command Code's own documentation states that **every plan except Go** has API access. A Go account
requesting `/provider/v1/*` receives `403 upgrade_required`. This plugin therefore implements the
same dual transport as the DSH version:

| Transport | Endpoint | Body | Plans |
|---|---|---|---|
| `openai` | `POST {apiBase}/provider/v1/chat/completions` | flat OpenAI body (prior reasoning replayed as `reasoning_content`) | GOAT / Pro / Max / Provider |
| `cli` | `POST {apiBase}/alpha/generate` | CLI envelope `{config, memory, taste, skills, params, threadId}` | **Go** (and as fallback) |

The flow: try the documented Provider API first, and only when it returns **403 judged to be the Go
plan gate** replay the same turn against `/alpha/generate`, remembering that key's transport choice
for 15 minutes so subsequent requests go straight to the CLI. If the billing cache already knows the
account is on the Go tier, the doomed Provider API attempt is skipped entirely.

The judgement is deliberately narrow: an ordinary 403 (say `model_not_in_plan`) is reported as an
error and does not trigger the fallback.

### A real trap: `upgrade_required` can be an impostor

The gateway also returns `error.code = "upgrade_required"` when the **client version is stale** —
the same error code as the Go plan gate. In practice (covered by `live-gateway-test.ts`) the two are
distinguishable only by their message text:

```json
{"error":{"code":"upgrade_required",
  "message":"Your Command Code CLI is out of date. Run `cmd update` ...",
  "minVersion":"0.18.10"}}
```

Therefore:

- `isCliOutOfDateError()` singles it out first and does **not** trigger a transport switch
  (switching transports cannot cure a version problem);
- the user is told to "update the client", not "your plan has no access";
- `x-command-code-version` resolves the current version from the npm registry at startup instead of
  a hardcoded constant (otherwise every CLI-transport request would silently break the next time
  Command Code ships a release, leaving Go users with nothing).

### Another real trap: pi 0.86 moved the prompt and the tools into the message stream

**Symptom**: ask pi to do something on this provider and it prints one paragraph and stops. No tool
ever runs. The paragraph is DeepSeek's *text* tool-call syntax — a `DSML`-marked block wrapping
`invoke name="Bash"` — which looks like a tool call but is only text.

**The cause** was not the gateway but the request. A wire capture (`COMMANDCODE_DEBUG_DUMP`) shows:

```json
{ "params": { "model": "deepseek/deepseek-v4.1-flash", "messages": [...],
              "tools": [], "system": "", "max_tokens": 64000 } }
```

`tools` is an empty array and `system` is an empty string: the prompt and the tool declarations never
left the client. With no tools to call, the gateway fell back to its own Claude-Code-flavoured
harness, the model answered in text-mode tool syntax, and pi — seeing no tool call — ended the turn.

pi 0.86 changed the contract: `Context.systemPrompt` / `Context.tools` became **shorthand for
callers**; `normalizeContext()` folds them into a leading `system` **message** (`content`, `sections`,
`toolsAdded`), and the provider receives a `TranscriptContext` whose only field is `messages` — so on
that shape the old fields always read empty:

| Shape | Where the prompt and the tools are |
|---|---|
| pi 0.86+ normalized transcript | replay it: `getCurrentSystemPrompt(context.messages)` / `getCurrentTools(context.messages)` — `sections` patched by name, `toolsAdded`/`toolsRemoved` applied, in order |
| pi 1.0 fields populated directly | `context.systemPrompt` / `context.tools` |

`systemTextFor()` / `toolsFor()` now accept **both**: they prefer the context fields when they are
non-empty and otherwise replay the transcript, so neither shape loses the prompt. The regression test
"carries the prompt and tools on the CLI transport too" pins this down: it builds the context with
`normalizeContext()` the way pi does, then asserts the CLI body's `system` and `tools` are non-empty.
Tool parameters are JSON round-tripped on the way out because typebox schemas carry symbol keys that
`JSON.stringify` does not survive — which is why `typebox` is a peer dependency.

#### Those two helpers are missing from pi 1.0's packaged build

Being the right call does not make them reachable. Observed on pi 1.0.0: the **packaged release**
exposes `@earendil-works/pi-ai` to extensions through a virtual module whose compat entry carries 100
exports against 127 in the `dist/compat.js` on disk. `getCurrentSystemPrompt` and `getCurrentTools`
are among the missing ones, the `@earendil-works/pi-ai/utils/transcript` subpath is absent from the
virtual module table and so will not resolve either, and taking the two off the root namespace yields
`undefined` — every request then dies with `getCurrentSystemPrompt is not a function`, which takes the
provider down completely.

`transcript-compat.ts` therefore prefers the upstream implementation and falls back to a local
equivalent that follows `dist/utils/transcript.js` / `dist/utils/text.js` semantics: system message
contents joined with a blank line, `sections` overwritten by name (`null` deleting one), tool sets
folded in `toolsAdded` / `toolsRemoved` order. A source run, an older pi, and a future release that
restores the exports all keep using upstream automatically; only the gap uses the fallback.

> Lesson: **a provider always sees a normalized `TranscriptContext`.** A test that skips
> `normalizeContext()` and passes `{systemPrompt, tools}` directly exercises a shape no real request
> has — which is how this bug survived until it hit production.

## Web search and page fetching

Command Code's official CLI has two built-in web tools, and both are reachable with the **same
subscription key the model already uses** — no separate search key, endpoint or model:

| Route | Body | Response |
|---|---|---|
| `POST {apiBase}/alpha/web-search` | `{ query, numResults, allowedDomains?, blockedDomains? }` | `{ results: [{ title, url, snippet }], formatted }` |
| `POST {apiBase}/alpha/web-fetch` | `{ url }` | `{ content, url, status }` |

`/alpha/web-fetch` converts the page server-side, so HTML comes back as readable markdown-style
text rather than markup.

These are the same private `/alpha/*` routes the DSH plugin
[`Mars-Sea/dsh-commandcode-provider`](https://github.com/Mars-Sea/dsh-commandcode-provider) uses for
its `web_search` backend. pi, by contrast, has no pluggable search backend and no built-in
`web_search` tool, so here the capability has to arrive as **two ordinary tools registered by a
second extension entry, `search.ts`** — an entry of its own precisely so the web tools can be
disabled independently of the model provider.

Both tools reuse the plugin's existing credential chain and nothing else has to be configured: the
multi-account pool with its 401/429 rotation, the `commandcode.apiBase` setting, and the CLI's
first-party header set — including the `x-command-code-version` that is refreshed from npm.

### Measured against the live gateway

Observed with a Go-plan key, through the same client the tools use:

| Behaviour | Observation |
|---|---|
| Search latency | answers in ~3.5 s per query |
| `allowedDomains` | honoured — every result came back from the named domains |
| `numResults` | anything above 10 is rejected by the server with a bare `400`, so it is clamped client-side into 1–10 (default 5) |
| Bad key | `401`, which rotates to the next account exactly like the model transport |
| `web-fetch` and `maxChars` | the endpoint ignores `maxChars` (a GitHub page came back as ~35 KB), so truncation happens client-side (default 20000 characters) |
| Multiple URLs | an array of URLs is rejected — one URL per call |
| Cost | metered, but small: two searches moved the credit counter and both usage windows by 0.007 in total (~0.0035 each) |

Results are also cached in-process: a search by query plus its parameters, a fetched page by URL.
The default TTL is 10 minutes, and `cacheTtlMs: 0` disables caching entirely.

### The `commandcode.search` block

It sits under the existing `commandcode` section, next to the keys above:

```json
{
  "commandcode": {
    "search": {
      "enabled": true,
      "fetchEnabled": true,
      "toolName": "cc_search",
      "fetchToolName": "cc_fetch",
      "activeByDefault": true,
      "numResults": 5,
      "allowedDomains": [],
      "blockedDomains": [],
      "cacheTtlMs": 600000,
      "maxContentChars": 20000,
      "timeoutMs": 60000,
      "nativeSearchProviders": ["deepseek-responses"]
    }
  }
}
```

- **`enabled` / `fetchEnabled`**: whether the search / fetching tool is registered at all.
- **`toolName` / `fetchToolName`**: the names it is registered under (see below).
- **`activeByDefault`**: whether a registered tool starts active in a session.
- **`numResults` / `allowedDomains` / `blockedDomains`**: the values used when a call names none — the
  tool's own parameters still win, and the count is always clamped into 1–10.
- **`cacheTtlMs`**: in-process result cache TTL; `0` disables the cache.
- **`maxContentChars`**: client-side truncation cap for a fetched page, since the server ignores its
  own `maxChars`.
- **`timeoutMs`**: per-request timeout.
- **`nativeSearchProviders`**: providers whose models already search server-side. On such a provider
  the search tool answers with a "skipped" note instead of spending a second round-trip on the same
  query.

### Why the tools are not called `web_search` / `web_fetch`

pi keeps the **first** registration per tool name and silently ignores later ones, so two extensions
both registering `web_search` would race, with the winner decided by load order. This package
therefore registers `cc_search` and `cc_fetch`, which lets it coexist with a user's own `web_search`
extension. `toolName` / `fetchToolName` are there for the other direction: disable the competing
extension and point them at the standard names to take those over.

### `/commandcode-search`

| Subcommand | Effect |
|---|---|
| `status` (default) | registration state, endpoint, cache size, default result count and the last call |
| `on` / `off` | activate / deactivate the registered web tools for the current session |
| `fetch on` / `fetch off` | the same for the fetching tool alone |
| `cache` | clear the result cache |

Activation goes through `pi.setActiveTools()`. pi has no way to **unregister** a tool at runtime, so
switching one off only deactivates it; removing it from the session entirely takes `/reload`.

These are undocumented CLI routes, not a public API, and they can change without notice. Failures are
therefore reported to the model as advisory text — the classified error plus a bilingual hint —
rather than thrown, so a broken search never blocks the turn.

The mock suite is `npm run test:search` (equivalently `node tests/run-tests.mjs search`).
`npm run test:live-search` hits the real gateway with your own key and is manual-only, like
`npm run test:loop`.

## Configuration

Everything lives under the `commandcode` section of `~/.pi/agent/settings.json`; all keys optional:

```json
{
  "commandcode": {
    "apiBase": "https://api.commandcode.ai",
    "apiKeyEnv": "COMMANDCODE_API_KEY",
    "accounts": [
      { "label": "Go #2", "apiKeyEnv": "COMMANDCODE_API_KEY_2" },
      { "label": "backup", "apiKey": "user_..." }
    ],
    "activeAccount": "COMMANDCODE_API_KEY_2",
    "modelAccountRules": [
      { "models": ["deepseek/deepseek-v4-pro"], "account": "COMMANDCODE_API_KEY_2" }
    ],
    "filterModelsByPlan": true,
    "visibleModels": [],
    "modelsCachePath": "~/.commandcode/models-cache.json",
    "requestTimeoutMs": 60000,
    "streamIdleTimeoutMs": 300000
  }
}
```

- **Credential precedence**: literal `apiKey` → `apiKeyEnv` environment variable → (default account
  only) `~/.commandcode/auth.json`.
- **Multi-account rotation**: 429 marks an account exhausted, 401 marks it invalid; when everything
  is exhausted the 5-hour window on `/alpha/billing/credits` is probed and reset accounts come back
  to life without a restart.
- **Per-model routing**: `modelAccountRules` matches in order and the first hit wins; if the pinned
  account is unavailable the request falls back to normal rotation instead of failing.
- **`filterModelsByPlan`**: defaults to `true` and hides models the current plan cannot use (judged
  by billing tier); anything uncertain stays visible, and the server has the final say.

## Commands and panels

| Command / shortcut | Effect |
|---|---|
| `/commandcode` | usage per account, plan, 5-hour / weekly windows |
| `/commandcode-status` | account status and the transport in use (`openai` / `cli` / auto) |
| `/commandcode-models` | force a refresh of the model catalogue |
| `/commandcode-login` | save an API key |
| `/commandcode-search` | registration, endpoints, cache and last call for the web tools; `on` / `off` / `fetch on` / `fetch off` / `cache` |
| **alt+c** | expand / collapse the usage panel under the input box (refreshes every 60 s, and immediately after each turn) |

Every model in the picker carries capability annotations: plan tier, `FREE`/discounted,
`Peak`/`Half` (UTC peak/off-peak), `Image`, and context length; free models sort first.

## Project layout

| File | Responsibility |
|---|---|
| `index.ts` | plugin entry: provider registration, commands, usage panel |
| `search.ts` | web tools (`cc_search` / `cc_fetch`) and the `/commandcode-search` command — a second extension entry, so they can be disabled apart from the provider |
| `wire.ts` | dual-transport wire protocol, CLI impostor headers, error classification, request bodies |
| `convert.ts` | pi messages → both wire formats (tool calls, long ids, images inside tool results) |
| `transcript-compat.ts` | `getCurrentSystemPrompt` / `getCurrentTools` with a local fallback, for pi builds whose packaged compat entry does not export them |
| `stream.ts` | streaming engine: transport fallback, event assembly, account rotation |
| `login.ts` | browser login: loopback callback, state validation, whoami verification, persistence |
| `accounts.ts` | account pool: credential resolution, rotation state, per-model routing |
| `catalog.ts` | live model catalogue, disk cache, capability annotations, plan filtering |
| `usage.ts` | `/alpha/*` usage and billing queries, Go-tier detection |
| `capabilities.ts` | capability snapshot (**generated**, see below) |

### How the capability snapshot is produced

`capabilities.ts` is **mechanically extracted** from an installed DSH plugin package by
`scripts/extract-capabilities.mjs` rather than copied by hand (44 reasoning-effort sets, 50 vision
models, 70 plan mappings):

```
npm run capabilities      # or: node scripts/extract-capabilities.mjs
```

Re-run it whenever a Command Code release changes models, plans, or pricing.

## Tests

```
npm test                  # everything (111 checks)
npm run test:smoke        # a single suite
```

You can also run `node tests/run-tests.mjs [prefix]` directly.

| Suite | Coverage |
|---|---|
| `smoke-test.ts` | pure functions: wire parsing, Go-gate detection (including the stale-version counterexample), credentials, catalogue, capability annotations |
| `routing-test.ts` | per-model account routing and fallback behaviour |
| `login-test.ts` | **the whole browser-login path**: a real loopback HTTP server plus a simulated browser callback; forged state, missing fields, 405/404, invalid keys not persisted, denied authorisation, timeout, cancellation, occupied ports skipped, both stores written |
| `migration-test.ts` | migrating an existing key into pi's credential store at startup: migration, no-ops (pi already has a key / env var supplies one), other providers preserved, empty and corrupt files |
| `align-test.ts` | usage-panel alignment: both panels' bars in the same column, CJK/ASCII labels equally wide, three-digit percentages not shifting the bar |
| `stream-test.ts` | the streaming engine against a **local mock gateway**: the full dual-transport fallback path, tool calls, error classification, rotation, request shaping |
| `search-test.ts` | the web tools against an injected `fetch` (no key, no network): headers **exactly** `cliHeaders()`'s set, `numResults` clamping, domain cleanup, payload parsing and dedup, the server's `formatted` block kept with missing URLs appended, client-side truncation, error classification, 401/429 rotation, cache hits and `cacheTtlMs: 0`, timeout and abort |
| `live-gateway-test.ts` | the **real production gateway**: catalogue reachable, both endpoints present, CLI envelope accepted by the server's schema |
| `loop-live.ts` | **real gateway, real key, two-turn tool loop** (manual; never part of `npm test`, spends quota): normalized context → structured tool call → tool result fed back → closing answer. Run with `npm run test:loop` |
| `live-search-test.ts` | **real gateway, real key, the web tools** (manual; never part of `npm test`, spends quota): a live search returning citable absolute URLs, `allowedDomains` constraining the index, a server-side page fetch coming back as readable text, and the clamped `numResults`. Run with `npm run test:live-search` |

`stream-test.ts` / `live-gateway-test.ts` need the types from `@earendil-works/pi-ai`; pi injects
them at runtime but a bare node run cannot resolve them, so `run-tests.mjs` creates a junction
temporarily and removes it afterwards — none of that ships with the plugin.

> `loop-live.ts` is marked `manual`, so `npm test` skips it; only an explicit `npm run test:loop`
> runs it. `live-search-test.ts` is marked the same way and takes `npm run test:live-search`. Both
> talk to the production gateway with your own credentials — mind your quota.

> **Known gap**: a human actually authorising in a browser — the tests simulate the callback over
> HTTP, covering everything except the browser genuinely opening and logging in.

> During tests `login-test.ts` / `migration-test.ts` redirect every write to a temporary directory,
> so they **never touch your real `~/.pi/agent/auth.json` or `~/.commandcode/auth.json`**.

### Debugging: capture the raw wire

What the gateway returned and what the adapter sent are often two different stories. Point
`COMMANDCODE_DEBUG_DUMP` at a directory and every request appends its body (including the resolved
`options.reasoning`) plus **every raw stream line** to `request-<pid>.json` / `stream-<pid>.ndjson`:

```
set COMMANDCODE_DEBUG_DUMP=G:\tmp\cc-dump     # Windows cmd
$env:COMMANDCODE_DEBUG_DUMP="G:\tmp\cc-dump"  # PowerShell
pi --provider commandcode --model deepseek/deepseek-v4.1-flash "run something in bash"
```

Zero cost when the variable is unset, and a failed capture never affects the request. This is what
pinned the bug above: `tools: []` and `system: ""` were visible at a glance.

## Uninstall

```
pi remove pi-commandcode-provider
```

`~/.pi/agent/auth.json`, `~/.commandcode/auth.json` and the `capabilities.ts` snapshot are all left
untouched.

## Licence and credits

MIT. The transport protocol and capability snapshot come from
[Mars-Sea/dsh-commandcode-provider](https://github.com/Mars-Sea/dsh-commandcode-provider) (MIT) and
[patlux/pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider) (MIT).

This project is not affiliated with Command Code, Inc.; using it requires your own Command Code
account and compliance with their terms of service.
