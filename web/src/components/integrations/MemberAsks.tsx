// Admin › Connectors: what members asked to have added (QA TC-133; shared/src/api/service-requests.ts). One line per app
// or listed service with open requests: its logo and name, who asked ("Alice and 2 others asked"), Add (the usual setup:
// a Google one's page, a listed service's "Connect for the team") and Dismiss (closes the requests; nobody is told, they
// may ask again). Nothing when nobody asked, or on an older server.
import { useCallback, useEffect, useRef, useState } from 'react'
import { API, isGoogleRequestable, type RequestableService, type TeamServiceRequest } from '@mycel/shared/api'
import { api, errorText } from '../../lib/api'
import { builtInLogo, requestableName } from '../../lib/googleApps'
import { CONNECTORS, connectorLogo } from '../../lib/connectors'
import { useLocale, useT } from '../../i18n'
import { toast } from '../../store/ui'
import { Button } from '../ui'
import { LogoTile } from './ConnectorsView'

const logoOf = (s: RequestableService) => {
  if (isGoogleRequestable(s)) return builtInLogo(s)
  const c = CONNECTORS.find((x) => x.id === s)
  return c ? connectorLogo(c) : '/favicon.svg'
}

/** The open requests, read again when `version` changes (a connection was added). `undefined` is "not known yet": the
 * first known version is not a change (the page's own list arriving read them twice). */
export function useMemberAsks(version: unknown) {
  const [items, setItems] = useState<TeamServiceRequest[]>([])
  const load = useCallback(async () => {
    try { setItems((await api.call(API.teamServiceRequests)).items) } catch { setItems([]) }
  }, [])
  const seen = useRef<{ v: unknown } | null>(null)
  useEffect(() => {
    const before = seen.current
    seen.current = { v: version }
    if (before && before.v === undefined && version !== undefined) return
    void load()
  }, [load, version])
  return { items, setItems, reload: load }
}

export function MemberAsks({ asks, onAdd }: { asks: ReturnType<typeof useMemberAsks>; onAdd: (service: RequestableService) => void }) {
  const t = useT()
  const locale = useLocale()
  const [busy, setBusy] = useState<string | null>(null)
  if (!asks.items.length) return null
  const dismiss = async (s: RequestableService) => {
    setBusy(s)
    try {
      await api.call(API.dismissServiceRequests, { params: { service: s }, body: {} })
      asks.setItems((x) => x.filter((r) => r.service !== s))
      toast({ level: 'success', text: t('serviceRequest.admin.dismissed', { name: requestableName(s) }) })
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally { setBusy(null) }
  }
  return (
    <section aria-labelledby="member-asks-title" data-testid="member-asks">
      <h3 id="member-asks-title" className="mb-1 text-title-sm font-semibold text-ink">{t('serviceRequest.admin.title')}</h3>
      <ul className="-mx-2 divide-y divide-line">
        {asks.items.map((r) => {
          const name = requestableName(r.service)
          const who = r.askers.length > 1 ? t('serviceRequest.admin.more', { name: r.askers[0]!.name, n: r.askers.length - 1 }) : t('serviceRequest.admin.one', { name: r.askers[0]?.name ?? '' })
          return (
            <li key={r.service} className="flex flex-wrap items-center gap-3 px-2 py-2.5" data-testid="member-ask" data-service={r.service}>
              <LogoTile src={logoOf(r.service)} className="size-9" />
              <span className="min-w-0 flex-[1_1_10rem]">
                <span className="block truncate text-row font-medium">{name}</span>
                <span className="block truncate text-xs text-muted" title={r.askers.map((a) => a.name).join(', ')}>{who}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2 max-sm:w-full max-sm:justify-end">
                <Button size="sm" variant="ghost" busy={busy === r.service} onClick={() => void dismiss(r.service)} data-testid="member-ask-dismiss">{t('serviceRequest.admin.dismiss')}</Button>
                <Button size="sm" variant="primary" onClick={() => onAdd(r.service)} data-testid="member-ask-add">{t('serviceRequest.admin.add')}</Button>
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
