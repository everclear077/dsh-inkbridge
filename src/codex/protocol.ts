/**
 * Hand-maintained subset of the Codex app-server protocol that Inkbridge uses.
 *
 * Source of truth: `codex app-server generate-ts --out .codex-schema` (run `pnpm schema:codex`).
 * Verified against codex-cli 0.153.4. See docs/CODEX_PROTOCOL.md.
 *
 * RULES:
 * - Only add fields we actually read. Keep everything optional-tolerant: the protocol moves fast.
 * - Never import generated schema files at runtime; they are version-specific.
 */

export type RequestId = number

export interface RpcRequest<P = unknown> {
  readonly id: RequestId
  readonly method: string
  readonly params?: P
}

export interface RpcResponse<R = unknown> {
  readonly id: RequestId
  readonly result?: R
  readonly error?: RpcErrorPayload
}

export interface RpcNotification<P = unknown> {
  readonly method: string
  readonly params?: P
}

/** Server → client request (has both id and method). We must answer or the turn stalls. */
export interface RpcServerRequest<P = unknown> {
  readonly id: RequestId | string
  readonly method: string
  readonly params?: P
}

export interface RpcErrorPayload {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

// --- initialize ------------------------------------------------------------

export interface InitializeParams {
  readonly clientInfo: { readonly name: string; readonly title: string | null; readonly version: string }
  readonly capabilities: {
    readonly experimentalApi: boolean
    readonly requestAttestation: boolean
    readonly optOutNotificationMethods?: readonly string[] | null
  } | null
}

export interface InitializeResponse {
  readonly userAgent: string
  readonly codexHome: string
  readonly platformFamily: string
  readonly platformOs: string
}

// --- account ---------------------------------------------------------------

export type Account =
  | { readonly type: 'apiKey' }
  | { readonly type: 'chatgpt'; readonly email: string | null; readonly planType: string }
  | { readonly type: 'amazonBedrock'; readonly usesCodexManagedCredentials?: boolean }

export interface GetAccountResponse {
  readonly account: Account | null
  readonly requiresOpenaiAuth: boolean
}

export type LoginAccountParams =
  | {
      readonly type: 'chatgpt'
      readonly useHostedLoginSuccessPage?: boolean
      readonly appBrand?: 'codex' | 'chatgpt' | null
    }
  | { readonly type: 'chatgptDeviceCode' }

export type LoginAccountResponse =
  | { readonly type: 'chatgpt'; readonly loginId: string; readonly authUrl: string }
  | {
      readonly type: 'chatgptDeviceCode'
      readonly loginId: string
      readonly verificationUrl: string
      readonly userCode: string
    }
  | { readonly type: string }

export interface AccountLoginCompletedNotification {
  readonly loginId: string | null
  readonly success: boolean
  readonly error: string | null
}

export interface AccountUpdatedNotification {
  readonly authMode: string | null
  readonly planType: string | null
}

export interface RateLimitWindow {
  readonly usedPercent: number
  readonly windowDurationMins: number | null
  readonly resetsAt: number | null
}

export interface RateLimitSnapshot {
  readonly limitId: string | null
  readonly primary: RateLimitWindow | null
  readonly secondary: RateLimitWindow | null
  readonly credits: {
    readonly hasCredits: boolean
    readonly unlimited: boolean
    readonly balance: string | null
  } | null
  readonly planType: string | null
  readonly rateLimitReachedType: string | null
}

export interface GetAccountRateLimitsResponse {
  readonly rateLimits: RateLimitSnapshot
}

export interface ModelProviderCapabilitiesReadResponse {
  readonly namespaceTools: boolean
  readonly imageGeneration: boolean
  readonly webSearch: boolean
}

// --- threads & turns -------------------------------------------------------

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type AskForApproval = 'untrusted' | 'on-request' | 'never'

export interface ThreadStartParams {
  readonly cwd?: string | null
  readonly approvalPolicy?: AskForApproval | null
  readonly sandbox?: SandboxMode | null
  readonly config?: Readonly<Record<string, unknown>> | null
  readonly developerInstructions?: string | null
  readonly ephemeral?: boolean | null
  readonly model?: string | null
}

export interface ThreadStartResponse {
  readonly thread: { readonly id: string }
  readonly model: string
}

export type UserInput =
  | { readonly type: 'text'; readonly text: string; readonly text_elements: readonly never[] }
  | { readonly type: 'localImage'; readonly path: string }
  | { readonly type: 'image'; readonly url: string }

export interface TurnStartParams {
  readonly threadId: string
  readonly input: readonly UserInput[]
  readonly effort?: string | null
}

export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress'

export interface TurnError {
  readonly message: string
  readonly codexErrorInfo?: unknown
  readonly additionalDetails?: string | null
}

export interface Turn {
  readonly id: string
  readonly status: TurnStatus
  readonly error: TurnError | null
  readonly durationMs?: number | null
}

export interface TurnStartResponse {
  readonly turn: Turn
}

export interface TurnCompletedNotification {
  readonly threadId: string
  readonly turn: Turn
}

export interface ImageGenerationFailure {
  readonly type: 'usageLimitExceeded' | string
  readonly limitId?: string
  readonly resetsAt?: number | null
}

/** `item.type === 'imageGeneration'` in item/started and item/completed. */
export interface ImageGenerationItem {
  readonly type: 'imageGeneration'
  readonly id: string
  readonly status: string
  readonly revisedPrompt: string | null
  /** Base64 image bytes (may be empty when savedPath is set; tolerate both). */
  readonly result: string
  readonly transparentBackground?: boolean
  readonly failure: ImageGenerationFailure | null
  /** Absolute path under $CODEX_HOME/generated_images/<threadId>/<itemId>.png */
  readonly savedPath?: string
}

export interface ThreadItemBase {
  readonly type: string
  readonly id: string
}

export interface ItemNotification {
  readonly item: ThreadItemBase & Partial<ImageGenerationItem>
  readonly threadId: string
  readonly turnId: string
}

export interface ErrorNotification {
  readonly error: TurnError
  readonly willRetry: boolean
  readonly threadId: string
  readonly turnId: string
}

/** Method names, in one place. */
export const Method = {
  initialize: 'initialize',
  initialized: 'initialized',
  accountRead: 'account/read',
  loginStart: 'account/login/start',
  loginCancel: 'account/login/cancel',
  logout: 'account/logout',
  rateLimitsRead: 'account/rateLimits/read',
  capabilitiesRead: 'modelProvider/capabilities/read',
  threadStart: 'thread/start',
  turnStart: 'turn/start',
  turnInterrupt: 'turn/interrupt',
  // notifications
  loginCompleted: 'account/login/completed',
  accountUpdated: 'account/updated',
  rateLimitsUpdated: 'account/rateLimits/updated',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  turnCompleted: 'turn/completed',
  error: 'error',
} as const

/** Server→client requests that would need a human. Inkbridge always declines them (see generate.ts). */
export const APPROVAL_REQUEST_METHODS: ReadonlySet<string> = new Set([
  'applyPatchApproval',
  'execCommandApproval',
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
])
