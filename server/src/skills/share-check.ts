// 내 스킬 가져오기 (docs/DECISIONS.md "K — 내 스킬 가져오기"): the deterministic checks of a share proposal. Pure (no
// context, no disk): the server is the authority for every source (a picked .claude folder in the browser or the
// desktop app, or Claude Code through the connector), so whatever a sender pre-filtered is checked again here.
// Each candidate skill gets one outcome:
//   - excluded (cannot go to the team), its content dropped at once: secret (a key, token or password in any file, or a
//     secret file name such as .env or id_rsa; never written anywhere), plugin (a plugin's skill: installed as a plugin),
//     too_big, scripts (its SKILL.md tells the AI to run code: the team never runs a skill's scripts), not_skill (no
//     SKILL.md, or a header the team's own reader cannot take even after it is made valid);
//   - otherwise kept, with its files (script files left out and counted, anything not a text file or a small image
//     left out), its header made valid for skills/<name>/SKILL.md (the name a valid folder name, scalar values only, no
//     YAML anchors, aliases or tags), and two marks: a path on the sender's computer (personal_path, unticked) and a
//     team skill of the same name (merged by default). A command (~/.claude/commands/*.md) becomes a skill with a
//     generated header.
// The CLAUDE.md lines that carry a secret are dropped before anything else sees them; remote MCP servers keep only an
// https address without a key or a query. The AI's judgement and the final groups: share-judge.ts.
import { isAlias, isMap, isScalar, isSeq, parseDocument, visit } from 'yaml'
import { addressHasSecret, findLikelySecrets, findSecrets } from '@mycel/shared'
import {
  SHARE_IMAGE_EXTENSIONS, SHARE_SCRIPT_EXTENSIONS, SHARE_TEXT_EXTENSIONS, SKILL_SHARE_LIMITS,
  type CreateSkillShare, type ShareCandidate, type ShareExcludedIn, type ShareExcludedReason, type ShareSkillIn, type ShareTool,
} from '@mycel/shared/api'
import { checkSkill, sameSkillName, SKILL_NAME_MAX } from '../chat/skills'
import { badSegment } from '../policy/names'
import { romanize } from '../onboarding/skill-draft'

/** A team skill the caller can read (listTeamSkills), by the name "/<name>" runs and the title people read. */
export interface TeamSkillRef { name: string; path: string; title: string; description?: string }
/** A file of a kept candidate as it is staged (and written on apply): its path inside the skill folder. */
export interface StagedFile { path: string; data: Buffer }
/** The CLAUDE.md as the server keeps it for the AI: the lines with a secret left out (counted in `dropped`). */
export interface RuleInput { text: string; lines: number; dropped: number }
export interface CheckedShare {
  candidates: ShareCandidate[]
  /** the kept files of each candidate that is not excluded, by its name; SKILL.md first, header made valid */
  files: Map<string, StagedFile[]>
  rule: RuleInput | null
  tools: ShareTool[]
  where: string | null
  projects: number | null
}

const MANIFEST = 'SKILL.md'
/** segments of a file's path inside the skill folder */
const PATH_DEPTH = 4
/** the start of CLAUDE.md the AI reads; the rest is cut */
export const RULE_IN_CHARS = 16_000

const TEXT_EXT = new Set<string>(SHARE_TEXT_EXTENSIONS)
const IMAGE_EXT = new Set<string>(SHARE_IMAGE_EXTENSIONS)
const SCRIPT_EXT = new Set<string>(SHARE_SCRIPT_EXTENSIONS)
const extOf = (p: string) => { const b = p.slice(p.lastIndexOf('/') + 1); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1).toLowerCase() : '' }
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1)
/** a key for paths and names that a case-insensitive team folder would take as the same */
const fold = (s: string) => s.normalize('NFC').toLowerCase()

/** One line of text, control and direction characters removed, at most `max` characters. */
export function oneLine(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  return [...v.replace(/[\r\n\v\f\u0085\u2028\u2029\t]+/g, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim()].slice(0, max).join('').trim()
}

// ---------------------------------------------------------------- names

/**
 * The folder name a sent skill is saved under: lowercase a–z, 0–9 and hyphens, at most 64 characters, as the team's
 * reader wants it (chat/skills.ts checkSkill). A valid name stays; another one becomes a slug (Hangul romanized, accents
 * dropped, anything else a hyphen); nothing left: "skill". A name the team folder refuses as a segment (CON, NUL …)
 * gets "-skill".
 */
export function validSkillName(raw: string): string {
  const clean = raw.normalize('NFKC').replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '').trim()
  let name = clean.length <= SKILL_NAME_MAX && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(clean) ? clean
    : romanize(clean.normalize('NFC')).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, SKILL_NAME_MAX).replace(/-+$/g, '')
  if (!name) name = 'skill'
  if (badSegment(name)) name = `${name.slice(0, SKILL_NAME_MAX - 6)}-skill`
  return name
}

/** `base`, or "<base>-2", "-3" … (cut to stay at 64 characters) when `taken` says it is in use. */
export function freeName(base: string, taken: (name: string) => boolean): string {
  if (!taken(base)) return base
  for (let n = 2; n < 10_000; n++) {
    const tail = `-${n}`
    const name = `${base.slice(0, SKILL_NAME_MAX - tail.length).replace(/-+$/g, '')}${tail}`
    if (!taken(name)) return name
  }
  throw new Error('no free skill name')
}

// ---------------------------------------------------------------- secrets

/** Names of files that hold keys whatever their text says (checked on every segment of a path). */
const SECRET_NAMES: [RegExp, string][] = [
  [/^\.env(?:\..*)?$/i, 'env'],
  [/^\.envrc$/i, 'env'],
  [/\.(?:pem|key|p12|pfx|jks|keystore|ppk|asc|gpg|kdbx)$/i, 'private-key'],
  [/^id_(?:rsa|dsa|ecdsa|ed25519)(?:[._-].*)?$/i, 'private-key'],
  [/^\.(?:npmrc|yarnrc|yarnrc\.yml|pypirc)$/i, 'npm'],
  [/^\.?netrc$/i, 'netrc'],
  [/^_netrc$/i, 'netrc'],
  [/^\.?credentials(?:\..*)?$/i, 'credentials'],
  [/^\.git-credentials$/i, 'credentials'],
  [/^\.htpasswd$/i, 'credentials'],
  [/^(?:client_)?secrets?\.(?:json|ya?ml|toml|env|txt)$/i, 'credentials'],
  [/^service[-_]?account.*\.json$/i, 'credentials'],
  [/^\.(?:ssh|aws|gnupg|docker|kube)$/i, 'credentials'],
]
/** The kind of secret a file's name says it holds ("env", "private-key"), or null. */
export function secretFileKind(rel: string): string | null {
  for (const seg of rel.split('/')) for (const [re, kind] of SECRET_NAMES) if (re.test(seg.normalize('NFC'))) return kind
  return null
}

/** finds that only say "something looks generated": a provider's name tells the person more */
const GENERIC_KINDS = new Set(['random', 'named-key', 'prefixed', 'assignment', 'labelled'])
/** The kind of the first secret in the text ("slack", "openai", "private-key"…), or null. Both readers of
 * shared/src/secrets.ts: the one that errs towards finding (titles) and the one that is almost sure. */
export function secretKind(text: string): string | null {
  const spans = [...findLikelySecrets(text), ...findSecrets(text)]
  if (!spans.length) return null
  return (spans.find((s) => !GENERIC_KINDS.has(s.kind)) ?? spans[0]!).kind
}

// ---------------------------------------------------------------- personal paths, scripts

/** A path on the sender's computer: a home folder (macOS, Linux, Windows) or ~/ outside the skill's own folder. */
export function personalPathIn(text: string, skillName: string): boolean {
  if (/(?:^|[^\w.-])\/Users\/[^/\s'"`()<>]+\//m.test(text)) return true
  if (/(?:^|[^\w.-])\/home\/[^/\s'"`()<>]+\//m.test(text)) return true
  if (/(?:^|[^\w.-])[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s'"`()<>]+[\\/]/im.test(text)) return true
  if (/%USERPROFILE%|%HOMEPATH%|\$HOME\b|\$\{HOME\}/i.test(text)) return true
  const own = skillName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[\\s'"\`(=:,])~[\\\\/](?!\\.claude/(?:skills|commands)/${own}(?:[/.\\s'"\`)]|$))`, 'm').test(text)
}

/** Lines that tell the AI to run code: interpreters with a script or -c, package runners, installs, scripts/…, a
 * shell or code fence, a Claude Code command's shell line (!`…`), ./x.sh, "run the script". */
const RUNS_CODE: RegExp[] = [
  /(?:^|[^\w.-])(?:python3?|py|pypy3?)\s+(?:-[mcu]\b|[^\s`'"|;&()]+\.py\b)/im,
  /(?:^|[^\w.-])(?:bash|sh|zsh|fish|source)\s+(?:-c\b|[^\s`'"|;&()]+\.(?:sh|bash|zsh|fish)\b)/im,
  /(?:^|[^\w.-])(?:node|deno|bun|tsx|ts-node|ruby|perl|php|pwsh|powershell)\s+(?:-e\b|-c\b|run\b|[^\s`'"|;&()]+\.(?:m?js|cjs|ts|mts|rb|pl|php|ps1)\b)/im,
  /(?:^|[^\w.-])(?:npx|bunx|uvx|pipx|pnpx)\s+\S/im,
  /(?:^|[^\w.-])(?:uv|poetry|pdm|hatch)\s+run\b/im,
  /(?:^|[^\w.-])(?:pip3?|npm|pnpm|yarn|brew|apt(?:-get)?|cargo|gem|go)\s+(?:install|i|add|run|exec)\b/im,
  /(?:^|[\s(`'"[])(?:\.{1,2}\/)?scripts\/[^\s`'"()]+/im,
  /(?:^|[^\w.-])\.\/[^\s`'"()/]+\.(?:sh|bash|zsh|py|m?js|cjs|ts|rb|pl|php|ps1)\b/im,
  /```[ \t]*(?:bash|sh|zsh|fish|shell|console|shellscript|shell-session|terminal|python3?|py|javascript|js|node|typescript|ts|ruby|rb|perl|php|powershell|ps1|pwsh|bat|cmd)\b/i,
  /!`[^`\n]+`/,
  /\b(?:run|execute|invoke)\b[^\n.]{0,40}\b(?:python|bash|node|shell|command line|terminal)\b/i,
  /스크립트[^\n.]{0,20}(?:실행|돌려|돌리)/,
]
/** Whether a SKILL.md tells the AI to run code (a command, a script, one of the skill's own script files by name). */
export function needsScripts(skillMd: string, scriptPaths: readonly string[]): boolean {
  if (RUNS_CODE.some((re) => re.test(skillMd))) return true
  const t = fold(skillMd)
  return scriptPaths.some((p) => t.includes(fold(p)) || t.includes(fold(baseOf(p))))
}

// ---------------------------------------------------------------- the header

const HEADER_RE = /^\ufeff?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/
const HEADER_MAX = 8 * 1024
const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/
/** a YAML double-quoted value on one line (JSON string syntax; U+2028/9 escaped: JSON.stringify writes them raw) */
const q = (s: string) => JSON.stringify(s).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
const key = (k: string) => (PLAIN_KEY.test(k) ? k : q(k))

/** A header value as one text: a scalar as written (true → "true"), a list of scalars joined by ", " (allowed-tools:
 * [Read, Grep] → "Read, Grep"); null for anything else (a map, a list of maps, an empty value). */
function flat(v: unknown): string | null {
  if (isScalar(v)) return v.value === null || v.value === undefined ? null : typeof v.value === 'object' ? null : String(v.value)
  if (isSeq(v)) {
    const parts = v.items.map((x) => (isScalar(x) && x.value !== null && typeof x.value !== 'object' ? String(x.value) : null))
    return parts.length && parts.every((x) => x !== null) ? parts.join(', ') : null
  }
  return null
}

export interface SkillHeader { fields: [string, string][]; metadata: [string, string][]; body: string }

/** The header of a Markdown file as plain fields, or null: no header, a header over 8 KB, broken YAML, or any anchor,
 * alias or tag in it (they make one text mean another; refused, never expanded). Values that are not text become
 * text or are left out (flat). */
export function readHeader(text: string): SkillHeader | null {
  const m = HEADER_RE.exec(text)
  if (!m || Buffer.byteLength(m[1]!, 'utf8') > HEADER_MAX) return null
  let doc
  try { doc = parseDocument(m[1]!, { strict: true, uniqueKeys: true, schema: 'core', version: '1.2', prettyErrors: false, logLevel: 'silent' }) } catch { return null }
  if (doc.errors.length || doc.warnings.length || !isMap(doc.contents)) return null
  let tricky = false
  visit(doc, (_k, n) => {
    if (isAlias(n)) { tricky = true; return visit.BREAK }
    const node = n as { anchor?: string; tag?: string }
    if (node && typeof node === 'object' && (node.anchor || node.tag)) { tricky = true; return visit.BREAK }
    return undefined
  })
  if (tricky) return null
  const fields: [string, string][] = [], metadata: [string, string][] = []
  for (const item of doc.contents.items) {
    if (!isScalar(item.key) || typeof item.key.value !== 'string') return null
    const k = item.key.value
    if (k === 'metadata') {
      if (!isMap(item.value)) continue
      for (const p of item.value.items) {
        if (!isScalar(p.key) || typeof p.key.value !== 'string') return null
        const v = flat(p.value)
        if (v !== null) metadata.push([p.key.value, v])
      }
      continue
    }
    const v = flat(item.value)
    if (v !== null) fields.push([k, v])
  }
  return { fields, metadata, body: text.slice(m[0].length) }
}

/** A SKILL.md with a header the team's reader takes: `name` set, the description first, every value one quoted line,
 * the metadata title replaced when `title` is given (allowed-tools and the rest kept as they are: they grant
 * nothing). */
export function writeSkillMd(h: SkillHeader, o: { name: string; description?: string; title?: string | null }): string {
  const fields = h.fields.filter(([k]) => k !== 'name' && k !== 'description')
  const description = o.description ?? h.fields.find(([k]) => k === 'description')?.[1] ?? ''
  const metadata = o.title ? [...h.metadata.filter(([k]) => k !== 'title'), ['title', o.title] as [string, string]] : h.metadata
  const lines = ['---', `name: ${o.name}`, `description: ${q(description.replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, ' ').trim())}`]
  for (const [k, v] of fields) lines.push(`${key(k)}: ${q(v)}`)
  if (metadata.length) { lines.push('metadata:'); for (const [k, v] of metadata) lines.push(`  ${key(k)}: ${q(v)}`) }
  lines.push('---')
  return `${lines.join('\n')}\n${h.body.replace(/^\r?\n/, '')}`
}

/** The SKILL.md text again with another name and/or title (separate, the AI's title on apply), or null when it does not
 * read any more. */
export function renamedSkillMd(text: string, o: { name: string; title?: string | null }): string | null {
  const h = readHeader(text)
  if (!h) return null
  const out = writeSkillMd(h, o)
  return checkSkill(out, `skills/${o.name}/${MANIFEST}`).ok ? out : null
}

/** A Claude Code command as a skill: its own header made valid (or a new one), the description from its header or its
 * first line that is not empty. */
export function commandSkillMd(text: string, name: string): string | null {
  const h = readHeader(text) ?? (HEADER_RE.test(text) ? null : { fields: [], metadata: [], body: text })
  if (!h) return null
  const given = h.fields.find(([k]) => k === 'description')?.[1]?.trim()
  const first = h.body.split(/\r?\n/).map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? ''
  const description = oneLine(given || first || name, 1000) || name
  return writeSkillMd(h, { name, description })
}

// ---------------------------------------------------------------- one skill

type Outcome = { excluded: ShareExcludedReason; detail: string | null; description?: string } | { kept: StagedFile[]; description: string; scriptsDropped: number; personalPath: boolean }

/** Base64 of an image whose first bytes are that kind of image (png, jpeg, gif, webp), decoded; else null. */
export function imageBytes(b64: string, ext: string): Buffer | null {
  const s = b64.replace(/\s+/g, '')
  if (!s || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null
  const b = Buffer.from(s, 'base64')
  const is = (sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x)
  const ok = ext === 'png' ? is([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    : ext === 'jpg' || ext === 'jpeg' ? is([0xff, 0xd8, 0xff])
    : ext === 'gif' ? is([0x47, 0x49, 0x46, 0x38]) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61
    : ext === 'webp' ? is([0x52, 0x49, 0x46, 0x46]) && is([0x57, 0x45, 0x42, 0x50], 8)
    : false
  return ok ? b : null
}

/** A path inside the skill folder the team folder takes (every segment a valid, visible name), NFC; else null. */
function cleanRel(p: string): string | null {
  const rel = p.normalize('NFC')
  const segs = rel.split('/')
  if (segs.length > PATH_DEPTH || segs.some((s) => !s || s.startsWith('.') || badSegment(s))) return null
  return rel
}

function checkSkillIn(s: ShareSkillIn, name: string): Outcome {
  const no = (excluded: ShareExcludedReason, detail: string | null = null, description?: string): Outcome => ({ excluded, detail, ...(description ? { description } : {}) })
  if (s.origin === 'plugin') return no('plugin')
  // secrets first: the skill's content is dropped whatever else is wrong with it
  for (const f of s.files) { const k = secretFileKind(f.path); if (k) return no('secret', k) }
  for (const f of s.files) { if (f.text) { const k = secretKind(f.text); if (k) return no('secret', k) } }
  // what would be kept, and its size
  const seen = new Set<string>()
  const scripts: string[] = []
  const files: { rel: string; data: Buffer; text: string | null }[] = []
  let total = 0
  for (const f of s.files) {
    const ext = extOf(f.path)
    const bytes = f.text !== undefined ? Buffer.byteLength(f.text, 'utf8') : f.base64 !== undefined ? Math.floor(f.base64.replace(/\s+/g, '').length * 3 / 4) : 0
    const script = SCRIPT_EXT.has(ext) || (fold(f.path).startsWith('scripts/') && !TEXT_EXT.has(ext) && !IMAGE_EXT.has(ext))
    if (!script && bytes > SKILL_SHARE_LIMITS.fileBytes) return no('too_big')
    const rel = cleanRel(f.path)
    if (!rel || seen.has(fold(rel))) continue
    seen.add(fold(rel))
    // a script's content is never kept, even when a sender includes it
    if (script) { scripts.push(rel); continue }
    if (TEXT_EXT.has(ext) && f.text !== undefined && !f.text.includes('\u0000')) {
      files.push({ rel, data: Buffer.from(f.text, 'utf8'), text: f.text })
      total += bytes
    } else if (IMAGE_EXT.has(ext) && f.base64 !== undefined) {
      const img = imageBytes(f.base64, ext)
      if (img) { files.push({ rel, data: img, text: null }); total += img.length }
    }
  }
  if (s.files.length > SKILL_SHARE_LIMITS.skillFiles || total > SKILL_SHARE_LIMITS.skillBytes) return no('too_big')
  // the entry point: SKILL.md at the top of the folder (any letter case), or a command's own file
  let manifest: string | null
  let rest: typeof files
  if (s.origin === 'command') {
    const md = files.filter((f) => f.text !== null && extOf(f.rel) === 'md')
    const own = md.find((f) => fold(baseOf(f.rel)) === fold(`${s.name}.md`)) ?? md[0]
    manifest = own ? commandSkillMd(own.text!, name) : null
    // a command is one file
    rest = []
  } else {
    const own = files.find((f) => f.text !== null && fold(f.rel) === fold(MANIFEST))
    const h = own ? readHeader(own.text!) : null
    manifest = h ? writeSkillMd(h, { name }) : null
    rest = files.filter((f) => f !== own)
  }
  if (!manifest) return no('not_skill')
  const check = checkSkill(manifest, `skills/${name}/${MANIFEST}`)
  if (!check.ok) return no('not_skill')
  if (needsScripts(manifest, scripts)) return no('scripts', null, check.description)
  const texts = [manifest, ...rest.filter((f) => f.text !== null).map((f) => f.text!)]
  return {
    kept: [{ path: MANIFEST, data: Buffer.from(manifest, 'utf8') }, ...rest.map((f) => ({ path: f.rel, data: f.data }))],
    description: check.description,
    scriptsDropped: scripts.length,
    personalPath: texts.some((t) => personalPathIn(t, name)),
  }
}

// ---------------------------------------------------------------- CLAUDE.md, tools

/** CLAUDE.md as the AI may read it: every line touched by a secret left out (counted), at most RULE_IN_CHARS; null when
 * nothing is left. */
export function cleanRuleInput(text: string): RuleInput | null {
  const t = text.replace(/\r\n?/g, '\n')
  const lines = t.split('\n')
  const starts: number[] = []
  let at = 0
  for (const l of lines) { starts.push(at); at += l.length + 1 }
  const lineAt = (pos: number) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid]! <= pos) lo = mid; else hi = mid - 1 } return lo }
  const bad = new Set<number>()
  for (const s of [...findSecrets(t), ...findLikelySecrets(t)]) for (let i = lineAt(s.start); i <= lineAt(Math.max(s.start, s.end - 1)); i++) bad.add(i)
  lines.forEach((l, i) => { if (!bad.has(i) && secretKind(l)) bad.add(i) })
  const kept = lines.filter((_, i) => !bad.has(i))
  const dropped = [...bad].filter((i) => lines[i]!.trim()).length
  let out = kept.join('\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim()
  if (out.length > RULE_IN_CHARS) out = out.slice(0, RULE_IN_CHARS)
  if (!out) return null
  return { text: out, lines: out.split('\n').filter((l) => l.trim()).length, dropped }
}

/** The team rule as the server keeps it from the AI's text: lines with a secret or a path on someone's computer left
 * out, no header (a file without one is a team rule, chat/prompt.ts teamRuleFiles), at most `max` characters cut at a
 * line. null when nothing is left. */
export function cleanRuleOutput(text: string, max = SKILL_SHARE_LIMITS.ruleChars): { text: string; lines: number; removed: number } | null {
  const lines = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').split('\n')
  let removed = 0
  const kept: string[] = []
  for (const l of lines) {
    if (secretKind(l) || personalPathIn(l, '')) { if (l.trim()) removed++; continue }
    kept.push(l.replace(/\s+$/, ''))
  }
  // a "---" first line would start a header: the file would be read as a skill, not a rule
  while (kept.length && (!kept[0]!.trim() || /^-{3,}\s*$/.test(kept[0]!))) kept.shift()
  let out = ''
  for (const l of kept) {
    const next = out ? `${out}\n${l}` : l
    if ([...next].length > max) break
    out = next
  }
  out = out.trim()
  if (!out) return null
  return { text: out, lines: out.split('\n').filter((l) => l.trim()).length, removed }
}

/** Remote MCP servers as connection templates: an https address without a user, password, query, fragment or key
 * (a server whose address holds a key is left out, never stored), a header name only for header auth, each name once. */
export function cleanTools(tools: CreateSkillShare['tools']): ShareTool[] {
  const out: ShareTool[] = []
  for (const t of tools ?? []) {
    const name = oneLine(t.name, 80)
    if (!name || secretKind(name) || out.some((o) => fold(o.name) === fold(name))) continue
    let u: URL
    try { u = new URL(t.url.trim()) } catch { continue }
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || addressHasSecret(t.url) || addressHasSecret(u.href)) continue
    const header = t.auth === 'header' && t.header && /^[A-Za-z0-9-]{1,64}$/.test(t.header) ? t.header : null
    out.push({ name, url: u.href, auth: t.auth, header, templateId: null, error: null })
  }
  return out
}

// ---------------------------------------------------------------- the whole share

const KIND = /^[A-Za-z0-9 _.-]{1,40}$/
/** A project folder's own name (never a full path). */
const projectName = (v: string | undefined) => { const s = oneLine(v, 200); const b = s.split(/[\\/]/).filter(Boolean).pop() ?? ''; return b && !secretKind(b) ? oneLine(b, 100) : null }

/** A candidate as it is before the AI's judgement (and when there is none): excluded as checked, else under 그 밖에
 * (a path on the computer, a command, or not judged); merged by default into a team skill of the same name. */
function before(c: Omit<ShareCandidate, 'group' | 'reason' | 'detail' | 'action' | 'title' | 'similar' | 'applied'> & { excluded?: { reason: ShareExcludedReason; detail: string | null } }): ShareCandidate {
  const { excluded, ...rest } = c
  if (excluded) return { ...rest, title: null, group: 'excluded', reason: excluded.reason, detail: excluded.detail, similar: null, action: 'add', applied: null, files: [], scriptsDropped: 0, personalPath: false, sameName: null }
  return { ...rest, title: null, group: 'other', reason: rest.personalPath ? 'personal_path' : rest.origin === 'command' ? 'command' : 'unjudged', detail: null, similar: null, action: rest.sameName ? 'merge' : 'add', applied: null }
}

/**
 * Check a share as sent: every skill (names made valid and unique, files, secrets, scripts, plugin, size, header,
 * personal paths, a team skill of the same name), the names the sender left out, CLAUDE.md, and (Claude Code only) the
 * remote MCP servers and project count. Excluded candidates keep no file; a secret's content is never kept.
 */
export function checkShare(body: CreateSkillShare, team: readonly TeamSkillRef[]): CheckedShare {
  const used = new Set<string>()
  // a name that is itself a key is never kept, not even as a folder name
  const take = (raw: string) => { const n = freeName(validSkillName(secretKind(raw) ? '' : raw), (x) => used.has(x)); used.add(n); return n }
  const candidates: ShareCandidate[] = []
  const files = new Map<string, StagedFile[]>()
  const sameName = (name: string) => { const t = team.find((s) => sameSkillName(s.name, name)); return t ? { path: t.path, title: t.title } : null }
  for (const s of body.skills) {
    const name = take(s.name)
    const base = { name, origin: s.origin, project: s.origin === 'project' ? projectName(s.project) : null }
    const r = checkSkillIn(s, name)
    if ('excluded' in r) {
      candidates.push(before({ ...base, description: r.description ?? '', excluded: { reason: r.excluded, detail: r.detail }, personalPath: false, files: [], scriptsDropped: 0, sameName: null }))
      continue
    }
    files.set(name, r.kept)
    candidates.push(before({ ...base, description: r.description, personalPath: r.personalPath, files: r.kept.map((f) => ({ path: f.path, bytes: f.data.length })), scriptsDropped: r.scriptsDropped, sameName: sameName(name) }))
  }
  for (const e of body.excluded ?? [] as ShareExcludedIn[]) {
    const name = take(e.name)
    const detail = e.reason === 'secret' && e.kind && KIND.test(e.kind) ? e.kind : null
    candidates.push(before({ name, origin: e.origin ?? 'user', project: null, description: '', excluded: { reason: e.reason, detail }, personalPath: false, files: [], scriptsDropped: 0, sameName: null }))
  }
  const cc = body.source === 'claude_code'
  return {
    candidates, files,
    rule: body.rule ? cleanRuleInput(body.rule.text) : null,
    tools: cc ? cleanTools(body.tools) : [],
    where: (() => { const w = oneLine(body.where, 100); return w && !secretKind(w) ? w : null })(),
    projects: cc && body.projects !== undefined ? body.projects : null,
  }
}
