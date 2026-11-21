// The gate's daily totals (stateDir/stats.json): how many landings, starts, questions, refusals, "Start free" clicks
// and how long visitors were active, per UTC day and locale. Counters only: no address, no hash, no visitor id. One
// start is one visitor session (a visitor gets one instance), so per-visitor flags live on the in-memory Instance.
import fs from 'node:fs'
import path from 'node:path'
import { isLocale } from './config.ts'
import { utcDay } from './state.ts'

export const KEEP_DAYS = 400
const DAY = 24 * 3600_000

/** time-active buckets (lastSeenAt - assignedAt) */
export const DURATION_BUCKETS = ['dur.lt2m', 'dur.2to10m', 'dur.10to30m', 'dur.30to60m', 'dur.60mPlus'] as const
export function durationBucket(ms: number): (typeof DURATION_BUCKETS)[number] {
  const m = Math.max(0, ms) / 60_000
  if (m < 2) return 'dur.lt2m'
  if (m < 10) return 'dur.2to10m'
  if (m < 30) return 'dur.10to30m'
  if (m < 60) return 'dur.30to60m'
  return 'dur.60mPlus'
}

export type StatKey =
  | 'landing' | 'busyShown' | 'refusedPaused' | 'refusedFull' | 'refusedLimit' | 'turnstilePass' | 'turnstileFail'
  | 'starts' | 'startFailed' | 'resumes' | 'questions' | 'hitLimit' | 'startFree' | 'tokens' | (typeof DURATION_BUCKETS)[number]

/** day -> locale (one of LOCALES, or '-') -> counter -> value */
export type StatDays = Record<string, Record<string, Record<string, number>>>

const localeKey = (l: string | null | undefined) => (isLocale(l) ? l : '-')

export class GateStats {
  private file: string
  private days: StatDays = {}
  private timer: ReturnType<typeof setTimeout> | null = null
  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.file = path.join(dir, 'stats.json')
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { days?: unknown }
      if (s.days && typeof s.days === 'object') {
        for (const [d, locs] of Object.entries(s.days as Record<string, unknown>)) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !locs || typeof locs !== 'object') continue
          for (const [l, c] of Object.entries(locs as Record<string, unknown>)) {
            if (!c || typeof c !== 'object') continue
            for (const [k, v] of Object.entries(c as Record<string, unknown>)) if (typeof v === 'number' && Number.isFinite(v)) ((this.days[d] ??= {})[localeKey(l)] ??= {})[k] = v
          }
        }
      }
    } catch {}
    this.prune()
  }

  bump(locale: string | null | undefined, key: StatKey, n = 1, now = Date.now()): void {
    if (!(n > 0)) return
    const c = ((this.days[utcDay(now)] ??= {})[localeKey(locale)] ??= {})
    c[key] = (c[key] ?? 0) + n
    this.save()
  }
  duration(locale: string | null | undefined, ms: number, now = Date.now()): void { this.bump(locale, durationBucket(ms), 1, now) }

  /** the last `days` UTC days (today included) that have any counts */
  read(days = 30, now = Date.now()): StatDays {
    const n = Math.min(KEEP_DAYS, Math.max(1, Math.floor(days) || 1))
    const from = utcDay(now - (n - 1) * DAY)
    const out: StatDays = {}
    for (const d of Object.keys(this.days).sort()) if (d >= from) out[d] = structuredClone(this.days[d]!)
    return out
  }

  private prune(now = Date.now()) {
    const from = utcDay(now - (KEEP_DAYS - 1) * DAY)
    for (const d of Object.keys(this.days)) if (d < from) delete this.days[d]
  }
  private save() {
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = null; this.flush() }, 500)
    this.timer.unref?.()
  }
  flush(now = Date.now()): void {
    this.prune(now)
    const tmp = this.file + '.tmp'
    try { fs.writeFileSync(tmp, JSON.stringify({ days: this.days }), { mode: 0o600 }); fs.renameSync(tmp, this.file) } catch {}
  }
}
