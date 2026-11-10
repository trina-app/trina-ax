// Status messages (docs/DECISIONS.md "상태 메시지"), modelled on the common pattern of team chat apps. One per person in user_status_messages
// (migration 283): an emoji, a short text and when it clears, set by the person alone (PUT /api/me/status).
//
// - When it clears is worked out here, in the team's time zone (admin/settings.ts teamTimeZone), never the server's: a
//   hosted server runs in UTC, where a Korean team's "today" would end at 09:00. 오늘 ends at the team's next midnight,
//   이번 주 at the end of its Sunday, chosen days at the end of the last one; a later first day shows it from that day's
//   midnight only.
// - Who sees it: exactly who sees the person's online dot (realtime/presence.ts): the people directory (GET
//   /api/people: signed in, active, not in a forced password change) and the person's own account (/api/me). Only an
//   active account's status is given, only between its start and its end; nothing else reads the table.
// - An ended status is hidden on every read at once (start and end compared with now), removed on the next write and
//   by the clock below, which runs at the next start or end (at least hourly) and tells open windows (the quiet
//   profile notices: they read the directory, and my account, again).
import type { Database } from 'bun:sqlite'
import { addDays, STATUS_DAYS_AHEAD, STATUS_DEFAULT_EMOJI } from '@mycel/shared'
import type { Locale, MyStatus, SetStatusBody, StatusClear, StatusMessage } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { teamTimeZone } from '../admin/settings'
import { fail } from '../http/errors'
import { zonedDay, zonedParts, zonedToUtc } from '../system/time-zone'
import { MY_PROFILE_CHANGED, PROFILE_CHANGED } from './profiles'

type T = Record<Locale, string>
const t = (ko: string, en: string, id: string, ja: string, es: string): T => ({ ko, en, id, ja, es })

/** Refusals of a status, in the person's language. */
export const STATUS_TEXT: Record<'empty' | 'noDay' | 'order' | 'far' | 'gone' | 'tooOften', T> = {
  empty: t('상태를 적거나 이모지를 골라 주세요.', 'Write a status or choose an emoji.', 'Tulis status atau pilih emoji.', 'ステータスを入力するか、絵文字を選んでください。', 'Escriba un estado o elija un emoji.'),
  noDay: t('마지막 날을 골라 주세요.', 'Choose the last day.', 'Pilih hari terakhir.', '最終日を選んでください。', 'Elija el último día.'),
  order: t('마지막 날은 시작일과 같거나 그 뒤여야 해요.', 'The last day must be the first day or after it.', 'Hari terakhir harus sama dengan atau setelah hari pertama.', '最終日は開始日と同じか、それより後にしてください。', 'El último día debe ser el primero o posterior.'),
  far: t('1년 안의 날짜를 골라 주세요.', 'Choose days within a year.', 'Pilih tanggal dalam satu tahun.', '1年以内の日付を選んでください。', 'Elija días dentro de un año.'),
  gone: t('상태가 이미 지워졌어요. 삭제 시간을 다시 골라 주세요.', 'The status has already cleared. Choose when it clears again.', 'Status sudah terhapus. Pilih lagi kapan dihapus.', 'ステータスはすでに消えています。削除する時間を選び直してください。', 'El estado ya se borró. Vuelva a elegir cuándo se borra.'),
  tooOften: t('상태를 너무 자주 바꿨어요. 잠시 뒤 다시 해 주세요.', 'You changed your status too often. Try again in a moment.', 'Status terlalu sering diubah. Coba lagi sebentar lagi.', 'ステータスの変更が多すぎます。しばらくしてからもう一度お試しください。', 'Cambió su estado demasiadas veces. Vuelva a intentarlo en un momento.'),
}
const refuse = (k: keyof typeof STATUS_TEXT, locale: Locale, field: string): never =>
  fail('validation', STATUS_TEXT[k][locale] ?? STATUS_TEXT[k].en, { fields: { [field]: k } })

export interface StatusRow { user_id: string; emoji: string; text: string; clear: StatusClear; starts_at: string | null; clears_at: string | null; until_day: string | null }
const COLS = 'user_id, emoji, text, clear, starts_at, clears_at, until_day'
const AFTER_MS: Partial<Record<StatusClear, number>> = { '30m': 30 * 60_000, '1h': 60 * 60_000, '2h': 2 * 60 * 60_000 }

/** 00:00 of a "YYYY-MM-DD" day in a time zone. */
const dayStart = (day: string, tz: string): Date => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  return zonedToUtc(y, m, d, 0, 0, tz)
}

/** The SQL condition of a status the team sees at `?` (twice): started, not cleared (on a row aliased `s`). */
export const LIVE_SQL = '(s.starts_at IS NULL OR s.starts_at <= ?) AND (s.clears_at IS NULL OR s.clears_at > ?)'

/** A row as the team sees it. */
export function statusOut(r: Pick<StatusRow, 'emoji' | 'text' | 'clears_at' | 'until_day'>): StatusMessage {
  return { emoji: r.emoji, text: r.text, ...(r.clears_at ? { until: r.clears_at } : {}), ...(r.until_day ? { untilDay: r.until_day } : {}) }
}

export interface StatusPlan { emoji: string; text: string; clear: StatusClear; startsAt: string | null; clearsAt: string | null; untilDay: string | null }

/**
 * When a status starts and clears, in the team's zone `tz`, or a refusal in the person's language. `current`: the
 * person's status now (not cleared; maybe still to start), for 'keep'.
 */
export function planStatus(body: SetStatusBody, now: Date, tz: string, current: StatusRow | null, locale: Locale): StatusPlan {
  const text = body.text
  const emoji = body.emoji ?? (text ? STATUS_DEFAULT_EMOJI : '')
  if (!emoji) refuse('empty', locale, 'body.text')
  // days come only with chosen days (a stray one is a mistake of the caller, not something to guess at)
  if (body.clear !== 'dates' && (body.from !== undefined || body.to !== undefined)) refuse('noDay', locale, body.from !== undefined ? 'body.from' : 'body.to')
  const base = { emoji, text }
  const today = zonedDay(now, tz)
  switch (body.clear) {
    case 'keep':
      if (!current) return refuse('gone', locale, 'body.clear')
      return { ...base, clear: current.clear, startsAt: current.starts_at, clearsAt: current.clears_at, untilDay: current.until_day }
    case 'never':
      return { ...base, clear: 'never', startsAt: null, clearsAt: null, untilDay: null }
    case '30m': case '1h': case '2h':
      return { ...base, clear: body.clear, startsAt: null, clearsAt: new Date(now.getTime() + AFTER_MS[body.clear]!).toISOString(), untilDay: null }
    case 'today':
      return { ...base, clear: 'today', startsAt: null, clearsAt: dayStart(addDays(today, 1), tz).toISOString(), untilDay: today }
    case 'week': {
      // the week ends with its Sunday (Monday to Sunday); on a Sunday that is today
      const last = addDays(today, (7 - zonedParts(now, tz).wd) % 7)
      return { ...base, clear: 'week', startsAt: null, clearsAt: dayStart(addDays(last, 1), tz).toISOString(), untilDay: last }
    }
    case 'dates': {
      if (!body.to) return refuse('noDay', locale, 'body.to')
      // a first day already past (another device's clock, a dialog left open overnight) is today
      const from = body.from && body.from > today ? body.from : today
      if (body.to < from) refuse('order', locale, 'body.to')
      if (body.to > addDays(today, STATUS_DAYS_AHEAD)) refuse('far', locale, 'body.to')
      return { ...base, clear: 'dates', startsAt: from > today ? dayStart(from, tz).toISOString() : null, clearsAt: dayStart(addDays(body.to, 1), tz).toISOString(), untilDay: body.to }
    }
  }
}

/** The person's status row that has not cleared at `now` (it may still be to start), or null. */
function currentRow(db: Database, userId: string, now: Date): StatusRow | null {
  return db.query(`SELECT ${COLS} FROM user_status_messages WHERE user_id = ? AND (clears_at IS NULL OR clears_at > ?)`).get(userId, now.toISOString()) as StatusRow | null
}

/** What the team sees of a person now: a status that has started and not cleared, of an active account. */
export function liveStatusOf(db: Database, userId: string, now = new Date()): StatusMessage | null {
  const iso = now.toISOString()
  const r = db.query(`SELECT s.emoji, s.text, s.clears_at, s.until_day FROM user_status_messages s JOIN users u ON u.id = s.user_id
    WHERE s.user_id = ? AND u.status = 'active' AND u.deleted_at IS NULL AND ${LIVE_SQL}`).get(userId, iso, iso) as Pick<StatusRow, 'emoji' | 'text' | 'clears_at' | 'until_day'> | null
  return r ? statusOut(r) : null
}

/** The live statuses of the given people (active accounts only), for the AI's lines (rooms/reader.ts). */
export function liveStatuses(db: Database, userIds: readonly string[], now = new Date()): Map<string, StatusMessage> {
  const out = new Map<string, StatusMessage>()
  if (!userIds.length) return out
  const iso = now.toISOString()
  const rows = db.query(`SELECT s.user_id, s.emoji, s.text, s.clears_at, s.until_day FROM user_status_messages s JOIN users u ON u.id = s.user_id
    WHERE s.user_id IN (SELECT value FROM json_each(?)) AND u.status = 'active' AND u.deleted_at IS NULL AND ${LIVE_SQL}`).all(JSON.stringify(userIds), iso, iso) as (StatusRow)[]
  for (const r of rows) out.set(r.user_id, statusOut(r))
  return out
}

/** My own status for /api/me: also one that starts later (`fromDay`, its first day in the team's zone). */
export function myStatusOf(db: Database, userId: string, now = new Date(), tz = teamTimeZone(db)): MyStatus | undefined {
  const r = currentRow(db, userId, now)
  if (!r) return undefined
  const later = !!r.starts_at && r.starts_at > now.toISOString()
  return { ...statusOut(r), clear: r.clear, ...(later ? { fromDay: zonedDay(new Date(r.starts_at!), tz) } : {}) }
}

/** Remove every status that has cleared (a write and the clock do this; reads only hide them). Returns whose. */
export function removeCleared(db: Database, now: Date): string[] {
  const iso = now.toISOString()
  const ids = (db.query('SELECT user_id FROM user_status_messages WHERE clears_at IS NOT NULL AND clears_at <= ?').all(iso) as { user_id: string }[]).map((r) => r.user_id)
  if (ids.length) db.query('DELETE FROM user_status_messages WHERE clears_at IS NOT NULL AND clears_at <= ?').run(iso)
  return ids
}

/** Set my status. `changed`: what the team sees of me changed (a status that starts later changes nothing for them). */
export function setStatus(db: Database, userId: string, body: SetStatusBody, o: { now: Date; tz: string; locale: Locale }): { status: MyStatus; changed: boolean } {
  let changed = false
  db.transaction(() => {
    if (!db.query("SELECT 1 FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL").get(userId)) fail('unauthorized')
    const before = liveStatusOf(db, userId, o.now)
    removeCleared(db, o.now)
    const p = planStatus(body, o.now, o.tz, currentRow(db, userId, o.now), o.locale)
    db.query(`INSERT INTO user_status_messages (user_id, emoji, text, clear, starts_at, clears_at, until_day, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET emoji = excluded.emoji, text = excluded.text, clear = excluded.clear, starts_at = excluded.starts_at,
        clears_at = excluded.clears_at, until_day = excluded.until_day, updated_at = excluded.updated_at`)
      .run(userId, p.emoji, p.text, p.clear, p.startsAt, p.clearsAt, p.untilDay, o.now.toISOString())
    changed = JSON.stringify(before) !== JSON.stringify(liveStatusOf(db, userId, o.now))
  })()
  return { status: myStatusOf(db, userId, o.now, o.tz)!, changed }
}

/** Clear my status (also one that starts later). `removed`: there was one; `changed`: the team saw it. */
export function clearStatus(db: Database, userId: string, now: Date): { removed: boolean; changed: boolean } {
  let out = { removed: false, changed: false }
  db.transaction(() => {
    const before = liveStatusOf(db, userId, now)
    removeCleared(db, now)
    const removed = db.query('DELETE FROM user_status_messages WHERE user_id = ?').run(userId).changes > 0
    out = { removed, changed: removed && !!before }
  })()
  return out
}

/** One status for the AI's lines (rooms/reader.ts, the remote connector's people_list): "🌴 휴가 중 until 2026-11-14"
 * (the last day) or "until 2026-11-10 15:30" (a time, the team's zone). The caller makes the words safe for its form. */
export function statusForAi(s: StatusMessage, tz: string): string {
  const words = `${s.emoji} ${s.text}`.trim()
  if (s.untilDay) return `${words} until ${s.untilDay}`
  if (!s.until) return words
  const p = zonedParts(new Date(s.until), tz)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${words} until ${p.y}-${two(p.m)}-${two(p.d)} ${two(p.h)}:${two(p.min)}`
}

// ---------------- writes per person ----------------
/** status writes one person may make per minute: each one makes every open window of the team read the directory */
export const STATUS_WRITES_PER_MINUTE = 20
const writes = new WeakMap<Database, Map<string, number[]>>()
/** Count a write, or refuse it (429) past the limit. */
export function countWrite(db: Database, userId: string, now: number, locale: Locale): void {
  let m = writes.get(db)
  if (!m) writes.set(db, (m = new Map()))
  const recent = (m.get(userId) ?? []).filter((t0) => now - t0 < 60_000)
  if (recent.length >= STATUS_WRITES_PER_MINUTE) fail('rate_limited', STATUS_TEXT.tooOften[locale] ?? STATUS_TEXT.tooOften.en, { retryAfter: Math.max(1, Math.ceil((recent[0]! + 60_000 - now) / 1000)) })
  recent.push(now)
  m.set(userId, recent)
  if (m.size > 1000) for (const [k, v] of m) if (!v.some((t0) => now - t0 < 60_000)) m.delete(k)
}
/** Forget the counts (tests). */
export function forgetWrites(db: Database): void { writes.delete(db) }

// ---------------- the clock: starts and ends ----------------
/** the clock looks at least this often, whatever the next start or end (a changed clock, a long sleep) */
export const STATUS_CLOCK_MAX_MS = 3600_000

export class StatusClock {
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastLook: number
  private stopped = false
  constructor(private ctx: AppContext, private now: () => number = () => Date.now(), private maxMs = STATUS_CLOCK_MAX_MS) {
    this.lastLook = now()
  }

  /** Look now: remove what cleared, and tell the team (and their own windows) whose status started or cleared since
   * the last look; then wait for the next start or end. */
  tick(): string[] {
    if (this.stopped) return []
    const db = this.ctx.db
    const now = this.now()
    const iso = new Date(now).toISOString()
    let changed: string[] = []
    try {
      const started = (db.query('SELECT user_id FROM user_status_messages WHERE starts_at IS NOT NULL AND starts_at > ? AND starts_at <= ? AND (clears_at IS NULL OR clears_at > ?)')
        .all(new Date(this.lastLook).toISOString(), iso, iso) as { user_id: string }[]).map((r) => r.user_id)
      changed = [...new Set([...db.transaction(() => removeCleared(db, new Date(now)))(), ...started])]
    } catch (e) {
      this.ctx.log.error('status clock failed', { err: e })
    }
    this.lastLook = now
    if (changed.length) {
      const own = new Set(changed)
      this.ctx.services.realtime.publishEach((to) => (own.has(to) ? MY_PROFILE_CHANGED : PROFILE_CHANGED))
    }
    this.arm()
    return changed
  }

  /** Wait for the next start or end (at most maxMs). A write calls it: its status may come sooner. */
  arm(): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    let wait = this.maxMs
    try {
      const iso = new Date(this.now()).toISOString()
      const next = (this.ctx.db.query(`SELECT MIN(t) AS t FROM (SELECT MIN(clears_at) AS t FROM user_status_messages WHERE clears_at > ?
        UNION ALL SELECT MIN(starts_at) AS t FROM user_status_messages WHERE starts_at > ?)`).get(iso, iso) as { t: string | null } | null)?.t
      if (next) wait = Math.min(wait, Math.max(0, Date.parse(next) - this.now()) + 50)
    } catch { /* the database is closing: the next look is the hourly one */ }
    this.timer = setTimeout(() => this.tick(), wait)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

const clocks = new WeakMap<AppContext, StatusClock>()
/** The server's status clock, started with the people routes (routes/people.ts) and stopped with the context. */
export function startStatusClock(ctx: AppContext): StatusClock {
  const have = clocks.get(ctx)
  if (have) return have
  const c = new StatusClock(ctx)
  clocks.set(ctx, c)
  ctx.onClose(() => c.stop())
  c.arm()
  return c
}
export const statusClockOf = (ctx: AppContext): StatusClock | null => clocks.get(ctx) ?? null
