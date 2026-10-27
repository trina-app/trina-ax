// Admin > AI connections (docs/DECISIONS.md "AI 연결" 3.13): the accounts the team's AI answers with — Claude
// subscription tokens, API keys, ChatGPT sign-ins — grouped by engine, with their state, who uses them, this month's
// use and the order they are tried in. Admins see and re-check; only the owner adds, replaces, orders, assigns,
// limits, switches off and removes (adding and replacing ask for the password again). Tokens and keys are sealed in
// the browser before they are sent (lib/seal.ts) and never shown again. Settings > AI connections (MyCredentials)
// is a member's own list, when the team allows it.
import { ArrowDown, ArrowUp, ExternalLink, KeyRound, MoreHorizontal, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Credential, CredentialAssignment, CredentialKind, CredentialLogin, CredentialsResponse, Group, User } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { canSeal, sealSecret } from '../../lib/seal'
import { formatDateTime, formatNumber, formatUsd } from '../../lib/format'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { isOwner, useMeStrict } from '../../store/session'
import { credentialLogin } from '../../store/live'
import { toast } from '../../store/ui'
import { Badge, Button, CopyButton, Field, IconButton, Modal, Switch, confirmDialog, inputCls } from '../../components/ui'
import { Card, Loadable, useAction, useLoad } from './common'

const FAMILY: Record<'claude' | 'codex', CredentialKind[]> = { claude: ['anthropic-oauth', 'anthropic-api-key'], codex: ['chatgpt', 'openai-api-key'] }
const SUBSCRIPTION = new Set<CredentialKind>(['anthropic-oauth', 'chatgpt'])
/** Company API keys lead the team form; personal subscriptions lead a member's form (D1). */
const KIND_ORDER: CredentialKind[] = ['anthropic-api-key', 'anthropic-oauth', 'openai-api-key', 'chatgpt']
const PERSONAL_KIND_ORDER: CredentialKind[] = ['anthropic-oauth', 'anthropic-api-key', 'chatgpt', 'openai-api-key']
const TONE: Record<Credential['state'], 'ok' | 'warn' | 'danger' | 'neutral'> = {
  ok: 'ok', unverified: 'neutral', expiring: 'warn', expired: 'danger', invalid: 'danger', needs_reconnect: 'danger', limited: 'warn', over_limit: 'warn', disabled: 'neutral', kind_off: 'neutral', sharing_off: 'warn',
}
const CLAUDE_TOKEN_RE = /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,1000}$/
const ANTHROPIC_KEY_RE = /^sk-ant-api\d{2}-[A-Za-z0-9_-]{20,300}$/
const OPENAI_KEY_RE = /^sk-[A-Za-z0-9_-]{20,300}$/
const formatOk = (kind: CredentialKind, s: string) => kind === 'anthropic-oauth' ? CLAUDE_TOKEN_RE.test(s) : kind === 'anthropic-api-key' ? ANTHROPIC_KEY_RE.test(s) : kind === 'openai-api-key' ? OPENAI_KEY_RE.test(s) && !s.startsWith('sk-ant-') : true

export default function Credentials() {
  const t = useT()
  const me = useMeStrict()
  const owner = isOwner(me)
  const act = useAction()
  const state = useLoad(() => api.call(API.listCredentials))
  const groups = useLoad(async () => (owner ? (await api.call(API.listGroups)).items : []), [owner])
  const users = useLoad(async () => (owner ? (await api.call(API.listUsers)).items : []), [owner])
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Credential | null>(null)
  const [replacing, setReplacing] = useState<Credential | null>(null)
  const [checking, setChecking] = useState<string | null>(null)

  const update = (c: Credential) => state.data && state.setData({ ...state.data, items: state.data.items.map((x) => (x.id === c.id ? c : x)) })
  const check = async (c: Credential) => {
    setChecking(c.id)
    const r = await act(() => api.call(API.checkCredential, { params: { id: c.id } }), t('credentials.checked'))
    setChecking(null)
    if (r) update(r)
  }
  const patch = async (c: Credential, body: { disabled?: boolean; priority?: number }) => {
    const r = await act(() => api.call(API.updateCredential, { params: { id: c.id }, body }))
    if (r) void state.reload()
    return r
  }
  const remove = async (c: Credential) => {
    const body = c.kind === 'chatgpt' ? t('credentials.deleteChatgptNote') : undefined
    if (!(await confirmDialog({ title: t('credentials.deleteConfirm', { label: c.label }), body, confirm: t('common.delete'), danger: true }))) return
    if (await act(async () => { await api.call(API.deleteCredential, { params: { id: c.id } }); return true })) void state.reload()
  }
  /** move a team connection up / down within its engine: priorities 10, 20, 30 … in the new order */
  const move = async (d: CredentialsResponse, c: Credential, dir: -1 | 1) => {
    const fam = (FAMILY.claude.includes(c.kind) ? FAMILY.claude : FAMILY.codex)
    const list = d.items.filter((x) => x.scope === 'team' && fam.includes(x.kind))
    const i = list.findIndex((x) => x.id === c.id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= list.length) return
    const next = [...list]
    ;[next[i], next[j]] = [next[j]!, next[i]!]
    for (const [n, x] of next.entries()) if (x.priority !== (n + 1) * 10) await act(() => api.call(API.updateCredential, { params: { id: x.id }, body: { priority: (n + 1) * 10 } }))
    void state.reload()
  }
  const target = (c: Credential) => c.scope === 'personal' ? t('credentials.target.personal', { name: c.owner?.name ?? '' })
    : !c.assignments.length ? t('credentials.target.team') : c.assignments.map((a) => a.name).join(', ')

  return (
    <Loadable state={state}>
      {(d) => (
        <>
          <Card
            title={t('admin.credentials')}
            desc={t('credentials.desc')}
            actions={owner ? <Button size="sm" variant="primary" onClick={() => setAdding(true)} data-testid="credential-add"><Plus size={14} aria-hidden /> {t('credentials.add')}</Button> : undefined}
          >
            {(['claude', 'codex'] as const).map((fam) => {
              const list = d.items.filter((x) => x.scope === 'team' && FAMILY[fam].includes(x.kind))
              return (
                <section key={fam} className="mb-5" aria-labelledby={`cred-${fam}`}>
                  <h3 id={`cred-${fam}`} className="mb-2 text-xs font-semibold tracking-wide text-faint uppercase">{t(`credentials.group.${fam}`)}</h3>
                  {!list.length ? <p className="text-sm text-faint">{t('credentials.none')}</p> : (
                    <ul className="divide-y divide-line rounded-xl border border-line" data-testid={`credentials-${fam}`}>
                      {list.map((c, i) => (
                        <CredentialRow key={c.id} c={c} target={target(c)} owner={owner} checking={checking === c.id}
                          onCheck={() => check(c)} onEdit={() => setEditing(c)} onReplace={() => setReplacing(c)} onRemove={() => remove(c)}
                          onToggle={() => patch(c, { disabled: !c.disabled })}
                          onUp={i > 0 ? () => move(d, c, -1) : undefined} onDown={i < list.length - 1 ? () => move(d, c, 1) : undefined} />
                      ))}
                    </ul>
                  )}
                </section>
              )
            })}
            <p className="text-xs text-muted">{t('credentials.order')}</p>
            <p className="mt-2 text-xs text-muted">{t('credentials.companyBudgetHint')}</p>
            {owner && (
              <div className="mt-4 space-y-1">
                <Switch checked={d.memberOwn} label={t('credentials.memberOwn')} onChange={async (v) => {
                  const r = await act(() => api.call(API.updateCredentialSettings, { body: { memberOwn: v } }))
                  if (r) state.setData({ ...d, memberOwn: r.memberOwn })
                }} />
                <p className="text-xs text-muted">{t('credentials.memberOwnHint')}</p>
                <div data-testid="shared-subscriptions-setting" className="pt-3">
                  <Switch checked={d.sharedSubscriptions} label={t('credentials.sharedSubscriptions')} onChange={async (v) => {
                    if (v && !(await confirmDialog({ title: t('credentials.sharedRiskTitle'), body: t('credentials.sharedRiskWarning'), confirm: t('credentials.sharedRiskConfirm'), danger: true }))) return
                    const r = await act(() => api.call(API.updateCredentialSettings, { body: { sharedSubscriptions: v, ...(v ? { acknowledgedSharedSubscriptionRisk: true } : {}) } }))
                    if (r) void state.reload()
                  }} />
                </div>
                <p className="text-xs text-warn">{t('credentials.sharedRiskWarning')}</p>
              </div>
            )}
            {d.items.some((x) => x.scope === 'personal') && (
              <section className="mt-5">
                <h3 className="mb-2 text-xs font-semibold tracking-wide text-faint uppercase">{t('credentials.personalList')}</h3>
                <ul className="divide-y divide-line rounded-xl border border-line" data-testid="credentials-personal">
                  {d.items.filter((x) => x.scope === 'personal').map((c) => (
                    <CredentialRow key={c.id} c={c} target={target(c)} owner={owner} checking={checking === c.id} personal
                      onCheck={() => check(c)} onEdit={() => {}} onReplace={() => {}} onRemove={() => remove(c)} onToggle={() => patch(c, { disabled: !c.disabled })} />
                  ))}
                </ul>
              </section>
            )}
            <p className="mt-4 text-xs text-faint">{t('credentials.costNote', { date: d.pricesAsOf })}</p>
          </Card>
          {adding && (
            <AddCredential allowedKinds={d.allowedKinds} sharedSubscriptions={d.sharedSubscriptions} groups={groups.data ?? []} users={users.data ?? []} onClose={() => setAdding(false)} onDone={() => { setAdding(false); void state.reload() }} />
          )}
          {replacing && (
            <AddCredential allowedKinds={d.allowedKinds} sharedSubscriptions={d.sharedSubscriptions} groups={[]} users={[]} replace={replacing} onClose={() => setReplacing(null)} onDone={() => { setReplacing(null); void state.reload() }} />
          )}
          {editing && <EditCredential c={editing} groups={groups.data ?? []} users={users.data ?? []} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void state.reload() }} />}
        </>
      )}
    </Loadable>
  )
}

function CredentialRow({ c, target, owner, checking, personal, ownDelete, onCheck, onEdit, onReplace, onRemove, onToggle, onUp, onDown }: {
  c: Credential; target: string; owner: boolean; checking: boolean; personal?: boolean
  /** a member's own row (Settings): a delete button instead of the owner's menu */
  ownDelete?: boolean
  onCheck: () => void; onEdit: () => void; onReplace: () => void; onRemove: () => void; onToggle: () => void; onUp?: () => void; onDown?: () => void
}) {
  const t = useT()
  const locale = useLocale()
  const [menu, setMenu] = useState(false)
  const apiKey = c.kind === 'anthropic-api-key' || c.kind === 'openai-api-key'
  return (
    <li className="flex flex-wrap items-start gap-3 px-3 py-3" data-testid="credential-row" data-kind={c.kind}>
      <KeyRound size={16} className="mt-1 text-faint" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">{c.label}</span>
          {c.hint && <span className="text-xs text-faint">…{c.hint}</span>}
          <span className="text-xs text-muted">{t(`credentials.kind.${c.kind}` as MessageKey)}{c.planType ? ` (${c.planType})` : ''}</span>
          <Badge tone={TONE[c.state]}>{t(`credentials.state.${c.state}` as MessageKey)}</Badge>
          {c.expiresAt && c.state === 'ok' && <span className="text-xs text-faint">{t('credentials.until', { date: formatDateTime(c.expiresAt, locale) })}</span>}
        </p>
        {c.detail && <p className="mt-1 text-xs text-muted" data-testid="credential-detail">{c.detail}</p>}
        <p className="mt-1 text-xs text-faint">
          {target} · {t('credentials.month', { tokens: formatNumber(c.month.tokens, locale) })}
          {apiKey && c.month.usd > 0 && ` · ${t('credentials.monthUsd', { usd: formatUsd(c.month.usd, locale) })}`}
          {apiKey && c.spendLimit.usd !== null && ` / ${formatUsd(c.spendLimit.usd, locale)}`}
          {c.lastUsedAt && ` · ${t('credentials.lastUsed', { date: formatDateTime(c.lastUsedAt, locale) })}`}
        </p>
      </div>
      <div className="flex items-center gap-1">
        {owner && onUp && <IconButton label={t('credentials.moveUp')} onClick={onUp}><ArrowUp size={14} /></IconButton>}
        {owner && onDown && <IconButton label={t('credentials.moveDown')} onClick={onDown}><ArrowDown size={14} /></IconButton>}
        {!personal && (c.state === 'needs_reconnect' && c.kind === 'chatgpt' && owner
          ? <Button size="sm" onClick={onReplace}>{t('credentials.reconnect')}</Button>
          : <IconButton label={t('credentials.check')} onClick={onCheck} disabled={checking}><RefreshCw size={14} className={checking ? 'animate-spin' : ''} /></IconButton>)}
        {ownDelete && <IconButton label={t('common.delete')} onClick={onRemove} data-testid="my-credential-delete"><Trash2 size={14} /></IconButton>}
        {owner && (
          <div className="relative">
            <IconButton label={t('credentials.menu')} onClick={() => setMenu((v) => !v)} aria-expanded={menu} data-testid="credential-menu"><MoreHorizontal size={15} /></IconButton>
            {menu && (
              <div role="menu" className="absolute right-0 z-10 mt-1 w-48 rounded-lg border border-line bg-surface py-1 text-sm shadow-lg" onClick={() => setMenu(false)}>
                {!personal && <button role="menuitem" type="button" className="block w-full px-3 py-1.5 text-left hover:bg-hover" onClick={onEdit}>{t('credentials.rename')} · {t('credentials.changeTarget')} · {t('credentials.spendLimit')}</button>}
                {!personal && <button role="menuitem" type="button" className="block w-full px-3 py-1.5 text-left hover:bg-hover" onClick={onReplace}>{c.kind === 'chatgpt' ? t('credentials.reconnect') : t('credentials.replace')}</button>}
                <button role="menuitem" type="button" className="block w-full px-3 py-1.5 text-left hover:bg-hover" onClick={onToggle}>{c.disabled ? t('credentials.enable') : t('credentials.disable')}</button>
                <button role="menuitem" type="button" className="block w-full px-3 py-1.5 text-left text-danger hover:bg-hover" onClick={onRemove}>{t('common.delete')}</button>
              </div>
            )}
          </div>
        )}
      </div>
    </li>
  )
}

/** Groups / people a connection is assigned to (empty = the whole team). */
function TargetPicker({ value, onChange, groups, users }: { value: CredentialAssignment[]; onChange: (v: CredentialAssignment[]) => void; groups: Group[]; users: User[] }) {
  const t = useT()
  const [pick, setPick] = useState(value.length > 0)
  const has = (a: CredentialAssignment) => value.some((x) => x.subjectType === a.subjectType && x.subjectId === a.subjectId)
  const toggle = (a: CredentialAssignment) => onChange(has(a) ? value.filter((x) => !(x.subjectType === a.subjectType && x.subjectId === a.subjectId)) : [...value, a])
  return (
    <fieldset className="space-y-2">
      <legend className="text-xs font-medium text-muted">{t('credentials.target')}</legend>
      <label className="flex items-center gap-2 text-sm"><input type="radio" checked={!pick} onChange={() => { setPick(false); onChange([]) }} /> {t('credentials.target.team')}</label>
      <label className="flex items-center gap-2 text-sm"><input type="radio" checked={pick} onChange={() => setPick(true)} /> {t('credentials.target.pick')}</label>
      {pick && (
        <div className="grid gap-2 pl-6 sm:grid-cols-2">
          <div>
            <p className="mb-1 text-xs text-faint">{t('credentials.target.groups')}</p>
            {groups.map((g) => <label key={g.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={has({ subjectType: 'group', subjectId: g.id })} onChange={() => toggle({ subjectType: 'group', subjectId: g.id })} /> {g.name}</label>)}
          </div>
          <div>
            <p className="mb-1 text-xs text-faint">{t('credentials.target.people')}</p>
            {users.filter((u) => u.status === 'active').map((u) => <label key={u.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={has({ subjectType: 'user', subjectId: u.id })} onChange={() => toggle({ subjectType: 'user', subjectId: u.id })} /> {u.name}</label>)}
          </div>
        </div>
      )}
    </fieldset>
  )
}

/**
 * Add a connection (owner: the team's; personal: one's own), or put a new token / key on one (replace), or sign the
 * ChatGPT plan in again (replace of a chatgpt connection).
 */
export function AddCredential({ allowedKinds, groups, users, replace, personal, sharedSubscriptions = false, onClose, onDone }: {
  allowedKinds: CredentialKind[]; groups: Group[]; users: User[]; replace?: Credential; personal?: boolean; sharedSubscriptions?: boolean; onClose: () => void; onDone: () => void
}) {
  const t = useT()
  const locale = useLocale()
  const [kind, setKind] = useState<CredentialKind | null>(replace?.kind ?? null)
  const [label, setLabel] = useState(replace?.label ?? '')
  const [secret, setSecret] = useState('')
  const [assignments, setAssignments] = useState<CredentialAssignment[]>([])
  const [ack, setAck] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [login, setLogin] = useState<CredentialLogin | null>(null)
  const secure = canSeal()
  const subscription = kind !== null && SUBSCRIPTION.has(kind)
  const sharingBlocked = subscription && !personal && !sharedSubscriptions
  const needsPassword = !personal
  const ready = kind !== null && !sharingBlocked && (replace || label.trim().length > 0) && (kind === 'chatgpt' || formatOk(kind, secret.trim())) && (!subscription || replace || ack) && (!needsPassword || password.length > 0)

  // ChatGPT sign-in progress: the WebSocket event, and a poll in case the socket is down
  useEffect(() => {
    if (!login || ['done', 'failed', 'expired', 'cancelled'].includes(login.state)) return
    const off = credentialLogin.on((l) => { if (l.loginId === login.loginId) setLogin(l) })
    const poll = setInterval(async () => {
      try { setLogin(await api.call(personal ? API.getMyCredentialLogin : API.getCredentialLogin, { params: { id: login.loginId } })) } catch { /* the event will do */ }
    }, 3000)
    return () => { off(); clearInterval(poll) }
  }, [login, personal])

  const submit = async () => {
    if (!kind || !ready) return
    setBusy(true); setError(null)
    try {
      if (kind === 'chatgpt') {
        const common = { label: label.trim() || replace?.label || 'ChatGPT', acknowledgedPlanNotice: true as const, ...(replace ? { reconnectId: replace.id } : {}) }
        setLogin(personal ? await api.call(API.startMyCredentialLogin, { body: common }) : await api.call(API.startCredentialLogin, { body: { ...common, assignments, password } }))
        return
      }
      const key = await api.call(API.sealingKey)
      if (replace) {
        const sealed = await sealSecret(key, secret.trim(), 'credential.replace')
        await api.call(API.replaceCredentialSecret, { params: { id: replace.id }, body: { sealed, password } })
        toast({ level: 'success', text: t('credentials.connected') })
      } else {
        const sealed = await sealSecret(key, secret.trim(), 'credential.create')
        const body = { kind: kind as Exclude<CredentialKind, 'chatgpt'>, label: label.trim(), sealed, ...(subscription ? { acknowledgedPlanNotice: ack } : {}) }
        const c = personal ? await api.call(API.createMyCredential, { body }) : await api.call(API.createCredential, { body: { ...body, assignments, password } })
        toast({ level: 'success', text: c.state === 'unverified' ? t('credentials.unverifiedSaved') : t('credentials.connected') })
      }
      setSecret('')
      onDone()
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    } finally { setBusy(false) }
  }
  const cancelLogin = async () => {
    if (login && !['done', 'failed', 'expired', 'cancelled'].includes(login.state)) {
      try { await api.call(personal ? API.cancelMyCredentialLogin : API.cancelCredentialLogin, { params: { id: login.loginId } }) } catch { /* gone already */ }
    }
    onClose()
  }
  const kinds = (personal ? PERSONAL_KIND_ORDER : KIND_ORDER).filter((k) => !replace || k === replace.kind)
  const finished = login && ['done', 'failed', 'expired', 'cancelled'].includes(login.state)

  return (
    <Modal open onClose={cancelLogin} width={560} title={replace ? (replace.kind === 'chatgpt' ? t('credentials.reconnect') : t('credentials.replace')) : t('credentials.add')}
      footer={login ? (
        <>
          {login.state === 'done' ? <Button variant="primary" onClick={onDone}>{t('common.done')}</Button>
            : finished ? <Button variant="primary" onClick={() => setLogin(null)}>{t('credentials.chatgpt.restart')}</Button>
            : <Button variant="ghost" onClick={cancelLogin}>{t('common.cancel')}</Button>}
        </>
      ) : (
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" busy={busy} disabled={!ready || !secure} onClick={submit} data-testid="credential-submit">
            {busy ? t('credentials.checking') : kind === 'chatgpt' ? t('credentials.chatgpt.start') : t('credentials.connect')}
          </Button>
        </>
      )}>
      {!secure ? <p className="text-sm text-warn" data-testid="credential-https-only">{t('credentials.httpsOnly')}</p>
        : login ? <ChatgptProgress l={login} />
        : (
          <div className="space-y-4">
            {personal && <p className="text-sm text-muted">{t('credentials.personalFirst')}</p>}
            {!personal && !sharedSubscriptions && <p className="text-sm text-warn" data-testid="shared-subscriptions-off">{t('credentials.sharedSubscriptionsOff')}</p>}
            {!replace && (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">{t('credentials.chooseKind')}</legend>
                {kinds.map((k) => {
                  const policyOff = !personal && SUBSCRIPTION.has(k) && !sharedSubscriptions
                  const off = !allowedKinds.includes(k) || policyOff
                  return (
                    <label key={k} className={`flex items-start gap-2 rounded-lg border border-line p-2 text-sm ${off ? 'opacity-60' : 'cursor-pointer hover:bg-hover'}`}>
                      <input type="radio" name="kind" disabled={off} checked={kind === k} onChange={() => { setKind(k); setError(null) }} data-testid={`kind-${k}`} />
                      <span>
                        <span className="font-medium">{t(`credentials.kind.${k}` as MessageKey)}</span>
                        <span className="block text-xs text-muted">{policyOff ? t('credentials.sharedSubscriptionsOff') : off ? t('credentials.kindOff') : t(`credentials.kind.${k}.desc` as MessageKey)}</span>
                      </span>
                    </label>
                  )
                })}
              </fieldset>
            )}
            {kind === 'anthropic-oauth' && (
              <ol className="list-decimal space-y-2 pl-5 text-sm" data-testid="setup-token-steps">
                <li>{t('credentials.setupToken.steps.1')}
                  <CommandLine text="curl -fsSL https://claude.ai/install.sh | bash" />
                  <span className="text-xs text-muted">{t('credentials.setupToken.steps.1win')}</span> <CommandLine text="irm https://claude.ai/install.ps1 | iex" />
                </li>
                <li>{t('credentials.setupToken.steps.2')} <CommandLine text="claude setup-token" /></li>
                <li>{t('credentials.setupToken.steps.3')}</li>
                <li>{t('credentials.setupToken.steps.4')}</li>
              </ol>
            )}
            {(kind === 'anthropic-api-key' || kind === 'openai-api-key') && (
              <p className="text-sm text-muted">
                {t('credentials.apiKey.hint')}{' '}
                <a className="inline-flex items-center gap-1 text-accent underline" href={kind === 'anthropic-api-key' ? 'https://platform.claude.com/settings/keys' : 'https://platform.openai.com/api-keys'} target="_blank" rel="noreferrer noopener">
                  {t(kind === 'anthropic-api-key' ? 'credentials.apiKey.consoleAnthropic' : 'credentials.apiKey.consoleOpenai')} <ExternalLink size={12} aria-hidden />
                </a>
              </p>
            )}
            {kind && !replace && (
              <Field label={t('credentials.label')}>
                <input className={inputCls} value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} data-testid="credential-label" />
              </Field>
            )}
            {kind && kind !== 'chatgpt' && (
              <Field label={t(kind === 'anthropic-oauth' ? 'credentials.setupToken.paste' : 'credentials.apiKey.paste')}
                error={secret.trim() && !formatOk(kind, secret.trim()) ? t(kind === 'anthropic-oauth' ? 'credentials.setupToken.invalidFormat' : 'credentials.apiKey.invalidFormat') : null}>
                <input className={inputCls} type="password" autoComplete="off" spellCheck={false} value={secret} onChange={(e) => setSecret(e.target.value)} data-testid="credential-secret" />
              </Field>
            )}
            {kind && !replace && !personal && <TargetPicker value={assignments} onChange={setAssignments} groups={groups} users={users} />}
            {subscription && !replace && (
              <div className="rounded-lg bg-subtle p-3 text-sm" data-testid="plan-notice">
                <p>{t('credentials.planNotice')}</p>
                <label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="plan-notice-ack" /> {t('credentials.planNoticeAck')}</label>
              </div>
            )}
            {kind && needsPassword && (
              <Field label={t('credentials.reauth')}>
                <input className={inputCls} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="credential-password" />
              </Field>
            )}
            {error && <p className="text-sm text-danger" role="alert" data-testid="dialog-error">{error}</p>}
          </div>
        )}
    </Modal>
  )
}

function CommandLine({ text }: { text: string }) {
  return (
    <span className="my-1 flex items-center gap-1 rounded-md bg-subtle px-2 py-1 font-mono text-xs">
      <code className="min-w-0 flex-1 break-all">{text}</code>
      <CopyButton text={text} />
    </span>
  )
}

function ChatgptProgress({ l }: { l: CredentialLogin }) {
  const t = useT()
  if (l.state === 'starting') return <p className="text-sm text-muted">{t('credentials.chatgpt.starting')}</p>
  if (l.state === 'code' && l.url && l.code) return (
    <ol className="list-decimal space-y-3 pl-5 text-sm" data-testid="chatgpt-code">
      <li>{t('credentials.chatgpt.step1')}
        <span className="mt-1 flex items-center gap-2">
          <a className="break-all text-accent underline" href={l.url} target="_blank" rel="noreferrer noopener">{l.url}</a>
          <CopyButton text={l.url} />
        </span>
      </li>
      <li>{t('credentials.chatgpt.step2')}
        <span className="mt-1 flex items-center gap-2"><code className="text-xl font-semibold tracking-widest" data-testid="chatgpt-user-code">{l.code}</code><CopyButton text={l.code} /></span>
      </li>
      <li>{t('credentials.chatgpt.step3')}</li>
      <li className="list-none text-muted">⏳ {t('credentials.chatgpt.waiting')}</li>
    </ol>
  )
  if (l.state === 'done') return <p className="text-sm text-ok" data-testid="chatgpt-done">{t('credentials.chatgpt.done', { plan: l.credential?.planType ?? '' })}</p>
  if (l.state === 'expired') return <p className="text-sm text-warn">{t('credentials.chatgpt.expired')}</p>
  if (l.state === 'cancelled') return <p className="text-sm text-muted">{t('credentials.chatgpt.cancelled')}</p>
  const reason = l.reason === 'other_account' ? 'credentials.chatgpt.otherAccount' : l.reason === 'same_account' ? 'credentials.chatgpt.sameAccount' : 'credentials.chatgpt.failed'
  return <p className="text-sm text-danger" data-testid="chatgpt-failed">{t(reason)}</p>
}

/** rename, who uses it, monthly limit (owner) */
function EditCredential({ c, groups, users, onClose, onSaved }: { c: Credential; groups: Group[]; users: User[]; onClose: () => void; onSaved: () => void }) {
  const t = useT()
  const act = useAction()
  const [label, setLabel] = useState(c.label)
  const [assignments, setAssignments] = useState<CredentialAssignment[]>(c.assignments.map(({ subjectType, subjectId }) => ({ subjectType, subjectId })))
  const [usd, setUsd] = useState(c.spendLimit.usd === null ? '' : String(c.spendLimit.usd))
  const [tokens, setTokens] = useState(c.spendLimit.tokens === null ? '' : String(c.spendLimit.tokens))
  const [action, setAction] = useState(c.spendLimit.action)
  const [busy, setBusy] = useState(false)
  const apiKey = c.kind === 'anthropic-api-key' || c.kind === 'openai-api-key'
  const num = (s: string) => (s.trim() === '' ? null : Math.max(0, Number(s)))
  const valid = label.trim().length > 0 && (usd.trim() === '' || Number.isFinite(Number(usd))) && (tokens.trim() === '' || Number.isInteger(Number(tokens)))
  return (
    <Modal open onClose={onClose} title={c.label} width={520}
      footer={<>
        <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" busy={busy} disabled={!valid} onClick={async () => {
          setBusy(true)
          const r = await act(() => api.call(API.updateCredential, { params: { id: c.id }, body: { label: label.trim(), assignments, spendLimit: { usd: apiKey ? num(usd) : null, tokens: num(tokens) === null ? null : Math.round(num(tokens)!), action } } }), t('common.saved'))
          setBusy(false)
          if (r) onSaved()
        }}>{t('common.save')}</Button>
      </>}>
      <div className="space-y-4">
        <Field label={t('credentials.label')}><input className={inputCls} value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} /></Field>
        <TargetPicker value={assignments} onChange={setAssignments} groups={groups} users={users} />
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-muted">{t('credentials.spendLimit')}</legend>
          <p className="text-xs text-faint">{t('credentials.spendLimitHint')}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {apiKey && <Field label={t('credentials.spendLimitUsd')}><input className={inputCls} inputMode="decimal" value={usd} onChange={(e) => setUsd(e.target.value)} /></Field>}
            <Field label={t('credentials.spendLimitTokens')}><input className={inputCls} inputMode="numeric" value={tokens} onChange={(e) => setTokens(e.target.value)} /></Field>
          </div>
          <select className={inputCls} value={action} onChange={(e) => setAction(e.target.value as 'warn' | 'block')}>
            <option value="block">{t('credentials.spendLimitAction.block')}</option>
            <option value="warn">{t('credentials.spendLimitAction.warn')}</option>
          </select>
        </fieldset>
      </div>
    </Modal>
  )
}

/** Settings > AI connections: one's own connections (shown only while the team allows them). */
export function MyCredentials() {
  const t = useT()
  const act = useAction()
  const state = useLoad(() => api.call(API.myCredentials))
  const [adding, setAdding] = useState(false)
  return (
    <Loadable state={state}>
      {(d) => (
        <Card title={t('settings.credentials')} desc={t('settings.credentials.desc')}
          actions={d.allowed ? <Button size="sm" onClick={() => setAdding(true)} data-testid="my-credential-add"><Plus size={14} aria-hidden /> {t('credentials.add')}</Button> : undefined}>
          {!d.items.length ? <p className="text-sm text-faint">{t('credentials.none')}</p> : (
            <ul className="divide-y divide-line rounded-xl border border-line" data-testid="my-credentials">
              {d.items.map((c) => (
                <CredentialRow key={c.id} c={c} target={t('credentials.target.personal', { name: c.owner?.name ?? '' })} owner={false} checking={false} personal ownDelete
                  onCheck={() => {}} onEdit={() => {}} onReplace={() => {}} onToggle={() => {}}
                  onRemove={async () => {
                    if (!(await confirmDialog({ title: t('credentials.deleteConfirm', { label: c.label }), confirm: t('common.delete'), danger: true }))) return
                    if (await act(async () => { await api.call(API.deleteMyCredential, { params: { id: c.id } }); return true })) void state.reload()
                  }} />
              ))}
            </ul>
          )}
          {adding && <AddCredential personal allowedKinds={d.allowedKinds} groups={[]} users={[]} onClose={() => setAdding(false)} onDone={() => { setAdding(false); void state.reload() }} />}
        </Card>
      )}
    </Loadable>
  )
}
