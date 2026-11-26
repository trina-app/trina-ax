// Dates, sizes and numbers through Intl (tab 5: 날짜·숫자는 Intl API로).
import type { Locale } from '@mycel/shared/api'

const TAG: Record<Locale, string> = { ko: 'ko-KR', en: 'en-US', id: 'id-ID', ja: 'ja-JP', es: 'es', zh: 'zh-CN' }
export const intlTag = (l: Locale) => TAG[l]

export function formatSize(bytes: number | null | undefined, locale: Locale): string {
  if (bytes === null || bytes === undefined) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  const nf = new Intl.NumberFormat(TAG[locale], { maximumFractionDigits: i === 0 || v >= 100 ? 0 : 1 })
  return `${nf.format(v)} ${units[i]}`
}

export function formatNumber(n: number, locale: Locale, o: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(TAG[locale], o).format(n)
}

export function formatUsd(n: number, locale: Locale): string {
  return new Intl.NumberFormat(TAG[locale], { style: 'currency', currency: 'USD', maximumFractionDigits: n < 1 ? 4 : 2 }).format(n)
}

export function formatDateTime(iso: string | null | undefined, locale: Locale, timeZone?: string): string {
  if (!iso) return ''
  return new Intl.DateTimeFormat(TAG[locale], { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(iso))
}

/** A short time within the next weeks, for a badge: "11월 8일 오전 12:59", "Nov 8 at 12:59 AM" (no year). */
export function formatShortDateTime(iso: string | null | undefined, locale: Locale): string {
  if (!iso) return ''
  return new Intl.DateTimeFormat(TAG[locale], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
}

/** A day without its year: "11월 8일", "November 8". */
/** The day a usage limit starts again ("Dec 1"): `iso` is the start of the next period in the team's time zone
 * (server/src/admin/budgets.ts periodEnd), so the day is read in that zone, never the browser's. */
export function formatResetDay(iso: string, locale: Locale, timeZone?: string): string {
  try { return new Intl.DateTimeFormat(TAG[locale], { month: 'short', day: 'numeric', ...(timeZone ? { timeZone } : {}) }).format(new Date(iso)) } catch { return new Intl.DateTimeFormat(TAG[locale], { month: 'short', day: 'numeric' }).format(new Date(iso)) }
}

/** "Nov 21, 3:00 PM": a day and time in the reader's own clock (when an AI limit starts again) */
export function formatResetTime(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(TAG[locale], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
}

export function formatMonthDay(iso: string | null | undefined, locale: Locale): string {
  if (!iso) return ''
  return new Intl.DateTimeFormat(TAG[locale], { month: 'long', day: 'numeric' }).format(new Date(iso))
}

/** "Nov 15" this year, "Nov 15, 2025" another year (a list's meta line: Files › Shared with me) */
export function formatShortDate(iso: string | null | undefined, locale: Locale, now = new Date()): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (d.getFullYear() === now.getFullYear()) return new Intl.DateTimeFormat(TAG[locale], { month: 'short', day: 'numeric' }).format(d)
  return new Intl.DateTimeFormat(TAG[locale], { dateStyle: 'medium' }).format(d)
}

export function formatDate(iso: string | null | undefined, locale: Locale): string {
  if (!iso) return ''
  return new Intl.DateTimeFormat(TAG[locale], { dateStyle: 'medium' }).format(new Date(iso))
}

/** "3분 전", "어제", or a date for older things. */
export function formatRelative(iso: string, locale: Locale, now = Date.now()): string {
  const diff = (new Date(iso).getTime() - now) / 1000
  const rtf = new Intl.RelativeTimeFormat(TAG[locale], { numeric: 'auto' })
  const abs = Math.abs(diff)
  const say = (n: number, unit: Intl.RelativeTimeFormatUnit) => cjkTight(rtf.format(n, unit), locale)
  if (abs < 45) return say(0, 'second')
  if (abs < 3600) return say(Math.round(diff / 60), 'minute')
  if (abs < 86400) return say(Math.round(diff / 3600), 'hour')
  if (abs < 86400 * 7) return say(Math.round(diff / 86400), 'day')
  return formatDate(iso, locale)
}

/** ja and zh write "3時間前", not ICU's "3 時間前" (QA 2026-11-22 C10): no space between a number and the word after it. */
export function cjkTight(s: string, locale: Locale): string {
  return locale === 'ja' || locale === 'zh' ? s.replace(/(\d)[\s ]+(?=\D)/gu, '$1') : s
}

/** History groups by date: today / yesterday / last 7 days / last 30 days / older. */
export type DateBucket = 'today' | 'yesterday' | 'week' | 'month' | 'older'
export function dateBucket(iso: string, now = new Date()): DateBucket {
  const d = new Date(iso)
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const t = d.getTime()
  if (t >= start) return 'today'
  if (t >= start - 86400_000) return 'yesterday'
  if (t >= start - 7 * 86400_000) return 'week'
  if (t >= start - 30 * 86400_000) return 'month'
  return 'older'
}

/** How long something took, in the person's words: "45 sec", "3 min", "1 hr 5 min" (Intl units, no i18n keys). */
export function formatElapsed(ms: number, locale: Locale): string {
  const unit = (n: number, u: 'second' | 'minute' | 'hour') => new Intl.NumberFormat(TAG[locale], { style: 'unit', unit: u, unitDisplay: 'short' }).format(n)
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return unit(s, 'second')
  const m = Math.round(s / 60)
  if (m < 60) return unit(m, 'minute')
  return m % 60 ? `${unit(Math.floor(m / 60), 'hour')} ${unit(m % 60, 'minute')}` : unit(m / 60, 'hour')
}

export function fmtDuration(s: number) {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

/** YYYY-MM-DD of the person's own calendar day (date inputs). Not toISOString(): that is the UTC day, which in
 * Seoul is still "yesterday" until 09:00, and the usage screen then left out everything of today. */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** YYYY-MM-DD of the calendar day in a time zone (the team's, where schedules run); without one, the person's own day.
 * Not toISOString(): in Jakarta that is still "yesterday" until 07:00 (QA TC-075). */
export function zoneDay(d: Date, tz: string | null | undefined): string {
  if (!tz) return localDay(d)
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  } catch {
    return localDay(d)
  }
}

/** Inclusive date inputs -> [from, to) API range. Calendar arithmetic preserves DST boundaries. */
export function localDayRange(from: string, to: string): { from: string; to: string } {
  const end = new Date(`${to}T00:00:00`)
  end.setDate(end.getDate() + 1)
  return { from: new Date(`${from}T00:00:00`).toISOString(), to: end.toISOString() }
}

/** Optional inclusive date inputs -> [from, to) API bounds. An empty input gives no bound on that side. */
export function localDayBounds(from: string, to: string): { from?: string; to?: string } {
  return { from: from ? localDayRange(from, from).from : undefined, to: to ? localDayRange(to, to).to : undefined }
}

/** A list's time (the 대화 list, the Inbox's conversation rows): today the time, yesterday the word, before the date. */
export function listTime(iso: string, locale: Locale, yesterday: string): string {
  const b = dateBucket(iso)
  if (b === 'today') return new Intl.DateTimeFormat(intlTag(locale), { timeStyle: 'short' }).format(new Date(iso))
  if (b === 'yesterday') return yesterday
  return formatDate(iso, locale)
}

/** An ISO date or date-time a card shows as one of its values (a Calendar event's start: "2026-11-27T15:00:00"), as a
 * person reads it in `locale`: "2026년 11월 27일 (금) 오후 3:00", "Fri, Nov 27, 2026, 3:00 PM". The time written, never
 * converted to another zone: a call's time without an offset is in the zone the call names next to it. An offset or "Z"
 * in the value is kept, as "UTC+9" / "UTC". Seconds show when they are not zero. Anything else, a fraction of a second or
 * a date that does not exist included, is null: the card shows the value as sent. */
const CARD_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?)?$/
export function formatCardTime(value: string, locale: Locale): string | null {
  const m = CARD_TIME.exec(value)
  if (!m) return null
  const [, y, mo, d, h, mi, s, off] = m
  const at = Date.UTC(+y!, +mo! - 1, +d!, h ? +h : 0, mi ? +mi : 0, s ? +s : 0)
  const t = new Date(at)
  // a day or a time that does not exist ("2026-02-30", "25:00") is not reformatted
  if (t.getUTCFullYear() !== +y! || t.getUTCMonth() !== +mo! - 1 || t.getUTCDate() !== +d! || (h && (t.getUTCHours() !== +h || t.getUTCMinutes() !== +mi!))) return null
  const date: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short', timeZone: 'UTC' }
  if (!h) return new Intl.DateTimeFormat(TAG[locale], date).format(t)
  const text = new Intl.DateTimeFormat(TAG[locale], { ...date, hour: 'numeric', minute: '2-digit', ...(s && s !== '00' ? { second: '2-digit' } : {}) }).format(t)
  if (!off) return text
  if (off === 'Z') return `${text} UTC`
  const o = /^([+-])(\d{2}):?(\d{2})$/.exec(off)!
  return `${text} UTC${o[1]}${+o[2]!}${o[3] === '00' ? '' : `:${o[3]}`}`
}
