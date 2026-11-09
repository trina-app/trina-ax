// Moving or copying a skill from one level to another (docs/DECISIONS.md "Project skills"): the team (skills/), one of
// the person's groups (groups/<g>/skills/), a live team project (<folder>/skills/: its chats only) or the person's own
// (users/<me>/skills/). One action for the Skills page's Move dialog (GET / POST /api/skills/move) and the AI's move_skill
// (chat/tools.ts; `keep`: a copy), whose card the person answers. A move needs write on both places, a copy read on the
// original and write on the target; both need no skill of that name at the target, a SKILL.md folder for a project, and
// for a project no wider skill of the same name the person sees (a project only adds names). What the person saw is
// bound to a hash of every file of the skill, the name, the target and who gets and may change it (`token`), checked
// again when it moves or is copied. The AI may propose any move the Skills page makes, and a copy the person asks for:
// its card says who gains and loses the skill (by name only to who may see that: seesWho) and always shows SKILL.md.
// Audited as `skills.move` / `skills.copy` (both levels, the counts), and each change of a skills folder as
// `skills.change` (skills/changes.ts).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Locale, SkillLevel, SkillMoveOptions, SkillMoveTarget } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { audit } from '../admin/audit'
import { atLeast, type Principal } from '../policy/access'
import { authorize } from '../policy/authorize'
import { foldKey } from '../policy/names'
import { groupSkillRoots, isPersonalSkill, isSkillManifest, listGroupSkills, listSkills, listTeamSkills, liveProjectRoots, personalSkillsDir, projectOfFolder, projectSkillSections, readSkill, sameSkillName, skillFolder, skillTier, widerSkillsNamed, type Skill } from '../chat/skills'
import { mayEditProject } from '../chat/projects'
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

/** A name on one line, cut at 40 characters. */
const short = (s: string) => { const t = s.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').trim(); return [...t].length > 40 ? [...t].slice(0, 39).join('') + '…' : t }

/** "팀 전체", "리드 부서", "견적 프로젝트 채팅", "나만" (names one line, cut at 40). */
export function levelLabel(l: Level, L: Locale): string {
  if (l.level === 'group') return st('levelGroup', L, { group: short(l.group.name) })
  if (l.level === 'project') return st('levelProject', L, { project: short(l.project.name) })
  return st(l.level === 'team' ? 'levelTeam' : 'levelPersonal', L)
}

/** The skills folder of a level, in words: "팀 스킬 폴더(skills/)", "리드 부서의 스킬 폴더", "견적 프로젝트의 스킬 폴더". */
export function levelFolder(l: Level, L: Locale): string {
  if (l.level === 'group') return st('folderGroup', L, { group: short(l.group.name) })
  if (l.level === 'project') return st('folderProject', L, { project: short(l.project.name) })
  return st(l.level === 'team' ? 'folderTeam' : 'folderPersonal', L)
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

/** Whether `asker` may see by name who is at level `l` (who reads or writes its skills): the owner and admins see it all
 * (Admin › People, Admin › Folder permissions); a project's creator sees their project's people on its access screen;
 * one's own skills are one's own. Anyone else gets counts only: members do not see group membership or a project's
 * participants anywhere in the app (/api/people has no groups; GET /api/projects/:id/access is its creator's and
 * admins'). */
export function seesWho(ctx: AppContext, asker: Principal, l: Level): boolean {
  if (asker.role === 'owner' || asker.role === 'admin' || l.level === 'personal') return true
  if (l.level !== 'project') return false
  const r = ctx.db.query('SELECT created_by FROM projects WHERE id = ?').get(l.project.id) as { created_by: string | null } | null
  return !!r && mayEditProject(ctx.files, asker, { folder_path: l.folder, created_by: r.created_by })
}

/** Some people by name (one line each, cut at 40, sorted in `L`), at most `max`; `more`: the rest. */
export function peopleNames(ctx: AppContext, ids: Iterable<string>, L: Locale, max = 5): { names: string[]; more: number } {
  const want = new Set(ids)
  const byId = new Map(activePeople(ctx.db).filter((p) => want.has(p.id)).map((p) => [p.id, short(p.name) || p.id]))
  const names = [...want].filter((id) => byId.has(id)).map((id) => byId.get(id)!).sort(new Intl.Collator(L).compare)
  return { names: names.slice(0, max), more: want.size - Math.min(names.length, max) }
}

/** "김소라, 박준호 외 2명". */
export function peopleText(p: { names: string[]; more: number }, L: Locale): string {
  if (!p.names.length) return st('morePeopleOnly', L, { n: String(p.more) })
  return p.names.join(', ') + (p.more ? ' ' + st('morePeople', L, { n: String(p.more) }) : '')
}

/** One line of what a move or copy changes for people: "2명이 새로 쓰고 2명은 못 쓰게 돼요 (3명 → 3명)." (never
 * "2 more (3 → 3)": two gain it and two lose it). A copy loses nobody; its "after" counts both. */
export function changeLine(p: Pick<MovePlan, 'gained' | 'lost' | 'fromPeople' | 'afterPeople'>, L: Locale): string {
  const vars = { gained: String(p.gained), lost: String(p.lost), fromN: String(p.fromPeople), toN: String(p.afterPeople), n: String(p.afterPeople) }
  return st(p.gained && p.lost ? 'moveBoth' : p.gained ? 'moveGainedOnly' : p.lost ? 'moveLost' : 'moveSamePeople', L, vars)
}

/** "옮기면 5명이 고칠 수 있어요." with how many of them are new. */
export function editorsLine(p: Pick<MovePlan, 'editors' | 'editorsGained' | 'copy'>, L: Locale): string {
  return st(p.editorsGained ? (p.copy ? 'copyEditorsNew' : 'moveEditorsNew') : p.copy ? 'copyEditors' : 'moveEditors', L, { n: String(p.editors), gained: String(p.editorsGained) })
}

/** The skill `user` has at `rel` (readSkill with its project when it is a project's, which they must see). */
export function skillAt(ctx: AppContext, user: Principal, rel: string): { skill: Skill; level: Level } | null {
  const level = levelOfPath(ctx, user, rel)
  if (!level) return null
  if (level.level === 'project' && !atLeast(ctx.files.rules().access(user, level.folder.split('/')), 'read')) return null
  const skill = readSkill(ctx.files, user, rel, level.level === 'project' ? { project: { id: level.project.id, name: level.project.name, folderPath: level.folder } } : {})
  return skill ? { skill, level } : null
}

interface FileHash { path: string; size: number; sha: string; bytes: Buffer }
/** Every regular file of the skill (its folder, or the single file), by path, with its hash and the bytes hashed (the
 * card shows them, a copy writes them); no links. */
function skillFiles(ctx: AppContext, user: Principal, from: string): FileHash[] {
  const root = ctx.files.fx.root
  const out: FileHash[] = []
  let total = 0
  const walk = (rel: string) => {
    const r = authorize(ctx.files.fx, ctx.files.rules(), user, rel, 'read')
    const st = fs.lstatSync(r.abs)
    if (st.isSymbolicLink()) throw new HttpError('conflict', 'a link in the skill folder')
    if (st.isDirectory()) { for (const n of fs.readdirSync(r.abs).sort()) walk(`${r.rel}/${n}`); return }
    if (!st.isFile()) return
    if (out.length >= MOVE_MAX_FILES || (total += st.size) > MOVE_MAX_BYTES) throw new HttpError('payload_too_large', 'too many files', { params: { reason: 'skill_too_large' } })
    const bytes = fs.readFileSync(path.join(root, ...r.rel.split('/')))
    out.push({ path: r.rel, size: bytes.length, sha: crypto.createHash('sha256').update(bytes).digest('hex'), bytes })
  }
  walk(from)
  return out
}

/** A copy's name: what a folder name may be (lowercase a-z, 0-9, hyphens; at most 64). */
export const COPY_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

/** SKILL.md (or a single-file skill) with its header's name line set to `name`; null when it has no header name. Only
 * that line changes. */
export function withName(text: string, name: string): string | null {
  const m = /^(﻿?---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/.exec(text)
  if (!m) return null
  let done = false
  const head = m[2]!.replace(/^name[ \t]*:.*$/m, () => { done = true; return `name: ${name}` })
  return done ? m[1]! + head + m[3]! + text.slice(m[0].length) : null
}

/** One move or copy as it would go, with who gains and loses it, and why not (a SKILL_TEXT key and its words). */
export interface MovePlan {
  skill: Skill
  from: Level
  to: Level
  /** a copy: the skill stays where it is (move_skill's `keep`) */
  copy: boolean
  /** its name at the target (a copy with a new name: that one) */
  name: string
  /** what moves or is copied: the skill's folder, or its single file */
  source: string
  target: string
  /** the entry at the target */
  entry: string
  files: FileHash[]
  /** the entry file's text as it would be at the target (a renamed copy: its name line changed), from the hashed bytes */
  text: string
  fromPeople: number
  toPeople: number
  /** who has it (or, for a copy, either one) afterwards */
  afterPeople: number
  gained: number
  lost: number
  /** who newly gets it there and who stops getting it (ids; the card names them only to who may see them: seesWho) */
  gainedIds: string[]
  lostIds: string[]
  /** who may change it there, and how many of them may not change it now */
  editors: number
  editorsGained: number
  editorsGainedIds: string[]
  /** who gets it and who may change it there (ids, sorted: bound by `token`), and who may change it now */
  readerIds: string[]
  editorIds: string[]
  fromEditorIds: string[]
  /** a project skill of the same name it would hide, at a wider level ("the project Falcon"), or null */
  shadows: string | null
  blocked: { key: keyof typeof SKILL_TEXT; vars: Record<string, string> } | null
  token: string
}

/** Where "the same name" is for the person: the label of a wider skill whose name, or file or folder name, `name` is. */
function widerSameName(ctx: AppContext, user: Principal, name: string, except: string | undefined, L: Locale): string | null {
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

const tierOf = (l: Level) => (l.level === 'personal' ? 0 : l.level === 'group' ? 1 : l.level === 'team' ? 2 : 3)
/** It would be followed above where it is now (personal > group > team > project), or out of a project's chats. */
export const raisesTrust = (p: Pick<MovePlan, 'from' | 'to'>) => tierOf(p.to) < tierOf(p.from)

/**
 * A move, or with `copy` a copy (the original stays; `name`: the copy's new name), of `have` to `to`. A move needs write
 * on both places; a copy reads the original and writes the target. Both: no skill of that name at the target, a SKILL.md
 * folder for a project, and for a project no wider skill of the name the person sees (a moved skill leaves, so it is not
 * counted; a copied one stays, so a copy under its own name into a project is refused: it would never run for them).
 */
export function planMove(ctx: AppContext, user: Principal, have: { skill: Skill; level: Level }, to: Level, L: Locale, o: { copy?: boolean; name?: string } = {}): MovePlan {
  const { skill, level: from } = have
  const copy = !!o.copy
  const manifest = isSkillManifest(skill.path)
  const source = manifest ? skillFolder(skill.path) : skill.path
  const name = copy && o.name ? o.name : skill.name
  const base = copy && o.name ? (manifest ? o.name : `${o.name}.md`) : source.split('/').pop()!
  const target = `${to.root}/${base}`
  const entry = manifest ? `${target}/SKILL.md` : target
  const files = skillFiles(ctx, user, source)
  const rules = ctx.files.rules()
  const toWords = levelLabel(to, L)
  let blocked: MovePlan['blocked'] = null
  const block = (key: keyof typeof SKILL_TEXT, vars: Record<string, string> = {}) => { blocked ??= { key, vars } }
  if (!copy && sameLevel(from, to)) block('moveSame')
  if (copy && o.name !== undefined && !COPY_NAME.test(o.name)) block('folderName')
  if (!copy && rules.access(user, source.split('/')) !== 'write') block('moveNoWrite', { where: levelFolder(from, L) })
  if (to.level === 'project' && !manifest) block('moveNotFolder', { name: skill.name })
  if (to.level !== 'personal' && rules.access(user, target.split('/')) !== 'write') block('moveNoWrite', { where: levelFolder(to, L) })
  // a copy lands without the folder rules inside the skill's folder: its restricted files would reach more people
  if (copy && manifest && rules.ruleFolders().some((f) => foldKey(f).startsWith(foldKey(source) + '/'))) block('copyRuled', { name: skill.name })
  // a skills folder that is not there yet (a project's first skill, a person's first own skill) is free: runMove makes it
  let exists = false
  try { exists = authorize(ctx.files.fx, rules, user, target, 'write', { mustExist: false, createDirs: true }).exists } catch { exists = false }
  if (exists || skillsAtLevel(ctx, user, to).some((s) => s.path !== (copy ? '' : skill.path) && sameSkillName(s.name, name))) block('moveTaken', { to: toWords, name })
  if (to.level === 'project') {
    // the moved skill leaves: what it hides now counts too; a copied one stays and keeps winning for its people
    const where = widerSameName(ctx, user, name, copy ? undefined : skill.path, L)
    if (where) block(copy ? 'copyHidden' : 'moveHidden', { name, where })
  }
  // the text the card shows: the hashed bytes, as they would be at the target
  const own = files.find((f) => f.path === skill.path) ?? files.find((f) => foldKey(f.path) === foldKey(skill.path))
  let text = own ? own.bytes.toString('utf8') : ''
  if (copy && o.name && o.name !== skill.name) {
    const renamed = withName(text, o.name)
    if (renamed === null) block('copyNoName', { name: skill.name })
    else text = renamed
  }
  // at a wider level than a project, a project skill of that name the person sees is hidden for those who get this one
  let shadows: string | null = null
  if (to.level !== 'project') {
    const hit = projectSkillSections(ctx.files, user).find((x) => x.skill.path !== (copy ? '' : skill.path) && sameSkillName(x.skill.name, name))
    if (hit?.skill.project) shadows = st('whereProject', L, { project: hit.skill.project.name })
  }
  const a = reachOf(ctx, user, from, skill.path), b = reachOf(ctx, user, to, entry)
  const gainedIds = [...b].filter((x) => !a.has(x)).sort(), lostIds = copy ? [] : [...a].filter((x) => !b.has(x)).sort()
  const ea = editorsOf(ctx, user, from, source), eb = editorsOf(ctx, user, to, target)
  const editorsGainedIds = [...eb].filter((x) => !ea.has(x)).sort()
  const readerIds = [...b].sort(), editorIds = [...eb].sort()
  // what the person saw, bound together: every file, the name, and who gets it and who may change it there (a change of
  // any of these between the card and the move refuses it: runMove, runCopy)
  const token = crypto.createHash('sha256').update(JSON.stringify({ copy, name, source, target, files: files.map((f) => [f.path, f.sha]), readers: readerIds, editors: editorIds })).digest('hex').slice(0, 64)
  return {
    skill, from, to, copy, name, source, target, entry, files, text, fromPeople: a.size, toPeople: b.size, afterPeople: copy ? new Set([...a, ...b]).size : b.size,
    gained: gainedIds.length, lost: lostIds.length, gainedIds, lostIds, editors: eb.size, editorsGained: editorsGainedIds.length, editorsGainedIds, readerIds, editorIds,
    fromEditorIds: [...ea].sort(), shadows, blocked, token,
  }
}

/** The whole text shown before a move reaches more people (the Skills page's dialog and the AI's card): at most this. */
export const MOVE_TEXT_MAX = 64 * 1024

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
  // the text from the bytes that were hashed (what the token binds), not read again
  const own = files.find((f) => f.path === have.skill.path) ?? files.find((f) => foldKey(f.path) === foldKey(have.skill.path))
  return {
    path: have.skill.path, name: have.skill.name,
    from: { label: levelLabel(have.level, L), people: reachOf(ctx, user, have.level, have.skill.path).size, level: have.level.level },
    files: files.map((f) => ({ path: f.path, size: f.size })), text: own ? own.bytes.toString('utf8').slice(0, MOVE_TEXT_MAX) : '', targets,
  }
}

/** The plan again for `rel` and `to` (both checked again), refused when blocked or when it is not what was shown. */
function replan(ctx: AppContext, user: Principal, rel: string, to: SkillLevel, token: string, L: Locale, o: { copy?: boolean; name?: string }): MovePlan {
  const have = skillAt(ctx, user, rel)
  if (!have) throw new HttpError('not_found', st('moveNotFound', L))
  const level = levelFor(ctx, user, to)
  if (!level) throw new HttpError('not_found', st('moveNotFound', L))
  const plan = planMove(ctx, user, have, level, L, o)
  if (plan.blocked) throw new HttpError('conflict', st(plan.blocked.key, L, plan.blocked.vars), { params: { reason: 'skill_move_blocked' } })
  // the files, the name, who gets it or who may change it differ from what was shown: nothing moves, the person looks again
  if (plan.token !== token) throw new HttpError('conflict', st('moveChanged', L), { params: { reason: 'skill_move_changed' } })
  // the target's skills folder may not be there yet: made now (it has no rules of its own, so its folder's rules apply)
  const parent = plan.target.split('/').slice(0, -1)
  authorize(ctx.files.fx, ctx.files.rules(), user, parent.join('/'), 'write', { mustExist: false, createDirs: true })
  fs.mkdirSync(path.join(ctx.files.fx.root, ...parent), { recursive: true, mode: 0o700 })
  return plan
}

// a person's own folder is never named in the audit log (admins read it; they cannot read users/<id>/)
const side = (l: Level, people: number, p: string) => ({ level: l.level, ...(l.level === 'group' ? { group: l.group } : l.level === 'project' ? { project: l.project } : {}), people, path: l.level === 'personal' ? null : p })

/** Move it, as planned and seen (`token`): everything is checked again first. `turnId` / `tool`: the AI's move_skill,
 * after the person's yes on its card. Returns the plan that ran. */
export function runMove(ctx: AppContext, userId: string, rel: string, to: SkillLevel, token: string, L: Locale, o: { turnId?: string | null; tool?: string } = {}): MovePlan {
  const user = ctx.files.principal(userId)
  const plan = replan(ctx, user, rel, to, token, L, {})
  componentC(ctx).files.move(userId, plan.source, plan.target, 'fail', { confirm: true, turnId: o.turnId ?? null, tool: o.tool ?? 'skill_move', skillMove: true })
  audit(ctx.db, {
    actor: userId, action: 'skills.move', target: plan.to.level === 'personal' ? plan.skill.path : plan.entry,
    detail: { name: plan.skill.name, from: side(plan.from, plan.fromPeople, plan.skill.path), to: side(plan.to, plan.toPeople, plan.entry), gained: plan.gained, lost: plan.lost, editors: plan.editors, editorsGained: plan.editorsGained, files: plan.files.length, byAi: !!o.turnId, turnId: o.turnId ?? null },
  })
  return plan
}

/** Copy it (the original stays), as planned and seen (`token`): planned again, and the bytes written are the ones just
 * hashed, which the token binds, so what lands is byte for byte what the card showed (a renamed copy: only its folder or
 * file name and its name line differ). Audited as `skills.copy` (both levels, the files, the entry's hash); its file
 * event says where it came from (`copiedFrom`, skills/changes.ts). */
export function runCopy(ctx: AppContext, userId: string, rel: string, to: SkillLevel, token: string, L: Locale, o: { name?: string; turnId?: string | null; tool?: string } = {}): MovePlan {
  const user = ctx.files.principal(userId)
  const plan = replan(ctx, user, rel, to, token, L, { copy: true, name: o.name })
  const manifest = isSkillManifest(plan.skill.path)
  const entryFile = plan.files.find((f) => f.path === plan.skill.path) ?? plan.files.find((f) => foldKey(f.path) === foldKey(plan.skill.path))
  const renamed = plan.name !== plan.skill.name
  // the bytes this plan hashed (never read again), the entry with its name line changed for a renamed copy
  const out = plan.files.map((f) => ({ segs: manifest ? f.path.slice(plan.source.length + 1).split('/') : [], bytes: f === entryFile && renamed ? Buffer.from(plan.text, 'utf8') : f.bytes }))
  componentC(ctx).files.writeSkillCopy(userId, plan.from.level === 'personal' ? null : plan.source, plan.target, out, { folder: manifest, turnId: o.turnId ?? null, tool: o.tool ?? 'skill_copy' })
  const written = entryFile ? (renamed ? crypto.createHash('sha256').update(Buffer.from(plan.text, 'utf8')).digest('hex') : entryFile.sha) : null
  audit(ctx.db, {
    actor: userId, action: 'skills.copy', target: plan.to.level === 'personal' ? plan.skill.path : plan.entry,
    detail: { name: plan.skill.name, as: plan.name, from: side(plan.from, plan.fromPeople, plan.skill.path), to: side(plan.to, plan.toPeople, plan.entry), files: plan.files.length, sha256: written, sourceSha256: entryFile?.sha ?? null, gained: plan.gained, editors: plan.editors, editorsGained: plan.editorsGained, byAi: !!o.turnId, turnId: o.turnId ?? null },
  })
  return plan
}
