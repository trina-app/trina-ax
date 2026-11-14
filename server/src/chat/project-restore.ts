// A team project came back from the trash with its folder (team-files/service.ts restoreTrash: the project screen's
// Restore, routes/chats.ts restoreProject, or the folder restored on the Files trash). What its trash stopped starts
// again for the people who read it now (also after an admin points a project in the trash at a folder, routes/chats.ts
// updateProject):
// - their scheduled tasks that a due run paused while it was in the trash (chat/schedules.ts runDue
//   `schedule.project_gone`), never a task the person turned off themselves (QA TC-1014);
// - its shared chats come back into their open chat lists, as they left them with `chat.updated` 'deleted' when it went
//   to the trash (routes/chats.ts deleteProject; QA TC-1015);
// - its guests whom the trash switched off, while they are still in it and no admin switched them by hand since
//   (admin/guests.ts returnGuestsWithPlace; QA TC-2239).
// Never throws: the restore is done already.
import type { AppContext } from '../context'
import { getChatRuntime } from './runtime'
import { Audiences } from './shared'

export function projectsRestored(ctx: AppContext, projectIds: readonly string[], o: { by: string; trashedAt: string | null }): void {
  if (!projectIds.length) return
  try {
    // required lazily: admin/guests reaches admin/users, which imports the chat runtime
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { returnGuestsWithPlace } = require('../admin/guests') as typeof import('../admin/guests')
    returnGuestsWithPlace(ctx, projectIds.map((id) => ({ kind: 'project' as const, id })), o.by)
  } catch (e) { ctx.log.warn('guests not switched on with their project', { err: e }) }
  let rt: ReturnType<typeof getChatRuntime>
  try { rt = getChatRuntime(ctx) } catch { return }
  const aud = new Audiences(ctx.db, ctx.files)
  for (const id of projectIds) {
    try {
      const p = rt.store.projectRow(id)
      if (!p || p.trashed_with !== null) continue
      // (when it went to the trash is unknown: no task is turned on, rather than one paused before it)
      for (const uid of o.trashedAt ? aud.of(p) : []) {
        try { rt.schedules.resumeForProject(uid, id, new Date(), { pausedSince: o.trashedAt!, via: 'project_restored' }) } catch (e) { ctx.log.warn('paused project tasks not resumed', { err: e }) }
      }
      const shared = ctx.db.query('SELECT id FROM chats WHERE project_id = ? AND shared_at IS NOT NULL AND deleted_at IS NULL').all(id) as { id: string }[]
      // publishChat sends a shared chat to everyone who sees its project now, each as they see it
      for (const c of shared) rt.publishChat(o.by, c.id, 'restored')
    } catch (e) { ctx.log.warn('project restore follow-up failed', { err: e }) }
  }
}
