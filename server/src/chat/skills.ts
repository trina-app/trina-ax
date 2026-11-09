// Skills: legacy Markdown files and Agent Skills folders with a SKILL.md entry point. Three kinds of root hold them:
// skills/ (team skills; the folder rules of skills/ and its subfolders decide who can read each one),
// groups/<folder>/skills/ (group skills: one root for each group the person belongs to, its folder name as the groups
// row has it; docs/DECISIONS.md "Group skills") and users/<id>/skills/ (personal skills of that person; nobody else can
// read them, owner and admins included). Every listing is for one principal: the person who runs the turn or calls the
// API (docs/DECISIONS.md "Skills: folder permissions and personal skills"). Folder rules still govern every read/write.
// Resources are read on demand through the ordinary file tools; discovering a manifest never executes scripts or grants
// tools named in its metadata. One name, three skills: personal > group > team (scanSkills).
// A fourth, lowest level: projects/<name>/skills/<skill>/SKILL.md of a live team project on exactly projects/<name>
// (docs/DECISIONS.md "Project skills"), only in that project's chats (the listing takes the chat's project) and only
// SKILL.md folders. A project skill only adds new names: one whose name, or a wider skill's file or folder name, is taken
// is hidden.
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { isMap, isScalar, parseDocument } from 'yaml'
import { parseSkillInputs, readSkillTitle, SKILL_EXAMPLE_MAX, type SkillInput } from '@mycel/shared/api'
import type { FileService } from '../files/service'
import { readRegular } from '../files/store'
import { atLeast, type Principal, type RuleSet } from '../policy/access'
import { authorize } from '../policy/authorize'
import { PROJECTS_DIR, projectLevelPossible, projectSkillsDir } from '../skills/guard'

/** `inputs`: the short form the skill runs from (metadata `inputs`, shared/src/api/skill-inputs.ts), only when valid.
 * `title`: the name people read (metadata `title`, "광고 문구"), only when valid; "/<name>" still runs the skill.
 * `recurring`: metadata `recurring` as written, only when the key is there ("weekly": the work comes back every week,
 * docs/DECISIONS.md "S"; isRecurring). Server side only: listings (skillInfo) leave it out. */
export interface SkillInfo { path: string; name: string; description: string; inputs?: SkillInput[]; title?: string; recurring?: string; example?: string; group?: SkillGroup; project?: SkillProject }
/** The group a group skill belongs to, by its current name (a rename shows at once; the folder keeps its name). */
export interface SkillGroup { id: string; name: string }
/** The project a project skill belongs to, by its current name. */
export interface SkillProject { id: string; name: string }
/** A project's skills folder: projects/<name>/skills of a live team project (skills/guard.ts projectLevelPossible). */
export interface ProjectSkillRoot extends SkillProject { root: string }
/** The chat's project as the turn has it (chat/runtime.ts projectForChat): only while the person sees it. */
export interface ChatProject { id: string; name: string; folderPath: string }
/** What a listing is for: `project`, the chat's project (its skills join, lowest of the four levels); `usable`, a shared
 * chat's paths everyone who sees it may use (the others drop out before a name's winner is picked). */
export interface SkillScope { project?: ChatProject | null; usable?: ((rel: string) => boolean) | null }

/** metadata `example` (docs/DECISIONS.md "W5": a request a skill's form starts with): one line of at most
 * SKILL_EXAMPLE_MAX characters without control or text-direction characters, else none. */
export function readSkillExample(raw: string | undefined): string | null {
  const v = raw?.trim()
  return v && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(v) && [...v].length <= SKILL_EXAMPLE_MAX ? v : null
}
export interface Skill extends SkillInfo { body: string }

const SKILLS_DIR = 'skills'
const USERS_DIR = 'users'
const GROUPS_DIR = 'groups'
const PROJECTS = PROJECTS_DIR
const MAX_DEPTH = 3
/** entries read per skill root (team skills/, each group's groups/<folder>/skills/, a person's own users/<id>/skills/),
 * team rule files included. Over it the rest is not read: skill managers see a "too_many" issue (skillIssues), never a
 * silent cut */
export const MAX_FILES = 1000
export const SKILL_BODY_MAX = 16_000
export const SKILL_FILE_MAX_BYTES = 128 * 1024
const HEADER_MAX = 8 * 1024
export const SKILL_NAME_MAX = 64
const LEGACY_NAME_MAX = 60
const LEGACY_DESCRIPTION_MAX = 300
const DESCRIPTION_MAX = 1024

export const isSkillManifest = (rel: string) => path.posix.basename(rel) === 'SKILL.md'
/** The personal skills folder of one person. */
export const personalSkillsDir = (userId: string) => `${USERS_DIR}/${userId}/${SKILLS_DIR}`

/** A group's skills folder: groups/<folder>/skills (`groupFolder`: the group's folder, admin/groups.ts groupFolder). */
export const groupSkillsDir = (groupFolder: string) => `${groupFolder}/${SKILLS_DIR}`

/** The number of path segments of the skill root that holds `parts`: 1 for skills/..., 3 for users/<id>/skills/...,
 * groups/<folder>/skills/... and projects/<name>/skills/..., null for a path outside the roots. The first segment
 * decides the kind, so depth 3 of a group never reads as a person's folder. The root itself is not inside it. */
function skillRootLength(parts: readonly string[]): number | null {
  if (parts[0] === SKILLS_DIR) return 1
  if ((parts[0] === USERS_DIR || parts[0] === GROUPS_DIR || parts[0] === PROJECTS) && parts.length >= 3 && parts[1] && parts[2] === SKILLS_DIR) return 3
  return null
}
/** The root length of `parts` and whether that root is a project's (only SKILL.md folders load there). */
function rootOf(parts: readonly string[]): { len: number; project: boolean } | null {
  const len = skillRootLength(parts)
  return len === null ? null : { len, project: parts[0] === PROJECTS }
}
/** A path under users/<id>/skills/ (a personal skill entry). */
export const isPersonalSkill = (rel: string) => { const p = rel.split('/'); return p[0] === USERS_DIR && skillRootLength(p) === 3 }
/** A path under groups/<folder>/skills/ (a group skill entry, or that folder itself). */
export const isGroupSkill = (rel: string) => { const p = rel.split('/'); return p[0] === GROUPS_DIR && skillRootLength(p) === 3 }
/** A path under projects/<name>/skills/ (a project skill entry, or that folder itself). */
export const isProjectSkill = (rel: string) => { const p = rel.split('/'); return p[0] === PROJECTS && skillRootLength(p) === 3 }

/** The skills of one group the person belongs to: `root` is groups/<folder>/skills. */
export interface GroupSkillRoot extends SkillGroup { root: string }
const orderKey = (s: string) => s.normalize('NFC').toLowerCase()
/** Groups by name (letter case ignored, compared by Unicode code points), then id: the order of the Team skills
 * sections and the tie-break of "/name" between two groups' skills (docs/DECISIONS.md "Group skills"). */
export function groupOrder(a: SkillGroup, b: SkillGroup): number {
  const x = orderKey(a.name), y = orderKey(b.name)
  return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
/** The skill roots of the groups `user` belongs to (Principal.groups, read with the person), in groupOrder. Only a
 * group whose folder is groups/<one name> has one (a folder moved elsewhere has none, a group without a folder none).
 * The folder rules still decide every read: a member without access to their group's folder sees nothing there. */
export function groupSkillRoots(db: Database, user: Pick<Principal, 'groups'>): GroupSkillRoot[] {
  if (!user.groups?.length) return []
  let rows: { id: string; name: string; path: string }[]
  try {
    rows = db.query(`SELECT g.id, g.name, f.path FROM groups g JOIN folders f ON f.id = g.folder_id WHERE g.id IN (${user.groups.map(() => '?').join(',')})`).all(...user.groups) as typeof rows
  } catch { return [] }
  const out: GroupSkillRoot[] = []
  for (const r of rows.sort(groupOrder)) {
    const segs = r.path.normalize('NFC').split('/')
    if (segs.length !== 2 || segs[0] !== GROUPS_DIR || !segs[1]) continue
    const root = groupSkillsDir(segs.join('/'))
    if (!out.some((g) => g.root === root)) out.push({ id: r.id, name: r.name, root })
  }
  return out
}
/** The group whose folder is `folder` (groups/<name>, as the folders row has it; letter case and Unicode form ignored
 * only when no row has it exactly), or null: a folder left behind by a deleted group, or no group's folder at all. */
export function groupOfFolder(db: Database, folder: string): SkillGroup | null {
  try {
    const rows = db.query("SELECT g.id, g.name, f.path FROM groups g JOIN folders f ON f.id = g.folder_id WHERE f.path LIKE 'groups/%'").all() as { id: string; name: string; path: string }[]
    const want = folder.normalize('NFC')
    const hit = rows.find((r) => r.path.normalize('NFC') === want) ?? rows.find((r) => orderKey(r.path) === orderKey(want))
    return hit ? { id: hit.id, name: hit.name } : null
  } catch { return null }
}
/**
 * Who of `people` may not use this team path as the AI is shown it (a skill list, a skill it loads, the team's rules):
 * whoever cannot read it, and for a group's skill (isGroupSkill: groups/<folder>/skills/…) whoever is not in that group
 * (docs/DECISIONS.md "Group skills": the owner and admins read every group folder, but its skills are its members').
 * An account that cannot be loaded (null) may use nothing. The ids, in `people`'s order (a null counts as '').
 */
export function mayNotUse(db: Database, rules: RuleSet, people: readonly (Principal | null)[], rel: string): string[] {
  const segs = rel.split('/').filter(Boolean)
  const group = isGroupSkill(segs.join('/')) ? groupOfFolder(db, segs.slice(0, 2).join('/')) : undefined
  return people.filter((p) => !p || !atLeast(rules.access(p, segs), 'read') || (group !== undefined && (!group || !p.groups.includes(group.id)))).map((p) => p?.id ?? '')
}

/** May every one of `people` use this team path (mayNotUse is empty)? Kept per path for the caller's life: a room's
 * members (rooms/ai.ts) and the people who see a shared project chat (chat/turn.ts) both go by it. */
export function everyoneMayUse(db: Database, rules: RuleSet, people: readonly (Principal | null)[]): (rel: string) => boolean {
  const seen = new Map<string, boolean>()
  return (rel) => {
    let ok = seen.get(rel)
    if (ok === undefined) { ok = mayNotUse(db, rules, people, rel).length === 0; seen.set(rel, ok) }
    return ok
  }
}

/** The group root that holds `segs` (a path as authorize resolved it) among `roots`, or null. */
const groupRootOf = (roots: readonly GroupSkillRoot[], segs: readonly string[]) =>
  segs[0] === GROUPS_DIR && segs[2] === SKILLS_DIR && segs[1] ? roots.find((g) => g.root === `${GROUPS_DIR}/${segs[1]!.normalize('NFC')}/${SKILLS_DIR}`) ?? null : null

/** personal 0 > group 1 > team 2 > project 3: which of the skills of one name a person gets (docs/DECISIONS.md "Group
 * skills", "Project skills"). */
export const skillTier = (s: Pick<SkillInfo, 'path' | 'group' | 'project'>): 0 | 1 | 2 | 3 => (isPersonalSkill(s.path) ? 0 : s.project ? 3 : s.group || isGroupSkill(s.path) ? 1 : 2)
/** The file or folder name "/<alias>" also runs a skill by (invokedSkill). */
export const skillAlias = (p: string) => (isSkillManifest(p) ? path.posix.basename(path.posix.dirname(p)) : path.posix.basename(p, '.md'))

/** The metadata a listing shows (no body). `personal` is set only for a personal skill, `group` only for a group
 * skill, `inputs` only for a skill with a valid form, `title` only for a skill with one. */
export const skillInfo = ({ path: p, name, description, inputs, title, example, group, project }: SkillInfo): SkillInfo & { personal?: true } =>
  ({ path: p, name, description, ...(isPersonalSkill(p) ? { personal: true as const } : {}), ...(group ? { group: { id: group.id, name: group.name } } : {}), ...(project ? { project: { id: project.id, name: project.name } } : {}), ...(inputs ? { inputs } : {}), ...(title ? { title } : {}), ...(example ? { example } : {}) })
const hasFrontmatter = (text: string) => /^\uFEFF?---[ \t]*(?:\r?\n|$)/.test(text)

/** Decode the standard metadata without constructing JS objects or expanding aliases. Only the root and the
 * optional metadata string map may be collections. The bounded header also limits parser work before validation.
 * `metadata` holds the metadata map's values (the form of a skill is its `inputs`). A form written as YAML instead of
 * one text (a list, or a JSON list without `|`: JSON is YAML) is never read, and never breaks the header: the skill
 * loads without its form (`inputsNotText`). */
function standardFields(header: string): { fields: Map<string, string>; metadata: Map<string, string>; inputsNotText: boolean } | null {
  try {
    const doc = parseDocument(header, { strict: true, uniqueKeys: true, schema: 'core', version: '1.2', prettyErrors: false, logLevel: 'silent' })
    if (doc.errors.length || doc.warnings.length || !isMap(doc.contents) || doc.contents.anchor || doc.contents.tag) return null
    const fields = new Map<string, string>(), metadata = new Map<string, string>()
    let inputsNotText = false
    const scalar = (v: unknown): v is import('yaml').Scalar<string> => isScalar(v) && typeof v.value === 'string' && !v.anchor && !v.tag
    for (const item of doc.contents.items) {
      if (!scalar(item.key)) return null
      const key = item.key.value
      if (key === 'metadata') {
        if (!isMap(item.value) || item.value.anchor || item.value.tag) return null
        for (const pair of item.value.items) {
          if (!scalar(pair.key)) return null
          if (pair.key.value === 'inputs' && !scalar(pair.value)) { inputsNotText = true; continue }
          // a title that is not text (left empty, a number, a list) is no title: the skill loads and shows its name
          if (pair.key.value === 'title' && !scalar(pair.value)) continue
          // and an example that is not text is no example
          if (pair.key.value === 'example' && !scalar(pair.value)) continue
          if (!scalar(pair.value)) return null
          metadata.set(pair.key.value, pair.value.value)
        }
      } else {
        if (!scalar(item.value)) return null
        fields.set(key, item.value.value)
      }
    }
    return { fields, metadata, inputsNotText }
  } catch { return null }
}

const HEADER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/
const INPUTS_NOT_TEXT = 'inputs must be one JSON text: write "inputs: |" and the JSON list on the lines below it, indented'

/** The header with its form (the `inputs` key directly under `metadata:` and the lines under it) left empty, or null
 * when it has none: a SKILL.md whose form makes the header larger than HEADER_MAX still loads, without the form. An
 * `inputs:` line anywhere else (inside a description block, deeper in another metadata value) is not the form. */
function withoutInputs(header: string): string | null {
  const lines = header.split(/\r?\n/)
  const indentOf = (l: string) => /^[ \t]*/.exec(l)![0]
  const meta = lines.findIndex((l) => /^metadata[ \t]*:[ \t]*(?:#.*)?$/.test(l))
  if (meta < 0) return null
  let child: string | null = null
  for (let at = meta + 1; at < lines.length; at++) {
    const line = lines[at]!
    if (!line.trim()) continue
    const indent = indentOf(line)
    if (!indent) return null // the metadata map ended
    child ??= indent // its keys are as indented as its first one
    if (indent !== child || !/^[ \t]+inputs[ \t]*:/.test(line)) continue
    let end = at + 1
    while (end < lines.length && (!lines[end]!.trim() || indentOf(lines[end]!).length > indent.length)) end++
    return [...lines.slice(0, at), `${indent}inputs: ""`, ...lines.slice(end)].join('\n')
  }
  return null
}

/** Why an entry with a header is not a skill. Codes only: the screens translate them (R2-SKILL-03). */
export type SkillProblem = 'too_large' | 'header' | 'location' | 'name' | 'name_folder' | 'description' | 'compatibility'
/** `inputs` / `badInputs`: a SKILL.md's form (metadata `inputs`), when it declares one: the list when valid, else why
 * not (the skill still loads, without a form: skillIssues reports `inputs`). */
export type SkillCheck = { ok: true; name: string; description: string; body: string; inputs?: SkillInput[]; badInputs?: string; title?: string; recurring?: string; example?: string } | { ok: false; problem: SkillProblem }

/** The skill's work comes back every week (metadata `recurring: weekly`). */
export const isRecurring = (s: Pick<SkillInfo, 'recurring'>): boolean => s.recurring?.trim().toLowerCase() === 'weekly'

/** A header line that the legacy reader takes as a field. legacyHeaderOk uses the same regex for its duplicate check. */
const LEGACY_KEY = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/

/** Legacy header lines are `key: value` (any key text, a space after the colon is optional) and a key comes once.
 * Values have no YAML quoting rules: a value that opens a quote or a bracket and does not close it is plain text
 * (older files have values such as `[긴급 처리용`). Only a line without a colon or a duplicate key breaks the header.
 * Valid YAML (for example a block scalar) is also accepted. */
function legacyHeaderOk(header: string): boolean {
  // The reader ignores the case of keys, so `name` and `NAME` are a duplicate even where YAML accepts them. This check
  // runs over all lines with the reader's own key regex, so a line that is not `key: value` does not stop it.
  const readerKeys = new Set<string>()
  for (const line of header.split(/\r?\n/)) {
    const kv = LEGACY_KEY.exec(line)
    if (!kv) continue
    const key = kv[1]!.toLowerCase()
    if (readerKeys.has(key)) return false
    readerKeys.add(key)
  }
  const lines = header.split(/\r?\n/).filter((l) => l.trim() && !/^\s*#/.test(l))
  const keys = new Set<string>()
  let duplicate = false
  const lineForm = lines.every((line) => {
    const kv = /^([^\s:#"'][^:]*?)\s*:(.*)$/.exec(line)
    if (!kv) return false
    const key = kv[1]!.toLowerCase()
    if (keys.has(key)) return !(duplicate = true)
    keys.add(key)
    return true
  })
  if (lineForm) return true
  if (duplicate) return false
  try {
    const doc = parseDocument(header, { strict: true, uniqueKeys: true, prettyErrors: false, logLevel: 'silent' })
    return !doc.errors.length && isMap(doc.contents)
  } catch { return false }
}

/** A legacy value. A value in matching double quotes is decoded as a YAML / JSON double-quoted string when it is
 * one (skillFileText writes values in this form), and a value in matching single quotes uses the YAML rule `''` = `'`.
 * Other values are kept as typed. */
function legacyValue(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      const s: unknown = JSON.parse(v)
      if (typeof s === 'string') return s
    } catch { /* not a JSON string: keep the old rule */ }
    return v.slice(1, -1)
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'")
  return v
}

/** Legacy files keep their Korean/display-name format. A SKILL.md needs its actual path: the standard name must
 * match its parent folder. Invalid frontmatter is never a fallback team rule, and a broken legacy header is not a
 * skill (R2-SKILL-04). Optional metadata grants nothing. */
export function checkSkill(text: string, rel?: string): SkillCheck {
  const no = (problem: SkillProblem): SkillCheck => ({ ok: false, problem })
  if (Buffer.byteLength(text, 'utf8') > SKILL_FILE_MAX_BYTES) return no('too_large')
  const t = text.replace(/^\uFEFF/, '')
  let m = HEADER_RE.exec(t.slice(0, HEADER_MAX + 16))
  let headerText = m?.[1]
  let oversized = 0
  if (!m || Buffer.byteLength(m[1]!, 'utf8') > HEADER_MAX) {
    // a SKILL.md whose form makes the header too large (Korean takes 3 bytes a letter): the skill without its form,
    // and an `inputs` issue that says why, rather than a broken header and no skill at all
    const big = rel !== undefined && isSkillManifest(rel) ? HEADER_RE.exec(t) : null
    const rest = big ? withoutInputs(big[1]!) : null
    if (!big || rest === null || Buffer.byteLength(rest, 'utf8') > HEADER_MAX) return no('header')
    m = big
    headerText = rest
    oversized = Buffer.byteLength(big[1]!, 'utf8')
  }
  if (rel !== undefined && isSkillManifest(rel)) {
    const parts = rel.split('/')
    const root = skillRootLength(parts)
    if (root === null || parts.length < root + 2 || parts.length > root + MAX_DEPTH) return no('location')
    const header = standardFields(headerText!)
    if (!header) return no('header')
    const { fields } = header
    const name = fields.get('name'), description = fields.get('description')
    if (!name || name.length > SKILL_NAME_MAX || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return no('name')
    if (name !== parts.at(-2)) return no('name_folder')
    if (!description?.trim() || [...description].length > DESCRIPTION_MAX) return no('description')
    const compatibility = fields.get('compatibility')
    if (compatibility !== undefined && (!compatibility.trim() || [...compatibility].length > 500)) return no('compatibility')
    // the name people read: one line, at most SKILL_TITLE_MAX characters; any other value is left out (the name shows)
    const title = readSkillTitle(header.metadata.get('title'))
    const recurring = header.metadata.get('recurring')
    const example = readSkillExample(header.metadata.get('example'))
    const ok = { ok: true as const, name, description: description.trim(), body: t.slice(m[0].length), ...(title ? { title } : {}), ...(recurring !== undefined ? { recurring: recurring.trim() } : {}), ...(example ? { example } : {}) }
    if (oversized) return { ...ok, badInputs: `with this form the header is ${oversized} bytes, over the ${HEADER_MAX / 1024} KB limit (a Korean letter takes 3 bytes): shorten the labels and placeholders` }
    if (header.inputsNotText) return { ...ok, badInputs: INPUTS_NOT_TEXT }
    const raw = header.metadata.get('inputs')
    if (raw === undefined) return ok
    const form = parseSkillInputs(raw)
    return form.ok ? { ...ok, inputs: form.inputs } : { ...ok, badInputs: form.reason }
  }
  if (!legacyHeaderOk(m[1]!)) return no('header')
  const fields: Record<string, string> = Object.create(null)
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = LEGACY_KEY.exec(line)
    if (kv) fields[kv[1]!.toLowerCase()] = legacyValue(kv[2]!.trim())
  }
  const name = (fields.name ?? '').replace(/\s+/g, ' ').trim()
  if (!name || name.length > LEGACY_NAME_MAX || name.includes('/')) return no('name')
  return { ok: true, name, description: (fields.description ?? '').slice(0, LEGACY_DESCRIPTION_MAX), body: t.slice(m[0].length) }
}

export function parseSkill(text: string, rel?: string): { name: string; description: string; body: string; inputs?: SkillInput[]; title?: string; recurring?: string; example?: string } | null {
  const r = checkSkill(text, rel)
  return r.ok ? { name: r.name, description: r.description, body: r.body, ...(r.inputs ? { inputs: r.inputs } : {}), ...(r.title ? { title: r.title } : {}), ...(r.recurring !== undefined ? { recurring: r.recurring } : {}), ...(r.example ? { example: r.example } : {}) } : null
}

/** Why the form of a skill that loads does not parse (metadata `inputs`), or null: no form, or a valid one. */
export function skillInputsProblem(text: string, rel: string): string | null {
  const r = checkSkill(text, rel)
  return r.ok && r.badInputs ? r.badInputs : null
}

/** The problem of an entry that looks like a skill: a SKILL.md, or another file with a header. null: it loads, or it
 * is a team rule. */
function loadProblem(text: string, rel: string): SkillProblem | null {
  // a project's skills are SKILL.md folders only: a single .md with a header there is in the wrong place
  if (rootOf(rel.split('/'))?.project && !isSkillManifest(rel)) return hasFrontmatter(text) ? 'location' : null
  const check = checkSkill(text, rel)
  return !check.ok && (isSkillManifest(rel) || hasFrontmatter(text)) ? check.problem : null
}

/** Even an invalid or unreadable manifest reserves its folder: resource files must not become separate skills.
 * This checks names only, never reads a manifest that the caller cannot access. */
function isSkillResource(root: string, rel: string): boolean {
  const parts = rel.split('/')
  // a SKILL.md directly in a skill root does not make a package: start one folder below the root
  for (let n = (skillRootLength(parts) ?? 1) + 1; n < parts.length; n++) {
    if (n === parts.length - 1 && isSkillManifest(rel)) continue
    try { fs.lstatSync(path.join(root, ...parts.slice(0, n), 'SKILL.md')); return true } catch (e: any) {
      if (e.code !== 'ENOENT') return true
    }
  }
  return false
}

/** Shared by discovery, usage, edit previews and change history, so resources and invalid entries agree. */
export function skillFileKind(root: string, rel: string, text: string): 'skill' | 'rule' | 'other' {
  if (!rel.endsWith('.md') || isSkillResource(root, rel)) return 'other'
  // a project's skills are SKILL.md folders only (a README there is just a file)
  if (rootOf(rel.split('/'))?.project) return isSkillManifest(rel) && parseSkill(text, rel) ? 'skill' : 'other'
  if (parseSkill(text, rel)) return 'skill'
  // team rules are skills/*.md only (prompt.ts teamRules): a file without a header in a group's skills is just a file
  return isSkillManifest(rel) || hasFrontmatter(text) || isGroupSkill(rel) ? 'other' : 'rule'
}

/** Why `text` does not load at `rel` (R2-SKILL-03), for a save: the confirmation card and the AI's write result. null
 * for a file that loads, a team rule, a resource file and every path outside the skill roots: a project folder can
 * hold a SKILL.md for another tool, so a check there gives false alarms. */
export function skillFileProblem(root: string, rel: string, text: string): SkillProblem | null {
  if (!rel.endsWith('.md') || skillRootLength(rel.split('/')) === null || isSkillResource(root, rel)) return null
  return loadProblem(text, rel)
}

/** One line for the AI after it saved a skill file that does not load, so it can tell the person and fix the file.
 * Empty when the file is not a problem. Tool results are in English; the screens use the codes. */
export function skillWriteNote(root: string, rel: string, data: Buffer): string {
  const problem = skillFileProblem(root, rel, data.toString('utf8'))
  if (!problem) {
    const form = isSkillManifest(rel) && skillRootLength(rel.split('/')) !== null && !isSkillResource(root, rel) ? skillInputsProblem(data.toString('utf8'), rel) : null
    return form ? `\nWarning: the skill loads, but its form (metadata inputs) does not: ${form}. It runs without its form until the value is a JSON list of inputs. Tell the user, and fix it if they want the form.` : ''
  }
  const how: Record<SkillProblem, string> = {
    too_large: `the file is larger than ${SKILL_FILE_MAX_BYTES / 1024} KB`,
    header: 'the header between the --- lines is broken',
    location: rootOf(rel.split('/'))?.project && !isSkillManifest(rel)
      ? 'a project\'s skills are folders with a SKILL.md (skills/<name>/SKILL.md in the project folder), not single .md files'
      : `SKILL.md must be in its own folder inside the skill folder, at most ${MAX_DEPTH} levels down`,
    name: isSkillManifest(rel)
      ? `the name must have only lowercase a to z, 0 to 9 and hyphens, at most ${SKILL_NAME_MAX} characters, and be the same as the folder name; if the folder name has other characters, change the folder name too`
      : `the name must be present, at most ${LEGACY_NAME_MAX} characters, with no /`,
    name_folder: 'the name must be the same as the folder name',
    description: `the description must be present, at most ${DESCRIPTION_MAX} characters`,
    compatibility: 'the compatibility value must not be empty, at most 500 characters',
  }
  return `\nWarning: this skill file does not load, so nobody can use it as a skill: ${how[problem]}. Tell the user, and fix the file if they want this skill.`
}

/** Read exactly one authorized entry using the same link/size checks as the file tools. A personal entry is a skill
 * only for its owner, a group entry only for the members of that group (the folder rules let the owner and admins read
 * every group folder; this check does not depend on them). */
export function readSkill(files: FileService, user: Principal, inputPath: string, o: Pick<SkillScope, 'project'> = {}): Skill | null {
  return readSkillIn(files, user, inputPath, null, projectRootsFor(o.project))
}

/** The skills folder of the chat's project, when it may have one: a team project on exactly projects/<name>
 * (skills/guard.ts projectLevelPossible). The caller decided that the person sees the project and that its folder is
 * not in the trash (chat/runtime.ts projectForChat). */
export function projectRootsFor(project: ChatProject | null | undefined): ProjectSkillRoot[] {
  return project && projectLevelPossible(project.folderPath) ? [{ id: project.id, name: project.name, root: projectSkillsDir(project.folderPath) }] : []
}

/** A live team project that may have skills: its folder (exactly projects/<name>) not in the trash. */
export interface LiveProjectRoot extends ProjectSkillRoot { folder: string; createdBy: string | null }
/** Every live team project that may have skills, oldest first; [] when the projects cannot be read. */
export function liveProjectRoots(db: Database): LiveProjectRoot[] {
  let rows: { id: string; name: string; folder_path: string; created_by: string | null }[]
  try { rows = db.query('SELECT id, name, folder_path, created_by FROM projects WHERE trashed_with IS NULL ORDER BY created_at, id').all() as typeof rows } catch { return [] }
  return rows.filter((r) => projectLevelPossible(r.folder_path)).map((r) => ({ id: r.id, name: r.name, folder: r.folder_path, root: projectSkillsDir(r.folder_path), createdBy: r.created_by }))
}
/** The live team project on `folder` (projects/<name>, letter case and Unicode form ignored), the oldest when older
 * rows share it; null when there is none (a folder left behind keeps its guard, never its skills). */
export function projectOfFolder(db: Database, folder: string): LiveProjectRoot | null {
  const k = orderKey(folder)
  return liveProjectRoots(db).find((p) => orderKey(p.folder) === k) ?? null
}
/** The project skills folder among `roots` that holds the resolved path `segs` (projects/<name>/skills/…), or null. */
function projectRootOf(roots: readonly ProjectSkillRoot[], segs: readonly string[]): ProjectSkillRoot | null {
  if (segs[0] !== PROJECTS || skillRootLength(segs) !== 3) return null
  const k = orderKey(segs.slice(0, 3).join('/'))
  return roots.find((r) => orderKey(r.root) === k) ?? null
}

/** readSkill inside one listing walk (walkSkillEntries: its rules and folder listings); never exported, so a memo of
 * folder listings cannot outlive the synchronous walk that made it. `projects`: the project skill roots this listing
 * is for (the chat's project); a project's skills are nobody's anywhere else. */
function readSkillIn(files: FileService, user: Principal, inputPath: string, scan: Scan | null, projects: readonly ProjectSkillRoot[] = scan?.projects ?? []): Skill | null {
  try {
    const r = authorize(files.fx, scan?.rules ?? files.rules(), user, inputPath, 'read', scan ? { dirs: scan.dirs } : {})
    const root = skillRootLength(r.segs)
    if (root === null || (r.segs[0] === USERS_DIR && r.segs[1] !== user.id)) return null
    const group = r.segs[0] === GROUPS_DIR ? groupRootOf(scan?.groups ?? groupSkillRoots(files.db, user), r.segs) : null
    if (r.segs[0] === GROUPS_DIR && !group) return null
    // a project's skills: only in a listing for that project (the chat's), SKILL.md folders only
    const project = r.segs[0] === PROJECTS ? projectRootOf(projects, r.segs) : null
    if (r.segs[0] === PROJECTS && (!project || !isSkillManifest(r.rel))) return null
    if (r.segs.length > root + MAX_DEPTH || !r.rel.endsWith('.md') || isSkillResource(files.fx.root, r.rel)) return null
    const text = readRegular(r.abs, SKILL_FILE_MAX_BYTES).bytes.toString('utf8')
    const skill = parseSkill(text, r.rel)
    return skill ? { path: r.rel, ...skill, body: skill.body.slice(0, SKILL_BODY_MAX), ...(group ? { group: { id: group.id, name: group.name } } : {}), ...(project ? { project: { id: project.id, name: project.name } } : {}) } : null
  } catch { return null }
}

/** Visit the accessible entry candidates under skills/, under the skills of each group the caller belongs to and under
 * the caller's own users/<id>/skills/: legacy .md files and folder SKILL.md files, capped per root (team skills cannot
 * push personal or group skills out, and one group cannot push out another's). Never descend into a skill package.
 * Returns the roots whose walk stopped at the cap (some entries there were not visited). */
function walkSkillEntries(files: FileService, user: Principal, visit: (rel: string, scan: Scan) => void, projects: readonly ProjectSkillRoot[] = []): string[] {
  const capped: string[] = []
  // one synchronous scan: the folder rules and each folder's listing are read once (a folder of 1,000 skills was
  // listed again for every entry it holds)
  const scan: Scan = { rules: files.rules(), dirs: new Map(), groups: groupSkillRoots(files.db, user), projects }
  for (const root of [SKILLS_DIR, ...scan.groups.map((g) => g.root), personalSkillsDir(user.id)]) if (walkSkillRoot(files, user, root, (rel) => visit(rel, scan), scan)) capped.push(root)
  // a project's skills: SKILL.md folders only
  for (const p of projects) if (walkSkillRoot(files, user, p.root, (rel) => visit(rel, scan), scan, true)) capped.push(p.root)
  return capped
}

/** What one synchronous walk reuses (never across an await): the folder rules, the folder listings it read, the
 * caller's group skill roots and the project skill roots of this listing. */
interface Scan { rules: ReturnType<FileService['rules']>; dirs: Map<string, string[]>; groups: GroupSkillRoot[]; projects: readonly ProjectSkillRoot[] }

/** true: the root has more entries than MAX_FILES (the rest were not visited). `manifestsOnly`: a project's skills
 * folder, where single .md files are no skills. */
function walkSkillRoot(files: FileService, user: Principal, rootRel: string, visit: (rel: string) => void, scan: Scan, manifestsOnly = false): boolean {
  let seen = 0
  let capped = false
  const walk = (rel: string, depth: number) => {
    let names: string[]
    try {
      const r = authorize(files.fx, scan.rules, user, rel, 'list', { dirs: scan.dirs })
      if (!r.st?.isDirectory()) return
      const listed = scan.dirs.get(r.abs) ?? fs.readdirSync(r.abs)
      scan.dirs.set(r.abs, listed)
      names = [...listed].sort()
    } catch { return }
    if (depth > 1 && names.includes('SKILL.md')) {
      if (seen < MAX_FILES) { seen++; visit(`${rel}/SKILL.md`) } else capped = true
      return
    }
    for (const n of names) {
      if (capped) break
      if (n.startsWith('.')) continue
      const child = `${rel}/${n}`
      let st: fs.Stats
      try { st = authorize(files.fx, scan.rules, user, child, 'list', { dirs: scan.dirs }).st! } catch { continue }
      if (st.isDirectory()) { if (depth < MAX_DEPTH) walk(child, depth + 1); continue }
      if (!st.isFile() || st.nlink > 1 || !n.endsWith('.md') || manifestsOnly) continue
      if (seen >= MAX_FILES) { capped = true; break }
      seen++
      visit(child)
    }
  }
  walk(rootRel, 1)
  return capped
}

const nameKey = (s: string) => s.normalize('NFC').toLowerCase()

/** Accessible legacy files and folder entry points of `user`, sorted: the team skills the folder rules let them
 * read, and their own personal skills. A personal skill with the same name as a team skill replaces that team skill
 * in this person's list only (other people still get the team skill). */
export function listSkills(files: FileService, user: Principal, scope: SkillScope = {}): Skill[] {
  return scanSkills(files, user, scope).skills
}

/** The team skills `user` can read (skills/ only), whether or not a personal skill of theirs has the same name: for
 * a check of names before a team skill is added (onboarding/skill-packs.ts). */
export function listTeamSkills(files: FileService, user: Principal): Skill[] {
  const out: Skill[] = []
  const scan: Scan = { rules: files.rules(), dirs: new Map(), groups: [], projects: [] }
  walkSkillRoot(files, user, SKILLS_DIR, (rel) => {
    const skill = readSkillIn(files, user, rel, scan)
    if (skill) out.push(skill)
  }, scan)
  return out
}

/** The skills of one group of `user` (its groups/<folder>/skills/ only), whether or not a personal skill of theirs has
 * the same name; [] when they are not a member: for checks against a group's own skills (a share to that group). */
export function listGroupSkills(files: FileService, user: Principal, groupId: string): Skill[] {
  const out: Skill[] = []
  const groups = groupSkillRoots(files.db, user).filter((g) => g.id === groupId)
  if (!groups.length) return out
  const scan: Scan = { rules: files.rules(), dirs: new Map(), groups, projects: [] }
  walkSkillRoot(files, user, groups[0]!.root, (rel) => {
    const skill = readSkillIn(files, user, rel, scan)
    if (skill) out.push(skill)
  }, scan)
  return out
}

/** The same skill name for "/<name>" (invokedSkill compares names this way). */
export const sameSkillName = (a: string, b: string) => nameKey(a) === nameKey(b)

/** listSkills, and the roots whose walk stopped at MAX_FILES (skills/, a group's skills or the caller's
 * users/<id>/skills). One name: a personal skill hides a group's and the team's, a group's hides the team's (each only
 * for this person); skills of one tier with the same name all stay (two groups': both, told apart by their paths). */
export function scanSkills(files: FileService, user: Principal, scope: SkillScope = {}): { skills: Skill[]; capped: string[] } {
  const { skills, capped } = scanSkillsWithShadowed(files, user, scope)
  return { skills, capped }
}

/** A skill another of the same name replaced for this person: `by` is the tier that runs instead (a personal skill, a
 * group's: the first of its tier by path, so one is named when two groups' skills share the name; or the team's, which
 * only a project skill gives way to). */
export type ShadowedBy = { tier: 'personal' } | { tier: 'group'; group: SkillGroup } | { tier: 'team' }
export interface ShadowedSkill { skill: Skill; by: ShadowedBy }
type Replaced = 'team' | 'group' | 'project'
const REPLACED_RANK: Record<Replaced, number> = { team: 0, group: 1, project: 2 }

/** Of `all` (one person's skills, every tier), the ones that run and the ones that lost, each with the skills it lost
 * to. One name: personal > group > team > project, and a project skill also gives way to a wider skill whose file or
 * folder name is its name ("/<alias>" runs that one: docs/DECISIONS.md "Project skills": a project only adds names). */
function pickWinners(all: readonly Skill[], wider: readonly Skill[] = all): { skills: Skill[]; lost: { skill: Skill; to: Skill[] }[] } {
  const best = new Map<string, number>()
  for (const s of all) best.set(nameKey(s.name), Math.min(best.get(nameKey(s.name)) ?? 4, skillTier(s)))
  // what a project skill gives way to: a wider skill whose name or file / folder name is its name, among `wider` (the
  // person's own skills of every tier; in a shared chat also those its audience may not use: a project skill never takes
  // a name the sender has at a higher tier)
  const byName = new Map<string, Skill[]>(), byAlias = new Map<string, Skill[]>()
  const add = (m: Map<string, Skill[]>, k: string, s: Skill) => m.set(k, [...(m.get(k) ?? []), s])
  for (const s of wider) if (skillTier(s) < 3) { add(byName, nameKey(s.name), s); add(byAlias, nameKey(skillAlias(s.path)), s) }
  const byPath = (a: Skill, b: Skill) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)
  const named = (s: Skill) => skillTier(s) !== best.get(nameKey(s.name))
  const givesWay = (s: Skill) => skillTier(s) === 3 && (byName.has(nameKey(s.name)) || byAlias.has(nameKey(s.name)))
  const skills = all.filter((s) => !named(s) && !givesWay(s)).sort(byPath)
  const lost = all.filter((s) => named(s) || givesWay(s)).sort(byPath).map((s) => {
    const to = named(s) ? skills.filter((w) => sameSkillName(w.name, s.name)) : []
    return { skill: s, to: to.length ? to : [...(byName.get(nameKey(s.name)) ?? []), ...(byAlias.get(nameKey(s.name)) ?? [])].sort((a, b) => skillTier(a) - skillTier(b) || byPath(a, b)) }
  })
  return { skills, lost }
}

const shadowedBy = (w: Skill): ShadowedBy | null => {
  const t = skillTier(w)
  // a group-tier winner always has its group (skillTier: personal, else group when `group` is set, else team)
  return t === 0 ? { tier: 'personal' } : t === 1 ? (w.group ? { tier: 'group', group: w.group } : null) : t === 2 ? { tier: 'team' } : null
}

/** scanSkills plus what it dropped: `shadowed` (the skills a better tier replaced, for the Team skills page, which
 * shows them with a note: docs/DECISIONS.md "Group skills") and `replaces` (path of each running skill -> the lowest
 * tier it replaced, 'team' before 'group': the "/" menu's hint). Which skill runs is `skills`, as before. */
export function scanSkillsWithShadowed(files: FileService, user: Principal, scope: SkillScope = {}): { skills: Skill[]; capped: string[]; shadowed: ShadowedSkill[]; replaces: Map<string, Replaced> } {
  const out: Skill[] = []
  const capped = walkSkillEntries(files, user, (rel, scan) => {
    const skill = readSkillIn(files, user, rel, scan)
    if (skill) out.push(skill)
  }, projectRootsFor(scope.project))
  // a shared chat: skills some of the people who see it may not use are out before a name's winner is picked, so a team
  // skill usable by all of them is not hidden by a group's that is not; a project skill still gives way to every skill
  // of the sender's own of its name (docs/DECISIONS.md "Project skills")
  const { skills, lost } = pickWinners(scope.usable ? out.filter((s) => scope.usable!(s.path)) : out, out)
  const shadowed: ShadowedSkill[] = []
  const replaces = new Map<string, Replaced>()
  for (const { skill: s, to } of lost) {
    const by = to[0] ? shadowedBy(to[0]) : null
    if (!by) continue
    shadowed.push({ skill: s, by })
    const t = skillTier(s)
    const what: Replaced = t === 3 ? 'project' : t === 2 ? 'team' : 'group'
    for (const x of to) { const had = replaces.get(x.path); if (!had || REPLACED_RANK[what] < REPLACED_RANK[had]) replaces.set(x.path, what) }
  }
  return { skills, capped, shadowed, replaces }
}

/** Every personal, group and team skill `user` sees (the ones that run and the ones a better tier hides) whose name, or
 * whose file or folder name, is `name`, but `except`: what a project skill of that name would give way to (a project only
 * adds names), widest first. For the save and move cards (docs/DECISIONS.md "Project skills"). */
export function widerSkillsNamed(files: FileService, user: Principal, name: string, except?: string): Skill[] {
  const { skills, shadowed } = scanSkillsWithShadowed(files, user)
  return [...skills, ...shadowed.map((x) => x.skill)].filter((s) => s.path !== except && skillTier(s) < 3 && (sameSkillName(s.name, name) || sameSkillName(skillAlias(s.path), name)))
    .sort((a, b) => skillTier(a) - skillTier(b) || a.path.localeCompare(b.path))
}

/** The Skills page's project sections: the skills of every live team project the person sees (reads its folder), each
 * with its project, and with `shadowedBy` when one of the person's own, group or team skills runs instead (a project
 * only adds names). Paths the person cannot read are never listed. */
export function projectSkillSections(files: FileService, user: Principal): { skill: Skill; by: ShadowedBy | null }[] {
  const rules = files.rules()
  const seen = liveProjectRoots(files.db).filter((f) => atLeast(rules.access(user, f.folder.split('/')), 'read')).map((f) => ({ id: f.id, name: f.name, root: f.root }))
  if (!seen.length) return []
  const mine = scanSkills(files, user).skills
  const out: { skill: Skill; by: ShadowedBy | null }[] = []
  for (const p of seen) {
    const found: Skill[] = []
    const scan: Scan = { rules, dirs: new Map(), groups: [], projects: [p] }
    walkSkillRoot(files, user, p.root, (rel) => { const s = readSkillIn(files, user, rel, scan); if (s) found.push(s) }, scan, true)
    const { lost } = pickWinners([...mine, ...found])
    for (const s of found.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))) {
      const l = lost.find((x) => x.skill.path === s.path)
      out.push({ skill: s, by: l?.to[0] ? shadowedBy(l.to[0]) : null })
    }
  }
  return out
}

/** The skills folder of the chat's project, when the person may write it (the prompt's "save one for this project"). */
export function writableProjectSkillRoot(files: FileService, user: Principal, project: ChatProject | null | undefined): ProjectSkillRoot | null {
  const r = projectRootsFor(project)[0]
  return r && files.rules().access(user, r.root.split('/')) === 'write' ? r : null
}

/** Skill managers (docs/DECISIONS.md "팀 스킬 관리"): write on skills/ or on one of its folders. The topmost such
 * folders, [] for everyone else. Team skills only: a group's are writableGroupSkillRoots. */
export function managedSkillRoots(files: FileService, user: Principal): string[] {
  const rules = files.rules()
  const writable = [SKILLS_DIR, ...(rules.ruleFolders?.() ?? []).filter((f) => f.startsWith(SKILLS_DIR + '/') && f.split('/').length <= 3)]
    .filter((f) => rules.access(user, f.split('/')) === 'write')
  return writable.filter((f) => !writable.some((g) => g !== f && f.startsWith(g + '/')))
}

/** The skills folders of the caller's groups that the caller may write (by default every member: a group writes its
 * own folder), in groupOrder. */
export function writableGroupSkillRoots(files: FileService, user: Principal): GroupSkillRoot[] {
  const rules = files.rules()
  return groupSkillRoots(files.db, user).filter((g) => rules.access(user, g.root.split('/')) === 'write')
}

export interface SkillIssue { path: string; problem: SkillProblem | 'too_many' | 'too_many_rules' | 'inputs' }

/** Entries that look like skills but do not load (R2-SKILL-03): a SKILL.md that fails validation, or a legacy file
 * with a header that fails. Only entries the caller can read are checked, so a path the caller cannot read never
 * shows. A file without a header is a team rule, not an issue. A root with more entries than MAX_FILES is one issue
 * (`too_many`) for the people who manage it: skill managers for skills/, the owner for their personal skills. More
 * team rule files than the AI follows (`too_many_rules`, prompt.ts teamRules) is one for skill managers. A skill that
 * loads but whose form does not parse (metadata `inputs`) is `inputs`: it runs without its form. */
export function skillIssues(files: FileService, user: Principal, o: { rules?: { total: number; followed: number } } = {}): SkillIssue[] {
  const out: SkillIssue[] = []
  // a project's skills folder: for the people who may write it (as a group's)
  let projects: ProjectSkillRoot[] = []
  try { const rules = files.rules(); projects = liveProjectRoots(files.db).filter((f) => rules.access(user, f.root.split('/')) === 'write').map((f) => ({ id: f.id, name: f.name, root: f.root })) } catch { projects = [] }
  const capped = walkSkillEntries(files, user, (rel, scan) => {
    try {
      const r = authorize(files.fx, scan.rules, user, rel, 'read', { dirs: scan.dirs })
      if (isSkillResource(files.fx.root, r.rel)) return
      if (!r.st?.isFile()) return
      if (r.st.size > SKILL_FILE_MAX_BYTES) { out.push({ path: r.rel, problem: 'too_large' }); return }
      const text = readRegular(r.abs, SKILL_FILE_MAX_BYTES).bytes.toString('utf8')
      const problem = loadProblem(text, r.rel)
      if (problem) out.push({ path: r.rel, problem })
      else if (isSkillManifest(r.rel) && skillInputsProblem(text, r.rel)) out.push({ path: r.rel, problem: 'inputs' })
    } catch { /* not readable: say nothing */ }
  }, projects)
  const manager = managedSkillRoots(files, user).length > 0
  // a group's root: for its members who may write it; the team's: for its skill managers; the person's own: always
  const groupWriter = new Set(capped.some((r) => isGroupSkill(r)) ? writableGroupSkillRoots(files, user).map((g) => g.root) : [])
  for (const root of capped) if (isGroupSkill(root) ? groupWriter.has(root) : root !== SKILLS_DIR || manager) out.push({ path: root, problem: 'too_many' })
  // (a project's root is only walked for the people who may write it)
  if (manager && o.rules && o.rules.total > o.rules.followed) out.push({ path: SKILLS_DIR, problem: 'too_many_rules' })
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.problem.localeCompare(b.problem))
}

/** Longest explicit name wins, then (at that length) every wider skill before a project skill, by name or by alias
 * (a project only adds names: docs/DECISIONS.md "Project skills"), then file aliases, then a personal skill before a
 * group skill before a team skill; between two groups' skills the group that comes first in groupOrder (its name,
 * letter case ignored, then its id), then the path. Folder skills never acquire a shared /SKILL alias. */
export function invokedSkill(skills: Skill[], content: string): { skill: Skill; input: string } | null {
  const t = content.trimStart()
  if (!t.startsWith('/')) return null
  const rest = t.slice(1)
  const fold = (s: string) => s.normalize('NFC').toLowerCase()
  const candidates = skills.flatMap((s) => [
    { s, key: s.name, alias: false },
    { s, key: skillAlias(s.path), alias: true },
  ]).sort((a, b) => b.key.length - a.key.length || Number(!!a.s.project) - Number(!!b.s.project) || Number(a.alias) - Number(b.alias)
    || skillTier(a.s) - skillTier(b.s) || (a.s.group && b.s.group ? groupOrder(a.s.group, b.s.group) : 0) || a.s.path.localeCompare(b.s.path))
  for (const { s, key } of candidates) {
    const head = rest.slice(0, key.length)
    const next = rest.charAt(key.length)
    if (fold(head) === fold(key) && (next === '' || /\s/.test(next))) return { skill: s, input: rest.slice(key.length).trim() }
  }
  return null
}

/** The folder of a skill file (for the chat's read scope). */
export const skillFolder = (p: string) => p.slice(0, p.lastIndexOf('/'))
