import { InkbridgeError } from '../codex/errors.js'

/** FIFO counting semaphore with AbortSignal support. */
export class Semaphore {
  private available: number
  private readonly waiters: { resolve: () => void; reject: (e: unknown) => void; signal?: AbortSignal }[] = []

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Semaphore capacity must be a positive integer')
    this.available = capacity
  }

  /** Resolves with a release function. Rejects with `cancelled` if the signal aborts while waiting. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new InkbridgeError('cancelled', 'Cancelled while waiting for a slot'))
    if (this.available > 0) {
      this.available--
      return Promise.resolve(this.releaser())
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => resolve(this.releaser()),
        reject,
        ...(signal === undefined ? {} : { signal }),
      }
      this.waiters.push(waiter)
      signal?.addEventListener(
        'abort',
        () => {
          const i = this.waiters.indexOf(waiter)
          if (i >= 0) {
            this.waiters.splice(i, 1)
            reject(new InkbridgeError('cancelled', 'Cancelled while waiting for a slot'))
          }
        },
        { once: true },
      )
    })
  }

  get pending(): number {
    return this.waiters.length
  }

  private releaser(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiters.shift()
      if (next !== undefined) next.resolve()
      else this.available++
    }
  }
}
