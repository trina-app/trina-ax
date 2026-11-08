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
//                      REDECIDE_ROOM_MAX) are decided again soon after, off the request.
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
export const REDECIDE_ROOM_MAX = 20

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
  db.query('UPDATE room_ai_turns SET decision = ? WHERE turn_id = ?').run(now, r.turn_id)
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

const soon = new WeakMap<AppContext, Set<string>>()
/**
 * People left this room, or a later member's hidden answers there were checked again: its recent refused previews are
 * decided again soon after (once for a burst of changes), off the request. Never throws.
 */
export function redecideRoomSoon(ctx: AppContext, roomId: string) {
  let rooms = soon.get(ctx)
  if (!rooms) soon.set(ctx, (rooms = new Set()))
  if (rooms.has(roomId)) return
  rooms.add(roomId)
  const t = setTimeout(() => { rooms!.delete(roomId); redecideRoom(ctx, roomId) }, 0)
  ;(t as { unref?: () => void }).unref?.()
}
/** This room's recent refused previews decided again now; returns how many changed. */
export function redecideRoom(ctx: AppContext, roomId: string): number {
  let changed = 0
  try {
    const since = new Date(Date.now() - REDECIDE_RECENT_DAYS * 86_400_000).toISOString()
    const rows = ctx.db.query(`SELECT t.turn_id, t.room_id, t.chat_id, t.question_id, t.answer_id, t.scope, t.created_at, t.decision
      FROM room_ai_turns t JOIN room_messages m ON m.id = t.answer_id
      WHERE ${REFUSED} AND t.room_id = ? AND t.created_at >= ? ORDER BY t.created_at DESC LIMIT ?`).all(roomId, since, REDECIDE_ROOM_MAX) as Row[]
    for (const r of rows) try { if (again(ctx, r)) changed++ } catch (e) { ctx.log.warn('room preview not decided again', { err: e }) }
  } catch (e) { ctx.log.warn('room previews not decided again', { err: e }) }
  return changed
}
