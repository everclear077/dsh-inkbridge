/**
 * Minimal JSON-RPC 2.0 client over newline-delimited JSON (Codex app-server stdio framing;
 * the `"jsonrpc":"2.0"` field is omitted on the wire).
 *
 * Transport-agnostic: give it a `write(line)` sink and feed it lines with `receive(line)`.
 * That keeps it fully unit-testable without spawning a process.
 */
import { InkbridgeError } from './errors.js'
import type { RequestId, RpcErrorPayload, RpcNotification, RpcServerRequest } from './protocol.js'

export type NotificationListener = (message: RpcNotification) => void
/** Return the `result` to send back, or throw to send an error. */
export type ServerRequestHandler = (message: RpcServerRequest) => Promise<unknown> | unknown

interface Pending {
  readonly method: string
  readonly resolve: (value: unknown) => void
  readonly reject: (error: InkbridgeError) => void
  readonly timer: ReturnType<typeof setTimeout> | undefined
  readonly cleanup: () => void
}

export interface RpcClientOptions {
  /** Write one serialized message (the client appends '\n'). */
  readonly write: (line: string) => void
  readonly defaultTimeoutMs?: number
}

export class RpcClient {
  private nextId: RequestId = 1
  private readonly pending = new Map<RequestId, Pending>()
  private readonly listeners = new Set<NotificationListener>()
  private serverRequestHandler: ServerRequestHandler | undefined
  private closedError: InkbridgeError | undefined

  constructor(private readonly options: RpcClientOptions) {}

  /** Send a request; resolves with `result`, rejects with InkbridgeError('protocol' | 'timeout' | 'cancelled'). */
  request<R>(method: string, params?: unknown, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<R> {
    if (this.closedError !== undefined) return Promise.reject(this.closedError)
    const id = this.nextId++
    const timeoutMs = opts?.timeoutMs ?? this.options.defaultTimeoutMs ?? 30_000

    return new Promise<R>((resolve, reject) => {
      const signal = opts?.signal
      const onAbort = () => {
        this.settle(id)?.reject(new InkbridgeError('cancelled', `${method} was cancelled`))
      }
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.settle(id)?.reject(new InkbridgeError('timeout', `${method} timed out after ${timeoutMs}ms`))
            }, timeoutMs)
          : undefined
      if (signal?.aborted) {
        if (timer) clearTimeout(timer)
        reject(new InkbridgeError('cancelled', `${method} was cancelled`))
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        method,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      })
      this.send(params === undefined ? { id, method } : { id, method, params })
    })
  }

  /** Fire-and-forget notification (e.g. `initialized`). */
  notify(method: string, params?: unknown): void {
    if (this.closedError !== undefined) return
    this.send(params === undefined ? { method } : { method, params })
  }

  onNotification(listener: NotificationListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Exactly one handler; server requests without a handler get a -32601 error. */
  setServerRequestHandler(handler: ServerRequestHandler | undefined): void {
    this.serverRequestHandler = handler
  }

  /** Feed one line read from the transport. Non-JSON lines are ignored (Codex may log to stdout). */
  receive(line: string): void {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed[0] !== '{') return
    let message: Record<string, unknown>
    try {
      message = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      return
    }
    const hasId = message.id !== undefined && message.id !== null
    const hasMethod = typeof message.method === 'string'

    if (hasId && !hasMethod) {
      const entry = this.settle(message.id as RequestId)
      if (entry === undefined) return
      const error = message.error as RpcErrorPayload | undefined
      if (error !== undefined) {
        entry.reject(
          new InkbridgeError('protocol', `${entry.method}: ${error.message}`, {
            details: { rpcCode: error.code, method: entry.method },
          }),
        )
      } else {
        entry.resolve(message.result)
      }
      return
    }

    if (hasId && hasMethod) {
      void this.answerServerRequest(message as unknown as RpcServerRequest)
      return
    }

    if (hasMethod) {
      const notification = message as unknown as RpcNotification
      for (const listener of this.listeners) {
        try {
          listener(notification)
        } catch {
          /* a faulty listener must not break the stream */
        }
      }
    }
  }

  /** Reject everything in flight and refuse new requests (process exited). */
  close(reason: InkbridgeError): void {
    if (this.closedError !== undefined) return
    this.closedError = reason
    for (const id of [...this.pending.keys()]) this.settle(id)?.reject(reason)
    this.listeners.clear()
  }

  get isClosed(): boolean {
    return this.closedError !== undefined
  }

  get inFlight(): number {
    return this.pending.size
  }

  private async answerServerRequest(message: RpcServerRequest): Promise<void> {
    const handler = this.serverRequestHandler
    if (handler === undefined) {
      this.send({ id: message.id, error: { code: -32601, message: `Unhandled server request: ${message.method}` } })
      return
    }
    try {
      const result = await handler(message)
      this.send({ id: message.id, result: result ?? null })
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      this.send({ id: message.id, error: { code: -32000, message: text } })
    }
  }

  private settle(id: RequestId): Pending | undefined {
    const entry = this.pending.get(id)
    if (entry === undefined) return undefined
    this.pending.delete(id)
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.cleanup()
    return entry
  }

  private send(message: object): void {
    this.options.write(JSON.stringify(message))
  }
}
