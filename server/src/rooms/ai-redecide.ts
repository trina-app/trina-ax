// Private previews of room AI answers kept as not postable because they used an old answer hidden from some member
// (Decision.hidden) are decided again, on what their own question used, so one gets its button once what such an
// answer was built on can be named to its asker (rooms/earlier-sources.ts, docs/DECISIONS.md "방에 올리기…"). Only the
// decision changes: nothing is posted; the asker's windows get the preview again when it changed.
//
//   after an upgrade   every preview made before this build's first start (`until`) is tried once, oldest first, in
//                      steps of REDECIDE_CHUNK rows or REDECIDE_STEP_MS (at least one row a step), REDECIDE_GAP_MS
//                      apart, starting REDECIDE_FIRST_MS after start (the server listens by then): never in the way of
//                      start-up. Where it got to is kept in settings (REDECIDE_KEY: `after`, the last row tried, by
//                      creation time and turn id) after every row, so a restart goes on from there and a row is never
//                      tried twice; the pass is done when no row is left. A row's own cost is bounded by decide()
//                      (DECIDE_HISTORY_MS for histories, EARLIER_DEPTH / EARLIER_MAX for what it follows). Previews made
//                      after `until` were decided by this build already.
//   when people leave  a member out of a team room or the everyone room, or a later member's hidden answers checked
//                      again (fewer now): that room's recent refused previews (REDECIDE_RECENT_DAYS, at most
//                      REDECIDE_ROOM_MAX) are decided again soon after, off the request. Rooms wait in one queue per
//                      server and go one at a time: a step takes one room's previews for about REDECIDE_STEP_MS (at
//                      least one; the rest of that room in the next step), steps REDECIDE_ROOM_GAP_MS apart, so many
//                      rooms at once (a group's members changed, accounts removed) never hold the server up together.
// A decision is saved only on a turn still private: one posted meanwhile keeps what it is.
// Never throws.
import type { Database } from 'bun:sqlite'
import type { AppContext } from '../context'
import { decisionJson, rootOf, roomAiOf, storedScope } from './ai'
import { messageRow, seenSeq } from './store'
import { roomsOf } from './service'

/** settings key of the pass after an upgrade: { until, after, done } */
export const REDECIDE_KEY = 'rooms.redecideHidden.v2'
export const REDECIDE_CHUNK = 20
export const REDECIDE_STEP_MS = 250
export const REDECIDE_GAP_MS = 2_000
export const REDECIDE_FIRST_MS = 5_000
/** a room's refused previews decided again when people leave it: this recent, at most this many */
export const REDECIDE_RECENT_DAYS = 14
export const REDECIDE_ROOM_MAX = 10
/** between the steps of the room queue */
export const REDECIDE_ROOM_GAP_MS = 200
/** rooms with nothing to decide again looked past in one step, at most */
const EMPTY_ROOMS_PER_STEP = 50

interface State { until: string; after: { at: string; id: string } | null; done: boolean }
type Row = { turn_id: string; room_id: string; chat_id: string; question_id: string; answer_id: string; scope: string; created_at: string; decision: string }

const REFUSED = `t.status = 'private' AND m.visibility = 'private' AND m.deleted_at IS NULL AND t.scope IS NOT NULL
  AND json_valid(t.decision) AND json_extract(t.decision, '$.hidden') = 1`

/** The pass's state; the first call (this build's first start) begins it, with every preview made until now to try. */
export function redecideState(db: Database): State {
  const raw = (db.query('SELECT value FROM settings WHERE key = ?').get(REDECIDE_KEY) as { value: string } | null)?.value
  if (raw) try { const s = JSON.parse(raw) as State; if (typeof s.until === 'string') return s } catch { /* begun again below */ }
  const s: State = { until: new Date().toISOString(), after: null, done: false }
  saveState(db, s)
  return s
}
function saveState(db: Database, s: State) {
  db.query('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(REDECIDE_KEY, JSON.stringify(s))
}

/** Decide one refused preview again; true when its decision changed (saved, and sent to the asker's windows). */
function again(ctx: AppContext, r: Row): boolean {
  const db = ctx.db
  const scope = storedScope(r.scope)
  const m = messageRow(db, r.room_id, r.answer_id)
  if (!scope || !m) return false
  const q = messageRow(db, r.room_id, r.question_id)
  const d = roomAiOf(ctx).decide(r.room_id, r.chat_id, scope, q ? seenSeq(q) : undefined, rootOf(m), q?.seq)
  const now = decisionJson(d)
  if (d.hidden || now === r.decision) return false
  // only a turn still private: one its asker posted meanwhile (share) keeps what it is, and nothing is sent
  if (!db.query("UPDATE room_ai_turns SET decision = ? WHERE turn_id = ? AND status = 'private'").run(now, r.turn_id).changes) return false
  try { roomsOf(ctx).messageEvent('room.message.updated', m) } catch (e) { ctx.log.warn('room preview not sent again', { err: e }) }
  return true
}

/**
 * One step of the pass after an upgrade: up to `max` refused previews after the last one tried, for about `budgetMs`
 * (at least one), each tried once. Returns how many were tried and changed, and whether the pass is done.
 */
export function redecideStep(ctx: AppContext, o: { max?: number; budgetMs?: number } = {}): { tried: number; changed: number; done: boolean } {
  const db = ctx.db, max = o.max ?? REDECIDE_CHUNK, until = Date.now() + (o.budgetMs ?? REDECIDE_STEP_MS)
  let tried = 0, changed = 0
  try {
    const s = redecideState(db)
    if (s.done) return { tried, changed, done: true }
    const rows = db.query(`SELECT t.turn_id, t.room_id, t.chat_id, t.question_id, t.answer_id, t.scope, t.created_at, t.decision
      FROM room_ai_turns t JOIN room_messages m ON m.id = t.answer_id
      WHERE ${REFUSED} AND t.created_at <= ?1 AND (?2 IS NULL OR t.created_at > ?2 OR (t.created_at = ?2 AND t.turn_id > ?3))
      ORDER BY t.created_at, t.turn_id LIMIT ?4`).all(s.until, s.after?.at ?? null, s.after?.id ?? '', max) as Row[]
    for (const r of rows) {
      if (tried > 0 && Date.now() > until) break
      tried++
      try { if (again(ctx, r)) changed++ } catch (e) { ctx.log.warn('room preview not decided again', { err: e }) }
      // kept after every row: a restart goes on after it, and it is never tried again
      s.after = { at: r.created_at, id: r.turn_id }
      saveState(db, s)
    }
    // fewer than asked and none left behind: nothing more to try
    if (rows.length < max && tried === rows.length) { s.done = true; saveState(db, s) }
    return { tried, changed, done: s.done }
  } catch (e) {
    ctx.log.warn('room previews not decided again', { err: e })
    return { tried, changed, done: false }
  }
}

const timers = new WeakMap<AppContext, ReturnType<typeof setTimeout>>()
/** At start: begin the pass (its state, at once) and run its steps after the server listens, until it is done. */
export function startRedecide(ctx: AppContext) {
  try { if (redecideState(ctx.db).done) return } catch (e) { ctx.log.warn('room previews not decided again', { err: e }); return }
  const tick = (ms: number) => {
    const t = setTimeout(() => { if (!redecideStep(ctx).done) tick(REDECIDE_GAP_MS); else timers.delete(ctx) }, ms)
    ;(t as { unref?: () => void }).unref?.()
    timers.set(ctx, t)
  }
  tick(REDECIDE_FIRST_MS)
  ctx.onClose(() => stopRedecide(ctx))
}
/** Stop the steps (closing; tests). */
export function stopRedecide(ctx: AppContext) {
  const t = timers.get(ctx)
  if (t) clearTimeout(t)
  timers.delete(ctx)
}

/** The rooms waiting to be decided again (in order, each once) and the rest of the one begun. */
interface Queue { rooms: Set<string>; rows: Row[]; timer: ReturnType<typeof setTimeout> | null; hooked: boolean }
const queues = new WeakMap<AppContext, Queue>()
const queueOf = (ctx: AppContext): Queue => queues.get(ctx) ?? queues.set(ctx, { rooms: new Set(), rows: [], timer: null, hooked: false }).get(ctx)!

/**
 * People left this room, or a later member's hidden answers there were checked again: its recent refused previews are
 * decided again soon after, off the request, in the room queue (one room a step). Never throws.
 */
export function redecideRoomSoon(ctx: AppContext, roomId: string) {
  const q = queueOf(ctx)
  q.rooms.add(roomId)
  schedule(ctx, q, 0)
}
function schedule(ctx: AppContext, q: Queue, ms: number) {
  if (q.timer) return
  if (!q.hooked) { q.hooked = true; ctx.onClose(() => { if (q.timer) clearTimeout(q.timer); q.timer = null }) }
  q.timer = setTimeout(() => {
    q.timer = null
    redecideRoomStep(ctx)
    if (q.rooms.size || q.rows.length) schedule(ctx, q, REDECIDE_ROOM_GAP_MS)
  }, ms)
  ;(q.timer as { unref?: () => void }).unref?.()
}
/** How many rooms and previews wait in the room queue (tests). */
export function pendingRedecide(ctx: AppContext): number {
  const q = queues.get(ctx)
  return q ? q.rooms.size + q.rows.length : 0
}

/** A room's recent refused previews, newest first. */
function roomRows(ctx: AppContext, roomId: string): Row[] {
  const since = new Date(Date.now() - REDECIDE_RECENT_DAYS * 86_400_000).toISOString()
  return ctx.db.query(`SELECT t.turn_id, t.room_id, t.chat_id, t.question_id, t.answer_id, t.scope, t.created_at, t.decision
    FROM room_ai_turns t JOIN room_messages m ON m.id = t.answer_id
    WHERE ${REFUSED} AND t.room_id = ? AND t.created_at >= ? ORDER BY t.created_at DESC LIMIT ?`).all(roomId, since, REDECIDE_ROOM_MAX) as Row[]
}

/**
 * One step of the room queue: the rest of the room begun before, or the next room with refused previews (rooms with
 * none are looked past), for about `budgetMs` (at least one preview). Only one room a step. Returns that room, how
 * many were tried and how many changed.
 */
export function redecideRoomStep(ctx: AppContext, budgetMs = REDECIDE_STEP_MS): { roomId: string | null; tried: number; changed: number } {
  const q = queueOf(ctx), until = Date.now() + budgetMs
  let tried = 0, changed = 0
  try {
    for (let empty = 0; !q.rows.length && q.rooms.size && empty < EMPTY_ROOMS_PER_STEP; empty++) {
      const next = q.rooms.values().next().value as string
      q.rooms.delete(next)
      q.rows = roomRows(ctx, next)
    }
    const roomId = q.rows[0]?.room_id ?? null
    while (q.rows.length && q.rows[0]!.room_id === roomId) {
      if (tried > 0 && Date.now() > until) break
      const r = q.rows.shift()!
      tried++
      try { if (again(ctx, r)) changed++ } catch (e) { ctx.log.warn('room preview not decided again', { err: e }) }
    }
    return { roomId, tried, changed }
  } catch (e) {
    ctx.log.warn('room previews not decided again', { err: e })
    q.rows = []
    return { roomId: null, tried, changed }
  }
}
