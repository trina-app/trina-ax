// A team project came back from the trash with its folder (team-files/service.ts restoreTrash: the project screen's
// Restore, routes/chats.ts restoreProject, or the folder restored on the Files trash). What its trash stopped starts
// again for the people who read it now:
// - their scheduled tasks that a due run paused while it was in the trash (chat/schedules.ts runDue
//   `schedule.project_gone`), never a task the person turned off themselves (QA TC-1014);
// - its shared chats come back into their open chat lists, as they left them with `chat.updated` 'deleted' when it went
//   to the trash (routes/chats.ts deleteProject; QA TC-1015).
// Never throws: the restore is done already.
import type { AppContext } from '../context'
import { getChatRuntime } from './runtime'
import { Audiences } from './shared'

export function projectsRestored(ctx: AppContext, projectIds: readonly string[], o: { by: string; trashedAt: string }): void {
  if (!projectIds.length) return
  let rt: ReturnType<typeof getChatRuntime>
  try { rt = getChatRuntime(ctx) } catch { return }
  const aud = new Audiences(ctx.db, ctx.files)
  for (const id of projectIds) {
    try {
      const p = rt.store.projectRow(id)
      if (!p || p.trashed_with !== null) continue
      for (const uid of aud.of(p)) {
        try { rt.schedules.resumeForProject(uid, id, new Date(), { pausedSince: o.trashedAt, via: 'project_restored' }) } catch (e) { ctx.log.warn('paused project tasks not resumed', { err: e }) }
      }
      const shared = ctx.db.query('SELECT id FROM chats WHERE project_id = ? AND shared_at IS NOT NULL AND deleted_at IS NULL').all(id) as { id: string }[]
      // publishChat sends a shared chat to everyone who sees its project now, each as they see it
      for (const c of shared) rt.publishChat(o.by, c.id, 'restored')
    } catch (e) { ctx.log.warn('project restore follow-up failed', { err: e }) }
  }
}
