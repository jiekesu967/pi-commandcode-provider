# Command Code provider for pi

[English](./README.md) · **中文**

把 [Command Code](https://commandcode.ai) 接入 pi：模型、浏览器登录、用量面板，以及官方自带的两个网页工具（联网搜索与网页抓取）；包括 **Go 套餐**（该套餐不含 Provider API 权限，只能走 CLI 网关）。

对标 DeepSeek Harness 的 [`@mars-sea/dsh-commandcode-provider`](https://github.com/Mars-Sea/dsh-commandcode-provider)（MIT），后者移植自 [`patlux/pi-commandcode-provider`](https://github.com/patlux/pi-commandcode-provider)（MIT）。

作为 pi 包安装（`pi install`）。改动源码后用 `/reload` 热重载。

## 0.2.0 新增

- **联网搜索与网页抓取** —— `cc_search` / `cc_fetch`，用模型已经在用的同一把订阅密钥，带
  `commandcode.search` 配置段与 `/commandcode-search` 命令。它们放在**第二个扩展入口**
  （`search.ts`）里，因此可以独立于模型 provider 关闭。见[联网搜索与网页抓取](#联网搜索与网页抓取)。
- **提示词与工具重新送达网关**（pi 0.86/1.0）：两种消息形态都认，并为 pi 1.0 打包发行版没有导出的
  两个 transcript helper 提供本地兜底。这就是「模型把工具调用写成文本、工具一次都没跑」的修复。
- **启动不再等网络**：目录从磁盘缓存预热，档位探测限时 400 毫秒，两者都在后台收敛。
- **`COMMANDCODE_DEBUG_DUMP`** 把每次请求体与原始流逐行追加到指定目录 —— 当初定位上述 transcript
  问题靠的就是它，不设该变量时零开销。
- **新套件**：`npm run test:search`（mock，离线），以及手动的 `npm run test:live-search` 与
  `npm run test:loop`（真实网关，会计费/耗额度）。

## 快速开始

```
/commandcode-login        # 选「浏览器登录」自动获取密钥，或手工粘贴
/model commandcode/deepseek/deepseek-v4.1-flash
```

### 浏览器自动登录

`/commandcode-login` 首选**浏览器登录**，流程与官方 `cmd login` 一致：

1. 在 `127.0.0.1` 上从 5959 起找一个空闲端口，绑定回环回调服务；
2. 生成随机 `state` 令牌，打开 `commandcode.ai/studio/auth/cli?callback=…&state=…`；
   登录页签完授权后，会把 `{ apiKey, state, userId, userName, keyName }` POST 回本机回调；
3. 校验 `state` 一致（防伪造 —— 否则本机任何进程都能塞一个 key 进来）；
4. 用 `GET /alpha/whoami` **验证密钥有效后才落盘**，写入 `~/.commandcode/auth.json`。

浏览器会自动打开（Windows 用 `rundll32 url.dll,FileProtocolHandler`，不走 shell —— 授权 URL 带
`&`，经 `cmd /c start` 会重新解析元字符；macOS 用 `open`，Linux 用 `xdg-open`）。URL 同时显示在
对话框里，方便远程 / 无头环境手工复制。**手工粘贴**始终保留为回退路径。

> `oauth` 也注册到了 provider 上，因此 pi 的 `/login commandcode` 同样可用。

#### Go 套餐与"没有 API key"的澄清

有一处常见误解值得写清楚：**Go 套餐不是没有 API key，而是没有 Provider API 权限。**

- 官方 Provider API 文档明确写：*"Every plan except the Go plan has API access."*
- Go 账户请求 `/provider/v1/*` 会拿到 `403 upgrade_required`；
- 但 CLI 网关 `/alpha/generate` **接受同一个 API key**，Go 用户照常能用。

所以浏览器登录拿到的就是普通 `user_...` 密钥，只是必须走 CLI 传输 —— 这正是本插件自动完成的事。
（开发时实测：用无效密钥请求 `/alpha/generate`，服务端返回 `401 UNAUTHORIZED`，证明该端点确实在
按 bearer token 鉴权，而非另有一套订阅凭据。）

**登录后自动生效**：`/commandcode-login` 与 provider 的 `oauth.login` 共用同一条 `runBrowserLogin`
路径，成功后清空传输缓存与档位缓存、重查账单档位并按新档位重新注册 provider —— 于是 Go 套餐
用不到的模型自动从 `/model` 里过滤掉（见 `filterModelsByPlan`）。

### 两个认证存储，缺一不可（实测踩过的坑）

| 文件 | 谁在读 | 作用 |
|---|---|---|
| `~/.pi/agent/auth.json` | **pi 本身** | 判断该 provider 是否"已配置" |
| `~/.commandcode/auth.json` | 本插件的账户池、官方 `cmd` CLI | 实际发请求时的密钥 |

只写后者会出现**最迷惑的故障形态**：请求其实完全能用，但 pi 认为该 provider 未配置，于是
**`/model` 里一个 Command Code 模型都看不到**（`pi --list-models` 也为空）。

因此登录会**同时写两处**；此外插件启动时做一次**一次性迁移**：若账号是在此逻辑存在之前登录的
（或由 `cmd` CLI 直接登录的），启动时自动把密钥同步进 pi 的凭据库，**无需重新登录**。迁移对已有
pi 密钥、或已由 `COMMANDCODE_API_KEY` 供钥的情况是 no-op，不会覆盖你的选择。

### 套餐过滤的时机，以及启动为什么不再等它

档位过滤必须**在首次注册时就正确**，同时启动也不能慢。以前这两件事都在关键路径上 —— 目录拉取
与账单探测各自把一次网络往返加进了每次 TUI 启动 —— 因此拆成了三步：

1. `catalog.preloadFromCache()` 用毫秒级从 `models-cache.json` 预热内存目录，于是
   `pi --list-models` 与启动时的 `--model` 解析**完全不碰网络**也能看到完整目录；
2. 实时目录刷新在后台跑，回来后再注册一次 provider；
3. 档位探测与 **400 毫秒**预算赛跑（`TIER_BOOT_BUDGET_MS`）。按时返回则过滤从第一次注册就生效；
   超时则先以"档位未知"注册 —— 这是**有意**的 fail-open，最终以服务端为准 —— 等答案到达时
   `refreshTier()` 再重新注册。

档位依然重要：`pi --list-models` 这类不触发会话事件的路径会以"档位未知"注册，而未知是 fail-open，
于是把用不了的模型也列出来。实测（档位已知时）Go 账户：69 → **44 个可见**，Provider 档的
`claude-opus-5` 被隐藏，Go 档的 `deepseek/deepseek-v4.1-flash` 保留。

> 加预热时顺带踩到的坑：缓存文件带 `version`，若它由别的构建写入（比如另一个插件写的 v3 文件），
> 就通不过 `CACHE_VERSION` 校验，预热**一条都读不到**，`/model` 会一直空到后台刷新完成。模型列表
> 一旦为空，先怀疑这个文件 —— `~/.commandcode/models-cache.json`；跑一次
> `catalog.load({ force: true })` 就会按当前格式重写。

### 用量面板对齐

两个用量面板（本插件与 `opencode-go-usage.ts`）叠在一起，指标条必须落在同一列。两边都按
**可见列宽**（非字符数）把标签补到 16 列：CJK 字形占两个终端单元格，`"5 小时"` 与 `"每周"`
字符数不同、宽度也不同；百分比跨到三位（`18%` → `100%`）也会把条右移一格，故百分比统一
`padStart(4)`。对齐由 `align-test.ts` 断言 —— 两边的条都从第 22 列开始。

## 双传输：Go 套餐为什么能用

Command Code 官方文档写明「**除 Go 套餐外**每个套餐都有 API 访问权」。Go 账户请求
`/provider/v1/*` 会得到 `403 upgrade_required`。因此本插件按 DSH 版的做法实现双传输：

| 传输 | 端点 | 请求体 | 套餐 |
|---|---|---|---|
| `openai` | `POST {apiBase}/provider/v1/chat/completions` | 扁平 OpenAI 体（历史推理以 `reasoning_content` 回放） | GOAT / Pro / Max / Provider |
| `cli` | `POST {apiBase}/alpha/generate` | CLI 信封 `{config, memory, taste, skills, params, threadId}` | **Go**（含降级） |

流程：先用文档化的 Provider API；只有当它返回 **403 且判定为 Go 套餐门槛**时，才改用
`/alpha/generate` 重放同一轮请求，并记住该 key 的传输选择（15 分钟），后续请求直连 CLI。
若账单缓存已知该账户是 Go 档，则跳过注定失败的 Provider API 尝试。

判定很克制：普通 403（如 `model_not_in_plan`）照常报错，不会误触发降级。

### 一个真实的坑：`upgrade_required` 会假冒

网关对**客户端版本过期**也返回 `error.code = "upgrade_required"` —— 与 Go 套餐门槛**同一个错误码**。
实测（`live-gateway-test.ts` 覆盖）两者只靠文案区分：

```json
{"error":{"code":"upgrade_required",
  "message":"Your Command Code CLI is out of date. Run `cmd update` ...",
  "minVersion":"0.18.10"}}
```

因此：

- `isCliOutOfDateError()` 先把它挑出来，**不**触发传输切换（换传输也治不好版本问题）；
- 提示用户「更新客户端」而不是「套餐无权限」；
- `x-command-code-version` 在启动时从 npm registry 解析当前版本，不再依赖硬编码常量
  （否则下次 Command Code 发版后所有 CLI 传输请求会静默失效，Go 用户直接不可用）。

### 另一个真实的坑：pi 0.86 把系统提示词与工具搬进了消息流

**症状**：让 pi 执行任务时它只吐一段文本就结束了，工具一次都没跑。那段文本是 DeepSeek 的
*文本*工具调用格式（`DSML` 标记包着 `invoke name="Bash"` 之类的调用），看起来像工具调用，
但终究只是文本。

**根因**不在网关，而在请求本身。抓包（`COMMANDCODE_DEBUG_DUMP`）里的请求体是这样的：

```json
{ "params": { "model": "deepseek/deepseek-v4.1-flash", "messages": [...],
              "tools": [], "system": "", "max_tokens": 64000 } }
```

`tools` 是空数组、`system` 是空串 —— 系统提示词和工具声明**根本没发出去**。网关收不到工具，
就退回它自带的 Claude Code 风格脚手架，于是模型改用文本格式"调用工具"；pi 拿到的是一条没有
工具调用的普通回复，一轮就此结束，看上去就是"任务异常终止"。

pi 0.86 改了契约：`Context.systemPrompt` / `Context.tools` 变成只给调用方的**简写**，
`normalizeContext()` 会把它们折叠成一条**开头的 `system` 消息**（带 `content`、`sections`、
`toolsAdded`），provider 拿到的 `TranscriptContext` 里只有 `messages` —— 在这种形态下旧字段永远是空：

| 形态 | 提示词与工具在哪 |
|---|---|
| pi 0.86+ 归一化后的 transcript | 重放它：`getCurrentSystemPrompt(context.messages)` / `getCurrentTools(context.messages)` —— `sections` 按名覆盖、`toolsAdded`/`toolsRemoved` 按序增删 |
| pi 1.0 直接填好字段 | `context.systemPrompt` / `context.tools` |

现在 `systemTextFor()` / `toolsFor()` **两种都认**：字段非空时优先用字段，否则重放 transcript，
因此哪种形态都不会丢提示词。`stream-test.ts` 里 "carries the prompt and tools on the CLI transport
too" 这条回归测试盯的就是这个：它按 pi 的方式先 `normalizeContext()`，再断言 CLI 请求体的
`system` 与 `tools` 非空。工具参数往外发之前会做一次 JSON 往返，因为 typebox schema 带 symbol 键，
`JSON.stringify` 过不去 —— 这也是 `typebox` 成为 peer dependency 的原因。

#### 这两个 helper 在 pi 1.0 的打包发行版里根本取不到

方向对了不等于拿得到。pi 1.0.0 实测：**打包发行版**通过虚拟模块把 `@earendil-works/pi-ai` 暴露给
扩展，其 compat 入口只有 100 个导出，而磁盘上的 `dist/compat.js` 有 127 个；
`getCurrentSystemPrompt` 与 `getCurrentTools` 正在缺失之列，`@earendil-works/pi-ai/utils/transcript`
子路径也没登记进虚拟模块表、解析不了。于是从根命名空间取这两个函数会拿到 `undefined`，
每次请求都以 `getCurrentSystemPrompt is not a function` 失败，整个 provider 直接不可用。

因此 `transcript-compat.ts` 优先使用上游实现，取不到时回退到本地等价实现，语义对齐
`dist/utils/transcript.js` / `dist/utils/text.js`：system 消息内容以空行拼接，`sections` 按名覆盖
（`null` 表示删除），工具集按 `toolsAdded` / `toolsRemoved` 顺序折叠。源码运行、旧版 pi、以及将来
恢复导出的版本都会自动继续走上游，只有这个缺口用回退实现。

> 教训：**provider 收到的永远是归一化后的 `TranscriptContext`**。裸跑测试时若省掉
> `normalizeContext()` 而直接传 `{systemPrompt, tools}`，测的就是一个真实世界里不存在的形状 ——
> 本插件最初正是这样测的，所以这个 bug 一路活到了线上。

## 联网搜索与网页抓取

Command Code 官方 CLI 自带两个网页工具，用的就是模型已经在用的**同一个订阅密钥** —— 不需要另配
搜索密钥、端点或模型：

| 路由 | 请求体 | 响应 |
|---|---|---|
| `POST {apiBase}/alpha/web-search` | `{ query, numResults, allowedDomains?, blockedDomains? }` | `{ results: [{ title, url, snippet }], formatted }` |
| `POST {apiBase}/alpha/web-fetch` | `{ url }` | `{ content, url, status }` |

`/alpha/web-fetch` 在服务端完成转换：HTML 回来时已经是可读的 markdown 风格纯文本。

这两条私有 `/alpha/*` 路由，正是 DSH 插件
[`Mars-Sea/dsh-commandcode-provider`](https://github.com/Mars-Sea/dsh-commandcode-provider) 用作
`web_search` 后端的那两条。但 pi 没有可插拔的搜索后端，也没有内置 `web_search` 工具，所以这里
只能以**两个普通工具**的形式提供，由**第二个扩展入口 `search.ts`** 注册 —— 单独一个入口文件，
正是为了让联网工具能独立于模型 provider 被关掉。

两个工具复用插件现有的整条凭据链，无需任何额外配置：多账户池及其 401/429 轮换、
`commandcode.apiBase` 设置，以及 CLI 的一手请求头（含从 npm 刷新的 `x-command-code-version`）。

### 真实网关实测

用 Go 套餐密钥、走工具用的同一个 client 实测：

| 行为 | 实测结果 |
|---|---|
| 搜索耗时 | 单次查询约 3.5 秒 |
| `allowedDomains` | 生效 —— 返回结果全部来自指定域名 |
| `numResults` | 超过 10 服务端直接返回 `400`，故在客户端夹取到 1–10（默认 5） |
| 无效密钥 | 返回 `401`，随后按与模型传输相同的方式轮换到下一个账户 |
| `web-fetch` 与 `maxChars` | 该端点**忽略** `maxChars`（抓一个 GitHub 页面回来约 35 KB），因此截断改在客户端做（默认 20000 字符） |
| 多个 URL | 传数组会被拒绝 —— 一次调用一个 URL |
| 费用 | 会计费，但很小：实测两次搜索让额度计数与两个用量窗口合计动了 0.007（每次约 0.0035） |

结果还会在进程内缓存：搜索按「查询 + 参数」缓存，抓到的页面按 URL 缓存。默认 TTL 10 分钟，
`cacheTtlMs: 0` 则完全关闭缓存。

### `commandcode.search` 段

写在上面那个 `commandcode` 段里，与其余键并列：

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

- **`enabled` / `fetchEnabled`**：是否注册搜索工具 / 抓取工具。
- **`toolName` / `fetchToolName`**：注册用的工具名（见下）。
- **`activeByDefault`**：注册后是否在会话里默认激活。
- **`numResults` / `allowedDomains` / `blockedDomains`**：调用未指定时用的默认值 —— 工具自己的
  参数优先，结果数始终夹取到 1–10。
- **`cacheTtlMs`**：进程内结果缓存 TTL；`0` 关闭缓存。
- **`maxContentChars`**：抓取页面的客户端截断上限（服务端不认自己的 `maxChars`）。
- **`timeoutMs`**：单次请求超时。
- **`nativeSearchProviders`**：这些 provider 的模型已在服务端自带联网搜索；命中时搜索工具直接
  返回「跳过」提示，不再为同一件事多花一次往返。

### 为什么默认不叫 `web_search` / `web_fetch`

pi 对同名工具**只保留第一次注册**，之后的静默忽略；两个扩展都注册 `web_search` 就是一场由加载
顺序决定胜负的竞争。因此本包注册 `cc_search` 与 `cc_fetch`，以便与你自己的 `web_search` 扩展
共存。反过来也留了口子：把对方扩展关掉，再把 `toolName` / `fetchToolName` 指到标准名即可接管。

### `/commandcode-search`

| 子命令 | 作用 |
|---|---|
| `status`（默认） | 注册状态、端点、缓存条数、默认结果数与最近一次调用 |
| `on` / `off` | 在当前会话启用 / 停用已注册的联网工具 |
| `fetch on` / `fetch off` | 只对抓取工具做同样的切换 |
| `cache` | 清空结果缓存 |

切换走 `pi.setActiveTools()`。pi 在运行时**无法注销**工具，所以关掉只是停用；要彻底移除得 `/reload`。

这些路由是未公开的 CLI 端点而非公开 API，随时可能变化。因此失败一律以建议文本回给模型
（分类后的错误 + 中英双语提示），不抛异常，坏掉的搜索不会卡住这一轮。

本地 mock 套件是 `npm run test:search`（等价于 `node tests/run-tests.mjs search`）；
`npm run test:live-search` 用你自己的密钥直连真实网关，与 `npm run test:loop` 一样只手动跑。

## 配置

写在 `~/.pi/agent/settings.json` 的 `commandcode` 段，全部可选：

```json
{
  "commandcode": {
    "apiBase": "https://api.commandcode.ai",
    "apiKeyEnv": "COMMANDCODE_API_KEY",
    "accounts": [
      { "label": "Go #2", "apiKeyEnv": "COMMANDCODE_API_KEY_2" },
      { "label": "备用",  "apiKey": "user_..." }
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

- **凭据优先级**：`apiKey` 字面量 → `apiKeyEnv` 环境变量 →（仅默认账户）`~/.commandcode/auth.json`。
- **多账户轮换**：429 标记为耗尽、401 标记为失效；全部耗尽时探测 `/alpha/billing/credits`
  的 5 小时窗口，已重置的账户自动复活，无需重启。
- **按模型路由**：`modelAccountRules` 按顺序匹配，第一条命中的生效；被钉住的账户不可用时
  自动回落到常规轮换，不会让请求失败。
- **`filterModelsByPlan`**：默认 `true`，隐藏当前套餐用不到的模型（按账单档位判断）；
  任何不确定的情况都放开显示，最终以服务端为准。

## 命令与面板

| 命令 / 快捷键 | 作用 |
|---|---|
| `/commandcode` | 各账户用量、套餐、5 小时 / 每周窗口 |
| `/commandcode-status` | 账户状态与当前使用的传输（`openai` / `cli` / 自动） |
| `/commandcode-models` | 强制刷新模型目录 |
| `/commandcode-login` | 保存 API key |
| `/commandcode-search` | 联网工具的注册状态、端点、缓存与最近一次调用；`on` / `off` / `fetch on` / `fetch off` / `cache` |
| **alt+c** | 展开 / 收起输入框下方的用量面板（每 60 秒自动刷新，每轮结束即时刷新） |

模型选择器里每个模型都带能力标注：套餐档位、`FREE`/折扣、`Peak`/`Half`（UTC 峰谷）、
`Image`、上下文长度；免费模型排在最前。

## 文件结构

| 文件 | 职责 |
|---|---|
| `index.ts` | 插件入口：provider 注册、命令、用量面板 |
| `search.ts` | 联网工具（`cc_search` / `cc_fetch`）与 `/commandcode-search` 命令 —— 第二个扩展入口，可独立于 provider 关闭 |
| `wire.ts` | 双传输线协议、CLI 伪装头、错误分类、请求体构造 |
| `convert.ts` | pi 消息 → 两种线格式（适配工具调用、长 id、工具结果里的图片） |
| `transcript-compat.ts` | `getCurrentSystemPrompt` / `getCurrentTools` 及本地兜底实现，应对 pi 打包发行版 compat 入口未导出这两个函数的版本 |
| `stream.ts` | 流式引擎：传输降级、事件装配、账户轮换 |
| `login.ts` | 浏览器登录：回环回调、state 校验、whoami 验证、落盘 |
| `accounts.ts` | 账户池：凭据解析、轮换状态、按模型路由 |
| `catalog.ts` | 实时模型目录、磁盘缓存、能力标注、套餐过滤 |
| `usage.ts` | `/alpha/*` 用量与账单查询、Go 档位识别 |
| `capabilities.ts` | 能力快照（**自动生成**，见下） |

### 能力快照的生成

`capabilities.ts` 由 `scripts/extract-capabilities.mjs` 从已安装的 DSH 插件包里**机械提取**，
不手抄（44 组推理档位、50 个 Vision 模型、70 条套餐映射）：

```
npm run capabilities      # 或 node scripts/extract-capabilities.mjs
```

Command Code 发版后模型/套餐/价格有变动时重跑一次即可。

## 测试

```
npm test                  # 全部（111 项）
npm run test:smoke        # 单个套件
```

也可以直接 `node tests/run-tests.mjs [前缀]`。

| 套件 | 覆盖 |
|---|---|
| `smoke-test.ts` | 纯函数：线协议解析、Go 门槛判定（含版本过期反例）、凭据、目录、能力标注 |
| `routing-test.ts` | 按模型路由账户、回落行为 |
| `login-test.ts` | **浏览器登录全链路**：真实回环 HTTP + 模拟浏览器回调；state 伪造、字段缺失、405/404、无效密钥不落盘、拒绝授权、超时、取消、端口占用跳过、双存储写入 |
| `migration-test.ts` | 启动时把既有密钥迁入 pi 凭据库：迁移、no-op（pi 已有钥/环境变量已供钥）、保留其他 provider、空钥与损坏文件 |
| `align-test.ts` | 用量面板对齐：两个面板的指标条同列、CJK/ASCII 标签同宽、三位百分比不位移 |
| `stream-test.ts` | 流式引擎，跑在**本地 mock 网关**上：双传输降级全链路、工具调用、错误分类、轮换、请求整形 |
| `search-test.ts` | 联网工具，跑在注入的 `fetch` 上（无需密钥与网络）：请求头与 `cliHeaders()` **完全一致**、`numResults` 夹取、域名清洗、响应解析与去重、保留服务端 `formatted` 并补上缺失 URL、客户端截断、错误分类、401/429 轮换、缓存命中与 `cacheTtlMs: 0`、超时与取消 |
| `live-gateway-test.ts` | **真实生产网关**：目录可达、两端点存在、CLI 信封通过服务端 schema 校验 |
| `loop-live.ts` | **真实网关 + 真实密钥的两轮工具环**（手动，默认不跑，会计费/耗额度）：归一化上下文 → 结构化工具调用 → 回灌工具结果 → 收尾回答。`npm run test:loop` |
| `live-search-test.ts` | **真实网关 + 真实密钥的联网工具实测**（手动，默认不跑，耗额度）：真实搜索返回可引用的绝对 URL、`allowedDomains` 确实约束索引、服务端抓取返回可读文本、`numResults` 夹取生效。`npm run test:live-search` |

`stream-test.ts` / `live-gateway-test.ts` 需要 `@earendil-works/pi-ai` 的类型；运行时由 pi 注入，
裸跑 node 解析不到，因此 `run-tests.mjs` 会临时建 junction、跑完自行清理 —— 这些都不会随插件发布。

> `loop-live.ts` 标了 `manual`，`npm test` 不会带上它；只有显式 `npm run test:loop` 才跑。
> `live-search-test.ts` 同样标了 `manual`，入口是 `npm run test:live-search`。两者都用你本机凭据
> 直连生产网关，请自行确认额度。

> **已知未覆盖**：真人点浏览器的实际授权（测试用 HTTP 模拟了回调，覆盖了"浏览器真的打开并登录"
> 以外的全部环节）。

> 测试期间 `login-test.ts` / `migration-test.ts` 把所有落盘重定向到临时目录，**不会读写你真实的
> `~/.pi/agent/auth.json` 或 `~/.commandcode/auth.json`**。

### 排障：抓原始线流

网关"回了什么"和"适配器发了什么"经常是两件事。设 `COMMANDCODE_DEBUG_DUMP` 指向一个目录，
每次请求都会把请求体（含解析后的 `options.reasoning`）与**每一行原始流**追加到
`request-<pid>.json` / `stream-<pid>.ndjson`：

```
set COMMANDCODE_DEBUG_DUMP=G:\tmp\cc-dump     # Windows cmd
$env:COMMANDCODE_DEBUG_DUMP="G:\tmp\cc-dump"  # PowerShell
pi --provider commandcode --model deepseek/deepseek-v4.1-flash "调一下 bash"
```

不带这个变量时零开销；抓包失败也绝不会影响请求本身。这也是当初定位"模型把工具调用写成文本"
所用的手段：请求体里 `tools: []` + `system: ""` 一眼可见。

## 卸载

```
pi remove pi-commandcode-provider
```

`~/.pi/agent/auth.json`、`~/.commandcode/auth.json` 与 `capabilities.ts` 快照都不受影响。

## 许可证与致谢

MIT。传输协议与能力快照来自 [Mars-Sea/dsh-commandcode-provider](https://github.com/Mars-Sea/dsh-commandcode-provider)（MIT）
与 [patlux/pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider)（MIT）。

本项目与 Command Code, Inc. 无关；使用需自备 Command Code 账号并遵守其服务条款。
