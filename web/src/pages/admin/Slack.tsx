// Admin › Slack (the owner's; docs/SLACK.md). Not set up: four steps, each linking to its Slack page (make the app from
// our manifest, install it, make the app-level token and copy the app's credentials, paste them: the tokens and the
// client secret sealed in this browser for 'slack.token', never shown again, then turned on). Without the team's https
// address one line says "Sign in with Slack" needs it. Set up: one status line with one button (turn on / off); a problem says the one
// place to fix it. Replacing the tokens, and removing it, are behind "Replace tokens".
import { useState, type ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'
import { ApiError, SLACK, type SlackAdmin, type SlackErrorCode } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { canSeal, sealSecret } from '../../lib/seal'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { Badge, Button, Field, confirmDialog, inputCls } from '../../components/ui'
import { AdminPageHeader, Card, Loadable, useAction, useLoad } from './common'

const STATE: Record<SlackAdmin['state'], { key: MessageKey; tone: 'neutral' | 'ok' | 'warn' | 'danger' }> = {
  off: { key: 'slack.state.off', tone: 'neutral' },
  connecting: { key: 'slack.state.connecting', tone: 'warn' },
  connected: { key: 'slack.state.connected', tone: 'ok' },
  error: { key: 'slack.state.error', tone: 'danger' },
}

/** The app's pages in Slack: its own settings page once its id is known, else the list of the owner's apps */
type Page = 'install' | 'oauth' | 'general' | 'socket'
const SLACK_APPS = 'https://api.slack.com/apps'
const PATHS: Record<Page, string> = { install: 'install-on-team', oauth: 'oauth', general: 'general', socket: 'socket-mode' }
const slackPage = (appId: string | null, page: Page) => appId ? `${SLACK_APPS}/${encodeURIComponent(appId)}/${PATHS[page]}` : SLACK_APPS

/** A problem of the running connection: the words name the one place to fix it; the part in [ ] links there (a Slack
 * page, or "Replace tokens" here). The connection uses the app-level token only. */
const FIX: Record<SlackErrorCode, { key: MessageKey; page?: Page | 'replace' }> = {
  invalid_auth: { key: 'slack.err.invalid_auth', page: 'replace' }, token_revoked: { key: 'slack.err.invalid_auth', page: 'replace' },
  not_app_token: { key: 'slack.err.invalid_auth', page: 'replace' }, not_bot_token: { key: 'slack.err.invalid_auth', page: 'replace' },
  missing_scope: { key: 'slack.err.missing_scope', page: 'oauth' }, enterprise_install: { key: 'slack.err.enterprise_install', page: 'install' },
  socket_mode_off: { key: 'slack.err.socket_mode_off', page: 'socket' }, app_mismatch: { key: 'slack.err.app_mismatch', page: 'general' },
  workspace_changed: { key: 'slack.err.unknown', page: 'replace' }, unknown: { key: 'slack.err.unknown', page: 'replace' },
  unreachable: { key: 'slack.err.unreachable' }, ratelimited: { key: 'slack.err.unreachable' }, key_unsafe: { key: 'slack.err.key_unsafe' },
}
/** A token Slack refused while saving: shown under that token's field (the server names the field) */
type FieldName = 'bot' | 'app' | 'clientId' | 'clientSecret'
const SAVE_FIX: Record<FieldName, Partial<Record<string, { key: MessageKey; page: Page }>>> = {
  bot: {
    invalid_auth: { key: 'slack.err.botRejected', page: 'install' }, token_revoked: { key: 'slack.err.botRejected', page: 'install' },
    not_bot_token: { key: 'slack.err.not_bot_token', page: 'install' }, missing_scope: { key: 'slack.err.missing_scopes', page: 'oauth' },
    enterprise_install: { key: 'slack.err.enterprise_install', page: 'install' },
  },
  app: {
    invalid_auth: { key: 'slack.err.not_app_token', page: 'general' }, token_revoked: { key: 'slack.err.not_app_token', page: 'general' },
    not_app_token: { key: 'slack.err.not_app_token', page: 'general' }, app_mismatch: { key: 'slack.err.app_mismatch', page: 'general' },
    socket_mode_off: { key: 'slack.err.socket_mode_off', page: 'socket' },
  },
  clientId: { not_client_id: { key: 'slack.err.not_client_id', page: 'general' } },
  clientSecret: { not_client_secret: { key: 'slack.err.not_client_secret', page: 'general' } },
}

/** A sentence whose part in [ ] is a link: to a Slack page, or a button doing `onClick` */
function FixText({ text, href, onClick }: { text: string; href?: string; onClick?: () => void }) {
  return <>{text.split(/(\[[^\]]+\])/).map((part, i) => {
    const m = /^\[([^\]]+)\]$/.exec(part)
    if (!m) return part
    if (href) return <a key={i} href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{m[1]}</a>
    if (onClick) return <button key={i} type="button" className="underline underline-offset-2" onClick={onClick}>{m[1]}</button>
    return m[1]
  })}</>
}

/** A sentence with a command in backticks: the command as code */
function CodeText({ text }: { text: string }) {
  return <>{text.split(/(`[^`]+`)/).map((part, i) => /^`[^`]+`$/.test(part)
    ? <code key={i} className="rounded bg-subtle px-1 font-mono text-[0.95em] text-ink select-all">{part.slice(1, -1)}</code>
    : part)}</>
}

export default function AdminSlack() {
  const t = useT()
  const state = useLoad(() => api.call(SLACK.slackAdmin))
  const act = useAction()
  const [replacing, setReplacing] = useState(false)
  const set = (v: SlackAdmin | undefined) => { if (v) state.setData(v) }
  return (
    <>
      <AdminPageHeader title={t('slack.admin.title')} desc={t('slack.admin.desc')} testId="slack-admin" />
      <Loadable state={state}>
        {(s) => {
          const fix = s.enabled && s.lastError ? FIX[s.lastError] : null
          const origin = s.linkOrigin && s.linkOrigin !== window.location.origin ? s.linkOrigin : null
          return (
            <>
              {s.tokens && (
                <Card>
                  <div className="flex items-center gap-3" data-testid="slack-status">
                    <p className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                      <Badge tone={STATE[s.state].tone}>{t(STATE[s.state].key)}</Badge>
                      <span className="truncate">{[s.workspace?.name, s.botName ? `@${s.botName}` : null].filter(Boolean).join(' · ')}</span>
                    </p>
                    <Button variant={s.enabled ? 'secondary' : 'primary'} data-testid="slack-toggle"
                      onClick={async () => set(await act(() => api.call(SLACK.setSlackEnabled, { body: { enabled: !s.enabled } }), t(s.enabled ? 'slack.admin.turnedOff' : 'slack.admin.turnedOn')))}>
                      {t(s.enabled ? 'slack.admin.turnOff' : 'slack.admin.turnOn')}
                    </Button>
                  </div>
                  {fix ? (
                    <p className="mt-2 text-sm text-danger" data-testid="slack-error">
                      <FixText text={t(fix.key)} href={fix.page && fix.page !== 'replace' ? slackPage(s.appId, fix.page) : undefined} onClick={fix.page === 'replace' ? () => setReplacing(true) : undefined} />
                    </p>
                  ) : s.enabled && s.botName ? (
                    <p className="mt-2 text-sm text-muted" data-testid="slack-invite"><CodeText text={t('slack.admin.invite', { bot: s.botName })} /></p>
                  ) : null}
                  {!s.redirectUrl && <p className="mt-2 text-sm text-warn" data-testid="slack-https-needed">{t('slack.admin.httpsNeeded')}</p>}
                  <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                    <span>{t('slack.admin.linked', { n: s.linked })}</span>
                    {origin && <span>{t('slack.admin.linksOpen', { origin })}</span>}
                    <button type="button" className="underline underline-offset-2" aria-expanded={replacing} onClick={() => setReplacing((v) => !v)} data-testid="slack-replace">{t('slack.admin.replace')}</button>
                  </p>
                </Card>
              )}
              {(!s.tokens || replacing) && (
                <Card title={t('slack.admin.setupTitle')} testId="slack-setup">
                  <ol className="space-y-4 text-sm">
                    <Step n={1} title={t('slack.admin.create')} href={s.createUrl} testId="slack-create">{t('slack.admin.createHint')}</Step>
                    <Step n={2} title={t('slack.admin.install')} href={slackPage(s.appId, 'install')}>{t('slack.admin.installHint')}</Step>
                    <Step n={3} title={t('slack.admin.appTokenStep')} href={slackPage(s.appId, 'general')}>{t('slack.admin.appTokenStepHint')}</Step>
                    <Step n={4} title={t('slack.admin.pasteStep')}>
                      {!s.redirectUrl && <p className="mb-2 text-warn" data-testid="slack-https-needed">{t('slack.admin.httpsNeeded')}</p>}
                      <TokenForm appId={s.appId} enabled={s.enabled} onSaved={(v) => { state.setData(v); setReplacing(false) }} />
                    </Step>
                  </ol>
                  {s.tokens && (
                    <button type="button" className="mt-5 text-xs text-danger underline underline-offset-2" data-testid="slack-remove"
                      onClick={async () => {
                        if (!(await confirmDialog({ title: t('slack.admin.removeTitle'), body: t('slack.admin.removeBody'), confirm: t('slack.admin.remove'), danger: true }))) return
                        const v = await act(() => api.call(SLACK.removeSlack))
                        if (v) { state.setData(v); setReplacing(false) }
                      }}>{t('slack.admin.remove')}</button>
                  )}
                </Card>
              )}
            </>
          )
        }}
      </Loadable>
    </>
  )
}

/** One step of the setup: a number, its title (a link to the Slack page where it is done) and one line under it */
function Step({ n, title, href, testId, children }: { n: number; title: string; href?: string; testId?: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-line text-xs font-medium text-muted tabular-nums" aria-hidden>{n}</span>
      <div className="min-w-0 flex-1 pt-0.5">
        {href
          ? <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-accent underline-offset-2 hover:underline" data-testid={testId}>{title}<ExternalLink size={13} aria-hidden /></a>
          : <p className="font-medium">{title}</p>}
        <div className="mt-1 text-muted">{children}</div>
      </div>
    </li>
  )
}

function TokenForm({ appId, enabled, onSaved }: { appId: string | null; enabled: boolean; onSaved: (s: SlackAdmin) => void }) {
  const t = useT(), locale = useLocale()
  const [bot, setBot] = useState('')
  const [app, setApp] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [busy, setBusy] = useState(false)
  // what went wrong at the last try, under the field it concerns (or the button); kept until the next try
  const [error, setError] = useState<{ field: FieldName | null; text: ReactNode } | null>(null)
  const secure = canSeal()
  const ready = /^xoxb-\S{10,}$/.test(bot.trim()) && /^xapp-\S{10,}$/.test(app.trim()) && clientId.trim().length > 0 && clientSecret.trim().length > 0
  const why = (e: unknown): { field: FieldName | null; text: ReactNode } => {
    if (e instanceof ApiError) {
      const fields = e.body.fields ?? {}, reason = String(e.body.params?.reason ?? '')
      const field: FieldName | null = 'body.botToken' in fields ? 'bot' : 'body.appToken' in fields ? 'app' : 'body.clientId' in fields ? 'clientId' : 'body.clientSecret' in fields ? 'clientSecret' : null
      const fix = field ? SAVE_FIX[field][reason] : undefined
      if (field && fix) return { field, text: <FixText text={t(fix.key, { scopes: String(e.body.params?.scopes ?? '') })} href={slackPage(appId, fix.page)} /> }
    }
    return { field: null, text: errorText(e, locale, t('error.network')) }
  }
  const save = async () => {
    if (!ready || busy) return
    setBusy(true); setError(null)
    try {
      const key = await api.call(API.sealingKey)
      const body = { botToken: await sealSecret(key, bot.trim(), 'slack.token'), appToken: await sealSecret(key, app.trim(), 'slack.token'),
        clientId: clientId.trim(), clientSecret: await sealSecret(key, clientSecret.trim(), 'slack.token') }
      const saved = await api.call(SLACK.saveSlackTokens, { body })
      setBot(''); setApp(''); setClientId(''); setClientSecret('')
      // step 4 turns it on too (already on: it stays on with the new tokens)
      let on = saved
      if (!enabled && !saved.enabled) { try { on = await api.call(SLACK.setSlackEnabled, { body: { enabled: true } }) } catch { /* saved, still off: the status line's button turns it on */ } }
      onSaved(on)
    } catch (e) { setError(why(e)) } finally { setBusy(false) }
  }
  return (
    <div className="space-y-3 text-ink">
      <Field label={t('slack.admin.botToken')} error={error?.field === 'bot' ? error.text : null}>
        <input className={inputCls} type="password" autoComplete="off" spellCheck={false} value={bot} onChange={(e) => setBot(e.target.value)} placeholder="xoxb-…" data-testid="slack-bot-token" />
      </Field>
      <Field label={t('slack.admin.appToken')} error={error?.field === 'app' ? error.text : null}>
        <input className={inputCls} type="password" autoComplete="off" spellCheck={false} value={app} onChange={(e) => setApp(e.target.value)} placeholder="xapp-…" data-testid="slack-app-token" />
      </Field>
      {/* Basic Information › App Credentials: for "Sign in with Slack", with which people link their own Slack account */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('slack.admin.clientId')} error={error?.field === 'clientId' ? error.text : null}>
          <input className={inputCls} autoComplete="off" spellCheck={false} value={clientId} onChange={(e) => setClientId(e.target.value)} data-testid="slack-client-id" />
        </Field>
        <Field label={t('slack.admin.clientSecret')} error={error?.field === 'clientSecret' ? error.text : null}>
          <input className={inputCls} type="password" autoComplete="off" spellCheck={false} value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} data-testid="slack-client-secret" />
        </Field>
      </div>
      {!secure && <p className="text-sm text-warn">{t('credentials.httpsOnly')}</p>}
      {error && !error.field && <p role="alert" className="text-sm text-danger" data-testid="slack-save-error">{error.text}</p>}
      <Button variant="primary" busy={busy} disabled={!ready || !secure || busy} onClick={() => void save()} data-testid="slack-save">{t('slack.admin.save')}</Button>
    </div>
  )
}
