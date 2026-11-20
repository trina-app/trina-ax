/**
 * The name to greet someone by, in the UI's language (`locale`: "ko", "en", "en-US" …), one rule for every greeting by
 * name ("{team}에 오신 걸 환영해요, {name}님", "이제 {name}님 차례예요", "How can I help you, {name}?").
 *
 * - Korean, Japanese and Chinese (the UI language, or a name written in those scripts, family name first): the whole
 *   name, as these languages address people ("QA Member" → "QA Member님", "김민지" → "김민지님"; no given-name guess).
 * - Other languages: the first word, the given name ("Mina Park" → "Mina").
 * - Words with no letter or digit (an emoji, "·") are left out; a name that is only those stays as it is.
 */
export function greetName(name: string, locale: string): string {
  const s = name.trim()
  const words = s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w))
  if (!words.length) return s
  const lang = locale.toLowerCase().split(/[-_]/)[0]
  const whole = lang === 'ko' || lang === 'ja' || lang === 'zh' || /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(s)
  return whole ? words.join(' ') : words[0]!
}
