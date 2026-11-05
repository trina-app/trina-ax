// The demo content format (scripts/demo/company/README.md; docs/DECISIONS.md "Demo content: the mechanism is open, a
// company's content is a folder"). `bun run demo:company` runs a fictional company from a folder of this shape:
//
//   <content>/company.json   the company: owner account, people, groups, folder rules, who uploads which file, team
//                            settings, memories, the company profile, the three demo people with their lines and
//                            questions, the scenarios to record, and what each person can open (checks)
//   <content>/files/         the sample files at their team paths (shared/…, groups/<group>/…, skills/…)
//   <content>/recordings/    recorded real answers, <scenario slug>.json (record.ts writes them; optional)
//   <content>/assets/        optional: what the files are made from (generators, source pictures, their notes); the demo
//                            never reads it
//   <content>/README.md      what the company is, that it is fictional, where its pictures come from
//
// The open example is scripts/demo/acme (the default). A company's own content can live anywhere, e.g. a private
// repository: `bun run demo:company --content <dir>` or MYCEL_DEMO_CONTENT=<dir>. loadContent checks the whole folder
// before anything starts, so a broken folder stops with a list of what is wrong instead of a half-seeded team.
import fs from 'node:fs'
import path from 'node:path'
import { DEMO_CONTENT_FORMAT, DemoContentCompany, DemoFile, DemoRecording, type DemoPersonaKey } from '../../../shared/src/api'
import { DEMO_PASSWORD, listFiles, type DemoCompany } from '../seed'

const ROOT = path.resolve(import.meta.dir, '..', '..', '..')
/** the open example company, used when no content is given */
export const DEFAULT_CONTENT = path.join(ROOT, 'scripts', 'demo', 'acme')
/** the environment variable that names a content folder (the --content flag wins) */
export const CONTENT_ENV = 'MYCEL_DEMO_CONTENT'
export const CONTENT_FORMAT = DEMO_CONTENT_FORMAT

export type ContentCompany = DemoContentCompany
export type Scenario = ContentCompany['scenarios'][number]

export class ContentError extends Error {}

export interface DemoContent {
  /** the content folder (absolute) */
  dir: string
  company: ContentCompany
  /** what seedDemo makes (scripts/demo/seed.ts) */
  seed: DemoCompany
  filesDir: string
  /** where the recordings are (the folder may be missing: no replays, no past chats) */
  recordingsDir: string
  /** team paths of the files the seed uploads (the sample files, then the pack skills) */
  files: string[]
  /** the demo file the server reads (MYCEL_DEMO). `replays`: the recordings folder, or null while recording (no
   * replays: every prompt goes to the real AI). A showcase prompt is suggested only once it is recorded. */
  demoFile(o?: { replays?: string | null }): DemoFile
}

/** Which content folder: --content, else MYCEL_DEMO_CONTENT, else the open example (null when content is required). */
export function contentDir(flag: string | null | undefined, env: Record<string, string | undefined> = process.env, required = false): string | null {
  const v = flag?.trim() || env[CONTENT_ENV]?.trim()
  if (v) return path.resolve(v.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'))
  return required ? null : DEFAULT_CONTENT
}

const nfc = (s: string) => s.normalize('NFC')
const under = (rel: string, p: string) => rel === p || rel.startsWith(p.endsWith('/') ? p : `${p}/`)

/** Read and check a content folder. Every problem is listed at once (ContentError). */
export function loadContent(dirIn: string, o: { repoRoot?: string } = {}): DemoContent {
  const dir = path.resolve(dirIn)
  const root = o.repoRoot ?? ROOT
  const fail = (problems: string[]): never => {
    throw new ContentError(`the demo content in ${dir} is not usable (format: scripts/demo/company/README.md):\n${problems.map((p) => `- ${p}`).join('\n')}`)
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) fail([`there is no folder ${dir}`])
  let raw: unknown
  try { raw = JSON.parse(fs.readFileSync(path.join(dir, 'company.json'), 'utf8')) } catch (e) { fail([`company.json cannot be read: ${(e as Error).message}`]) }
  const parsed = DemoContentCompany.safeParse(raw)
  if (!parsed.success) fail(parsed.error.issues.slice(0, 20).map((i) => `company.json ${i.path.join('.') || '(top)'}: ${i.message}`))
  const c = parsed.data!
  const problems: string[] = []

  // people and groups
  const accounts = [c.owner.username, ...c.people.map((p) => p.username)]
  const lower = accounts.map((u) => u.toLowerCase())
  for (const [i, u] of lower.entries()) if (lower.indexOf(u) !== i) problems.push(`the account "${accounts[i]}" is there twice`)
  const groupNames = c.groups.map((g) => nfc(g.name))
  for (const [i, g] of groupNames.entries()) if (groupNames.indexOf(g) !== i) problems.push(`the group "${g}" is there twice`)
  const person = (u: string) => c.people.find((p) => p.username.toLowerCase() === u.toLowerCase())
  const account = (u: string) => u.toLowerCase() === c.owner.username.toLowerCase() || !!person(u)
  for (const p of c.people) if (p.group !== null && !groupNames.includes(nfc(p.group))) problems.push(`${p.username}: no group "${p.group}"`)
  for (const r of c.rules) {
    for (const x of r.rules) {
      if ('group' in x && !groupNames.includes(nfc(x.group))) problems.push(`rule ${r.path}: no group "${x.group}"`)
      if ('user' in x && !person(x.user)) problems.push(`rule ${r.path}: no person "${x.user}" (rules are for people, not the owner)`)
    }
  }
  for (const u of c.uploaders) if (!account(u.username)) problems.push(`uploaders ${u.path}: no account "${u.username}"`)
  if (c.defaultUploader && !account(c.defaultUploader)) problems.push(`defaultUploader: no account "${c.defaultUploader}"`)
  for (const m of c.memories) if (!person(m.username)) problems.push(`memories: no person "${m.username}"`)

  // the demo people: members of this content, each once
  const personas = c.demo.personas
  for (const p of personas) if (!person(p.username)) problems.push(`demo persona ${p.key}: "${p.username}" is not one of the people (the owner can never be a demo person)`)
  if (new Set(personas.map((p) => p.key)).size !== personas.length) problems.push('demo personas: each key (newHire, lead, ceo) once')
  if (new Set(personas.map((p) => p.username.toLowerCase())).size !== personas.length) problems.push('demo personas: each person once')

  // scenarios: a demo person's, unique slugs, room for the suggestions
  const slugs = c.scenarios.map((s) => s.slug)
  for (const [i, s] of slugs.entries()) if (slugs.indexOf(s) !== i) problems.push(`scenario "${s}" is there twice`)
  for (const s of c.scenarios) {
    if (!personas.some((p) => p.username.toLowerCase() === s.username.toLowerCase())) problems.push(`scenario ${s.slug}: "${s.username}" is not a demo persona`)
    if (s.kind === 'history' && s.daysAgo === undefined) problems.push(`scenario ${s.slug}: a history scenario needs daysAgo`)
  }
  for (const p of personas) {
    const n = p.questions.length + c.scenarios.filter((s) => s.kind === 'showcase' && s.username.toLowerCase() === p.username.toLowerCase()).length
    if (n > 6) problems.push(`demo persona ${p.key}: ${n} questions with its showcase prompts (at most 6)`)
  }
  for (const k of c.checks) if (!account(k.username)) problems.push(`checks: no account "${k.username}"`)

  // the sample files: there, at team paths the seed can upload to
  const filesDir = path.join(dir, 'files')
  let files: string[] = []
  if (!fs.existsSync(filesDir) || !fs.statSync(filesDir).isDirectory()) problems.push('there is no files/ folder')
  else {
    files = listFiles(filesDir)
    if (!files.length) problems.push('files/ is empty')
    for (const f of files) {
      const [top, second] = f.split('/')
      if (!['shared', 'groups', 'skills'].includes(top!) || f.split('/').length < 2) problems.push(`files/${f}: sample files go under shared/, groups/<group>/ or skills/`)
      else if (top === 'groups' && !groupNames.includes(second!)) problems.push(`files/${f}: no group "${second}"`)
    }
  }
  const packFiles = c.packSkills.flatMap((p) => p.skills.map((s) => ({ rel: `skills/${p.pack}/${s}/SKILL.md`, source: path.join(root, 'resources', 'skill-packs', p.pack, p.locale, s, 'SKILL.md') })))
  for (const f of packFiles) {
    if (!fs.existsSync(f.source)) problems.push(`packSkills: ${path.relative(root, f.source)} is not in this repository`)
    if (files.includes(f.rel)) problems.push(`files/${f.rel}: also a pack skill`)
  }

  // the recordings: each a recording of one of the scenarios, by its person
  const recordingsDir = path.join(dir, 'recordings')
  if (fs.existsSync(recordingsDir)) {
    for (const n of fs.readdirSync(recordingsDir).filter((x) => x.endsWith('.json')).sort()) {
      const s = c.scenarios.find((x) => `${x.slug}.json` === n)
      if (!s) { problems.push(`recordings/${n}: no scenario "${n.slice(0, -5)}" in company.json`); continue }
      let r: DemoRecording
      try { r = DemoRecording.parse(JSON.parse(fs.readFileSync(path.join(recordingsDir, n), 'utf8'))) } catch (e) {
        problems.push(`recordings/${n}: not a recording (${(e as { issues?: { message: string }[] }).issues?.[0]?.message ?? (e as Error).message})`); continue
      }
      if (r.username.toLowerCase() !== s.username.toLowerCase() || nfc(r.prompt) !== nfc(s.prompt) || r.kind !== s.kind || (s.kind === 'history' && r.daysAgo !== s.daysAgo)) {
        problems.push(`recordings/${n}: recorded as ${r.username}, ${r.kind}, "${r.prompt.slice(0, 40)}"; the scenario says ${s.username}, ${s.kind}, "${s.prompt.slice(0, 40)}" (record it again)`)
      }
    }
  }
  if (problems.length) fail(problems)

  const ownerName = c.owner.username
  const seed: DemoCompany = {
    teamName: c.teamName,
    people: [{ username: ownerName, name: c.owner.name, role: 'owner', group: null }, ...c.people.map((p) => ({ username: p.username, name: p.name, role: 'member' as const, group: p.group }))],
    groups: c.groups,
    rules: c.rules.map((r) => ({ path: r.path, rules: r.rules, why: r.why ?? r.rules.map((x) => `${'group' in x ? x.group : 'user' in x ? x.user : 'everyone'}: ${x.access}`).join(', ') })),
    filesDir,
    uploaderOf: (rel) => c.uploaders.find((u) => under(nfc(rel), nfc(u.path)))?.username ?? c.defaultUploader ?? ownerName,
    extraFiles: packFiles,
    ...(c.profile ? { profile: c.profile } : {}),
    ...(c.settings ? { settings: c.settings } : {}),
    memories: c.memories,
  }
  const content: DemoContent = {
    dir, company: c, seed, filesDir, recordingsDir,
    files: [...files, ...packFiles.map((f) => f.rel)],
    demoFile(d = {}) {
      const replays = d.replays === undefined ? recordingsDir : d.replays
      const recorded = (slug: string) => !!replays && fs.existsSync(path.join(replays, `${slug}.json`))
      return DemoFile.parse({
        company: c.teamName,
        password: DEMO_PASSWORD,
        ...(c.demo.sameQuestion ? { sameQuestion: c.demo.sameQuestion } : {}),
        ...(replays ? { replays } : {}),
        personas: personas.map((p) => ({
          ...p,
          questions: [...p.questions, ...c.scenarios.filter((s) => s.kind === 'showcase' && s.username.toLowerCase() === p.username.toLowerCase() && recorded(s.slug)).map((s) => s.prompt)],
        })),
      })
    },
  }
  return content
}

/** the demo person of a persona key (for the terminal's lines) */
export function personaOf(c: DemoContent, key: DemoPersonaKey): { username: string; name: string; group: string | null } | null {
  const p = c.company.demo.personas.find((x) => x.key === key)
  const who = p && c.company.people.find((x) => x.username.toLowerCase() === p.username.toLowerCase())
  return who ? { username: who.username, name: who.name, group: who.group } : null
}
