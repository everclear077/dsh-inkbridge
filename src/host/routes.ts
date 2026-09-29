/**
 * Authenticated HTTP routes for the settings page.
 *
 * Registered through `ctx.connection.fetch.register`, i.e. DSH's `/api` channel, so every
 * request has already passed the Host/Origin fence and browser authentication before it
 * reaches these handlers. Do NOT use `ctx.webServer.register` for these (that bypasses auth).
 *
 * Wire format: JSON in, JSON out. Success → 200 InkbridgeStatus. Failure → 4xx/5xx ApiError.
 */
import { InkbridgeError, toInkbridgeError } from '../codex/errors.js'
import { type ApiError, type InkbridgeErrorCode, type LoginRequest, ROUTES } from '../shared/index.js'
import type { ConnectionPort } from './dsh-ports.js'
import type { InkbridgeService } from './service.js'

const MAX_BODY_BYTES = 16 * 1024

export function registerRoutes(connection: ConnectionPort, service: InkbridgeService): (() => void)[] {
  const post = (path: string, handler: (body: unknown) => Promise<unknown>) =>
    connection.fetch.register({
      path,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handle(request, handler),
    })

  return [
    connection.fetch.register({
      path: ROUTES.status,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => json(200, service.snapshot()),
    }),
    post(ROUTES.refresh, () => service.refresh()),
    post(ROUTES.login, (body) => service.login(parseLogin(body).method)),
    post(ROUTES.loginCancel, () => service.cancelLogin()),
    post(ROUTES.logout, () => service.logout()),
    // TODO(M2): ROUTES.testGenerate — tiny generation for the "test" button (explicit quota warning in UI).
  ]
}

async function handle(request: Request, handler: (body: unknown) => Promise<unknown>): Promise<Response> {
  try {
    const body = await readJson(request)
    return json(200, await handler(body))
  } catch (error) {
    const e = toInkbridgeError(error)
    const payload: ApiError = { code: e.code, message: e.message }
    return json(statusFor(e.code), payload)
  }
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) throw new InkbridgeError('invalid-request', 'Request body too large')
  if (text.trim() === '') return {}
  const type = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (type !== 'application/json') throw new InkbridgeError('invalid-request', 'Content-Type must be application/json')
  try {
    return JSON.parse(text)
  } catch {
    throw new InkbridgeError('invalid-request', 'Body is not valid JSON')
  }
}

export function parseLogin(body: unknown): LoginRequest {
  const method = (body as { method?: unknown } | null)?.method ?? 'browser'
  if (method !== 'browser' && method !== 'device-code') {
    throw new InkbridgeError('invalid-request', "method must be 'browser' or 'device-code'")
  }
  return { method }
}

export function statusFor(code: InkbridgeErrorCode): number {
  switch (code) {
    case 'invalid-request':
    case 'reference-not-found':
      return 400
    case 'not-signed-in':
    case 'api-key-login':
      return 409
    case 'usage-limit':
      return 429
    case 'codex-not-found':
    case 'image-generation-unavailable':
      return 424
    case 'timeout':
      return 504
    default:
      return 500
  }
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
