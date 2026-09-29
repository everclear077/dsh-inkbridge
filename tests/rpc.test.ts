import { describe, expect, it } from 'vitest'
import { InkbridgeError } from '../src/codex/errors.js'
import { RpcClient } from '../src/codex/rpc.js'

function pair() {
  const sent: Record<string, unknown>[] = []
  const rpc = new RpcClient({ write: (line) => sent.push(JSON.parse(line)), defaultTimeoutMs: 1000 })
  return { rpc, sent }
}

describe('RpcClient', () => {
  it('correlates responses by id', async () => {
    const { rpc, sent } = pair()
    const p = rpc.request<{ ok: boolean }>('account/read', { refreshToken: false })
    expect(sent[0]).toMatchObject({ id: 1, method: 'account/read', params: { refreshToken: false } })
    rpc.receive(JSON.stringify({ id: 1, result: { ok: true } }))
    await expect(p).resolves.toEqual({ ok: true })
  })

  it('maps JSON-RPC errors to InkbridgeError(protocol)', async () => {
    const { rpc } = pair()
    const p = rpc.request('thread/start')
    rpc.receive(JSON.stringify({ id: 1, error: { code: -32600, message: 'bad' } }))
    await expect(p).rejects.toMatchObject({ code: 'protocol' })
  })

  it('times out', async () => {
    const { rpc } = pair()
    await expect(rpc.request('x', undefined, { timeoutMs: 10 })).rejects.toMatchObject({ code: 'timeout' })
  })

  it('honors AbortSignal', async () => {
    const { rpc } = pair()
    const ac = new AbortController()
    const p = rpc.request('x', undefined, { signal: ac.signal })
    ac.abort()
    await expect(p).rejects.toMatchObject({ code: 'cancelled' })
    expect(rpc.inFlight).toBe(0)
  })

  it('dispatches notifications and ignores non-JSON noise', () => {
    const { rpc } = pair()
    const seen: string[] = []
    rpc.onNotification((m) => seen.push(m.method))
    rpc.receive('WARNING: something on stdout')
    rpc.receive(JSON.stringify({ method: 'turn/completed', params: {} }))
    expect(seen).toEqual(['turn/completed'])
  })

  it('answers server requests (errors when no handler)', async () => {
    const { rpc, sent } = pair()
    rpc.receive(JSON.stringify({ id: 'srv-1', method: 'execCommandApproval', params: {} }))
    await Promise.resolve()
    expect(sent.at(-1)).toMatchObject({ id: 'srv-1', error: { code: -32601 } })
  })

  it('rejects everything on close', async () => {
    const { rpc } = pair()
    const p = rpc.request('x')
    rpc.close(new InkbridgeError('codex-crashed', 'gone'))
    await expect(p).rejects.toMatchObject({ code: 'codex-crashed' })
    await expect(rpc.request('y')).rejects.toMatchObject({ code: 'codex-crashed' })
  })
})
