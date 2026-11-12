// "Ask admin to add it" (shared/src/api/service-requests.ts): on the page of an app the team has not set up (Google
// Drive, Gmail, Google Calendar, Google Docs, Google Sheets), a member asks the owner and the admins to add it, like an
// app request in Slack. It takes the place of the Connect button that could not work and of the "not set up" line. After
// the tap, and whenever the page is opened again while the request is open, it says "Request sent" (one word for it:
// QA final); the server keeps one open request per app, so nothing is sent twice. Its card in the list says so too. Members never see who the
// admins are: the words say "admin" and the answers name nobody. Since QA TC-133 every service of the app's list can be
// asked for too, and "Cancel request" under the status takes the member's own request back.
import { Check } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { API, isRequestableService, type RequestableService } from '@mycel/shared/api'
import { api, isApiError } from '../../lib/api'
import { useT } from '../../i18n'
import { Button } from '../ui'

export type AskState = 'none' | 'sent' | 'already'

/** A member's asks, kept by the Connectors layout so the list's cards and the app's page agree. `admin`: owners and
 * admins have none (they set the app up themselves) and the server is not asked. */
export function useServiceAsks(admin: boolean) {
  const t = useT()
  const [open, setOpen] = useState<Set<RequestableService> | null>(null)
  /** what a tap here answered (sent, or already when another window had asked) */
  const [answered, setAnswered] = useState<Partial<Record<RequestableService, 'sent' | 'already'>>>({})
  const [busy, setBusy] = useState<RequestableService | null>(null)
  const [error, setError] = useState<{ service: RequestableService; text: string } | null>(null)
  const life = useRef(0)
  useEffect(() => () => { life.current++ }, [])
  const load = useCallback(async (): Promise<number | null> => {
    if (admin) { setOpen(new Set()); return 0 }
    const g = life.current
    // an older server has no requests: the pages work as before (no button is offered without the list)
    try {
      const r = await api.call(API.myServiceRequests)
      if (g !== life.current) return null
      const now = new Set(r.items.map((x) => x.service))
      setOpen(now)
      // what a tap answered holds only while the request is open (an app added, then taken away again, asks anew)
      setAnswered((a) => Object.fromEntries(Object.entries(a).filter(([k]) => now.has(k as RequestableService))))
      return now.size
    } catch { if (g === life.current) setOpen((s) => s ?? null); return null }
  }, [admin])
  useEffect(() => { void load() }, [load])
  const stateOf = useCallback((s: RequestableService): AskState => answered[s] ?? (open?.has(s) ? 'already' : 'none'), [answered, open])
  /** `name`: the app's name for the words; `onChanged`: the app's state is not what the page showed (it was added
   * meanwhile, or turned off): the page reads it again */
  const ask = async (service: RequestableService, name: string, onChanged?: () => void) => {
    if (busy) return
    const g = life.current
    setBusy(service); setError(null)
    try {
      const r = await api.call(API.askService, { body: { service } })
      if (g !== life.current) return
      setAnswered((a) => ({ ...a, [service]: r.state }))
      setOpen((s) => new Set([...(s ?? []), service]))
    } catch (e) {
      if (g !== life.current) return
      const reason = isApiError(e) ? e.body.params?.reason : undefined
      if (reason === 'can_connect' || reason === 'not_requestable') onChanged?.()
      setError({ service, text: reason === 'rate_limited' ? t('serviceRequest.tooMany') : reason === 'can_connect' ? t('serviceRequest.canConnect', { name })
        : reason === 'not_requestable' ? t('serviceRequest.notRequestable', { name }) : t('serviceRequest.failed') })
    } finally { if (g === life.current) setBusy(null) }
  }
  /** take my own open request back: the page offers the ask again */
  const withdraw = async (service: RequestableService) => {
    if (busy) return
    const g = life.current
    setBusy(service); setError(null)
    try {
      await api.call(API.withdrawService, { params: { service } })
      if (g !== life.current) return
      setAnswered((a) => { const { [service]: _, ...rest } = a; return rest })
      setOpen((s) => new Set([...(s ?? [])].filter((x) => x !== service)))
    } catch {
      if (g === life.current) setError({ service, text: t('serviceRequest.withdrawFailed') })
    } finally { if (g === life.current) setBusy(null) }
  }
  /** `reload`: the asks again; how many are open now (null when they could not be read) */
  return { ready: open !== null, open: open?.size ?? 0, stateOf, ask, withdraw, busy, error, reload: load }
}
export type ServiceAsks = ReturnType<typeof useServiceAsks>

/** The page's action: the button, or once asked what happened, in the same place. Focus stays here after the tap. */
export function AskAdminAction({ state, busy, onAsk, onWithdraw }: { state: AskState; busy: boolean; onAsk: () => void; onWithdraw?: () => void }) {
  const t = useT()
  const status = useRef<HTMLSpanElement>(null)
  const tapped = useRef(false)
  // the button is gone with the tap: the keyboard (and a screen reader) lands on what it says now
  useEffect(() => { if (state !== 'none' && tapped.current) status.current?.focus({ preventScroll: true }) }, [state])
  if (state === 'none') return (
    <Button variant="primary" busy={busy} onClick={() => { tapped.current = true; onAsk() }} data-testid="service-ask">{t('serviceRequest.ask')}</Button>
  )
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span ref={status} tabIndex={-1} role="status" className="flex items-center gap-1.5 rounded-lg px-1 text-sm font-medium text-ok focus:outline-none" data-testid="service-asked" data-state={state}>
        {/* one word for an open request, whether it was sent just now or before (QA final) */}
        <Check size={16} aria-hidden /> {t('serviceRequest.sent')}
      </span>
      {onWithdraw && (
        <button type="button" disabled={busy} className="touch-hit text-sm text-muted underline underline-offset-2 hover:text-ink disabled:opacity-60 max-md:min-h-11" onClick={() => { tapped.current = false; onWithdraw() }} data-testid="service-withdraw">
          {t('serviceRequest.withdraw')}
        </button>
      )}
    </span>
  )
}

/** A listed service's page (QA TC-133), for a member whose team has no connection to it they may use. `inline`: they
 * may connect their own (Connect stays the page's action), so the ask for the team's sits under it as one line;
 * otherwise the ask is the action (`AskAdminAction`) and this shows only what follows: when they will hear, and why a
 * tap did not go through. */
export function ListedAsk({ asks, service, name, inline }: { asks: ServiceAsks; service: RequestableService; name: string; inline: boolean }) {
  const t = useT()
  const state = asks.stateOf(service)
  const error = asks.error?.service === service ? asks.error.text : null
  return (
    <div className="mb-4 space-y-1.5" data-testid="service-ask-listed">
      {inline && state === 'none' && (
        <p className="text-sm text-muted">
          {t('serviceRequest.teamLine', { name })}{' '}
          <button type="button" disabled={asks.busy === service} className="touch-hit font-medium text-accent-text underline underline-offset-2 disabled:opacity-60 max-md:min-h-11" onClick={() => void asks.ask(service, name)} data-testid="service-ask">
            {t('serviceRequest.ask')}
          </button>
        </p>
      )}
      {inline && state !== 'none' && <AskAdminAction state={state} busy={asks.busy === service} onAsk={() => void asks.ask(service, name)} onWithdraw={() => void asks.withdraw(service)} />}
      {state !== 'none' && <p className="text-sm text-muted" data-testid="service-asked-note">{t('serviceRequest.waiting', { name })}</p>}
      {error && <p role="alert" className="text-sm text-warn" data-testid="service-ask-error">{error}</p>}
    </div>
  )
}

/** Which app of the Connectors page a member may ask for, by its page's id (none for another id). */
export const askable = (id: string): RequestableService | null => (isRequestableService(id) ? id : null)
