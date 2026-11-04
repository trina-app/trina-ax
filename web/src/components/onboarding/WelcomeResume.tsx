// "시작 설정 이어하기 (1/2)" on the owner's Home until the welcome steps are finished or hidden (pages/Welcome.tsx).
// One slim row, the only thing at the top of Home while it shows (docs/DECISIONS.md "Y — Home shows one thing at a
// time"; Home decides). Nothing shows for anyone else, or before the steps were started.
import { Sparkles, X } from 'lucide-react'
import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import type { WelcomeProgress } from '@mycel/shared/api'
import { doneCount, showResume } from '../../lib/welcome'
import { useT } from '../../i18n'
import { isOwner, useMe } from '../../store/session'
import { toast } from '../../store/ui'
import { useWelcome } from '../../store/welcome'
import { IconButton } from '../ui'

/** How many steps the entry counts: what lib/welcome.ts counts when every step is done (the steps decide, not this row). */
export const stepTotal = (p: WelcomeProgress) =>
  doneCount({ ...p, steps: Object.fromEntries(Object.keys(p.steps).map((s) => [s, 'done'])) as WelcomeProgress['steps'] })

export function WelcomeResume() {
  const t = useT()
  const owner = isOwner(useMe())
  const loaded = useWelcome((s) => s.loaded)
  const progress = useWelcome((s) => s.progress)
  useEffect(() => {
    if (owner) void useWelcome.getState().load().catch(() => {})
  }, [owner])
  if (!owner || !loaded || !showResume(progress)) return null
  const n = doneCount(progress)
  const total = stepTotal(progress!)
  const hide = () => void useWelcome.getState().update({ dismissed: true }).catch(() => toast({ level: 'error', text: t('error.network') }))
  return (
    <div className="mb-6 flex items-center gap-1 rounded-xl border border-line pr-1.5" data-testid="welcome-resume">
      <Link to="/welcome" className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3.5 py-3 hover:bg-hover max-sm:min-h-12" data-testid="welcome-resume-link">
        <Sparkles size={16} className="shrink-0 text-accent-text" aria-hidden />
        {/* the counted steps done: only the invite is left, say that rather than "(2/2)" */}
        <span className="min-w-0 flex-1 text-sm font-medium text-ink">{n >= total ? t('welcome.resume.inviteLeft') : t('home.setupResume', { n, total })}</span>
      </Link>
      <IconButton label={t('welcome.resume.hide')} onClick={hide} data-testid="welcome-resume-hide">
        <X size={15} />
      </IconButton>
    </div>
  )
}

export default WelcomeResume
