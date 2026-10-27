// The operator's notices on the hosted service (notices.json, GET /api/managed/notices): one line each under the other
// banners. info and warn can be closed on this browser; critical ones (e.g. "support has access until …") stay.
// A self-hosted server has no notices file, so nothing shows. lib/managedNotices.ts holds the rules.
import { AlertTriangle, Info, OctagonAlert, X } from 'lucide-react'
import clsx from 'clsx'
import { useEffect, useState } from 'react'
import type { ManagedNotice } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { dismissNotice, dismissedNotices, visibleNotices } from '../lib/managedNotices'
import { safeHref } from '../lib/safeLinks'
import { useT } from '../i18n'
import { useMe } from '../store/session'

const RELOAD_MS = 5 * 60_000
const TONE = {
  info: 'bg-accent-soft text-accent',
  warn: 'bg-warn-soft text-warn',
  critical: 'bg-danger-soft text-danger',
} as const
const ICON = { info: Info, warn: AlertTriangle, critical: OctagonAlert } as const

export default function ManagedNoticesBanner() {
  const t = useT()
  const me = useMe()
  const [items, setItems] = useState<ManagedNotice[] | null>(null)
  const [dismissed, setDismissed] = useState(dismissedNotices)
  const signedIn = !!me
  useEffect(() => {
    if (!signedIn) return
    let gone = false
    // an older server without the endpoint answers 404: no banner
    const load = () => api.call(API.managedNotices).then((r) => !gone && setItems(r.items), () => {})
    void load()
    const id = setInterval(load, RELOAD_MS)
    return () => { gone = true; clearInterval(id) }
  }, [signedIn])
  const shown = visibleNotices(items, dismissed)
  if (!shown.length) return null
  return (
    <div data-testid="managed-notices">
      {shown.map((n) => {
        const Icon = ICON[n.level]
        const href = n.link ? safeHref(n.link) : null
        return (
          <div key={n.id} role={n.level === 'critical' ? 'alert' : 'status'} className={clsx('flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-3 py-1.5 text-center text-xs font-medium', TONE[n.level])} data-notice={n.id}>
            <Icon size={14} className="shrink-0" aria-hidden />
            <span>{n.text}</span>
            {href && (
              <a className="underline underline-offset-2" href={href} target="_blank" rel="noreferrer">
                {t('notices.more')}
              </a>
            )}
            {n.dismissible && (
              <button type="button" aria-label={t('common.close')} className="rounded p-0.5 hover:bg-hover" onClick={() => setDismissed(dismissNotice(n.id, dismissed))}>
                <X size={13} aria-hidden />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
