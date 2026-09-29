/**
 * Browser entry — served as lib/client.js by dsh-client-modules.
 *
 * Registers:
 *   - `settings.section` → the 墨桥 settings page (own top-level menu entry)
 *   - TODO(M3): `tool.call.toolview` keyed by TOOL_NAME → inline image card in the conversation
 *
 * Slot/locale APIs are typed structurally here (see docs/DSH_INTEGRATION.md §4);
 * shapes verified against first-party plugins in DSH 0.2.0-rc.1.
 */
import { createElement } from 'react'
import { LOCALE_NS, SETTINGS_SECTION_ID } from '../shared/index.js'
import { InkbridgeApi } from './api.js'
import { en, type LocaleKey, zh } from './locales.js'
import { SettingsSection } from './SettingsSection.js'
import { StatusStore } from './status-store.js'

export const inject = ['slots', 'locale'] as const

interface SlotRegistration {
  name: string
  id?: string
  key?: string
  order?: number
  label?: () => string
  locale?: string
  inject?: () => unknown
}

export interface ClientContext {
  readonly slots: {
    inject(name: string, register: () => (() => void) | undefined): void
    register(options: SlotRegistration, component: (props: never) => unknown): () => void
  }
  readonly locale: {
    register(ns: string, dictionaries: Record<string, Record<string, string>>): () => void
    bind(ns: string): (key: string, params?: Record<string, string | number>) => string
  }
  effect(setup: () => () => void, label?: string): void
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'inkbridge: dictionaries')
  const t = ctx.locale.bind(LOCALE_NS) as (key: LocaleKey, params?: Record<string, string | number>) => string

  const store = new StatusStore(new InkbridgeApi())
  ctx.effect(() => () => store.dispose(), 'inkbridge: status store')

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: SETTINGS_SECTION_ID,
        order: 60,
        label: () => t('nav'),
        locale: LOCALE_NS,
      },
      // TODO(M2): read `sharedLogin` from the Host config (settings namespace) instead of assuming true.
      (() => createElement(SettingsSection, { store, t, sharedLogin: true })) as (props: never) => unknown,
    ),
  )
}
