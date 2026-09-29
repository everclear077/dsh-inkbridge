import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type LocateEnv,
  locateCodex,
  pathBinaryCandidates,
  targetTriple,
  vendorBinaryCandidates,
} from '../src/platform/locate.js'

function env(platform: NodeJS.Platform, files: string[], extra: Partial<LocateEnv> = {}): LocateEnv {
  const set = new Set(files.map((f) => path.normalize(f)))
  return {
    platform,
    arch: 'x64',
    env: {},
    home: platform === 'win32' ? 'C:\\Users\\u' : '/Users/u',
    nodeExecPath: '/usr/bin/node',
    isFile: (p) => set.has(path.normalize(p)),
    npmGlobalRoot: async () => undefined,
    ...extra,
  }
}

describe('locate', () => {
  it('maps target triples', () => {
    expect(targetTriple('win32', 'x64')).toBe('x86_64-pc-windows-msvc')
    expect(targetTriple('darwin', 'arm64')).toBe('aarch64-apple-darwin')
    expect(targetTriple('freebsd', 'x64')).toBeUndefined()
  })

  it('knows both observed vendor layouts', () => {
    const c = vendorBinaryCandidates('/g/@openai/codex', 'win32', 'x64').map((p) => p.replaceAll('\\', '/'))
    expect(c.some((p) => p.endsWith('vendor/x86_64-pc-windows-msvc/codex/codex.exe'))).toBe(true)
    expect(c.some((p) => p.endsWith('vendor/x86_64-pc-windows-msvc/bin/codex.exe'))).toBe(true)
  })

  it('never proposes .cmd shims from PATH on Windows', () => {
    const c = pathBinaryCandidates('win32', { PATH: 'C:\\npm;C:\\bin' })
    expect(c.every((p) => p.endsWith('codex.exe'))).toBe(true)
  })

  it('prefers explicit config path', async () => {
    const loc = await locateCodex('/opt/codex', env('darwin', ['/opt/codex']))
    expect(loc.source).toBe('config')
    expect(loc.spec).toEqual({ command: '/opt/codex', prefixArgs: [] })
  })

  it('runs a configured codex.js through node', async () => {
    const loc = await locateCodex('/x/codex.js', env('linux', ['/x/codex.js']))
    expect(loc.spec).toEqual({ command: '/usr/bin/node', prefixArgs: ['/x/codex.js'] })
  })

  it('finds Homebrew on macOS when PATH is empty (Dock launch)', async () => {
    const loc = await locateCodex('', env('darwin', ['/opt/homebrew/bin/codex']))
    expect(loc.source).toBe('well-known')
  })

  it('falls back to node + launcher', async () => {
    const root = '/usr/local/lib/node_modules'
    const loc = await locateCodex('', env('linux', [path.join(root, '@openai', 'codex', 'bin', 'codex.js')]))
    expect(loc.source).toBe('npm-launcher')
  })

  it('throws codex-not-found', async () => {
    await expect(locateCodex('', env('linux', []))).rejects.toMatchObject({ code: 'codex-not-found' })
  })
})
