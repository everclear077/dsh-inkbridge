/**
 * Owns ONE long-lived `codex app-server` child process and its RpcClient.
 *
 * Lifecycle:  stopped → starting → ready → (idle timeout | crash | dispose) → stopped
 * - Lazy: started on first use, never at plugin load (keeps DSH startup fast).
 * - Restartable: a crash rejects in-flight calls with `codex-crashed`; next `ensure()` respawns.
 * - Idle shutdown: stops after `idleShutdownMs` with no active leases.
 */
import { createInterface } from 'node:readline'
import { childEnv, killTree, type SpawnSpec, spawnPiped } from '../platform/process.js'
import { InkbridgeError } from './errors.js'
import { type InitializeParams, type InitializeResponse, Method } from './protocol.js'
import { RpcClient } from './rpc.js'

export interface AppServerOptions {
  readonly spec: SpawnSpec
  /** undefined = user's default ~/.codex */
  readonly codexHome: string | undefined
  readonly clientVersion: string
  readonly idleShutdownMs: number
  readonly logger?: { debug(msg: string): void; warn(msg: string): void }
}

export interface AppServerSession {
  readonly rpc: RpcClient
  readonly info: InitializeResponse
  readonly pid: number
}

const CLIENT_NAME = 'dsh_inkbridge'

export class AppServer {
  private session: AppServerSession | undefined
  private starting: Promise<AppServerSession> | undefined
  private leases = 0
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private readonly exitListeners = new Set<(error: InkbridgeError) => void>()
  private disposed = false

  constructor(private readonly options: AppServerOptions) {}

  /** Start (or reuse) the process and complete the initialize handshake. */
  ensure(): Promise<AppServerSession> {
    if (this.disposed) return Promise.reject(new InkbridgeError('internal', 'AppServer is disposed'))
    if (this.session !== undefined && !this.session.rpc.isClosed) return Promise.resolve(this.session)
    this.starting ??= this.start().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  /** Hold the process alive for the duration of `fn` (suspends idle shutdown). */
  async withLease<T>(fn: (session: AppServerSession) => Promise<T>): Promise<T> {
    const session = await this.ensure()
    this.leases++
    this.clearIdle()
    try {
      return await fn(session)
    } finally {
      this.leases--
      if (this.leases === 0) this.armIdle()
    }
  }

  /** Called with the crash reason when the process exits unexpectedly. */
  onExit(listener: (error: InkbridgeError) => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  get isRunning(): boolean {
    return this.session !== undefined && !this.session.rpc.isClosed
  }

  async stop(): Promise<void> {
    this.clearIdle()
    const session = this.session
    this.session = undefined
    if (session === undefined) return
    session.rpc.close(new InkbridgeError('cancelled', 'Codex app-server stopped'))
    await killTree(session.pid)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.exitListeners.clear()
    await this.stop()
  }

  private async start(): Promise<AppServerSession> {
    const { spec, codexHome, logger } = this.options
    let child: ReturnType<typeof spawnPiped>
    try {
      child = spawnPiped(spec, { args: ['app-server'], env: childEnv(process.env, codexHome) })
    } catch (cause) {
      throw new InkbridgeError('codex-start-failed', 'Failed to spawn codex app-server', { cause })
    }
    const pid = child.pid
    if (pid === undefined) throw new InkbridgeError('codex-start-failed', 'codex app-server did not start')

    const rpc = new RpcClient({ write: (line) => child.stdin.write(`${line}\n`), defaultTimeoutMs: 30_000 })
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => rpc.receive(line))

    let stderrTail = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-4096)
    })

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const error = new InkbridgeError('codex-crashed', `codex app-server exited (code=${code}, signal=${signal})`, {
        details: { stderrTail: redact(stderrTail) },
      })
      rpc.close(error)
      if (this.session?.pid === pid) this.session = undefined
      if (!this.disposed) for (const l of this.exitListeners) l(error)
    }
    child.once('exit', onExit)
    child.once('error', (cause) => {
      rpc.close(new InkbridgeError('codex-start-failed', `codex app-server error: ${cause.message}`, { cause }))
    })

    const params: InitializeParams = {
      clientInfo: { name: CLIENT_NAME, title: 'DSH Inkbridge', version: this.options.clientVersion },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        // We never render deltas; suppress the chattiest streams.
        optOutNotificationMethods: [
          'item/agentMessage/delta',
          'item/reasoning/textDelta',
          'item/reasoning/summaryTextDelta',
          'item/commandExecution/outputDelta',
        ],
      },
    }
    let info: InitializeResponse
    try {
      info = await rpc.request<InitializeResponse>(Method.initialize, params, { timeoutMs: 20_000 })
      rpc.notify(Method.initialized, {})
    } catch (cause) {
      await killTree(pid)
      throw new InkbridgeError('codex-start-failed', 'codex app-server initialize failed', {
        cause,
        details: { stderrTail: redact(stderrTail) },
      })
    }
    logger?.debug(`codex app-server ready pid=${pid} os=${info.platformOs}`)
    const session: AppServerSession = { rpc, info, pid }
    this.session = session
    this.armIdle()
    return session
  }

  private armIdle(): void {
    this.clearIdle()
    if (this.options.idleShutdownMs <= 0 || this.leases > 0) return
    this.idleTimer = setTimeout(() => {
      void this.stop()
    }, this.options.idleShutdownMs)
    this.idleTimer.unref?.()
  }

  private clearIdle(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }
}

/** Strip anything that looks like a bearer token or email before logging/exposing stderr. */
export function redact(text: string): string {
  return text
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<jwt>')
    .replace(/(bearer\s+)[\w.-]+/gi, '$1<redacted>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>')
}
