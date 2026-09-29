# Codex app-server 协议笔记

> **已验证版本：codex-cli 0.153.4（Windows x64，ChatGPT prolite 账号）**
> 完整类型：`pnpm schema:codex` 生成到 `.codex-schema/`（706 个文件，不入库）。
> 官方文档：<https://learn.chatgpt.com/docs/app-server>

## 1. 传输

- `codex app-server`（默认 `--listen stdio://`）：stdin/stdout，**每行一条 JSON**。
- JSON-RPC 2.0 语义，但 wire 上**省略** `"jsonrpc":"2.0"`。
- 三种消息：
  - 请求 `{id, method, params}` / 响应 `{id, result}` 或 `{id, error:{code,message}}`
  - 通知 `{method, params}`（无 id）
  - **服务端请求** `{id, method, params}` 从 server 发来，客户端必须回应，否则 turn 会卡住。
- stdout 偶尔有非 JSON 行（WARNING），要忽略。
- stderr 是日志，可能含敏感信息 → 只保留尾部并 `redact()`。

## 2. 握手

```jsonc
→ {"id":1,"method":"initialize","params":{"clientInfo":{"name":"dsh_inkbridge","title":"DSH Inkbridge","version":"0.0.1"},
    "capabilities":{"experimentalApi":false,"requestAttestation":false,"optOutNotificationMethods":["item/agentMessage/delta"]}}}
← {"id":1,"result":{"userAgent":"Codex Desktop/0.153.4 (...)","codexHome":"C:\\Users\\x\\.codex","platformFamily":"windows","platformOs":"windows"}}
→ {"method":"initialized","params":{}}
```

握手前发其它请求 → `Not initialized`。

## 3. 账号

| 方法 | params | result |
|---|---|---|
| `account/read` | `{refreshToken?: boolean}` | `{account: null \| {type:'apiKey'} \| {type:'chatgpt', email, planType}, requiresOpenaiAuth}` |
| `account/login/start` | `{type:'chatgpt', useHostedLoginSuccessPage?, appBrand?:'codex'\|'chatgpt'}` | `{type:'chatgpt', loginId, authUrl}` |
| `account/login/start` | `{type:'chatgptDeviceCode'}` | `{type:'chatgptDeviceCode', loginId, verificationUrl, userCode}` |
| `account/login/cancel` | `{loginId}` | `{status}` |
| `account/logout` | — | `{}` |
| `account/rateLimits/read` | — | `{rateLimits: RateLimitSnapshot, rateLimitsByLimitId, ...}` |
| `modelProvider/capabilities/read` | `{}` | `{namespaceTools, imageGeneration, webSearch}` |

通知：
- `account/login/completed {loginId, success, error}`
- `account/updated {authMode, planType}`
- `account/rateLimits/updated {rateLimits}`（**稀疏**更新，官方建议合并或重读）

实测 `account/rateLimits/read`：

```json
{ "limitId": "codex", "primary": { "usedPercent": 10, "windowDurationMins": 10080, "resetsAt": 1791094330 },
  "secondary": null, "credits": { "hasCredits": true, "unlimited": false, "balance": "1038.94" },
  "planType": "prolite", "rateLimitReachedType": null }
```

**登录要点**
- 浏览器流：app-server 自己在 `localhost:<port>/auth/callback` 监听；客户端只负责打开 `authUrl`。
- 登录进行中如果 app-server 被杀，回调监听消失 → **登录期间必须持有 lease**（TODO M2）。
- DSH 被远程访问时，用户浏览器到不了 Host 的 localhost → 用设备码流。

## 4. 生图

```jsonc
→ thread/start {"cwd":"<tmp>","ephemeral":true,"sandbox":"read-only","approvalPolicy":"never",
                 "config":{"model_reasoning_effort":"low"},"developerInstructions":"<BRIDGE_INSTRUCTIONS>"}
← {"thread":{"id":"01a0eb44-..."},"model":"gpt-6-astra", ...}
→ turn/start {"threadId":"01a0eb44-...","input":[{"type":"text","text":"...","text_elements":[]},
                                                {"type":"localImage","path":"C:\\ref.png"}]}
← {"turn":{"id":"...","status":"inProgress"}}
← thread/started, thread/status/changed, turn/started, item/started, ...
← item/completed {"item":{"type":"imageGeneration","id":"exec-28d9...","status":"completed",
                   "revisedPrompt":"...","result":"<base64 ~1.1MB>","transparentBackground":false,"failure":null,
                   "savedPath":"C:\\Users\\x\\.codex\\generated_images\\<threadId>\\<itemId>.png"},
                   "threadId":"...","turnId":"..."}
← thread/tokenUsage/updated, account/rateLimits/updated
← turn/completed {"threadId":"...","turn":{"status":"completed","error":null}}
```

实测：**51 秒**，1254×1254 PNG。

`ImageGenerationItem`：

```ts
{ id: string, status: string, revisedPrompt: string | null, result: string,
  transparentBackground?: boolean, failure: ImageGenerationFailure | null, savedPath?: AbsolutePathBuf }
type ImageGenerationFailure = { type: 'usageLimitExceeded', limitId: string, resetsAt: number | null }
```

结果读取优先级：`savedPath` → `result`(base64) → 扫描 `generated_images/<threadId>/`（TODO）。

`TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress'`；失败时 `turn.error = {message, codexErrorInfo, additionalDetails}`。

取消：`turn/interrupt {threadId, turnId}` → turn 以 `interrupted` 结束。

## 5. 服务端请求（必须回应）

0.153.4 的 `ServerRequest` 方法：

```
account/chatgptAuthTokens/refresh   applyPatchApproval   attestation/generate   execCommandApproval
item/commandExecution/requestApproval   item/fileChange/requestApproval   item/permissions/requestApproval
item/tool/call   item/tool/requestUserInput   mcpServer/elicitation/request
```

Inkbridge 策略：审批类一律拒绝（当前实现：返回 JSON-RPC error）。
**TODO(M1)**：按 schema 逐个确认“拒绝”的规范 result 形状（比返回 error 更友好）。
由于 `sandbox:read-only + approvalPolicy:never`，正常生图流程实测未收到任何服务端请求。

## 6. 跨平台启动

npm 安装布局（0.153.x，两种都见过）：

```
<npm-root>/@openai/codex/bin/codex.js                                   # node 启动器
<npm-root>/@openai/codex/node_modules/@openai/codex-<os>-<arch>/vendor/<triple>/codex/codex(.exe)
<npm-root>/@openai/codex/node_modules/@openai/codex-<os>-<arch>/vendor/<triple>/bin/codex(.exe)
```

`<triple>`：`x86_64-pc-windows-msvc` / `aarch64-pc-windows-msvc` / `x86_64-apple-darwin` / `aarch64-apple-darwin` / `x86_64-unknown-linux-musl` / `aarch64-unknown-linux-musl`。

启动器 `codex.js` 会把 `vendor/<triple>/path` 加入 PATH 并设置 `CODEX_MANAGED_BY_NPM=1`；直接启动原生二进制时这两点对 app-server 模式实测无影响。

## 7. 已知坑

| 现象 | 处理 |
|---|---|
| Windows 下 `spawn('codex')` 失败（只有 `codex.cmd`） | 解析到 `.exe` 或 `node codex.js`，永不 `shell:true`（Node 会报 DEP0190） |
| 沙箱内用管道启动子进程 EPERM | 只影响 DSH 工具沙箱；插件在 Host 进程内运行不受影响 |
| stderr `failed to clean up stale arg0 temp dirs` | 无害警告，忽略 |
| 默认推理强度下单图 4–6 分钟（社区报告） | `model_reasoning_effort: low` + 桥接指令，实测 ~51s |
