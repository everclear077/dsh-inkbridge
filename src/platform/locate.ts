/**
 * Locate a runnable Codex CLI on Windows / macOS / Linux.
 *
 * Resolution order (first hit wins):
 *   1. config.codexPath (explicit user choice)
 *   2. native binary inside an npm-installed @openai/codex platform package
 *      (npm global root, via `npm root -g`, plus well-known prefixes)
 *   3. `codex` / `codex.exe` on PATH — only accepted if it is a real binary,
 *      never a .cmd/.ps1 shim (those need a shell)
 *   4. well-known install dirs (Homebrew, /usr/local/bin, ~/.local/bin, ...)
 *   5. fallback: node + @openai/codex/bin/codex.js (works everywhere node does)
 *
 * macOS note: apps launched from Dock/Finder do NOT inherit the login-shell PATH,
 * so step 4 is essential there.
 *
 * Pure path logic is separated from I/O so it can be unit-tested with a fake fs.
 */
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { InkbridgeError } from '../codex/errors.js'
import { type Platform, runCapture, type SpawnSpec } from './process.js'

export type CodexSource = 'config' | 'npm-vendor' | 'path' | 'well-known' | 'npm-launcher'

export interface CodexLocation {
  readonly spec: SpawnSpec
  readonly source: CodexSource
  /** Human-readable path for the settings page. */
  readonly display: string
}

export interface LocateEnv {
  readonly platform: Platform
  readonly arch: string
  readonly env: NodeJS.ProcessEnv
  readonly home: string
  readonly nodeExecPath: string
  readonly isFile: (p: string) => boolean
  /** Returns `npm root -g`, or undefined. Injected so tests never spawn. */
  readonly npmGlobalRoot: () => Promise<string | undefined>
}

/** Rust target triple used by @openai/codex platform packages. */
export function targetTriple(platform: Platform, arch: string): string | undefined {
  const table: Record<string, string> = {
    'win32:x64': 'x86_64-pc-windows-msvc',
    'win32:arm64': 'aarch64-pc-windows-msvc',
    'darwin:x64': 'x86_64-apple-darwin',
    'darwin:arm64': 'aarch64-apple-darwin',
    'linux:x64': 'x86_64-unknown-linux-musl',
    'linux:arm64': 'aarch64-unknown-linux-musl',
  }
  return table[`${platform}:${arch}`]
}

export function platformPackageName(platform: Platform, arch: string): string {
  return `@openai/codex-${platform}-${arch}`
}

export function binaryName(platform: Platform): string {
  return platform === 'win32' ? 'codex.exe' : 'codex'
}

/**
 * Candidate native binaries inside an npm install of @openai/codex rooted at `codexPkgDir`.
 * Layout observed in 0.153.x (both appear in the wild):
 *   node_modules/@openai/codex-<os>-<arch>/vendor/<triple>/codex/codex(.exe)
 *   node_modules/@openai/codex-<os>-<arch>/vendor/<triple>/bin/codex(.exe)
 */
export function vendorBinaryCandidates(codexPkgDir: string, platform: Platform, arch: string): string[] {
  const triple = targetTriple(platform, arch)
  if (triple === undefined) return []
  const bin = binaryName(platform)
  const pkg = platformPackageName(platform, arch)
  const roots = [
    path.join(codexPkgDir, 'node_modules', pkg),
    path.join(path.dirname(codexPkgDir), pkg.split('/')[1] ?? ''),
  ]
  const out: string[] = []
  for (const root of roots) {
    out.push(path.join(root, 'vendor', triple, 'codex', bin))
    out.push(path.join(root, 'vendor', triple, 'bin', bin))
  }
  out.push(path.join(codexPkgDir, 'vendor', triple, 'codex', bin))
  return out
}

/** Well-known locations for a standalone codex binary. */
export function wellKnownBinaries(platform: Platform, home: string, env: NodeJS.ProcessEnv): string[] {
  const bin = binaryName(platform)
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
    return [path.join(local, 'Programs', 'codex', bin), path.join(home, '.codex', 'bin', bin)]
  }
  return [
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    '/usr/bin/codex',
    path.join(home, '.local', 'bin', 'codex'),
    path.join(home, '.codex', 'bin', 'codex'),
  ]
}

/** Well-known npm global roots (used when `npm root -g` is unavailable, e.g. GUI launch on macOS). */
export function wellKnownNpmRoots(platform: Platform, home: string, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    const appData = env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
    return [path.join(appData, 'npm', 'node_modules')]
  }
  return [
    '/opt/homebrew/lib/node_modules',
    '/usr/local/lib/node_modules',
    path.join(home, '.npm-global', 'lib', 'node_modules'),
  ]
}

/** Real-binary candidates for `codex` on PATH. Shims (.cmd/.ps1/.bat) are excluded on purpose. */
export function pathBinaryCandidates(platform: Platform, env: NodeJS.ProcessEnv): string[] {
  const sep = platform === 'win32' ? ';' : ':'
  const raw = env.PATH ?? env.Path ?? ''
  const bin = binaryName(platform)
  return raw
    .split(sep)
    .filter((dir) => dir.length > 0)
    .map((dir) => path.join(dir, bin))
}

export async function locateCodex(configPath: string | undefined, e: LocateEnv): Promise<CodexLocation> {
  // 1. explicit
  if (configPath !== undefined && configPath.trim() !== '') {
    const p = configPath.trim()
    if (!e.isFile(p)) throw new InkbridgeError('codex-not-found', `Configured codexPath does not exist: ${p}`)
    return p.endsWith('.js')
      ? { spec: { command: e.nodeExecPath, prefixArgs: [p] }, source: 'config', display: p }
      : { spec: { command: p, prefixArgs: [] }, source: 'config', display: p }
  }

  // 2. npm-installed native binary
  const npmRoots: string[] = []
  const detected = await e.npmGlobalRoot()
  if (detected !== undefined) npmRoots.push(detected)
  npmRoots.push(...wellKnownNpmRoots(e.platform, e.home, e.env))
  for (const root of npmRoots) {
    const pkgDir = path.join(root, '@openai', 'codex')
    for (const candidate of vendorBinaryCandidates(pkgDir, e.platform, e.arch)) {
      if (e.isFile(candidate))
        return { spec: { command: candidate, prefixArgs: [] }, source: 'npm-vendor', display: candidate }
    }
  }

  // 3. PATH (real binaries only)
  for (const candidate of pathBinaryCandidates(e.platform, e.env)) {
    if (e.isFile(candidate)) return { spec: { command: candidate, prefixArgs: [] }, source: 'path', display: candidate }
  }

  // 4. well-known dirs
  for (const candidate of wellKnownBinaries(e.platform, e.home, e.env)) {
    if (e.isFile(candidate))
      return { spec: { command: candidate, prefixArgs: [] }, source: 'well-known', display: candidate }
  }

  // 5. node + launcher script
  for (const root of npmRoots) {
    const launcher = path.join(root, '@openai', 'codex', 'bin', 'codex.js')
    if (e.isFile(launcher)) {
      return { spec: { command: e.nodeExecPath, prefixArgs: [launcher] }, source: 'npm-launcher', display: launcher }
    }
  }

  throw new InkbridgeError(
    'codex-not-found',
    'Codex CLI was not found. Install it with `npm i -g @openai/codex` or `brew install codex`.',
  )
}

/** Production LocateEnv. */
export function defaultLocateEnv(): LocateEnv {
  return {
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    home: homedir(),
    nodeExecPath: process.execPath,
    isFile: (p) => {
      try {
        return existsSync(p) && statSync(p).isFile()
      } catch {
        return false
      }
    },
    npmGlobalRoot: async () => {
      // TODO(M1): `npm` on Windows is npm.cmd (a shim). Resolve npm-cli.js next to node and run
      // it via process.execPath instead of relying on a shell. Until then, rely on well-known roots.
      if (process.platform === 'win32') return undefined
      const { code, stdout } = await runCapture({ command: 'npm', prefixArgs: [] }, ['root', '-g'], 5_000)
      const out = stdout.trim()
      return code === 0 && out !== '' ? out : undefined
    },
  }
}

/** `codex --version` → "0.153.4" (undefined if it cannot be read). */
export async function readCodexVersion(spec: SpawnSpec): Promise<string | undefined> {
  const { code, stdout } = await runCapture(spec, ['--version'], 10_000)
  if (code !== 0) return undefined
  return /(\d+\.\d+\.\d+[\w.-]*)/.exec(stdout)?.[1]
}
