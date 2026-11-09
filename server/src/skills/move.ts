// Moving a skill from one level to another (docs/DECISIONS.md "Project skills"): the team (skills/), one of the
// person's groups (groups/<g>/skills/), a live team project (<folder>/skills/: its chats only) or the person's own
// (users/<me>/skills/). One action for the Skills page's Move dialog (GET / POST /api/skills/move) and the AI's move_skill
// (chat/tools.ts), whose card the person answers. A move needs write on both places, no skill of that name at the target,
// a SKILL.md folder for a project, and for a project no wider skill of the same name the person sees (a project only adds
// names). What the person saw is bound to a hash of every file of the skill and the target (`token`), checked again when
// it moves. The AI may only move a skill where nobody gains it (move_skill); a move that reaches more people is made on
// the Skills page, where the whole text is shown. Audited as `skills.move` (both levels, gained and lost counts), and each
// file's move as `skills.change` (skills/changes.ts).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Locale, SkillLevel, SkillMoveOptions, SkillMoveTarget } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { audit } from '../admin/audit'
import { atLeast, type Principal } from '../policy/access'
import { authorize } from '../policy/authorize'
import { foldKey } from '../policy/names'
import { groupSkillRoots, isPersonalSkill, isSkillManifest, listGroupSkills, listSkills, listTeamSkills, liveProjectRoots, personalSkillsDir, projectOfFolder, readSkill, sameSkillName, skillFolder, skillTier, widerSkillsNamed, type Skill } from '../chat/skills'
import { HttpError } from '../http/errors'
import { componentC } from '../team-files/component'
import { activePeople } from '../team-files/service'
import { SKILLS_DIR, skillRootOf } from './guard'
import { SKILL_TEXT, st } from './text'

/** A skill folder this large is moved on the Files screen. */
export const MOVE_MAX_FILES = 500
export const MOVE_MAX_BYTES = 50 * 1024 * 1024

export type Level =
  | { level: 'team'; root: string }
  | { level: 'group'; root: string; group: { id: string; name: string } }
  | { level: 'project'; root: string; folder: string; project: { id: string; name: string } }
  | { level: 'personal'; root: string }

export const levelRef = (l: Level): SkillLevel =>
  l.level === 'group' ? { level: 'group', groupId: l.group.id } : l.level === 'project' ? { level: 'project', projectId: l.project.id } : { level: l.level }
const sameLevel = (a: Level, b: Level) => a.level === b.level && a.root === b.root

/** "팀 전체", "리드 그룹", "견적 프로젝트 채팅", "나만" (names one line, cut at 40). */
export function levelLabel(l: Level, L: Locale): string {
  const short = (s: string) => { const t = s.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').trim(); return [...t].length > 40 ? [...t].slice(0, 39).join('') + '…' : t }
  if (l.level === 'group') return st('levelGroup', L, { group: short(l.group.name) })
  if (l.level === 'project') return st('levelProject', L, { project: short(l.project.name) })
  return st(l.level === 'team' ? 'levelTeam' : 'levelPersonal', L)
}

/** The level a skill path of `user`'s is at, or null (not a skill root this person has). */
export function levelOfPath(ctx: AppContext, user: Principal, rel: string): Level | null {
  if (isPersonalSkill(rel)) return rel.split('/')[1] === user.id ? { level: 'personal', root: personalSkillsDir(user.id) } : null
  const root = skillRootOf(rel)
  if (!root) return null
  if (root.kind === 'team') return { level: 'team', root: SKILLS_DIR }
  if (root.kind === 'project') {
    // a live team project's only: a skills folder no project has is no level
    const p = projectOfFolder(ctx.db, root.folder)
    return p ? { level: 'project', root: p.root, folder: p.folder, project: { id: p.id, name: p.name } } : null
  }
  const g = groupSkillRoots(ctx.db, user).find((x) => foldKey(rel).startsWith(foldKey(x.root) + '/'))
  return g ? { level: 'group', root: g.root, group: { id: g.id, name: g.name } } : null
}

/** Every level `user` could put a skill at: the team, their groups, the live projects they see, their own. */
export function levelsOf(ctx: AppContext, user: Principal): Level[] {
  const rules = ctx.files.rules()
  const projects = liveProjectRoots(ctx.db).filter((p) => atLeast(rules.access(user, p.folder.split('/')), 'read'))
    .map((p): Level => ({ level: 'project', root: p.root, folder: p.folder, project: { id: p.id, name: p.name } }))
  return [
    { level: 'team', root: SKILLS_DIR },
    ...groupSkillRoots(ctx.db, user).map((g): Level => ({ level: 'group', root: g.root, group: { id: g.id, name: g.name } })),
    ...projects,
    { level: 'personal', root: personalSkillsDir(user.id) },
  ]
}

/** The level a SkillLevel names, among `user`'s levels, or null. */
export function levelFor(ctx: AppContext, user: Principal, to: SkillLevel): Level | null {
  return levelsOf(ctx, user).find((l) => l.level === to.level && (to.level === 'group' ? l.level === 'group' && l.group.id === to.groupId : to.level === 'project' ? l.level === 'project' && l.project.id === to.projectId : true)) ?? null
}

/** The active people whose AI follows a skill whose entry is `entry` at level `l`: who reads it (folder rules), and for
 * a group its members only, for a project those who see the project, for a person's own that person. */
export function reachOf(ctx: AppContext, owner: Principal, l: Level, entry: string): Set<string> {
  if (l.level === 'personal') return new Set([owner.id])
  const rules = ctx.files.rules()
  const segs = entry.split('/')
  const out = new Set<string>()
  for (const p of activePeople(ctx.db)) {
    if (l.level === 'group' && !p.groups.includes(l.group.id)) continue
    if (l.level === 'project' && !atLeast(rules.access(p, l.folder.split('/')), 'read')) continue
    if (atLeast(rules.access(p, segs), 'read')) out.add(p.id)
  }
  return out
}

/** The active people who may change a skill at `rel` once it is there: who may write that path (the folder rules; a
 * person's own folder is theirs alone). */
export function editorsOf(ctx: AppContext, owner: Principal, l: Level, rel: string): Set<string> {
  if (l.level === 'personal') return new Set([owner.id])
  const rules = ctx.files.rules()
  const segs = rel.split('/')
  return new Set(activePeople(ctx.db).filter((p) => rules.access(p, segs) === 'write').map((p) => p.id))
}

/** The levels the AI's move_skill may move a skill between (docs/DECISIONS.md "Project skills"): only to a level whose
 * chats are fewer and whose text is trusted no less: the team's to a group or a project, a group's to a project. A
 * skill never leaves a project by the AI (its text would run in more chats and stop counting as outside content), and
 * nothing goes into one person's own skills (it would outrank their team and group skills). The rest is the Skills
 * page's, which shows the whole text first. */
export const AI_MOVES: ReadonlySet<string> = new Set(['team>group', 'team>project', 'group>project'])

/** The skill `user` has at `rel` (readSkill with its project when it is a project's, which they must see). */
export function skillAt(ctx: AppContext, user: Principal, rel: string): { skill: Skill; level: Level } | null {
  const level = levelOfPath(ctx, user, rel)
  if (!level) return null
  if (level.level === 'project' && !atLeast(ctx.files.rules().access(user, level.folder.split('/')), 'read')) return null
  const skill = readSkill(ctx.files, user, rel, level.level === 'project' ? { project: { id: level.project.id, name: level.project.name, folderPath: level.folder } } : {})
  return skill ? { skill, level } : null
}

interface FileHash { path: string; size: number; sha: string }
/** Every regular file of the skill (its folder, or the single file), by path, with its hash; no links. */
function skillFiles(ctx: AppContext, user: Principal, from: string): FileHash[] {
  const root = ctx.files.fx.root
  const out: FileHash[] = []
  let bytes = 0
  const walk = (rel: string) => {
    const r = authorize(ctx.files.fx, ctx.files.rules(), user, rel, 'read')
    const st = fs.lstatSync(r.abs)
    if (st.isSymbolicLink()) throw new HttpError('conflict', 'a link in the skill folder')
    if (st.isDirectory()) { for (const n of fs.readdirSync(r.abs).sort()) walk(`${r.rel}/${n}`); return }
    if (!st.isFile()) return
    if (out.length >= MOVE_MAX_FILES || (bytes += st.size) > MOVE_MAX_BYTES) throw new HttpError('payload_too_large', 'too many files', { params: { reason: 'skill_too_large' } })
    out.push({ path: r.rel, size: st.size, sha: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, ...r.rel.split('/')))).digest('hex') })
  }
  walk(from)
  return out
}

/** One move as it would go, with who gains and loses it, and why not (a SKILL_TEXT key and its words). */
export interface MovePlan {
  skill: Skill
  from: Level
  to: Level
  /** what moves: the skill's folder, or its single file */
  source: string
  target: string
  /** the entry at the target */
  entry: string
  files: FileHash[]
  fromPeople: number
  toPeople: number
  gained: number
  lost: number
  /** who may change it there, and how many of them may not change it now */
  editors: number
  editorsGained: number
  blocked: { key: keyof typeof SKILL_TEXT; vars: Record<string, string> } | null
  token: string
}

/** Where "the same name" is for the person: the label of a wider skill whose name, or file or folder name, `name` is. */
function widerSameName(ctx: AppContext, user: Principal, name: string, except: string, L: Locale): string | null {
  // the moved skill leaves: what it hides now counts too
  const hit = widerSkillsNamed(ctx.files, user, name, except)[0]
  if (!hit) return null
  return skillTier(hit) === 0 ? st('wherePersonal', L) : hit.group ? st('whereGroup', L, { group: hit.group.name }) : st('whereTeam', L)
}

/** The skills already at level `l` (for the name check), as `user` sees them. */
function skillsAtLevel(ctx: AppContext, user: Principal, l: Level): Skill[] {
  if (l.level === 'team') return listTeamSkills(ctx.files, user)
  if (l.level === 'group') return listGroupSkills(ctx.files, user, l.group.id)
  if (l.level === 'project') return listSkills(ctx.files, user, { project: { id: l.project.id, name: l.project.name, folderPath: l.folder } }).filter((s) => s.project?.id === l.project.id)
  return listSkills(ctx.files, user).filter((s) => isPersonalSkill(s.path))
}

export function planMove(ctx: AppContext, user: Principal, have: { skill: Skill; level: Level }, to: Level, L: Locale): MovePlan {
  const { skill, level: from } = have
  const manifest = isSkillManifest(skill.path)
  const source = manifest ? skillFolder(skill.path) : skill.path
  const base = source.split('/').pop()!
  const target = `${to.root}/${base}`
  const entry = manifest ? `${target}/SKILL.md` : target
  const files = skillFiles(ctx, user, source)
  const rules = ctx.files.rules()
  const fromWords = levelLabel(from, L), toWords = levelLabel(to, L)
  let blocked: MovePlan['blocked'] = null
  const block = (key: keyof typeof SKILL_TEXT, vars: Record<string, string> = {}) => { blocked ??= { key, vars } }
  if (sameLevel(from, to)) block('moveSame')
  if (rules.access(user, source.split('/')) !== 'write') block('moveNoWrite', { where: fromWords })
  if (to.level === 'project' && !manifest) block('moveNotFolder')
  if (to.level !== 'personal' && rules.access(user, target.split('/')) !== 'write') block('moveNoWrite', { where: toWords })
  // a skills folder that is not there yet (a project's first skill, a person's first own skill) is free: runMove makes it
  let exists = false
  try { exists = authorize(ctx.files.fx, rules, user, target, 'write', { mustExist: false, createDirs: true }).exists } catch { exists = false }
  if (exists || skillsAtLevel(ctx, user, to).some((s) => sameSkillName(s.name, skill.name))) block('moveTaken', { to: toWords, name: skill.name })
  if (to.level === 'project') {
    const where = widerSameName(ctx, user, skill.name, skill.path, L)
    if (where) block('moveHidden', { name: skill.name, where })
  }
  const a = reachOf(ctx, user, from, skill.path), b = reachOf(ctx, user, to, entry)
  const gained = [...b].filter((x) => !a.has(x)).length, lost = [...a].filter((x) => !b.has(x)).length
  const ea = editorsOf(ctx, user, from, source), eb = editorsOf(ctx, user, to, target)
  const editorsGained = [...eb].filter((x) => !ea.has(x)).length
  // what the person saw, bound together: every file, and who gets it and who may change it there (a change of any of
  // these between the card and the move refuses it: runMove)
  const token = crypto.createHash('sha256').update(JSON.stringify({ source, target, files: files.map((f) => [f.path, f.sha]), readers: [...b].sort(), editors: [...eb].sort() })).digest('hex').slice(0, 64)
  return { skill, from, to, source, target, entry, files, fromPeople: a.size, toPeople: b.size, gained, lost, editors: eb.size, editorsGained, blocked, token }
}

/** GET /api/skills/move: where one skill of the caller's can go. */
export function moveOptions(ctx: AppContext, userId: string, rel: string, L: Locale): SkillMoveOptions {
  const user = ctx.files.principal(userId)
  const have = skillAt(ctx, user, rel)
  if (!have) throw new HttpError('not_found', st('moveNotFound', L))
  const targets: SkillMoveTarget[] = []
  let first: MovePlan | null = null
  for (const to of levelsOf(ctx, user)) {
    if (sameLevel(have.level, to)) continue
    const p = planMove(ctx, user, have, to, L)
    first ??= p
    targets.push({ to: levelRef(to), label: levelLabel(to, L), people: p.toPeople, gained: p.gained, lost: p.lost, editors: p.editors, editorsGained: p.editorsGained, ...(p.blocked ? { blocked: st(p.blocked.key, L, p.blocked.vars) } : { token: p.token }) })
  }
  const files = first?.files ?? skillFiles(ctx, user, isSkillManifest(have.skill.path) ? skillFolder(have.skill.path) : have.skill.path)
  const text = (() => { try { return fs.readFileSync(path.join(ctx.files.fx.root, ...have.skill.path.split('/')), 'utf8').slice(0, 64 * 1024) } catch { return '' } })()
  return {
    path: have.skill.path, name: have.skill.name,
    from: { label: levelLabel(have.level, L), people: reachOf(ctx, user, have.level, have.skill.path).size, level: have.level.level },
    files: files.map((f) => ({ path: f.path, size: f.size })), text, targets,
  }
}

/** Move it, as planned and seen (`token`): everything is checked again first. `turnId` / `tool`: the AI's move_skill,
 * after the person's yes on its card. Returns the plan that ran. */
export function runMove(ctx: AppContext, userId: string, rel: string, to: SkillLevel, token: string, L: Locale, o: { turnId?: string | null; tool?: string } = {}): MovePlan {
  const user = ctx.files.principal(userId)
  const have = skillAt(ctx, user, rel)
  if (!have) throw new HttpError('not_found', st('moveNotFound', L))
  const level = levelFor(ctx, user, to)
  if (!level) throw new HttpError('not_found', st('moveNotFound', L))
  const plan = planMove(ctx, user, have, level, L)
  if (plan.blocked) throw new HttpError('conflict', st(plan.blocked.key, L, plan.blocked.vars), { params: { reason: 'skill_move_blocked' } })
  // the files, who gets it or who may change it differ from what was shown: nothing moves, the person looks again
  if (plan.token !== token) throw new HttpError('conflict', st('moveChanged', L), { params: { reason: 'skill_move_changed' } })
  // the target's skills folder may not be there yet: made now (it has no rules of its own, so its folder's rules apply)
  const parent = plan.target.split('/').slice(0, -1)
  authorize(ctx.files.fx, ctx.files.rules(), user, parent.join('/'), 'write', { mustExist: false, createDirs: true })
  fs.mkdirSync(path.join(ctx.files.fx.root, ...parent), { recursive: true, mode: 0o700 })
  componentC(ctx).files.move(userId, plan.source, plan.target, 'fail', { confirm: true, turnId: o.turnId ?? null, tool: o.tool ?? 'skill_move', skillMove: true })
  // a person's own folder is never named in the audit log (admins read it; they cannot read users/<id>/)
  const side = (l: Level, people: number, p: string) => ({ level: l.level, ...(l.level === 'group' ? { group: l.group } : l.level === 'project' ? { project: l.project } : {}), people, path: l.level === 'personal' ? null : p })
  audit(ctx.db, {
    actor: userId, action: 'skills.move', target: plan.to.level === 'personal' ? plan.skill.path : plan.entry,
    detail: { name: plan.skill.name, from: side(plan.from, plan.fromPeople, plan.skill.path), to: side(plan.to, plan.toPeople, plan.entry), gained: plan.gained, lost: plan.lost, editors: plan.editors, editorsGained: plan.editorsGained, files: plan.files.length, byAi: !!o.turnId, turnId: o.turnId ?? null },
  })
  return plan
}
