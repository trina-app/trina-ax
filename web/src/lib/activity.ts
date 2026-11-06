// Admin > Activity log: the filters kept in the address, the date presets, and the list grouped by day with runs of the
// same event folded into one row. Pure, so the unit tests (web/test/unit/activity.test.ts) check it without a browser.
import type { AuditEntry } from '@mycel/shared/api'
import { localDay, localDayBounds } from './format'

export type ActivityKind = 'admin' | 'file' | 'tool' | 'auth'
export const ACTIVITY_KINDS: ActivityKind[] = ['auth', 'admin', 'file', 'tool']
export type ActivityRange = 'any' | 'today' | '7d' | '30d' | 'custom'
export const ACTIVITY_RANGES: ActivityRange[] = ['any', 'today', '7d', '30d', 'custom']

/** What the page shows, as kept in the address (?kind=auth&who=bob&q=finance/&range=7d, custom: &from=&to=). */
export type ActivityFilters = { kind: ActivityKind | ''; who: string; q: string; range: ActivityRange; from: string; to: string }
export const NO_FILTERS: ActivityFilters = { kind: '', who: '', q: '', range: 'any', from: '', to: '' }

const DAY = /^\d{4}-\d{2}-\d{2}$/
export function readFilters(p: URLSearchParams): ActivityFilters {
  const kind = p.get('kind') ?? ''
  const range = p.get('range') ?? 'any'
  const from = p.get('from') ?? ''
  const to = p.get('to') ?? ''
  return {
    kind: (ACTIVITY_KINDS as string[]).includes(kind) ? (kind as ActivityKind) : '',
    who: p.get('who') ?? '',
    q: p.get('q') ?? '',
    range: (ACTIVITY_RANGES as string[]).includes(range) ? (range as ActivityRange) : 'any',
    from: DAY.test(from) ? from : '',
    to: DAY.test(to) ? to : '',
  }
}

/** Only what differs from the defaults goes into the address, so a plain /admin/audit stays plain. */
export function writeFilters(f: ActivityFilters): URLSearchParams {
  const p = new URLSearchParams()
  if (f.kind) p.set('kind', f.kind)
  if (f.who) p.set('who', f.who)
  if (f.q) p.set('q', f.q)
  if (f.range !== 'any') p.set('range', f.range)
  if (f.range === 'custom' && f.from) p.set('from', f.from)
  if (f.range === 'custom' && f.to) p.set('to', f.to)
  return p
}

export const filtersActive = (f: ActivityFilters) => writeFilters(f).toString() !== ''

/** The API's [from, to) bounds for a preset; the person's own calendar days (custom: both days included). */
export function rangeBounds(f: Pick<ActivityFilters, 'range' | 'from' | 'to'>, now = new Date()): { from?: string; to?: string } {
  const back = (days: number) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    d.setDate(d.getDate() - days)
    return localDay(d)
  }
  switch (f.range) {
    case 'today': return localDayBounds(localDay(now), '')
    case '7d': return localDayBounds(back(6), '')
    case '30d': return localDayBounds(back(29), '')
    case 'custom': return localDayBounds(f.from, f.to)
    default: return {}
  }
}

/** A search that is a folder path ("finance/2026", "skills/") asks the server for file events under it, so older ones
 * are found too; anything else filters the loaded rows by person, action and item. */
export function pathQuery(q: string): string | undefined {
  const s = q.trim()
  if (!s || /\s/.test(s) || !s.includes('/') || s.includes('..')) return undefined
  const p = s.replace(/^\/+|\/+$/g, '')
  return p || undefined
}

/** Does this row mention the search words (person, the action in words, the item, the AI tool's summary)? */
export function matchesQuery(e: AuditEntry, q: string, label: string): boolean {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const summary = typeof e.detail?.summary === 'string' ? e.detail.summary : ''
  const hay = [e.actor?.name ?? '', label, e.action, e.target ?? '', summary].join(' ').toLowerCase()
  return words.every((w) => hay.includes(w))
}

/** "Signed in" after a name reads "Dion signed in": the first letter goes small unless the word is an acronym ("AI"). */
export function inSentence(label: string): string {
  const a = label.charAt(0)
  const b = label.charAt(1)
  return a && a !== a.toLowerCase() && b && b === b.toLowerCase() && b !== b.toUpperCase() ? a.toLowerCase() + label.slice(1) : label
}

/** Rows of the same event (who, kind, action, item, outcome) close together: one row, "· 5 times". */
export const RUN_GAP_MS = 30 * 60_000
export type ActivityRun = { key: string; entries: AuditEntry[] }
export type ActivityDay = { day: string; runs: ActivityRun[] }

const sameEvent = (a: AuditEntry, b: AuditEntry) =>
  a.source === b.source && a.action === b.action && (a.actor?.id ?? null) === (b.actor?.id ?? null) && a.target === b.target
  && (a.detail?.ok ?? null) === (b.detail?.ok ?? null) && (a.detail?.ip ?? null) === (b.detail?.ip ?? null)

/** Newest first, as the API sends them: grouped by the person's calendar day, repeats folded within a day. */
export function groupActivity(items: AuditEntry[]): ActivityDay[] {
  const days: ActivityDay[] = []
  for (const e of items) {
    const day = localDay(new Date(e.at))
    let d = days[days.length - 1]
    if (!d || d.day !== day) days.push((d = { day, runs: [] }))
    const run = d.runs[d.runs.length - 1]
    const last = run?.entries[run.entries.length - 1]
    if (run && last && sameEvent(last, e) && Math.abs(Date.parse(last.at) - Date.parse(e.at)) <= RUN_GAP_MS) run.entries.push(e)
    else d.runs.push({ key: e.id, entries: [e] })
  }
  return days
}

/** The day's label: "Today", "Yesterday", or the date ("Nov 2"; with the year when it is not this year). */
export function dayLabel(day: string, locale: string, words: { today: string; yesterday: string }, now = new Date()): string {
  const today = localDay(now)
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (day === today) return words.today
  if (day === localDay(y)) return words.yesterday
  const d = new Date(`${day}T00:00:00`)
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', weekday: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) }).format(d)
}
