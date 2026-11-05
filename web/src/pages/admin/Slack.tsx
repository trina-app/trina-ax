// Admin › Slack (the owner's; docs/SLACK.md). Not set up: four steps, each linking to its Slack page (make the app from
// our manifest, install it, make the app-level token, paste both tokens: sealed in this browser for 'slack.token',
// never shown again, then turned on). Set up: one status line with one button (turn on / off); a problem says the one
// place to fix it. Replacing the tokens, and removing it, are behind "Replace tokens".
import { useMemo, useState, type ReactNode } from 'react'
import { ChevronRight, ExternalLink } from 'lucide-react'
import { ApiError, SLACK, type SlackAdmin, type SlackErrorCode, type SlackMember, type User } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { canSeal, sealSecret } from '../../lib/seal'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { Badge, Button, Field, Modal, confirmDialog, inputCls } from '../../components/ui'
import { AdminPageHeader, Card, Loadable, useAction, useActionOk, useLoad } from './common'

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
const SAVE_FIX: Record<'bot' | 'app', Partial<Record<string, { key: MessageKey; page: Page }>>> = {
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
                  <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                    <span>{t('slack.admin.linked', { n: s.linked })}</span>
                    {origin && <span>{t('slack.admin.linksOpen', { origin })}</span>}
                    <button type="button" className="underline-offset-2 hover:underline" aria-expanded={replacing} onClick={() => setReplacing((v) => !v)} data-testid="slack-replace">{t('slack.admin.replace')}</button>
                  </p>
                </Card>
              )}
              {s.enabled && s.tokens && <People />}
              {(!s.tokens || replacing) && (
                <Card title={t('slack.admin.setupTitle')} testId="slack-setup">
                  <ol className="space-y-4 text-sm">
                    <Step n={1} title={t('slack.admin.create')} href={s.createUrl} testId="slack-create">{t('slack.admin.createHint')}</Step>
                    <Step n={2} title={t('slack.admin.install')} href={slackPage(s.appId, 'install')}>{t('slack.admin.installHint')}</Step>
                    <Step n={3} title={t('slack.admin.appTokenStep')} href={slackPage(s.appId, 'general')}>{t('slack.admin.appTokenStepHint')}</Step>
                    <Step n={4} title={t('slack.admin.pasteStep')}>
                      <TokenForm appId={s.appId} enabled={s.enabled} onSaved={(v) => { state.setData(v); setReplacing(false) }} />
                    </Step>
                  </ol>
                  {s.tokens && (
                    <button type="button" className="mt-5 text-xs text-danger underline-offset-2 hover:underline" data-testid="slack-remove"
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
  const [busy, setBusy] = useState(false)
  // what went wrong at the last try, under the field it concerns (or the button); kept until the next try
  const [error, setError] = useState<{ field: 'bot' | 'app' | null; text: ReactNode } | null>(null)
  const secure = canSeal()
  const ready = /^xoxb-\S{10,}$/.test(bot.trim()) && /^xapp-\S{10,}$/.test(app.trim())
  const why = (e: unknown): { field: 'bot' | 'app' | null; text: ReactNode } => {
    if (e instanceof ApiError) {
      const fields = e.body.fields ?? {}, reason = String(e.body.params?.reason ?? '')
      const field = 'body.botToken' in fields ? 'bot' : 'body.appToken' in fields ? 'app' : null
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
      const body = { botToken: await sealSecret(key, bot.trim(), 'slack.token'), appToken: await sealSecret(key, app.trim(), 'slack.token') }
      const saved = await api.call(SLACK.saveSlackTokens, { body })
      setBot(''); setApp('')
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
      {!secure && <p className="text-sm text-warn">{t('credentials.httpsOnly')}</p>}
      {error && !error.field && <p role="alert" className="text-sm text-danger" data-testid="slack-save-error">{error.text}</p>}
      <Button variant="primary" busy={busy} disabled={!ready || !secure || busy} onClick={() => void save()} data-testid="slack-save">{t('slack.admin.save')}</Button>
    </div>
  )
}

/** The workspace's people and whom each is linked to. A row not linked yet opens one dialog: propose linking that Slack
 * account to a member whose e-mails differ (the person cannot link it themselves then), or withdraw the proposal
 * waiting for them. Nothing is linked until that member accepts it in the app. */
function People() {
  const t = useT()
  const ok = useActionOk()
  const members = useLoad(() => api.call(SLACK.slackMembers))
  const users = useLoad(async () => (await api.call(API.listUsers, { query: {} })).items.filter((u) => u.status === 'active'))
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<SlackMember | null>(null)
  const done = (yes: boolean) => { if (yes) { setOpen(null); void members.reload() } }
  return (
    <Card title={t('slack.people.title')} desc={t('slack.people.desc')} testId="slack-people">
      <Loadable state={members}>
        {(m) => {
          const words = q.trim().toLowerCase()
          const shown = m.members.filter((x) => !words || [x.name, x.realName, x.handle, x.email, x.linkedTo?.name].some((v) => v?.toLowerCase().includes(words)))
          return (
            <>
              <input className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('slack.people.search')} aria-label={t('slack.people.search')} data-testid="slack-people-search" />
              <ul className="mt-2 divide-y divide-line">
                {shown.map((x) => {
                  const who = (
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{x.name ?? x.realName ?? x.handle ?? x.slackUserId}</p>
                      <p className="truncate text-xs text-muted">{x.email ?? t('slack.people.noEmail')}</p>
                    </div>
                  )
                  return (
                    <li key={x.slackUserId} data-testid="slack-person">
                      {x.linkedTo
                        ? <div className="flex items-center gap-3 py-2">{who}<span className="shrink-0 text-xs text-muted">→ {x.linkedTo.name}</span></div>
                        : <button type="button" className="flex w-full items-center gap-3 py-2 text-left hover:bg-subtle" onClick={() => setOpen(x)} data-testid="slack-person-open">
                            {who}
                            {x.pending && <span className="shrink-0 text-xs text-muted" data-testid="slack-person-pending">{t('slack.people.waiting', { name: x.pending.name })}</span>}
                            <ChevronRight size={16} className="shrink-0 text-faint" aria-hidden />
                          </button>}
                    </li>
                  )
                })}
              </ul>
              {m.truncated && <p className="mt-2 text-xs text-muted">{t('slack.people.truncated')}</p>}
            </>
          )
        }}
      </Loadable>
      {open && (
        <LinkDialog member={open} users={users.data ?? []} onClose={() => setOpen(null)}
          onLink={async (userId) => done(await ok(() => api.call(SLACK.proposeSlackLink, { body: { slackUserId: open.slackUserId, userId } }), t('slack.people.proposed')))}
          onWithdraw={async (proposalId) => done(await ok(() => api.call(SLACK.cancelSlackProposal, { params: { id: proposalId } })))} />
      )}
    </Card>
  )
}

function LinkDialog({ member, users, onClose, onLink, onWithdraw }: { member: SlackMember; users: User[]; onClose: () => void; onLink: (userId: string) => Promise<void>; onWithdraw: (proposalId: string) => Promise<void> }) {
  const t = useT()
  const [userId, setUserId] = useState('')
  const [busy, setBusy] = useState(false)
  const chosen = useMemo(() => users.find((u) => u.id === userId) ?? null, [users, userId])
  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn() } finally { setBusy(false) } }
  const pending = member.pending
  return (
    <Modal open onClose={onClose} title={t('slack.people.dialogTitle')}
      footer={<>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        {pending
          ? <Button variant="danger" busy={busy} disabled={busy} data-testid="slack-proposal-withdraw" onClick={() => void run(() => onWithdraw(pending.proposalId))}>{t('slack.people.withdraw')}</Button>
          : <Button variant="primary" busy={busy} disabled={!chosen || busy} data-testid="slack-link-member-confirm" onClick={() => void run(() => onLink(userId))}>{t('slack.people.confirm')}</Button>}
      </>}>
      <dl className="space-y-3 text-sm">
        <div>
          <dt className="text-muted">Slack</dt>
          <dd><span className="font-medium">{member.name ?? member.realName ?? member.handle ?? member.slackUserId}</span>
            <span className="block text-xs text-muted">{[member.realName, member.handle ? `@${member.handle}` : null, member.email ?? t('slack.people.noEmail')].filter(Boolean).join(' · ')}</span></dd>
        </div>
        <div>
          <dt className="text-muted">{t('slack.people.member')}</dt>
          {pending
            ? <dd>{t('slack.people.waiting', { name: pending.name })}</dd>
            : <dd>
                <select className={inputCls} value={userId} onChange={(e) => setUserId(e.target.value)} data-testid="slack-link-member-user" aria-label={t('slack.people.member')}>
                  <option value="">{t('slack.people.choose')}</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.name} (@{u.username})</option>)}
                </select>
                {chosen && <span className="mt-1 block text-xs text-muted">{chosen.email ?? t('slack.people.noEmail')}</span>}
              </dd>}
        </div>
      </dl>
      {!pending && <p className="mt-3 text-sm text-warn">{t('slack.people.warning')}</p>}
    </Modal>
  )
}
