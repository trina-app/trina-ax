// A short line above the composer when this person has no usable AI. Typing is never blocked; nothing shows until the
// server has answered, and never for people who have AI.
import { Plug } from 'lucide-react'
import { useEffect } from 'react'
import { bannerText, trialLine } from '../../lib/aiAccess'
import { useT } from '../../i18n'
import { useAiAccess } from '../../store/aiAccess'
import AiAccessButton from './AiAccessButton'

export default function AiAccessBanner() {
  const t = useT()
  const { loaded, usable, action, requested, trial, load } = useAiAccess()
  useEffect(() => { void load() }, [load])
  if (!loaded || usable) return null
  return (
    <div role="status" className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-subtle px-3 py-2 text-sm" data-testid="ai-access-banner">
      <Plug size={15} className="shrink-0 text-muted" aria-hidden />
      <span className="min-w-0 flex-[1_1_12rem] leading-6">
        {trial && <span className="block font-medium" data-testid="ai-access-trial">{t(trialLine(trial))}</span>}
        {t(bannerText(action, requested))}
      </span>
      <AiAccessButton />
    </div>
  )
}
