// One emoji in one form (docs/DECISIONS.md "Any emoji as a reaction"): the same emoji typed or pasted with or without
// its emoji selector (U+FE0F) is one reaction, not two chips that look alike. It changes the form of a string that is
// one emoji (isStatusEmoji), never whether it is one; anything else comes back as it is.
import { isStatusEmoji } from './status-message'

/** a pictograph drawn as text unless the selector follows it (❤, ☺, ✌): it takes the selector */
const TEXT_DEFAULT = /^(?!\p{Emoji_Presentation})\p{Extended_Pictographic}$/u
const SKIN = /^[\u{1F3FB}-\u{1F3FF}]$/u
const VS16 = '\u{FE0F}'
const KEYCAP = '\u{20E3}'

/** The fully qualified form of one emoji: the selector after each pictograph drawn as text by default (not before a
 * skin tone), none after one drawn as an emoji anyway (👍 rather than 👍 with a selector), and a keycap's (1️⃣). */
export function emojiForm(s: string): string {
  if (!isStatusEmoji(s)) return s
  const cps = [...s]
  if (cps[cps.length - 1] === KEYCAP) return `${cps[0]}${VS16}${KEYCAP}`
  const out: string[] = []
  cps.forEach((c, i) => {
    if (c === VS16) {
      // kept only after a pictograph that needs it
      if (TEXT_DEFAULT.test(cps[i - 1] ?? '')) out.push(c)
      return
    }
    out.push(c)
    const next = cps[i + 1] ?? ''
    if (TEXT_DEFAULT.test(c) && next !== VS16 && !SKIN.test(next)) out.push(VS16)
  })
  return out.join('')
}
