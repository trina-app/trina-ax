// Admin › Slack (the owner's; docs/SLACK.md): make the internal Slack app from our manifest, paste its two tokens
// (sealed in this browser for 'slack.token', never shown again), turn it on. One main button per state: no tokens ->
// Save, saved -> Turn on, on -> its state. Replacing the tokens and removing it are small links under it.
import { useMemo, useState } from 'react'
import { SLACK, type SlackAdmin, type SlackErrorCode, type SlackMember, type User } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { canSeal, sealSecret } from '../../lib/seal'
import { useT, type MessageKey } from '../../i18n'
import { Badge, Button, CopyButton, Field, Modal, confirmDialog, inputCls } from '../../components/ui'
import { AdminPageHeader, Card, Loadable, useAction, useActionOk, useLoad } from './common'

const STATE: Record<SlackAdmin['state'], { key: MessageKey; tone: 'neutral' | 'ok' | 'warn' | 'danger' }> = {
  off: { key: 'slack.state.off', tone: 'neutral' },
  connecting: { key: 'slack.state.connecting', tone: 'warn' },
  connected: { key: 'slack.state.connected', tone: 'ok' },
  error: { key: 'slack.state.error', tone: 'danger' },
}
const ERRORS: Record<SlackErrorCode, MessageKey> = {
  invalid_auth: 'slack.err.invalid_auth', token_revoked: 'slack.err.invalid_auth', missing_scope: 'slack.err.missing_scope',
  not_bot_token: 'slack.err.invalid_auth', not_app_token: 'slack.err.not_app_token', enterprise_install: 'slack.err.unknown',
  workspace_changed: 'slack.err.unknown', socket_mode_off: 'slack.err.socket_mode_off', app_mismatch: 'slack.err.app_mismatch', unreachable: 'slack.err.unreachable',
  ratelimited: 'slack.err.unreachable', key_unsafe: 'slack.err.key_unsafe', unknown: 'slack.err.unknown',
}

export default function AdminSlack() {
  const t = useT()
  const state = useLoad(() => api.call(SLACK.slackAdmin))
  const act = useAction()
  const [replacing, setReplacing] = useState(false)
  const [manifest, setManifest] = useState(false)
  const set = (v: SlackAdmin | undefined) => { if (v) state.setData(v) }
  return (
    <>
      <AdminPageHeader title={t('slack.admin.title')} desc={t('slack.admin.desc')} testId="slack-admin" />
      <Loadable state={state}>
        {(s) => (
          <>
            {s.tokens && (
              <Card>
                <div className="flex flex-wrap items-center gap-3" data-testid="slack-status">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {s.workspace?.name}
                      {s.botName && <span className="ml-2 text-muted">@{s.botName}</span>}
                    </p>
                    <p className="mt-1 text-xs text-muted">{t('slack.admin.linked', { n: s.linked })}{s.linkOrigin ? ` · ${t('slack.admin.linksOpen', { origin: s.linkOrigin })}` : ''}</p>
                    {s.enabled && s.lastError && <p className="mt-1 text-xs text-danger" data-testid="slack-error">{t(ERRORS[s.lastError])}</p>}
                  </div>
                  <Badge tone={STATE[s.state].tone}>{t(STATE[s.state].key)}</Badge>
                  <Button variant={s.enabled ? 'secondary' : 'primary'} data-testid="slack-toggle"
                    onClick={async () => set(await act(() => api.call(SLACK.setSlackEnabled, { body: { enabled: !s.enabled } }), t(s.enabled ? 'slack.admin.turnedOff' : 'slack.admin.turnedOn')))}>
                    {t(s.enabled ? 'slack.admin.turnOff' : 'slack.admin.turnOn')}
                  </Button>
                </div>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  <button type="button" className="text-muted underline-offset-2 hover:underline" onClick={() => setReplacing((v) => !v)}>{t('slack.admin.replace')}</button>
                  <button type="button" className="text-danger underline-offset-2 hover:underline" data-testid="slack-remove"
                    onClick={async () => {
                      if (!(await confirmDialog({ title: t('slack.admin.removeTitle'), body: t('slack.admin.removeBody'), confirm: t('slack.admin.remove'), danger: true }))) return
                      set(await act(() => api.call(SLACK.removeSlack)))
                    }}>{t('slack.admin.remove')}</button>
                </div>
              </Card>
            )}
            {s.enabled && s.tokens && <People />}
            {(!s.tokens || replacing) && (
              <Card title={t('slack.admin.setupTitle')}>
                <ol className="list-decimal space-y-4 pl-5 text-sm">
                  <li>
                    <p>{t('slack.admin.step1')}</p>
                    <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                      <a href={s.createUrl} target="_blank" rel="noopener noreferrer" className="text-accent underline-offset-2 hover:underline" data-testid="slack-create">{t('slack.admin.create')}</a>
                      <button type="button" className="text-muted underline-offset-2 hover:underline" onClick={() => setManifest((v) => !v)}>{t('slack.admin.showManifest')}</button>
                    </p>
                    {manifest && (
                      <div className="mt-2">
                        <pre className="scroll-thin max-h-64 overflow-auto rounded-lg border border-line bg-canvas p-3 text-xs" data-testid="slack-manifest">{s.manifest}</pre>
                        <CopyButton text={s.manifest} label={t('slack.admin.copyManifest')} showLabel className="mt-2" />
                      </div>
                    )}
                  </li>
                  <li><p>{t('slack.admin.step2')}</p></li>
                  <li><TokenForm onSaved={(v) => { state.setData(v); setReplacing(false) }} /></li>
                </ol>
              </Card>
            )}
            <p className="text-xs text-muted">{t('slack.admin.how')}</p>
          </>
        )}
      </Loadable>
    </>
  )
}

function TokenForm({ onSaved }: { onSaved: (s: SlackAdmin) => void }) {
  const t = useT()
  const act = useAction()
  const [bot, setBot] = useState('')
  const [app, setApp] = useState('')
  const [busy, setBusy] = useState(false)
  const secure = canSeal()
  const ready = /^xoxb-\S{10,}$/.test(bot.trim()) && /^xapp-\S{10,}$/.test(app.trim())
  const save = async () => {
    if (!ready || busy) return
    setBusy(true)
    try {
      const r = await act(async () => {
        const key = await api.call(API.sealingKey)
        const body = { botToken: await sealSecret(key, bot.trim(), 'slack.token'), appToken: await sealSecret(key, app.trim(), 'slack.token') }
        return api.call(SLACK.saveSlackTokens, { body })
      }, t('slack.admin.saved'))
      if (r) { setBot(''); setApp(''); onSaved(r) }
    } finally { setBusy(false) }
  }
  return (
    <div className="space-y-3">
      <p>{t('slack.admin.step3')}</p>
      <Field label={t('slack.admin.botToken')} hint={t('slack.admin.botTokenHint')}>
        <input className={inputCls} type="password" autoComplete="off" spellCheck={false} value={bot} onChange={(e) => setBot(e.target.value)} placeholder="xoxb-…" data-testid="slack-bot-token" />
      </Field>
      <Field label={t('slack.admin.appToken')} hint={t('slack.admin.appTokenHint')}>
        <input className={inputCls} type="password" autoComplete="off" spellCheck={false} value={app} onChange={(e) => setApp(e.target.value)} placeholder="xapp-…" data-testid="slack-app-token" />
      </Field>
      {!secure && <p className="text-sm text-warn">{t('credentials.httpsOnly')}</p>}
      <Button variant="primary" busy={busy} disabled={!ready || !secure || busy} onClick={() => void save()} data-testid="slack-save">{t('slack.admin.save')}</Button>
    </div>
  )
}

/** The workspace's people and whom each is linked to; one action: link someone whose Slack and app e-mails differ (the
 * person cannot link it themselves then). Slack tells them which account it is and how to undo it. */
function People() {
  const t = useT()
  const ok = useActionOk()
  const members = useLoad(() => api.call(SLACK.slackMembers))
  const users = useLoad(async () => (await api.call(API.listUsers, { query: {} })).items.filter((u) => u.status === 'active'))
  const [q, setQ] = useState('')
  const [linking, setLinking] = useState<SlackMember | null>(null)
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
                {shown.map((x) => (
                  <li key={x.slackUserId} className="flex items-center gap-3 py-2" data-testid="slack-person">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{x.name ?? x.realName ?? x.handle ?? x.slackUserId}</p>
                      <p className="truncate text-xs text-muted">{x.email ?? t('slack.people.noEmail')}</p>
                    </div>
                    {x.linkedTo
                      ? <span className="shrink-0 text-xs text-muted">→ {x.linkedTo.name}</span>
                      : <Button size="sm" onClick={() => setLinking(x)} data-testid="slack-person-link">{t('slack.people.link')}</Button>}
                  </li>
                ))}
              </ul>
              {m.truncated && <p className="mt-2 text-xs text-muted">{t('slack.people.truncated')}</p>}
            </>
          )
        }}
      </Loadable>
      {linking && (
        <LinkDialog member={linking} users={users.data ?? []} onClose={() => setLinking(null)}
          onLink={async (userId) => {
            if (await ok(() => api.call(SLACK.linkSlackMember, { body: { slackUserId: linking.slackUserId, userId } }), t('slack.people.linked'))) { setLinking(null); void members.reload() }
          }} />
      )}
    </Card>
  )
}

function LinkDialog({ member, users, onClose, onLink }: { member: SlackMember; users: User[]; onClose: () => void; onLink: (userId: string) => Promise<void> }) {
  const t = useT()
  const [userId, setUserId] = useState('')
  const [busy, setBusy] = useState(false)
  const chosen = useMemo(() => users.find((u) => u.id === userId) ?? null, [users, userId])
  return (
    <Modal open onClose={onClose} title={t('slack.people.dialogTitle')}
      footer={<>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" busy={busy} disabled={!chosen || busy} data-testid="slack-link-member-confirm"
          onClick={async () => { setBusy(true); try { await onLink(userId) } finally { setBusy(false) } }}>{t('slack.people.confirm')}</Button>
      </>}>
      <dl className="space-y-3 text-sm">
        <div>
          <dt className="text-muted">Slack</dt>
          <dd><span className="font-medium">{member.name ?? member.realName ?? member.handle ?? member.slackUserId}</span>
            <span className="block text-xs text-muted">{[member.realName, member.handle ? `@${member.handle}` : null, member.email ?? t('slack.people.noEmail')].filter(Boolean).join(' · ')}</span></dd>
        </div>
        <div>
          <dt className="text-muted">{t('slack.link.meAccount')}</dt>
          <dd>
            <select className={inputCls} value={userId} onChange={(e) => setUserId(e.target.value)} data-testid="slack-link-member-user" aria-label={t('slack.link.meAccount')}>
              <option value="">{t('slack.people.choose')}</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name} (@{u.username})</option>)}
            </select>
            {chosen && <span className="mt-1 block text-xs text-muted">{chosen.email ?? t('slack.people.noEmail')}</span>}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-sm text-warn">{t('slack.people.warning')}</p>
    </Modal>
  )
}
