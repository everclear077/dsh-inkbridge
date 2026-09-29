# AGENTS.md — 给 AI 编码助手（Cursor / Codex / DSH）的工作说明

你在开发 **Inkbridge（墨桥）**：一个 DeepSeek Harness（DSH）插件，在 DSH Host 进程内驱动官方 `codex app-server`，用用户自己的 ChatGPT 订阅生图。

## 开始任何任务前必读

1. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)：分层、流程、进程模型、安全边界。
2. [docs/CODING_STANDARDS.md](docs/CODING_STANDARDS.md)：硬性规则，带编号。
3. 任务涉及的领域文档：
   - 动 `src/codex/**` → [docs/CODEX_PROTOCOL.md](docs/CODEX_PROTOCOL.md)
   - 动 `src/host/**` 或 `src/client/**` → [docs/DSH_INTEGRATION.md](docs/DSH_INTEGRATION.md)
4. [docs/ROADMAP.md](docs/ROADMAP.md)：找到任务所属里程碑；代码中 `TODO(Mx)` 与之对应。

## 绝对禁止（违反即回滚）

- 读取/解析 `auth.json` 或任何 Codex 令牌；直连 `chatgpt.com` / `api.openai.com`。（§7.1–7.2）
- `shell: true`；在 Windows 上 spawn `.cmd`/`.ps1`。（§5.2–5.3）
- 在 `src/platform/process.ts` 之外 import `node:child_process`。（§5.1）
- 用 `ctx.webServer.register` 暴露路由（绕过认证）。（§7.5）
- 跨层 import（`codex/`、`platform/` 引用 `@deepseek-ai/*`；`client/` 引用 `node:*`）。（§1）
- 改动 wire 形状却只改一端。（§3.2）
- 把 `any`、`!` 写进代码。（§2.1–2.2）

## 完成任务的定义

```bash
pnpm typecheck && pnpm test && pnpm lint && pnpm build
```

全部通过，并且：
- 新逻辑有单测（不 spawn 真实 codex、不联网）；平台分支覆盖 win32/darwin/linux。
- 对应的 `TODO(Mx)` 已删除，ROADMAP 勾选状态已更新。
- 行为变化已同步到对应 docs。
- 提交信息符合 Conventional Commits（§12）。

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm install` | 安装依赖（pnpm 11） |
| `pnpm test` / `pnpm test:watch` | 单测 |
| `pnpm typecheck` | 类型检查 |
| `pnpm lint` / `pnpm format` | Biome |
| `pnpm build` | 产出 `lib/index.js`（Host）+ `lib/client.js`（浏览器） |
| `pnpm probe` | 真实探测本机 Codex（不消耗额度） |
| `pnpm probe -- --generate "…"` | 真实生图一次（**消耗额度**，需要用户同意） |
| `pnpm schema:codex` | 导出当前 Codex 完整协议类型到 `.codex-schema/` |
| `dsh plugin --profile desktop add <本仓库绝对路径>` | 装进 DSH 联调 |

## 不确定时

- DSH API 形状不确定：以 DSH_INTEGRATION.md 为准；仍不确定就在该文档 §6「待核实」加一条，并用最保守的实现 + `TODO(Mx)`。
- Codex 协议不确定：`pnpm schema:codex` 看生成类型，不要猜。
- 需要消耗用户额度的验证：先问用户。
