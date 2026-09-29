/**
 * Browser-safe contract shared by the Host and Client halves.
 *
 * RULES (see docs/CODING_STANDARDS.md §3):
 * - Constants and types only. No Node imports, no runtime dependencies.
 * - Every wire shape crossing Host ↔ Client lives here and nowhere else.
 */

/** Package / bundle identity. Must equal package.json#name. */
export const PACKAGE_NAME = 'dsh-inkbridge'

/** Loader entry id used in cordis.patch.yml. */
export const ENTRY_ID = 'inkbridge'

/** Model-facing tool name. Prefixed so it never collides with other image plugins. */
export const TOOL_NAME = 'inkbridge_generate_image'

/** Settings section id (settings.section slot). */
export const SETTINGS_SECTION_ID = 'inkbridge'

/** Client locale namespace. */
export const LOCALE_NS = 'inkbridge'

/**
 * Authenticated Host routes. They ride DSH's `/api` channel through
 * `ctx.connection.fetch.register`, so the Host/Origin fence and browser auth
 * already apply. Segment grammar: [A-Za-z0-9_$.-]+ (no extra slashes).
 */
export const ROUTES = {
  status: '/api/inkbridge.status',
  refresh: '/api/inkbridge.refresh',
  login: '/api/inkbridge.login',
  loginCancel: '/api/inkbridge.login.cancel',
  logout: '/api/inkbridge.logout',
  testGenerate: '/api/inkbridge.test',
} as const

/** Browser-relative form (the page resolves it against its own mount, like first-party plugins). */
export function browserRoute(path: (typeof ROUTES)[keyof typeof ROUTES]): string {
  return path.slice(1)
}

// ---------------------------------------------------------------------------
// Status snapshot (Host → Client)
// ---------------------------------------------------------------------------

export type RuntimeState =
  /** No codex executable found. */
  | 'not-installed'
  /** Found, app-server not started yet (lazy). */
  | 'idle'
  | 'starting'
  | 'ready'
  /** Process crashed or failed to initialize. */
  | 'error'

export type AuthState =
  | 'unknown'
  | 'signed-out'
  | 'signing-in'
  | 'signed-in'
  /** Logged in with an API key, which Inkbridge refuses to use (would bill per call). */
  | 'api-key'

export interface CodexRuntimeInfo {
  readonly state: RuntimeState
  /** Resolved executable, when found. Display only. */
  readonly executable?: string
  readonly version?: string
  /** Where discovery found it (config / path / npm-global / well-known). */
  readonly source?: string
  readonly platformOs?: string
  readonly codexHome?: string
  readonly error?: string
}

export interface AccountInfo {
  readonly state: AuthState
  /** Masked (a***@example.com). Never the raw address. */
  readonly email?: string
  readonly planType?: string
}

export interface PendingLogin {
  readonly loginId: string
  readonly method: 'browser' | 'device-code'
  /** Browser flow: URL opened on the Host; shown so the user can copy it. */
  readonly authUrl?: string
  /** Device flow. */
  readonly verificationUrl?: string
  readonly userCode?: string
  readonly startedAt: number
}

export interface QuotaInfo {
  readonly usedPercent?: number
  readonly windowMinutes?: number
  /** Unix seconds. */
  readonly resetsAt?: number
  readonly credits?: { readonly unlimited: boolean; readonly balance?: string }
  readonly limitReached: boolean
}

export interface InkbridgeStatus {
  /** Monotonic; lets the page drop stale responses. */
  readonly revision: number
  readonly runtime: CodexRuntimeInfo
  readonly account: AccountInfo
  /** `modelProvider/capabilities/read` → imageGeneration. Undefined until known. */
  readonly imageGeneration?: boolean
  readonly quota?: QuotaInfo
  readonly pendingLogin?: PendingLogin
  readonly lastLoginError?: string
  readonly activeJobs: number
}

// ---------------------------------------------------------------------------
// Requests (Client → Host)
// ---------------------------------------------------------------------------

export interface LoginRequest {
  readonly method: 'browser' | 'device-code'
}

export interface ApiError {
  readonly code: InkbridgeErrorCode
  readonly message: string
}

/** Stable, machine-readable failure codes. UI copy is keyed by these. */
export type InkbridgeErrorCode =
  | 'codex-not-found'
  | 'codex-start-failed'
  | 'codex-crashed'
  | 'protocol'
  | 'not-signed-in'
  | 'api-key-login'
  | 'image-generation-unavailable'
  | 'usage-limit'
  | 'turn-failed'
  | 'no-image'
  | 'timeout'
  | 'cancelled'
  | 'invalid-request'
  | 'reference-not-found'
  | 'internal'

// ---------------------------------------------------------------------------
// Tool value (Host tool output ↔ Client tool view)
// ---------------------------------------------------------------------------

export interface GeneratedImageValue {
  readonly prompt: string
  readonly revisedPrompt?: string
  /** Durable DSH attachment reference fields (see dsh-attachment ImageAttachmentRef). */
  readonly image: {
    readonly attachmentId: string
    readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
    readonly bytes: number
    readonly width: number
    readonly height: number
    readonly name?: string
  }
  /** Workspace copy, when saved. */
  readonly savedPath?: string
  readonly transparentBackground?: boolean
  readonly elapsedMs: number
}
