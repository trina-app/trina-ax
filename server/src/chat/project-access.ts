// Who sees a team project (docs/DECISIONS.md "Projects live only in projects/"). A team project's folder is
// projects/<name>; who sees the project is who can read that folder, so its "participants" are the folder's rules: each
// participant (a group or a person) and the creator get write. The folder is always limited (docs/DECISIONS.md "Folder
// access adds up like Google Drive (P2)"), so an admin's root "everyone: read" cannot open it. The project's edit screen and Admin › Folder permissions both write those rules,
// through the same path (writeFolderAccess with the rules hash check, captureState / afterAccessChange, the audit).
// Rules the project screen does not change (read-only people or groups, roles, an everyone rule other than the floor,
// rules on folders inside it) stay as they are and are shown read-only. A person's own "no access" rule that a
// project_leavers row backs is a leaver's exception (docs/DECISIONS.md "Leaving a project"): it belongs to the project,
// shown on a group's row ("Marketing · except Kim") or as "Left: Kim", kept while the row is there, replaced when they
// are added back by name. Any other "no access" for a person is an admin's setting: read-only here, never replaced.
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import type { AudienceSplit, FolderRuleInput, Locale, ProjectAccess, ProjectAccessPreview, ProjectOtherRule, ProjectParticipant, ProjectPeople, ProjectPerson } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { fail } from '../http/errors'
import { atLeast, loadPrincipal, RuleSet, splitOf, type Principal } from '../policy/access'
import { hiddenEntry, badSegment } from '../policy/names'
import { rulesHash } from '../admin/access-edit'
import { afterAccessChange, captureState, ensureFolderRow, getFolderByPath, isProjectsFolder, resolveFolderPath, rulesOf, setProjectException, validateRules, writeFolderAccess } from '../admin/folders'
import { getTeamSettings } from '../admin/settings'
import { audit } from '../admin/audit'
import { activePrincipals, Audiences } from './shared'
import { mayEditProject, projectFolderName, takenProjectPaths } from './projects'
import type { ProjectRow } from './store'
import { tr } from './i18n'
import { wideningAnswers, type WideningResult, type WideningSubject } from './widening'
import { placeWords } from './place-words'
import { skillsUnder } from '../skills/switch-on'

const isAdminRole = (p: Pick<Principal, 'role'>) => p.role === 'owner' || p.role === 'admin'
const segsOf = (p: string) => (p === '' ? [] : p.split('/'))

/** A project folder's rules as `next` says them (participantRules), in a rule set: the folder limited, its grants, and
 * exactly the project exceptions `next` holds (a person's own "no access"). */
export const withProjectRules = (rules: RuleSet, folder: string, next: readonly FolderRuleInput[]): RuleSet =>
  rules.replacing(folder, { rules: next.filter((x) => x.access !== 'none'), limited: true, exceptions: next.filter((x) => x.subjectType === 'user' && x.access === 'none' && x.subjectId).map((x) => x.subjectId!) })

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
/** The legacy marker (everyone: none): never in rulesOf any more, kept out of "other" rules anyway. */
const isFloor = (r: FolderRuleInput) => r.subjectType === 'everyone' && r.access === 'none'
/** A leaver's exception: a person's own "no access" on the project folder that a project_leavers row backs (they left
 * it; a person's rule decides before a group's, policy/access.ts). Part of the project's members, not an "other" rule.
 * A "no access" without such a row is an admin's setting and stays one. */
export const isException = (r: Pick<FolderRuleInput, 'subjectType' | 'subjectId' | 'access'>, leavers: ReadonlySet<string>) => r.subjectType === 'user' && r.access === 'none' && !!r.subjectId && leavers.has(r.subjectId)
/** Who left this project (project_leavers). */
export const leaversOf = (db: Database, projectId: string): Set<string> =>
  new Set((db.query('SELECT user_id FROM project_leavers WHERE project_id = ?').all(projectId) as { user_id: string }[]).map((x) => x.user_id))

/** The creator, while their account is there (a deleted one's rule went with it: the project fails closed to admins). */
function creatorOf(db: Database, r: Pick<ProjectRow, 'created_by'>): string | null {
  if (!r.created_by) return null
  return db.query('SELECT 1 FROM users WHERE id = ? AND deleted_at IS NULL').get(r.created_by) ? r.created_by : null
}

/**
 * The folder's rules after a change of participants: the participants and the creator write, the rules the project
 * screen does not change as they are, and the leavers' exceptions (isException) of people not named here (the folder
 * itself is limited when saved: writeFolderAccess, withProjectRules). A leaver named here loses their exception: added back by name, they
 * write. Nothing else drops an exception (a group taken out, another group of theirs added: they stay out). The
 * creator's rule is not put back over a "no access" of theirs.
 */
export function participantRules(current: readonly FolderRuleInput[], participants: readonly ProjectParticipant[], creator: string | null, leavers: ReadonlySet<string> = new Set()): FolderRuleInput[] {
  const other = current.filter((r) => !isParticipantRule(r) && !isFloor(r) && !isException(r, leavers))
  const exceptions = current.filter((r) => isException(r, leavers))
  const taken = new Set(other.map(key))
  const out: FolderRuleInput[] = []
  const seen = new Set<string>()
  const add = (x: ProjectParticipant) => {
    const k = key(x)
    if (seen.has(k) || taken.has(k)) return
    seen.add(k)
    out.push({ subjectType: x.subjectType, subjectId: x.subjectId, access: 'write' } as FolderRuleInput)
  }
  if (creator && !current.some((r) => r.subjectType === 'user' && r.subjectId === creator && r.access === 'none')) add({ subjectType: 'user', subjectId: creator })
  for (const x of participants) add(x)
  out.push(...exceptions.filter((r) => !seen.has(key(r))))
  out.push(...other)
  return out
}

/** The rules of a brand-new project folder: each participant and the creator write (the folder is limited). */
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
  const taken = takenProjectPaths(ctx.db)
  const name = projectFolderName(path.join(root, 'projects'), 'projects', taken, o.name, o.id)
  const want = `projects/${name}`
  // a folders row kept at or under that path (stepped around above; a guard against a row made in the meantime)
  if (ctx.db.query("SELECT 1 FROM folders WHERE path = ? OR substr(path, 1, length(?) + 1) = ? || '/' LIMIT 1").get(want, want, want)) fail('conflict', tr('projectFolderTaken', o.locale), { fields: { 'body.folderPath': 'taken' } })
  const made = resolveFolderPath(ctx, want, { create: true, locale: o.locale })
  if (!made.created) fail('conflict', tr('projectFolderTaken', o.locale), { fields: { 'body.folderPath': 'taken' } })
  return { path: made.path, abs: path.join(root, ...made.path.split('/')) }
}

/** Take a folder made by makeProjectFolder away again (its folders row and rules too). Call outside a transaction.
 * `onlyEmpty` (sharing a personal project, whose files may have been moved into it): only while the folder is empty;
 * otherwise folder, row and rules all stay, so whatever is in it stays the members' alone. */
export function unmakeProjectFolder(ctx: AppContext, made: { path: string; abs: string }, o: { onlyEmpty?: boolean } = {}): void {
  if (o.onlyEmpty) {
    try { fs.rmdirSync(made.abs) } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') { ctx.log.warn('project folder kept after a failed share: not empty', { path: made.path }); return }
    }
  } else try { fs.rmSync(made.abs, { recursive: true, force: true }) } catch {}
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
 * Project.alone ("나와 관리자만 봐요" under a chat's box, docs/DECISIONS.md "Who sees it, always") only for someone who
 * may read its rules anyway (an owner or admin, or whoever changes its members: GET access answers them its
 * participants). To anyone else it would say that the others who see it are admins, and with a name next to it (whose
 * question is answered, a creator who lost their rule) who is one.
 */
export function membersView(ctx: AppContext, r: ProjectRow, p: Principal, canEdit: boolean, creators?: Map<string, Principal | null>, aud?: Audiences, o: { member?: false } = {}): { membersEditable?: boolean; creatorChangesMembers?: boolean; alone?: true; audienceSplit?: AudienceSplit } {
  if (r.folder_path === 'users' || r.folder_path.startsWith('users/')) return {}
  // (`creators`: the list's people, read once per request)
  const load = (id: string) => { if (!creators) return loadPrincipal(ctx.db, id); if (!creators.has(id)) creators.set(id, loadPrincipal(ctx.db, id)); return creators.get(id)! }
  const creator = r.created_by ? load(r.created_by) : null
  const byCreator = (who: Principal) => mayEditProject(ctx.files, who, r) && accessEditable(r, ctx.files, who)
  const membersEditable = canEdit && accessEditable(r, ctx.files, p)
  const a = () => (aud ??= new Audiences(ctx.db, ctx.files))
  // (not for someone who manages it without being a member: "only you" would be about the others)
  const alone = o.member !== false && (membersEditable || isAdminRole(p)) && a().alone(p.id, r)
  // the audience apart ("멤버 3명"), for the owner and admins only: never a member, editor or not (beside `audience` it
  // would say how many see it only by role; docs/DECISIONS.md "Who sees it: the project's own people first"). In
  // projects/ nobody sees it by role any more (docs/DECISIONS.md "Project contents only for members"): byRole is 0 there
  return { membersEditable, creatorChangesMembers: !!creator && byCreator(creator), ...(alone ? { alone: true as const } : {}), ...(isAdminRole(p) ? { audienceSplit: a().split(r) } : {}) }
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
  // the leavers' exceptions: on each group's row that holds them ("Marketing · except Kim"), the others as "Left: Kim";
  // any other "no access" for a person is an admin's, an other rule
  const leavers = leaversOf(db, r.id)
  const exceptions = rules.filter((x) => isException(x, leavers)).map((x) => x.subjectId!)
  const covered = new Set<string>()
  const exceptOf = (groupId: string) => {
    if (!exceptions.length) return []
    const inGroup = new Set((db.query('SELECT user_id FROM group_members WHERE group_id = ?').all(groupId) as { user_id: string }[]).map((x) => x.user_id))
    const out = exceptions.filter((id) => inGroup.has(id)).map((id) => { covered.add(id); return { id, name: subjectName(db, 'user', id) ?? '' } })
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }
  const participants = rules.filter(isParticipantRule).map((x) => {
    const except = x.subjectType === 'group' ? exceptOf(x.subjectId!) : []
    return {
      subjectType: x.subjectType as 'group' | 'user', subjectId: x.subjectId!, name: subjectName(db, x.subjectType, x.subjectId) ?? '',
      ...(x.subjectType === 'user' && x.subjectId === r.created_by ? { creator: true } : {}),
      ...(except.length ? { except } : {}),
    }
  })
  // the creator first, then groups, then people, each by name
  participants.sort((a, b) => Number(!!b.creator) - Number(!!a.creator) || (a.subjectType === b.subjectType ? a.name.localeCompare(b.name) : a.subjectType === 'group' ? -1 : 1))
  const left = exceptions.filter((id) => !covered.has(id)).map((id) => ({ id, name: subjectName(db, 'user', id) ?? '' })).sort((a, b) => a.name.localeCompare(b.name))
  const otherRules: ProjectOtherRule[] = rules.filter((x) => !isParticipantRule(x) && !isFloor(x) && !isException(x, leavers)).map((x) => ({ path: r.folder_path, subjectType: x.subjectType, subjectId: x.subjectId, name: subjectName(db, x.subjectType, x.subjectId), access: x.access }))
  // rules on folders inside it (an admin's sub-rules): shown, never changed here
  const hidden = new Set<string>()
  if (r.folder_path !== '') {
    // (display only, without the markers: the legacy marker of a limited folder, the managed marker)
    const below = db.query("SELECT f.path, r.subject_type, r.subject_id, r.access FROM folder_rules r JOIN folders f ON f.id = r.folder_id WHERE substr(f.path, 1, length(?) + 1) = ? || '/' AND NOT (r.subject_type = 'everyone' AND r.access = 'none') AND r.subject_type <> 'role' ORDER BY f.path, r.subject_type, r.subject_id")
      .all(r.folder_path, r.folder_path) as { path: string; subject_type: ProjectOtherRule['subjectType']; subject_id: string | null; access: ProjectOtherRule['access'] }[]
    const set = ctx.files.rules()
    for (const x of below) {
      // only rules of folders the caller can read (one they can only list, for something readable below it, keeps its
      // rules to whoever reads it): a member, and the owner or an admin who is not a member of a project in projects/
      // (docs/DECISIONS.md "Project contents only for members"); counted, never named
      if (!atLeast(set.access(p, segsOf(x.path)), 'read')) { hidden.add(x.path); continue }
      otherRules.push({ path: x.path, subjectType: x.subject_type, subjectId: x.subject_id, name: subjectName(db, x.subject_type, x.subject_id), access: x.access })
    }
  }
  return { editable, participants, otherRules, rulesHash: rulesHash(rules), people, ...(hidden.size ? { otherRulesHidden: hidden.size } : {}), ...(left.length ? { left } : {}) }
}

/**
 * GET /api/projects/:id/people: who is in a team project in projects/<name> (the caller was checked before: a member, or
 * someone who manages it). Its people are its audience (who reads its folder now: in projects/ that is its members
 * only, the owner and admins too only as members), each once, with their photo; the creator first, then by name.
 * `groups` (each group a rule of its own folder lets in, with the people of the list in it) only when `manage`: whoever
 * manages it reads those rules in GET …/access anyway; a member is not told which groups an admin chose.
 */
export function projectPeople(ctx: AppContext, r: ProjectRow, o: { manage: boolean }): ProjectPeople {
  const db = ctx.db
  const ids = new Audiences(db, ctx.files).of(r)
  const there = new Set(ids)
  const rows = ids.length
    ? db.query(`SELECT u.id, u.name, p.avatar_version FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id WHERE u.id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { id: string; name: string; avatar_version: number | null }[]
    : []
  const people: ProjectPerson[] = rows.map((x) => ({ id: x.id, name: x.name, ...(x.avatar_version ? { avatarVersion: x.avatar_version } : {}), ...(x.id === r.created_by ? { creator: true as const } : {}) }))
  people.sort((a, b) => Number(!!b.creator) - Number(!!a.creator) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  if (!o.manage) return { people }
  const row = getFolderByPath(db, r.folder_path)
  const groupIds = [...new Set((row ? rulesOf(db, row.id) : []).filter((x) => x.subjectType === 'group' && x.access !== 'none' && x.subjectId).map((x) => x.subjectId!))]
  const order = new Map(people.map((x, i) => [x.id, i]))
  const groups = groupIds.flatMap((id) => {
    const g = db.query('SELECT name FROM groups WHERE id = ?').get(id) as { name: string } | null
    if (!g) return []
    const inside = (db.query('SELECT user_id FROM group_members WHERE group_id = ?').all(id) as { user_id: string }[]).map((x) => x.user_id).filter((u) => there.has(u))
    inside.sort((a, b) => order.get(a)! - order.get(b)!)
    return [{ id, name: g.name, people: inside }]
  })
  groups.sort((a, b) => a.name.localeCompare(b.name))
  return { people, groups }
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
 * participants). For a caller who is not the owner or an admin, only the caller and the participants (`adminsApart`):
 * with the admins counted in, naming an admin would not change the count and naming a member would, which tells any
 * member who may make projects, for free, who the admins are (members are never told roles). An existing one (its
 * creator or an admin, a projects/<name> folder in place): who gains and who loses it, and what the people who gain it
 * would see. Nothing is saved.
 */
export function previewAccess(ctx: AppContext, p: Principal, body: { participants: readonly ProjectParticipant[]; removeRules?: readonly { subjectType: string; subjectId: string | null }[] }, r: ProjectRow | null, locale: Locale): ProjectAccessPreview {
  const db = ctx.db
  if (!r) {
    const people = activePrincipals(db)
    const list = checkParticipants(db, p, body.participants, locale)
    const users = new Set(list.filter((x) => x.subjectType === 'user').map((x) => x.subjectId))
    const groups = new Set(list.filter((x) => x.subjectType === 'group').map((x) => x.subjectId))
    // a new team project is members only (docs/DECISIONS.md "Project contents only for members"): the caller and the
    // people and groups chosen, the owner and admins only when chosen, for every caller (no count by role, no adminsApart)
    const direct = people.filter((x) => x.id === p.id || users.has(x.id) || x.groups.some((g) => groups.has(g))).length
    return { people: direct, added: 0, removed: 0, files: 0, othersFiles: 0, sharedChats: 0, skills: 0, skillNames: [], ...(isAdminRole(p) ? { split: { direct, byRole: 0 } } : {}) }
  }
  const plan = planAccess(ctx, p, r, body.participants, locale, body.removeRules ?? [])
  // who loses it, by name (three; the screen says how many more: QA TC-1067): people the caller reads in the dialog
  const nameOf = (id: string) => (db.query('SELECT name FROM users WHERE id = ?').get(id) as { name: string } | null)?.name
  const lostNames = plan.lost.flatMap((id) => nameOf(id) ?? []).sort((a, b) => a.localeCompare(b)).slice(0, 3)
  // what the save writes besides the people chosen (participantRules): the screen asks first, since the person did not
  // choose it (review M4)
  const extra = { ...(plan.addsFloor ? { addsFloor: true } : {}), ...(plan.restoresCreator ? { restoresCreator: true } : {}), ...(lostNames.length ? { removedNames: lostNames } : {}) }
  const { files, othersFiles, skills, skillNames } = plan.seen
  // the answers of its shared chats the people who gain it would start seeing although they miss a place they used (the
  // widening warning, chat/widening.ts; its list: POST /api/sharing/widening-answers)
  const hiddenAnswers = plan.gained.length && plan.sharedChats ? projectWidening(ctx, p, r, body.participants, plan, { limit: 0 }, locale).total : 0
  // the count apart for the owner and admins only (a member who manages the project reads the total, as before)
  return { people: plan.after.length, added: plan.gained.length, removed: plan.lost.length, files, othersFiles, sharedChats: plan.sharedChats, skills, skillNames: skillNames.slice(0, 10), ...extra, ...(hiddenAnswers ? { hiddenAnswers } : {}), ...(isAdminRole(p) ? { split: plan.afterSplit } : {}), ...(plan.contentsHidden ? { contentsHidden: true } : {}) }
}

/**
 * The widening list of a change of a project's participants (chat/widening.ts): the answers of its shared chats the
 * people who gain it (`plan.gained`) would start seeing although they miss a place one used, as `p` may see them. The
 * picked people and groups (`participants` that bring someone who gains it) name who misses what. Nothing when nobody
 * gains it or `p` does not see its chats (`contentsHidden`).
 */
export function projectWidening(ctx: AppContext, p: Principal, r: ProjectRow, participants: readonly ProjectParticipant[], plan: AccessPlan, page: { before?: number | null; limit: number }, locale: Locale): WideningResult & { subjects: WideningSubject[] } {
  const db = ctx.db
  if (!plan.gained.length || plan.contentsHidden) return { total: 0, totalCapped: false, items: [], nextRowid: null, subjects: [] }
  // the same question again within a few seconds (the dialog's dry run on every pick, a page asked twice): the answer
  // kept for this caller, not a new walk (security review of #813: no free repeated walks)
  // (a new answer or record since: asked again; the newest record's rowid is one look at the table's end)
  const newest = (db.query('SELECT MAX(rowid) AS n FROM shared_answer_reads').get() as { n: number | null }).n ?? 0
  const key = JSON.stringify([p.id, r.id, plan.rulesHash, newest, plan.gained, participants.map((x) => `${x.subjectType}:${x.subjectId}`).sort(), page.before ?? null, page.limit, locale])
  const cache = wideningCache.get(db) ?? new Map<string, { at: number; v: WideningResult & { subjects: WideningSubject[] } }>()
  wideningCache.set(db, cache)
  const now = Date.now()
  const kept = cache.get(key)
  if (kept && now - kept.at < WIDENING_CACHE_MS) return kept.v
  for (const [k, v] of cache) if (now - v.at >= WIDENING_CACHE_MS) cache.delete(k)
  const gained = plan.gained.map((id) => loadPrincipal(db, id)).filter((x): x is Principal => !!x)
  const subjects: WideningSubject[] = []
  for (const x of participants) {
    const people = x.subjectType === 'user' ? gained.filter((g) => g.id === x.subjectId).map((g) => g.id) : gained.filter((g) => g.groups.includes(x.subjectId)).map((g) => g.id)
    if (!people.length) continue
    const name = x.subjectType === 'user'
      ? (db.query('SELECT name FROM users WHERE id = ?').get(x.subjectId) as { name: string } | null)?.name
      : (db.query('SELECT name FROM groups WHERE id = ?').get(x.subjectId) as { name: string } | null)?.name
    if (name) subjects.push({ key: `${x.subjectType}:${x.subjectId}`, name, people })
  }
  const words = { root: tr('scopeRoot', locale), mine: tr('sharedScopeMine', locale), room: tr('scopeRoom', locale) }
  // places in the Files screen's words, as the read card says them
  const place = (path: string) => placeWords(db, path, locale, p.id)
  const v = { ...wideningAnswers(db, { now: plan.rulesNow, after: plan.rulesAfter }, { kind: 'project', projectId: r.id }, gained, p, page, { subjects, words, place }), subjects }
  if (cache.size < 500) cache.set(key, { at: now, v })
  return v
}

/** How long a widening answer is kept for the same caller and question (projectWidening). */
export const WIDENING_CACHE_MS = 20_000
const wideningCache = new WeakMap<import('bun:sqlite').Database, Map<string, { at: number; v: WideningResult & { subjects: WideningSubject[] } }>>()

/** What a change of a project's participants does (the dry run's answer, and the AI's members card: chat/project-members.ts). */
export interface AccessPlan {
  /** the folder's rules now and after the save (participantRules), and the hash of the ones now (ProjectAccess.rulesHash) */
  current: FolderRuleInput[]
  next: FolderRuleInput[]
  rulesHash: string
  /** active people who see it before and after, who gains and who loses it (ids, sorted) */
  before: string[]
  after: string[]
  /** `after` apart: by the folder's rules after the save, or only by role (the owner and admins' dry run) */
  afterSplit: AudienceSplit
  gained: string[]
  lost: string[]
  /** what the people who gain it would see, as the caller can read it (none when nobody gains it); every skill name */
  seen: { files: number; othersFiles: number; skills: number; skillNames: string[] }
  /** its shared chats (counted when someone gains it) */
  sharedChats: number
  /** the save also writes the floor rule, or puts the creator's rule back (nobody chose either) */
  addsFloor: boolean
  restoresCreator: boolean
  /** the caller manages it without reading it: `seen` and `sharedChats` are not counted (0) */
  contentsHidden: boolean
  /** the folder rules now and after the save (the widening list judges the people who gain it by the latter: chat/widening.ts) */
  rulesNow: RuleSet
  rulesAfter: RuleSet
}

/** The plan of a change of participants (checked: editable for `p`, the participants), nothing saved. */
export function planAccess(ctx: AppContext, p: Principal, r: ProjectRow, participants: readonly ProjectParticipant[], locale: Locale, removeRules: readonly { subjectType: string; subjectId: string | null }[] = []): AccessPlan {
  const db = ctx.db
  const people = activePrincipals(db)
  const { current, next, rules } = proposed(ctx, r, p, participants, locale, removeRules)
  const after = withProjectRules(rules, r.folder_path, next)
  const segs = segsOf(r.folder_path)
  const readers = (set: RuleSet) => people.filter((x) => atLeast(set.access(x, segs), 'read'))
  const sees = (set: RuleSet) => readers(set).map((x) => x.id).sort()
  const before = sees(rules), nowReaders = readers(after), now = nowReaders.map((x) => x.id).sort()
  const gained = now.filter((id) => !before.includes(id)), lost = before.filter((id) => !now.includes(id))
  const none = { files: 0, othersFiles: 0, skills: 0, skillNames: [] as string[] }
  const added = people.filter((x) => gained.includes(x.id))
  // what the caller can read themselves: a member is never told about a folder inside it they cannot see
  const seen = added.length ? whatTheySee(ctx, r.folder_path, p.id, (s) => atLeast(rules.access(p, s), 'read') && added.some((x) => atLeast(after.access(x, s), 'read'))) : none
  // the owner or an admin who is not a member: nothing of what is in it is counted for them (docs/DECISIONS.md "Project
  // contents only for members"); whatTheySee counts only what the caller reads anyway
  const contentsHidden = !atLeast(rules.access(p, segs), 'read')
  const sharedChats = added.length && !contentsHidden ? (db.query('SELECT COUNT(*) AS n FROM chats WHERE project_id = ? AND shared_at IS NOT NULL AND deleted_at IS NULL').get(r.id) as { n: number }).n : 0
  return { current, next, rulesHash: rulesHash(current), before, after: now, afterSplit: splitOf(after, nowReaders, segs), gained, lost, seen: contentsHidden ? none : seen, sharedChats, addsFloor: !getFolderByPath(db, r.folder_path)?.limited, restoresCreator: restoresCreator(current, next, creatorOf(db, r)), contentsHidden, rulesNow: rules, rulesAfter: after }
}

/** The save limits a project folder that is not limited now (only an older build's, before the conversion). Kept for
 * the API's `addsFloor`; the plan reads the folder row (planAccess). */
export const addsFloor = (_current: readonly FolderRuleInput[], _next: readonly FolderRuleInput[]): boolean => false
/** The save puts the creator's write rule back on a folder that has no rule of theirs now (taken away in Admin). */
export const restoresCreator = (current: readonly FolderRuleInput[], next: readonly FolderRuleInput[], creator: string | null): boolean =>
  !!creator && !current.some((x) => x.subjectType === 'user' && x.subjectId === creator) && next.some((x) => x.subjectType === 'user' && x.subjectId === creator)

/** The folder's rules now and after the change (checked: editable, the participants). */
function proposed(ctx: AppContext, r: ProjectRow, p: Principal, participants: readonly ProjectParticipant[], locale: Locale, removeRules: readonly { subjectType: string; subjectId: string | null }[] = []) {
  if (!accessEditable(r, ctx.files, p)) fail('conflict', tr('projectAccessNotEditable', locale), { params: { reason: 'project_not_editable' } })
  const row = getFolderByPath(ctx.db, r.folder_path)
  const now = row ? rulesOf(ctx.db, row.id) : []
  // other rules on its own folder taken out (the members screen's ×): only ones that are there and that this screen does
  // not set. Taking one out only narrows: participantRules keeps or puts back "everyone else: none", and a removal that
  // would let someone in is refused (assertRemovalNarrows)
  const leavers = leaversOf(ctx.db, r.id)
  const drop = new Set(removeRules.map(key))
  // (a leaver's exception is no other rule: it goes only when they are added back by name)
  for (const [i, x] of removeRules.entries()) if (!now.some((c) => key(c) === key(x) && !isParticipantRule(c) && !isFloor(c) && !isException(c, leavers)))
    fail('validation', tr('projectRuleNotThere', locale), { fields: { [`body.removeRules.${i}`]: 'not an other rule of this folder' } })
  const current = now
  const kept = now.filter((c) => !(drop.has(key(c)) && !isParticipantRule(c) && !isFloor(c)))
  const keep = new Set(current.filter(isParticipantRule).map(key))
  const list = checkParticipants(ctx.db, p, participants, locale, keep)
  // a group or person with a rule this screen does not change (read only, no access) stays as Admin › Folder
  // permissions set it: naming them here would silently do nothing
  const fixed = new Set(kept.filter((r) => !isParticipantRule(r) && !isFloor(r) && !isException(r, leavers)).map(key))
  for (const [i, x] of list.entries()) if (fixed.has(key(x)) && !(x.subjectType === 'user' && x.subjectId === r.created_by))
    fail('validation', tr('projectParticipantFixed', locale), { fields: { [`body.participants.${i}.subjectId`]: 'set in folder permissions' }, params: { reason: 'participant_fixed' } })
  const rules = RuleSet.load(ctx.db)
  const next = participantRules(kept, list, creatorOf(ctx.db, r), leavers)
  validateRules(ctx.db, next, locale, 'body.participants')
  if (drop.size) assertRemovalNarrows(ctx.db, rules, r.folder_path, now, drop, list, next, creatorOf(ctx.db, r), leavers, locale)
  // the leavers named here come back (their project_leavers rows go with the save)
  const back = list.filter((x) => x.subjectType === 'user' && leavers.has(x.subjectId)).map((x) => x.subjectId)
  return { current, next, rules, back }
}

const RANK = { none: 0, read: 1, write: 2 } as const

/**
 * Taking an other rule out only narrows (docs/DECISIONS.md "Project contents only for members"; the dry run and the save
 * both check it): a removal that lets anyone open or change, at the project's folder or a folder inside it with rules of
 * its own, what they cannot now (a "no access" for a person or a group that a member group or "everyone: read" would
 * then let in) is refused, 409 remove_widens. Compared with the same change keeping those rules, so the people chosen
 * here count as chosen; a rule taken out for someone named as a member in the same change is that choice.
 */
function assertRemovalNarrows(db: Database, rules: RuleSet, folder: string, now: readonly FolderRuleInput[], drop: ReadonlySet<string>, list: readonly ProjectParticipant[], next: readonly FolderRuleInput[], creator: string | null, leavers: ReadonlySet<string>, locale: Locale): void {
  const named = new Set(list.map(key))
  const keptForCheck = now.filter((c) => !(drop.has(key(c)) && named.has(key(c)) && !isParticipantRule(c) && !isFloor(c)))
  const without = withProjectRules(rules, folder, participantRules(keptForCheck, list, creator, leavers))
  const with_ = withProjectRules(rules, folder, next)
  const places = [folder, ...rules.boundaryFolders().filter((f) => f.startsWith(folder + '/'))].map(segsOf)
  for (const x of activePrincipals(db)) {
    for (const at of places) {
      if (RANK[with_.access(x, at)] > RANK[without.access(x, at)]) fail('conflict', tr('projectRuleRemoveWidens', locale), { fields: { 'body.removeRules': 'would let someone in' }, params: { reason: 'remove_widens' } })
    }
  }
}

/**
 * PUT /api/projects/:id/participants: the project folder's rules, saved as Admin › Folder permissions saves them: the
 * rules hash the screen started from (409 rules_changed when someone changed them since), writeFolderAccess, the audit, then
 * afterAccessChange (fresh sessions, notices, shared chats dropped for whoever lost the project). People who saw the
 * project before hear it when someone gains it.
 */
export function saveParticipants(ctx: AppContext, r: ProjectRow, p: Principal, actor: { id: string; name: string }, body: { participants: readonly ProjectParticipant[]; expectedHash: string; removeRules?: readonly { subjectType: string; subjectId: string | null }[] }, locale: Locale, o: { via?: 'ai'; turnId?: string; chatId?: string } = {}): ProjectAccess {
  const db = ctx.db
  const { current, next, back } = proposed(ctx, r, p, body.participants, locale, body.removeRules ?? [])
  const before = captureState(db)
  const segs = segsOf(r.folder_path)
  const sawBefore = before.principals.filter((x) => atLeast(before.rules.access(x, segs), 'read')).map((x) => x.id)
  // the person who saves starts to read it themselves (Add me, or a group that holds them): said in the audit row
  const self = !sawBefore.includes(p.id) && atLeast(withProjectRules(before.rules, r.folder_path, next).access(p, segs), 'read')
  db.transaction(() => {
    const row = ensureFolderRow(db, r.folder_path)
    if (rulesHash(rulesOf(db, row.id)) !== body.expectedHash) fail('conflict', tr('projectAccessChanged', locale), { params: { reason: 'rules_changed' } })
    writeFolderAccess(db, row.id, { rules: next.filter((x) => x.access !== 'none'), limited: true }, actor.id)
    // a person's own "no access" the save leaves out (an admin's, taken out with ×; a leaver added back by name was
    // replaced by their write rule already)
    for (const x of current) if (x.subjectType === 'user' && x.access === 'none' && x.subjectId && !next.some((y) => y.subjectType === 'user' && y.subjectId === x.subjectId)) setProjectException(db, row.id, x.subjectId, false, actor.id)
    for (const id of back) db.query('DELETE FROM project_leavers WHERE project_id = ? AND user_id = ?').run(r.id, id)
    // the AI's change (chat/project-members.ts, after the person's yes on its card) says so, with its turn and chat
    audit(db, { actor: actor.id, action: 'folder.rules', target: r.folder_path, detail: { before: current, after: next, via: o.via ?? 'project', projectId: r.id, ...(self ? { self: true } : {}), ...(o.via ? { turnId: o.turnId ?? null, chatId: o.chatId ?? null } : {}) } })
  })()
  afterAccessChange(ctx, before, { actor: actor.id, target: r.folder_path, via: o.via ?? 'project' })
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
