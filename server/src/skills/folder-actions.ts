// skill_files (chat/skill-files.ts): the AI's move, copy or rename of one item that touches a skill folder
// (docs/DECISIONS.md "Skill folders: the AI's file actions"). Before, every such call got one refusal, even an admin's
// rename of a project folder that only holds skills (refusal audit 2026-11-10, A6, A7 and bug 3). The security review
// narrowed it to three kinds, each behind one server card the person answers in their own chat:
//   N  a group's or a project's folder (groups/<g>, projects/<p>) that holds skills renamed in place, when nothing
//      changes for anyone: the same skills for the same people, the same editors, the same readers of every file, judged
//      by the folder rules before and after. Also a skill's own folder renamed in its skills folder, with its `name:`
//      line on the same card (R: without it the skill stops loading).
//   O  files, skills or rules leaving a skill root: moved out, the skills folder itself renamed, a group's or a
//      project's folder moved out of its place (its skills stop), or a file copied out. The card names the skills and
//      how many people lose them, and who gains or loses the files.
//   I  a SKILL.md folder of text files going into a skill root, at an exact target that is not there yet. The card
//      shows every word of every file the AI would follow, who newly gets it and may change it, and the same name
//      elsewhere (counted for each person who gets it, named only where the asker can read it). Nothing that is not
//      text goes in (pictures, media, Office files, PDFs: cut by the product owner, a person uploads them on the Files
//      screen), nor a file on its own (a .md is a team rule or a skill; other text is write / edit's), an instruction
//      file name, or text past the card's limit.
// Everything else is refused before any card, with the reason and what to do instead (move_skill for a whole skill to
// another level, write / edit for text, the Files screen for the rest). Moves that would switch a group's or a
// project's skills on, groups/ and projects/ themselves and the person's own skills folder are among them.
// What the card shows is bound to a token: every file's path and hash, the target, who follows each skill and who may
// change it, who can see the files. The file service takes a grant for exactly that operation and plans it again right
// before the rename or copy (skills/guard.ts takeSkillAction): anything that differs refuses it. "I" places the bytes
// the card showed as new files.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { audit } from '../admin/audit'
import { groupOfFolder, listGroupSkills, listSkills, listTeamSkills, liveProjectRoots, parseSkill, projectOfFolder, sameSkillName, skillAlias, skillEntriesOnDisk, skillFileProblem, skillTier, widerSkillsNamed, type Skill } from '../chat/skills'
import { ext } from '../files/extract'
import { readRegular } from '../files/store'
import { atLeast, RuleSet, type Principal } from '../policy/access'
import { authorize } from '../policy/authorize'
import { Denied, ToolError } from '../policy/errors'
import { badSegment, foldKey } from '../policy/names'
import { componentC } from '../team-files/component'
import { FileError } from '../team-files/errors'
import { activePeople } from '../team-files/service'
import { allowSkillAction, dropSkillAction, projectLevelPossible, skillRootOf, type SkillActionGrant } from './guard'
import { copyNameOk, withName, type Level } from './move'

export type FolderAction = 'move' | 'copy' | 'rename'
export interface FolderActionInput { action: FolderAction; path: string; to_folder?: string; new_name?: string }

/** A file the card is bound to: its path, size, hash and the bytes hashed ("I" places these); `exec`: its mode lets it
 * run (a skill's script keeps that when it is placed anew). */
interface FileHash { path: string; size: number; sha: string; bytes: Buffer; exec: boolean }

/** A skill or team rule the action changes: stops being followed (O), new (I), changed (a file of it moves), renamed or
 * kept (N, R). `followers`: who follows it (ids; before for O, after for the rest). */
export interface SkillTouched { name: string; entry: string; kind: 'skill' | 'rule'; effect: 'stops' | 'new' | 'changes' | 'renamed' | 'kept'; followers: string[]; readable: boolean }

/** N: a group's or project's folder renamed; R: a skill's folder renamed (with its name line); O: out; I: in */
export type FolderKind = 'rename_folder' | 'rename_skill' | 'out' | 'in'

export interface FolderPlan {
  kind: FolderKind
  action: FolderAction
  /** a group's or project's folder (its skills folder inside it) rather than something in a skill root */
  holder: boolean
  /** the item and where it goes, as the file service resolves them */
  from: string
  to: string
  isDir: boolean
  /** the files the token binds (a group's or project's folder: its skills folder's files) */
  files: FileHash[]
  /** every text file the AI would follow, in full, as it will be (I: the folder's text files; R: the new SKILL.md) */
  texts: { path: string; text: string }[]
  skills: SkillTouched[]
  /** the level of the skill root involved (the target's for I, N and R, the source's for O), null for a skills folder no
   * group or live project has (nobody follows it) */
  level: Level | null
  /** who stops getting a skill (O) or newly gets it (I), ids */
  lostIds: string[]
  gainedIds: string[]
  /** who may change it at the target, and who of them may not change it now (I) */
  editorIds: string[]
  editorsGainedIds: string[]
  /** who else can see the files afterwards and could not before, and who no longer can (ids, never the asker) */
  seeAdded: string[]
  seeLost: string[]
  /** a move into the asker's own folder: how many others lose it (the file service asks for confirm) */
  narrowed: number
  /** I and R into a wider level: for how many who get it a project skill of the same name is hidden, and the projects
   * the asker can read */
  shadow: { people: number; projects: string[] } | null
  /** I and R: for how many who get it a wider skill of the same name runs instead (a project's: a group's or the team's;
   * the team's: a group's) */
  hiddenFor: number
  /** I and R into a group: for how many who get it this one takes the place of the team's skill of the same name */
  replaces: number
  /** R: the new name and SKILL.md as it will be (its hash before: what the rewrite expects) */
  rename: { name: string; entry: string; text: string; oldSha: string } | null
  token: string
}
export interface FolderRefused { refused: { why: string; next: string; say?: 'fileMediaNext' } }

/** The card shows the text in full: more than this many characters in all is refused, never cut. */
export const FOLDER_TEXT_MAX = 60_000
/** A folder this large is moved on the Files screen. */
export const FOLDER_MAX_FILES = 500
export const FOLDER_MAX_BYTES = 50 * 1024 * 1024
const INSTRUCTION = /^(CLAUDE|AGENTS|GEMINI)\.md$/i

const FILES = 'the user can do it on the Files screen'
const ADMIN = 'an admin can do it on the Files screen'

/** `say`: a next step the user is told in their own language (skills/text.ts), besides `next` for the AI */
type Say = 'fileMediaNext'
class Refuse extends Error { constructor(readonly why: string, readonly next: string = FILES, readonly say?: Say) { super(why) } }
const refuse = (why: string, next?: string, say?: Say): never => { throw new Refuse(why, next, say) }

const fold = (s: string) => s.normalize('NFC').toLowerCase()
const clean = (p: string) => p.normalize('NFC').split('/').filter((s) => s !== '' && s !== '.').join('/')
const segsOf = (p: string) => (p ? p.split('/') : [])
const nameOf = (p: string) => p.split('/').pop() ?? ''
const parentOf = (p: string) => p.split('/').slice(0, -1).join('/')
const join = (a: string, b: string) => (a ? `${a}/${b}` : b)
const under = (p: string, f: string) => p === f || p.startsWith(f + '/')
const sha256 = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex')
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i])
const holderWord = (s: string) => fold(s) === 'groups' || fold(s) === 'projects'
/** groups/<g> or projects/<p>: where a group's or project's folder is (its skills/ is a skill root) */
const holderPos = (p: string) => { const s = segsOf(p); return s.length === 2 && holderWord(s[0]!) && !!s[1] }
/** users/<id>/skills and below: a person's own skills (move_skill moves skills there) */
const personalSkills = (p: string) => { const s = segsOf(p); return s.length >= 3 && fold(s[0]!) === 'users' && fold(s[2]!) === 'skills' }
/** the skills folder of the skill root `rel` is in, as written in `rel` */
function rootFolder(rel: string): string | null {
  const r = skillRootOf(rel)
  return r ? (r.kind === 'team' ? segsOf(rel)[0]! : segsOf(rel).slice(0, 3).join('/')) : null
}
// Characters a person cannot see on the card or that turn the text around them (review MUST 1): format characters
// (zero-width ones, bidi marks, overrides and isolates, the tag block), other default-ignorable ones, private-use
// characters, lone surrogates, noncharacters, C1 controls, and the C0 controls other than tab and line breaks. The same
// test as a connection's name and notes (integrations/connections/service.ts hiddenText): an emoji's presentation
// selector and a zero-width joiner between two emoji are allowed; one byte-order mark at the start is too.
const HIDDEN = /[\p{Cf}\p{DI}\p{Co}\p{Cs}\p{Noncharacter_Code_Point}\u0080-\u009f\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
const EMOJI = /\p{Emoji}/u
const PICTOGRAPH = /\p{Extended_Pictographic}/u
export function hiddenChars(text: string): boolean {
  const cps = [...text.replace(/^\ufeff/, '')]
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i]!
    if (!HIDDEN.test(c)) continue
    if ((c === '\ufe0f' || c === '\ufe0e') && i > 0 && EMOJI.test(cps[i - 1]!)) continue
    if (c === '\u200d') {
      let j = i - 1
      if (cps[j] === '\ufe0f') j--
      if (j >= 0 && /\p{Emoji_Modifier}/u.test(cps[j]!)) j--
      if (j >= 0 && PICTOGRAPH.test(cps[j]!) && PICTOGRAPH.test(cps[i + 1] ?? '')) continue
    }
    return true
  }
  return false
}

/** text the AI could follow: no NUL byte at the start and valid UTF-8 */
function looksText(b: Buffer): boolean {
  if (b.subarray(0, 8000).includes(0)) return false
  try { new TextDecoder('utf-8', { fatal: true }).decode(b); return true } catch { return false }
}

/** The level of the skill root `rel` is in, from its path: the team's, the group whose folder it is (its members), the
 * live project on it (who sees the project), or null (a skills folder no group or live project has: nobody follows it).
 * `as`: a group's or project's folder renamed from `as.from` to `as.to`: the group or project follows it. */
function levelAt(ctx: AppContext, rel: string, as?: { from: string; to: string }): Level | null {
  const r = skillRootOf(rel)
  if (!r) return null
  if (r.kind === 'team') return { level: 'team', root: rootFolder(rel)! }
  const renamed = !!as && foldKey(r.folder) === foldKey(as.to)
  const folder = renamed ? as!.from : r.folder
  if (r.kind === 'group') {
    // a group's skills run only from groups/<one name> (chat/skills.ts groupSkillRoots)
    if (renamed && (segsOf(r.folder)[0] !== 'groups')) return null
    const g = groupOfFolder(ctx.db, folder)
    return g ? { level: 'group', root: `${r.folder}/skills`, group: { id: g.id, name: g.name } } : null
  }
  if (renamed && !projectLevelPossible(r.folder)) return null
  const p = projectOfFolder(ctx.db, folder)
  return p ? { level: 'project', root: `${r.folder}/skills`, folder: r.folder, project: { id: p.id, name: p.name } } : null
}

/** Who follows a skill at `entry` on level `l` under `rules`: who reads it, and for a group its members only, for a
 * project those who see the project (ids, sorted). */
function followers(ctx: AppContext, rules: RuleSet, l: Level | null, entry: string): string[] {
  if (!l || l.level === 'personal') return []
  const s = segsOf(entry)
  return activePeople(ctx.db).filter((p) => {
    if (l.level === 'group' && !p.groups.includes(l.group.id)) return false
    if (l.level === 'project' && !atLeast(rules.access(p, segsOf(l.folder)), 'read')) return false
    return atLeast(rules.access(p, s), 'read')
  }).map((p) => p.id).sort()
}
/** Who may change `rel` under `rules` (write), ids sorted. */
const editors = (ctx: AppContext, rules: RuleSet, rel: string) => activePeople(ctx.db).filter((p) => rules.access(p, segsOf(rel)) === 'write').map((p) => p.id).sort()
/** Who can read `rel` under `rules`, but `except` (the asker), ids sorted. */
const readers = (ctx: AppContext, rules: RuleSet, rel: string, except: string) => activePeople(ctx.db).filter((p) => p.id !== except && atLeast(rules.access(p, segsOf(rel)), 'read')).map((p) => p.id).sort()

/** The folder rules as they will be after `from` moves to `to`: a moved folder's rules go with it (team-files
 * relocate moves the folders rows), everything else stays. */
function rulesAfterMove(ctx: AppContext, from: string, to: string): RuleSet {
  const rows = ctx.db.query('SELECT f.path, r.subject_type, r.subject_id, r.access FROM folder_rules r JOIN folders f ON f.id = r.folder_id').all() as { path: string; subject_type: never; subject_id: string | null; access: never }[]
  return new RuleSet(rows.map((r) => ({ ...r, path: r.path === from ? to : r.path.startsWith(from + '/') ? to + r.path.slice(from.length) : r.path })))
}

/** Every regular file below `rel` (or `rel` itself), with its hash and bytes: no links, no hard links, nothing the asker
 * cannot read, at most FOLDER_MAX_FILES / FOLDER_MAX_BYTES. */
function walk(ctx: AppContext, user: Principal, rules: RuleSet, rel: string): FileHash[] {
  const root = ctx.files.fx.root
  const r = authorize(ctx.files.fx, rules, user, rel, 'read', { mustExist: true })
  const out: FileHash[] = []
  let total = 0
  // its own name too (a planted direction character would show `from` otherwise than it is)
  const top = nameOf(r.rel)
  if (badSegment(top.normalize('NFC')) || hiddenChars(top)) refuse(`the name '${r.rel}' cannot be shown as it is on the card`)
  const visit = (relp: string) => {
    const abs = path.join(root, ...relp.split('/'))
    const st = fs.lstatSync(abs)
    if (st.isSymbolicLink()) refuse(`'${relp}' is a link; links are not moved into or out of skill folders`)
    if (st.isDirectory()) {
      for (const n of fs.readdirSync(abs).sort()) {
        // a name the card cannot show as it is (control, invisible or direction characters): refused, never shown
        const bad = badSegment(n.normalize('NFC'))
        if (bad || hiddenChars(n)) refuse(`a name in '${relp}' cannot be shown as it is on the card (${bad ?? 'invisible or direction-changing characters'})`)
        visit(`${relp}/${n}`)
      }
      return
    }
    if (!st.isFile()) refuse(`'${relp}' is not a regular file`)
    if (st.nlink > 1) refuse(`'${relp}' is hard-linked to another file; replace it with a copy first`)
    if (!atLeast(rules.access(user, relp.split('/')), 'read')) refuse('something inside it is hidden from the user', ADMIN)
    if (out.length >= FOLDER_MAX_FILES || (total += st.size) > FOLDER_MAX_BYTES) refuse(`it is too large to show on one card (more than ${FOLDER_MAX_FILES} files or ${FOLDER_MAX_BYTES / 1024 / 1024} MB)`)
    const bytes = readRegular(abs, FOLDER_MAX_BYTES).bytes
    out.push({ path: relp, size: bytes.length, sha: sha256(bytes), bytes, exec: (st.mode & 0o111) !== 0 })
  }
  visit(r.rel)
  return out
}

/** The child folder of `abs` named skills (any letter case), as on disk, or null. */
function skillsChild(abs: string): string | null {
  let names: fs.Dirent[]
  try { names = fs.readdirSync(abs, { withFileTypes: true }) } catch { return null }
  return names.find((d) => fold(d.name) === 'skills' && d.isDirectory())?.name ?? null
}

/** The SKILL.md folder `rel` is in (its folder, below the skill root), or null. */
function packageOf(ctx: AppContext, rel: string): string | null {
  const rf = rootFolder(rel)
  if (!rf) return null
  const s = segsOf(rel)
  for (let n = segsOf(rf).length + 1; n <= s.length; n++) {
    const dir = s.slice(0, n).join('/')
    try { if (fs.lstatSync(path.join(ctx.files.fx.root, ...dir.split('/'), 'SKILL.md')).isFile()) return dir } catch { /* none here */ }
  }
  return null
}

/** The name a skill entry goes by (its header's name, else its folder or file name), from bytes the walk hashed. */
function entryName(entry: string, bytes: Buffer | undefined): string {
  const parsed = bytes ? parseSkill(bytes.toString('utf8'), entry) : null
  return parsed?.name ?? skillAlias(entry)
}

/** The skills already at level `l` as the asker sees them (move_skill's check). */
function skillsAt(ctx: AppContext, user: Principal, l: Level): Skill[] {
  if (l.level === 'team') return listTeamSkills(ctx.files, user)
  if (l.level === 'group') return listGroupSkills(ctx.files, user, l.group.id)
  if (l.level === 'project') return listSkills(ctx.files, user, { project: { id: l.project.id, name: l.project.name, folderPath: l.folder } }).filter((s) => s.project?.id === l.project.id)
  return []
}

/** A new skill called `name` at `l` for `who`: refused when the asker would not get it (a wider one of that name runs
 * instead in a project) or the level has one of that name; for a project, how many of `who` keep a wider one; for a
 * wider level, for how many of `who` it hides a project skill of that name, and those projects the asker sees. */
function nameCheck(ctx: AppContext, user: Principal, rules: RuleSet, l: Level, name: string, who: readonly string[], except?: string): { shadow: FolderPlan['shadow']; hiddenFor: number; replaces: number } {
  if (skillsAt(ctx, user, l).some((s) => s.path !== except && (sameSkillName(s.name, name) || sameSkillName(skillAlias(s.path), name)))) {
    refuse(`a skill called "${name}" is already there; one of the two needs another name first`, 'tell the user which name is taken and ask which one to rename')
  }
  // one name runs personal > group > team > project. For how many who get it another skill of the name wins, or loses to
  // this one, counting only skills the asker can read too: never someone's own skills, nor a group's or the team's the
  // asker cannot see (review S5: a count must not tell names)
  const seen = (s: Skill) => !personalSkills(s.path) && atLeast(rules.access(user, segsOf(s.path)), 'read') && (!s.group || user.groups.includes(s.group.id) || user.role === 'owner' || user.role === 'admin')
  const count = (tier: (t: number) => boolean, skipAsker: boolean) => {
    let n = 0
    for (const id of who) {
      if (skipAsker && id === user.id) continue
      try { if (widerSkillsNamed(ctx.files, ctx.files.principal(id), name, except).some((s) => seen(s) && tier(skillTier(s)))) n++ } catch { /* not loadable: not counted */ }
    }
    return n
  }
  if (l.level === 'project') {
    if (widerSkillsNamed(ctx.files, user, name, except).length) refuse(`the user has a skill called "${name}" at a wider level (their own, a group's or the team's), which runs ahead of a project skill of that name, so this one would never run for them`, 'give it another name first (a SKILL.md folder\'s name and its name: line)')
    return { shadow: null, hiddenFor: count((t) => t < 3, true), replaces: 0 }
  }
  // a group's skill takes the place of the team's of the same name for its members (review SHOULD); a team skill gives
  // way to a group's of that name
  const replaces = l.level === 'group' ? count((t) => t === 2, false) : 0
  const groupFirst = l.level === 'team' ? count((t) => t === 1, false) : 0
  // the live projects with a skill of this name (read from disk), and who of `who` sees them
  const hits: { project: string; folder: string; entry: string }[] = []
  for (const p of liveProjectRoots(ctx.db)) {
    for (const e of skillEntriesOnDisk(ctx.files.fx.root, p.root)) {
      const entry = `${p.root}/${e.path}`
      const n = e.name
      // only projects and skills the asker reads (review S5: a count must not tell that a name exists elsewhere)
      if (entry !== except && sameSkillName(n, name) && atLeast(rules.access(user, segsOf(p.folder)), 'read') && atLeast(rules.access(user, segsOf(entry)), 'read')) hits.push({ project: p.name, folder: p.folder, entry })
    }
  }
  if (!hits.length) return { shadow: null, hiddenFor: groupFirst, replaces }
  const people = new Map(activePeople(ctx.db).map((p) => [p.id, p]))
  let shadowed = 0
  for (const id of who) {
    const p = people.get(id)
    if (p && hits.some((h) => atLeast(rules.access(p, segsOf(h.folder)), 'read') && atLeast(rules.access(p, segsOf(h.entry)), 'read'))) shadowed++
  }
  const named = [...new Set(hits.map((h) => h.project))]
  return { shadow: shadowed ? { people: shadowed, projects: named } : null, hiddenFor: groupFirst, replaces }
}

/** What leaves a skill root with `from` (O): every skill entry the loader finds at or below it (chat/skills.ts
 * skillEntriesOnDisk: SKILL.md folders, single-file skills in any subfolder, the team's rules), and the SKILL.md folder
 * it is part of (that skill changes). */
function leaving(ctx: AppContext, user: Principal, rules: RuleSet, from: string, files: FileHash[], level: Level | null): SkillTouched[] {
  const rf = rootFolder(from)!
  const bytesOf = (p: string) => files.find((f) => f.path === p)?.bytes ?? (() => { try { return readRegular(path.join(ctx.files.fx.root, ...p.split('/')), 128 * 1024).bytes } catch { return undefined } })()
  const out: SkillTouched[] = []
  const add = (entry: string, kind: 'skill' | 'rule', effect: SkillTouched['effect']) =>
    out.push({ name: kind === 'rule' ? nameOf(entry) : entryName(entry, bytesOf(entry)), entry, kind, effect, followers: followers(ctx, rules, level, entry), readable: atLeast(rules.access(user, segsOf(entry)), 'read') })
  const pkg = packageOf(ctx, from)
  if (pkg && !under(pkg, from) && from !== `${pkg}/SKILL.md`) add(`${pkg}/SKILL.md`, 'skill', 'changes')
  for (const e of skillEntriesOnDisk(ctx.files.fx.root, rf)) { const p = `${rf}/${e.path}`; if (under(p, from)) add(p, e.kind, 'stops') }
  return out
}

/** Plan one skill_files call for `user`: what kind it is, everything its card shows, and its token; or why not (in
 * English, for the AI) and what to do instead. Nothing changes. */
export function planFolderAction(ctx: AppContext, user: Principal, a: FolderActionInput): FolderPlan | FolderRefused {
  try { return plan(ctx, user, a) } catch (e) {
    if (e instanceof Refuse) return { refused: { why: e.why, next: e.next, ...(e.say ? { say: e.say } : {}) } }
    if (e instanceof FileError) {
      if (e.key === 'ruleFolder') return { refused: { why: 'only an admin or the owner may move or rename a group\'s or project\'s folder, or a folder with folder permissions (or one holding such a folder)', next: ADMIN } }
      if (e.key === 'exists') return { refused: { why: 'something is already at that place; nothing is put next to it under another name', next: 'ask the user for another name or folder' } }
      return { refused: { why: e.message.replace(/\.$/, ''), next: FILES } }
    }
    if (e instanceof Denied || e instanceof ToolError) return { refused: { why: e.message.replace(/\.$/, ''), next: /^not found or no access/.test(e.message) ? 'check the path (list or glob); if it should be there, the user can ask whoever manages that folder' : FILES } }
    throw e
  }
}

function plan(ctx: AppContext, user: Principal, a: FolderActionInput): FolderPlan {
  const fx = ctx.files.fx
  const svc = componentC(ctx).files
  const rules = ctx.files.rules()
  const src = clean(a.path)
  if (!src) refuse('path is empty', 'give the file or folder to move, copy or rename')
  let target: string
  if (a.action === 'rename') {
    if (a.to_folder !== undefined) refuse('rename takes new_name only (it stays in its folder)', 'call skill_files with action move and to_folder to put it elsewhere')
    const name = (a.new_name ?? '').normalize('NFC')
    if (!name) refuse('new_name is missing', 'call skill_files again with new_name')
    if (name.includes('/')) refuse('new_name is a name, not a path', 'call skill_files with action move and to_folder to put it elsewhere')
    const bad = badSegment(name)
    if (bad) refuse(`invalid name: ${bad}`, 'pick another name')
    if (name.startsWith('.')) refuse('a name that starts with "." is hidden', 'pick another name')
    target = join(parentOf(src), name)
  } else {
    if (a.new_name !== undefined) refuse('new_name is for rename only', 'call skill_files again without new_name')
    if (a.to_folder === undefined) refuse('to_folder is missing', 'call skill_files again with to_folder')
    target = join(clean(a.to_folder!), nameOf(src))
  }
  // where it is and where it would go, as the file service resolves them (and every check it makes: write, admins
  // for managed folders, nothing into itself, nothing protected)
  let from: string, to: string, isDir: boolean, narrowed = 0
  if (a.action === 'copy') {
    const fr = authorize(fx, rules, user, src, 'read', { mustExist: true })
    const tr = authorize(fx, rules, user, target, 'write', { mustExist: false, createDirs: true })
    if (tr.exists) refuse(`something called '${nameOf(tr.rel)}' is already in that folder; a copy never goes next to it under another name`, 'ask the user for another folder, or rename one of them first')
    from = fr.rel; to = tr.rel; isDir = fr.st!.isDirectory()
  } else {
    const m = svc.checkMove(user.id, src, target, 'fail', { createDirs: true })
    if (m.switchOn.length) refuse(`moved there, the skills in it (${m.switchOn.slice(0, 5).join(', ')}) would start to apply in a project's chats; skill_files never switches a group's or project's skills on`, 'move each skill with move_skill (its card says who gets it), or the user can do it on the Files screen')
    from = m.from; to = m.to; isDir = m.isDir; narrowed = m.narrowed
  }
  const fromSegs = segsOf(from)
  const srcRoot = skillRootOf(from), dstRoot = skillRootOf(to)
  if (personalSkills(to) || (personalSkills(from) && !srcRoot)) refuse('the user\'s own skills folder (users/<id>/skills) is a skill level of its own', 'move or copy a whole skill there or from there with move_skill; for any other file, pick another folder')
  // the folder it goes into is there (a skills folder that is not there yet is made for a skill going into it)
  const dirThere = (rel: string) => { try { return fs.lstatSync(path.join(fx.root, ...segsOf(rel))).isDirectory() } catch { return false } }
  const toFolder = parentOf(to)
  if (!dirThere(toFolder) && !(dstRoot && rootFolder(to) === toFolder && dirThere(parentOf(toFolder)))) refuse(`the folder '${toFolder}' is not there`, 'pick a folder that is there (list), or the user can make it on the Files screen')
  if (isDir && fromSegs.length === 1 && fold(fromSegs[0]!) === 'skills') refuse('skills/ is the team\'s skills folder: moving or renaming it would stop every team skill and team rule for everyone at once', ADMIN)
  if (isDir && fromSegs.length === 1 && holderWord(fromSegs[0]!)) refuse(`${from}/ holds every ${fold(fromSegs[0]!) === 'groups' ? 'group' : 'project'}'s folder; moving or renaming it would stop all their skills at once`, ADMIN)
  const skillsDir = isDir ? skillsChild(path.join(fx.root, ...from.split('/'))) : null
  const holder = isDir && !!skillsDir && holderPos(from) && !srcRoot
  // a folder with a skills folder in it landing where a group's or a project's folder is: its skills would switch on
  if (isDir && skillsDir && holderPos(to) && !(a.action === 'rename' && holder)) refuse(`'${to}' is where a group's or a project's folder goes, so the skills folder inside would start to apply there; skill_files never switches skills on`, 'move each skill with move_skill (its card says who gets it), or the user can do it on the Files screen')

  if (a.action === 'rename' && holder) return renameFolder(ctx, user, rules, a, from, to, skillsDir!, narrowed)
  if (a.action === 'rename' && srcRoot && dstRoot) {
    const rf = rootFolder(from)
    if (isDir && parentOf(from) === rf && fs.existsSync(path.join(fx.root, ...from.split('/'), 'SKILL.md'))) return renameSkill(ctx, user, rules, a, from, to)
  }
  if ((srcRoot || holder) && dstRoot) refuse('it would move inside or between skill folders', 'a whole skill goes to another level (the team, a group, a project, the user\'s own) with move_skill; for anything else inside a skill folder the user can use the Files screen')
  if (srcRoot || holder) return out(ctx, user, rules, a, from, to, isDir, holder ? skillsDir : null, narrowed)
  if (dstRoot) return into(ctx, user, rules, a, from, to, isDir, narrowed)
  refuse('it does not touch a skill folder', 'use move_files, copy_files or rename_file for it')
  throw new Error('unreachable')
}

/** N: a group's or project's folder that holds skills, renamed in place; nothing may change for anyone. */
function renameFolder(ctx: AppContext, user: Principal, rules: RuleSet, a: FolderActionInput, from: string, to: string, skillsDir: string, narrowed: number): FolderPlan {
  const after = rulesAfterMove(ctx, from, to)
  const sd = `${from}/${skillsDir}`, td = `${to}/${skillsDir}`
  const before = levelAt(ctx, `${sd}/x`), later = levelAt(ctx, `${td}/x`, { from, to })
  if (!!before !== !!later || (before && later && (before.level !== later.level))) refuse('renamed this way, the skills in it would stop applying', 'pick a name that keeps it a group\'s or project\'s folder, or the user can do it on the Files screen')
  const files = walk(ctx, user, rules, sd)
  const skills: SkillTouched[] = []
  for (const e of skillEntriesOnDisk(ctx.files.fx.root, sd)) {
    const was = `${sd}/${e.path}`, now = `${td}/${e.path}`
    const fb = followers(ctx, rules, before, was), fa = followers(ctx, after, later, now)
    const eb = editors(ctx, rules, was), ea = editors(ctx, after, now)
    const name = entryName(was, files.find((f) => f.path === was)?.bytes)
    if (!same(fb, fa)) refuse(`renamed, the skill "${name}" would reach other people than now`, 'the user can do it on the Files screen, where the folder permissions show who gets what')
    if (!same(eb, ea)) refuse(`renamed, other people than now could change the skill "${name}"`, 'the user can do it on the Files screen, where the folder permissions show who gets what')
    skills.push({ name, entry: now, kind: 'skill', effect: 'kept', followers: fa, readable: atLeast(rules.access(user, segsOf(was)), 'read') })
  }
  // and nobody gains or loses a file in it
  const sb = readers(ctx, rules, from, user.id), sa = readers(ctx, after, to, user.id)
  if (!same(sb, sa)) refuse('renamed, other people than now could see what is in it', 'the user can do it on the Files screen, where the folder permissions show who gets what')
  return finish({ kind: 'rename_folder', action: a.action, holder: true, from, to, isDir: true, files, texts: [], skills, level: later, lostIds: [], gainedIds: [], editorIds: [], editorsGainedIds: [], seeAdded: [], seeLost: [], narrowed, shadow: null, hiddenFor: 0, replaces: 0, rename: null })
}

/** R: a skill's own folder renamed in its skills folder, its SKILL.md's name line with it (else it stops loading). */
function renameSkill(ctx: AppContext, user: Principal, rules: RuleSet, a: FolderActionInput, from: string, to: string): FolderPlan {
  const name = nameOf(to)
  if (!copyNameOk(name)) refuse('a skill\'s folder name uses lowercase letters a-z, digits and hyphens only (at most 64), and its name: line takes the same', 'suggest a name like "estimate-docs" and call skill_files again')
  const files = walk(ctx, user, rules, from)
  const manifest = `${from}/SKILL.md`
  const own = files.find((f) => f.path === manifest)
  if (!own) refuse('it has no SKILL.md at its top', FILES)
  const oldText = own!.bytes.toString('utf8')
  const text = withName(oldText, name)
  if (text === null) refuse('its SKILL.md has no name: line in its header to change with the folder', 'add the name line with write / edit first (the user confirms on a card)')
  const entry = `${to}/SKILL.md`
  if (hiddenChars(text!)) refuse('its SKILL.md holds characters a person cannot see on the card (zero-width, direction or tag characters), so it cannot be shown in full', 'take them out with edit first (the user confirms on a card)')
  const problem = skillFileProblem(ctx.files.fx.root, entry, text!)
  if (problem) refuse(`with the new name its SKILL.md would not load (${problem})`, 'fix the SKILL.md header first with edit, or pick another name')
  const after = rulesAfterMove(ctx, from, to)
  const level = levelAt(ctx, manifest)
  const fb = followers(ctx, rules, level, manifest), fa = followers(ctx, after, level, entry)
  const eb = editors(ctx, rules, from), ea = editors(ctx, after, to)
  if (!same(fb, fa) || !same(eb, ea)) refuse('renamed, other people than now would get or could change it', FILES)
  const old = entryName(manifest, own!.bytes)
  const checked = level ? nameCheck(ctx, user, rules, level, name, fa, manifest) : { shadow: null, hiddenFor: 0, replaces: 0 }
  const skills: SkillTouched[] = [{ name: old, entry, kind: 'skill', effect: 'renamed', followers: fa, readable: true }]
  return finish({ kind: 'rename_skill', action: a.action, holder: false, from, to, isDir: true, files, texts: [{ path: entry, text: text! }], skills, level, lostIds: [], gainedIds: [], editorIds: ea, editorsGainedIds: [], seeAdded: [], seeLost: [], narrowed: 0, ...checked, rename: { name, entry, text: text!, oldSha: own!.sha } })
}

/** O: out of a skill root (or a group's or project's folder moved out of its place: `skillsDir`, its skills stop). */
function out(ctx: AppContext, user: Principal, rules: RuleSet, a: FolderActionInput, from: string, to: string, isDir: boolean, skillsDir: string | null, narrowed: number): FolderPlan {
  if (a.action === 'copy' && isDir) refuse('only single files are copied out of a skill folder', 'copy a whole skill to another level with move_skill (keep: true); for a folder, the user can use the Files screen')
  if (a.action === 'rename' && !skillsDir && rootFolder(from) !== from) refuse('a rename keeps it in the same skill folder', 'the user can do it on the Files screen')
  // a skill's SKILL.md alone: the rest of its folder stays, and what it hid (a SKILL.md folder or a .md skill inside it)
  // would start to apply as skills of their own, which this card never showed (review MUST 2)
  const pkg = !isDir && a.action !== 'copy' ? packageOf(ctx, from) : null
  if (pkg && from === `${pkg}/SKILL.md`) refuse('moving a skill\'s SKILL.md out on its own leaves the rest of its folder behind, and files in it could start to apply as skills of their own', `move the whole skill folder (${pkg}) out instead`)
  const after = a.action === 'copy' ? rules : rulesAfterMove(ctx, from, to)
  let files: FileHash[]
  let skills: SkillTouched[]
  let level: Level | null
  if (skillsDir) {
    const sd = `${from}/${skillsDir}`
    level = levelAt(ctx, `${sd}/x`)
    files = walk(ctx, user, rules, sd)
    skills = leaving(ctx, user, rules, sd, files, level)
  } else {
    level = levelAt(ctx, from)
    files = walk(ctx, user, rules, from)
    skills = leaving(ctx, user, rules, from, files, level)
  }
  if (a.action === 'copy') for (const s of skills) s.effect = 'kept'
  const lostIds = a.action === 'copy' ? [] : [...new Set(skills.filter((s) => s.effect === 'stops').flatMap((s) => s.followers))].sort()
  const sb = readers(ctx, rules, from, user.id), sa = readers(ctx, after, to, user.id)
  const seeAdded = sa.filter((x) => !sb.includes(x)), seeLost = a.action === 'copy' ? [] : sb.filter((x) => !sa.includes(x))
  return finish({ kind: 'out', action: a.action, holder: !!skillsDir, from, to, isDir, files, texts: [], skills, level, lostIds, gainedIds: [], editorIds: [], editorsGainedIds: [], seeAdded, seeLost, narrowed, shadow: null, hiddenFor: 0, replaces: 0, rename: null })
}

/** The next step when a file that is not text would go into a skill folder (the product owner, 2026-11-10: no picture,
 * media or any other non-text file goes in through the AI; a person uploads it on the Files screen). Said to the user in
 * their language (skills/text.ts fileMediaNext). */
const MEDIA_NEXT = 'the user can upload it into the skill folder themselves on the Files screen; tell them so in their words'

/** I: a SKILL.md folder of text files into a skill root. Nothing but text goes in: every word of it is on the card. A
 * single file never does (a .md on its own is a team rule or a skill; other text is written with write / edit), nor a
 * picture, media or any other file that is not text (cut by the product owner: its content would not be on the card). */
function into(ctx: AppContext, user: Principal, rules: RuleSet, a: FolderActionInput, from: string, to: string, isDir: boolean, narrowed: number): FolderPlan {
  const rf = rootFolder(to)!
  if (!isDir) {
    const n = nameOf(to)
    const x = ext(from)
    if (INSTRUCTION.test(n) || n === 'SKILL.md') refuse(`'${n}' is the name of a file the AI follows as instructions`, 'write it with write / edit, where the user sees every word on the card')
    if (x === 'md' || x === 'markdown') refuse('a .md file on its own in a skill folder is a team rule or a skill the AI follows; file actions never make one', 'write it with write (the user sees every word on the card), or put it in a SKILL.md folder and bring the folder in')
    let text = false
    try { text = looksText(readRegular(path.join(ctx.files.fx.root, ...from.split('/')), FOLDER_MAX_BYTES).bytes) } catch { text = false }
    if (text) refuse('a text file goes into a skill folder only written with write / edit, where the user sees every word on the card', 'write it with write / edit')
    refuse('the AI does not put pictures, media or any other file that is not text into a skill folder: its content would not be on the card', MEDIA_NEXT, 'fileMediaNext')
  }
  const level = levelAt(ctx, to)
  if (!level) refuse(`no group or live project uses ${rf}, so no AI would follow what goes there`, 'pick the skills folder of the team, one of the user\'s groups or a project; a folder that is not a project yet is made one with Projects › New project')
  // a SKILL.md folder, right in the skills folder, under the name it goes by
  if (parentOf(to) !== rf) refuse(`a skill goes right into the skills folder (to_folder '${rf}'), not into another folder in it`, 'call skill_files again with that to_folder')
  const files = walk(ctx, user, rules, from)
  const after = a.action === 'copy' ? rules : rulesAfterMove(ctx, from, to)
  // a copy lands without the folder rules inside the source: what they hide would reach more people
  if (a.action === 'copy' && rules.ruleFolders().some((f) => under(f, from) && f !== from)) refuse('a folder inside it has folder permissions of its own, which a copy would not keep', 'move it instead, or the user can do it on the Files screen')
  const manifest = files.find((f) => f.path === `${from}/SKILL.md`)
  if (!manifest) refuse('a folder goes into a skill folder only as a skill: a SKILL.md at its top', 'write a SKILL.md for it first (write, with the user\'s card), or the user can do it on the Files screen')
  const texts: { path: string; text: string }[] = []
  let chars = 0
  for (const f of files) {
    if (INSTRUCTION.test(nameOf(f.path))) refuse(`'${f.path}' is an instruction file (CLAUDE.md, AGENTS.md, GEMINI.md); it is not put into a skill folder`, 'take it out of the folder first, or the user can do it on the Files screen')
    if (!looksText(f.bytes)) refuse(`'${f.path}' is not a text file, and the AI does not put pictures, media or any other file that is not text into a skill folder: its content would not be on the card`, MEDIA_NEXT, 'fileMediaNext')
    const t = f.bytes.toString('utf8')
    // every word on the card: no character a person cannot see there (review MUST 1)
    if (hiddenChars(t)) refuse(`'${f.path}' holds characters a person cannot see on the card (zero-width, direction or tag characters), so it cannot be shown in full`, 'take them out with edit first (the file is the user\'s), or the user can do it on the Files screen')
    chars += t.length
    texts.push({ path: to + f.path.slice(from.length), text: t })
  }
  if (chars > FOLDER_TEXT_MAX) refuse(`its text files are too long to show in full on one card (${chars} characters, at most ${FOLDER_TEXT_MAX})`, FILES)
  const entry = `${to}/SKILL.md`
  const problem = skillFileProblem(ctx.files.fx.root, entry, manifest!.bytes.toString('utf8'))
  if (problem) refuse(`its SKILL.md would not load there (${problem}): a skill's folder and its name: line must match`, 'fix the SKILL.md header with edit first, or rename the folder to its name')
  const name = entryName(entry, manifest!.bytes)
  const gainedIds = followers(ctx, after, level, entry)
  const skills: SkillTouched[] = [{ name, entry, kind: 'skill', effect: 'new', followers: gainedIds, readable: true }]
  const editorIds = editors(ctx, after, to)
  const before = editors(ctx, rules, from)
  const editorsGainedIds = editorIds.filter((x) => !before.includes(x))
  const checked = nameCheck(ctx, user, after, level!, name, gainedIds, entry)
  const sb = readers(ctx, rules, from, user.id), sa = readers(ctx, after, to, user.id)
  const seeAdded = sa.filter((x) => !sb.includes(x)), seeLost = a.action === 'copy' ? [] : sb.filter((x) => !sa.includes(x))
  return finish({ kind: 'in', action: a.action, holder: false, from, to, isDir, files, texts, skills, level, lostIds: [], gainedIds, editorIds, editorsGainedIds, seeAdded, seeLost, narrowed, ...checked, rename: null })
}

/** The token over everything the card shows and the action does. */
function finish(p: Omit<FolderPlan, 'token'>): FolderPlan {
  const token = crypto.createHash('sha256').update(JSON.stringify({
    kind: p.kind, action: p.action, holder: p.holder, from: p.from, to: p.to, isDir: p.isDir, files: p.files.map((f) => [f.path, f.sha]), texts: p.texts.map((t) => [t.path, sha256(Buffer.from(t.text, 'utf8'))]),
    skills: p.skills.map((s) => [s.entry, s.effect, s.followers]), level: p.level ? [p.level.level, p.level.root] : null, lost: p.lostIds, gained: p.gainedIds, editors: p.editorIds, editorsGained: p.editorsGainedIds,
    seeAdded: p.seeAdded, seeLost: p.seeLost, narrowed: p.narrowed, shadow: p.shadow, hiddenFor: p.hiddenFor, replaces: p.replaces, rename: p.rename ? [p.rename.name, p.rename.oldSha] : null,
  })).digest('hex')
  return { ...p, token }
}

/**
 * Do it, as planned and shown (`plan`, its token): the file service takes a grant for exactly this operation and plans
 * it again right before the rename or the copy; anything that differs from the card refuses it (Denied). "I" places
 * the card's bytes as new files, and R its files with SKILL.md's new name line (the old text kept as a version), in the
 * same step as the move.
 * Audited as `skills.files`; each skill change also as `skills.change` (file events, skills/changes.ts).
 */
export async function runFolderAction(ctx: AppContext, userId: string, a: FolderActionInput, plan: FolderPlan, o: { turnId: string; tool: string }): Promise<{ path: string }> {
  const svc = componentC(ctx).files
  const recheck = () => {
    const now = planFolderAction(ctx, ctx.files.principal(userId), a)
    if ('refused' in now) throw new Denied(`what the card showed changed: ${now.refused.why}`)
    if (now.token !== plan.token) throw new Denied('what the card showed changed (the files, who gets them or who may change them)')
  }
  // "I" by a move, and R: what the card showed, placed as new files in the same step as the move (R: SKILL.md with its
  // new name line, the old text kept as a version), so it never lands half done
  const segsIn = (f: FileHash) => (plan.isDir ? f.path.slice(plan.from.length + 1).split('/') : [])
  const placed = (f: FileHash) => ({ segs: segsIn(f), bytes: plan.rename && f.path === `${plan.from}/SKILL.md` ? Buffer.from(plan.rename.text, 'utf8') : f.bytes, exec: f.exec })
  const fresh = (plan.kind === 'in' && plan.action === 'move') || plan.kind === 'rename_skill' ? plan.files.map(placed) : undefined
  const action: SkillActionGrant['action'] = plan.kind === 'in' && plan.action === 'copy' ? 'place' : plan.action === 'copy' ? 'copy' : 'move'
  const ids: string[] = []
  const grant = (g: Omit<SkillActionGrant, 'userId' | 'turnId'>) => { const id = allowSkillAction(ctx.files, { userId, turnId: o.turnId, ...g }); ids.push(id); return id }
  if (plan.rename && fresh && !fresh.some((f) => f.segs.join('/') === 'SKILL.md')) throw new Denied('what the card showed changed (no SKILL.md)')
  try {
    let done = plan.to
    const id = grant({ action, from: plan.from, to: plan.to, recheck, ...(fresh ? { fresh } : {}) })
    if (action === 'place') {
      done = svc.placeSkillTree(userId, plan.from, plan.to, plan.files.map(placed), { folder: plan.isDir, turnId: o.turnId, tool: o.tool, skillGrant: id }).path
    } else if (action === 'copy') {
      const r = await svc.copy(userId, plan.from, plan.to, { onExists: 'fail', turnId: o.turnId, tool: o.tool, skillGrant: id })
      if ('path' in r) done = r.path
    } else {
      // a project's first skill: its skills folder is made first (it has no rules of its own), and taken away again
      // when the move does not happen
      const made = plan.kind === 'in' && parentOf(plan.to) === rootFolder(plan.to) ? svc.ensureSkillsFolder(userId, parentOf(plan.to)) : false
      try { done = svc.move(userId, plan.from, plan.to, 'fail', { confirm: true, turnId: o.turnId, tool: o.tool, skillGrant: id }).entry.path }
      catch (e) { if (made) svc.dropEmptySkillsFolder(parentOf(plan.to)); throw e }
    }
    audit(ctx.db, {
      actor: userId, action: 'skills.files', target: done,
      detail: { kind: plan.kind, action: plan.action, from: plan.from, to: done, files: plan.files.length, skills: plan.skills.map((s) => ({ entry: s.entry, effect: s.effect, people: s.followers.length })), lost: plan.lostIds.length, gained: plan.gainedIds.length, editorsGained: plan.editorsGainedIds.length, byAi: true, turnId: o.turnId },
    })
    return { path: done }
  } finally { for (const id of ids) dropSkillAction(ctx.files, id) }
}
