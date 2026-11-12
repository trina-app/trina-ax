// What one viewer of the activity log may know of team projects (admin/audit.ts ProjectSight; docs/DECISIONS.md
// "Project contents only for members"): a project folder is hidden from them unless they read it now, by the same rules
// as the Files screen (the owner and admins only as members). The rules and the person are read once per answer.
import type { AppContext } from '../context'
import { atLeast } from '../policy/access'
import type { ProjectSight } from './audit'

export function auditSight(ctx: AppContext, viewerId: string): ProjectSight {
  const rules = ctx.files.rules()
  let me: ReturnType<AppContext['files']['principal']> | null = null
  try { me = ctx.files.principal(viewerId) } catch { me = null }
  const seen = new Map<string, boolean>()
  return {
    hides: (folder) => {
      let v = seen.get(folder)
      if (v === undefined) { v = !me || !atLeast(rules.access(me, folder.split('/').filter(Boolean)), 'read'); seen.set(folder, v) }
      return v
    },
    folderOf: (projectId) => (ctx.db.query('SELECT folder_path FROM projects WHERE id = ?').get(projectId) as { folder_path: string } | null)?.folder_path ?? null,
    turnFolder: (turnId) => (ctx.db.query('SELECT p.folder_path FROM turns t JOIN chats c ON c.id = t.chat_id JOIN projects p ON p.id = c.project_id WHERE t.id = ?').get(turnId) as { folder_path: string } | null)?.folder_path ?? null,
  }
}
