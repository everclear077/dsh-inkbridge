/**
 * Narrow, locally-declared views of the DSH Host services Inkbridge uses.
 *
 * Why local: several DSH services are typed in browser-side or unpublished packages, and
 * pinning to their full types couples us to internals that change every release. We declare
 * exactly the members we call, verified against DSH 0.2.0-rc.1 compiled sources
 * (see docs/DSH_INTEGRATION.md for where each shape was observed).
 *
 * RULE: every access to a DSH service goes through one of these ports.
 */

/** `ctx.connection` (dsh-client-connection host half). */
export interface ConnectionPort {
  readonly fetch: {
    /**
     * Register an exact `/api/<segment>` route behind the Host/Origin fence + browser auth.
     * Returns a disposer (registration is an effect on the calling context).
     */
    register(route: {
      path: string
      methods: readonly ('GET' | 'POST' | 'HEAD')[]
      requestBody: 'buffered' | 'streaming'
      fetch: (request: Request) => Promise<Response>
    }): () => void
  }
}

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** Durable image reference (dsh-attachment ImageAttachmentRef, structurally). */
export interface ImageAttachmentRef {
  readonly attachmentId: string
  readonly mediaType: ImageMediaType
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
  readonly originalDimensions?: { readonly width: number; readonly height: number }
}

/** `ctx.attachments` (dsh-attachment AttachmentStore). */
export interface AttachmentsPort {
  readonly imageLimits: {
    readonly maxImageBytes: number
    readonly maxMessageImageBytes: number
    readonly maxImageDimension: number
    readonly maxImagePixels: number
    readonly mediaTypes: readonly ImageMediaType[]
  }
  saveImage(input: { data: Uint8Array; mediaType: ImageMediaType; name?: string }): Promise<ImageAttachmentRef>
}

/** Minimal logger shape (Cordis `ctx.logger(name)`). */
export interface LoggerPort {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/** The subset of a tool execution context (`exec`) the image tool reads. */
export interface ToolExecPort {
  readonly signal: AbortSignal
  readonly callId?: string
  readonly agent?: {
    readonly session: { readonly header: { readonly cwd?: string } }
  }
}
