# 联网搜索方案：是否在 pi-commandcode-provider 里集成

> 结论先行：**在现有 `pi-commandcode-provider` 仓库里做，但作为第二个扩展入口（`./search.ts`）**，
> 不新建独立插件。下面每一条结论都有实测或源码依据。

---

## 零、实现状态（已完成）

按本方案已落地并验证：

| 项 | 位置 |
|---|---|
| 两个工具与客户端（复用凭据链、一手请求头、错误分类、TTL 缓存、401/429 轮换） | `search.ts` |
| 扩展入口注册 | `package.json` → `pi.extensions: ["./index.ts", "./search.ts"]` |
| 单元测试（23 项，注入 fetch，无需 key/网络） | `tests/search-test.ts`，`npm run test:search` |
| 真端点冒烟（manual，消耗额度） | `tests/live-search-test.ts`，`npm run test:live-search` |
| 用户文档 | `README.md` / `README.zh-CN.md` 的「Web search and page fetching / 联网搜索与网页抓取」 |

验证证据：

- `npm test` 全绿：28 + 5 + 18 + 7 + 6 + 20 + **23** + 4 = **111** 项。
- **真机端到端**：`pi -t cc_search,cc_fetch --model commandcode/deepseek/deepseek-v4.1-flash -p "用 cc_search 查…"`
  的会话记录（`~/.pi/agent/sessions/*.jsonl`）里出现 `cc_search` 与 `cc_fetch` 的真实调用，回答带回了来源 URL。
  走的是 `settings.json` 里安装的包清单（两个入口都加载）——即用户的真实使用路径。
- 唯一实现中的实测修正：请求超时定时器原本 `unref()`，导致测试环境下超时永不触发；已改为不 unref
  （每次请求都在 `finally` 里清理），并补了「已中断的 signal 直接失败、飞行中中断归类为 aborted」两个用例。

### 开工前那两个待定问题的答案

1. **搜索是否消耗额度 —— 会，但很小。** 实测（同一把 Go 套餐 key）：调用前后读 `/alpha/billing/credits`，
   两次搜索让 `monthlyCredits` 从 68.9373 降到 68.9303、`fiveHour.used` 与 `weekly.used` 各 +0.007，
   即**约 0.0035 每次**。故默认 `numResults=5` + 10 分钟结果缓存保持不变；文档里已注明会计费。
2. **仓库原有的未提交改动**：未代为提交，工作树保持原样（我的改动叠加在其上）。

### 顺带发现的一个既有问题（与本次改动无关）

`~/.commandcode/models-cache.json` 里是 `"version": 3`（由别的构建/旧版本写入，且带 `apiBase` 字段），
而当前 `catalog.ts` 的 `CACHE_VERSION = 1` → `readCatalogCache()` 判定过期返回 `undefined` →
`preloadFromCache()` 拿到空目录 → **`pi --list-models` 与启动时的 `--model` 解析看不到任何 commandcode 模型**
（要等后台 `catalog.load()` 完成才会注册）。已用 `CatalogClient.load({force:true})` 重写为 v1 缓存，
`pi --list-models` 随即恢复（84 个模型）。若再次出现「模型列表空」，先怀疑这条缓存版本不一致。

---

## 一、调研事实（可验证）

### 1. DSH 那边到底是怎么实现的

`Mars-Sea/dsh-commandcode-provider` 的 `src/web-search.ts` 只做了一件事：
把自己注册成 dsh `ctx.web` 的一个**搜索后端**（provider id `commandcode`），
用**和聊天完全相同的 API key 与 apiBase** 调用 Command Code 的私有路由：

| 项 | 值 |
|---|---|
| 路由 | `POST {apiBase}/alpha/web-search` |
| 请求体 | `{ query, numResults }`（1–10，未给默认 5） |
| 响应 | `{ results: [{ title, url, snippet }] }` |
| 认证头 | `Authorization: Bearer <key>`、`x-command-code-version`、`x-cli-environment: production` |

也就是说：**Command Code 的联网搜索不是另配 key 的服务，而是同一把 key 的 `/alpha/*` 私有端点**。
模型侧看到的仍然是 dsh 内置的 `web_search` 工具，插件只是在"后端选择"这一层把它接过去
（`applyCommandCodeSearchSelection()` 甚至要处理"切换/归还后端"的残留状态）。

### 2. 用你自己的 key 实测（Go 套餐，本机 `~/.commandcode/auth.json`）

| 探测 | 结果 |
|---|---|
| `POST /alpha/web-search {query, numResults:3}` | **HTTP 200**，约 3.5s，返回 `query / results / formatted` |
| 带 `allowedDomains: ["blog.rust-lang.org"]` | 200，结果被限制在该域名（**参数生效**） |
| 带 `blockedDomains` + 中文 query | 200，中文检索正常 |
| `numResults: 50` | **HTTP 400**（服务端拒绝 >10，客户端必须钳到 1–10） |
| 错误 key | **HTTP 401** |
| `POST {apiBase}/alpha/web-fetch` `{url}` | **HTTP 200**，返回 `{content, url, status}` |

**额外发现（DSH 插件没做的部分）**：`/alpha/web-fetch` 也是活的，服务端抓页面并转成可读文本
（实测 GitHub 仓库页 → 35KB markdown 风格正文，6.2s；`maxChars` **被忽略**；不支持 `urls` 数组，传数组 400）。
其它候选路由（`/alpha/fetch`、`/alpha/web/read`、`/alpha/scrape`、`/alpha/web-crawl`、`/alpha/screenshot` 等）全部 404。

### 3. pi 侧的现实（和 DSH 最大的差别）

- **pi 没有可插拔的搜索后端，也没有内置 `web_search`。**
  （在 `@earendil-works/pi-coding-agent@1.0.0` 的 `dist/` 里 grep `web_search` 零命中。）
  所以"接管内置搜索工具"这条路在 pi 上不存在——**必须由扩展 `pi.registerTool()` 自己注册一个工具**。
- pi 的扩展 API 足够用：`registerTool()`、`registerCommand()`、`registerFlag()`、`setActiveTools()`、
  `defaultActive`、`promptSnippet/promptGuidelines`（`dist/core/extensions/types.d.ts`）。
- **工具重名是"先注册者获胜"，而且不报错**：
  `runner.js:410` `getAllRegisteredTools()` —— *"first registration per name wins"*。
  你现在的 `~/.pi/agent/extensions/ds-web-search.ts` 已经占用 `web_search`，`web.ts` 占用 `web_fetch`。
  若新插件也叫 `web_search`，谁先加载谁生效，另一个被**静默丢弃**（取决于扩展加载顺序，不可控）。
- 一个包可以挂多个扩展入口、并按资源单独启停：
  `pi.extensions: ["./index.ts", "./search.ts"]`（`docs/packages.md`），
  `pi config` / 设置里 `packages[].extensions: ["!..."]` 可只禁用其中一个。
- 你的包当前是以**本地路径**安装的：`~/.pi/agent/settings.json` → `"packages": ["G:\\Work\\pi-commandcode-provider"]`，
  改完源码 `/reload` 即生效，无需重新安装。

---

## 二、结论：集成进原插件，但用第二个入口文件

### 为什么不是独立插件

1. **需要的底层能力，原插件已经全有了**，而且都是有坑的部分：

   | 能力 | 现成位置 |
   |---|---|
   | 多账号轮换 / 401、429 健康状态 | `accounts.ts` → `AccountPool.resolveKey()` |
   | 与官方 CLI 一致的第一方请求头（含 `x-command-code-version`、`x-cli-environment`） | `wire.ts` → `cliHeaders()` |
   | CLI 版本从 npm 自刷新（版本过旧网关会 403） | `wire.ts` → `fetchCliVersion()` + `index.ts` 的 `cliVersion` |
   | `apiBase` 配置读取 | `index.ts` → `readConfig()` / `apiBase()` |
   | 错误分类与重试（含"版本过旧冒充 upgrade_required"这个真实陷阱） | `wire.ts` → `CommandCodeHttpError`、`isCliOutOfDateError`、`parseRetryAfterMs`、`commandCodeErrorMessage` |
   | 额度核对 | `usage.ts` → `UsageClient` / `BillingAccessCache` |

   独立插件要么把这些**复制一份**（CC 一改头或版本门槛，搜索就静默坏掉——这正是 README 里已经踩过的坑），
   要么依赖本包；而 pi 的包模型明确说了两条：**别指望两个包共享同一个依赖实例**、
   **跨包依赖必须打进自己的 tarball**（`docs/packages.md`）。独立插件反而更重、更脆。

2. **架构上独立没有任何收益**：DSH 上"独立"有意义是因为它要跟别的搜索后端抢 `ctx.web` 的位置；
   pi 上没有这个位置可抢，功能本质就是"加两个工具"，加在哪个包只影响维护成本。

3. **用户体验**：装了订阅插件的用户，本来就期望"模型 + 联网"一起到手（DSH 版也是这样一个插件全包）。

### 为什么不是直接塞进 `index.ts`

用一个**独立的第二入口 `./search.ts`** 而不是写进 provider 入口，好处是：
- 关注点分离（provider 管模型，search 管工具），`index.ts` 已经 700 行；
- 用户可以在 `pi config` / settings 里**单独禁用搜索**而不影响模型接入（也能反过来）；
- 共享同一份 `accounts.ts` / `wire.ts` / `usage.ts`，无复制、无跨包依赖问题。

### 什么情况下才值得独立成包

只有当你想让**不用这个 provider 的人**也能用 CC 搜索时。但注意：搜索只需要
`~/.commandcode/auth.json` 或 `COMMANDCODE_API_KEY`，和 provider 是不是本包无关——
所以这个场景用本包的工具同样成立，依然不构成独立成包的理由。
真要说独立收益，只剩"独立发版节奏 / 独立 license"，属于次要因素。

---

## 三、实施方案

### 3.1 新增工具（对外契约）

**`cc_search`**（名字可配，理由见 3.3）

| 参数 | 类型 | 说明 |
|---|---|---|
| `query` | string，必填 | 检索词/问题 |
| `num_results` | number，选填，默认 5 | **钳到 1–10**（服务端 >10 直接 400） |
| `allowed_domains` | string[]，选填 | 透传，实测生效 |
| `blocked_domains` | string[]，选填 | 透传 |

返回给模型：`formatted`（服务端给的紧凑摘要）+ 明确的来源 URL 列表（便于接着 `cc_fetch`/`web_fetch` 读全文）；
`details` 里带结构化 `results[{title,url,snippet}]`（供渲染/测试/后续扩展用）。

**`cc_fetch`**（建议一起做，可选开关）

| 参数 | 类型 | 说明 |
|---|---|---|
| `url` | string，必填 | 目标 URL |
| `max_chars` | number，选填，默认 20000 | **客户端截断**（服务端忽略 `maxChars`，实测 35KB 原样返回） |

亮点：服务端抓取 + 正文抽取，比你现在 `web.ts` 里"fetch + 正则去标签"可靠得多（无 CORS/JS/编码/代理问题）。

**不做的**：批量 fetch（`urls` 数组实测 400）。

### 3.2 复用与新增代码

```
search.ts               新增入口（约 250–350 行）
  ├─ 复用 accounts.ts AccountPool.resolveKey()      取 key（含轮换）
  ├─ 复用 wire.ts cliHeaders(key, cwd, cliVersion)  第一方请求头
  ├─ 复用 wire.ts 错误分类 / parseRetryAfterMs
  ├─ 复用 index.ts 的 cliVersion 刷新值（通过注入或共享模块）
  └─ 新增 buildSearchBody / buildFetchBody / clampNumResults / 结果整形 / TTL 缓存
wire.ts                 新增 SEARCH_ROUTE='/alpha/web-search'、FETCH_ROUTE='/alpha/web-fetch'（或放 search.ts）
package.json            pi.extensions 加 "./search.ts"；peerDependencies 加 "typebox": "*"；版本号 +0.1.0
tests/search-test.ts    新增（mock fetch）
tests/run-tests.mjs     注册新套件
tests/search-live-test.ts  新增 manual 套件（打真端点，像 loop-live.ts 那样默认跳过）
README.md / README.zh-CN.md  新增"联网搜索"章节
```

行为约定（对齐你已有的习惯）：

- **凭证**：走 `AccountPool`，401 标记该账号失效、429 按 `Retry-After` 轮换——和聊天请求一致，不另搞一套。
- **版本**：用 `cliVersion`（npm 自刷新）。若命中"CLI 版本过旧"那类 403，提示更新客户端而不是"套餐无权限"。
- **失败不阻塞**：任何错误都以 `isError: true` 的结果返回文字说明（沿用 `ds-web-search.ts` 的风格）。
- **缓存**：按 `(query, num_results, domains)` 做 TTL 缓存，默认 10 分钟，可关（省钱、省额度）。
- **智能跳过**：若当前模型 provider 自带服务端搜索（例如你自己的 `deepseek-responses`），直接回一句
  "无需调用，服务端已检索"——和 `ds-web-search.ts` 里的判断保持一致。
- **提示词**：`promptSnippet` + `promptGuidelines` 说清分工，避免模型乱选：
  - `cc_search`：**快（实测约 3.5s）、纯检索、返回来源**，适合"找最新信息/链接"；
  - `web_search`（你现有的 DS 版）：慢（20–90s）但给**带来源的综合结论**；
  - `cc_fetch` / `web_fetch`：读指定 URL 的正文。

### 3.3 命名与共存（必须处理，否则会静默失效）

因为 **pi 里重名工具先注册者获胜且不报错**，而 `web_search` 已被 `ds-web-search.ts` 占用：

- 默认注册 **`cc_search` / `cc_fetch`**（不叫 `web_search`/`web_fetch`），两者可以并存、各司其职；
- 配置留 `toolName` / `fetchToolName` 覆盖：用户若愿意禁用 `ds-web-search.ts`，可以把它改名为 `web_search` 接管标准名；
- README 里明确写这条规则，避免"我装了但模型看不到"的困惑。

### 3.4 配置与开关

`~/.pi/agent/settings.json`：

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
      "maxContentChars": 20000
    }
  }
}
```

配套：
- `/commandcode-search` 命令：显示状态与上次调用统计、`on|off` 切换（off 走 `pi.setActiveTools()` 会话内停用；
  pi **没有** `unregisterTool`，彻底卸载要 `/reload`——文档里写清楚）；
- `defaultActive: false` 时可用 `defaultTools: ["+cc_search"]` 或 `--tools cc_search` 激活；
- 也可整体用 `pi config` 禁用 `./search.ts` 这个入口（只留模型接入）。

### 3.5 测试

`tests/search-test.ts`（mock fetch，纳入 `npm test`）：

- 请求头集合 == `cliHeaders()` 的输出（防止头漂移，这是最关键的一条）；
- `num_results` 钳制：0→1、50→10、缺省→5；
- `allowedDomains` / `blockedDomains` 原样透传；
- 401 → 账号标记失效并给出可操作文案；429 → 轮换 + `Retry-After`；400 → 不轮换、报参数错误；
- 403 + 版本消息 → 走"客户端过旧"分支而不是"套餐无权限"；
- 响应缺 `results`、非 JSON、超时、abort 各一条；
- `cc_fetch` 客户端截断、`urls` 不支持时的报错；
- 缓存命中/过期。

`tests/search-live-test.ts`（manual，`npm run test:search-live`）：真端点冒烟，断言 200 且来源 URL 非空。

### 3.6 风险与未知（需要你知道的）

| 风险 | 说明 | 应对 |
|---|---|---|
| 路由未公开 | `/alpha/web-search`、`/alpha/web-fetch` 是 CLI 私有端点，CC 可随时改 | 回归测试 + 失败降级为文字说明，不阻塞对话 |
| **是否消耗额度未确认** | DSH 文档没提；我不知道搜索是否计费 | 用现成 `UsageClient` 在调用前后对比 `/alpha/billing/credits` 做一次实验；若有消耗则默认 `numResults` 调小 + 缓存 |
| `web-fetch` 忽略 `maxChars` | 实测 35KB 原样返回 | 客户端截断（默认 20000 字符） |
| 无批量 fetch | `{urls:[...]}` → 400 | 一次一个 URL |
| 版本门槛 | 头里的版本过旧会被网关拒绝（且错误码会伪装成 `upgrade_required`） | 复用 `cliVersion` 自刷新 + `isCliOutOfDateError()` |
| 重名静默丢弃 | 见 3.3 | 不同名字 + 文档 + README 说明 |
| 仓库当前有未提交改动 | `git status` 有 M/?? 若干 | 动手前先提交或开分支 |

### 3.7 工作量

约 **0.5–1 天**：`search.ts` + 测试为主，`index.ts` 基本不用动（除非要把 `cliVersion` 提到共享模块）。
不需要任何新的外部依赖或新 key。

---

## 四、一句话总结

DSH 版是"**换搜索后端**"，pi 版只能"**加搜索工具**"；而加工具所需的一切（key 池、第一方头、版本自刷新、
错误分类）都在 `pi-commandcode-provider` 里现成——所以**集成进原仓库、以 `./search.ts` 第二入口的形式交付**，
默认工具名用 `cc_search`/`cc_fetch` 以避开与现有 `web_search` 的重名陷阱。
