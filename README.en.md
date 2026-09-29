<div align="center">

<img src="icon.svg" width="72" alt="Inkbridge" />

# Inkbridge

**Generate images in DeepSeek Harness with your own ChatGPT subscription.**
Bridges the official Codex app · no API key · no token scraping · Windows / macOS / Linux

[简体中文](README.md) · English

</div>

> ⚠️ Work in progress (v0.0.x). See [docs/ROADMAP.md](docs/ROADMAP.md).

## What it is

Inkbridge gives the DSH agent an `inkbridge_generate_image` tool backed by the ChatGPT plan you already pay for, instead of per-image API billing.

Unlike other "subscription, no key" approaches, Inkbridge never handles login itself, never reads tokens, and never calls private endpoints. It drives the official `codex app-server` on your machine; Codex owns sign-in, token refresh and billing.

## Requirements

- DeepSeek Harness 0.2.0-rc.1+
- Node.js 22.19+ / 24+
- Codex CLI: `npm i -g @openai/codex` (or `brew install codex`)
- A ChatGPT plan with image generation (not Free)

## Install

```bash
dsh plugin --profile desktop add dsh-inkbridge          # once published
# local build
git clone https://github.com/everclear077/dsh-inkbridge.git
cd dsh-inkbridge && pnpm install && pnpm build
dsh plugin --profile desktop add "$(pwd)"
```

Restart DSH, then **Settings → Inkbridge · ChatGPT images → Sign in with ChatGPT**. If you already ran `codex login`, it shows as signed in.

## Privacy

No auth files are read; the browser only sees a masked email, plan and usage. API-key env vars are stripped from the Codex process, and generation is refused when Codex is signed in with an API key. Codex runs read-only with every approval request declined. Programmatic use of a personal subscription is subject to OpenAI's terms.

## Development

Read [AGENTS.md](AGENTS.md) and the docs in [docs/](docs/). License: [MIT](LICENSE).
