// Rollback guard for chats shared with people and groups (migration 298; docs/DECISIONS.md "Chats shared with people
// and groups", B2 and B3). This build marks every turn it starts (turns.people_checked = 1, set when it moves a
// queued turn to running, or ends one without running it; a turn waits in the queue with 0) and the turns a chat had
// when it was first shared (2). Turns still queued are passed over. An older build knows nothing about these chats: it sees an ordinary private chat of its
// creator (chats.shared_at stays NULL) and runs its creator's turns there with their memories, personal tools and
// browser, none of which a shared chat allows. When this build starts again, before anything runs:
//   - a people-shared chat with a turn this build did not mark stops being shared (people_shared_at NULL, its audience
//     rows gone: the creator keeps it as their own chat), and turns still queued there by anyone else are stopped;
//   - a people-shared chat an older build moved into a project loses the mark and its audience rows (it is its creator's
//     private project chat; a people-shared chat never gets a project otherwise: PATCH {projectId} is refused).
// Each is audited (chat.unshared_rollback, counts only). Fails closed: a check that throws stops the recovery.
import type { Database } from 'bun:sqlite'
import { audit } from '../admin/audit'

export function unsharePeopleChecked(db: Database): { unshared: string[]; moved: string[] } {
  // every turn of a people-shared chat is checked or marked by the share: no time filter (a clock set back must not hide
  // one)
  const ran = db.query(`SELECT c.id, c.user_id FROM chats c WHERE c.people_shared_at IS NOT NULL AND c.project_id IS NULL
    AND EXISTS (SELECT 1 FROM turns t WHERE t.chat_id = c.id AND t.people_checked = 0 AND t.status <> 'queued')`).all() as { id: string; user_id: string }[]
  const moved = db.query('SELECT id FROM chats WHERE people_shared_at IS NOT NULL AND project_id IS NOT NULL').all() as { id: string }[]
  if (!ran.length && !moved.length) return { unshared: [], moved: [] }
  const now = new Date().toISOString()
  db.transaction(() => {
    for (const r of ran) {
      db.query('UPDATE chats SET people_shared_at = NULL WHERE id = ?').run(r.id)
      db.query('DELETE FROM chat_audience WHERE chat_id = ?').run(r.id)
      const queued = db.query("SELECT id, message_id FROM turns WHERE chat_id = ? AND status = 'queued' AND user_id <> ?").all(r.id, r.user_id) as { id: string; message_id: string | null }[]
      for (const t of queued) {
        db.query("UPDATE turns SET status = 'stopped', ended_at = ?, people_checked = CASE WHEN status = 'queued' THEN 1 ELSE people_checked END, shared_checked = CASE WHEN status = 'queued' AND shared_checked = 0 THEN 1 ELSE shared_checked END WHERE id = ?").run(now, t.id)
        if (t.message_id) db.query("UPDATE messages SET status = 'stopped', updated_at = ? WHERE id = ? AND status = 'streaming'").run(now, t.message_id)
      }
      audit(db, { actor: null, action: 'chat.unshared_rollback', target: r.id, detail: { kind: 'people', why: 'older_build_turn', stopped: queued.length } })
    }
    for (const r of moved) {
      db.query('UPDATE chats SET people_shared_at = NULL WHERE id = ?').run(r.id)
      db.query('DELETE FROM chat_audience WHERE chat_id = ?').run(r.id)
      audit(db, { actor: null, action: 'chat.unshared_rollback', target: r.id, detail: { kind: 'people', why: 'older_build_move' } })
    }
  })()
  return { unshared: ran.map((r) => r.id), moved: moved.map((r) => r.id) }
}
