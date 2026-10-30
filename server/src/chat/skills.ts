// Skills: legacy Markdown files and Agent Skills folders with a SKILL.md entry point. Two roots hold them: skills/
// (team skills; the folder rules of skills/ and its subfolders decide who can read each one) and users/<id>/skills/
// (personal skills of that person; nobody else can read them, owner and admins included). Every listing is for one
// principal: the person who runs the turn or calls the API (docs/DECISIONS.md "Skills: folder permissions and
// personal skills"). Folder rules still govern every read/write. Resources are read on demand through the ordinary file tools;
// discovering a manifest never executes scripts or grants tools named in its metadata.
import fs from 'node:fs'
import path from 'node:path'
import { isMap, isScalar, parseDocument } from 'yaml'
import type { FileService } from '../files/service'
import { readRegular } from '../files/store'
import type { Principal } from '../policy/access'
import { authorize } from '../policy/authorize'

export interface SkillInfo { path: string; name: string; description: string }
export interface Skill extends SkillInfo { body: string }

const SKILLS_DIR = 'skills'
const USERS_DIR = 'users'
const MAX_DEPTH = 3
const MAX_FILES = 200
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

/** The number of path segments of the skill root that holds `parts`: 1 for skills/..., 3 for users/<id>/skills/...,
 * null for a path outside both roots. The root itself is not inside it. */
function skillRootLength(parts: readonly string[]): number | null {
  if (parts[0] === SKILLS_DIR) return 1
  if (parts[0] === USERS_DIR && parts.length >= 3 && parts[1] && parts[2] === SKILLS_DIR) return 3
  return null
}
/** A path under users/<id>/skills/ (a personal skill entry). */
export const isPersonalSkill = (rel: string) => skillRootLength(rel.split('/')) === 3
/** The metadata a listing shows (no body). `personal` is set only for a personal skill. */
export const skillInfo = ({ path: p, name, description }: SkillInfo): SkillInfo & { personal?: true } =>
  (isPersonalSkill(p) ? { path: p, name, description, personal: true } : { path: p, name, description })
const hasFrontmatter = (text: string) => /^\uFEFF?---[ \t]*(?:\r?\n|$)/.test(text)

/** Decode the standard metadata without constructing JS objects or expanding aliases. Only the root and the
 * optional metadata string map may be collections. The bounded header also limits parser work before validation. */
function standardFields(header: string): Map<string, string> | null {
  try {
    const doc = parseDocument(header, { strict: true, uniqueKeys: true, schema: 'core', version: '1.2', prettyErrors: false, logLevel: 'silent' })
    if (doc.errors.length || doc.warnings.length || !isMap(doc.contents) || doc.contents.anchor || doc.contents.tag) return null
    const fields = new Map<string, string>()
    const scalar = (v: unknown): v is import('yaml').Scalar<string> => isScalar(v) && typeof v.value === 'string' && !v.anchor && !v.tag
    for (const item of doc.contents.items) {
      if (!scalar(item.key)) return null
      const key = item.key.value
      if (key === 'metadata') {
        if (!isMap(item.value) || item.value.anchor || item.value.tag) return null
        for (const pair of item.value.items) if (!scalar(pair.key) || !scalar(pair.value)) return null
      } else {
        if (!scalar(item.value)) return null
        fields.set(key, item.value.value)
      }
    }
    return fields
  } catch { return null }
}

/** Why an entry with a header is not a skill. Codes only: the screens translate them (R2-SKILL-03). */
export type SkillProblem = 'too_large' | 'header' | 'location' | 'name' | 'name_folder' | 'description' | 'compatibility'
export type SkillCheck = { ok: true; name: string; description: string; body: string } | { ok: false; problem: SkillProblem }

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
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(t.slice(0, HEADER_MAX + 16))
  if (!m || Buffer.byteLength(m[1]!, 'utf8') > HEADER_MAX) return no('header')
  if (rel !== undefined && isSkillManifest(rel)) {
    const parts = rel.split('/')
    const root = skillRootLength(parts)
    if (root === null || parts.length < root + 2 || parts.length > root + MAX_DEPTH) return no('location')
    const fields = standardFields(m[1]!)
    if (!fields) return no('header')
    const name = fields.get('name'), description = fields.get('description')
    if (!name || name.length > SKILL_NAME_MAX || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return no('name')
    if (name !== parts.at(-2)) return no('name_folder')
    if (!description?.trim() || [...description].length > DESCRIPTION_MAX) return no('description')
    const compatibility = fields.get('compatibility')
    if (compatibility !== undefined && (!compatibility.trim() || [...compatibility].length > 500)) return no('compatibility')
    return { ok: true, name, description: description.trim(), body: t.slice(m[0].length) }
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

export function parseSkill(text: string, rel?: string): { name: string; description: string; body: string } | null {
  const r = checkSkill(text, rel)
  return r.ok ? { name: r.name, description: r.description, body: r.body } : null
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
  if (parseSkill(text, rel)) return 'skill'
  return isSkillManifest(rel) || hasFrontmatter(text) ? 'other' : 'rule'
}

/** Read exactly one authorized entry using the same link/size checks as the file tools. A personal entry is a skill
 * only for its owner (the folder rules give nobody else access; this check does not depend on them). */
export function readSkill(files: FileService, user: Principal, inputPath: string): Skill | null {
  try {
    const r = authorize(files.fx, files.rules(), user, inputPath, 'read')
    const root = skillRootLength(r.segs)
    if (root === null || (root === 3 && r.segs[1] !== user.id)) return null
    if (r.segs.length > root + MAX_DEPTH || !r.rel.endsWith('.md') || isSkillResource(files.fx.root, r.rel)) return null
    const text = readRegular(r.abs, SKILL_FILE_MAX_BYTES).bytes.toString('utf8')
    const skill = parseSkill(text, r.rel)
    return skill ? { path: r.rel, ...skill, body: skill.body.slice(0, SKILL_BODY_MAX) } : null
  } catch { return null }
}

/** Visit the accessible entry candidates under skills/ and under the caller's own users/<id>/skills/: legacy .md
 * files and folder SKILL.md files, capped per root (team skills cannot push personal skills out). Never descend into
 * a skill package. */
function walkSkillEntries(files: FileService, user: Principal, visit: (rel: string) => void) {
  walkSkillRoot(files, user, SKILLS_DIR, visit)
  walkSkillRoot(files, user, personalSkillsDir(user.id), visit)
}

function walkSkillRoot(files: FileService, user: Principal, rootRel: string, visit: (rel: string) => void) {
  let seen = 0
  const walk = (rel: string, depth: number) => {
    let names: string[]
    try {
      const r = authorize(files.fx, files.rules(), user, rel, 'list')
      if (!r.st?.isDirectory()) return
      names = fs.readdirSync(r.abs).sort()
    } catch { return }
    if (depth > 1 && names.includes('SKILL.md')) {
      if (seen++ < MAX_FILES) visit(`${rel}/SKILL.md`)
      return
    }
    for (const n of names) {
      if (seen >= MAX_FILES) break
      if (n.startsWith('.')) continue
      const child = `${rel}/${n}`
      let st: fs.Stats
      try { st = authorize(files.fx, files.rules(), user, child, 'list').st! } catch { continue }
      if (st.isDirectory()) { if (depth < MAX_DEPTH) walk(child, depth + 1); continue }
      if (!st.isFile() || st.nlink > 1 || !n.endsWith('.md')) continue
      seen++
      visit(child)
    }
  }
  walk(rootRel, 1)
}

const nameKey = (s: string) => s.normalize('NFC').toLowerCase()

/** Accessible legacy files and folder entry points of `user`, sorted: the team skills the folder rules let them
 * read, and their own personal skills. A personal skill with the same name as a team skill replaces that team skill
 * in this person's list only (other people still get the team skill). */
export function listSkills(files: FileService, user: Principal): Skill[] {
  const out: Skill[] = []
  walkSkillEntries(files, user, (rel) => {
    const skill = readSkill(files, user, rel)
    if (skill) out.push(skill)
  })
  const personal = new Set(out.filter((s) => isPersonalSkill(s.path)).map((s) => nameKey(s.name)))
  return out.filter((s) => isPersonalSkill(s.path) || !personal.has(nameKey(s.name)))
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
}

export interface SkillIssue { path: string; problem: SkillProblem }

/** Entries that look like skills but do not load (R2-SKILL-03): a SKILL.md that fails validation, or a legacy file
 * with a header that fails. Only entries the caller can read are checked, so a path the caller cannot read never
 * shows. A file without a header is a team rule, not an issue. */
export function skillIssues(files: FileService, user: Principal): SkillIssue[] {
  const out: SkillIssue[] = []
  walkSkillEntries(files, user, (rel) => {
    try {
      const r = authorize(files.fx, files.rules(), user, rel, 'read')
      if (isSkillResource(files.fx.root, r.rel)) return
      if (!r.st?.isFile()) return
      if (r.st.size > SKILL_FILE_MAX_BYTES) { out.push({ path: r.rel, problem: 'too_large' }); return }
      const text = readRegular(r.abs, SKILL_FILE_MAX_BYTES).bytes.toString('utf8')
      const check = checkSkill(text, r.rel)
      if (!check.ok && (isSkillManifest(r.rel) || hasFrontmatter(text))) out.push({ path: r.rel, problem: check.problem })
    } catch { /* not readable: say nothing */ }
  })
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/** Longest explicit name wins, then file aliases, then a personal skill before a team skill. Folder skills never
 * acquire a shared /SKILL alias. */
export function invokedSkill(skills: Skill[], content: string): { skill: Skill; input: string } | null {
  const t = content.trimStart()
  if (!t.startsWith('/')) return null
  const rest = t.slice(1)
  const fold = (s: string) => s.normalize('NFC').toLowerCase()
  const candidates = skills.flatMap((s) => [
    { s, key: s.name, alias: false },
    { s, key: isSkillManifest(s.path) ? path.posix.basename(path.posix.dirname(s.path)) : path.posix.basename(s.path, '.md'), alias: true },
  ]).sort((a, b) => b.key.length - a.key.length || Number(a.alias) - Number(b.alias)
    || Number(isPersonalSkill(b.s.path)) - Number(isPersonalSkill(a.s.path)) || a.s.path.localeCompare(b.s.path))
  for (const { s, key } of candidates) {
    const head = rest.slice(0, key.length)
    const next = rest.charAt(key.length)
    if (fold(head) === fold(key) && (next === '' || /\s/.test(next))) return { skill: s, input: rest.slice(key.length).trim() }
  }
  return null
}

/** The folder of a skill file (for the chat's read scope). */
export const skillFolder = (p: string) => p.slice(0, p.lastIndexOf('/'))
