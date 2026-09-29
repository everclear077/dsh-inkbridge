/**
 * Settings → 墨桥 · ChatGPT 生图. Rendered by the DSH settings shell via the `settings.section` slot.
 *
 * SKELETON: structure and data flow are final; visuals are placeholders.
 * TODO(M2): use @deepseek-ai/dsh-client-ui-primitives (SettingsForm, fields, buttons) for native look,
 *           and add the "test generation" button.
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { InkbridgeStatus } from '../shared/index.js'
import type { LocaleKey } from './locales.js'
import type { StatusStore } from './status-store.js'

export interface SectionProps {
  readonly store: StatusStore
  readonly t: (key: LocaleKey, params?: Record<string, string | number>) => string
  /** Whether the login is shared with the user's Codex CLI (config.codexHome === 'shared'). */
  readonly sharedLogin: boolean
}

export function SettingsSection({ store, t, sharedLogin }: SectionProps) {
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot)
  useEffect(() => {
    store.start()
    return () => store.stop()
  }, [store])

  const status = view.status
  return (
    <div data-inkbridge-settings="" style={{ display: 'grid', gap: 16 }}>
      <header>
        <h2 style={{ margin: 0 }}>{t('title')}</h2>
        <p style={{ margin: '4px 0 0', opacity: 0.7 }}>{t('subtitle')}</p>
      </header>
      {status === undefined ? (
        <p>…</p>
      ) : (
        <StatusBody status={status} store={store} t={t} sharedLogin={sharedLogin} busy={view.loading} />
      )}
      {view.error !== undefined && <p role="alert">{view.error}</p>}
    </div>
  )
}

function StatusBody(props: {
  status: InkbridgeStatus
  store: StatusStore
  t: SectionProps['t']
  sharedLogin: boolean
  busy: boolean
}) {
  const { status, store, t, sharedLogin, busy } = props
  const { runtime, account, pendingLogin, quota } = status
  return (
    <>
      <section>
        <h3>{t('runtime.heading')}</h3>
        {runtime.state === 'not-installed' ? (
          <p>{t('runtime.notInstalled')}</p>
        ) : (
          <p>
            {t(
              `runtime.${runtime.state === 'ready' ? 'ready' : runtime.state === 'starting' ? 'starting' : runtime.state === 'error' ? 'error' : 'idle'}`,
            )}
            {runtime.version !== undefined && ` · codex ${runtime.version}`}
            {runtime.error !== undefined && ` · ${runtime.error}`}
          </p>
        )}
      </section>

      <section>
        <h3>{t('account.heading')}</h3>
        {account.state === 'signed-in' && (
          <>
            <p>
              {t('account.signedIn')} {account.email} · {t('account.plan')}: {account.planType}
            </p>
            {sharedLogin && <p style={{ opacity: 0.7 }}>{t('account.logoutSharedWarning')}</p>}
            <button type="button" disabled={busy} onClick={() => void store.run((api) => api.logout())}>
              {t('account.logout')}
            </button>
          </>
        )}
        {account.state === 'api-key' && <p>{t('account.apiKey')}</p>}
        {pendingLogin !== undefined ? (
          <div>
            <p>{t('account.signingIn')}</p>
            {pendingLogin.method === 'browser' && pendingLogin.authUrl !== undefined && (
              <button type="button" onClick={() => void navigator.clipboard.writeText(pendingLogin.authUrl ?? '')}>
                {t('account.copyLink')}
              </button>
            )}
            {pendingLogin.method === 'device-code' && (
              <p>
                {t('account.deviceHint')} <code>{pendingLogin.verificationUrl}</code> ·{' '}
                <strong>{pendingLogin.userCode}</strong>
              </p>
            )}
            <button type="button" disabled={busy} onClick={() => void store.run((api) => api.cancelLogin())}>
              {t('account.cancel')}
            </button>
          </div>
        ) : (
          account.state !== 'signed-in' &&
          runtime.state !== 'not-installed' && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" disabled={busy} onClick={() => void store.run((api) => api.login('browser'))}>
                {t('account.login')}
              </button>
              <button type="button" disabled={busy} onClick={() => void store.run((api) => api.login('device-code'))}>
                {t('account.loginDevice')}
              </button>
            </div>
          )
        )}
        {status.lastLoginError !== undefined && <p role="alert">{status.lastLoginError}</p>}
      </section>

      {account.state === 'signed-in' && (
        <section>
          <h3>{t('quota.heading')}</h3>
          {status.imageGeneration === false && <p>{t('quota.unavailable')}</p>}
          {quota?.usedPercent !== undefined && <p>{t('quota.used', { percent: quota.usedPercent })}</p>}
          {quota?.resetsAt !== undefined && (
            <p>{t('quota.resets', { time: new Date(quota.resetsAt * 1000).toLocaleString() })}</p>
          )}
          {quota?.credits?.balance !== undefined && <p>{t('quota.credits', { balance: quota.credits.balance })}</p>}
        </section>
      )}

      <button type="button" disabled={busy} onClick={() => void store.run((api) => api.refresh())}>
        {t('refresh')}
      </button>
    </>
  )
}
