# 架构设计 · Inkbridge（墨桥）

> 读者：实现者（人或 Cursor）。改动任何模块前先读本文 + [CODING_STANDARDS.md](CODING_STANDARDS.md)。

## 1. 一句话

在 DeepSeek Harness（DSH）里，用**用户自己的 ChatGPT 订阅**生图：插件在 DSH Host 进程内驱动**官方 `codex app-server`**，登录、令牌、计费全部由 Codex 负责；插件只做桥。

## 2. 不可违反的设计原则

| # | 原则 | 为什么 |
|---|---|---|
| P1 | **不碰令牌**：不读 `auth.json`、不调 `chatgpt.com/backend-api`、不实现 OAuth | 合规 + 稳定；Codex 协议升级时我们只需要跟 app-server。 |
| P2 | **只用订阅，拒绝 API Key** | 子进程环境剔除 `OPENAI_API_KEY` 等；账号为 `apiKey` 时拒绝生图（防止静默按量扣费）。 |
| P3 | **浏览器永远拿不到凭据** | 前端只看到打码邮箱、套餐、额度百分比。 |
| P4 | **跨平台零 shell** | 所有子进程 argv 启动、`shell:false`；Windows 不启动 `.cmd` 充当可执行文件。 |
| P5 | **单一状态所有者** | 所有可变 Host 状态只在 `InkbridgeService`；路由、工具是薄适配层。 |
| P6 | **懒启动** | 插件加载不启动 Codex；首次打开设置页或首次生图才拉起，空闲自动退出。 |

## 3. 整体拓扑

```
┌─────────────────────── DSH 浏览器 / Desktop 渲染层（lib/client.js） ───────────────────────┐
│ settings.section ── SettingsSection.tsx ── StatusStore ── InkbridgeApi ── fetch('api/inkbridge.*')   │
│ tool.call.toolview[inkbridge_generate_image] ── ImageToolView (M3)                                │
└──────────────────────────────────────────────────────────────────────────────────────┬────┘
                              DSH /api 通道（Host/Origin 栅栏 + 浏览器认证）      │
┌───────────────────────────────────── DSH Host 进程（lib/index.js） ───────────────────────▼────┐
│ host/index.ts   apply(): 组装 + 生命周期                                                     │
│ host/routes.ts  ctx.connection.fetch.register(...)  ──┐                                        │
│ host/tool.ts    ctx.tools.register(defineTool(...)) ──┼──► host/service.ts  InkbridgeService    │
│                 ctx.attachments.saveImage(...)        │      ├─ Semaphore（并发闸门）          │
│                                                       │      ├─ status 快照 + revision        │
│                                                       │      └─ AppServer ── RpcClient        │
│ platform/locate.ts  跨平台找 codex                     │              │                        │
│ platform/process.ts spawn / killTree / openExternalUrl│              │ stdio JSONL            │
└────────────────────────────────────────────────────────────────────┼───────────────────────┘
                                                                       ▼
                                          codex app-server（官方二进制） ──► OpenAI（ChatGPT 订阅额度）
```

## 4. 目录与分层

```
src/
├─ shared/        浏览器安全：常量 + wire 类型。Host 与 Client 唯一的共享面。
├─ codex/         与 DSH 无关的 Codex 桥：协议类型、RPC、进程、账号、生图。
├─ platform/      跨平台 OS 适配：找可执行文件、启动/杀进程、打开浏览器。
├─ host/          DSH Host 适配：插件入口、配置、服务、工具、路由、DSH 服务端口。
└─ client/        DSH 浏览器适配：slot 注册、设置页、API 客户端、文案。
```

**依赖方向（只能向下）**

```
host/  ──► codex/ ──► platform/
  │         │
  └─────────┴──────► shared/ ◄──── client/
```

- `codex/`、`platform/` **禁止** import `@deepseek-ai/*`（保持可独立测试、可复用到别的宿主）。
- `client/` **禁止** import `node:*`、`codex/`、`platform/`、`host/`。
- `shared/` **禁止**任何运行时依赖。

## 5. 关键流程

### 5.1 状态刷新

```
SettingsSection 挂载 → StatusStore.start() → GET api/inkbridge.status（只读快照，不启动 Codex）
用户点「刷新」  → POST api/inkbridge.refresh → service.refresh()
                 → ensureServer()：locate → spawn app-server → initialize/initialized
                 → account/read + modelProvider/capabilities/read (+ account/rateLimits/read)
                 → patch(status) → revision++
```

### 5.2 ChatGPT OAuth 登录（浏览器授权）

```
POST api/inkbridge.login {method:'browser'}
  → account/login/start {type:'chatgpt', useHostedLoginSuccessPage:true, appBrand:'chatgpt'}
  ← {loginId, authUrl}           # app-server 自己监听 localhost 回调端口
  → openExternalUrl(authUrl)     # Host 打开系统浏览器；authUrl 也返回给页面供「复制链接」
  ← 通知 account/login/completed {loginId, success, error}
  → service.refresh()
设备码兜底：{method:'device-code'} → {verificationUrl, userCode}（回调端口不可达/远程访问 DSH 时用）
```

### 5.3 生图（模型调用 `inkbridge_generate_image`）

```
tool.execute(args, exec)
  → service.generate(request, exec.signal)
      assertReady()  ─ 未登录 / apiKey / 不支持生图 → 抛 InkbridgeError（模型看到可执行的提示）
      Semaphore.acquire(signal)
      mkdtemp($DSH_HOME/inkbridge/scratch/turn-*)
      generateImage(rpc, request, {workDir, reasoningEffort, timeoutMs, signal})
          thread/start {ephemeral, sandbox:'read-only', approvalPolicy:'never', developerInstructions}
          turn/start   {input:[text, ...localImage]}
          ← item/completed(imageGeneration) → savedPath | base64
          ← turn/completed
          (signal/超时 → turn/interrupt)
  → ctx.attachments.saveImage(png)        # 跟随会话持久化，历史可回看
  → [可选] 写入工作区 saveTo / workspaceDir
  → 返回 GeneratedImageValue；render = 文本信封 + image block（视觉模型可自检）
```

## 6. 进程模型

- **一个** app-server 子进程服务整个 DSH Host（所有会话共享），并发由 `maxConcurrent` 控制。
- `withLease()` 在工作期间暂停空闲计时；无租约 `idleShutdownMs` 后退出。
- 崩溃：`RpcClient.close(codex-crashed)` 拒绝所有在途调用；下次 `ensure()` 重启。
- 插件卸载（Loader dispose / HMR）：`service.dispose()` → `killTree(pid)`。

## 7. 数据落盘

| 位置 | 内容 | 生命周期 |
|---|---|---|
| `$DSH_HOME/inkbridge/scratch/turn-*` | 每次 turn 的 cwd（空目录） | turn 结束即删 |
| `$DSH_HOME/inkbridge/codex-home/` | `codexHome: isolated` 时的私有 CODEX_HOME（含 Codex 自己的登录凭据） | 用户登出/卸载 |
| `$CODEX_HOME/generated_images/<thread>/` | Codex 自己落的原图 | Codex 管理（TODO: 可选清理） |
| DSH attachments store | 会话内显示的图片 | DSH 管理 |
| 工作区 `saveTo` / `workspaceDir` | 用户要求的副本 | 用户 |

## 8. 安全边界

- 路由只走 `ctx.connection.fetch.register`（`/api/*`）→ 已有 Host/Origin 栅栏 + cookie 认证；**禁止** `ctx.webServer.register` 裸路由。
- Codex 线程 `sandbox:'read-only'` + `approvalPolicy:'never'` + 所有审批类 server request 一律拒绝 → Codex 无法在用户机器上执行命令或写文件。
- `saveTo`/相对 `references` 经 `resolveInside()` 限制在会话工作区内。
- 日志/错误详情经 `redact()` 去掉 JWT、Bearer、邮箱。
- `openExternalUrl` 只接受 `https://`。

## 9. 扩展点（未来）

- 其它 Codex 能力（看图、web search）复用同一个 `AppServer` + `InkbridgeService`，新增工具即可。
- 状态推送：轮询 → SSE 路由或 Typert 流（见 ROADMAP M2）。
