// Projects from before the update (docs/DECISIONS.md "Projects from before the update: one card, Add me to these", QA
// TC-360). 0.4.0 gave the owner and admins every team project in projects/<name> by their role; since "Project
// contents only for members" they read one only as its member. The owner or an admin who lost projects that way gets ONE
// card on Admin › Home naming them, with "Add me to these" (a member of all of them at once, audited, their members
// told) and a dismiss. Members never see it.
//
// What 0.4.0 showed is worked out each time (only who was staff at T and the dismissal are stored): the update's first start is the time of the `projectsMembersOnly.v1`
// setting (chat/members-only-once.ts), T. The person: the owner or an admin now, an account from before T, whose role
// nobody changed since T (a role change, a handover: they may not have been one then). The projects: team projects in
// projects/<name> (any letter case, as the zone) made before T, folder in place, that the person may manage, does not
// read now, and did not join and leave since T (then leaving was someone's choice, not the update's). Only the
// dismissal is kept (suggestion_dismissals, one key; per person, every device). A project joined, trashed or deleted
// drops off by itself.
import type { Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { audit } from '../admin/audit'
import { getSetting, setSetting } from '../admin/settings'
import { inProjectZone, type Principal } from '../policy/access'
import { canSeeProject, mayManageProject } from './projects'
import { accessEditable, planAccess, projectAccess, saveParticipants } from './project-access'
import { PROJECT_COLS, type ProjectRow } from './store'

/** The setting chat/members-only-once.ts writes at the update's first start (its time). */
const UPDATED_AT = 'projectsMembersOnly.v1'
/** The card's dismissal, per person (suggestion_dismissals: a per-person "closed, never again" key). */
export const UPDATE_NOTICE_KEY = 'members_only_update'
/** The ids of the owner and admins at T, written once (rememberUpdateStaff). */
const UPDATE_STAFF = 'projectsMembersOnly.staff'

const isStaff = (p: Principal) => p.role === 'owner' || p.role === 'admin'

/** The person was the owner or an admin at T: an account from before it, and no role change of theirs since. */
function staffAtUpdate(ctx: AppContext, userId: string, at: string): boolean {
  const u = ctx.db.query("SELECT created_at FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL").get(userId) as { created_at: string } | null
  if (!u || !(u.created_at < at)) return false
  const changed = ctx.db.query(`SELECT 1 FROM audit_log WHERE target = ? AND at >= ? AND (action = 'owner.transfer'
    OR (action = 'user.update' AND json_valid(detail) AND json_extract(detail, '$.role') IS NOT NULL)) LIMIT 1`).get(userId, at)
  return !changed
}

/** Once, at a start after T: who was the owner or an admin then (staffAtUpdate, while the audit still has the rows),
 * kept so the card does not change when they age out. Never throws. */
export function rememberUpdateStaff(ctx: AppContext): void {
  try {
    const at = getSetting<string>(ctx.db, UPDATED_AT)
    if (typeof at !== 'string' || !at || getSetting(ctx.db, UPDATE_STAFF) !== undefined) return
    const ids = (ctx.db.query("SELECT id FROM users WHERE role IN ('owner', 'admin')").all() as { id: string }[]).map((u) => u.id).filter((id) => staffAtUpdate(ctx, id, at))
    setSetting(ctx.db, UPDATE_STAFF, ids)
  } catch (e) { ctx.log.warn('who was an admin at the update not kept', { err: e }) }
}

/** They read it since T and lost it again: a join recorded for them, or a members save after T that took out a rule
 * naming them. Either way someone chose it after the update. */
function leftSince(ctx: AppContext, userId: string, r: ProjectRow, at: string): boolean {
  // they left it with Leave project (chat/project-leave.ts): not offered again
  if (ctx.db.query('SELECT 1 FROM project_leavers WHERE project_id = ? AND user_id = ?').get(r.id, userId)) return true
  if (ctx.db.query("SELECT 1 FROM audit_log WHERE action = 'project.member_gained' AND target = ? AND json_valid(detail) AND json_extract(detail, '$.userId') = ? LIMIT 1").get(r.id, userId)) return true
  const saves = ctx.db.query("SELECT detail FROM audit_log WHERE action = 'folder.rules' AND target = ? AND at >= ?").all(r.folder_path, at) as { detail: string | null }[]
  const names = (list: unknown) => Array.isArray(list) && list.some((x) => x && x.subjectType === 'user' && x.subjectId === userId && x.access !== 'none')
  for (const s of saves) {
    let d: { before?: unknown; after?: unknown } | null = null
    try { d = JSON.parse(s.detail ?? 'null') } catch { d = null }
    if (d && names(d.before) && !names(d.after)) return true
  }
  return false
}

/** The projects on the card for this person (empty: no card). */
export function updateNoticeProjects(ctx: AppContext, p: Principal): ProjectRow[] {
  if (!isStaff(p) || p.system) return []
  const at = getSetting<string>(ctx.db, UPDATED_AT)
  if (typeof at !== 'string' || !at) return []
  if (ctx.db.query('SELECT 1 FROM suggestion_dismissals WHERE user_id = ? AND key = ?').get(p.id, UPDATE_NOTICE_KEY)) return []
  const kept = getSetting<unknown>(ctx.db, UPDATE_STAFF)
  if (Array.isArray(kept) ? !kept.includes(p.id) : !staffAtUpdate(ctx, p.id, at)) return []
  // made before T, or (no creator: an adopted leftover folder) on a folder row from before T
  const rows = ctx.db.query(`SELECT ${PROJECT_COLS.split(', ').map((c) => `p.${c}`).join(', ')} FROM projects p WHERE p.trashed_with IS NULL AND (p.created_at < ?
    OR (p.created_by IS NULL AND EXISTS(SELECT 1 FROM folders f WHERE f.path = p.folder_path AND f.created_at < ?)))
    ORDER BY p.name COLLATE NOCASE, p.id`).all(at, at) as ProjectRow[]
  const seen = new Set<string>()
  return rows.filter((r) => {
    const segs = r.folder_path.split('/')
    // (two older rows on one folder: one entry; a folder that is gone or whose settings Projects cannot change: Add me
    // cannot work there either, so it is not offered)
    const key = r.folder_path.normalize('NFC').toLowerCase()
    if (seen.has(key)) return false
    const on = segs.length === 2 && inProjectZone(segs) && mayManageProject(ctx.files, p, r) && accessEditable(r, ctx.files, p) && !canSeeProject(ctx.files, p, r) && !leftSince(ctx, p.id, r, at)
    if (on) seen.add(key)
    return on
  })
}

/** "Add me to these": the person becomes a member of every project on their card, each saved as the members dialog's
 * Add me saves it (saveParticipants: the rules hash, the `folder.rules` audit with `self`, `project.member_gained`,
 * its members told), when the dry run says the only change is the person, then one `projects.update_joined` row. A project that cannot be saved is skipped and counted; the
 * card keeps it (the dismiss takes it away). Only projects on the card: nobody gains more than 0.4.0 gave them. */
export function joinUpdateNoticeProjects(ctx: AppContext, user: { id: string; name: string }, locale: Locale): { joined: number; skipped: number } {
  const p = ctx.files.principal(user.id)
  const list = updateNoticeProjects(ctx, p)
  const joined: string[] = []
  const skipped: string[] = []
  for (const r of list) {
    try {
      const a = projectAccess(ctx, r, p)
      const participants = [
        ...a.participants.filter((x) => !x.creator && !(x.subjectType === 'user' && x.subjectId === user.id)).map(({ subjectType, subjectId }) => ({ subjectType, subjectId })),
        { subjectType: 'user' as const, subjectId: user.id },
      ]
      // only when the one change is "and me": nobody loses it (the floor "everyone else: none" a 0.4.0 folder lacks would
      // cut out people who read it through a setting above it), nobody else gains it, and no creator's rule is put back.
      // Anything else is the members dialog's, with its preview: skipped, and the card says to open it in Projects
      const plan = planAccess(ctx, p, r, participants, locale)
      if (plan.lost.length || plan.gained.length !== 1 || plan.gained[0] !== user.id || plan.restoresCreator) { skipped.push(r.id); continue }
      saveParticipants(ctx, r, p, user, { participants, expectedHash: plan.rulesHash }, locale)
      if (canSeeProject(ctx.files, ctx.files.principal(user.id), r)) joined.push(r.id)
      else skipped.push(r.id)
    } catch (e) {
      ctx.log.info('a project from before the update was not joined', { project: r.id, err: e instanceof Error ? e.message : String(e) })
      skipped.push(r.id)
    }
  }
  if (list.length) audit(ctx.db, { actor: user.id, action: 'projects.update_joined', target: null, detail: { joined, skipped } })
  return { joined: joined.length, skipped: skipped.length }
}

/** The card's dismiss: never again for this person, on any device. */
export function dismissUpdateNotice(ctx: AppContext, userId: string): void {
  ctx.db.query('INSERT INTO suggestion_dismissals (user_id, key, dismissed_at) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO NOTHING').run(userId, UPDATE_NOTICE_KEY, new Date().toISOString())
}
