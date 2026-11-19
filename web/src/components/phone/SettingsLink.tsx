// The way to the phone's Settings for this app, as a phone's settings show it: words in the accent colour with › after
// them, 44 px for a finger, no frame (never a computer's outlined button wedged into a sentence). At the end of a row
// (Settings › Notifications, this device's notifications turned off in the phone's Settings; the 나 list's line about
// them) it is 44 px tall; `under`: on its own line under a notice's words (a blocked microphone,
// components/MicBlockedNotice.tsx), as tall as its words, the 44 px taken around it (touch-hit).
import clsx from 'clsx'
import { ChevronRight } from 'lucide-react'

export function SettingsLink({ label, onClick, testId, className, under }: { label: string; onClick: () => void; testId?: string; className?: string; under?: boolean }) {
  return (
    <button type="button" onClick={onClick} data-testid={testId}
      className={clsx('inline-flex shrink-0 items-center gap-0.5 rounded text-sm font-medium whitespace-nowrap text-accent-text hover:underline focus-visible:outline-offset-2',
        under ? 'touch-hit' : '-mr-1 min-h-11 pl-1', className)}>
      {label}
      <ChevronRight size={16} className="shrink-0" aria-hidden />
    </button>
  )
}
