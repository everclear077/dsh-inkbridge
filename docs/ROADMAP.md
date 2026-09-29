# 路线图

> 每个里程碑是一组可独立交给 Cursor 的任务。代码里的 `TODO(Mx)` 与此处对应。
> 状态：✅ 完成 · 🟡 骨架已在 · ⬜ 未开始

## M0 ✅ 可行性验证

- ✅ app-server 协议探测：账号 / 能力 / 额度 / 真实生图（`scripts/probe-app-server.mjs`，记录见 CODEX_PROTOCOL.md）
- ✅ DSH 0.2.0-rc.1 插件形态、slot、路由、附件 API 核实（DSH_INTEGRATION.md）
- ✅ 项目骨架、规范、单测

## M1 🟡 Host 打通：对话里出图（Windows）

验收：已登录 Codex 的机器上，安装插件后对 DSH 说“画一只纸鹤”，对话里出现图片。

1. 🟡 `pnpm build` 产物可被 DSH 加载（`dsh plugin add <abs path>`），插件页显示图标与中英文标题。
2. 🟡 核实 DSH_INTEGRATION.md §6 的待核实项，修正 `dsh-ports.ts` / `host/index.ts`。
3. ⬜ `host/index.ts`：`HostContext` 换成 Cordis `Context` 类型；`resolveDataDir()` 换 `dshHomePath`。
4. ⬜ `platform/locate.ts`：Windows 下不经 shell 取得 npm 全局根（解析 `npm-cli.js` 用 `process.execPath` 运行）。
5. ⬜ `platform/process.ts`：`killTree` 等待退出 + POSIX SIGTERM→SIGKILL 升级。
6. ⬜ `codex/generate.ts`：`declineServerRequest` 按 schema 返回规范“拒绝” result；结果兜底 #3（扫描 `generated_images/<threadId>/`）。
7. ⬜ `host/service.ts`：app-server 空闲重启后重新挂 server-request handler 与通知监听（AppServer 增加 `onSession` 事件）。
8. ⬜ `tests/live/generate.test.ts`：`INKBRIDGE_LIVE=1` 时跑一次真实生图。

## M2 🟡 设置菜单 + OAuth

验收：未登录机器上，设置 → 墨桥 → 登录 → 浏览器授权 → 页面自动变为已登录并显示额度；设备码流程同样可用。

1. 🟡 `settings.section` 注册与页面骨架（已在）；换成 `dsh-client-ui-primitives` 原生组件。
2. ⬜ 登录期间持有 app-server lease（防止空闲关闭导致回调监听消失）；登录超时（10 分钟）自动取消。
3. ⬜ `sharedLogin` 从 Host 配置读取（当前写死 true）。
4. ⬜ “测试生成”按钮 + `ROUTES.testGenerate`（明确提示消耗额度）。
5. ⬜ **开放问题**：状态推送用 SSE 路由（`requestBody:'buffered'` + `text/event-stream` 响应）还是 Typert `@Remote({mode:'stream'})`？先 spike `@deepseek-ai/dsh-typert-generator` 能否用于 0.2.0；不行就 SSE。定了之后替换 `StatusStore` 轮询。
6. ⬜ 同一页面注册到 `plugins.bundle.config`（插件页详情内也能登录）。
7. ⬜ `codexPath` / `codexHome` / `reasoningEffort` 等配置项在页面可编辑（`ctx.configForms.get('inkbridge')`）。

## M3 ⬜ 对话体验

1. ⬜ `tool.call.toolview`（key=`inkbridge_generate_image`）：生成中进度/耗时；完成后图片、放大、复制、下载、“以此图继续编辑”。
2. ⬜ references 校验（存在、格式、大小）→ `reference-not-found`。
3. ⬜ 透明背景：`tRNS` chunk 检测；失败时明确告知。
4. ⬜ 工作区保存不覆盖已有文件。
5. ⬜ `skills/inkbridge/SKILL.md` 调优（提示词写法、比例、连续编辑用法）。

## M4 ⬜ 跨平台

1. ⬜ macOS Apple Silicon / Intel：Homebrew 安装、npm 安装、Dock 启动 DSH（无 shell PATH）三种场景手测。
2. ⬜ Linux 冒烟。
3. ⬜ GitHub Actions：ubuntu / macos / windows × Node 22 / 24 跑 typecheck + test + build。

## M5 ⬜ 发布

1. ⬜ README 截图、安装说明。
2. ⬜ npm 发布（provenance）；`dsh plugin add dsh-inkbridge` 可用。
3. ⬜ 提交到 awesome-dsh-plugin。
