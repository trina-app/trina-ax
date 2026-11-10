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
import type { Locale, MyStatus, SetStatusBody, StatusMessage } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { teamTimeZone } from '../admin/settings'
import { fail } from '../http/errors'
import { zonedDay } from '../system/time-zone'
import { MY_PROFILE_CHANGED, PROFILE_CHANGED } from './profiles'
import { LIVE_SQL, planStatus, STATUS_TEXT, statusOut, type StatusRow } from './status-plan'

export { LIVE_SQL, planStatus, STATUS_TEXT, statusForAi, statusOut, type StatusPlan, type StatusRow } from './status-plan'

const COLS = 'user_id, emoji, text, clear, starts_at, clears_at, until_day'

/** The person's status row that has not cleared at `now` (it may still be to start), or null. */
function currentRow(db: Database, userId: string, now: Date): StatusRow | null {
  return db.query(`SELECT ${COLS} FROM user_status_messages WHERE user_id = ? AND (clears_at IS NULL OR clears_at > ?)`).get(userId, now.toISOString()) as StatusRow | null
}

/** What the team sees of a person now: a status that has started and not cleared, of an active account (`anyAccount`:
 * whatever the account's state, for the notice when it is turned off or on: admin/users.ts). */
export function liveStatusOf(db: Database, userId: string, now = new Date(), anyAccount = false): StatusMessage | null {
  const iso = now.toISOString()
  const r = db.query(`SELECT s.emoji, s.text, s.clears_at, s.until_day FROM user_status_messages s JOIN users u ON u.id = s.user_id
    WHERE s.user_id = ? ${anyAccount ? '' : "AND u.status = 'active' AND u.deleted_at IS NULL"} AND ${LIVE_SQL}`).get(userId, iso, iso) as Pick<StatusRow, 'emoji' | 'text' | 'clears_at' | 'until_day'> | null
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

/** Set my status. `changed`: what the team sees of me changed (a status that starts later changes nothing for them);
 * `cleared`: other people's statuses that had ended and were removed now (the team is told of them too). */
export function setStatus(db: Database, userId: string, body: SetStatusBody, o: { now: Date; tz: string; locale: Locale }): { status: MyStatus; changed: boolean; cleared: string[] } {
  let changed = false
  let cleared: string[] = []
  db.transaction(() => {
    if (!db.query("SELECT 1 FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL").get(userId)) fail('unauthorized')
    const before = liveStatusOf(db, userId, o.now)
    const current = currentRow(db, userId, o.now)
    const p = planStatus(body, o.now, o.tz, current, o.locale)
    cleared = removeCleared(db, o.now)
    db.query(`INSERT INTO user_status_messages (user_id, emoji, text, clear, starts_at, clears_at, until_day, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET emoji = excluded.emoji, text = excluded.text, clear = excluded.clear, starts_at = excluded.starts_at,
        clears_at = excluded.clears_at, until_day = excluded.until_day, updated_at = excluded.updated_at`)
      .run(userId, p.emoji, p.text, p.clear, p.startsAt, p.clearsAt, p.untilDay, o.now.toISOString())
    changed = JSON.stringify(before) !== JSON.stringify(liveStatusOf(db, userId, o.now))
  })()
  return { status: myStatusOf(db, userId, o.now, o.tz)!, changed, cleared: cleared.filter((id) => id !== userId) }
}

/** Clear my status (also one that starts later). `removed`: there was one; `changed`: the team saw it; `cleared`:
 * other people's ended statuses removed now. */
export function clearStatus(db: Database, userId: string, now: Date): { removed: boolean; changed: boolean; cleared: string[] } {
  let out = { removed: false, changed: false, cleared: [] as string[] }
  db.transaction(() => {
    const before = liveStatusOf(db, userId, now)
    const cleared = removeCleared(db, now).filter((id) => id !== userId)
    const removed = db.query('DELETE FROM user_status_messages WHERE user_id = ?').run(userId).changes > 0
    out = { removed, changed: removed && !!before, cleared }
  })()
  return out
}

/** The notices after a write of `userId`: my windows always (they read my account), the team when what it sees
 * changed (mine, or someone's ended status removed by the write). */
export function tellAfterWrite(ctx: AppContext, userId: string, r: { changed: boolean; cleared: string[] }): void {
  const rt = ctx.services.realtime
  if (!r.changed && !r.cleared.length) return rt.publish(userId, MY_PROFILE_CHANGED)
  const own = new Set([userId, ...r.cleared])
  rt.publishEach((to) => (own.has(to) ? MY_PROFILE_CHANGED : PROFILE_CHANGED))
}

/** A person's account was turned off or deleted (admin/users.ts): when they had a status the team sees, open windows
 * read the directory again, so their emoji and a DM's line go at once. */
export function statusGoneWithAccount(ctx: AppContext, hadStatus: boolean): void {
  if (hadStatus) ctx.services.realtime.publishEach(() => PROFILE_CHANGED)
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

  /** How long to wait for the next start or end since the last look (at most maxMs; 0 when one has passed). */
  waitMs(): number {
    let wait = this.maxMs
    try {
      // from the last look, not from now: a start or an end passed since (a write between it and its look, a late
      // timer) is told at once instead of at the hourly look
      const iso = new Date(this.lastLook).toISOString()
      const next = (this.ctx.db.query(`SELECT MIN(t) AS t FROM (SELECT MIN(clears_at) AS t FROM user_status_messages WHERE clears_at > ?
        UNION ALL SELECT MIN(starts_at) AS t FROM user_status_messages WHERE starts_at > ?)`).get(iso, iso) as { t: string | null } | null)?.t
      if (next) wait = Math.min(wait, Math.max(0, Date.parse(next) - this.now()) + 50)
    } catch { /* the database is closing: the next look is the hourly one */ }
    return wait
  }

  /** Wait for the next start or end. A write calls it: its status may come sooner. */
  arm(): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.tick(), this.waitMs())
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
