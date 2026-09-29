---
name: inkbridge
description: Generate or edit images with the user's ChatGPT subscription through the Inkbridge plugin (tool inkbridge_generate_image). Use when the user asks to draw, generate, render, design, or edit an image, icon, poster, illustration, mockup, or photo.
---

# Inkbridge — image generation

Use the `inkbridge_generate_image` tool. It runs GPT Image through the user's own ChatGPT subscription via the official Codex app.

## Before calling

- Each call takes roughly 30–90 seconds and spends the user's ChatGPT image quota. Do not call speculatively or "just to check".
- One image per call. For N variants, make N calls only if the user asked for N.

## Writing the prompt

Write a dense, specific prompt. Cover, in order:
1. Subject and action
2. Composition / framing / camera
3. Style / medium (photo, flat vector, watercolor, 3D render…)
4. Lighting and color palette
5. Exact text to render, in quotes, if any
6. Things to avoid

Keep the user's own wording when they gave a detailed prompt; do not "improve" it unasked.

## Parameters

- `aspect`: `1:1` (icons, avatars), `16:9` (banners, slides), `9:16` (phone, stories), `4:3`, `3:4`, `3:2`, `2:3`.
- `background: "transparent"`: for icons, stickers, logos. The result reports whether the PNG really has alpha.
- `references`: local image paths. With `mode: "edit"`, `references[0]` is the image to change; describe only the change.
- `saveTo`: workspace-relative `.png` path when the user wants a file in the project.

## Iterating

For "change the last one", pass the previous result file as `references[0]` with `mode: "edit"`. Each call is independent; nothing is remembered between calls.

## Errors

- `not-signed-in` / `api-key-login`: tell the user to open **Settings → 墨桥 · ChatGPT 生图** and sign in with ChatGPT. Do not retry.
- `usage-limit`: tell the user their image quota is used up and when it resets. Do not retry.
- `codex-not-found`: tell the user to install Codex (`npm i -g @openai/codex`, or `brew install codex` on macOS).
- `timeout` / `turn-failed`: you may retry once with a simpler prompt.
