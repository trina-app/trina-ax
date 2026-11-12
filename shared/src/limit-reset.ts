// When a usage limit can be used again: a day's or a month's limit ends at the team's midnight. Said in 24-hour time,
// so midnight never reads as noon ("오전 12:00", "12:00 AM"); Korean names the hour alone ("11월 12일 0시").
// The refusal (server/src/admin/budgets.ts budgetBlock) and Settings › 사용량 (web MyUsage) say it the same way.
import type { Locale } from './api/common'

const TAG: Record<Locale, string> = { ko: 'ko-KR', en: 'en-US', id: 'id-ID', ja: 'ja-JP', es: 'es' }

export function limitResetText(at: Date, locale: Locale, timeZone?: string): string {
  const o: Intl.DateTimeFormatOptions = locale === 'ko'
    ? { month: 'short', day: 'numeric', hour: 'numeric', hourCycle: 'h23' }
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
  return new Intl.DateTimeFormat(TAG[locale] ?? TAG.en, { ...o, ...(timeZone ? { timeZone } : {}) }).format(at)
}
