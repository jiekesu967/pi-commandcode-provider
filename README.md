# Command Code provider for pi

**English** · [中文](./README.zh-CN.md)

Brings [Command Code](https://commandcode.ai) into pi — including the **Go plan**, which has no
Provider API access and can therefore only reach the service through the CLI gateway.

Modelled on DeepSeek Harness's [`@mars-sea/dsh-commandcode-provider`](https://github.com/Mars-Sea/dsh-commandcode-provider) (MIT),
which in turn was ported from [`patlux/pi-commandcode-provider`](https://github.com/patlux/pi-commandcode-provider) (MIT).

Install it as a pi package (`pi install`); after changing the sources, hot-reload with `/reload`.

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

### When plan filtering runs

The plan lookup must complete **before the first model registration**. Otherwise paths that never
fire a session event — `pi --list-models`, for instance — register with "plan unknown", and unknown
fails open, so unusable models get listed too. Measured on a Go account: 69 → **44 visible**, the
Provider-tier `claude-opus-5` hidden, the Go-tier `deepseek/deepseek-v4.1-flash` kept.

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
| **alt+c** | expand / collapse the usage panel under the input box (refreshes every 60 s, and immediately after each turn) |

Every model in the picker carries capability annotations: plan tier, `FREE`/discounted,
`Peak`/`Half` (UTC peak/off-peak), `Image`, and context length; free models sort first.

## Project layout

| File | Responsibility |
|---|---|
| `index.ts` | plugin entry: provider registration, commands, usage panel |
| `wire.ts` | dual-transport wire protocol, CLI impostor headers, error classification, request bodies |
| `convert.ts` | pi messages → both wire formats (tool calls, long ids, images inside tool results) |
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
npm test                  # everything (87 checks)
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
| `live-gateway-test.ts` | the **real production gateway**: catalogue reachable, both endpoints present, CLI envelope accepted by the server's schema |

`stream-test.ts` / `live-gateway-test.ts` need the types from `@earendil-works/pi-ai`; pi injects
them at runtime but a bare node run cannot resolve them, so `run-tests.mjs` creates a junction
temporarily and removes it afterwards — none of that ships with the plugin.

> **Known gaps**: (1) an end-to-end conversation with a real key — this round verified billing-tier
> lookup and model filtering with a real key, but "send a message, get a reply" has not been run;
> (2) a human actually authorising in a browser — the tests simulate the callback over HTTP, covering
> everything except the browser genuinely opening and logging in.

> During tests `login-test.ts` / `migration-test.ts` redirect every write to a temporary directory,
> so they **never touch your real `~/.pi/agent/auth.json` or `~/.commandcode/auth.json`**.

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
