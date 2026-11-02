// Settings › External services: the services an admin asked this member to connect as their own connection
// (Admin › External services, RequestDialog.tsx). The member connects one with their own key or signs in at the
// service; it becomes their personal connection, through the same create path as one they add themselves, so the admin
// never sees the key. Or they decline it. A link the admin sent (?request=<id>) opens the request here, or says what
// became of it. The admin chooses the address, so the member is told plainly where their key or sign-in goes (the
// host, in bold) before they enter it. Server: server/src/integrations/connections/requests.ts.
import { Inbox, LogIn, Plug } from 'lucide-react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { Integration, IntegrationRequest, WritePolicy } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { requestIdFrom, serverFieldErrors } from '../../lib/integrations'
import { mobileApp } from '../../lib/mobile'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { notificationsChanged } from '../../store/live'
import { toast } from '../../store/ui'
import { Button, Field, Modal, confirmDialog, inputCls } from '../ui'
import { Choices, Warning } from './IntegrationDialog'
import { reserveSignInWindow } from './IntegrationRow'

const ENDED: Record<Exclude<IntegrationRequest['state'], 'waiting'>, MessageKey> = {
  connected: 'integrations.asked.ended.connected',
  declined: 'integrations.asked.ended.declined',
  withdrawn: 'integrations.asked.ended.withdrawn',
  expired: 'integrations.asked.ended.expired',
}

/** The waiting requests, above the member's own connections. `onConnected`: a connection was made from one (a sign-in
 * next: in the window reserved during the click, null when none could open). `version` changes: load again. */
export function MyRequests({ onConnected, version }: { onConnected: (i: Integration, signIn: { window: Window | null } | null) => void; version: number }) {
  const t = useT()
  const locale = useLocale()
  const location = useLocation()
  const navigate = useNavigate()
  const [items, setItems] = useState<IntegrationRequest[]>([])
  const [open, setOpen] = useState<IntegrationRequest | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const gen = useRef(0)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  const load = async () => {
    const g = ++gen.current
    try {
      const r = await api.call(API.listIntegrationRequests)
      if (g === gen.current) setItems(r.items)
    } catch {
      // an older server has no requests; the rest of the page works without them
    }
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])
  // a new request comes with an inbox entry (notifications.changed): the list follows while the page is open
  useEffect(() => notificationsChanged.on(() => void load()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [])
  // a link from the admin or the inbox: open that request, or say what became of it
  const linked = requestIdFrom(location.search)
  useEffect(() => {
    if (!linked) return
    // the address loses ?request= at once (a reload does not open it again); the answer still lands here
    navigate({ pathname: location.pathname, search: '' }, { replace: true })
    api.call(API.getIntegrationRequest, { params: { id: linked } }).then(
      (r) => {
        if (!alive.current) return
        if (r.state === 'waiting') { setNote(null); setOpen(r) } else setNote(t(ENDED[r.state], { name: r.name }))
      },
      (e) => { if (alive.current) setNote(isApiError(e, 'not_found') ? t('integrations.asked.notFound') : errorText(e, locale, t('error.network'))) },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked])

  const decline = async (r: IntegrationRequest) => {
    const ok = await confirmDialog({ title: t('integrations.asked.declineTitle', { name: r.name }), body: t('integrations.asked.declineBody'), confirm: t('integrations.asked.decline'), danger: true })
    if (!ok) return false
    try {
      await api.call(API.declineIntegrationRequest, { params: { id: r.id }, body: {} })
      toast({ level: 'success', text: t('integrations.asked.declined') })
      return true
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
      return false
    } finally {
      void load()
    }
  }

  if (!items.length && !note && !open) return null
  return (
    <section aria-labelledby={items.length ? 'integrations-asked' : undefined} data-testid="integrations-asked">
      {note && (
        <p role="status" className="mb-3 rounded-xl bg-subtle px-3 py-2 text-sm text-muted" data-testid="integrations-asked-note">
          {note}
        </p>
      )}
      {items.length > 0 && (
        <>
          <h3 id="integrations-asked" className="text-sm font-semibold">
            {t('integrations.asked.title')}
          </h3>
          <p className="mt-0.5 mb-2 text-xs text-muted">{t('integrations.asked.hint')}</p>
          <ul className="divide-y divide-line rounded-xl border border-accent/40 bg-accent-soft/40" data-testid="integrations-asked-list">
            {items.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3" data-testid="integration-asked" data-name={r.name}>
                <Inbox size={16} className="mt-0.5 shrink-0 text-faint" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                    <span className="font-medium break-words">{r.name}</span>
                    <span className="text-xs text-muted">{t(r.kind === 'mcp' ? 'integrations.kind.mcp' : 'integrations.kind.http')}</span>
                  </p>
                  <p className="mt-0.5 text-xs break-all text-faint">{r.url}</p>
                  <p className="mt-1 text-xs text-muted">{t('integrations.asked.by', { name: r.requestedBy?.name ?? '?', date: formatDateTime(r.expiresAt, locale) })}</p>
                </div>
                <div className="flex flex-wrap items-center gap-1 max-sm:w-full max-sm:pl-7">
                  <Button size="sm" variant="primary" onClick={() => setOpen(r)} data-testid="integration-asked-connect">
                    <Plug size={14} aria-hidden /> {t('integrations.asked.connect')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void decline(r)} data-testid="integration-asked-decline">
                    {t('integrations.asked.decline')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {open && (
        <AnswerDialog
          r={open}
          onClose={() => { setOpen(null); void load() }}
          onDecline={async () => { if (await decline(open)) setOpen(null) }}
          onConnected={(i, signIn) => {
            setOpen(null)
            void load()
            onConnected(i, signIn)
          }}
        />
      )}
    </section>
  )
}

/** A text with the host in bold wherever it names it: where the key or sign-in goes is what to check. */
function WithHost({ text, host }: { text: (host: string) => string; host: string }) {
  const MARK = '\u0000'
  const parts = text(MARK).split(MARK)
  return <>{parts.map((p, i) => <Fragment key={i}>{i > 0 && <strong className="font-semibold">{host}</strong>}{p}</Fragment>)}</>
}

/** What the admin filled in (fixed: that is what was asked for), then the member's key or a sign-in next, and what
 * the AI may change there. Saved as the member's own connection; they can change it afterwards like any other. */
function AnswerDialog({ r, onClose, onDecline, onConnected }: {
  r: IntegrationRequest
  onClose: () => void
  onDecline: () => void
  onConnected: (i: Integration, signIn: { window: Window | null } | null) => void
}) {
  const t = useT()
  const locale = useLocale()
  const [secret, setSecret] = useState('')
  const [policy, setPolicy] = useState<WritePolicy>('ask')
  const [submitted, setSubmitted] = useState(false)
  const [server, setServer] = useState<{ secret?: string | null; writePolicy?: string | null }>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const key = r.auth !== 'oauth'
  const host = new URL(r.url).host
  const phone = !!mobileApp()
  const signInNext = !key && !phone
  const keyError = server.secret !== undefined ? server.secret ?? t('integrations.error.field') : submitted && key && !secret.trim() ? t('integrations.error.key') : secret.trim().length > 8000 ? t('integrations.error.keyLong') : null

  const connect = async () => {
    setSubmitted(true)
    if (key && (!secret.trim() || secret.trim().length > 8000)) return
    // the sign-in window has to open during the click: reserve it now, send it to the service once the server answers
    const win = signInNext ? reserveSignInWindow() : null
    setBusy(true)
    setError(null)
    setServer({})
    try {
      const i = await api.call(API.completeIntegrationRequest, { params: { id: r.id }, body: { writePolicy: policy, ...(key ? { secret: secret.trim() } : {}) } })
      onConnected(i, signInNext ? { window: win } : null)
    } catch (e) {
      win?.close()
      const fields = serverFieldErrors(e, { secret: 'secret', writePolicy: 'writePolicy' } as const)
      setServer(fields)
      if (!Object.keys(fields).length) setError(errorText(e, locale, t('error.network')))
    } finally {
      setBusy(false)
    }
  }

  const rows: [string, string][] = [
    [t('integrations.field.kind'), t(r.kind === 'mcp' ? 'integrations.kind.mcp' : 'integrations.kind.http')],
    [t('integrations.field.url'), r.url],
    [t('integrations.field.auth'), t(key ? 'integrations.auth.key' : 'integrations.auth.oauth')],
    ...(r.auth === 'header' && r.authHeader ? [[t('integrations.field.headerName'), r.authHeader] as [string, string]] : []),
  ]
  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      title={t('integrations.asked.dialogTitle', { name: r.name })}
      footer={
        <>
          <Button variant="ghost" onClick={onDecline} data-testid="integration-answer-decline">
            {t('integrations.asked.decline')}
          </Button>
          <span className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void connect()} data-testid="integration-answer-connect">
            {signInNext ? <><LogIn size={14} aria-hidden /> {t('integrations.saveAndSignIn')}</> : t('integrations.asked.connect')}
          </Button>
        </>
      }
    >
      <form className="space-y-5" noValidate onSubmit={(e) => { e.preventDefault(); void connect() }} data-testid="integration-answer">
        <p className="text-sm">{t('integrations.asked.dialogIntro', { by: r.requestedBy?.name ?? '?' })}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border border-line px-3 py-2 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="min-w-0 break-all">{v}</dd>
            </div>
          ))}
        </dl>
        {r.notes && (
          <div className="text-xs">
            <p className="font-medium text-muted">{t('integrations.field.notes')}</p>
            <p className="mt-0.5 whitespace-pre-wrap break-words text-faint">{r.notes}</p>
          </div>
        )}
        <div data-testid="integration-answer-host-warning">
          <Warning>
            <WithHost host={host} text={(h) => t(key ? 'integrations.asked.sendsKey' : 'integrations.asked.sendsSignIn', { host: h, name: r.name })} />
          </Warning>
        </div>
        {key ? (
          <Field label={t('integrations.field.key')} hint={t('integrations.field.keyHint')} error={keyError}>
            <input className={inputCls} type="password" autoComplete="off" spellCheck={false} value={secret} data-autofocus onChange={(e) => { setSecret(e.target.value); setServer((s) => ({ ...s, secret: undefined })); setError(null) }} data-testid="integration-answer-key" />
          </Field>
        ) : (
          <p className="text-sm text-muted" data-testid="integration-answer-oauth-note">{t(phone ? 'integrations.signIn.phone' : 'integrations.signIn.next')}</p>
        )}
        <Choices<WritePolicy>
          legend={t('integrations.field.write')}
          value={policy}
          onChange={(p) => { setPolicy(p); setServer((s) => ({ ...s, writePolicy: undefined })) }}
          error={server.writePolicy !== undefined ? server.writePolicy ?? t('integrations.error.field') : null}
          options={(['ask', 'deny'] as const).map((p) => ({ value: p, label: t(`integrations.write.${p}`), desc: t(`integrations.write.${p}.desc`), testId: `integration-answer-write-${p}` }))}
        />
        <p className="text-xs text-faint">{t('integrations.asked.mineNote')}</p>
        {error && (
          <p role="alert" className="text-sm text-danger" data-testid="integration-answer-error">
            {error}
          </p>
        )}
        <button type="submit" hidden tabIndex={-1} aria-hidden />
      </form>
    </Modal>
  )
}
