// "시작 설정 이어하기 (1/4)" ("(1/5)" once the AI step was shown; "남은 일: 내 스킬 가져오기" when only that is left, put
// off on a phone: docs/DECISIONS.md "K"), on the owner's Home until the welcome steps are
// finished or hidden (pages/Welcome.tsx). One slim row (on phones a frameless row under the message box), the only thing at the top of Home while it shows
// (docs/DECISIONS.md "Y — Home shows one thing at a time"; Home decides: while no AI answers the owner, Home's connect
// card stands in its place, so the row never leads back to the AI step). Nothing shows for anyone else, or before the
// steps were started. On a landing the owner goes to the steps themselves (useResumeOnLanding).
import { Sparkles, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { doneCount, markStepsSeen, resumeLeft, resumesOnLanding, showResume, stepsSeen, stepTotal } from '../../lib/welcome'
import { useT } from '../../i18n'
import { useAiAccess } from '../../store/aiAccess'
import { isOwner, useMe } from '../../store/session'
import { toast } from '../../store/ui'
import { useWelcome } from '../../store/welcome'
import { IconButton, useMediaQuery } from '../ui'

export function WelcomeResume() {
  const t = useT()
  const owner = isOwner(useMe())
  const loaded = useWelcome((s) => s.loaded)
  const progress = useWelcome((s) => s.progress)
  // the AI step counts while no AI answers the owner (the same count as the steps' own progress bar)
  const ai = useAiAccess()
  const aiReady = !ai.loaded || ai.usable
  // on a phone 내 스킬 가져오기 put off for a computer is not something to resume (docs/DECISIONS.md "K")
  const computer = !useMediaQuery('(max-width: 767.98px)')
  useEffect(() => {
    if (owner) void useWelcome.getState().load().catch(() => {})
  }, [owner])
  if (!owner || !loaded || !progress || !showResume(progress, computer)) return null
  const n = doneCount(progress, aiReady)
  // the step total comes from lib/welcome.ts (the same number as the steps' own progress bar), never a number here
  const total = stepTotal(progress, aiReady)
  const left = n >= total ? 'invite' : resumeLeft(progress, aiReady)
  const hide = () => void useWelcome.getState().update({ dismissed: true }).catch(() => toast({ level: 'error', text: t('error.network') }))
  return (
    // phones (below 768px): a quiet 44px row under the message box (Home places it there), no frame, like the goal's
    <div className="mb-6 flex items-center gap-1 rounded-xl border border-line pr-1.5 max-md:mb-0 max-md:border-0 max-md:pr-0" data-testid="welcome-resume">
      <Link to="/welcome" className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3.5 py-3 hover:bg-hover max-md:min-h-11 max-md:gap-2.5 max-md:rounded-lg max-md:px-3 max-md:py-2" data-testid="welcome-resume-link">
        <Sparkles size={16} className="shrink-0 text-accent-text" aria-hidden />
        {/* the counted steps done: only the invite is left, say that rather than "(4/4)"; only 내 스킬 left: say so */}
        <span className="min-w-0 flex-1 text-sm font-medium text-ink" data-testid="welcome-resume-text">
          {left === 'invite' ? t('welcome.resume.inviteLeft') : left === 'skills' ? t('welcome.resume.skillsLeft') : t('home.setupResume', { n, total })}
        </span>
      </Link>
      <IconButton label={t('welcome.resume.hide')} onClick={hide} className="touch-hit" data-testid="welcome-resume-hide">
        <X size={15} />
      </IconButton>
    </div>
  )
}

/**
 * Coming back resumes the steps (lib/welcome.ts, docs/DECISIONS.md "W4"): on a landing (`landing`: the tab opened here,
 * or a sign-in sent it here), an owner whose steps are started, unfinished and not hidden goes to /welcome, which opens
 * at its resume step; once per tab session (the steps mark it), never for anyone else. Decided when the page opens: a
 * later change of the progress never sends anyone away. True while that is being decided, so the page shows nothing
 * first (a failed read decides "stay").
 */
export function useResumeOnLanding(landing: boolean): boolean {
  const me = useMe()
  const navigate = useNavigate()
  const userId = me?.user.id ?? ''
  const [armed] = useState(() => landing && isOwner(me) && !stepsSeen(userId))
  const computer = !useMediaQuery('(max-width: 767.98px)')
  const loaded = useWelcome((s) => s.loaded)
  const progress = useWelcome((s) => s.progress)
  useEffect(() => {
    if (armed) void useWelcome.getState().load().catch(() => {})
  }, [armed])
  const go = armed && loaded && resumesOnLanding(progress, computer)
  useEffect(() => {
    if (!go) return
    markStepsSeen(userId)
    navigate('/welcome', { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [go])
  return armed && (!loaded || go)
}

export default WelcomeResume
