// Admin › Home, once (QA TC-4911, docs/decisions/20261118-run-code-skills-subagents.md): a team that had people before
// the dev environment came (migration 236) has it off, and its admins were never told. The owner and admins read in
// plain words what turning it on allows and that nothing changes until they do, with a link to the switch (Team
// settings › Dev environment). Shown while the server says so (GET /api/admin/dev-env `offer`: the setting was never
// saved since). Closed with ✕ or followed it never shows again for that person, on any device (prefs.devEnvOffer,
// PATCH /api/me), as FolderShareNotice.tsx. The switch's card says the same above the switch (DevEnvTeam.tsx).
import { TerminalSquare, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { DevEnvTeamResponse } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { useT } from '../../i18n'
import { isAdmin, useSession } from '../../store/session'
import { IconButton } from '../../components/ui'

/** the notice shows: the server offers it and the server can run the dev environment (a switch that cannot turn on is
 * no offer). Exported for its test. */
export const offerShown = (r: Pick<DevEnvTeamResponse, 'offer' | 'availability'> | null) => !!r?.offer && r.availability?.available !== false

export function DevEnvOfferNotice() {
  const t = useT()
  // only an owner or admin, on a server with the dev environment, who did not close it yet
  const state = useSession((s) => (s.status.kind === 'signed-in' && isAdmin(s.status.me) && s.status.me.server.devEnv ? s.status.me.user.prefs?.devEnvOffer ?? 'new' : null))
  const [r, setR] = useState<DevEnvTeamResponse | null>(null)
  const [gone, setGone] = useState(false)
  useEffect(() => {
    if (state !== 'new') return
    api.call(API.devEnvTeam).then(setR, () => setR(null))
  }, [state])
  if (state !== 'new' || gone || !offerShown(r)) return null
  const seen = () => {
    setGone(true)
    void useSession.getState().updatePrefs({ devEnvOffer: 'seen' }).catch(() => {})
  }
  return (
    <div className="flex items-start gap-2 rounded-lg border border-line bg-accent-soft/40 py-2 pr-1 pl-3" role="status" data-testid="admin-dev-env-offer">
      <TerminalSquare size={16} className="mt-0.5 shrink-0 text-accent-text" aria-hidden />
      <p className="min-w-0 flex-1 text-sm break-keep text-ink">
        <span className="font-medium">{t('adminHome.devEnvOffer')}</span>{' '}
        {t('devEnvOffer.body')}{' '}
        <Link to="/admin/settings#dev-env" onClick={seen} className="font-medium text-accent-text underline-offset-2 hover:underline" data-testid="admin-dev-env-offer-open">
          {t('adminHome.devEnvOfferOpen')}
        </Link>
      </p>
      <IconButton tip label={t('common.close')} className="touch-hit shrink-0" onClick={seen} data-testid="admin-dev-env-offer-close">
        <X size={14} aria-hidden />
      </IconButton>
    </div>
  )
}
