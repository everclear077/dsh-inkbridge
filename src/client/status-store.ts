/**
 * Tiny external store for the settings page: holds the latest InkbridgeStatus and exposes
 * `getSnapshot/subscribe` for React's useSyncExternalStore.
 *
 * TODO(M2): replace polling with a push channel (SSE route or Typert stream) once chosen;
 * see docs/ROADMAP.md "M2 open question".
 */
import type { InkbridgeStatus } from '../shared/index.js'
import type { InkbridgeApi } from './api.js'

export interface StatusView {
  readonly status: InkbridgeStatus | undefined
  readonly loading: boolean
  readonly error: string | undefined
}

export class StatusStore {
  private view: StatusView = { status: undefined, loading: false, error: undefined }
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setInterval> | undefined
  private disposed = false

  constructor(private readonly api: InkbridgeApi) {}

  getSnapshot = (): StatusView => this.view

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Poll while the page is visible. Faster while a login is pending. */
  start(): void {
    if (this.timer !== undefined) return
    void this.load()
    this.timer = setInterval(() => void this.load(), this.view.status?.pendingLogin ? 1500 : 5000)
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Run an action and adopt the status it returns. */
  async run(action: (api: InkbridgeApi) => Promise<InkbridgeStatus>): Promise<void> {
    this.set({ loading: true, error: undefined })
    try {
      this.accept(await action(this.api))
    } catch (error) {
      this.set({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      this.set({ loading: false })
    }
  }

  dispose(): void {
    this.disposed = true
    this.stop()
    this.listeners.clear()
  }

  private async load(): Promise<void> {
    try {
      this.accept(await this.api.status())
    } catch (error) {
      this.set({ error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Drop out-of-order responses by revision. */
  private accept(status: InkbridgeStatus): void {
    const current = this.view.status
    if (current !== undefined && status.revision < current.revision) return
    const wasPending = current?.pendingLogin !== undefined
    this.set({ status, error: undefined })
    if (wasPending !== (status.pendingLogin !== undefined) && this.timer !== undefined) {
      this.stop()
      this.start()
    }
  }

  private set(patch: Partial<StatusView>): void {
    if (this.disposed) return
    this.view = { ...this.view, ...patch }
    for (const l of this.listeners) l()
  }
}
