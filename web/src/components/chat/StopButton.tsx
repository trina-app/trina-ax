// Stop (답변 멈추기, composer.stop): the one button that stops my running answer, in every box I ask the AI from — the
// full chat's box (Composer.tsx) and the ✦ side chat beside a room (rooms/SideChatPanel.tsx). A round button with a
// filled square; while the stop is on its way it spins and takes no second press. Who may stop is the server's rule
// (a shared chat: only the person whose turn it is); a box shows this only for an answer that is mine to stop.
import clsx from 'clsx'
import { Loader2, Square } from 'lucide-react'
import { useState } from 'react'
import { useT } from '../../i18n'
import { Tooltip } from '../Tooltip'

export function StopButton({ onStop, onError, className, testId = 'stop' }: {
  /** stops the answer (useChats.stop); a throw goes to onError */
  onStop: () => Promise<void>
  onError?: (e: unknown) => void
  /** the size where the box's other buttons are larger (default 32px) */
  className?: string
  testId?: string
}) {
  const t = useT()
  const [stopping, setStopping] = useState(false)
  const stop = async () => {
    if (stopping) return
    setStopping(true)
    try {
      await onStop()
    } catch (e) {
      onError?.(e)
    } finally {
      setStopping(false)
    }
  }
  return (
    <Tooltip label={t('composer.stop')}>
      <button
        type="button"
        onClick={() => void stop()}
        disabled={stopping}
        aria-label={t('composer.stop')}
        className={clsx('touch-hit flex shrink-0 items-center justify-center rounded-full bg-ink text-canvas transition hover:opacity-80 disabled:opacity-40', className ?? 'h-8 w-8')}
        data-testid={testId}
      >
        {stopping ? <Loader2 size={17} className="animate-spin" /> : <Square size={14} className="fill-current" />}
      </button>
    </Tooltip>
  )
}
