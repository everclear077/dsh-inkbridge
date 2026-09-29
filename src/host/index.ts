/**
 * Host entry — loaded by the Cordis Loader as the `inkbridge` entry (see cordis.patch.yml).
 *
 * Composition only: build the service, register the tool and the routes, tie everything
 * to the plugin context's lifetime. No business logic here.
 */
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import path from 'node:path'
import { ENTRY_ID } from '../shared/index.js'
import { Config, type InkbridgeConfig } from './config.js'
import type { AttachmentsPort, ConnectionPort, LoggerPort } from './dsh-ports.js'
import { registerRoutes } from './routes.js'
import { InkbridgeService } from './service.js'
import { createImageTool } from './tool.js'

export type { InkbridgeConfig }
export { Config }

/** Stable Loader identity. */
export const name = ENTRY_ID

/** Services this plugin needs. The Loader waits until all are available. */
export const inject = ['tools', 'attachments', 'connection'] as const

/**
 * Cordis context, typed structurally to the members we use.
 * TODO(M1): switch to `import type { Context } from '@deepseek-ai/cordis'` + module augmentation
 * once the dev dependency types are confirmed for 0.2.0-rc.1.
 */
export interface HostContext {
  readonly tools: { register(tool: unknown): unknown }
  readonly attachments: AttachmentsPort
  readonly connection: ConnectionPort
  effect(setup: () => () => void, label?: string): void
  logger?(name: string): LoggerPort
  on(event: 'dispose', listener: () => void | Promise<void>): void
}

export function apply(ctx: HostContext, config: InkbridgeConfig): void {
  const logger = ctx.logger?.('inkbridge')
  const service = new InkbridgeService({
    config,
    version: readOwnVersion(),
    dataDir: resolveDataDir(),
    ...(logger === undefined ? {} : { logger }),
  })

  ctx.effect(() => {
    const disposers = registerRoutes(ctx.connection, service)
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'inkbridge: settings routes')

  ctx.effect(() => {
    const registration = ctx.tools.register(createImageTool({ service, attachments: ctx.attachments, config }))
    return () => {
      if (typeof registration === 'function') (registration as () => void)()
    }
  }, 'inkbridge: image tool')

  ctx.effect(
    () => () => {
      void service.dispose()
    },
    'inkbridge: codex app-server',
  )
}

/** $DSH_HOME/inkbridge (falls back to ~/.dsh/inkbridge). */
function resolveDataDir(): string {
  // TODO(M1): use `dshHomePath('inkbridge')` from @deepseek-ai/dsh-home-paths (runtime-provided).
  const home = process.env.DSH_HOME?.trim() || path.join(homedir(), '.dsh')
  return path.join(home, 'inkbridge')
}

function readOwnVersion(): string {
  try {
    const require = createRequire(import.meta.url)
    return (require('../package.json') as { version: string }).version
  } catch {
    return '0.0.0'
  }
}
