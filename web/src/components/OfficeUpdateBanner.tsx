// "새 버전 x.y.z가 있어요 — 지금 업데이트 / 팀의 업데이트 시간에 자동" for owners and admins in office mode (docs/OFFICE.md
// "자동 업데이트"). Members never ask for it (the endpoint is admin-only). Dismissed per version on this browser.
// Kept current: read again every 5 minutes, when the tab comes back into view, when the update card loads a status
// (lib/officeUpdate.ts shareOfficeStatus), and once the server answers with a new version; hidden meanwhile, since
// the page then says "A new version is ready. Reload" and this status is from before the update.
import { Sparkles, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { OfficeUpdateStatus } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { bannerFor, dismissedVersion, dismissVersion, onOfficeStatus, turnDate } from '../lib/officeUpdate'
import { useLocale, useT } from '../i18n'
import { isAdmin, useMe } from '../store/session'
import { useUi } from '../store/ui'
import { Tooltip } from './Tooltip'

export default function OfficeUpdateBanner() {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const navigate = useNavigate()
  const admin = isAdmin(me)
  const [status, setStatus] = useState<OfficeUpdateStatus | null>(null)
  const [dismissed, setDismissed] = useState(dismissedVersion)
  const updateReady = useUi((s) => s.updateReady)
  useEffect(() => {
    if (!admin) return
    let gone = false
    const load = () => api.call(API.officeUpdateStatus).then((s) => !gone && setStatus(s), () => {})
    void load()
    const id = setInterval(load, 5 * 60_000)
    const visible = () => { if (document.visibilityState === 'visible') void load() }
    document.addEventListener('visibilitychange', visible)
    const off = onOfficeStatus((s) => !gone && setStatus(s))
    return () => { gone = true; clearInterval(id); document.removeEventListener('visibilitychange', visible); off() }
  }, [admin, updateReady])
  const b = bannerFor(me, status, dismissed, updateReady)
  if (!b) return null
  return (
    <div role="status" className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-accent-soft px-3 py-1.5 text-center text-xs font-medium text-accent-text" data-testid="office-update-banner">
      <Sparkles size={14} aria-hidden />
      <span>{t('officeUpdate.banner', { version: b.version })}</span>
      <button type="button" className="underline underline-offset-2" onClick={() => navigate('/admin/system')}>
        {t('officeUpdate.now')}
      </button>
      {b.turn?.kind === 'never' ? <span className="text-muted">{t('officeUpdate.bannerNever')}</span>
        : b.turn ? <span className="text-muted">{t('officeUpdate.bannerTurn', { date: turnDate(b.turn.date, locale), window: b.turn.window, zone: b.turn.zone })}</span>
        : b.nightly && <span className="text-muted">{t('officeUpdate.bannerNightly', b.nightly)}</span>}
      <Tooltip label={t('common.close')}>
        <button
          type="button"
          aria-label={t('common.close')}
          className="rounded p-0.5 hover:bg-hover"
          onClick={() => { dismissVersion(b.version); setDismissed(b.version) }}
        >
          <X size={13} aria-hidden />
        </button>
      </Tooltip>
    </div>
  )
}
