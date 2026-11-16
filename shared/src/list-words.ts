// People's names joined as one phrase, the way the app writes a list in each language: English, Spanish, Indonesian,
// Japanese and Chinese with the language's own "and" (Intl.ListFormat, as web lib/shareCard.ts and
// MemberWelcome do); Korean with commas (the app's Korean lists: web lib/teamGoal.ts, "QA Owner, QA Admin").
export function listWords(names: readonly string[], locale: string): string {
  if (locale === 'ko') return names.join(', ')
  try { return new Intl.ListFormat(locale, { type: 'conjunction' }).format(names) } catch { return names.join(', ') }
}
