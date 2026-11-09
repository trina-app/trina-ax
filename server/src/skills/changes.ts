// Change tracking of skills/ (docs/DECISIONS.md "팀 스킬 관리"), of each group's groups/<folder>/skills/
// (docs/DECISIONS.md "Group skills": the audit row names the group) and of each project's projects/<name>/skills/
// (docs/DECISIONS.md "Project skills": the row names the project, and its creator hears of it too while they can read
// the project's folder): every create / edit / move / delete / restore
// there, by a person on the file screen or by the AI in a chat turn, is written to the audit log (who, which file,
// AI or not) and announced to the owner and admins (an in-app banner with a link to the file's version history,
// where the previous version can be restored). Hooked on files/store.ts fileEvent: every team-file change records
// one, so none is missed.
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { Locale, type Page, type SkillChange } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { audit, redactPersonal } from '../admin/audit'
import { teamDefaultLocale } from '../admin/settings'
import { onFileEvent, readRegular, type FileEventInput } from '../files/store'
import { groupOfFolder, projectOfFolder, skillFileKind, SKILL_FILE_MAX_BYTES } from '../chat/skills'
import { verifyChain } from '../policy/resolve'
import { atLeast } from '../policy/access'
import { inSkills, skillRootOf } from './guard'
import { st } from './text'

export const SKILL_CHANGE_ACTION = 'skills.change'

interface ChangeDetail { change: SkillChange['change']; from: string | null; byAi: boolean; turnId: string | null; kind: SkillChange['kind']; tool: string | null; group?: { id: string | null; name: string }; project?: { id: string | null; name: string } }

const parse = (d: unknown): Record<string, unknown> => (d && typeof d === 'object' ? d as Record<string, unknown> : {})

/** What a file event means for skills/, or null when it is not a change there. */
export function skillChangeOf(e: FileEventInput): (ChangeDetail & { path: string }) | null {
  const d = parse(e.detail)
  const movedFrom = typeof d.movedFrom === 'string' ? d.movedFrom : null
  const movedTo = typeof d.movedTo === 'string' ? d.movedTo : null
  // a skill copied from another level (skills/move.ts runCopy): a new skill, its `from` the original
  const copiedFrom = typeof d.copiedFrom === 'string' ? d.copiedFrom : null
  const folder = d.folder === true
  const tool = typeof d.tool === 'string' ? d.tool : null
  const base = { byAi: e.turnId !== null, turnId: e.turnId, tool }
  if (e.action === 'delete' && movedTo) {
    // a move: the 'create' at the new place records it, unless the new place is outside skills/
    if (!inSkills(e.path) || inSkills(movedTo)) return null
    return { ...base, path: e.path, change: 'move', from: e.path, kind: folder ? 'folder' : null }
  }
  if (!inSkills(e.path)) return null
  switch (e.action) {
    case 'create': case 'upload':
      if (movedFrom) return { ...base, path: e.path, change: 'move', from: movedFrom, kind: folder ? 'folder' : null }
      return { ...base, path: e.path, change: 'create', from: copiedFrom, kind: folder ? 'folder' : null }
    case 'update': return { ...base, path: e.path, change: 'update', from: null, kind: null }
    case 'delete': return { ...base, path: e.path, change: 'delete', from: null, kind: folder ? 'folder' : null }
    case 'restore': return { ...base, path: e.path, change: 'restore', from: null, kind: folder ? 'folder' : null }
    default: return null // conflict (the copy gets its own 'create'), rejected (nothing changed)
  }
}

/** Use the same entry-point/resource classification as discovery and the confirmation card. */
function kindOf(ctx: AppContext, rel: string): SkillChange['kind'] {
  if (!rel.toLowerCase().endsWith('.md')) return 'other'
  try {
    verifyChain(ctx.files.fx.root, rel.split('/'))
    const { bytes } = readRegular(path.join(ctx.files.fx.root, ...rel.split('/')), SKILL_FILE_MAX_BYTES)
    return skillFileKind(ctx.files.fx.root, rel, bytes.toString('utf8'))
  } catch { return null }
}

/** History link for a changed file (the file screen opens its version history), the files trash for a deleted one
 * (파일 › 휴지통, web/src/lib/nav.ts FILES_TRASH; `/trash` is the deleted AI chats). */
export function historyLink(rel: string, change: SkillChange['change'], kind: SkillChange['kind']): string {
  if (change === 'delete') return '/files?view=trash'
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
  if (kind === 'folder') return `/files?path=${encodeURIComponent(rel)}`
  return `/files?path=${encodeURIComponent(dir)}&select=${encodeURIComponent(rel)}&history=${encodeURIComponent(rel)}`
}

/** Owners and admins who should hear about it (active, not the person who made the change), and for a project's skill
 * its creator while they can read the project's folder. */
function watchers(ctx: AppContext, except: string, project?: { createdBy: string | null; folder: string }): { id: string; locale: Locale }[] {
  const db = ctx.db
  const def = teamDefaultLocale(db)
  const rows = db.query("SELECT id, locale FROM users WHERE role IN ('owner', 'admin') AND status = 'active' AND deleted_at IS NULL AND id <> ?").all(except) as { id: string; locale: string }[]
  const creator = project?.createdBy && project.createdBy !== except && !rows.some((r) => r.id === project.createdBy)
    ? db.query("SELECT id, locale FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL").get(project.createdBy) as { id: string; locale: string } | null : null
  let reads = false
  if (creator) { try { reads = atLeast(ctx.files.rules().access(ctx.files.principal(creator.id), project!.folder.split('/')), 'read') } catch { reads = false } }
  return [...rows, ...(creator && reads ? [creator] : [])].map((u) => ({ id: u.id, locale: Locale.safeParse(u.locale).success ? (u.locale as Locale) : def }))
}

export function recordSkillChange(ctx: AppContext, e: FileEventInput): void {
  const c = skillChangeOf(e)
  if (!c) return
  const kind = c.kind ?? (c.change === 'delete' ? null : kindOf(ctx, c.path))
  record(ctx, e.userId, c.path, { change: c.change, from: c.from, byAi: c.byAi, turnId: c.turnId, kind, tool: c.tool })
}

/** One skill change: the audit row (with the group or project of its skills folder) and a notice to the owner, the
 * admins and a project's creator. `extra`: more for the row (a carried skill's on / off). */
function record(ctx: AppContext, actor: string, at: string, d: Omit<ChangeDetail, 'group' | 'project'>, extra: Record<string, unknown> = {}, owner?: SkillOwner): void {
  // a group's skills folder: the group by its name now (docs/DECISIONS.md "Group skills"); a folder no group has any
  // more is still recorded, by its folder
  // a moved file is recorded where it went, unless it left the skill roots (then where it was)
  const o = owner ?? skillOwner(ctx, at)
  const group = o.group ?? null
  const live = o.live ?? null
  const project = o.project ?? null
  const detail: ChangeDetail = { ...d, ...(group ? { group } : {}), ...(project ? { project } : {}) }
  audit(ctx.db, { actor, action: SKILL_CHANGE_ACTION, target: at, detail: { ...detail, ...extra } as unknown as Record<string, unknown> })
  const who = (ctx.db.query('SELECT name FROM users WHERE id = ?').get(actor) as { name: string } | null)?.name ?? actor
  const link = historyLink(at, d.change, d.kind)
  const people = watchers(ctx, actor, live ? { createdBy: live.createdBy, folder: live.folder } : undefined)
  // after the change is committed (fileEvent can run inside a transaction)
  queueMicrotask(() => {
    for (const u of people) {
      const p = redactPersonal(at, u.id)
      const vars = { path: p, who, ai: d.byAi ? st('viaAi', u.locale) : '' }
      try {
        const message = group ? st('changedGroup', u.locale, { ...vars, group: group.name }) : project ? st('changedProject', u.locale, { ...vars, project: project.name }) : st('changed', u.locale, vars)
        ctx.services.realtime.publish(u.id, { type: 'notice', data: { level: 'info', code: 'skill_changed', message, link } })
      } catch (err) { ctx.log.warn('skill change notice failed', { err }) }
    }
  })
}

/** The group or project whose skills folder `rel` is in, as it is now (a folder no group or live project has is still
 * named, by its folder); `live`: the live project, for its creator's notice. */
export interface SkillOwner { group?: { id: string | null; name: string }; project?: { id: string | null; name: string }; live?: { createdBy: string | null; folder: string } }
export function skillOwner(ctx: AppContext, rel: string): SkillOwner {
  const root = skillRootOf(rel)
  if (root?.kind === 'group') return { group: groupOfFolder(ctx.db, root.folder) ?? { id: null, name: root.folder.split('/')[1]! } }
  if (root?.kind !== 'project') return {}
  const live = projectOfFolder(ctx.db, root.folder)
  return { project: { id: live?.id ?? null, name: live?.name ?? root.folder.split('/')[1]! }, ...(live ? { live: { createdBy: live.createdBy, folder: live.folder } } : {}) }
}

/** A skill below a moved folder whose place as a skill changed with it (team-files/service.ts carriedSkills): `off` it
 * left the skill roots (a project's folder moved out of projects/, a group's out of groups/), `on` it came into one,
 * `moved` it stays one at another path (a group's or project's folder renamed). `owner`: for `off`, whose skills folder
 * it was, read before the move (the project or group follows its folder). */
export interface CarriedSkill { from: string; to: string; state: 'on' | 'off' | 'moved'; owner?: SkillOwner }

/**
 * Each skill a folder move carried (docs/DECISIONS.md "Skill folders: the AI's file actions"): a skill change, recorded
 * where it went (where it was when it left the skill roots), with where it came from and whether it stopped or started
 * applying, and the same notice as any other skill change. The Files screen's moves and the AI's alike: before, only a
 * project's skills switching on were recorded, without a notice, and skills switched off by a move left no trace.
 */
export function recordCarriedSkills(ctx: AppContext, actor: string, items: readonly CarriedSkill[], o: { turnId: string | null; tool: string | null }): void {
  for (const i of items) {
    try {
      record(ctx, actor, i.state === 'off' ? i.from : i.to, { change: 'move', from: i.from, byAi: o.turnId !== null, turnId: o.turnId, kind: i.to.endsWith('/SKILL.md') ? 'skill' : null, tool: o.tool },
        i.state === 'off' ? { switchedOff: 'folder_move', to: i.to } : i.state === 'on' ? { switchedOn: 'folder_move' } : {}, i.owner)
    } catch (err) { ctx.log.error('recording a carried skill failed', { err, path: i.to }) }
  }
}

/** Start tracking skills/ changes for this server instance (called once from createContext). */
export function trackSkillChanges(ctx: AppContext): void {
  onFileEvent(ctx.db, (e) => {
    try { recordSkillChange(ctx, e) } catch (err) { ctx.log.error('recording a team skill change failed', { err, path: e.path }) }
  })
}

/** Admin > 팀 스킬: the changes, newest first. Paths inside someone else's personal folder (a file moved in from
 * there) show only as users/<id>/…, like the audit list. */
export function listSkillChanges(db: Database, viewer: string, o: { cursor?: string; limit?: number }): Page<SkillChange> {
  const limit = Math.min(Math.max(o.limit ?? 50, 1), 200)
  const before = o.cursor && /^\d+$/.test(o.cursor) ? Number(o.cursor) : null
  const rows = db.query(`SELECT a.id, a.at, a.actor_id, u.name AS actor_name, a.target, a.detail FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
    WHERE a.action = ? ${before !== null ? 'AND a.id < ?' : ''} ORDER BY a.id DESC LIMIT ?`)
    .all(...(before !== null ? [SKILL_CHANGE_ACTION, before, limit + 1] : [SKILL_CHANGE_ACTION, limit + 1])) as { id: number; at: string; actor_id: string | null; actor_name: string | null; target: string; detail: string | null }[]
  const page = rows.slice(0, limit)
  return {
    items: page.map((r) => {
      let d: Partial<ChangeDetail> = {}
      try { d = JSON.parse(r.detail ?? '{}') } catch {}
      return {
        id: String(r.id), at: r.at,
        actor: r.actor_id ? { id: r.actor_id, name: r.actor_name ?? r.actor_id } : null,
        path: r.target, change: d.change ?? 'update', from: d.from ? redactPersonal(d.from, viewer) : null,
        byAi: !!d.byAi, kind: d.kind ?? null, ...(d.group && typeof d.group.name === 'string' ? { group: { id: d.group.id ?? null, name: d.group.name } } : {}),
        ...(d.project && typeof d.project.name === 'string' ? { project: { id: d.project.id ?? null, name: d.project.name } } : {}),
      }
    }),
    nextCursor: rows.length > limit ? String(page[page.length - 1]!.id) : null,
  }
}
