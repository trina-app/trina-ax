// "시작 설정 이어하기 (2/3)" on the owner's Home until the welcome steps are finished or hidden (pages/Welcome.tsx).
// One slim row, not a card: Home has its own cards. Nothing shows for anyone else, or before the steps were started.
import { Sparkles, X } from 'lucide-react'
import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { WELCOME_COUNTED } from '@mycel/shared/api'
import { doneCount, showResume } from '../../lib/welcome'
import { useT } from '../../i18n'
import { isOwner, useMe } from '../../store/session'
import { toast } from '../../store/ui'
import { useWelcome } from '../../store/welcome'
import { IconButton } from '../ui'

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
  const hide = () => void useWelcome.getState().update({ dismissed: true }).catch(() => toast({ level: 'error', text: t('error.network') }))
  return (
    <div className="mb-6 flex items-center gap-1 rounded-xl border border-line pr-1.5" data-testid="welcome-resume">
      <Link to="/welcome" className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3.5 py-3 hover:bg-hover max-sm:min-h-12" data-testid="welcome-resume-link">
        <Sparkles size={16} className="shrink-0 text-accent-text" aria-hidden />
        <span className="min-w-0 flex-1 text-sm">
          <span className="font-medium text-ink">{t('welcome.resume.title', { n })}</span>{' '}
          <span className="text-muted max-sm:hidden">{t('welcome.resume.desc')}</span>
        </span>
        <span className="flex shrink-0 gap-1" aria-hidden>
          {WELCOME_COUNTED.map((s) => (
            <span key={s} className={`h-1.5 w-4 rounded-full ${progress!.steps[s] === 'done' ? 'bg-accent' : 'bg-hover'}`} />
          ))}
        </span>
      </Link>
      <IconButton label={t('welcome.resume.hide')} onClick={hide} data-testid="welcome-resume-hide">
        <X size={15} />
      </IconButton>
    </div>
  )
}

export default WelcomeResume
