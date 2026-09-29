/**
 * Browser-side HTTP client for the Host routes. The page never talks to Codex directly.
 * Paths are browser-relative (no leading slash) so they resolve against the page mount,
 * which works for both DSH Web (http://127.0.0.1:<port>/) and Desktop.
 */
import { type ApiError, browserRoute, type InkbridgeStatus, type LoginRequest, ROUTES } from '../shared/index.js'

export class InkbridgeApiError extends Error {
  constructor(
    readonly status: number,
    readonly payload: ApiError,
  ) {
    super(payload.message)
    this.name = 'InkbridgeApiError'
  }
}

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

export class InkbridgeApi {
  constructor(private readonly fetcher: Fetcher = (input, init) => fetch(input, init)) {}

  status(signal?: AbortSignal): Promise<InkbridgeStatus> {
    return this.call(ROUTES.status, 'GET', undefined, signal)
  }
  refresh(): Promise<InkbridgeStatus> {
    return this.call(ROUTES.refresh, 'POST', {})
  }
  login(method: LoginRequest['method']): Promise<InkbridgeStatus> {
    return this.call(ROUTES.login, 'POST', { method } satisfies LoginRequest)
  }
  cancelLogin(): Promise<InkbridgeStatus> {
    return this.call(ROUTES.loginCancel, 'POST', {})
  }
  logout(): Promise<InkbridgeStatus> {
    return this.call(ROUTES.logout, 'POST', {})
  }

  private async call<T>(
    route: (typeof ROUTES)[keyof typeof ROUTES],
    method: 'GET' | 'POST',
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const init: RequestInit = { method, cache: 'no-store' }
    if (signal !== undefined) init.signal = signal
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    const response = await this.fetcher(browserRoute(route), init)
    const payload = (await response.json().catch(() => ({ code: 'protocol', message: response.statusText }))) as unknown
    if (!response.ok) throw new InkbridgeApiError(response.status, payload as ApiError)
    return payload as T
  }
}
