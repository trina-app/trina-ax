// What an earlier answer hidden from some member was built on (docs/DECISIONS.md "방에 올리기…"), so that a room AI
// answer that used it can be posted by its asker with what is at stake in sight, instead of never.
//
// A later member of a team room or the everyone room does not see an old answer that used something they cannot open
// (rooms/history.ts, room_hidden_answers). An answer whose context held such an answer (one its asker saw) may repeat
// it to them, so RoomAi.decide() kept it private and share() refused it (409 room_ai_hidden): the asker could not see
// what was at stake. Here each such answer is followed to what it used, as kept (an AI answer's question scope,
// room_ai_turns.scope; a person's message's room_messages.source_scope). This room as a source is followed through the
// answers in it hidden from those members, in turn (EARLIER_DEPTH levels, EARLIER_MAX answers, each once); a hidden
// thread reply through its thread's first message when that is hidden too, and a hidden answer through the answers in
// its thread. When every source reached is one the asker may open now (a team folder or the top of the team folder they
// may read, a name they may list, their own folder), the sources join the answer's own and decide() treats them as it
// treats its own: named folders with how many members cannot see each, so the asker decides with them in sight.
// Anything else keeps it unpostable, as before:
// - another room (a 1:1, a group chat, another team room), a connection, a shared Drive, the web or any tool outside
//   the team files, a source type this build does not know, nothing kept;
// - someone else's own folder, or a folder or name the asker cannot open now (a name counts only where the asker may
//   read it, so it is named to them like a folder);
// - people's words: messages in a hidden answer's thread (deleted ones too: they were given while they were there), a
//   hidden person's message other than a shared answer without a note (the note, or a message an AI app sent, is their
//   own words), a deleted person's message (what it had is gone), and files on a hidden message (uploads are no team
//   file the asker could be shown by name);
// - more than EARLIER_DEPTH levels or EARLIER_MAX answers.
// Shared project chats are kept as their project folder (chat/room-project-chats.ts: its readers are the chat's
// audience), so they are judged as that folder. Following more than an answer used (an answer of the room it did not
// see) only names more folders the asker may open, or refuses. A member whose history is not worked out yet is not
// judged here: decide() keeps that unpostable on its own.
import type { Database } from 'bun:sqlite'
import { atLeast, type Principal, type RuleSet } from '../policy/access'
import { nameSegs, sourceKey, type ReadSource } from '../chat/read-scope'

/** levels of answers built on hidden answers followed, at most */
export const EARLIER_DEPTH = 8
/** hidden answers followed for one question, at most */
export const EARLIER_MAX = 100

export interface EarlierAsk {
  roomId: string
  /** the members to whom an old answer from `fromSeq` on is hidden (decide(): the ones that keep it private) */
  users: readonly string[]
  /** where the question's context of this room started */
  fromSeq: number
  /** the asker, whose own hidden answers were never given (decide()'s `exempt`), or '' */
  exempt: string
  /** a question in a thread was given that thread only: only its hidden answers */
  rootId?: string
  /** the person who asked, as they are now */
  asker: Principal | null
}

type Row = { id: string; seq: number; author_kind: 'user' | 'ai'; thread_root_id: string | null; source_scope: string | null; answer_at: number | null; deleted_at: string | null; ai_scope: string | null; files: number }

/**
 * The sources of the old answers hidden from `users` that a question used, followed through the answers they were built
 * on; null when one of them is not something the asker may open now (then the answer stays unpostable).
 */
export function earlierSources(db: Database, rules: RuleSet, o: EarlierAsk): ReadSource[] | null {
  const asker = o.asker
  if (!asker || !o.users.length) return null
  const users = [...new Set(o.users)]
  const marks = users.map(() => '?').join(',')
  /** answers hidden from those members from `from` on (before `before`: what an answer at that seq could have seen) */
  const hiddenFrom = (from: number, before: number | null, exempt: string, rootId: string | null): string[] => (db.query(`SELECT DISTINCT h.message_id id FROM room_hidden_answers h
      JOIN room_messages m ON m.id = h.message_id
      WHERE h.room_id = ? AND h.user_id IN (${marks}) AND h.see_seq >= ? AND (? IS NULL OR m.seq < ?)
        AND NOT EXISTS (SELECT 1 FROM room_hidden_answers x WHERE x.room_id = h.room_id AND x.user_id = ? AND x.message_id = h.message_id)
        AND (? IS NULL OR h.message_id = ? OR m.thread_root_id = ?)
      ORDER BY m.seq`).all(o.roomId, ...users, from, before, before, exempt, rootId, rootId, rootId) as { id: string }[]).map((r) => r.id)
  const isHidden = (id: string) => !!db.query(`SELECT 1 FROM room_hidden_answers WHERE room_id = ? AND message_id = ? AND user_id IN (${marks}) LIMIT 1`).get(o.roomId, id, ...users)

  const out = new Map<string, ReadSource>()
  const seen = new Set<string>()
  const queue: { id: string; depth: number }[] = hiddenFrom(o.fromSeq, null, o.exempt, o.rootId ?? null).map((id) => ({ id, depth: 0 }))
  const push = (id: string, depth: number) => { if (!seen.has(id)) queue.push({ id, depth }) }
  while (queue.length) {
    const { id, depth } = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    if (seen.size > EARLIER_MAX || depth > EARLIER_DEPTH) return null
    const m = db.query(`SELECT m.id, m.seq, m.author_kind, m.thread_root_id, m.source_scope, m.answer_at, m.deleted_at,
        (SELECT t.scope FROM room_ai_turns t WHERE t.answer_id = m.id) ai_scope,
        (SELECT COUNT(*) FROM room_files f WHERE f.message_id = m.id) files
      FROM room_messages m WHERE m.id = ? AND m.room_id = ?`).get(id, o.roomId) as Row | null
    if (!m || m.files > 0) return null
    // a person's message: only a shared answer without a note is the AI's words alone (its kept scope says what they
    // came from); a note or a message an AI app sent is the person's own, and a deleted one's content is not known
    if (m.author_kind === 'user' && (m.answer_at !== 0 || m.deleted_at)) return null
    // its thread: people's words there are hidden with it and are no file to name (deleted ones too: they may have been
    // given); the answers there are followed
    const replies = db.query(`SELECT id, (author_kind = 'ai' OR answer_at IS NOT NULL OR source_scope IS NOT NULL) answer FROM room_messages
      WHERE room_id = ? AND thread_root_id = ? AND visibility = 'room' AND event IS NULL`).all(o.roomId, m.id) as { id: string; answer: number }[]
    if (replies.some((r) => !r.answer)) return null
    for (const r of replies) push(r.id, depth + 1)
    // a thread reply: hidden with its thread's first message, when that is hidden too, which is followed then
    if (m.thread_root_id && isHidden(m.thread_root_id)) push(m.thread_root_id, depth + 1)
    const scope = keptScope(m)
    if (!scope) return null
    for (const s of scope) {
      switch (s.type) {
        case 'room':
          // this room: the answers in it hidden from them that this one could have seen; any other room is not named
          if (s.id !== o.roomId) return null
          for (const w of hiddenFrom(s.fromSeq ?? 0, m.seq, '', null)) push(w, depth + 1)
          continue
        case 'user':
          if (s.id !== asker.id) return null
          break
        case 'name':
          // named to the asker like a folder: only where they may read it (decide() names a folder they may read)
          if (!atLeast(rules.access(asker, nameSegs(s.path)), 'read')) return null
          break
        case 'root':
          if (!atLeast(rules.access(asker, []), 'read')) return null
          break
        case 'folder': {
          const f = db.query('SELECT path FROM folders WHERE id = ?').get(s.id) as { path: string } | null
          if (!f || !atLeast(rules.access(asker, f.path === '' ? [] : f.path.split('/')), 'read')) return null
          break
        }
        default:
          // a connection, a shared Drive, a type this build does not know
          return null
      }
      out.set(sourceKey(s), s)
    }
  }
  return [...out.values()]
}

/** What a message used as kept: an AI answer's question scope ({sources, outside}), a person's message's
 * ({sources, unknown}); null when none is kept, not all of it is known, or it is not readable. */
function keptScope(m: Row): ReadSource[] | null {
  const raw = m.author_kind === 'ai' ? m.ai_scope : m.source_scope
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as { sources?: unknown; outside?: unknown; unknown?: unknown }
    if (!Array.isArray(v.sources) || v.outside || v.unknown) return null
    return (v.sources as unknown[]).every((s) => !!s && typeof s === 'object') ? (v.sources as ReadSource[]) : null
  } catch { return null }
}

/**
 * Has a preview's decision changed since the person was shown it (RoomAi.share)? Both are decisionJson() strings. A
 * decision from before the counts (`unable`) is compared without them: the reasons it showed are what it said.
 */
export function reasonsChanged(stored: string | null, now: string): boolean {
  if (stored === now) return false
  try {
    const a = JSON.parse(stored ?? 'null') as Record<string, unknown> | null
    const b = JSON.parse(now) as Record<string, unknown>
    if (!a || 'unable' in a) return true
    delete b.unable
    return JSON.stringify(a) !== JSON.stringify(b)
  } catch { return true }
}
