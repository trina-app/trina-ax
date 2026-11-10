// Who sees a team project (docs/DECISIONS.md "Projects live only in projects/"). A team project's folder is
// projects/<name>; who sees the project is who can read that folder, so its "participants" are the folder's rules: each
// participant (a group or a person) and the creator get write, everyone else none (the floor, so an admin's root
// "everyone: read" cannot open it). The project's edit screen and Admin › Folder permissions both write those rules,
// through the same path (replaceRules with the rules hash check, captureState / afterAccessChange, the audit).
// Rules the project screen does not change (read-only people or groups, roles, an everyone rule other than the floor,
// rules on folders inside it) stay as they are and are shown read-only.
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import type { FolderRuleInput, Locale, ProjectAccess, ProjectAccessPreview, ProjectOtherRule, ProjectParticipant } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { fail } from '../http/errors'
import { atLeast, loadPrincipal, RuleSet, type Principal } from '../policy/access'
import { hiddenEntry, badSegment } from '../policy/names'
import { rulesHash, withRules } from '../admin/access-edit'
import { afterAccessChange, captureState, ensureFolderRow, getFolderByPath, isProjectsFolder, replaceRules, resolveFolderPath, rulesOf, validateRules } from '../admin/folders'
import { getTeamSettings } from '../admin/settings'
import { audit } from '../admin/audit'
import { activePrincipals, Audiences } from './shared'
import { mayEditProject, projectFolderName, projectPaths } from './projects'
import type { ProjectRow } from './store'
import { tr } from './i18n'
import { skillsUnder } from '../skills/switch-on'

const isAdminRole = (p: Pick<Principal, 'role'>) => p.role === 'owner' || p.role === 'admin'
const segsOf = (p: string) => (p === '' ? [] : p.split('/'))
const FLOOR: FolderRuleInput = { subjectType: 'everyone', subjectId: null, access: 'none' } as FolderRuleInput

export { isProjectsFolder }

/** May this person make a team project (a new projects/<name>)? The owner and admins always; members unless the team
 * lets only admins (TeamSettings.projectCreators). */
export const mayCreateTeamProject = (db: Database, p: Principal): boolean => isAdminRole(p) || getTeamSettings(db).projectCreators !== 'admins'
export function assertMayCreateTeamProject(db: Database, p: Principal, locale: Locale): void {
  if (!mayCreateTeamProject(db, p)) fail('forbidden', tr('projectsAdminsOnly', locale), { params: { reason: 'projects_admins_only' } })
}

const key = (x: { subjectType: string; subjectId: string | null }) => `${x.subjectType}:${x.subjectId ?? ''}`

/**
 * The participants a person names, checked and without repeats: admins any group there is and any active person;
 * members their own groups and active people (a group already on the folder, `keep`, may stay: an admin added it).
 * Disabled people already on the folder may stay too (they see it again when enabled).
 */
export function checkParticipants(db: Database, p: Principal, list: readonly ProjectParticipant[], locale: Locale, keep: ReadonlySet<string> = new Set()): ProjectParticipant[] {
  const out: ProjectParticipant[] = []
  const seen = new Set<string>()
  for (const [i, x] of list.entries()) {
    const k = key(x)
    if (seen.has(k)) continue
    seen.add(k)
    if (x.subjectType === 'group') {
      const there = !!db.query('SELECT 1 FROM groups WHERE id = ?').get(x.subjectId)
      const mine = isAdminRole(p) || p.groups.includes(x.subjectId)
      if (!there || (!mine && !keep.has(k))) fail('validation', tr('projectParticipantGroup', locale), { fields: { [`body.participants.${i}.subjectId`]: 'not a group you can choose' } })
    } else {
      const u = db.query('SELECT status FROM users WHERE id = ? AND deleted_at IS NULL').get(x.subjectId) as { status: string } | null
      if (!u || (u.status !== 'active' && !keep.has(k))) fail('validation', tr('projectParticipantPerson', locale), { fields: { [`body.participants.${i}.subjectId`]: 'not an active person' } })
    }
    out.push({ subjectType: x.subjectType, subjectId: x.subjectId })
  }
  return out
}

/** A participant rule: write for a group or a person. Everything else on the folder is an "other" rule. */
const isParticipantRule = (r: FolderRuleInput) => (r.subjectType === 'group' || r.subjectType === 'user') && r.access === 'write'
const isFloor = (r: FolderRuleInput) => r.subjectType === 'everyone' && r.access === 'none'

/** The creator, while their account is there (a deleted one's rule went with it: the project fails closed to admins). */
function creatorOf(db: Database, r: Pick<ProjectRow, 'created_by'>): string | null {
  if (!r.created_by) return null
  return db.query('SELECT 1 FROM users WHERE id = ? AND deleted_at IS NULL').get(r.created_by) ? r.created_by : null
}

/**
 * The folder's rules after a change of participants: the participants and the creator write, the rules the project
 * screen does not change as they are, and the floor when the folder has no everyone rule of its own.
 */
export function participantRules(current: readonly FolderRuleInput[], participants: readonly ProjectParticipant[], creator: string | null): FolderRuleInput[] {
  const other = current.filter((r) => !isParticipantRule(r) && !isFloor(r))
  const taken = new Set(other.map(key))
  const out: FolderRuleInput[] = []
  const seen = new Set<string>()
  const add = (x: ProjectParticipant) => {
    const k = key(x)
    if (seen.has(k) || taken.has(k)) return
    seen.add(k)
    out.push({ subjectType: x.subjectType, subjectId: x.subjectId, access: 'write' } as FolderRuleInput)
  }
  if (creator) add({ subjectType: 'user', subjectId: creator })
  for (const x of participants) add(x)
  out.push(...other)
  if (!other.some((r) => r.subjectType === 'everyone')) out.push(FLOOR)
  return out
}

/** The rules of a brand-new project folder: each participant and the creator write, everyone else none. */
export const newProjectRules = (participants: readonly ProjectParticipant[], creator: string): FolderRuleInput[] => participantRules([], participants, creator)

/**
 * Make a new team project folder projects/<name> as the system (members have no write on projects/; the caller was
 * checked before: mayCreateTeamProject). The name steps around folders on disk, folders rows (kept rules) and the
 * folders projects name ("-2"), so a new project never takes over an old folder's files or rules. Returns the actual
 * path and the absolute path to take away again when a later step fails.
 */
export function makeProjectFolder(ctx: AppContext, o: { id: string; name: string; locale: Locale }): { path: string; abs: string } {
  const root = ctx.files.fx.root
  fs.mkdirSync(path.join(root, 'projects'), { recursive: true, mode: 0o700 })
  const taken = [...(ctx.db.query('SELECT path FROM folders').all() as { path: string }[]).map((r) => r.path), ...projectPaths(ctx.db)]
  const name = projectFolderName(path.join(root, 'projects'), 'projects', taken, o.name, o.id)
  const want = `projects/${name}`
  // a folders row kept at or under that path (stepped around above; a guard against a row made in the meantime)
  if (ctx.db.query("SELECT 1 FROM folders WHERE path = ? OR substr(path, 1, length(?) + 1) = ? || '/' LIMIT 1").get(want, want, want)) fail('conflict', tr('projectFolderTaken', o.locale), { fields: { 'body.folderPath': 'taken' } })
  const made = resolveFolderPath(ctx, want, { create: true, locale: o.locale })
  if (!made.created) fail('conflict', tr('projectFolderTaken', o.locale), { fields: { 'body.folderPath': 'taken' } })
  return { path: made.path, abs: path.join(root, ...made.path.split('/')) }
}

/** Take a folder made by makeProjectFolder away again (its folders row and rules too). Call outside a transaction. */
export function unmakeProjectFolder(ctx: AppContext, made: { path: string; abs: string }): void {
  try { fs.rmSync(made.abs, { recursive: true, force: true }) } catch {}
  const f = getFolderByPath(ctx.db, made.path)
  if (f) ctx.db.transaction(() => { ctx.db.query('DELETE FROM folder_rules WHERE folder_id = ?').run(f.id); ctx.db.query('DELETE FROM folders WHERE id = ?').run(f.id) })()
}

/** The name of a rule's subject for the edit screen (a group's or a person's name; null for everyone and roles). */
function subjectName(db: Database, t: string, id: string | null): string | null {
  if (t === 'group') return (db.query('SELECT name FROM groups WHERE id = ?').get(id) as { name: string } | null)?.name ?? null
  if (t === 'user') return (db.query('SELECT name FROM users WHERE id = ?').get(id) as { name: string } | null)?.name ?? null
  return null
}

/**
 * The project's participants can be changed from its screen (and its folder trashed with it), by `p`: a team project
 * in projects/<name> in place. A member (its creator) only when the server made that folder for it (folder_made):
 * a project older builds made on an existing projects/<name> folder carries rules an admin set, which stay the
 * admins' (review: a member's older project on an admin's folder would otherwise hand them its rules).
 */
export const accessEditable = (r: Pick<ProjectRow, 'folder_path' | 'trashed_with' | 'folder_made'>, files: AppContext['files'], p: Principal): boolean => {
  if (!isProjectsFolder(r.folder_path) || r.trashed_with !== null) return false
  if (!isAdminRole(p) && r.folder_made !== 1) return false
  try { return fs.lstatSync(path.join(files.fx.root, ...r.folder_path.split('/'))).isDirectory() } catch { return false }
}

/**
 * What a team project's page says about its members to `p` (Project.membersEditable, Project.creatorChangesMembers):
 * whether `p` changes them (mayEditProject and accessEditable: a member's older project on an admin's folder is not
 * theirs to change, so it gets no 관리 that would end in "not editable"; review M6), and whether its creator does (their
 * account active, they can still write the folder, the folder theirs to change), so the hint names them only then: a
 * viewer learns those three things about the creator, nothing else. Nothing for a personal project.
 */
export function membersView(ctx: AppContext, r: ProjectRow, p: Principal, canEdit: boolean, creators?: Map<string, Principal | null>): { membersEditable?: boolean; creatorChangesMembers?: boolean } {
  if (r.folder_path === 'users' || r.folder_path.startsWith('users/')) return {}
  // (`creators`: the list's people, read once per request)
  const load = (id: string) => { if (!creators) return loadPrincipal(ctx.db, id); if (!creators.has(id)) creators.set(id, loadPrincipal(ctx.db, id)); return creators.get(id)! }
  const creator = r.created_by ? load(r.created_by) : null
  const byCreator = (who: Principal) => mayEditProject(ctx.files, who, r) && accessEditable(r, ctx.files, who)
  return { membersEditable: canEdit && accessEditable(r, ctx.files, p), creatorChangesMembers: !!creator && byCreator(creator) }
}

/**
 * GET /api/projects/:id/access: who sees a team project, as its edit screen shows it to `p` (its creator or an admin).
 * A member gets only the count for a project they may not change (its folder's rules are an admin's), and of the rules
 * on folders inside it only those of folders they can read (an admin's restricted folder inside is not named).
 */
export function projectAccess(ctx: AppContext, r: ProjectRow, p: Principal): ProjectAccess {
  const db = ctx.db
  const editable = accessEditable(r, ctx.files, p)
  const people = new Audiences(db, ctx.files).of(r).length
  const row = getFolderByPath(db, r.folder_path)
  const rules = row ? rulesOf(db, row.id) : []
  // (no rules hash either: it would let a member confirm a guessed set of an admin's rules)
  if (!editable && !isAdminRole(p)) return { editable, participants: [], otherRules: [], rulesHash: '', people }
  const participants = rules.filter(isParticipantRule).map((x) => ({
    subjectType: x.subjectType as 'group' | 'user', subjectId: x.subjectId!, name: subjectName(db, x.subjectType, x.subjectId) ?? '',
    ...(x.subjectType === 'user' && x.subjectId === r.created_by ? { creator: true } : {}),
  }))
  // the creator first, then groups, then people, each by name
  participants.sort((a, b) => Number(!!b.creator) - Number(!!a.creator) || (a.subjectType === b.subjectType ? a.name.localeCompare(b.name) : a.subjectType === 'group' ? -1 : 1))
  const otherRules: ProjectOtherRule[] = rules.filter((x) => !isParticipantRule(x) && !isFloor(x)).map((x) => ({ path: r.folder_path, subjectType: x.subjectType, subjectId: x.subjectId, name: subjectName(db, x.subjectType, x.subjectId), access: x.access }))
  // rules on folders inside it (an admin's sub-rules): shown, never changed here
  if (r.folder_path !== '') {
    const below = db.query("SELECT f.path, r.subject_type, r.subject_id, r.access FROM folder_rules r JOIN folders f ON f.id = r.folder_id WHERE substr(f.path, 1, length(?) + 1) = ? || '/' ORDER BY f.path, r.subject_type, r.subject_id")
      .all(r.folder_path, r.folder_path) as { path: string; subject_type: ProjectOtherRule['subjectType']; subject_id: string | null; access: ProjectOtherRule['access'] }[]
    const set = ctx.files.rules()
    for (const x of below) {
      // a member: only rules of folders they can read (one they can only list, for something readable below it, keeps
      // its rules to admins)
      if (!isAdminRole(p) && !atLeast(set.access(p, segsOf(x.path)), 'read')) continue
      otherRules.push({ path: x.path, subjectType: x.subject_type, subjectId: x.subject_id, name: subjectName(db, x.subject_type, x.subject_id), access: x.access })
    }
  }
  return { editable, participants, otherRules, rulesHash: rulesHash(rules), people }
}

/** At most this many entries are looked at when the widening confirm counts a project's files. */
const FILES_SCAN_MAX = 20_000
const WRITES = "('create','update','upload','restore')"

/**
 * What people who start to see a project would see there: its files (left out: its skills/ folder, counted as skills),
 * those that someone other than `caller` put there (by the last write recorded for the file, else for the nearest
 * folder above it inside the project: a copied folder; nothing recorded counts as someone else's), and its project
 * skills (each SKILL.md folder in skills/ that loads, skills/<name>/ or a folder below one, counted by path).
 */
function whatTheySee(ctx: AppContext, folder: string, caller: string, readable: (segs: string[]) => boolean): { files: number; othersFiles: number; skills: number; skillNames: string[] } {
  const root = ctx.files.fx.root
  const base = segsOf(folder)
  const writer = new Map<string, string>()
  for (const r of ctx.db.query(`SELECT path, user_id, MAX(id) AS id FROM file_events WHERE (path = ?1 OR substr(path, 1, length(?1) + 1) = ?1 || '/') AND action IN ${WRITES} GROUP BY path`).all(folder) as { path: string; user_id: string }[]) writer.set(r.path, r.user_id)
  const lastWriter = (segs: string[]) => {
    for (let n = segs.length; n >= base.length; n--) { const w = writer.get(segs.slice(0, n).join('/')); if (w !== undefined) return w }
    return null
  }
  let files = 0, othersFiles = 0, seen = 0
  const walk = (segs: string[]) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(path.join(root, ...segs), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (++seen > FILES_SCAN_MAX) return
      if (hiddenEntry(e.name, segs.length) || badSegment(e.name) || e.isSymbolicLink()) continue
      const s = [...segs, e.name]
      if (segs.length === base.length && e.name === 'skills' && e.isDirectory()) continue
      // every folder is walked (one nobody added may read can hold one they may), each file counted once someone added
      // and the caller can both read it
      if (e.isDirectory()) walk(s)
      else if (e.isFile() && readable(s)) { files++; if (lastWriter(s) !== caller) othersFiles++ }
    }
  }
  walk(base)
  // the skills that load there (chat/skills.ts walks skills/ the same way: a SKILL.md folder one or two levels down)
  const found = skillsUnder(root, folder)
  const names = found.names.filter((_, i) => {
    const segs = [...base, ...found.paths[i]!.split('/')]
    return segs.slice(base.length).every((x, j) => !hiddenEntry(x, base.length + j) && !badSegment(x)) && readable(segs)
  }).map((n) => n.normalize('NFC')).sort((a, b) => a.localeCompare(b))
  return { files, othersFiles, skills: names.length, skillNames: names }
}

/**
 * POST /api/projects/access-preview: a dry run. A new project: who would see it (the caller, the owner, admins and the
 * participants). An existing one (its creator or an admin, a projects/<name> folder in place): who gains and who loses
 * it, and what the people who gain it would see. Nothing is saved.
 */
export function previewAccess(ctx: AppContext, p: Principal, body: { participants: readonly ProjectParticipant[] }, r: ProjectRow | null, locale: Locale): ProjectAccessPreview {
  const db = ctx.db
  if (!r) {
    const people = activePrincipals(db)
    const list = checkParticipants(db, p, body.participants, locale)
    const users = new Set(list.filter((x) => x.subjectType === 'user').map((x) => x.subjectId))
    const groups = new Set(list.filter((x) => x.subjectType === 'group').map((x) => x.subjectId))
    const n = people.filter((x) => isAdminRole(x) || x.id === p.id || users.has(x.id) || x.groups.some((g) => groups.has(g))).length
    return { people: n, added: 0, removed: 0, files: 0, othersFiles: 0, sharedChats: 0, skills: 0, skillNames: [] }
  }
  const plan = planAccess(ctx, p, r, body.participants, locale)
  // what the save writes besides the people chosen (participantRules): the screen asks first, since the person did not
  // choose it (review M4)
  const extra = { ...(plan.addsFloor ? { addsFloor: true } : {}), ...(plan.restoresCreator ? { restoresCreator: true } : {}) }
  const { files, othersFiles, skills, skillNames } = plan.seen
  return { people: plan.after.length, added: plan.gained.length, removed: plan.lost.length, files, othersFiles, sharedChats: plan.sharedChats, skills, skillNames: skillNames.slice(0, 10), ...extra }
}

/** What a change of a project's participants does (the dry run's answer, and the AI's members card: chat/project-members.ts). */
export interface AccessPlan {
  /** the folder's rules now and after the save (participantRules), and the hash of the ones now (ProjectAccess.rulesHash) */
  current: FolderRuleInput[]
  next: FolderRuleInput[]
  rulesHash: string
  /** active people who see it before and after, who gains and who loses it (ids, sorted) */
  before: string[]
  after: string[]
  gained: string[]
  lost: string[]
  /** what the people who gain it would see, as the caller can read it (none when nobody gains it); every skill name */
  seen: { files: number; othersFiles: number; skills: number; skillNames: string[] }
  /** its shared chats (counted when someone gains it) */
  sharedChats: number
  /** the save also writes the floor rule, or puts the creator's rule back (nobody chose either) */
  addsFloor: boolean
  restoresCreator: boolean
}

/** The plan of a change of participants (checked: editable for `p`, the participants), nothing saved. */
export function planAccess(ctx: AppContext, p: Principal, r: ProjectRow, participants: readonly ProjectParticipant[], locale: Locale): AccessPlan {
  const db = ctx.db
  const people = activePrincipals(db)
  const { current, next, rules } = proposed(ctx, r, p, participants, locale)
  const after = withRules(rules, r.folder_path, next)
  const segs = segsOf(r.folder_path)
  const sees = (set: RuleSet) => people.filter((x) => atLeast(set.access(x, segs), 'read')).map((x) => x.id).sort()
  const before = sees(rules), now = sees(after)
  const gained = now.filter((id) => !before.includes(id)), lost = before.filter((id) => !now.includes(id))
  const none = { files: 0, othersFiles: 0, skills: 0, skillNames: [] as string[] }
  const added = people.filter((x) => gained.includes(x.id))
  // what the caller can read themselves: a member is never told about a folder inside it they cannot see
  const seen = added.length ? whatTheySee(ctx, r.folder_path, p.id, (s) => atLeast(rules.access(p, s), 'read') && added.some((x) => atLeast(after.access(x, s), 'read'))) : none
  const sharedChats = added.length ? (db.query('SELECT COUNT(*) AS n FROM chats WHERE project_id = ? AND shared_at IS NOT NULL AND deleted_at IS NULL').get(r.id) as { n: number }).n : 0
  return { current, next, rulesHash: rulesHash(current), before, after: now, gained, lost, seen, sharedChats, addsFloor: addsFloor(current, next), restoresCreator: restoresCreator(current, next, creatorOf(db, r)) }
}

/** The save writes the floor (everyone: none) on a folder that has no everyone rule now (one an older build made). */
export const addsFloor = (current: readonly FolderRuleInput[], next: readonly FolderRuleInput[]): boolean =>
  !current.some((x) => x.subjectType === 'everyone') && next.some(isFloor)
/** The save puts the creator's write rule back on a folder that has no rule of theirs now (taken away in Admin). */
export const restoresCreator = (current: readonly FolderRuleInput[], next: readonly FolderRuleInput[], creator: string | null): boolean =>
  !!creator && !current.some((x) => x.subjectType === 'user' && x.subjectId === creator) && next.some((x) => x.subjectType === 'user' && x.subjectId === creator)

/** The folder's rules now and after the change (checked: editable, the participants). */
function proposed(ctx: AppContext, r: ProjectRow, p: Principal, participants: readonly ProjectParticipant[], locale: Locale) {
  if (!accessEditable(r, ctx.files, p)) fail('conflict', tr('projectAccessNotEditable', locale), { params: { reason: 'project_not_editable' } })
  const row = getFolderByPath(ctx.db, r.folder_path)
  const current = row ? rulesOf(ctx.db, row.id) : []
  const keep = new Set(current.filter(isParticipantRule).map(key))
  const list = checkParticipants(ctx.db, p, participants, locale, keep)
  // a group or person with a rule this screen does not change (read only, no access) stays as Admin › Folder
  // permissions set it: naming them here would silently do nothing
  const fixed = new Set(current.filter((r) => !isParticipantRule(r) && !isFloor(r)).map(key))
  for (const [i, x] of list.entries()) if (fixed.has(key(x)) && !(x.subjectType === 'user' && x.subjectId === r.created_by))
    fail('validation', tr('projectParticipantFixed', locale), { fields: { [`body.participants.${i}.subjectId`]: 'set in folder permissions' }, params: { reason: 'participant_fixed' } })
  const next = participantRules(current, list, creatorOf(ctx.db, r))
  validateRules(ctx.db, next, locale, 'body.participants')
  return { current, next, rules: RuleSet.load(ctx.db) }
}

/**
 * PUT /api/projects/:id/participants: the project folder's rules, saved as Admin › Folder permissions saves them: the
 * rules hash the screen started from (409 rules_changed when someone changed them since), replaceRules, the audit, then
 * afterAccessChange (fresh sessions, notices, shared chats dropped for whoever lost the project). People who saw the
 * project before hear it when someone gains it.
 */
export function saveParticipants(ctx: AppContext, r: ProjectRow, p: Principal, actor: { id: string; name: string }, body: { participants: readonly ProjectParticipant[]; expectedHash: string }, locale: Locale, o: { via?: 'ai'; turnId?: string; chatId?: string } = {}): ProjectAccess {
  const db = ctx.db
  const { current, next } = proposed(ctx, r, p, body.participants, locale)
  const before = captureState(db)
  const segs = segsOf(r.folder_path)
  const sawBefore = before.principals.filter((x) => atLeast(before.rules.access(x, segs), 'read')).map((x) => x.id)
  db.transaction(() => {
    const row = ensureFolderRow(db, r.folder_path)
    if (rulesHash(rulesOf(db, row.id)) !== body.expectedHash) fail('conflict', tr('projectAccessChanged', locale), { params: { reason: 'rules_changed' } })
    replaceRules(db, row.id, next, actor.id)
    // the AI's change (chat/project-members.ts, after the person's yes on its card) says so, with its turn and chat
    audit(db, { actor: actor.id, action: 'folder.rules', target: r.folder_path, detail: { before: current, after: next, via: o.via ?? 'project', projectId: r.id, ...(o.via ? { turnId: o.turnId ?? null, chatId: o.chatId ?? null } : {}) } })
  })()
  afterAccessChange(ctx, before, { actor: actor.id, target: r.folder_path, ...(o.via ? { via: o.via } : {}) })
  const now = new Audiences(db, ctx.files).of(r)
  const gained = now.filter((id) => !sawBefore.includes(id)).length
  if (gained) {
    for (const id of sawBefore) {
      if (id === actor.id || !now.includes(id)) continue
      const loc = (db.query('SELECT locale FROM users WHERE id = ?').get(id) as { locale: Locale | null } | null)?.locale ?? 'ko'
      try { ctx.services.realtime.publish(id, { type: 'notice', data: { level: 'info', code: 'project_access_widened', message: tr('projectAccessWidened', loc, { by: actor.name, name: r.name, n: String(gained) }) } }) } catch (e) { ctx.log.warn('project notice failed', { err: e }) }
    }
  }
  return projectAccess(ctx, r, p)
}
