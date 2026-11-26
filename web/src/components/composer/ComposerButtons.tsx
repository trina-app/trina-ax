// The buttons at the end of every message box's row: Send (↑), Answer (↑, while the AI waits for an answer to its
// question) and Send when ready (the clock, while an answer runs or someone else's turn does), all one round accent
// button of one size, the screen's one primary action; Stop is chat/StopButton.tsx at the same size. Used only by
// components/composer/ComposerShell.tsx.
import clsx from 'clsx'
import { ArrowUp, Clock, Loader2 } from 'lucide-react'
import { useT } from '../../i18n'
import { Tooltip } from '../Tooltip'

/** one size for send, the clock and Stop in every box: 36 px, 40 px under 640 px */
export const ROUND_BUTTON = 'size-9 max-sm:size-10'

export type SendKind = 'send' | 'answer' | 'later'

export function SendButton({ kind = 'send', can, sending = false, onSend, label, testId }: {
  kind?: SendKind
  can: boolean
  /** the message is on its way: it spins */
  sending?: boolean
  onSend: () => void
  /** the name in the tooltip when it is not the kind's own (the side chat's "Ask") */
  label?: string
  testId: string
}) {
  const t = useT()
  const name = label ?? t(kind === 'answer' ? 'composer.sendAnswer' : kind === 'later' ? 'outbox.sendLater' : 'chat.send')
  return (
    <Tooltip label={name}>
      <button
        type="button"
        onClick={onSend}
        disabled={!can}
        aria-label={name}
        className={clsx('touch-hit flex shrink-0 items-center justify-center rounded-full transition', ROUND_BUTTON, can ? 'bg-accent text-accent-ink hover:bg-accent-hover' : 'bg-subtle text-faint')}
        data-testid={testId}
      >
        {sending ? <Loader2 size={17} className="animate-spin" aria-hidden /> : kind === 'later' ? <Clock size={17} aria-hidden /> : <ArrowUp size={18} aria-hidden />}
      </button>
    </Tooltip>
  )
}
