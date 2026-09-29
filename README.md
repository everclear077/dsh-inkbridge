<div align="center">

<img src="icon.svg" width="72" alt="Inkbridge" />

# 墨桥 Inkbridge

**在 DeepSeek Harness 里，用你自己的 ChatGPT 订阅生图。**
桥接官方 Codex · 免 API Key · 不碰令牌 · Windows / macOS / Linux

简体中文 · [English](README.en.md)

</div>

> ⚠️ 开发中（v0.0.x）。进度见 [docs/ROADMAP.md](docs/ROADMAP.md)。

## 它是什么

墨桥让 DSH 的 Agent 能直接在对话里生图，走的是**你已经付费的 ChatGPT 订阅**（Plus / Pro / Business…），而不是按张计费的 API。

和其它“订阅免 Key”方案的区别：墨桥**不自己处理登录、不读取任何令牌、不调用任何非公开接口**。它只是驱动你机器上的官方 Codex（`codex app-server`），登录、令牌刷新、计费全部由 Codex 自己完成。

```
DSH Agent ── inkbridge_generate_image ──► 墨桥（DSH Host 内） ── stdio ──► codex app-server ──► ChatGPT 订阅
                                                   │
                    设置 → 墨桥 · ChatGPT 生图  ◄─┘  登录状态 / 额度 / 官方 OAuth 登录
```

## 前置条件

- DeepSeek Harness **0.2.0-rc.1** 或更新
- Node.js 22.19+ / 24+
- Codex CLI：`npm i -g @openai/codex`（macOS 也可 `brew install codex`）
- 支持生图的 ChatGPT 套餐（**Free 不支持**）

## 安装

```bash
# 发布后
dsh plugin --profile desktop add dsh-inkbridge

# 本地开发版
git clone https://github.com/everclear077/dsh-inkbridge.git
cd dsh-inkbridge && pnpm install && pnpm build
dsh plugin --profile desktop add "$(pwd)"
```

重启 DSH 后：**设置 → 墨桥 · ChatGPT 生图 → 使用 ChatGPT 登录**，在弹出的浏览器里授权即可。如果你已经在终端里 `codex login` 过，会直接显示已登录。

## 使用

直接对 Agent 说：

```
画一张雨夜霓虹街头的赛博朋克猫，电影感光线，16:9
把刚才那张图里的猫戴上墨镜
做一个蓝色机器人的扁平图标，透明背景，1:1，保存到 assets/robot.png
```

单张图通常 30–90 秒，消耗 ChatGPT 订阅额度（官方称生图约为普通回合的 3–5 倍）。

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖：

```yaml
- id: inkbridge
  config:
    codexHome: shared        # shared=复用 ~/.codex 登录；isolated=插件私有登录
    codexPath: ''            # 手动指定 codex 路径（留空自动发现）
    reasoningEffort: low     # 编排模型推理强度，越低越快
    maxConcurrent: 2
    turnTimeoutMs: 600000
    saveToWorkspace: false   # 是否默认把结果写入工作区
    workspaceDir: inkbridge
```

## 隐私与安全

- 墨桥不读取 `~/.codex/auth.json`，不接触任何令牌；浏览器侧只看到打码邮箱、套餐和额度。
- 启动 Codex 时剔除 `OPENAI_API_KEY` 等环境变量；Codex 若处于 API Key 登录状态，墨桥拒绝生图，避免被按量扣费。
- Codex 以只读沙箱运行、所有审批请求一律拒绝，不会在你的机器上执行命令。
- 使用个人订阅进行程序化调用受 OpenAI 服务条款约束，请自行评估。

## 开发

贡献者（含 AI 助手）请先读 [AGENTS.md](AGENTS.md)。

| 文档 | 内容 |
|---|---|
| [ARCHITECTURE](docs/ARCHITECTURE.md) | 分层、流程、进程模型、安全边界 |
| [CODING_STANDARDS](docs/CODING_STANDARDS.md) | 编码规范（带编号） |
| [CODEX_PROTOCOL](docs/CODEX_PROTOCOL.md) | Codex app-server 协议实测笔记 |
| [DSH_INTEGRATION](docs/DSH_INTEGRATION.md) | DSH 插件 API 参考与待核实项 |
| [ROADMAP](docs/ROADMAP.md) | 里程碑与任务拆分 |

```bash
pnpm install
pnpm typecheck && pnpm test && pnpm lint && pnpm build
pnpm probe                 # 检查本机 Codex 登录/能力/额度（不消耗额度）
```

## License

[MIT](LICENSE)
