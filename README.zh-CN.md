# Command Code provider for pi

[English](./README.md) · **中文**

把 [Command Code](https://commandcode.ai) 接入 pi，包括 **Go 套餐**（该套餐不含 Provider API 权限，只能走 CLI 网关）。

对标 DeepSeek Harness 的 [`@mars-sea/dsh-commandcode-provider`](https://github.com/Mars-Sea/dsh-commandcode-provider)（MIT），后者移植自 [`patlux/pi-commandcode-provider`](https://github.com/patlux/pi-commandcode-provider)（MIT）。

作为 pi 包安装（`pi install`）。改动源码后用 `/reload` 热重载。

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

### 套餐过滤的时机

档位查询必须**在首次注册模型之前**完成。否则 `pi --list-models` 这类不触发会话事件的路径会以
"档位未知"注册，而未知是 fail-open，于是把用不了的模型也列出来。实测 Go 账户：69 → **44 个可见**，
Provider 档的 `claude-opus-5` 被隐藏，Go 档的 `deepseek/deepseek-v4.1-flash` 保留。

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
| **alt+c** | 展开 / 收起输入框下方的用量面板（每 60 秒自动刷新，每轮结束即时刷新） |

模型选择器里每个模型都带能力标注：套餐档位、`FREE`/折扣、`Peak`/`Half`（UTC 峰谷）、
`Image`、上下文长度；免费模型排在最前。

## 文件结构

| 文件 | 职责 |
|---|---|
| `index.ts` | 插件入口：provider 注册、命令、用量面板 |
| `wire.ts` | 双传输线协议、CLI 伪装头、错误分类、请求体构造 |
| `convert.ts` | pi 消息 → 两种线格式（适配工具调用、长 id、工具结果里的图片） |
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
npm test                  # 全部（87 项）
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
| `live-gateway-test.ts` | **真实生产网关**：目录可达、两端点存在、CLI 信封通过服务端 schema 校验 |

`stream-test.ts` / `live-gateway-test.ts` 需要 `@earendil-works/pi-ai` 的类型；运行时由 pi 注入，
裸跑 node 解析不到，因此 `run-tests.mjs` 会临时建 junction、跑完自行清理 —— 这些都不会随插件发布。

> **已知未覆盖**：①带真实密钥的端到端对话（已用真实密钥验证了账单档位查询与模型过滤，
> 但"发一条消息拿到回复"仍未跑过）；②真人点浏览器的实际授权（测试用 HTTP 模拟了回调，覆盖了
> 除"浏览器真的打开并登录"以外的全部环节）。

> 测试期间 `login-test.ts` / `migration-test.ts` 把所有落盘重定向到临时目录，**不会读写你真实的
> `~/.pi/agent/auth.json` 或 `~/.commandcode/auth.json`**。

## 卸载

```
pi remove pi-commandcode-provider
```

`~/.pi/agent/auth.json`、`~/.commandcode/auth.json` 与 `capabilities.ts` 快照都不受影响。

## 许可证与致谢

MIT。传输协议与能力快照来自 [Mars-Sea/dsh-commandcode-provider](https://github.com/Mars-Sea/dsh-commandcode-provider)（MIT）
与 [patlux/pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider)（MIT）。

本项目与 Command Code, Inc. 无关；使用需自备 Command Code 账号并遵守其服务条款。
