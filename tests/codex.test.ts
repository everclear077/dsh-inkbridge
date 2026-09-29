import { describe, expect, it } from 'vitest'
import { maskEmail, toAccountInfo, toQuotaInfo } from '../src/codex/account.js'
import { redact } from '../src/codex/app-server.js'
import {
  buildPromptText,
  buildTurnInput,
  finalizeResult,
  pngDimensions,
  pngHasAlphaChannel,
} from '../src/codex/generate.js'

const turn = (status: 'completed' | 'failed' | 'interrupted') => ({ id: 't', status, error: null })
const base = { threadId: 'th', model: 'm', started: Date.now() - 1000, lastError: undefined }

describe('account mapping', () => {
  it('masks emails', () => {
    expect(maskEmail('alice@example.com')).toBe('a***@example.com')
    expect(maskEmail(null)).toBeUndefined()
  })
  it('maps account kinds', () => {
    expect(toAccountInfo({ account: null, requiresOpenaiAuth: true }).state).toBe('signed-out')
    expect(toAccountInfo({ account: { type: 'apiKey' }, requiresOpenaiAuth: true }).state).toBe('api-key')
    expect(
      toAccountInfo({ account: { type: 'chatgpt', email: 'bob@x.io', planType: 'plus' }, requiresOpenaiAuth: true }),
    ).toEqual({ state: 'signed-in', planType: 'plus', email: 'b***@x.io' })
  })
  it('maps quota', () => {
    const q = toQuotaInfo({
      limitId: 'codex',
      primary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1 },
      secondary: null,
      credits: { hasCredits: true, unlimited: false, balance: '5' },
      planType: 'plus',
      rateLimitReachedType: null,
    })
    expect(q).toEqual({
      usedPercent: 10,
      windowMinutes: 10080,
      resetsAt: 1,
      credits: { unlimited: false, balance: '5' },
      limitReached: false,
    })
  })
})

describe('generate helpers', () => {
  it('builds prompt constraints', () => {
    expect(buildPromptText({ prompt: 'a cat' })).toBe('a cat')
    expect(buildPromptText({ prompt: 'a cat', aspect: '16:9', background: 'transparent' })).toContain(
      'Aspect ratio: 16:9.',
    )
  })
  it('attaches references as localImage in order', () => {
    const input = buildTurnInput({ prompt: 'x', references: ['/a.png', '/b.png'] })
    expect(input.map((i) => i.type)).toEqual(['text', 'localImage', 'localImage'])
  })
  it('reads savedPath first, then base64', async () => {
    const png = Buffer.from('fake')
    const image = {
      type: 'imageGeneration' as const,
      id: 'i',
      status: 'completed',
      revisedPrompt: 'r',
      result: '',
      failure: null,
      savedPath: '/p.png',
    }
    const r = await finalizeResult({ ...base, turn: turn('completed'), image, readFileImpl: async () => png })
    expect(r.bytes).toEqual(png)
    expect(r.revisedPrompt).toBe('r')
    const r2 = await finalizeResult({
      ...base,
      turn: turn('completed'),
      image: { ...image, savedPath: undefined, result: png.toString('base64') } as never,
    })
    expect(r2.bytes).toEqual(png)
  })
  it('classifies failures', async () => {
    const image = {
      type: 'imageGeneration' as const,
      id: 'i',
      status: 'failed',
      revisedPrompt: null,
      result: '',
      failure: { type: 'usageLimitExceeded', resetsAt: 9 },
    }
    await expect(finalizeResult({ ...base, turn: turn('completed'), image })).rejects.toMatchObject({
      code: 'usage-limit',
    })
    await expect(finalizeResult({ ...base, turn: turn('completed'), image: undefined })).rejects.toMatchObject({
      code: 'no-image',
    })
    await expect(finalizeResult({ ...base, turn: turn('interrupted'), image: undefined })).rejects.toMatchObject({
      code: 'cancelled',
    })
  })
  it('parses PNG header', () => {
    const png = new Uint8Array(33)
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    new DataView(png.buffer).setUint32(16, 1254)
    new DataView(png.buffer).setUint32(20, 1254)
    png[25] = 6
    expect(pngDimensions(png)).toEqual({ width: 1254, height: 1254 })
    expect(pngHasAlphaChannel(png)).toBe(true)
    png[25] = 2
    expect(pngHasAlphaChannel(png)).toBe(false)
  })
  it('redacts secrets from stderr', () => {
    expect(redact('token eyJabc.def.ghi user a@b.com')).toBe('token <jwt> user <email>')
  })
})
