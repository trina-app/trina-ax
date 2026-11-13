// Admin › Connected apps › Slack (/admin/connectors/slack, a page of Integrations.tsx like a Google connector's; the
// owner's and admins'; docs/SLACK.md). Until 2026-11-12 it was an Admin menu item of its own; /admin/slack leads here
// (AdminLayout.tsx). On top the header of a connector's page (AppDetail.tsx: Connected apps › Slack, the logo, the name
// and one line), then the settings. Not set up: four steps, each linking to its Slack page (make the app from
// our manifest, install it, make the app-level token and copy the app's credentials, paste them: the tokens and the
// client secret sealed in this browser for 'slack.token', never shown again, then turned on). Without the team's https
// address one line says "Sign in with Slack" needs it. Set up: one status line with one button (turn on / off); a problem says the one
// place to fix it. Replacing the tokens, and removing it, are behind "Replace tokens". A phone (below 768 px): the
// cards without frames and 44 px targets (docs/DECISIONS.md "Admin and Settings on phones"); the setup (Slack's pages,
// keys to copy and paste) is a computer's job there: a status row and "Set this up on a computer" in its place.
// Where the hosting service serves this server (SlackAdmin.official) and no own app is saved: one "Add to Slack" button
// instead (the official app: nothing to copy, also on a phone); the four steps stay one link away. Added: the same
// status line, with Remove (it takes the app off the workspace) in place of "Replace tokens". Removed in Slack: "Add to
// Slack" again, with Remove beside it (it clears Slack from Connected and everyone's links). How "Add to Slack" went
// comes back in the address (?slack=…) and is said once.
// An admin (docs/DECISIONS.md "Admins manage Slack", 2026-11-13): the same page with "Add to Slack", on/off and Remove
// of the official app, but never the team's own app: no four steps, no "Replace tokens", no Remove of it; one line says
// only the team owner can (the server refuses them too).
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ExternalLink } from 'lucide-react'
import { ApiError, SLACK, type SlackAdmin, type SlackErrorCode } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { canSeal, sealSecret } from '../../lib/seal'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { outcomeText } from '../../lib/slackSignIn'
import { SLACK_APP, slackLogo } from '../../lib/connectors'
import { Badge, Button, Field, confirmDialog, inputCls, useMediaQuery } from '../../components/ui'
import { AppDetail } from '../../components/integrations/AppDetail'
import { Card, Loadable, useAction, useLoad } from './common'
import { isOwner, useMe } from '../../store/session'

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
  // the official app (the hosting service): nothing to fix in Slack's settings
  broker_unreachable: { key: 'slack.err.broker_unreachable' }, not_served: { key: 'slack.err.not_served' }, removed: { key: 'slack.err.removed' },
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

/** "Update Slack permissions" (docs/SLACK.md "Marketplace-safe reading"): the AI reads Slack threads and channels with
 * the bot token only, which needs the bot scopes channels:history and groups:history; an app from before them answers
 * with reading off. The team's own app: add them in its OAuth & Permissions page and reinstall (the owner's job), then
 * "I updated them" asks Slack again. The official app: Add to Slack again approves them. */
function ReadScopes({ s, owner, onChange }: { s: SlackAdmin; owner: boolean; onChange: (v: SlackAdmin | undefined) => void }) {
  const t = useT(), locale = useLocale()
  const act = useAction()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // "I updated them" pressed and Slack still does not list them: said once, under the button
  const [still, setStill] = useState(false)
  const official = s.mode === 'official'
  const approve = async () => {
    setBusy(true); setError(null)
    try { window.location.assign((await api.call(SLACK.startSlackInstall, { body: { origin: window.location.origin } })).authorizationUrl) }
    catch (e) { setError(errorText(e, locale, t('error.network'))); setBusy(false) }
  }
  const recheck = async () => {
    setBusy(true); setStill(false)
    try { const v = await act(() => api.call(SLACK.recheckSlackReadScopes, { body: {} })); onChange(v); setStill(v?.readScopes === 'missing') } finally { setBusy(false) }
  }
  return (
    <div className="mt-3 border-l-2 border-warn pl-3 text-sm" data-testid="slack-read-scopes">
      <p className="font-medium">{t('slack.admin.readTitle')}</p>
      {official ? <p className="mt-1 text-muted">{t('slack.admin.readOfficial')}</p>
        : owner ? (
          <>
            <p className="mt-1 text-muted"><FixText text={t('slack.admin.readOwn')} href={slackPage(s.appId, 'oauth')} /></p>
            <p className="mt-1 break-words font-mono text-xs" data-testid="slack-missing-scopes">{s.missingScopes.join(', ')}</p>
          </>
        ) : <p className="mt-1 text-muted">{t('slack.admin.readOwnAsk')}</p>}
      {error && <p role="alert" className="mt-2 text-danger">{error}</p>}
      {still && <p role="status" className="mt-2 text-warn" data-testid="slack-read-still">{t('slack.admin.readStill')}</p>}
      <div className="mt-2 flex flex-wrap gap-3">
        {official
          ? <Button size="sm" variant="primary" busy={busy} disabled={busy} className="max-md:h-11" onClick={() => void approve()} data-testid="slack-read-approve">{t('slack.official.add')}</Button>
          : owner && <Button size="sm" variant="secondary" busy={busy} disabled={busy} className="max-md:h-11" onClick={() => void recheck()} data-testid="slack-read-recheck">{t('slack.admin.readRecheck')}</Button>}
      </div>
    </div>
  )
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
    ? <code key={i} className="rounded bg-subtle px-1 font-mono text-[0.95em] text-ink select-all max-md:text-[1em]">{part.slice(1, -1)}</code>
    : part)}</>
}

/** `onChange`: the state as this page last read or changed it (Connected apps' Slack row shows it on the way back). */
export default function AdminSlack({ onChange }: { onChange?: (s: SlackAdmin) => void } = {}) {
  const t = useT()
  // the team's own Slack app (its tokens) is the owner's alone
  const owner = isOwner(useMe())
  // the page's own address: the manifest's redirect URL and where links open both come from it (and are the same)
  const state = useLoad(() => api.call(SLACK.slackAdmin, { query: { origin: window.location.origin } }))
  const changed = useRef(onChange)
  changed.current = onChange
  useEffect(() => { if (state.data) changed.current?.(state.data) }, [state.data])
  const act = useAction()
  const [replacing, setReplacing] = useState(false)
  // the own app's four steps although the official app can be added here
  const [ownApp, setOwnApp] = useState(false)
  const set = (v: SlackAdmin | undefined) => { if (v) state.setData(v) }
  const phone = useMediaQuery('(max-width: 767.98px)')
  // how "Add to Slack" went, said once: taken out of the address so a reload does not say it again
  const [params, setParams] = useSearchParams()
  const [outcome] = useState(() => params.get('slack'))
  useEffect(() => { if (params.has('slack')) setParams((p) => { p.delete('slack'); return p }, { replace: true }) }, [params, setParams])
  // what Remove deletes: the own app's tokens, the official app's install, or (removed in Slack already) only the row
  const remove = async (kind: 'own' | 'official' | 'removed') => {
    const body = kind === 'own' ? 'slack.admin.removeBody' : kind === 'official' ? 'slack.admin.removeOfficialBody' : 'slack.admin.removeRemovedBody'
    if (!(await confirmDialog({ title: t('slack.admin.removeTitle'), body: t(body), confirm: t('slack.admin.remove'), danger: true }))) return
    const v = await act(() => api.call(SLACK.removeSlack))
    if (v) { state.setData(v); setReplacing(false) }
  }
  return (
    <AppDetail embedded list={{ to: '/admin/connectors', name: t('admin.integrations') }} testId="slack-admin" state={state.data?.state ?? 'loading'}
      logo={slackLogo} name={SLACK_APP.name} byLine={t('slack.admin.desc')} tools={[]}>
      {/* one block under the header: the cards keep their own spacing */}
      <div data-testid="slack-settings">
      <Loadable state={state}>
        {(s) => {
          const fix = s.enabled && s.lastError ? FIX[s.lastError] : null
          const origin = s.linkOrigin && s.linkOrigin !== window.location.origin ? s.linkOrigin : null
          const official = s.mode === 'official'
          // "Add to Slack" instead of the four steps: the hosting service serves this server, nothing of our own saved
          const addable = !s.tokens && s.official && !ownApp
          return (
            <>
              {outcome && (
                <p role="status" className={`mb-3 text-sm ${outcome === 'installed' ? 'text-ok' : 'text-warn'}`} data-testid="slack-outcome">{t(outcomeText(outcome))}</p>
              )}
              {s.tokens && (
                <Card flat>
                  <div className="flex items-center gap-3" data-testid="slack-status">
                    <p className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                      <Badge tone={STATE[s.state].tone}>{t(STATE[s.state].key)}</Badge>
                      <span className="truncate">{[s.workspace?.name, s.botName ? `@${s.botName}` : null].filter(Boolean).join(' · ')}</span>
                    </p>
                    <Button variant={s.enabled ? 'secondary' : 'primary'} className="max-md:h-11" data-testid="slack-toggle"
                      onClick={async () => set(await act(() => api.call(SLACK.setSlackEnabled, { body: { enabled: !s.enabled } }), t(s.enabled ? 'slack.admin.turnedOff' : 'slack.admin.turnedOn')))}>
                      {t(s.enabled ? 'slack.admin.turnOff' : 'slack.admin.turnOn')}
                    </Button>
                  </div>
                  {fix ? (
                    <p className="mt-2 text-sm text-danger" data-testid="slack-error">
                      {/* an admin cannot replace the tokens: the words ask the owner instead */}
                      {fix.page === 'replace' && !owner ? t('slack.admin.askOwner')
                        : <FixText text={t(fix.key)} href={fix.page && fix.page !== 'replace' ? slackPage(s.appId, fix.page) : undefined} onClick={fix.page === 'replace' ? () => setReplacing(true) : undefined} />}
                    </p>
                  ) : s.enabled && s.botName ? (
                    <p className="mt-2 text-sm text-muted" data-testid="slack-invite"><CodeText text={t('slack.admin.invite', { bot: s.botName })} /></p>
                  ) : null}
                  {/* saving the own app's tokens again at the https address: the owner's (an admin cannot) */}
                  {!s.redirectUrl && !official && owner && <p className="mt-2 text-sm text-warn" data-testid="slack-https-needed">{t('slack.admin.httpsNeeded')}</p>}
                  {/* the bot lacks the reading scopes (an app from before them, as Slack lists the bot token's scopes): one
                      prompt to update them; reading stays off until then */}
                  {s.enabled && s.readScopes === 'missing' && <ReadScopes s={s} owner={owner} onChange={set} />}
                  <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted max-md:items-center">
                    <span>{t('slack.admin.linked', { n: s.linked })}</span>
                    {origin && <span>{t('slack.admin.linksOpen', { origin })}</span>}
                    {official
                      ? <button type="button" className="text-danger underline underline-offset-2 max-md:min-h-11" onClick={() => void remove('official')} data-testid="slack-remove">{t('slack.admin.remove')}</button>
                      : !owner ? <span data-testid="slack-owner-only">{t('slack.admin.ownerOnlyApp')}</span>
                      : <button type="button" className="underline underline-offset-2 max-md:min-h-11" aria-expanded={replacing} onClick={() => setReplacing((v) => !v)} data-testid="slack-replace">{t('slack.admin.replace')}</button>}
                  </p>
                </Card>
              )}
              {addable ? (
                <OfficialAdd removed={s.lastError === 'removed'} onOwnApp={owner ? () => setOwnApp(true) : undefined} onRemove={() => void remove('removed')} />
              ) : !s.tokens && !owner ? (
                <Card flat testId="slack-owner-only">
                  <p className="mb-2 flex items-center gap-2 text-sm" data-testid="slack-status">
                    <Badge tone={STATE[s.state].tone}>{t(STATE[s.state].key)}</Badge>
                  </p>
                  <p className="text-sm text-muted">{t('slack.admin.ownerOnlySetup')}</p>
                </Card>
              ) : (!s.tokens || replacing) && !owner ? null
              : (!s.tokens || replacing) && phone ? (
                <Card flat testId="slack-on-computer">
                  {!s.tokens && (
                    <p className="mb-2 flex items-center gap-2 text-sm" data-testid="slack-status">
                      <Badge tone={STATE[s.state].tone}>{t(STATE[s.state].key)}</Badge>
                    </p>
                  )}
                  <p className="text-sm font-medium text-ink">{t('admin.onComputer')}</p>
                  <p className="mt-1 text-sm text-muted">{t('admin.onComputerSlack')}</p>
                </Card>
              ) : (!s.tokens || replacing) && (
                <Card flat title={t('slack.admin.setupTitle')} testId="slack-setup">
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
                    <button type="button" className="mt-5 text-xs text-danger underline underline-offset-2 max-md:min-h-11" data-testid="slack-remove"
                      onClick={() => void remove('own')}>{t('slack.admin.remove')}</button>
                  )}
                  {!s.tokens && s.official && (
                    <button type="button" className="mt-5 text-xs text-accent underline underline-offset-2 max-md:min-h-11" data-testid="slack-use-official"
                      onClick={() => setOwnApp(false)}>{t('slack.official.useOfficial')}</button>
                  )}
                </Card>
              )}
            </>
          )
        }}
      </Loadable>
      </div>
    </AppDetail>
  )
}

/** "Add to Slack": the hosting service's official app. One button: Slack's own page (choose the workspace, allow),
 * then back here, added and on. Nothing to copy, so also on a phone. Removed in Slack: Remove too, so an owner who
 * does not want it back can clear it (its row in Connected apps, everyone's links) instead of keeping "Reconnect". */
function OfficialAdd({ removed, onOwnApp, onRemove }: { removed: boolean; onOwnApp?: () => void; onRemove: () => void }) {
  const t = useT(), locale = useLocale()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const add = async () => {
    setBusy(true); setError(null)
    // this browser goes to Slack and comes back to this page
    try { window.location.assign((await api.call(SLACK.startSlackInstall, { body: { origin: window.location.origin } })).authorizationUrl) }
    catch (e) { setError(errorText(e, locale, t('error.network'))); setBusy(false) }
  }
  return (
    <Card flat title={t('slack.official.title')} testId="slack-official">
      {removed && <p className="mb-2 text-sm text-warn" data-testid="slack-removed">{t('slack.err.removed')}</p>}
      <p className="text-sm text-muted">{t('slack.official.hint')}</p>
      {error && <p role="alert" className="mt-2 text-sm text-danger" data-testid="slack-add-error">{error}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button variant="primary" className="max-md:h-11" busy={busy} disabled={busy} onClick={() => void add()} data-testid="slack-add">{t('slack.official.add')}</Button>
        {/* the team's own app: the owner's alone (an admin is not offered it) */}
        {onOwnApp && <button type="button" className="text-xs text-muted underline underline-offset-2 max-md:min-h-11" onClick={onOwnApp} data-testid="slack-own-app">{t('slack.official.ownApp')}</button>}
        {removed && <button type="button" className="text-xs text-danger underline underline-offset-2 max-md:min-h-11" onClick={onRemove} data-testid="slack-remove">{t('slack.admin.remove')}</button>}
      </div>
    </Card>
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
        clientId: clientId.trim(), clientSecret: await sealSecret(key, clientSecret.trim(), 'slack.token'), origin: window.location.origin }
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
      <Button variant="primary" className="max-md:h-11" busy={busy} disabled={!ready || !secure || busy} onClick={() => void save()} data-testid="slack-save">{t('slack.admin.save')}</Button>
    </div>
  )
}
