// Every team project shares its new chats (docs/DECISIONS.md "Team project chats shared by default"). What decides it
// is that the project is a team project (chat/shared.ts sharesNewChats: its folder outside users/); the column
// projects.share_chats is kept in step for a rollback build, which reads it. This writes it wherever a project may have
// become a team project with the column off (made, shared, adopted, pointed at a team folder, its folder moved out of
// users/, and at start after a rollback build turned it off), with one audit row per project it changes (the system's,
// or the person's who did it). No imports beyond the audit: it runs at start and inside the files service.
import type { Database } from 'bun:sqlite'
import { audit } from '../admin/audit'

export type ShareReason = 'default' | 'created' | 'shared' | 'adopted' | 'repointed' | 'moved'

/** Set share_chats = 1 on team projects that have it off (all of them, or only `ids`); returns how many changed. */
export function markTeamShares(db: Database, actor: string | null, reason: ShareReason, ids?: readonly string[]): number {
  const rows = db.query(`SELECT id FROM projects WHERE share_chats = 0 AND folder_path <> 'users' AND substr(folder_path, 1, 6) <> 'users/'
    ${ids ? 'AND id IN (SELECT value FROM json_each(?))' : ''}`).all(...(ids ? [JSON.stringify(ids)] : [])) as { id: string }[]
  if (!rows.length) return 0
  db.transaction(() => {
    for (const r of rows) {
      db.query('UPDATE projects SET share_chats = 1 WHERE id = ?').run(r.id)
      audit(db, { actor, action: 'project.share_chats', target: r.id, detail: { on: true, reason } })
    }
  })()
  return rows.length
}
