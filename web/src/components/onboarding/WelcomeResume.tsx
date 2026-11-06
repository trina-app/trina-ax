// Home's quiet setup row on a phone (docs/DECISIONS.md "W5 — Onboarding v5"): "설정 이어서 하기 · 2/4" under the message
// box, the same words and count as the setup row in the ☰ drawer (SetupRow.tsx), which hides on Home so the two never
// show together. On a computer the sidebar's setup row replaces it (Home shows the goal card). Nothing shows for anyone
// else, before the steps were started, or while no AI answers the owner (Home's connect card stands in its place, so the
// row never leads back to the AI step). On a landing the owner goes to the steps themselves (useResumeOnLanding).
import { Sparkles, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { doneCount, markStepsSeen, resumesOnLanding, showResume, stepsSeen, stepTotal } from '../../lib/welcome'
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
  // on a phone 내 스킬 가져오기 put off for a computer is not something to resume (docs/DECISIONS.md "SK")
  const computer = !useMediaQuery('(max-width: 767.98px)')
  useEffect(() => {
    if (owner) void useWelcome.getState().load().catch(() => {})
  }, [owner])
  if (!owner || !loaded || !progress || !showResume(progress, computer)) return null
  const n = doneCount(progress, aiReady, computer)
  // the step total comes from lib/welcome.ts (the same number as the steps' own progress bar), never a number here
  const total = stepTotal(progress, aiReady)
  const hide = () => void useWelcome.getState().update({ dismissed: true }).then(
    () => toast({ level: 'info', text: t('setupRow.hidden'), action: { label: t('common.undo'), run: () => void useWelcome.getState().update({ dismissed: false }).catch(() => toast({ level: 'error', text: t('error.network') })) } }),
    () => toast({ level: 'error', text: t('error.network') }),
  )
  return (
    // a quiet 44px row under the message box (Home places it there), no frame, like the goal's
    <div className="flex items-center gap-1" data-testid="welcome-resume">
      <Link to="/welcome" className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-3 py-2 hover:bg-hover" data-testid="welcome-resume-link">
        <Sparkles size={16} className="shrink-0 text-accent-text" aria-hidden />
        <span className="min-w-0 flex-1 text-sm font-medium text-ink" data-testid="welcome-resume-text">
          {t('setupRow.resume')} <span className="font-normal text-faint tabular-nums"><span aria-hidden>· </span>{n}/{total}</span>
        </span>
      </Link>
      <IconButton label={t('setupRow.hide')} onClick={hide} className="touch-hit" data-testid="welcome-resume-hide">
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
