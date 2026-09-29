/**
 * One image = one ephemeral Codex thread + one turn.
 *
 * Flow (verified live on codex-cli 0.153.4, ~51s end-to-end):
 *   thread/start {ephemeral, sandbox:read-only, approvalPolicy:never, cwd:<private tmp>, developerInstructions}
 *   turn/start   {threadId, input:[text, ...localImage]}
 *   ← item/completed {item.type:'imageGeneration', savedPath, result(base64), revisedPrompt, failure}
 *   ← turn/completed {turn.status}
 *
 * This module is pure orchestration over an RpcClient: no DSH imports, no file writes
 * except reading the produced image. Persisting into DSH is the tool's job (host/tool.ts).
 */
import { readFile } from 'node:fs/promises'
import { InkbridgeError } from './errors.js'
import {
  APPROVAL_REQUEST_METHODS,
  type ErrorNotification,
  type ImageGenerationItem,
  type ItemNotification,
  Method,
  type RpcNotification,
  type ThreadStartParams,
  type ThreadStartResponse,
  type TurnCompletedNotification,
  type TurnStartParams,
  type TurnStartResponse,
  type UserInput,
} from './protocol.js'
import type { RpcClient } from './rpc.js'

export type AspectRatio = '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '3:2' | '2:3'

export interface GenerateRequest {
  readonly prompt: string
  /** Absolute local paths. The first one is treated as the edit target when `mode === 'edit'`. */
  readonly references?: readonly string[]
  readonly mode?: 'generate' | 'edit'
  readonly aspect?: AspectRatio
  readonly background?: 'auto' | 'transparent'
}

export interface GenerateOptions {
  /** Private scratch directory used as the thread cwd (Codex sandbox is read-only there). */
  readonly workDir: string
  readonly reasoningEffort: string
  readonly timeoutMs: number
  readonly signal?: AbortSignal
  /** Progress hook for UI (phase changes only; no deltas). */
  readonly onPhase?: (phase: GeneratePhase) => void
}

export type GeneratePhase = 'thread' | 'turn' | 'rendering' | 'done'

export interface GenerateResult {
  readonly bytes: Buffer
  readonly mediaType: 'image/png'
  readonly revisedPrompt?: string
  readonly transparentBackground?: boolean
  /** Codex-side file (under $CODEX_HOME/generated_images). Informational. */
  readonly codexSavedPath?: string
  readonly threadId: string
  readonly model?: string
  readonly elapsedMs: number
}

/**
 * Fixed bridge instructions. Keep the model from "helping": one tool call, prompt verbatim.
 * Changing this text changes output quality — treat edits as behavior changes (add a test note).
 */
export const BRIDGE_INSTRUCTIONS = [
  'You are an image generation bridge for another application.',
  'Call the built-in image generation tool exactly once, using the user prompt verbatim as the image prompt.',
  'If images are attached, the first attached image is the edit target and the rest are references, in order.',
  'Do not run shell commands, do not read or write files, do not browse, and do not ask questions.',
  'After the image is generated, reply with the single word: done.',
].join(' ')

/** Turn the structured request into the user text sent to Codex. */
export function buildPromptText(request: GenerateRequest): string {
  const constraints: string[] = []
  if (request.aspect !== undefined) constraints.push(`Aspect ratio: ${request.aspect}.`)
  if (request.background === 'transparent') constraints.push('Transparent background (PNG with alpha).')
  if (request.mode === 'edit')
    constraints.push('Edit the first attached image; keep everything not mentioned unchanged.')
  return constraints.length === 0 ? request.prompt : `${request.prompt}\n\n${constraints.join(' ')}`
}

export function buildTurnInput(request: GenerateRequest): UserInput[] {
  const input: UserInput[] = [{ type: 'text', text: buildPromptText(request), text_elements: [] }]
  for (const path of request.references ?? []) input.push({ type: 'localImage', path })
  return input
}

/** Decline every approval/elicitation request: the bridge must never block on a human. */
export function declineServerRequest(method: string): unknown {
  if (APPROVAL_REQUEST_METHODS.has(method)) {
    // TODO(M1): return the exact decline shape per method once verified against the schema.
    // Current behavior: throwing makes RpcClient answer with a JSON-RPC error, which Codex treats as denial.
    throw new Error('Inkbridge does not approve actions')
  }
  throw new Error(`Unsupported server request: ${method}`)
}

export async function generateImage(
  rpc: RpcClient,
  request: GenerateRequest,
  options: GenerateOptions,
): Promise<GenerateResult> {
  if (request.prompt.trim() === '') throw new InkbridgeError('invalid-request', 'prompt must not be empty')
  const started = Date.now()
  const signal = options.signal

  options.onPhase?.('thread')
  const threadParams: ThreadStartParams = {
    cwd: options.workDir,
    ephemeral: true,
    sandbox: 'read-only',
    approvalPolicy: 'never',
    developerInstructions: BRIDGE_INSTRUCTIONS,
    config: { model_reasoning_effort: options.reasoningEffort },
  }
  const thread = await rpc.request<ThreadStartResponse>(Method.threadStart, threadParams, {
    timeoutMs: 30_000,
    ...(signal === undefined ? {} : { signal }),
  })
  const threadId = thread.thread.id

  let image: ImageGenerationItem | undefined
  let turnId: string | undefined
  let lastError: string | undefined

  const completion = new Promise<TurnCompletedNotification['turn']>((resolve) => {
    const off = rpc.onNotification((message: RpcNotification) => {
      const params = message.params as { threadId?: string } | undefined
      if (params?.threadId !== threadId) return
      if (message.method === Method.itemStarted) {
        const item = (message.params as ItemNotification).item
        if (item.type === 'imageGeneration') options.onPhase?.('rendering')
      } else if (message.method === Method.itemCompleted) {
        const item = (message.params as ItemNotification).item
        if (item.type === 'imageGeneration') image = item as ImageGenerationItem
      } else if (message.method === Method.error) {
        const err = message.params as ErrorNotification
        if (!err.willRetry) lastError = err.error.message
      } else if (message.method === Method.turnCompleted) {
        off()
        resolve((message.params as TurnCompletedNotification).turn)
      }
    })
  })

  options.onPhase?.('turn')
  const turnParams: TurnStartParams = { threadId, input: buildTurnInput(request) }
  const turnStart = await rpc.request<TurnStartResponse>(Method.turnStart, turnParams, {
    timeoutMs: 30_000,
    ...(signal === undefined ? {} : { signal }),
  })
  turnId = turnStart.turn.id

  const interrupt = () => {
    if (turnId !== undefined) void rpc.request(Method.turnInterrupt, { threadId, turnId }).catch(() => {})
  }
  signal?.addEventListener('abort', interrupt, { once: true })

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      interrupt()
      reject(new InkbridgeError('timeout', `Image generation timed out after ${options.timeoutMs}ms`))
    }, options.timeoutMs)
  })
  const aborted = new Promise<never>((_, reject) => {
    if (signal === undefined) return
    const fail = () => reject(new InkbridgeError('cancelled', 'Image generation was cancelled'))
    if (signal.aborted) fail()
    else signal.addEventListener('abort', fail, { once: true })
  })

  let turn: TurnCompletedNotification['turn']
  try {
    turn = await Promise.race([completion, timeout, aborted])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    signal?.removeEventListener('abort', interrupt)
  }

  return finalizeResult({ turn, image, lastError, threadId, model: thread.model, started })
}

/** Decide success/failure from what the turn produced. Exported for tests. */
export async function finalizeResult(input: {
  turn: TurnCompletedNotification['turn']
  image: ImageGenerationItem | undefined
  lastError: string | undefined
  threadId: string
  model: string | undefined
  started: number
  readFileImpl?: (path: string) => Promise<Buffer>
}): Promise<GenerateResult> {
  const { turn, image, threadId } = input
  if (image?.failure?.type === 'usageLimitExceeded') {
    throw new InkbridgeError('usage-limit', 'ChatGPT image generation limit reached', {
      details: { resetsAt: image.failure.resetsAt ?? null, limitId: image.failure.limitId ?? null },
    })
  }
  if (turn.status === 'interrupted') throw new InkbridgeError('cancelled', 'Image generation was interrupted')
  if (turn.status === 'failed') {
    throw new InkbridgeError('turn-failed', turn.error?.message ?? input.lastError ?? 'Codex turn failed')
  }
  if (image === undefined) {
    throw new InkbridgeError('no-image', 'Codex finished without producing an image', {
      details: { threadId, lastError: input.lastError ?? null },
    })
  }

  const read = input.readFileImpl ?? readFile
  let bytes: Buffer | undefined
  if (image.savedPath !== undefined && image.savedPath !== '') {
    try {
      bytes = await read(image.savedPath)
    } catch {
      bytes = undefined
    }
  }
  if ((bytes === undefined || bytes.length === 0) && image.result !== '') {
    bytes = Buffer.from(image.result, 'base64')
  }
  // TODO(M1): fallback #3 — scan $CODEX_HOME/generated_images/<threadId>/ for a file newer than `started`.
  if (bytes === undefined || bytes.length === 0) {
    throw new InkbridgeError('no-image', 'Image item had neither a readable savedPath nor base64 data')
  }

  const result: {
    -readonly [K in keyof GenerateResult]: GenerateResult[K]
  } = { bytes, mediaType: 'image/png', threadId, elapsedMs: Date.now() - input.started }
  if (image.revisedPrompt !== null) result.revisedPrompt = image.revisedPrompt
  if (image.transparentBackground !== undefined) result.transparentBackground = image.transparentBackground
  if (image.savedPath !== undefined) result.codexSavedPath = image.savedPath
  if (input.model !== undefined) result.model = input.model
  return result
}

/** PNG signature + IHDR color type check: true when the PNG can carry alpha. */
export function pngHasAlphaChannel(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 33 || signature.some((b, i) => bytes[i] !== b)) return false
  const colorType = bytes[25]
  // 4 = grayscale+alpha, 6 = RGBA. (tRNS chunk detection: TODO(M3))
  return colorType === 4 || colorType === 6
}

/** Read width/height from a PNG IHDR. */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}
