// The placeholder and the kept draft of every message box (components/composer/ComposerShell.tsx).
import { useEffect, useRef } from 'react'
import type { useT } from '../../i18n'
import { readDraft, writeDraft } from '../../lib/localData'

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

/** A box's draft kept on this device across reloads and closing (lib/localData drafts, per person; the full chat's box
 * keeps its own the same way): read once into an empty box when it opens with `key`, written as it changes, removed
 * once empty. `key`: 'side:<room id>' (the side chat), 'thread:<chat id>:<answer id>' (an answer's thread). */
export function useKeptDraft(userId: string, key: string, text: string, setText: (text: string) => void) {
  const read = useRef<string | null>(null)
  useEffect(() => {
    if (read.current === key) return
    read.current = key
    const kept = readDraft(userId, key)
    if (kept && !text) setText(kept)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, key])
  useEffect(() => {
    if (read.current !== key) return
    writeDraft(userId, key, text)
  }, [userId, key, text])
}
