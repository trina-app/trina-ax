// Admin › MCP: asking a member to connect a service as their own connection. Some services log every call as the
// person whose key it is, so that key belongs in the member's personal connection, which nobody else can see or use.
// The admin opens it from Add connection's menu (a popup: the service — kind, name, address, how it signs in, the key's
// header, usage notes for an API — and the member); the member gets a notice and adds their own key or signs in
// (Settings › MCP, AnswerDialog.tsx). The admin never sees the key. On the page, a request is one quiet row in the
// Connected list while it waits (copy its link, withdraw it), and for two weeks after the member connected it,
// declined it or it expired (ask again); a withdrawn one goes at once. No list of its own.
// Server: server/src/integrations/connections/requests.ts.
import clsx from 'clsx'
import { Globe, Link2, RotateCcw, Undo2, Waypoints } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { INTEGRATION_REQUEST_DAYS, type IntegrationKind, type IntegrationRequest, type User } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { connectorFor } from '../../lib/connectors'
import { formatDateTime } from '../../lib/format'
import { emptyRequestForm, NOTES_MAX, REQUEST_FIELD_OF, REQUEST_STATE_TONE, requestMethodsFor, serverFieldErrors, toRequestInput, validateRequest, type RequestField, type RequestForm } from '../../lib/integrations'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { reloadAsked } from '../../store/live'
import { toast } from '../../store/ui'
import { Badge, Button, Field, IconButton, Modal, confirmDialog, inputCls } from '../ui'
import { useLoad } from '../../pages/admin/common'
import { Choices } from './IntegrationDialog'
import { ConnectorLogo } from './ConnectorsView'

/** how long a request that ended (connected, declined, expired) stays on the page */
const ENDED_SHOWN_MS = 14 * 24 * 60 * 60 * 1000

/** The requests the page shows: the waiting ones, and the ones that ended lately (not withdrawn: the admin did that). */
export const shownRequests = (list: IntegrationRequest[], now = Date.now()) =>
  list.filter((r) => r.state === 'waiting' || (r.state !== 'withdrawn' && now - Date.parse(r.endedAt ?? r.expiresAt) < ENDED_SHOWN_MS))

/** The requests admins sent: loaded with the page, kept in step with the server (reloadAsked), and withdrawing one. */
export function useTeamRequests() {
  const t = useT()
  const locale = useLocale()
  // an older server has no requests: the page works without them
  const state = useLoad(async () => { try { return (await api.call(API.listTeamIntegrationRequests)).items } catch { return [] as IntegrationRequest[] } })
  const reloadList = state.reload
  useEffect(() => reloadAsked.on(() => void reloadList()), [reloadList])
  const withdraw = async (r: IntegrationRequest) => {
    const ok = await confirmDialog({ title: t('integrations.requests.withdrawTitle', { name: r.name }), body: t('integrations.requests.withdrawBody', { user: r.user.name }), confirm: t('integrations.requests.withdraw'), danger: true })
    if (!ok) return
    try {
      const next = await api.call(API.withdrawIntegrationRequest, { params: { id: r.id }, body: {} })
      state.setData((d) => d?.map((x) => (x.id === next.id ? next : x)) ?? d)
      toast({ level: 'success', text: t('integrations.requests.withdrawn') })
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
      void reloadList()
    }
  }
  const sent = (r: IntegrationRequest) => state.setData((d) => (d ? [r, ...d.filter((x) => x.id !== r.id)] : [r]))
  return { list: state.data ?? [], withdraw, sent }
}

const ENDED_AT: Record<Exclude<IntegrationRequest['state'], 'waiting'>, MessageKey> = {
  connected: 'integrations.requests.endedAt.connected',
  declined: 'integrations.requests.endedAt.declined',
  withdrawn: 'integrations.requests.endedAt.withdrawn',
  expired: 'integrations.requests.endedAt.expired',
}

function ServiceIcon({ r }: { r: IntegrationRequest }) {
  const listed = connectorFor(r.url)
  const KindIcon = r.kind === 'mcp' ? Waypoints : Globe
  return listed ? <ConnectorLogo c={listed} className="size-9" /> : (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-subtle text-muted">
      <KindIcon size={16} aria-hidden />
    </span>
  )
}

/** One request in the Connected list: the service, "Requested · Alice" (or connected, declined, expired), and on the
 * line what can be done with it: copy its link and withdraw it while it waits, ask again once declined or expired. */
export function RequestRow({ r, onWithdraw, onAskAgain }: { r: IntegrationRequest; onWithdraw: () => void; onAskAgain: () => void }) {
  const t = useT()
  const locale = useLocale()
  const waiting = r.state === 'waiting'
  const state = r.state === 'waiting' ? t('integrations.requests.requested') : t(`integrations.requests.state.${r.state}`)
  const when = r.state === 'waiting'
    ? t('integrations.requests.until', { date: formatDateTime(r.expiresAt, locale) })
    : t(ENDED_AT[r.state], { date: formatDateTime(r.endedAt ?? r.expiresAt, locale) })
  let host = r.url
  try { host = new URL(r.url).host } catch { /* shown as given */ }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(r.link)
      toast({ level: 'success', text: t('integrations.requests.linkCopied') })
    } catch {
      toast({ level: 'error', text: t('integrations.requests.linkNotCopied') })
    }
  }
  return (
    <li className="flex items-center gap-1 py-1" data-testid="integration-request" data-state={r.state} data-name={r.name}>
      <div className="flex min-w-0 flex-1 items-center gap-3 p-2">
        <ServiceIcon r={r} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="max-w-full truncate text-sm font-medium" title={r.name}>{r.name}</span>
            <span className="inline-flex" data-testid="integration-request-chip"><Badge tone={REQUEST_STATE_TONE[r.state]}>{t('integrations.requests.chip', { state, name: r.user.name })}</Badge></span>
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted">{[host, when].join(' · ')}</span>
        </span>
      </div>
      {waiting ? (
        <>
          <IconButton label={t('integrations.requests.copyLink')} onClick={() => void copy()} data-testid="integration-request-copy"><Link2 size={15} /></IconButton>
          <IconButton label={t('integrations.requests.withdraw')} danger onClick={onWithdraw} data-testid="integration-request-withdraw"><Undo2 size={15} /></IconButton>
        </>
      ) : r.state !== 'connected' && (
        <IconButton label={t('integrations.requests.askAgain')} onClick={onAskAgain} data-testid="integration-request-again"><RotateCcw size={15} /></IconButton>
      )}
    </li>
  )
}

/** a request asked again: the same service and member */
export function requestFormOf(r: IntegrationRequest): RequestForm {
  const custom = r.auth === 'header'
  return {
    userId: r.user.id,
    kind: r.kind,
    name: r.name,
    url: r.url,
    method: r.auth === 'oauth' ? 'oauth' : 'key',
    header: custom ? 'custom' : 'bearer',
    headerName: custom ? r.authHeader ?? '' : '',
    notes: r.notes ?? '',
  }
}

/** Fill in the service and pick the member (`initial`: a request asked again). Sent: the popup closes with a short
 * note, and the request is a row on the page (its link is copied from there). */
export function RequestDialog({ users, initial, onClose, onSent }: { users: User[]; initial?: RequestForm; onClose: () => void; onSent: (r: IntegrationRequest) => void }) {
  const t = useT()
  const locale = useLocale()
  const [f, setF] = useState<RequestForm>(() => initial ?? emptyRequestForm('mcp'))
  const [touched, setTouched] = useState<Partial<Record<RequestField, boolean>>>({})
  const [submitted, setSubmitted] = useState(false)
  const [server, setServer] = useState<Partial<Record<RequestField, string | null>>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  const errors = validateRequest(f)
  const people = users.filter((u) => u.status === 'active').sort((a, b) => a.name.localeCompare(b.name))

  const errorOf = (k: RequestField): string | null => {
    if (k in server) return server[k] ?? t('integrations.error.field')
    const e = errors[k]
    return e && (submitted || touched[k]) ? t(e) : null
  }
  const change = (patch: Partial<RequestForm>, ...fields: RequestField[]) => {
    setF((x) => ({ ...x, ...patch }))
    if (fields.some((k) => k in server)) setServer((s) => Object.fromEntries(Object.entries(s).filter(([k]) => !fields.includes(k as RequestField))))
    setError(null)
  }
  const blur = (k: RequestField) => () => setTouched((x) => ({ ...x, [k]: true }))
  const focusInvalid = useCallback(() => requestAnimationFrame(() => body.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()), [])

  const send = async () => {
    setSubmitted(true)
    if (Object.keys(errors).length) return void focusInvalid()
    setBusy(true)
    setError(null)
    setServer({})
    try {
      const r = await api.call(API.createIntegrationRequest, { body: toRequestInput(f) })
      onSent(r)
      toast({ level: 'success', text: t('integrations.request.sent', { user: r.user.name, name: r.name }) })
      onClose()
    } catch (e) {
      const fields = serverFieldErrors(e, REQUEST_FIELD_OF)
      setServer(fields)
      if (!Object.keys(fields).length) setError(errorText(e, locale, t('error.network')))
      else focusInvalid()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={600}
      title={t('integrations.request.title')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void send()} data-testid="integration-request-send">
            {t('integrations.request.send')}
          </Button>
        </>
      }
    >
      <form className="space-y-5" noValidate onSubmit={(e) => { e.preventDefault(); void send() }}>
        <div ref={body} className="space-y-5">
          <p className="text-sm text-muted">{t('integrations.request.intro', { days: INTEGRATION_REQUEST_DAYS })}</p>
          <Field label={t('integrations.request.field.user')} error={errorOf('userId')}>
            <select className={clsx(inputCls)} value={f.userId} onChange={(e) => change({ userId: e.target.value }, 'userId')} onBlur={blur('userId')} data-autofocus data-testid="integration-request-user">
              <option value="">{t('integrations.request.field.userPlaceholder')}</option>
              {people.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.username})
                </option>
              ))}
            </select>
          </Field>
          <Choices<IntegrationKind>
            legend={t('integrations.field.kind')}
            value={f.kind}
            onChange={(k) => change({ kind: k, method: requestMethodsFor(k).includes(f.method) ? f.method : 'key' }, 'method')}
            options={(['mcp', 'http'] as const).map((k) => ({ value: k, label: t(`integrations.kind.${k}`), desc: t(`integrations.kind.${k}.desc`), testId: `integration-request-kind-${k}` }))}
          />
          <Field label={t('integrations.field.name')} hint={t('integrations.field.nameHint')} error={errorOf('name')}>
            <input className={inputCls} value={f.name} maxLength={80} placeholder={t('integrations.field.namePlaceholder')} onChange={(e) => change({ name: e.target.value }, 'name')} onBlur={blur('name')} data-testid="integration-request-name" />
          </Field>
          <Field label={t('integrations.field.url')} hint={t(f.kind === 'mcp' ? 'integrations.field.urlHint.mcp' : 'integrations.field.urlHint.http')} error={errorOf('url')}>
            <input className={inputCls} type="url" inputMode="url" autoComplete="off" spellCheck={false} value={f.url} placeholder={f.kind === 'mcp' ? 'https://mcp.example.com/mcp' : 'https://api.example.com/v1'} onChange={(e) => change({ url: e.target.value }, 'url')} onBlur={blur('url')} data-testid="integration-request-url" />
          </Field>
          <Choices<'oauth' | 'key'>
            legend={t('integrations.field.auth')}
            value={f.method}
            onChange={(m) => change({ method: m }, 'method', 'headerName')}
            error={errorOf('method')}
            options={requestMethodsFor(f.kind).map((m) => ({ value: m, label: t(`integrations.auth.${m}`), desc: t(`integrations.auth.${m}.desc`), testId: `integration-request-auth-${m}` }))}
          />
          {f.method === 'key' && (
            <div className="space-y-4">
              <Choices<'bearer' | 'custom'>
                legend={t('integrations.field.header')}
                value={f.header}
                onChange={(h) => change({ header: h }, 'headerName')}
                compact
                options={[
                  { value: 'bearer', label: t('integrations.header.bearer'), testId: 'integration-request-header-bearer' },
                  { value: 'custom', label: t('integrations.header.custom'), testId: 'integration-request-header-custom' },
                ]}
              />
              {f.header === 'custom' && (
                <Field label={t('integrations.field.headerName')} hint={t('integrations.field.headerNameHint')} error={errorOf('headerName')}>
                  <input className={inputCls} value={f.headerName} maxLength={64} autoComplete="off" spellCheck={false} placeholder="X-API-Key" onChange={(e) => change({ headerName: e.target.value }, 'headerName')} onBlur={blur('headerName')} data-testid="integration-request-header-name" />
                </Field>
              )}
              <p className="text-xs text-muted">{t('integrations.request.keyByMember')}</p>
            </div>
          )}
          {f.kind === 'http' && (
            <Field label={t('integrations.field.notes')} hint={t('integrations.field.notesHint', { n: NOTES_MAX.toLocaleString(locale) })} error={errorOf('notes')}>
              <textarea className={clsx(inputCls, 'h-auto min-h-24 py-2')} rows={4} value={f.notes} placeholder={t('integrations.field.notesPlaceholder')} onChange={(e) => change({ notes: e.target.value }, 'notes')} onBlur={blur('notes')} data-testid="integration-request-notes" />
            </Field>
          )}
          {error && (
            <p role="alert" className="text-sm text-danger" data-testid="integration-request-error">
              {error}
            </p>
          )}
        </div>
        <button type="submit" hidden tabIndex={-1} aria-hidden />
      </form>
    </Modal>
  )
}
