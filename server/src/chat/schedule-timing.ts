// When a scheduled task runs (chat/schedules.ts), in the team's time zone. The five first kinds (once, every day,
// weekdays, one day a week, a day of the month 1–28) are the columns of migration 203. Since 2026-11-19 a task can also
// repeat as Claude Code's scheduled jobs do (docs/decisions/20261118-shared-schedules-any-frequency.md): every N
// minutes from a start, on several days of the week, on day 29–31 or the last day of the month, or on any cron
// schedule (five fields, minute hour day-of-month month day-of-week, `L` = the last day of the month). No working
// hours and no shortest interval: each run still passes the team's AI budget and runs of one task never overlap.
//
// Those are kept in `schedules.rule` (JSON, migration 426) without changing the `repeat` CHECK of migration 203. The
// old columns of such a task hold a one-time task in the past (STORED_PAST), so an older build after a rollback runs
// it at most once more (its next time as stored) and then stops; it never runs it more often than asked.
import { zonedParts, zonedToUtc } from '../system/time-zone'

export const REPEATS = ['once', 'daily', 'weekdays', 'weekly', 'monthly', 'interval', 'cron'] as const
export type Repeat = (typeof REPEATS)[number]
/** The kinds the old `repeat` column (and an older build) knows. */
export type LegacyRepeat = 'once' | 'daily' | 'weekdays' | 'weekly' | 'monthly'

/** A task's timing as the server reads it. `date`: a one-time task's day, or where an interval starts counting. */
export interface Timing {
  repeat: Repeat
  time: string
  weekdays: number[] | null
  day: number | 'last' | null
  date: string | null
  everyMinutes: number | null
  cron: string | null
}

/** What a timing is read from: a stored row (with `rule`), schedule_create's or an edit's fields, or a Timing. */
export interface TimingSource {
  repeat: string
  time?: string | null
  weekday?: number | null
  weekdays?: readonly number[] | null
  day?: number | 'last' | null
  date?: string | null
  everyMinutes?: number | null
  cron?: string | null
  rule?: string | null
}

/** The old columns' date of a task kept in `rule`: a one-time task long past (an older build never schedules it). */
export const STORED_PAST = '2000-01-01'
/** The longest interval: a year in minutes (a longer one is a cron schedule or a one-time task). */
export const MAX_EVERY_MINUTES = 366 * 24 * 60

interface Rule { repeat: 'weekly' | 'monthly' | 'interval' | 'cron'; weekdays?: number[]; day?: number | 'last'; minutes?: number; start?: string; cron?: string }

function readRule(v: string | null | undefined): Rule | null {
  if (!v) return null
  try {
    const r = JSON.parse(v) as Rule
    return r && typeof r === 'object' && ['weekly', 'monthly', 'interval', 'cron'].includes(r.repeat) ? r : null
  } catch { return null }
}

const days = (v: readonly number[] | null | undefined) => v ? [...new Set(v.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b) : null

/** The timing of a row or of input fields: a stored rule wins over the old columns. */
export function timingOf(s: TimingSource): Timing {
  const r = readRule(s.rule)
  const time = s.time ?? '00:00'
  if (r) {
    if (r.repeat === 'weekly') return { repeat: 'weekly', time, weekdays: days(r.weekdays) ?? [], day: null, date: null, everyMinutes: null, cron: null }
    if (r.repeat === 'monthly') return { repeat: 'monthly', time, weekdays: null, day: r.day ?? null, date: null, everyMinutes: null, cron: null }
    if (r.repeat === 'interval') return { repeat: 'interval', time, weekdays: null, day: null, date: r.start ?? null, everyMinutes: r.minutes ?? null, cron: null }
    return { repeat: 'cron', time, weekdays: null, day: null, date: null, everyMinutes: null, cron: r.cron ?? null }
  }
  const repeat = (REPEATS as readonly string[]).includes(s.repeat) ? s.repeat as Repeat : 'once'
  const weekdays = repeat === 'weekly' ? days(s.weekdays) ?? (s.weekday === null || s.weekday === undefined ? [] : [s.weekday]) : null
  return {
    repeat, time, weekdays,
    day: repeat === 'monthly' ? s.day ?? null : null,
    date: repeat === 'once' || repeat === 'interval' ? s.date ?? null : null,
    everyMinutes: repeat === 'interval' ? s.everyMinutes ?? null : null,
    cron: repeat === 'cron' ? s.cron?.trim() ?? null : null,
  }
}

/** The columns a timing is stored in: the old ones exactly when an older build reads them the same way, else a past
 * one-time task in them and the timing in `rule`. */
export function storedTiming(t: Timing): { repeat: LegacyRepeat; time: string; weekday: number | null; day: number | null; date: string | null; rule: string | null } {
  const past = (rule: Rule) => ({ repeat: 'once' as const, time: t.time, weekday: null, day: null, date: STORED_PAST, rule: JSON.stringify(rule) })
  switch (t.repeat) {
    case 'once': case 'daily': case 'weekdays':
      return { repeat: t.repeat, time: t.time, weekday: null, day: null, date: t.repeat === 'once' ? t.date : null, rule: null }
    case 'weekly': {
      const w = t.weekdays ?? []
      return w.length === 1 ? { repeat: 'weekly', time: t.time, weekday: w[0]!, day: null, date: null, rule: null } : past({ repeat: 'weekly', weekdays: w })
    }
    case 'monthly':
      return typeof t.day === 'number' && t.day >= 1 && t.day <= 28 ? { repeat: 'monthly', time: t.time, weekday: null, day: t.day, date: null, rule: null } : past({ repeat: 'monthly', day: t.day ?? 'last' })
    case 'interval':
      return past({ repeat: 'interval', minutes: t.everyMinutes ?? 60, start: t.date ?? STORED_PAST })
    case 'cron':
      return past({ repeat: 'cron', cron: t.cron ?? '' })
  }
}

/** Is this a one-time task (it ends after its run)? */
export const isOnce = (s: TimingSource) => timingOf(s).repeat === 'once'

// ---------------- cron ----------------

/** A parsed cron schedule: five fields in the team's time zone. */
export interface Cron { minutes: number[]; hours: number[]; dom: Set<number>; lastDay: boolean; domAny: boolean; months: Set<number>; dow: Set<number>; dowAny: boolean }

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const DOWS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
/** "@hourly" and the other cron macros, by their name after the "@" */
const MACROS: Record<string, string> = { yearly: '0 0 1 1 *', annually: '0 0 1 1 *', monthly: '0 0 1 * *', weekly: '0 0 * * 0', daily: '0 0 * * *', midnight: '0 0 * * *', hourly: '0 * * * *' }

export class CronError extends Error {}

function field(src: string, lo: number, hi: number, name: string, names?: string[], o: { last?: boolean } = {}): { values: Set<number>; any: boolean; last: boolean } {
  const values = new Set<number>()
  let last = false
  const num = (v: string) => {
    const i = names ? names.indexOf(v.toUpperCase()) : -1
    if (i >= 0) return i + (name === 'month' ? 1 : 0)
    if (!/^\d+$/.test(v)) throw new CronError(`${name}: "${v}" is not a number`)
    return Number(v)
  }
  for (const part of src.split(',')) {
    if (!part) throw new CronError(`${name}: an empty part`)
    if (o.last && part.toUpperCase() === 'L') { last = true; continue }
    const [range, stepText] = part.split('/') as [string, string | undefined]
    if (part.split('/').length > 2) throw new CronError(`${name}: "${part}" has more than one "/"`)
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) throw new CronError(`${name}: the step in "${part}" must be a whole number of at least 1`)
    let a: number, b: number
    if (range === '*' || range === '?') { a = lo; b = hi }
    else if (range.includes('-')) {
      const [x, y] = range.split('-') as [string, string]
      a = num(x); b = num(y)
    } else { a = num(range); b = stepText === undefined ? a : hi }
    // day of the week 7 is Sunday too
    const top = name === 'day of the week' ? 7 : hi
    if (a < lo || b > top || a > b) throw new CronError(`${name}: "${part}" is outside ${lo}–${top}`)
    for (let v = a; v <= b; v += step) values.add(name === 'day of the week' && v === 7 ? 0 : v)
  }
  return { values, any: src === '*' || src === '?', last }
}

/** A cron expression as five fields (or a macro like "@hourly"); CronError says what is wrong. */
export function parseCron(expr: string): Cron {
  const macro = /^@([a-z]+)$/i.exec(expr.trim())?.[1]?.toLowerCase()
  const text = (macro && Object.hasOwn(MACROS, macro) ? MACROS[macro] : undefined) ?? expr.trim()
  const parts = text.split(/\s+/)
  if (parts.length !== 5) throw new CronError(`a cron schedule has five fields (minute hour day-of-month month day-of-week), "${expr.trim()}" has ${parts.length}`)
  const [mi, h, dom, mo, dow] = parts as [string, string, string, string, string]
  const m = field(mi, 0, 59, 'minute'), hr = field(h, 0, 23, 'hour'), d = field(dom, 1, 31, 'day of the month', undefined, { last: true })
  const month = field(mo, 1, 12, 'month', MONTHS), w = field(dow, 0, 6, 'day of the week', DOWS)
  return {
    minutes: [...m.values].sort((a, b) => a - b), hours: [...hr.values].sort((a, b) => a - b),
    dom: d.values, lastDay: d.last, domAny: d.any, months: month.values, dow: w.values, dowAny: w.any,
  }
}

const lastDayOf = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()

/** Does a cron schedule run on this day? Day of the month and day of the week both restricted: either one (as cron). */
function cronDay(c: Cron, y: number, m: number, d: number, wd: number): boolean {
  if (!c.months.has(m)) return false
  const domOk = c.dom.has(d) || (c.lastDay && d === lastDayOf(y, m))
  const dowOk = c.dow.has(wd)
  if (c.domAny && c.dowAny) return true
  if (c.domAny) return dowOk
  if (c.dowAny) return domOk
  return domOk || dowOk
}

/** How far ahead a cron schedule is looked for: 29 years covers every day-of-month, month and weekday combination. */
const CRON_DAYS = 366 * 29

function cronNext(c: Cron, after: Date, tz: string): Date | null {
  const start = zonedParts(after, tz)
  for (let i = 0; i < CRON_DAYS; i++) {
    const day = new Date(Date.UTC(start.y, start.m - 1, start.d + i))
    const y = day.getUTCFullYear(), m = day.getUTCMonth() + 1, d = day.getUTCDate()
    if (!cronDay(c, y, m, d, day.getUTCDay())) continue
    for (const h of c.hours) {
      // the first day: the hours already gone are skipped (one hour of slack for a clock change)
      if (i === 0 && h < start.h - 1) continue
      for (const mi of c.minutes) {
        const t = zonedToUtc(y, m, d, h, mi, tz)
        // a wall-clock time a clock change skips maps outside its hour: not that time, so not a run
        const back = zonedParts(t, tz)
        if (back.h !== h || back.min !== mi) continue
        if (t > after) return t
      }
    }
  }
  return null
}

// ---------------- next run ----------------

/** The first run strictly after `after` (null: a one-time task whose time has passed, or a cron schedule that never
 * comes). */
export function nextOf(s: TimingSource, after: Date, tz: string): Date | null {
  const t = timingOf(s)
  const [hh, mm] = t.time.split(':').map(Number) as [number, number]
  if (t.repeat === 'once') {
    if (!t.date) return null
    const [y, m, d] = t.date.split('-').map(Number) as [number, number, number]
    const at = zonedToUtc(y, m, d, hh, mm, tz)
    return at > after ? at : null
  }
  if (t.repeat === 'interval') {
    if (!t.everyMinutes || t.everyMinutes < 1 || !t.date) return null
    const [y, m, d] = t.date.split('-').map(Number) as [number, number, number]
    const anchor = zonedToUtc(y, m, d, hh, mm, tz).getTime()
    const step = t.everyMinutes * 60_000
    if (anchor > after.getTime()) return new Date(anchor)
    return new Date(anchor + (Math.floor((after.getTime() - anchor) / step) + 1) * step)
  }
  if (t.repeat === 'cron') {
    try { return t.cron ? cronNext(parseCron(t.cron), after, tz) : null } catch { return null }
  }
  const start = zonedParts(after, tz)
  const weekdays = new Set(t.weekdays ?? [])
  for (let i = 0; i < 370; i++) {
    const day = new Date(Date.UTC(start.y, start.m - 1, start.d + i))
    const y = day.getUTCFullYear(), m = day.getUTCMonth() + 1, d = day.getUTCDate(), wd = day.getUTCDay()
    const ok = t.repeat === 'daily' || (t.repeat === 'weekdays' && wd >= 1 && wd <= 5) || (t.repeat === 'weekly' && weekdays.has(wd))
      || (t.repeat === 'monthly' && (t.day === 'last' ? d === lastDayOf(y, m) : d === t.day))
    if (!ok) continue
    const at = zonedToUtc(y, m, d, hh, mm, tz)
    if (at > after) return at
  }
  return null
}

// ---------------- words ----------------

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const andList = (xs: string[]) => xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`

/** An interval in English ("90 minutes", "2 hours", "3 days"). */
export function everyWords(minutes: number): string {
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
  if (minutes % 1440 === 0) return unit(minutes / 1440, 'day')
  if (minutes % 60 === 0) return unit(minutes / 60, 'hour')
  return unit(minutes, 'minute')
}

/** "every weekday at 09:00" etc., for lists and the AI (English). */
export function describeTiming(s: TimingSource): string {
  const t = timingOf(s)
  switch (t.repeat) {
    case 'once': return `once on ${t.date} at ${t.time}`
    case 'daily': return `every day at ${t.time}`
    case 'weekdays': return `every weekday (Mon–Fri) at ${t.time}`
    case 'weekly': return `every ${andList((t.weekdays ?? []).map((d) => DAY_NAMES[d]!))} at ${t.time}`
    case 'monthly': return t.day === 'last' ? `on the last day of every month at ${t.time}`
      : typeof t.day === 'number' && t.day > 28 ? `every month on day ${t.day} at ${t.time} (a month without a day ${t.day} has no run)` : `every month on day ${t.day} at ${t.time}`
    case 'interval': return `every ${everyWords(t.everyMinutes ?? 0)}, counted from ${t.date} ${t.time}`
    case 'cron': return `on the cron schedule "${t.cron}" (minute hour day-of-month month day-of-week, in the team's time zone)`
  }
}
