/**
 * Account operations over an initialized app-server session.
 *
 * Pure mapping functions (`toAccountInfo`, `toQuotaInfo`, `maskEmail`) are exported for tests;
 * the async functions are thin RPC wrappers. State ownership lives in host/service.ts.
 */
import type { AccountInfo, QuotaInfo } from '../shared/index.js'
import {
  type GetAccountRateLimitsResponse,
  type GetAccountResponse,
  type LoginAccountParams,
  type LoginAccountResponse,
  Method,
  type ModelProviderCapabilitiesReadResponse,
  type RateLimitSnapshot,
} from './protocol.js'
import type { RpcClient } from './rpc.js'

export function maskEmail(email: string | null | undefined): string | undefined {
  if (email === null || email === undefined || email === '') return undefined
  const at = email.indexOf('@')
  if (at <= 0) return '***'
  return `${email[0]}***${email.slice(at)}`
}

export function toAccountInfo(response: GetAccountResponse): AccountInfo {
  const account = response.account
  if (account === null) return { state: 'signed-out' }
  if (account.type === 'apiKey') return { state: 'api-key' }
  if (account.type === 'chatgpt') {
    const email = maskEmail(account.email)
    return email === undefined
      ? { state: 'signed-in', planType: account.planType }
      : { state: 'signed-in', planType: account.planType, email }
  }
  // Bedrock and future modes are not a ChatGPT subscription.
  return { state: 'signed-out' }
}

export function toQuotaInfo(snapshot: RateLimitSnapshot): QuotaInfo {
  const primary = snapshot.primary
  const quota: {
    usedPercent?: number
    windowMinutes?: number
    resetsAt?: number
    credits?: { unlimited: boolean; balance?: string }
    limitReached: boolean
  } = { limitReached: snapshot.rateLimitReachedType !== null && snapshot.rateLimitReachedType !== undefined }
  if (primary !== null) {
    quota.usedPercent = primary.usedPercent
    if (primary.windowDurationMins !== null) quota.windowMinutes = primary.windowDurationMins
    if (primary.resetsAt !== null) quota.resetsAt = primary.resetsAt
  }
  if (snapshot.credits !== null) {
    quota.credits =
      snapshot.credits.balance === null
        ? { unlimited: snapshot.credits.unlimited }
        : { unlimited: snapshot.credits.unlimited, balance: snapshot.credits.balance }
  }
  return quota
}

export async function readAccount(rpc: RpcClient, refreshToken = false): Promise<AccountInfo> {
  return toAccountInfo(await rpc.request<GetAccountResponse>(Method.accountRead, { refreshToken }))
}

export async function readQuota(rpc: RpcClient): Promise<QuotaInfo> {
  const response = await rpc.request<GetAccountRateLimitsResponse>(Method.rateLimitsRead)
  return toQuotaInfo(response.rateLimits)
}

export async function readImageCapability(rpc: RpcClient): Promise<boolean> {
  const response = await rpc.request<ModelProviderCapabilitiesReadResponse>(Method.capabilitiesRead, {})
  return response.imageGeneration === true
}

export type LoginStart =
  | { readonly method: 'browser'; readonly loginId: string; readonly authUrl: string }
  | {
      readonly method: 'device-code'
      readonly loginId: string
      readonly verificationUrl: string
      readonly userCode: string
    }

/**
 * Start ChatGPT OAuth managed by Codex. The app-server hosts the localhost callback itself;
 * completion arrives later as `account/login/completed`.
 */
export async function startLogin(rpc: RpcClient, method: 'browser' | 'device-code'): Promise<LoginStart> {
  const params: LoginAccountParams =
    method === 'browser'
      ? { type: 'chatgpt', useHostedLoginSuccessPage: true, appBrand: 'chatgpt' }
      : { type: 'chatgptDeviceCode' }
  const response = await rpc.request<LoginAccountResponse>(Method.loginStart, params)
  if (response.type === 'chatgpt' && 'authUrl' in response) {
    return { method: 'browser', loginId: response.loginId, authUrl: response.authUrl }
  }
  if (response.type === 'chatgptDeviceCode' && 'userCode' in response) {
    return {
      method: 'device-code',
      loginId: response.loginId,
      verificationUrl: response.verificationUrl,
      userCode: response.userCode,
    }
  }
  throw new Error(`Unexpected login response type: ${response.type}`)
}

export async function cancelLogin(rpc: RpcClient, loginId: string): Promise<void> {
  await rpc.request(Method.loginCancel, { loginId })
}

export async function logout(rpc: RpcClient): Promise<void> {
  await rpc.request(Method.logout)
}
