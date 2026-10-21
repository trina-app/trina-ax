// "새 버전 x.y.z가 있어요 — 지금 업데이트 / 오늘 밤 3시에 자동" for owners and admins in office mode (docs/OFFICE.md
// "자동 업데이트"). Members never ask for it (the endpoint is admin-only). Dismissed per version on this browser.
import { Sparkles, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { OfficeUpdateStatus } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { bannerFor, dismissedVersion, dismissVersion } from '../lib/officeUpdate'
import { useT } from '../i18n'
import { isAdmin, useMe } from '../store/session'

export default function OfficeUpdateBanner() {
  const t = useT()
  const me = useMe()
  const navigate = useNavigate()
  const admin = isAdmin(me)
  const [status, setStatus] = useState<OfficeUpdateStatus | null>(null)
  const [dismissed, setDismissed] = useState(dismissedVersion)
  useEffect(() => {
    if (!admin) return
    let gone = false
    const load = () => api.call(API.officeUpdateStatus).then((s) => !gone && setStatus(s), () => {})
    void load()
    const id = setInterval(load, 30 * 60_000)
    return () => { gone = true; clearInterval(id) }
  }, [admin])
  const b = bannerFor(me, status, dismissed)
  if (!b) return null
  return (
    <div role="status" className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-accent-soft px-3 py-1.5 text-center text-xs font-medium text-accent" data-testid="office-update-banner">
      <Sparkles size={14} aria-hidden />
      <span>{t('officeUpdate.banner', { version: b.version })}</span>
      <button type="button" className="underline underline-offset-2" onClick={() => navigate('/admin/system')}>
        {t('officeUpdate.now')}
      </button>
      {b.nightly && <span className="text-muted">{t('officeUpdate.bannerNightly', { time: b.nightly })}</span>}
      <button
        type="button"
        aria-label={t('common.close')}
        className="rounded p-0.5 hover:bg-hover"
        onClick={() => { dismissVersion(b.version); setDismissed(b.version) }}
      >
        <X size={13} aria-hidden />
      </button>
    </div>
  )
}
