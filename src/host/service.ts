/**
 * InkbridgeService — the single owner of all mutable Host state.
 *
 * Owns: codex location, the AppServer process, account/quota/capability snapshot,
 * the pending login, and the concurrency gate. Routes and the tool are thin adapters
 * that call into this class; they never touch AppServer/RpcClient directly.
 *
 * State flow:  (codex events | user actions) → service mutates snapshot → revision++ → listeners
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as account from '../codex/account.js'
import { AppServer } from '../codex/app-server.js'
import { InkbridgeError, toInkbridgeError } from '../codex/errors.js'
import { declineServerRequest, type GenerateRequest, type GenerateResult, generateImage } from '../codex/generate.js'
import { type AccountLoginCompletedNotification, Method } from '../codex/protocol.js'
import {
  type CodexLocation,
  defaultLocateEnv,
  type LocateEnv,
  locateCodex,
  readCodexVersion,
} from '../platform/locate.js'
import { openExternalUrl } from '../platform/process.js'
import type { InkbridgeStatus, PendingLogin } from '../shared/index.js'
import type { InkbridgeConfig } from './config.js'
import type { LoggerPort } from './dsh-ports.js'
import { Semaphore } from './semaphore.js'

export interface ServiceDeps {
  readonly config: InkbridgeConfig
  readonly version: string
  /** Absolute; resolved by the plugin entry (dshHomePath('inkbridge')). */
  readonly dataDir: string
  readonly logger?: LoggerPort
  /** Test seams. */
  readonly locateEnv?: LocateEnv
  readonly openUrl?: (url: string) => Promise<boolean>
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }
/** A status update; an explicit `undefined` clears that optional field. */
type StatusPatch = { -readonly [K in keyof InkbridgeStatus]?: InkbridgeStatus[K] | undefined }

export class InkbridgeService {
  private status: Mutable<InkbridgeStatus> = {
    revision: 0,
    runtime: { state: 'idle' },
    account: { state: 'unknown' },
    activeJobs: 0,
  }
  private location: CodexLocation | undefined
  private server: AppServer | undefined
  private readonly gate: Semaphore
  private readonly listeners = new Set<(status: InkbridgeStatus) => void>()
  private disposers: (() => void)[] = []

  constructor(private readonly deps: ServiceDeps) {
    this.gate = new Semaphore(deps.config.maxConcurrent)
  }

  // ---------------------------------------------------------------- read side

  snapshot(): InkbridgeStatus {
    return structuredClone(this.status)
  }

  subscribe(listener: (status: InkbridgeStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Re-read everything from Codex (starts the app-server if needed).
   * Never throws: failures are reflected into `status.runtime`.
   */
  async refresh(): Promise<InkbridgeStatus> {
    try {
      const server = await this.ensureServer()
      await server.withLease(async ({ rpc }) => {
        const [acct, capability] = await Promise.all([
          account.readAccount(rpc),
          account.readImageCapability(rpc).catch(() => undefined),
        ])
        this.patch({
          account: this.status.pendingLogin
            ? { ...acct, state: acct.state === 'signed-in' ? 'signed-in' : 'signing-in' }
            : acct,
        })
        if (capability !== undefined) this.patch({ imageGeneration: capability })
        if (acct.state === 'signed-in') {
          const quota = await account.readQuota(rpc).catch(() => undefined)
          if (quota !== undefined) this.patch({ quota })
        }
      })
    } catch (error) {
      this.reflectRuntimeError(error)
    }
    return this.snapshot()
  }

  // ---------------------------------------------------------------- login

  /** Start ChatGPT OAuth. Browser flow opens the system browser on the Host. */
  async login(method: 'browser' | 'device-code'): Promise<InkbridgeStatus> {
    const server = await this.ensureServer()
    await server.withLease(async ({ rpc }) => {
      if (this.status.pendingLogin !== undefined) {
        await account.cancelLogin(rpc, this.status.pendingLogin.loginId).catch(() => {})
      }
      const started = await account.startLogin(rpc, method)
      const pending: PendingLogin =
        started.method === 'browser'
          ? { loginId: started.loginId, method: 'browser', authUrl: started.authUrl, startedAt: Date.now() }
          : {
              loginId: started.loginId,
              method: 'device-code',
              verificationUrl: started.verificationUrl,
              userCode: started.userCode,
              startedAt: Date.now(),
            }
      this.patch({ pendingLogin: pending, account: { state: 'signing-in' }, lastLoginError: undefined })
      const url = started.method === 'browser' ? started.authUrl : started.verificationUrl
      const opened = await (this.deps.openUrl ?? openExternalUrl)(url)
      if (!opened) this.deps.logger?.warn('inkbridge: could not open the system browser; user must copy the URL')
    })
    // TODO(M2): keep a lease while a login is pending so idle shutdown cannot kill the callback listener.
    return this.snapshot()
  }

  async cancelLogin(): Promise<InkbridgeStatus> {
    const pending = this.status.pendingLogin
    if (pending === undefined || this.server === undefined) return this.snapshot()
    await this.server.withLease(({ rpc }) => account.cancelLogin(rpc, pending.loginId)).catch(() => {})
    this.patch({ pendingLogin: undefined })
    return this.refresh()
  }

  async logout(): Promise<InkbridgeStatus> {
    const server = await this.ensureServer()
    await server.withLease(({ rpc }) => account.logout(rpc))
    this.patch({ account: { state: 'signed-out' }, quota: undefined })
    return this.snapshot()
  }

  // ---------------------------------------------------------------- generate

  /** Preconditions + concurrency + scratch dir around codex/generate.ts. */
  async generate(request: GenerateRequest, signal: AbortSignal): Promise<GenerateResult> {
    await this.assertReady()
    const release = await this.gate.acquire(signal)
    this.patch({ activeJobs: this.status.activeJobs + 1 })
    const scratchRoot = path.join(this.deps.dataDir, 'scratch')
    await mkdir(scratchRoot, { recursive: true })
    const workDir = await mkdtemp(path.join(scratchRoot, 'turn-'))
    try {
      const server = await this.ensureServer()
      return await server.withLease(({ rpc }) =>
        generateImage(rpc, request, {
          workDir,
          reasoningEffort: this.deps.config.reasoningEffort,
          timeoutMs: this.deps.config.turnTimeoutMs,
          signal,
        }),
      )
    } catch (error) {
      const e = toInkbridgeError(error)
      if (e.code === 'usage-limit') void this.refresh()
      throw e
    } finally {
      release()
      this.patch({ activeJobs: Math.max(0, this.status.activeJobs - 1) })
      await rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  // ---------------------------------------------------------------- lifecycle

  async dispose(): Promise<void> {
    for (const d of this.disposers.splice(0)) d()
    this.listeners.clear()
    await this.server?.dispose()
    this.server = undefined
  }

  // ---------------------------------------------------------------- internals

  private async assertReady(): Promise<void> {
    if (this.status.account.state === 'unknown') await this.refresh()
    const state = this.status.account.state
    if (this.status.runtime.state === 'not-installed') {
      throw new InkbridgeError('codex-not-found', this.status.runtime.error ?? 'Codex CLI not found')
    }
    if (state === 'api-key') {
      throw new InkbridgeError(
        'api-key-login',
        'Codex is logged in with an API key; sign in with ChatGPT in Settings → Inkbridge',
      )
    }
    if (state !== 'signed-in') {
      throw new InkbridgeError('not-signed-in', 'Not signed in to ChatGPT; open Settings → Inkbridge and sign in')
    }
    if (this.status.imageGeneration === false) {
      throw new InkbridgeError(
        'image-generation-unavailable',
        'Image generation is not available for this ChatGPT plan',
      )
    }
  }

  private async ensureServer(): Promise<AppServer> {
    if (this.server !== undefined) return this.server
    this.patch({ runtime: { ...this.status.runtime, state: 'starting' } })
    try {
      this.location ??= await locateCodex(this.deps.config.codexPath, this.deps.locateEnv ?? defaultLocateEnv())
    } catch (error) {
      const e = toInkbridgeError(error)
      this.patch({ runtime: { state: 'not-installed', error: e.message } })
      throw e
    }
    const codexHome = this.deps.config.codexHome === 'isolated' ? path.join(this.deps.dataDir, 'codex-home') : undefined
    if (codexHome !== undefined) await mkdir(codexHome, { recursive: true })
    const server = new AppServer({
      spec: this.location.spec,
      codexHome,
      clientVersion: this.deps.version,
      idleShutdownMs: this.deps.config.idleShutdownMs,
      ...(this.deps.logger === undefined ? {} : { logger: this.deps.logger }),
    })
    this.disposers.push(
      server.onExit((error) => {
        this.patch({ runtime: { ...this.status.runtime, state: 'error', error: error.message } })
      }),
    )
    const session = await server.ensure()
    session.rpc.setServerRequestHandler((message) => declineServerRequest(message.method))
    this.disposers.push(session.rpc.onNotification((m) => this.onNotification(m.method, m.params)))
    // TODO(M1): re-attach handler + notification listener after an idle restart (AppServer emits a new session).
    const version = await readCodexVersion(this.location.spec).catch(() => undefined)
    this.patch({
      runtime: {
        state: 'ready',
        executable: this.location.display,
        source: this.location.source,
        platformOs: session.info.platformOs,
        codexHome: session.info.codexHome,
        ...(version === undefined ? {} : { version }),
      },
    })
    this.server = server
    return server
  }

  private onNotification(method: string, params: unknown): void {
    if (method === Method.loginCompleted) {
      const done = params as AccountLoginCompletedNotification
      if (this.status.pendingLogin !== undefined && done.loginId !== this.status.pendingLogin.loginId) return
      this.patch({ pendingLogin: undefined, lastLoginError: done.success ? undefined : (done.error ?? 'Login failed') })
      void this.refresh()
    } else if (method === Method.accountUpdated || method === Method.rateLimitsUpdated) {
      void this.refresh()
    }
  }

  private reflectRuntimeError(error: unknown): void {
    const e = toInkbridgeError(error)
    if (e.code === 'codex-not-found') return // already reflected
    this.patch({ runtime: { ...this.status.runtime, state: 'error', error: e.message } })
  }

  private patch(update: StatusPatch): void {
    const next = { ...this.status, ...update, revision: this.status.revision + 1 } as StatusPatch
    for (const key of Object.keys(update) as (keyof InkbridgeStatus)[]) {
      if (update[key] === undefined) delete next[key]
    }
    this.status = next as Mutable<InkbridgeStatus>
    const snap = this.snapshot()
    for (const l of this.listeners) l(snap)
  }
}

/** Default data dir when DSH home helpers are unavailable (tests, scripts). */
export function fallbackDataDir(): string {
  return path.join(tmpdir(), 'dsh-inkbridge')
}
