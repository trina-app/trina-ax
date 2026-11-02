// Admin › External services: asking a member to connect a service as their own connection. Some services log every call
// as the person whose key it is, so that key belongs in the member's personal connection, which nobody else can see or
// use. The admin fills in the service (kind, name, address, how it signs in, the key's header, usage notes for an API)
// and picks the member; the member gets a notice and adds their own key or signs in (Settings › External services,
// AnswerDialog.tsx). The admin never sees the key, and sees each request's state: waiting, connected, declined,
// withdrawn or expired. Server: server/src/integrations/connections/requests.ts.
import clsx from 'clsx'
import { Send, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { INTEGRATION_REQUEST_DAYS, type IntegrationKind, type IntegrationRequest, type User } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { emptyRequestForm, NOTES_MAX, REQUEST_FIELD_OF, REQUEST_STATE_TONE, requestMethodsFor, serverFieldErrors, toRequestInput, validateRequest, type RequestField, type RequestForm } from '../../lib/integrations'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { reloadAsked } from '../../store/live'
import { toast } from '../../store/ui'
import { Badge, Button, CopyButton, EmptyState, Field, Modal, confirmDialog, inputCls } from '../ui'
import { Card, Loadable, useLoad } from '../../pages/admin/common'
import { Choices } from './IntegrationDialog'

/** The requests admins sent, with their state, and the button that sends a new one. */
export function TeamRequests() {
  const t = useT()
  const locale = useLocale()
  const state = useLoad(async () => (await api.call(API.listTeamIntegrationRequests)).items)
  const users = useLoad(async () => (await api.call(API.listUsers)).items)
  const [open, setOpen] = useState(false)
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
  return (
    <>
      <Card
        title={t('integrations.requests.title')}
        desc={t('integrations.requests.desc')}
        actions={
          <Button size="sm" onClick={() => setOpen(true)} data-testid="integration-request-add">
            <Send size={14} aria-hidden /> {t('integrations.requests.add')}
          </Button>
        }
      >
        <Loadable state={state}>
          {(list) =>
            !list.length ? (
              <EmptyState icon={<Send size={24} />} title={t('integrations.requests.empty')}>
                <p>{t('integrations.requests.emptyHint')}</p>
              </EmptyState>
            ) : (
              <ul className="-m-4 divide-y divide-line" data-testid="integration-requests">
                {list.map((r) => (
                  <RequestRow key={r.id} r={r} onWithdraw={() => void withdraw(r)} />
                ))}
              </ul>
            )
          }
        </Loadable>
      </Card>
      {open && (
        <RequestDialog
          users={users.data ?? []}
          onClose={() => setOpen(false)}
          onSent={(r) => state.setData((d) => (d ? [r, ...d] : d))}
        />
      )}
    </>
  )
}

const ENDED_AT: Record<Exclude<IntegrationRequest['state'], 'waiting'>, MessageKey> = {
  connected: 'integrations.requests.endedAt.connected',
  declined: 'integrations.requests.endedAt.declined',
  withdrawn: 'integrations.requests.endedAt.withdrawn',
  expired: 'integrations.requests.endedAt.expired',
}

function RequestRow({ r, onWithdraw }: { r: IntegrationRequest; onWithdraw: () => void }) {
  const t = useT()
  const locale = useLocale()
  const waiting = r.state === 'waiting'
  const when = r.state === 'waiting'
    ? t('integrations.requests.until', { date: formatDateTime(r.expiresAt, locale) })
    : t(ENDED_AT[r.state], { date: formatDateTime(r.endedAt ?? r.expiresAt, locale) })
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3" data-testid="integration-request" data-state={r.state} data-name={r.name}>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="font-medium break-words">{r.name}</span>
          <span className="text-xs text-muted">{t(r.kind === 'mcp' ? 'integrations.kind.mcp' : 'integrations.kind.http')}</span>
          <Badge tone={REQUEST_STATE_TONE[r.state]}>{t(`integrations.requests.state.${r.state}`)}</Badge>
        </p>
        <p className="mt-0.5 text-xs break-all text-faint">{r.url}</p>
        <p className="mt-1 text-xs text-muted">
          {[t('integrations.requests.to', { name: r.user.name }), r.requestedBy && t('integrations.requests.by', { name: r.requestedBy.name }), when].filter(Boolean).join(' · ')}
        </p>
      </div>
      {waiting && (
        <div className="flex flex-wrap items-center gap-1 max-sm:w-full">
          <CopyButton text={r.link} label={t('integrations.requests.copyLink')} showLabel className="border border-line" />
          <Button size="sm" variant="ghost" onClick={onWithdraw} data-testid="integration-request-withdraw">
            <Undo2 size={14} aria-hidden /> {t('integrations.requests.withdraw')}
          </Button>
        </div>
      )}
    </li>
  )
}

/** Fill in the service and pick the member; once sent, the link to pass on. */
function RequestDialog({ users, onClose, onSent }: { users: User[]; onClose: () => void; onSent: (r: IntegrationRequest) => void }) {
  const t = useT()
  const locale = useLocale()
  const [f, setF] = useState<RequestForm>(() => emptyRequestForm('mcp'))
  const [touched, setTouched] = useState<Partial<Record<RequestField, boolean>>>({})
  const [submitted, setSubmitted] = useState(false)
  const [server, setServer] = useState<Partial<Record<RequestField, string | null>>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<IntegrationRequest | null>(null)
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
      setSent(r)
    } catch (e) {
      const fields = serverFieldErrors(e, REQUEST_FIELD_OF)
      setServer(fields)
      if (!Object.keys(fields).length) setError(errorText(e, locale, t('error.network')))
      else focusInvalid()
    } finally {
      setBusy(false)
    }
  }

  if (sent) {
    return (
      <Modal open onClose={onClose} width={520} title={t('integrations.request.sentTitle')} footer={<Button variant="primary" onClick={onClose}>{t('common.close')}</Button>}>
        <div className="space-y-3 text-sm" data-testid="integration-request-sent">
          <p>{t('integrations.request.sent', { user: sent.user.name, name: sent.name })}</p>
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted">{t('integrations.request.link')}</p>
            <div className="flex items-center gap-2 rounded-lg border border-line bg-subtle px-3 py-2">
              <code className="min-w-0 flex-1 font-mono text-xs break-all select-all" data-testid="integration-request-link">{sent.link}</code>
              <CopyButton text={sent.link} label={t('integrations.requests.copyLink')} />
            </div>
            <p className="text-xs text-muted">{t('integrations.request.linkHint', { user: sent.user.name })}</p>
          </div>
        </div>
      </Modal>
    )
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
