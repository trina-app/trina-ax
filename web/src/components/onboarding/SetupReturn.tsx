// The way back to the welcome steps from a page one of them linked to (lib/welcome.ts setupReturnState; the AI step's
// "Other AI services" line left the owner in Admin with no way back). One small control at the top of that page, nothing
// else: "← Back to getting started", and after the AI step, once AI answers (an account added here, or in another tab),
// "Continue setup" in the accent. Either opens /welcome on the step it came from (pages/Welcome.tsx open: the team files
// step shows its result again from its stores; the AI step resumes past itself once AI answers, recorded done). On a
// phone whose entry under this one is the steps, it goes back in the history instead, so the bar and Back do not walk
// through the steps twice; while it shows, a phone's bar has no ‹ of its own (useSetupReturnShown), so there is one
// back, not two. Owner only; nothing once the steps are finished.
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { useEffect } from 'react'
import { parsePath, useLocation, useNavigate } from 'react-router-dom'
import { useT } from '../../i18n'
import { stackNow } from '../../lib/screenHistory'
import { setupReturnState, setupReturnStep } from '../../lib/welcome'
import { useAiAccess } from '../../store/aiAccess'
import { enginesChanged } from '../../store/live'
import { isOwner, useMe } from '../../store/session'
import { useWelcome } from '../../store/welcome'
import { Button } from '../ui'

/** The step this page was opened from while its way back shows (the owner's, the steps unfinished), else null. */
export function useSetupReturnShown() {
  const { state } = useLocation()
  const step = setupReturnStep(state)
  const owner = isOwner(useMe())
  const finished = useWelcome((s) => !!s.progress?.finishedAt)
  return owner && step !== null && !finished ? step : null
}

export function SetupReturn({ className }: { className?: string }) {
  const t = useT()
  const navigate = useNavigate()
  const step = useSetupReturnShown()
  const ai = useAiAccess()
  const afterAi = step === 'ai'
  const shown = step !== null
  useEffect(() => {
    if (!shown) return
    void useWelcome.getState().load().catch(() => {})
    if (!afterAi) return
    const check = () => void useAiAccess.getState().load(true)
    check()
    // an account added or signed in on this page, or in another window or tab (a subscription's sign-in opens one): does
    // AI answer now?
    const off = enginesChanged.on(check)
    window.addEventListener('focus', check)
    return () => { off(); window.removeEventListener('focus', check) }
  }, [shown, afterAi])
  if (!shown) return null
  // a failed check counts as "usable" in the store (so nothing warns); only an answered one offers to continue
  const connected = afterAi && ai.loaded && ai.answered && ai.usable
  const back = () => {
    const below = stackNow()?.below?.p
    if (below && parsePath(below).pathname === '/welcome') navigate(-1)
    // the step itself, as it was (Welcome.tsx opens it even when it was recorded done meanwhile)
    else navigate('/welcome', { state: setupReturnState(step!) })
  }
  return (
    <div className={className} data-testid="setup-return" data-state={connected ? 'continue' : 'back'}>
      {connected ? (
        <Button size="sm" variant="primary" onClick={back} data-testid="setup-return-button">
          {t('setupRow.resume')} <ArrowRight size={14} aria-hidden />
        </Button>
      ) : (
        <Button size="sm" variant="ghost" className="-ml-2.5" onClick={back} data-testid="setup-return-button">
          <ArrowLeft size={14} aria-hidden /> {t('welcome.returnBack')}
        </Button>
      )}
    </div>
  )
}
