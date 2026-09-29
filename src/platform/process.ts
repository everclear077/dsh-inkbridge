/**
 * Cross-platform process helpers. The ONLY module allowed to call `child_process`
 * (see docs/CODING_STANDARDS.md §5).
 *
 * Hard rules encoded here:
 * - Never `shell: true`. Arguments are argv, never a command string.
 * - On Windows never spawn a `.cmd`/`.ps1` shim; resolve to a real `.exe`
 *   or to `node <codex.js>` (see locate.ts).
 * - Always kill the whole tree; Codex spawns helpers.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'

export type Platform = NodeJS.Platform

export interface SpawnSpec {
  /** Absolute executable path (a native binary or process.execPath for node). */
  readonly command: string
  /** Leading argv, e.g. [<codex.js>] when running through node. */
  readonly prefixArgs: readonly string[]
}

export interface SpawnOptions {
  readonly args: readonly string[]
  readonly env: NodeJS.ProcessEnv
  readonly cwd?: string
}

/** Environment variables that would silently switch Codex to metered API billing. */
export const BILLING_ENV_DENYLIST: readonly string[] = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT_ID',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
]

/**
 * Build the child environment: inherit, drop billing overrides, optionally pin CODEX_HOME.
 * @param base - usually process.env
 * @param codexHome - isolated home, or undefined to keep the user's default (~/.codex)
 */
export function childEnv(base: NodeJS.ProcessEnv, codexHome: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const key of BILLING_ENV_DENYLIST) delete env[key]
  if (codexHome !== undefined) env.CODEX_HOME = codexHome
  return env
}

/** Spawn with piped stdio and no shell. Caller owns the lifecycle. */
export function spawnPiped(spec: SpawnSpec, options: SpawnOptions): ChildProcessWithoutNullStreams {
  return spawn(spec.command, [...spec.prefixArgs, ...options.args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: options.env,
    cwd: options.cwd,
    shell: false,
    windowsHide: true,
    // POSIX: own process group so killTree can signal the whole group.
    detached: process.platform !== 'win32',
  })
}

/**
 * Terminate a process and its descendants. Resolves when the kill was issued.
 * TODO(M1): wait for 'exit' with a bounded timeout, escalate SIGTERM → SIGKILL on POSIX.
 */
export async function killTree(pid: number, platform: Platform = process.platform): Promise<void> {
  if (platform === 'win32') {
    await runQuiet('taskkill', ['/PID', String(pid), '/T', '/F'])
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
}

/**
 * Open a URL in the user's default browser on the Host machine.
 * Windows: rundll32 url.dll,FileProtocolHandler (no cmd.exe `start` quoting pitfalls).
 * macOS: open. Linux/BSD: xdg-open.
 * Resolves true when the opener exited 0 (does not prove the page loaded).
 */
export async function openExternalUrl(url: string, platform: Platform = process.platform): Promise<boolean> {
  if (!/^https:\/\//i.test(url)) return false
  const [command, args] =
    platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  return (await runQuiet(command, args)) === 0
}

/** Run a short helper command, discard output, resolve its exit code (-1 on spawn failure). */
export function runQuiet(command: string, args: readonly string[], timeoutMs = 10_000): Promise<number> {
  return new Promise((resolve) => {
    let settled = false
    const done = (code: number) => {
      if (!settled) {
        settled = true
        resolve(code)
      }
    }
    try {
      const child = spawn(command, [...args], { stdio: 'ignore', shell: false, windowsHide: true })
      const timer = setTimeout(() => {
        child.kill()
        done(-1)
      }, timeoutMs)
      child.once('error', () => {
        clearTimeout(timer)
        done(-1)
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        done(code ?? -1)
      })
    } catch {
      done(-1)
    }
  })
}

/** Run a command and capture stdout (for `codex --version`, `npm root -g`). */
export function runCapture(
  spec: SpawnSpec,
  args: readonly string[],
  timeoutMs = 10_000,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    let stdout = ''
    let settled = false
    const done = (code: number) => {
      if (!settled) {
        settled = true
        resolve({ code, stdout })
      }
    }
    try {
      const child = spawn(spec.command, [...spec.prefixArgs, ...args], {
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: false,
        windowsHide: true,
      })
      const timer = setTimeout(() => {
        child.kill()
        done(-1)
      }, timeoutMs)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        if (stdout.length < 64 * 1024) stdout += chunk
      })
      child.once('error', () => {
        clearTimeout(timer)
        done(-1)
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        done(code ?? -1)
      })
    } catch {
      done(-1)
    }
  })
}
