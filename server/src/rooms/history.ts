// A team room's or the everyone room's history for a member who joins it later (docs/DECISIONS.md "지난 대화"): as in a
// Slack channel they see what was said before them (people's messages, threads, reactions, files, quotes), except the
// old answers they could not open. An answer of the room's AI, one a person shared from their own AI chat, or a message
// an AI app sent after reading went into the room only because everyone there then could open what it used; for a
// later member it is judged again when they join.
//
//   room_members.history_from_seq   where the member sees the room from: 0 (the whole history) once worked out here;
//                                   NULL until then, so they see it from their join on (visible_from_seq), as an
//                                   older build does: the safe state whatever fails
//   room_hidden_answers             the old answers they may not see: one line each in the app, nothing else of them
//                                   anywhere (rooms/store.ts SEE_SQL, messagesOut), nor what is in their threads
//   room_members.history_recheck    their access changed since: walked again, and only what is hidden both before and
//                                   now stays hidden (a member never loses an answer they could read: the members who
//                                   were there keep theirs when their access narrows too)
//
// Which answers: those whose who-sees seq (their own; a thread reply's thread's first message's) is at or before the
// member's join point, deleted ones too (an answer built on a deleted one is judged by it). A thread reply in a thread
// that started before the join was decided without the member, whenever it came. An answer is hidden when what it used
// is not known (no scope kept; an AI answer that used the web, a connection or any tool outside the team files; a
// shared answer whose chat did not describe it), when the member's account cannot be loaded, or when one of its
// sources is not theirs to read (chat/read-scope.ts viewersOf: the readers of the "more people can see" card). This
// room as a source: they must see it from where the answer's context started with no answer hidden from them from there
// on, but for the ones its asker could not see either while in the room since before it (never in its context). The
// walk goes in seq order, so an answer built on one hidden from them is hidden too.
import type { Database } from 'bun:sqlite'
import type { RoomKind } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { loadPrincipal, type Principal, type RuleSet } from '../policy/access'
import { sourceKey, viewersOf, type ReadSource } from '../chat/read-scope'
import { memberRow, roomRow } from './store'

/** Rooms whose history a later member sees: a team room and the everyone room (Slack's channels). Group chats and
 * 1:1s keep "from the join on" (Slack's group DMs). */
export const historyKinds = (kind: RoomKind): boolean => kind === 'team' || kind === 'all'

/** A failing (room, member) is tried again after this long (meanwhile they see the room from their join on). */
const RETRY_MS = 5 * 60_000
const failed = new WeakMap<Database, Map<string, number>>()

/** What an old answer used, as kept; closed: not all of it is known (hidden from every later member). */
interface Scope { sources: ReadSource[]; closed: boolean }
type Candidate = { id: string; seq: number; see: number; author_kind: 'user' | 'ai'; author_id: string | null; asked_by: string | null; thread_root_id: string | null; ai_scope: string | null; source_scope: string | null }
const KNOWN: ReadonlySet<string> = new Set(['folder', 'root', 'user', 'integration', 'drive_share', 'room', 'name'])

/** An AI answer's question scope (room_ai_turns.scope: {sources, outside}) or a person's message's
 * (room_messages.source_scope: {sources, unknown}); null: none kept, or not readable. */
function scopeOf(c: Candidate): Scope | null {
  const raw = c.author_kind === 'ai' ? c.ai_scope : c.source_scope
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as { sources?: unknown; outside?: unknown; unknown?: unknown }
    if (!Array.isArray(v.sources)) return null
    const sources = v.sources as ReadSource[]
    // a source this build does not know, and (for the AI, as RoomAi.decide counts them) a connection or a shared
    // Drive: not something to judge a later member by
    const closed = !!v.outside || !!v.unknown || sources.some((s) => !s || typeof s !== 'object' || !KNOWN.has((s as { type?: string }).type ?? '')
      || (c.author_kind === 'ai' && (s.type === 'integration' || s.type === 'drive_share')))
    return { sources, closed }
  } catch { return null }
}

/**
 * Work out the old answers hidden from `userId` in this room and open its history to them, in one transaction (false:
 * nothing to do: not a team room or the everyone room, not a member, already open and nothing to check again). A first
 * time keeps what the walk finds; a check again (history_recheck) keeps only what was hidden before too. Throws only on
 * a database failure: they then stay as they were (from their join on, or the rows they had).
 */
export function openHistory(ctx: AppContext, roomId: string, userId: string): boolean {
  const db = ctx.db
  const room = roomRow(db, roomId)
  if (!room || room.archived_at || !historyKinds(room.kind)) return false
  const me = memberRow(db, roomId, userId)
  if (!me) return false
  const first = me.history_from_seq === null
  if (!first && !me.history_recheck) return false
  const who = loadPrincipal(db, userId)
  const rules = ctx.files.rules()
  db.transaction(() => {
    const before = first ? null : new Set((db.query('SELECT message_id FROM room_hidden_answers WHERE room_id = ? AND user_id = ?').all(roomId, userId) as { message_id: string }[]).map((r) => r.message_id))
    const fresh = me.visible_from_seq > 0 ? walk(ctx, rules, roomId, userId, me.visible_from_seq, who) : []
    db.query('DELETE FROM room_hidden_answers WHERE room_id = ? AND user_id = ?').run(roomId, userId)
    const add = db.query('INSERT OR IGNORE INTO room_hidden_answers (room_id, user_id, message_id, see_seq) VALUES (?, ?, ?, ?)')
    for (const h of fresh) if (!before || before.has(h.id)) add.run(roomId, userId, h.id, h.see)
    db.query('UPDATE room_members SET history_from_seq = 0, history_recheck = 0 WHERE room_id = ? AND user_id = ?').run(roomId, userId)
  })()
  return true
}

/** The walk: every candidate in seq order, the ones hidden from the member (with the seq that decides who sees them). */
function walk(ctx: AppContext, rules: RuleSet, roomId: string, userId: string, joinedAt: number, who: Principal | null): { id: string; see: number }[] {
  const db = ctx.db
  const candidates = db.query(`SELECT m.id, m.seq, COALESCE(m.thread_root_seq, m.seq) see, m.author_kind, m.author_id, m.asked_by, m.thread_root_id, m.source_scope,
      (SELECT t.scope FROM room_ai_turns t WHERE t.answer_id = m.id LIMIT 1) ai_scope
    FROM room_messages m WHERE m.room_id = ? AND (m.author_kind = 'ai' OR m.answer_at IS NOT NULL OR m.source_scope IS NOT NULL)
      AND COALESCE(m.thread_root_seq, m.seq) <= ? AND m.visibility = 'room' AND m.event IS NULL ORDER BY m.seq`).all(roomId, joinedAt) as Candidate[]
  const hidden: { id: string; see: number }[] = []
  const ids = new Set<string>()
  const verdicts = new Map<string, boolean>()
  const readerRows = new Map<string, Set<string>>()
  /** the answers hidden from the person whose question (or message) `c` was, when they have been in the room since
   * before it (their rows are then what they could not see when it was made: rows only become fewer); else none */
  const exemptFor = (c: Candidate): Set<string> | null => {
    const r = c.author_kind === 'ai' ? c.asked_by : c.author_id
    if (!r || r === userId) return null
    const row = memberRow(db, roomId, r)
    if (!row || row.visible_from_seq >= c.seq) return null
    let s = readerRows.get(r)
    if (!s) readerRows.set(r, (s = new Set((db.query('SELECT message_id FROM room_hidden_answers WHERE room_id = ? AND user_id = ?').all(roomId, r) as { message_id: string }[]).map((x) => x.message_id))))
    return s
  }
  const reads = (p: Principal, s: ReadSource, c: Candidate): boolean => {
    if (s.type === 'room' && s.id === roomId) {
      const from = s.fromSeq ?? 0
      const exempt = exemptFor(c)
      return !hidden.some((h) => h.see >= from && !exempt?.has(h.id))
    }
    const k = sourceKey(s)
    let ok = verdicts.get(k)
    if (ok === undefined) { ok = viewersOf(db, rules, s, [p]).has(p.id); verdicts.set(k, ok) }
    return ok
  }
  for (const c of candidates) {
    // in the thread of an answer hidden from them: hidden with it (kept as a row, so a check again judges it on its own
    // once its thread's first message is no longer hidden)
    let visible = false
    if (!(c.thread_root_id && ids.has(c.thread_root_id))) {
      try {
        const scope = scopeOf(c)
        visible = !!who && !!scope && !scope.closed && scope.sources.every((s) => reads(who, s, c))
      } catch (e) {
        // one answer that cannot be judged is hidden; the walk goes on
        ctx.log.warn('room history: an answer not judged', { err: e })
        visible = false
      }
    }
    if (visible) continue
    hidden.push({ id: c.id, see: c.see })
    ids.add(c.id)
  }
  return hidden
}

/** Members waiting for a room's history (NULL) or a check again, newest joins first: `userId`'s only, or everyone's. */
function waiting(db: Database, userId?: string): { room_id: string; user_id: string }[] {
  return db.query(`SELECT m.room_id, m.user_id FROM room_members m JOIN rooms r ON r.id = m.room_id
    WHERE r.kind IN ('team', 'all') AND r.archived_at IS NULL AND (m.history_from_seq IS NULL OR m.history_recheck = 1)${userId ? ' AND m.user_id = ?' : ''}
    ORDER BY m.joined_at DESC, m.room_id, m.user_id`).all(...(userId ? [userId] : [])) as { room_id: string; user_id: string }[]
}

/**
 * Open the history of team rooms and the everyone room to the members waiting for it, and check again those whose
 * access changed: `userId`'s rooms only (when they open their rooms: no time limit), or everyone's for at most
 * `budgetMs` (the rest on the next call: Rooms.sync runs at start, every minute and after access changes). The first
 * members (joined at 0) have nothing to work out. A failure leaves that member as they were, is logged without the room
 * or the person, and is tried again after RETRY_MS. Returns the (room, member) pairs whose view changed, for the caller
 * to tell their windows.
 */
export function openHistories(ctx: AppContext, o: { userId?: string; budgetMs?: number } = {}): { roomId: string; userId: string }[] {
  const db = ctx.db
  db.query(`UPDATE room_members SET history_from_seq = 0 WHERE history_from_seq IS NULL AND visible_from_seq <= 0${o.userId ? ' AND user_id = ?' : ''}
    AND room_id IN (SELECT id FROM rooms WHERE kind IN ('team', 'all'))`).run(...(o.userId ? [o.userId] : []))
  const until = o.budgetMs === undefined ? Infinity : Date.now() + o.budgetMs
  const fails = failed.get(db) ?? new Map<string, number>()
  failed.set(db, fails)
  const changed: { roomId: string; userId: string }[] = []
  for (const m of waiting(db, o.userId)) {
    if (Date.now() > until) break
    const key = `${m.room_id} ${m.user_id}`
    if ((fails.get(key) ?? 0) > Date.now()) continue
    try {
      if (openHistory(ctx, m.room_id, m.user_id)) changed.push({ roomId: m.room_id, userId: m.user_id })
      fails.delete(key)
    } catch (e) {
      fails.set(key, Date.now() + RETRY_MS)
      ctx.log.warn('room history not opened', { err: e })
    }
  }
  return changed
}

/** These people's access changed (rules, groups, role): their hidden answers are checked again on the next pass, in
 * the team rooms and the everyone room where they have any. Never throws. */
export function recheckHistories(ctx: AppContext, userIds: readonly string[]) {
  if (!userIds.length) return
  try {
    for (let i = 0; i < userIds.length; i += 500) {
      const part = userIds.slice(i, i + 500)
      ctx.db.query(`UPDATE room_members SET history_recheck = 1 WHERE history_from_seq IS NOT NULL AND user_id IN (${part.map(() => '?').join(',')})
        AND EXISTS (SELECT 1 FROM room_hidden_answers h WHERE h.room_id = room_members.room_id AND h.user_id = room_members.user_id)`).run(...part)
    }
  } catch (e) { ctx.log.warn('room history recheck not marked', { err: e }) }
}
