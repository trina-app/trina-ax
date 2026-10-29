// Dates, sizes and numbers through Intl (tab 5: 날짜·숫자는 Intl API로).
import type { Locale } from '@mycel/shared/api'

const TAG: Record<Locale, string> = { ko: 'ko-KR', en: 'en-US', id: 'id-ID' }
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

export function formatDate(iso: string | null | undefined, locale: Locale): string {
  if (!iso) return ''
  return new Intl.DateTimeFormat(TAG[locale], { dateStyle: 'medium' }).format(new Date(iso))
}

/** "3분 전", "어제", or a date for older things. */
export function formatRelative(iso: string, locale: Locale, now = Date.now()): string {
  const diff = (new Date(iso).getTime() - now) / 1000
  const rtf = new Intl.RelativeTimeFormat(TAG[locale], { numeric: 'auto' })
  const abs = Math.abs(diff)
  if (abs < 45) return rtf.format(0, 'second')
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour')
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), 'day')
  return formatDate(iso, locale)
}

/** Sidebar groups: today / yesterday / last 7 days / last 30 days / older. */
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

export function fmtDuration(s: number) {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

/** YYYY-MM-DD of the person's own calendar day (date inputs). Not toISOString(): that is the UTC day, which in
 * Seoul is still "yesterday" until 09:00, and the usage screen then left out everything of today. */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
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
