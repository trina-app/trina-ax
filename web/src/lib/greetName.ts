/**
 * The name to greet the person themselves by, in the UI's language (`locale`: "ko", "en", "en-US" …): one rule for the
 * greetings that speak to them ("{team}에 오신 걸 환영해요, {name}님", "이제 {name}님 차례예요", "How can I help you,
 * {name}?"). Never for a name others read (the hi message in a room, another person named on a row): those use the
 * whole display name.
 *
 * - Korean, Japanese and Chinese (the UI language, or a name written in those scripts, family name first): the whole
 *   name as written, as these languages address people ("QA Member" → "QA Member님", "김민지" → "김민지님"; no
 *   given-name guess).
 * - Other languages: the given name, the first word ("Mina Park" → "Mina"), past a leading title or initial ("Dr.",
 *   "J.") or a bracketed tag ("(QA)"). When that word is a single letter ("A Park") or nothing is left, the whole name.
 * - Words that are only emoji are left out; a name that is only emoji stays as it is.
 */
export function greetName(name: string, locale: string): string {
  const s = name.trim()
  const kept = s.split(/\s+/).filter((w) => w && !emojiOnly(w))
  if (!kept.length) return s
  const whole = kept.join(' ')
  const lang = locale.toLowerCase().split(/[-_]/)[0]
  if (lang === 'ko' || lang === 'ja' || lang === 'zh' || /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(s)) return whole
  const first = kept.find((w) => letters(w) > 0 && !w.endsWith('.') && !/^[([{].*[)\]}]$/u.test(w))
  return first && letters(first) >= 2 ? first : whole
}

/** letters and digits in a word */
const letters = (w: string) => (w.match(/[\p{L}\p{N}]/gu) ?? []).length
/** a word of emoji only (with their joiners and variation selectors): no letter, no digit, no other mark ("·" stays) */
const emojiOnly = (w: string) => /\p{Extended_Pictographic}/u.test(w) && /^[\p{Extended_Pictographic}\p{Emoji_Component}‍️\p{M}]+$/u.test(w)
