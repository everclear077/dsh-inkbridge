/**
 * The model-facing tool `inkbridge_generate_image`.
 *
 * Contract with the model (docs/ARCHITECTURE.md §5):
 * - Input: prompt (+ optional references / aspect / background / mode / saveTo).
 * - Output value: GeneratedImageValue (shared/index.ts), rendered as a short text envelope
 *   PLUS an image block, so vision-capable models can inspect the result.
 * - Errors: throw InkbridgeError; DSH turns a thrown error into a normal error tool result
 *   (the turn continues), and the message tells the model what the user must do.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { InkbridgeError } from '../codex/errors.js'
import { type AspectRatio, type GenerateRequest, pngDimensions, pngHasAlphaChannel } from '../codex/generate.js'
import { type GeneratedImageValue, TOOL_NAME } from '../shared/index.js'
import type { InkbridgeConfig } from './config.js'
import type { AttachmentsPort, ToolExecPort } from './dsh-ports.js'
import type { InkbridgeService } from './service.js'

const ASPECTS: readonly AspectRatio[] = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']

export const TOOL_DESCRIPTION = [
  "Generate or edit an image with the user's own ChatGPT subscription (GPT Image, via the official Codex app).",
  "A call usually takes 30-90 seconds and consumes the user's ChatGPT image quota; do not call it speculatively.",
  'Write a dense, specific prompt (subject, composition, style, lighting, text to render).',
  'For edits pass the image to change as references[0] and describe only the change.',
  'The result is returned as an image you can inspect.',
].join(' ')

export interface ToolDeps {
  readonly service: InkbridgeService
  readonly attachments: AttachmentsPort
  readonly config: InkbridgeConfig
}

/** Build the tool definition. Registered by host/index.ts via ctx.tools.register(...). */
export function createImageTool(deps: ToolDeps) {
  return defineTool({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: {
      prompt: { type: 'string', required: true, description: 'Detailed image prompt.' },
      mode: {
        type: 'string',
        enum: ['generate', 'edit'],
        description: "'edit' modifies references[0]. Default 'generate'.",
      },
      references: {
        type: 'array',
        items: { type: 'string' },
        description: 'Local image paths (PNG/JPEG/WebP). Relative paths resolve against the session working directory.',
      },
      aspect: { type: 'string', enum: [...ASPECTS], description: 'Aspect ratio hint.' },
      background: { type: 'string', enum: ['auto', 'transparent'], description: 'Request a transparent PNG.' },
      saveTo: { type: 'string', description: 'Optional workspace-relative output path ending in .png.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: { type: 'string', required: true },
          revisedPrompt: { type: 'string' },
          image: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: {
                type: 'string',
                enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
                required: true,
              },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              name: { type: 'string' },
            },
          },
          savedPath: { type: 'string' },
          transparentBackground: { type: 'boolean' },
          elapsedMs: { type: 'integer', required: true },
        },
      },
      render: (_args: unknown, value: GeneratedImageValue) => renderToolContent(value),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return executeImageTool(deps, args as ImageToolArgs, exec as unknown as ToolExecPort)
    },
  })
}

export interface ImageToolArgs {
  prompt: string
  mode?: 'generate' | 'edit'
  references?: string[]
  aspect?: AspectRatio
  background?: 'auto' | 'transparent'
  saveTo?: string
}

export async function executeImageTool(
  deps: ToolDeps,
  args: ImageToolArgs,
  exec: ToolExecPort,
): Promise<GeneratedImageValue> {
  const cwd = exec.agent?.session.header.cwd
  const references = (args.references ?? []).map((p) => resolveInside(cwd, p))
  if (args.mode === 'edit' && references.length === 0) {
    throw new InkbridgeError('invalid-request', "mode 'edit' requires references[0] (the image to edit)")
  }
  // TODO(M3): verify each reference exists and is PNG/JPEG/WebP → InkbridgeError('reference-not-found').

  const request: GenerateRequest = {
    prompt: args.prompt,
    references,
    ...(args.mode === undefined ? {} : { mode: args.mode }),
    ...(args.aspect === undefined ? {} : { aspect: args.aspect }),
    ...(args.background === undefined ? {} : { background: args.background }),
  }
  const result = await deps.service.generate(request, exec.signal)

  const dims = pngDimensions(result.bytes)
  if (dims === undefined) throw new InkbridgeError('no-image', 'Generated file is not a valid PNG')
  const ref = await deps.attachments.saveImage({ data: result.bytes, mediaType: 'image/png', name: 'inkbridge.png' })

  let savedPath: string | undefined
  const target = args.saveTo ?? (deps.config.saveToWorkspace ? defaultSaveName(deps.config.workspaceDir) : undefined)
  if (target !== undefined && cwd !== undefined) {
    savedPath = resolveInside(cwd, target)
    await mkdir(path.dirname(savedPath), { recursive: true })
    // TODO(M3): refuse to overwrite an existing file unless the name was generated by us.
    await writeFile(savedPath, result.bytes)
  }

  const value: { -readonly [K in keyof GeneratedImageValue]: GeneratedImageValue[K] } = {
    prompt: args.prompt,
    image: {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...(ref.name === undefined ? {} : { name: ref.name }),
    },
    elapsedMs: result.elapsedMs,
  }
  if (result.revisedPrompt !== undefined) value.revisedPrompt = result.revisedPrompt
  if (savedPath !== undefined) value.savedPath = savedPath
  if (args.background === 'transparent') value.transparentBackground = pngHasAlphaChannel(result.bytes)
  return value
}

/** Model-facing content: one text envelope + the image block. */
export function renderToolContent(value: GeneratedImageValue) {
  const lines = [
    `<image-generated elapsed="${Math.round(value.elapsedMs / 1000)}s">`,
    `${value.image.width}x${value.image.height} ${value.image.mediaType}`,
    value.savedPath === undefined ? undefined : `saved: ${value.savedPath}`,
    value.transparentBackground === false
      ? 'warning: transparency was requested but the PNG has no alpha channel'
      : undefined,
    '</image-generated>',
  ].filter((l): l is string => l !== undefined)
  return [
    { type: 'text' as const, text: lines.join('\n') },
    // attachmentId is branded in dsh-attachment; a plain string is structurally identical at runtime.
    { type: 'image' as const, attachment: value.image as never },
  ]
}

/** Resolve `p` against `cwd` and refuse escapes outside it (for saveTo and relative references). */
export function resolveInside(cwd: string | undefined, p: string): string {
  if (path.isAbsolute(p)) return path.normalize(p)
  if (cwd === undefined) throw new InkbridgeError('invalid-request', `Relative path needs a session workspace: ${p}`)
  const resolved = path.resolve(cwd, p)
  const rel = path.relative(cwd, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new InkbridgeError('invalid-request', `Path escapes the workspace: ${p}`)
  }
  return resolved
}

function defaultSaveName(dir: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return path.join(dir, `inkbridge-${stamp}.png`)
}
