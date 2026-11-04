// Scheduled tasks nobody confirmed on their card are paused until their owner checks them again (docs/DECISIONS.md
// "Scheduled tasks nobody confirmed"). One line under the other banners while any of the person's own tasks waits,
// with the way to Scheduled tasks in the sidebar ("다시 확인" on the task's page). Not shown on that screen itself.
import { ShieldAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, API } from '../lib/api'
import { useT } from '../i18n'
import { notificationsChanged, reloadAsked, schedulesChanged } from '../store/live'
import { useMe } from '../store/session'
import { useRealPath } from '../lib/realPath'

const RELOAD_MS = 5 * 60_000

export default function ScheduleReviewBanner() {
  const t = useT()
  const me = useMe()
  const pathname = useRealPath()
  const [n, setN] = useState(0)
  const signedIn = !!me
  useEffect(() => {
    if (!signedIn) return
    let gone = false
    // an older server has no needsReview: nothing waits
    const load = () => api.call(API.listSchedules).then((r) => { if (!gone) setN(r.items.filter((s) => s.needsReview && !s.enabled && !s.resumeBlockedReason).length) }, () => {})
    void load()
    const id = setInterval(load, RELOAD_MS)
    const offs = [notificationsChanged.on(() => void load()), schedulesChanged.on(() => void load()), reloadAsked.on(() => void load())]
    return () => { gone = true; clearInterval(id); for (const off of offs) off() }
  }, [signedIn])
  if (!n || pathname.startsWith('/scheduled')) return null
  return (
    <div role="status" className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-warn-soft px-3 py-1.5 text-center text-xs font-medium text-warn" data-testid="schedule-review-banner">
      <ShieldAlert size={14} className="shrink-0" aria-hidden />
      <span>{t('schedules.reviewBanner', { n })}</span>
      <Link className="underline underline-offset-2" to="/scheduled">{t('schedules.reviewOpen')}</Link>
    </div>
  )
}
