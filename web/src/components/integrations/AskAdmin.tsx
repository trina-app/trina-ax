// "Ask admin to add it" (shared/src/api/service-requests.ts): on the page of an app the team has not set up (Google
// Drive, Gmail, Google Calendar, Google Docs, Google Sheets), a member asks the owner and the admins to add it, like an
// app request in Slack. It takes the place of the Connect button that could not work and of the "not set up" line. After
// the tap the button says "Request sent"; opened again (or tapped again from another window) "Already asked": the server
// keeps one open request per app, so nothing is sent twice. Its card in the list says "Asked". Members never see who the
// admins are: the words say "admin" and the answers name nobody.
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
  /** `reload`: the asks again; how many are open now (null when they could not be read) */
  return { ready: open !== null, open: open?.size ?? 0, stateOf, ask, busy, error, reload: load }
}
export type ServiceAsks = ReturnType<typeof useServiceAsks>

/** The page's action: the button, or once asked what happened, in the same place. Focus stays here after the tap. */
export function AskAdminAction({ state, busy, onAsk }: { state: AskState; busy: boolean; onAsk: () => void }) {
  const t = useT()
  const status = useRef<HTMLSpanElement>(null)
  const tapped = useRef(false)
  // the button is gone with the tap: the keyboard (and a screen reader) lands on what it says now
  useEffect(() => { if (state !== 'none' && tapped.current) status.current?.focus({ preventScroll: true }) }, [state])
  if (state === 'none') return (
    <Button variant="primary" busy={busy} onClick={() => { tapped.current = true; onAsk() }} data-testid="service-ask">{t('serviceRequest.ask')}</Button>
  )
  return (
    <span ref={status} tabIndex={-1} role="status" className="flex items-center gap-1.5 rounded-lg px-1 text-sm font-medium text-ok focus:outline-none" data-testid="service-asked" data-state={state}>
      <Check size={16} aria-hidden /> {t(state === 'sent' ? 'serviceRequest.sent' : 'serviceRequest.already')}
    </span>
  )
}

/** Which app of the Connectors page a member may ask for, by its page's id (none for another id). */
export const askable = (id: string): RequestableService | null => (isRequestableService(id) ? id : null)
