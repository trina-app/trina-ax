// Leaving a team project (docs/DECISIONS.md "Leaving a project"; QA TC-1020): a member takes themselves out of a project
// in projects/<name>. Their own rule on its folder goes; when a group (or a role or everyone rule) would still let them
// in, a "no access" rule of their own keeps it from doing so (a person's rule decides before a group's:
// policy/access.ts), and the group keeps the project for everyone else in it. The members screen shows that rule as
// "Marketing · except Kim" (chat/project-access.ts isException). Everything after the save is what an admin taking them
// out does: the folder.rules audit, afterAccessChange (sessions, notices, shared chats out of their lists); their
// scheduled tasks there pause at their next run (chat/schedules.ts runDue). Their private chats there move out to their
// own chats, so they keep them; their shared chats stay for the others. The creator may leave too: the project forgets
// its creator (created_by NULL), so no save puts their rule back and they have no creator's powers there any more.
// The last person who reads it may not leave (the owner and admins who manage it without being members do not count).
import fs from 'node:fs'
import path from 'node:path'
import type { FolderRuleInput, Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { fail } from '../http/errors'
import { audit } from '../admin/audit'
import { withRules } from '../admin/access-edit'
import { afterAccessChange, captureState, ensureFolderRow, isProjectsFolder, replaceRules, rulesOf } from '../admin/folders'
import { atLeast, type Principal } from '../policy/access'
import { isPersonalFolder } from './projects'
import type { Audiences } from './shared'
import type { ProjectRow } from './store'
import { getChatRuntime } from './runtime'
import { tr } from './i18n'

const segsOf = (p: string) => (p === '' ? [] : p.split('/'))
const FLOOR = { subjectType: 'everyone', subjectId: null, access: 'none' } as FolderRuleInput

/** A team project in projects/<name> whose folder is in place: the only kind one leaves. */
function leavable(ctx: AppContext, r: Pick<ProjectRow, 'folder_path' | 'trashed_with'>): boolean {
  if (!isProjectsFolder(r.folder_path) || r.trashed_with !== null) return false
  try { return fs.lstatSync(path.join(ctx.files.fx.root, ...segsOf(r.folder_path))).isDirectory() } catch { return false }
}

/** Project.leave for `p`, who reads `r`: 'yes', 'last' (nobody else reads it), or nothing (not a project one leaves). */
export function leaveState(ctx: AppContext, r: ProjectRow, p: Principal, aud: Audiences): { leave?: 'yes' | 'last' } {
  if (!leavable(ctx, r)) return {}
  const people = aud.of(r)
  if (!people.includes(p.id)) return {}
  return { leave: people.some((id) => id !== p.id) ? 'yes' : 'last' }
}

/** The folder's rules after `userId` leaves: their own rules out, an exception when something else still lets them in. */
export function rulesAfterLeave(current: readonly FolderRuleInput[], stillReads: (next: readonly FolderRuleInput[]) => boolean, userId: string): FolderRuleInput[] {
  const next = current.filter((x) => !(x.subjectType === 'user' && x.subjectId === userId))
  // (an older folder without an everyone rule: the floor, so nothing above lets anyone in when the last rule goes)
  if (!next.some((x) => x.subjectType === 'everyone')) next.push(FLOOR)
  if (stillReads(next)) next.push({ subjectType: 'user', subjectId: userId, access: 'none' } as FolderRuleInput)
  return next
}

/** POST /api/projects/:id/leave (the caller reads `r`: checked by the route, 404 otherwise). */
export function leaveProject(ctx: AppContext, r: ProjectRow, p: Principal, locale: Locale): { movedChats: number } {
  const db = ctx.db
  if (isPersonalFolder(r.folder_path)) fail('conflict', tr('projectLeavePersonal', locale), { params: { reason: 'project_personal' } })
  if (!leavable(ctx, r)) fail('conflict', tr('projectLeaveNotHere', locale), { params: { reason: 'project_not_leavable' } })
  const segs = segsOf(r.folder_path)
  const before = captureState(db)
  if (!atLeast(before.rules.access(p, segs), 'read')) fail('not_found')
  const row = ensureFolderRow(db, r.folder_path)
  const current = rulesOf(db, row.id)
  const next = rulesAfterLeave(current, (n) => atLeast(withRules(before.rules, r.folder_path, n).access(p, segs), 'read'), p.id)
  const after = withRules(before.rules, r.folder_path, next)
  if (!before.principals.some((x) => x.id !== p.id && atLeast(after.access(x, segs), 'read')))
    fail('conflict', tr('projectLeaveLast', locale), { params: { reason: 'project_last_member' } })
  const rt = getChatRuntime(ctx)
  // their private chats in it (in their trash too): out to their own chats, an answer running there stopped first
  const mine = (db.query('SELECT id, deleted_at FROM chats WHERE project_id = ? AND user_id = ? AND shared_at IS NULL').all(r.id, p.id) as { id: string; deleted_at: string | null }[])
  for (const x of mine) if (rt.activeTurn(x.id)) rt.stopChat(x.id)
  const creator = r.created_by === p.id
  const exception = next.some((x) => x.subjectType === 'user' && x.subjectId === p.id)
  db.transaction(() => {
    replaceRules(db, row.id, next, p.id)
    if (creator) db.query('UPDATE projects SET created_by = NULL WHERE id = ?').run(r.id)
    if (mine.length) db.query(`UPDATE chats SET project_id = NULL WHERE id IN (${mine.map(() => '?').join(',')})`).run(...mine.map((x) => x.id))
    // as a removal from the members screen is audited (the rules before and after), and the leave itself
    audit(db, { actor: p.id, action: 'folder.rules', target: r.folder_path, detail: { before: current, after: next, via: 'leave', projectId: r.id, self: true } })
    audit(db, { actor: p.id, action: 'project.leave', target: r.id, detail: { name: r.name, folderPath: r.folder_path, ...(exception ? { exception: true } : {}), ...(creator ? { creator: true } : {}), ...(mine.length ? { movedChats: mine.length } : {}) } })
  })()
  afterAccessChange(ctx, before, { actor: p.id, target: r.folder_path, via: 'leave' })
  for (const x of mine) if (!x.deleted_at) { try { rt.publishChat(p.id, x.id, 'updated') } catch (e) { ctx.log.warn('chat update after leaving a project failed', { err: e }) } }
  return { movedChats: mine.length }
}
