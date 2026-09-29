/**
 * Regenerate the full Codex app-server TypeScript schema into .codex-schema/ (git-ignored).
 * Use it to diff protocol changes after a Codex upgrade, then update src/codex/protocol.ts by hand.
 *
 *   pnpm schema:codex
 */
import { spawnSync } from 'node:child_process'

const bin = process.env.CODEX_BIN ?? 'codex'
const useShell = process.platform === 'win32' && !bin.endsWith('.exe')
const result = spawnSync(bin, ['app-server', 'generate-ts', '--out', '.codex-schema'], {
  stdio: 'inherit',
  shell: useShell,
})
process.exit(result.status ?? 1)
