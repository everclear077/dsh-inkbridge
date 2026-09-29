# 编码规范 · Inkbridge

> 适用于人和 AI（Cursor）。每条规则都有编号，Code Review 时直接引用（例：“违反 §5.2”）。
> 规则与现有代码冲突时，以本文为准并顺手修正代码。

## §0 工具链

| 项 | 约定 |
|---|---|
| Node | `^22.19.0 \|\| >=24`（与 DSH 一致） |
| 包管理 | **pnpm 11**（`packageManager` 已锁定）。禁止提交 `package-lock.json` / `yarn.lock` |
| 语言 | TypeScript 6，`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` |
| 构建 | `tsc -p tsconfig.build.json && tsdown`（输出 `lib/index.js` + `lib/client.js`） |
| 测试 | Vitest。`tests/live/**` 需 `INKBRIDGE_LIVE=1`（会消耗真实额度） |
| 格式/Lint | Biome（`pnpm lint` / `pnpm format`）。单引号、无分号、尾逗号、120 列 |

提交前必须全绿：`pnpm typecheck && pnpm test && pnpm lint && pnpm build`。

## §1 分层与依赖（硬性）

1.1 依赖只能向下：`host → codex → platform`，各层都可用 `shared`；`client → shared`。详见 ARCHITECTURE §4。
1.2 `src/codex/**`、`src/platform/**` 不得 import `@deepseek-ai/*`。
1.3 `src/client/**` 不得 import `node:*`、`../codex`、`../platform`、`../host`。
1.4 `src/shared/**` 只有常量和类型，零运行时 import。
1.5 访问任何 DSH 服务必须经 `src/host/dsh-ports.ts` 里声明的端口类型；新增成员先在此声明并在 `docs/DSH_INTEGRATION.md` 注明出处。

## §2 TypeScript

2.1 禁止 `any`（Biome 报错）。边界数据用 `unknown` + 显式收窄。
2.2 禁止非空断言 `!`。用提前返回或抛 `InkbridgeError`。
2.3 类型导入用 `import type`（`verbatimModuleSyntax`）。
2.4 相对导入必须带 `.js` 后缀（NodeNext）。
2.5 对外数据结构字段一律 `readonly`。
2.6 `exactOptionalPropertyTypes`：可选字段不要赋 `undefined`，用条件展开 `...(x === undefined ? {} : { x })`。
2.7 禁止 `enum`，用字面量联合 + `as const` 对象。
2.8 导出函数写显式返回类型（内部函数可推断）。

## §3 共享契约（Host ↔ Client）

3.1 一切跨端 wire 形状（路由、请求体、响应体、工具 value）**只**定义在 `src/shared/index.ts`。
3.2 改契约 = 同一个 commit 内同时改 Host 和 Client。
3.3 路由路径必须是 `/api/inkbridge.<segment>`，segment 满足 `[A-Za-z0-9_$.-]+`（DSH 要求）。
3.4 状态快照带 `revision`，客户端丢弃旧 revision。

## §4 错误处理

4.1 整个项目只抛 `InkbridgeError(code, message, {details, cause})`。`code` 取自 `InkbridgeErrorCode`，新增 code 先加到 shared。
4.2 `message`：英文、面向开发者、可直接展示；**绝不含**令牌、完整邮箱、绝对用户目录（必要时走 `redact()`）。
4.3 工具内抛出的错误会被 DSH 转成普通错误结果，模型会读到；message 必须告诉模型**用户该做什么**（例：“Not signed in to ChatGPT; open Settings → Inkbridge and sign in”）。
4.4 UI 文案按 `code` 映射，不对 `message` 做字符串匹配。
4.5 不吞错：`catch {}` 只允许用于“尽力而为”的清理（删临时目录、kill 已退出进程），并写注释说明。
4.6 所有异步操作接收并传递 `AbortSignal`；取消一律映射为 `code: 'cancelled'`。

## §5 跨平台（Windows / macOS / Linux）

5.1 **只有** `src/platform/process.ts` 可以 import `node:child_process`。
5.2 **永远** `shell: false`。参数是 argv 数组，不拼命令字符串。
5.3 Windows 不启动 `.cmd` / `.ps1` / `.bat`；解析到真实 `.exe` 或用 `process.execPath + <script.js>`。
5.4 路径一律 `node:path` 拼接；禁止手写 `/` 或 `\\` 分隔符；禁止假设大小写敏感。
5.5 用户目录用 `os.homedir()`，临时目录用 `os.tmpdir()` 或 `$DSH_HOME/inkbridge/scratch`。
5.6 杀进程一律 `killTree()`（Windows `taskkill /T /F`，POSIX 进程组）。
5.7 打开 URL 一律 `openExternalUrl()`。
5.8 macOS GUI 启动不继承 shell PATH：任何“在 PATH 里找”的逻辑都必须有“常见目录”兜底。
5.9 平台分支写成**纯函数 + 可注入的 `platform` 参数**，在单测里覆盖三个平台（见 `tests/locate.test.ts`）。
5.10 文本文件一律 UTF-8 + LF（`.gitattributes` 已强制）。

## §6 Codex 协议

6.1 协议类型只在 `src/codex/protocol.ts` 手写维护；只加实际读到的字段。
6.2 所有字段按“可能缺失”处理（Codex 迭代快）。解析宽松、写入严格。
6.3 方法名只引用 `Method.*` 常量。
6.4 升级 Codex 后：`pnpm schema:codex` → diff `.codex-schema/` → 手动更新 protocol.ts → 更新 `docs/CODEX_PROTOCOL.md` 的“已验证版本”。
6.5 `BRIDGE_INSTRUCTIONS` 是行为契约，改它必须在 PR 描述里附 live probe 前后对比。
6.6 所有审批/征询类 server request 一律拒绝（桥接永远不能阻塞在人身上）。

## §7 安全与隐私（硬性）

7.1 禁止读取、解析、复制 `$CODEX_HOME/auth.json` 或任何令牌文件。
7.2 禁止直连 `chatgpt.com`、`api.openai.com` 或任何 OpenAI 端点。
7.3 子进程环境必须经 `childEnv()`（剔除计费相关变量）。
7.4 浏览器可见数据只含：打码邮箱、套餐名、额度数字、可执行文件路径、登录 URL / 设备码。
7.5 Host 路由只用 `ctx.connection.fetch.register`；禁止 `ctx.webServer.register`。
7.6 写文件的路径必须经 `resolveInside()`。
7.7 日志不打印 prompt 全文（可打印长度）、不打印邮箱。

## §8 DSH 插件约定

8.1 所有副作用（路由、工具、子进程、定时器、订阅）必须挂在 `ctx.effect(() => dispose, label)` 上，label 格式 `inkbridge: <what>`。插件被停用/HMR 时必须干净退出。
8.2 `apply()` 同步返回、不做重活（不启动 Codex）。
8.3 `Config` 默认值与 `cordis.patch.yml` 保持一致。
8.4 工具名固定 `inkbridge_generate_image`；新增工具一律 `inkbridge_` 前缀。
8.5 peer 依赖范围必须覆盖当前 DSH 版本（DSH 用 peer 声明做兼容性拦截）。升 DSH 版本时同步调整。
8.6 浏览器 bundle 不打包 `react`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-slots`（见 tsdown.config.ts）。
8.7 用户可见文案全部在 `src/client/locales.ts`，中英文同时提供，`en` 类型约束与 `zh` 同键。

## §9 测试

9.1 纯逻辑（映射、解析、路径、状态机）必须有单测；不依赖网络、不 spawn 真实 codex。
9.2 I/O 用注入：`LocateEnv`、`readFileImpl`、`RpcClient({write})`、`Fetcher`。
9.3 每个 bug 修复先写复现测试。
9.4 live 测试放 `tests/live/`，默认跳过；CI 不跑。
9.5 覆盖三平台分支（见 §5.9）。

## §10 注释与文档

10.1 每个文件顶部一段注释：这个模块**负责什么、不负责什么**、关键约束。
10.2 导出符号写 JSDoc（一句话说清行为，参数有坑才展开）。
10.3 注释解释**为什么**，不复述代码。
10.4 未完成工作用 `TODO(Mx): …` 标注里程碑（见 ROADMAP），不写无主 TODO。
10.5 改行为就更新对应文档：ARCHITECTURE（流程）、CODEX_PROTOCOL（协议）、DSH_INTEGRATION（DSH API）、README（用户可见）。

## §11 命名

| 对象 | 规则 | 例 |
|---|---|---|
| 文件 | kebab-case；React 组件 PascalCase | `app-server.ts`、`SettingsSection.tsx` |
| 类 / 类型 | PascalCase | `InkbridgeService` |
| 函数 / 变量 | camelCase，动词开头 | `readAccount`、`buildTurnInput` |
| 常量 | UPPER_SNAKE | `TOOL_NAME` |
| 错误码 | kebab-case | `usage-limit` |
| 路由 | `/api/inkbridge.<dot.segments>` | `/api/inkbridge.login.cancel` |
| locale key | `area.item` | `account.login` |

## §12 Git

12.1 Conventional Commits：`feat|fix|refactor|test|docs|chore|build(scope): 摘要`。scope 取 `codex|platform|host|client|shared|docs|build`。
12.2 一个 commit 一件事；契约变更与两端实现同 commit。
12.3 分支：`feat/<milestone>-<topic>`，例 `feat/m1-tool-e2e`。
12.4 不提交 `lib/`、`.codex-schema/`、生成图片、任何含账号信息的 probe 输出。
