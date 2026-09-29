import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseLogin, statusFor } from '../src/host/routes.js'
import { Semaphore } from '../src/host/semaphore.js'
import { resolveInside } from '../src/host/tool.js'

describe('host helpers', () => {
  it('semaphore is FIFO and bounded', async () => {
    const s = new Semaphore(1)
    const order: number[] = []
    const r1 = await s.acquire()
    const p2 = s.acquire().then((r) => {
      order.push(2)
      return r
    })
    const p3 = s.acquire().then((r) => {
      order.push(3)
      return r
    })
    expect(s.pending).toBe(2)
    r1()
    ;(await p2)()
    ;(await p3)()
    expect(order).toEqual([2, 3])
  })

  it('semaphore waiter can be cancelled', async () => {
    const s = new Semaphore(1)
    await s.acquire()
    const ac = new AbortController()
    const p = s.acquire(ac.signal)
    ac.abort()
    await expect(p).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('resolveInside refuses escapes', () => {
    const cwd = path.resolve('/work/project')
    expect(resolveInside(cwd, 'out/a.png')).toBe(path.join(cwd, 'out', 'a.png'))
    expect(() => resolveInside(cwd, '../evil.png')).toThrow(/escapes/)
    expect(() => resolveInside(undefined, 'a.png')).toThrow(/workspace/)
  })

  it('parses login requests', () => {
    expect(parseLogin({}).method).toBe('browser')
    expect(parseLogin({ method: 'device-code' }).method).toBe('device-code')
    expect(() => parseLogin({ method: 'password' })).toThrow()
  })

  it('maps error codes to HTTP status', () => {
    expect(statusFor('not-signed-in')).toBe(409)
    expect(statusFor('usage-limit')).toBe(429)
    expect(statusFor('internal')).toBe(500)
  })
})
