import type { InkbridgeErrorCode } from '../shared/index.js'

/**
 * The single error type thrown across Inkbridge.
 *
 * - `code` is stable and machine-readable (UI copy and tests key off it).
 * - `message` is English, developer-facing, safe to show (never contains tokens or emails).
 * - `details` is structured, JSON-serializable context.
 */
export class InkbridgeError extends Error {
  readonly code: InkbridgeErrorCode
  readonly details: Readonly<Record<string, unknown>> | undefined

  constructor(
    code: InkbridgeErrorCode,
    message: string,
    options?: { details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'InkbridgeError'
    this.code = code
    this.details = options?.details
  }

  toJSON(): { code: InkbridgeErrorCode; message: string; details?: Readonly<Record<string, unknown>> } {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details }
  }
}

export function isInkbridgeError(value: unknown): value is InkbridgeError {
  return value instanceof InkbridgeError
}

/** Normalize anything thrown into an InkbridgeError (unknown errors become `internal`). */
export function toInkbridgeError(value: unknown): InkbridgeError {
  if (value instanceof InkbridgeError) return value
  if (value instanceof Error && value.name === 'AbortError') {
    return new InkbridgeError('cancelled', 'The operation was cancelled', { cause: value })
  }
  const message = value instanceof Error ? value.message : String(value)
  return new InkbridgeError('internal', message, { cause: value })
}
