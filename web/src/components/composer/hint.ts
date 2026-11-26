// The placeholder of every message box (components/composer/ComposerShell.tsx).
import type { useT } from '../../i18n'

type TFunction = ReturnType<typeof useT>

/** The empty box's line, picked the same way in every box: the words on their way from a recording, then the AI's open
 * question, then "sends after this answer" while one runs (or a card waits for a choice only its buttons make), then
 * the box's own. */
export function composerHint(t: TFunction, { transcribing, answering, waiting, choice = false, own, phone = false }: {
  /** the recording's words on their way (useVoiceInput transcribingText) */
  transcribing?: string | null
  /** the box answers the AI's open question: its own words for that, else the shared ones */
  answering?: boolean | string
  /** what is sent now waits (an answer runs, someone else's turn) */
  waiting?: boolean
  choice?: boolean
  own: string
  phone?: boolean
}): string {
  if (transcribing) return transcribing
  if (answering) return typeof answering === 'string' ? answering : t(phone ? 'composer.answerPlaceholderShort' : 'composer.answerPlaceholder')
  if (waiting) return t(choice ? 'outbox.placeholderChoice' : 'outbox.placeholder')
  return own
}
