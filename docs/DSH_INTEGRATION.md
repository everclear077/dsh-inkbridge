# DSH 集成参考

> **已验证版本：DeepSeek Harness Desktop 0.2.0-rc.1**（从安装包 `resources/app.asar` 内的编译产物与 README 核对）。
> DSH 官方包基本不发布 `.d.ts`，所以我们在 `src/host/dsh-ports.ts` / `src/client/index.ts` 里**结构化声明**用到的成员。
> 本文记录每个成员在哪里被观察到，升级 DSH 时逐条复核。

## 1. 插件包形态

DSH 插件 = 一个 npm 包，`package.json#dsh` 声明：

```jsonc
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },     // 组合包：安装后向 profile 插入 Loader 条目
  "client": { "platform": "web", "inject": [...] } // 浏览器半侧：由 dsh-client-modules 提供 ./client 导出
}
```

- Host 半侧：`exports["."]` → ESM，导出 `name`、`inject`、`Config`、`apply(ctx, config)`。
- 浏览器半侧：`exports["./client"]` → `window.__ModuleLoader__.load({ id, factory })` 包装的 CJS，导出 `inject`、`apply(ctx)`。
- `dsh.client.inject` 列出必须先加载的 DSH 客户端包（它们提供 slot 类型等）。
- DSH 用 `peerDependencies` 中 `@deepseek-ai/dsh-*` 的范围做运行时版本兼容检查，不匹配则拒绝加载。
- `package.json#icon` + `locale/<lang>.json#meta.{title,description}` 用于插件页展示。

参考：`@deepseek-ai/dsh-experimental-voice-input-bundle`（官方同形态组合包）、`@deepseek-ai/dsh-plugin-manager` README、`@deepseek-ai/dsh-client-modules` README。

## 2. 安装与调试

```bash
# 本地开发安装（绝对路径）
dsh plugin --profile desktop add D:/3am/code/project/dsh-inkbridge
# 或 Web profile
dsh plugin --profile web add /abs/path/dsh-inkbridge
# 查看最终组合配置
dsh --profile desktop --dump-config
```

- 也可在 DSH 侧栏 **插件 → 添加插件** 填本地绝对路径。
- profile 目录：`$DSH_HOME/profiles/<name>`（本机 `D:\Data\dsh\profiles\desktop`）。
- 改了 Host 代码需要重启 DSH；改了 `lib/client.js` 刷新页面即可（HMR 按文件 mtime 判定）。
- 用户覆盖配置：在 profile 的 `cordis.patch.yml` 里按 `id: inkbridge` 写 `config:`。

## 3. Host 服务

| 服务 | 我们用的成员 | 观察出处 |
|---|---|---|
| `ctx.tools` | `register(defineTool({...}))` | `dsh-tools` README；`dsh-tool-present`、`dsh-tool-fs` 编译产物 |
| `defineTool` | `{name, description, parameters, output:{schema, render, presentationMeta?}, execute(args, exec), isConcurrencySafe?, timeoutMs?}` | `dsh-tools/lib/index.js` |
| `ctx.attachments` | `saveImage({data, mediaType, name}) → ImageAttachmentRef`；`imageLimits.{maxImageBytes, mediaTypes, ...}` | `dsh-tool-fs` 的 `read_image` 实现 |
| 工具结果图片块 | `render()` 返回 `{type:'image', attachment: ImageAttachmentRef}` | `dsh-tool-fs` `imageReadContent()` |
| `ctx.connection.fetch.register` | `{path:'/api/<seg>', methods, requestBody:'buffered'\|'streaming', fetch:(Request)=>Promise<Response>}` | `dsh-client-connection`；用例 `dsh-api-session-controller`(`/api/file`)、`dsh-client-ui-deliverables`(`/api/present.host`) |
| `/api` 认证 | 进入 fetch 前已执行 `connection.admit(req)`（Host/Origin 栅栏 + cookie） | `dsh-client-connection` `createSharedFetchHandler` |
| `ctx.effect(setup, label)` | setup 返回 disposer | 所有官方插件 |
| `exec` | `signal`、`callId`、`agent.session.header.cwd` | `dsh-tool-present` |

路径约束：`/api/` 后的每段必须匹配 `[A-Za-z0-9_$.-]+`，不能有空段 / `.` / `..`。

浏览器侧调用：用**相对路径**`fetch('api/inkbridge.status')`（官方 `PRESENT_HOST_ROUTE = PRESENT_HOST_PATH.slice(1)` 同款做法），让页面按自己的挂载点解析，Web 与 Desktop 通用。

## 4. Client（浏览器）API

| API | 用法 | 观察出处 |
|---|---|---|
| `ctx.slots.inject(name, () => ctx.slots.register(opts, Component))` | slot 延迟声明时自动等待 | 所有官方 UI 包 |
| `settings.section` | `{name, id, order, label: () => string, locale, inject?}` → 设置左侧一级菜单 | `dsh-client-ui-agent-preset`（order 20）、`dsh-client-ui-settings-account`（order -10） |
| `tool.call.toolview` | `{name, key: '<tool name>'}` → 对话里该工具的卡片；props 含 `phase`、`block`、`loadImage` | `dsh-client-ui-tool` README |
| `plugins.bundle.config` | `{name, key: '<package name>'}` → 插件页该组合包详情内的配置区 | `dsh-client-ui-plugin-manager` README、语音输入包 |
| `ctx.locale.register(ns, {zh, en})` / `ctx.locale.bind(ns)` | 字典 + 取词函数 | `dsh-client-ui-settings-web-search` |
| `@deepseek-ai/dsh-client-ui-primitives` | `SettingsForm`、`SettingsValueField`、`SettingsSecretField`…（原生外观） | 同上 |

## 5. 与现有社区插件的冲突规避

| 项 | 我们的值 | 注意 |
|---|---|---|
| 包名 | `dsh-inkbridge` | — |
| Loader id | `inkbridge` | `dsh-image-gen` 用 `image-gen` |
| 工具名 | `inkbridge_generate_image` | 多个插件占用了 `generate_image` / `image_generate` |
| 路由 | `/api/inkbridge.*` | — |
| settings section id | `inkbridge` | — |

## 6. 待核实（实现时先验证）

- [ ] `ctx.tools.register` 返回值是否为 disposer（当前按“若为函数则调用”处理）。
- [ ] `ctx.connection.fetch.register` 在插件 ctx 上调用时是否已自动绑定 effect（源码显示 `owner.effect(...)`，返回值形态需确认）。
- [ ] `@deepseek-ai/dsh-home-paths` 是否可从第三方包解析（runtime resolution），可以则用 `dshHomePath('inkbridge')` 替换 `resolveDataDir()`。
- [ ] `settings.section` 组件收到的 props 形状（`close` 等）。
- [ ] Desktop（Electron）中相对 `fetch('api/...')` 是否同样走 IPC 桥（官方插件如此使用，预期可行）。
