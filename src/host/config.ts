/**
 * Plugin configuration (the `config:` block of the `inkbridge` Loader entry).
 * Defaults here MUST match cordis.patch.yml.
 */
import z from '@deepseek-ai/schemastery'

export interface InkbridgeConfig {
  /** 'shared' reuses ~/.codex (same login as the Codex CLI); 'isolated' uses $DSH_HOME/inkbridge/codex-home. */
  codexHome: 'shared' | 'isolated'
  /** Explicit codex binary or codex.js; '' = auto-discover. */
  codexPath: string
  /** Reasoning effort of the orchestrating Codex model (not the image renderer). */
  reasoningEffort: 'minimal' | 'low' | 'medium' | 'high'
  /** Concurrent image turns across all sessions. */
  maxConcurrent: number
  /** Hard cap per image turn. */
  turnTimeoutMs: number
  /** Stop the app-server after this long without work. 0 = never. */
  idleShutdownMs: number
  /** Also write each result into the session workspace. */
  saveToWorkspace: boolean
  /** Workspace-relative directory for saved results. */
  workspaceDir: string
}

export const Config: z<InkbridgeConfig> = z.object({
  codexHome: z.union(['shared', 'isolated']).default('shared'),
  codexPath: z.string().default(''),
  reasoningEffort: z.union(['minimal', 'low', 'medium', 'high']).default('low'),
  maxConcurrent: z.natural().min(1).max(4).default(2),
  turnTimeoutMs: z.natural().min(30_000).max(1_800_000).default(600_000),
  idleShutdownMs: z.natural().min(0).default(900_000),
  saveToWorkspace: z.boolean().default(false),
  workspaceDir: z.string().default('inkbridge'),
}) as z<InkbridgeConfig>
