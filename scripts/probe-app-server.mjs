/**
 * Live probe: talks to the real local Codex app-server. Spends quota only with --generate.
 *
 *   pnpm probe                          # auth state, capabilities, quota
 *   pnpm probe -- --generate "a crane"  # one real image turn; prints the imageGeneration item
 *
 * Standalone on purpose (no build needed). Mirrors src/codex/* behavior; if they diverge,
 * trust src/ and update this script.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'

const triples = {
  'win32:x64': 'x86_64-pc-windows-msvc',
  'win32:arm64': 'aarch64-pc-windows-msvc',
  'darwin:x64': 'x86_64-apple-darwin',
  'darwin:arm64': 'aarch64-apple-darwin',
  'linux:x64': 'x86_64-unknown-linux-musl',
  'linux:arm64': 'aarch64-unknown-linux-musl',
}

function locate() {
  if (process.env.CODEX_BIN)
    return process.env.CODEX_BIN.endsWith('.js')
      ? [process.execPath, [process.env.CODEX_BIN]]
      : [process.env.CODEX_BIN, []]
  const triple = triples[`${process.platform}:${process.arch}`]
  const bin = process.platform === 'win32' ? 'codex.exe' : 'codex'
  const roots =
    process.platform === 'win32'
      ? [path.join(process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules')]
      : ['/opt/homebrew/lib/node_modules', '/usr/local/lib/node_modules']
  if (process.env.npm_config_prefix)
    roots.unshift(
      process.platform === 'win32'
        ? path.join(process.env.npm_config_prefix, 'node_modules')
        : path.join(process.env.npm_config_prefix, 'lib', 'node_modules'),
    )
  for (const root of roots) {
    const pkg = path.join(root, '@openai', 'codex')
    for (const sub of ['codex', 'bin']) {
      const p = path.join(
        pkg,
        'node_modules',
        '@openai',
        `codex-${process.platform}-${process.arch}`,
        'vendor',
        triple,
        sub,
        bin,
      )
      if (existsSync(p)) return [p, []]
    }
    const launcher = path.join(pkg, 'bin', 'codex.js')
    if (existsSync(launcher)) return [process.execPath, [launcher]]
  }
  for (const p of ['/opt/homebrew/bin/codex', '/usr/local/bin/codex']) if (existsSync(p)) return [p, []]
  throw new Error('codex not found; set CODEX_BIN')
}

const [cmd, prefix] = locate()
const env = { ...process.env }
for (const k of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN']) delete env[k]
const child = spawn(cmd, [...prefix, 'app-server'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env,
  shell: false,
  windowsHide: true,
})
child.stderr.resume()

let nextId = 1
const pending = new Map()
const listeners = []
createInterface({ input: child.stdout }).on('line', (line) => {
  if (!line.startsWith('{')) return
  const msg = JSON.parse(line)
  if (msg.id !== undefined && pending.has(msg.id) && !msg.method) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  } else if (msg.id !== undefined && msg.method) {
    child.stdin.write(`${JSON.stringify({ id: msg.id, error: { code: -32000, message: 'declined' } })}\n`)
  } else if (msg.method) {
    for (const l of listeners) l(msg)
  }
})
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    child.stdin.write(`${JSON.stringify(params === undefined ? { id, method } : { id, method, params })}\n`)
  })

const out = { launcher: [cmd, ...prefix].join(' ') }
out.initialize = (
  await request('initialize', {
    clientInfo: { name: 'dsh_inkbridge_probe', title: 'Inkbridge probe', version: '0.0.0' },
    capabilities: null,
  })
).result
child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`)
const acct = (await request('account/read', { refreshToken: false })).result
if (acct?.account?.email) acct.account.email = acct.account.email.replace(/^(.).*(@.*)$/, '$1***$2')
out.account = acct
out.capabilities = (await request('modelProvider/capabilities/read', {})).result
out.rateLimits = (await request('account/rateLimits/read')).result?.rateLimits

const gi = process.argv.indexOf('--generate')
if (gi > 0) {
  const prompt = process.argv[gi + 1] ?? 'A minimal flat icon of a paper crane on an off-white background'
  const started = Date.now()
  const events = new Set()
  const cwd = mkdtempSync(path.join(tmpdir(), 'inkbridge-probe-'))
  const thread = (
    await request('thread/start', {
      cwd,
      ephemeral: true,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      config: { model_reasoning_effort: 'low' },
      developerInstructions:
        'Call the built-in image generation tool exactly once with the user prompt verbatim. Do not run commands.',
    })
  ).result
  const threadId = thread.thread.id
  const done = new Promise((resolve) =>
    listeners.push((m) => {
      if (m.params?.threadId !== threadId) return
      events.add(m.method)
      if (m.method === 'item/completed' && m.params.item.type === 'imageGeneration') {
        const { result, ...rest } = m.params.item
        out.imageItem = { ...rest, resultBase64Length: result?.length ?? 0 }
      }
      if (m.method === 'turn/completed') resolve(m.params.turn)
    }),
  )
  await request('turn/start', { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }] })
  const turn = await done
  out.turn = { status: turn.status, error: turn.error, seconds: (Date.now() - started) / 1000, model: thread.model }
  out.events = [...events]
}

console.log(JSON.stringify(out, null, 2))
child.kill()
process.exit(0)
