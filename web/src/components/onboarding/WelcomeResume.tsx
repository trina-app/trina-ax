// "시작 설정 이어하기 (1/2)" ("(1/3)" once the AI step was shown), on the owner's Home until the welcome steps are
// finished or hidden (pages/Welcome.tsx). One slim row, the only thing at the top of Home while it shows
// (docs/DECISIONS.md "Y — Home shows one thing at a time"; Home decides: while no AI answers the owner, Home's connect
// card stands in its place, so the row never leads back to the AI step). Nothing shows for anyone else, or before the
// steps were started.
import { Sparkles, X } from 'lucide-react'
import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { doneCount, showResume, stepTotal } from '../../lib/welcome'
import { useT } from '../../i18n'
import { useAiAccess } from '../../store/aiAccess'
import { isOwner, useMe } from '../../store/session'
import { toast } from '../../store/ui'
import { useWelcome } from '../../store/welcome'
import { IconButton } from '../ui'

export function WelcomeResume() {
  const t = useT()
  const owner = isOwner(useMe())
  const loaded = useWelcome((s) => s.loaded)
  const progress = useWelcome((s) => s.progress)
  // the AI step counts while no AI answers the owner (the same count as the steps' own progress bar)
  const ai = useAiAccess()
  const aiReady = !ai.loaded || ai.usable
  useEffect(() => {
    if (owner) void useWelcome.getState().load().catch(() => {})
  }, [owner])
  if (!owner || !loaded || !showResume(progress)) return null
  const n = doneCount(progress, aiReady)
  // the step total comes from lib/welcome.ts (the same number as the steps' own progress bar), never a number here
  const total = stepTotal(progress, aiReady)
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
