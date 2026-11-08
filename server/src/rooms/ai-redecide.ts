// At start: the private previews of room AI answers kept as not postable because they used an old answer hidden from
// some member (Decision.hidden) are decided again once, on what their own question used, so one made before what such
// an answer was built on could be named to its asker (rooms/earlier-sources.ts, docs/DECISIONS.md "방에 올리기…") gets
// its button now when it qualifies. Only the decision changes: nothing is posted, nobody is told (the app reads it with
// the message). The newest REDECIDE_MAX, for at most REDECIDE_MS, once per database: a pass that went through all of
// them is kept in settings (REDECIDE_KEY), one cut off by the time limit goes on at the next start; never throws.
import type { AppContext } from '../context'
import { decisionJson, rootOf, roomAiOf, storedScope } from './ai'
import { messageRow, seenSeq } from './store'

export const REDECIDE_MAX = 500
export const REDECIDE_MS = 2_000
/** settings key: the pass has been through this database's previews (a later build that needs another sets a new one) */
export const REDECIDE_KEY = 'rooms.redecideHidden.v1'

export function redecideHidden(ctx: AppContext, o: { force?: boolean } = {}): number {
  const db = ctx.db, ai = roomAiOf(ctx), until = Date.now() + REDECIDE_MS
  let changed = 0
  try {
    if (!o.force && db.query('SELECT 1 FROM settings WHERE key = ?').get(REDECIDE_KEY)) return 0
    let cut = false
    const rows = db.query(`SELECT t.turn_id, t.room_id, t.chat_id, t.question_id, t.answer_id, t.scope FROM room_ai_turns t JOIN room_messages m ON m.id = t.answer_id
      WHERE t.status = 'private' AND m.visibility = 'private' AND m.deleted_at IS NULL AND t.scope IS NOT NULL AND json_valid(t.decision) AND json_extract(t.decision, '$.hidden') = 1
      ORDER BY t.created_at DESC LIMIT ?`).all(REDECIDE_MAX) as { turn_id: string; room_id: string; chat_id: string; question_id: string; answer_id: string; scope: string }[]
    for (const r of rows) {
      if (Date.now() > until) { cut = true; break }
      try {
        const scope = storedScope(r.scope)
        const m = messageRow(db, r.room_id, r.answer_id)
        if (!scope || !m) continue
        const q = messageRow(db, r.room_id, r.question_id)
        const d = ai.decide(r.room_id, r.chat_id, scope, q ? seenSeq(q) : undefined, rootOf(m), q?.seq)
        if (d.hidden) continue
        db.query('UPDATE room_ai_turns SET decision = ? WHERE turn_id = ?').run(decisionJson(d), r.turn_id)
        changed++
      } catch (e) { ctx.log.warn('room preview not decided again', { err: e }) }
    }
    if (!cut) db.query('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(REDECIDE_KEY, JSON.stringify({ at: new Date().toISOString() }))
  } catch (e) { ctx.log.warn('room previews not decided again', { err: e }) }
  return changed
}
