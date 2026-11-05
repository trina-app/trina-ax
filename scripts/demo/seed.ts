// Demo team for trying the product: `bun run demo:seed` while `bun run dev` is running.
//
//   owner  dion    (Dion)          admin  admin1 (관리자1)
//   member alice   (Alice, 마케팅)  member bob    (Bob, 재무)       password of all four: teamax-demo-1
//
// Groups 마케팅 and 재무 (each gets groups/<name>/ with write access for its members), extra folder rules
// (groups/재무/급여 hidden from the 재무 group, so only admin1 and dion see the payroll; projects/신제품-출시 written by
// 마케팅 and read by 재무), the project "신제품 출시", and the sample files in scripts/demo/files (Korean meeting notes,
// an xlsx, a docx, a PDF, a team rule in skills/). Everything goes through the public REST API, the same calls the
// admin screens make.
//
// `--company trina` seeds the fictional 15-person company "트리나" instead (scripts/demo/trina/company.ts; what is in
// it: scripts/demo/trina/README.md). `bun run demo:trina` starts a server for it and seeds it.
//
// It can run again: what already exists is kept (people, groups, rules, files with the same name, a saved company
// profile), so a second run only fills in what is missing. On a server that was set up with another owner it stops
// and says so.
//
//   bun run demo:seed [--company demo|trina] [--base http://localhost:19100] [--data <dir with setup-token>]
// The setup token is read from <data>/setup-token (default: $TEAM_AX_DEV_DIR/data or ~/.team-ax-dev/data), where
// the dev server writes it while no account exists.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API, ApiClient, ApiError, type CompanyProfileInput, type FolderRuleInput, type Group, type Locale, type TeamSettings, type User } from '../../shared/src/api'

export const DEMO_PASSWORD = 'teamax-demo-1'
export const DEMO_TEAM_NAME = '데모 팀'
export const DEMO_FILES = path.join(import.meta.dir, 'files')

export interface DemoPerson { username: string; name: string; role: 'owner' | 'admin' | 'member'; group: string | null }
type Level = 'none' | 'read' | 'write'
/** A folder rule of a demo company, by name: resolved to ids while seeding. */
export type DemoRule = { group: string; access: Level } | { user: string; access: Level } | { everyone: true; access: Level }
/** Everything one demo team is made of. The first person is the owner. */
export interface DemoCompany {
  teamName: string
  people: DemoPerson[]
  groups: { name: string; description: string }[]
  /** folder rules beyond the group folders (the folder is made with its rules when it is missing) */
  rules: { path: string; rules: DemoRule[]; why: string }[]
  /** sample files: <filesDir>/<team path> */
  filesDir: string
  /** who uploads a sample file (so the file history and the audit show different people) */
  uploaderOf(rel: string): string
  /** files from elsewhere in the repository: team path and source file (e.g. a skill pack's SKILL.md) */
  extraFiles?: { rel: string; source: string }[]
  project?: { name: string; folderPath: string; instructions: string }
  /** the company profile (회사 소개), saved by the owner as the admin screen does */
  profile?: CompanyProfileInput
  /** team settings the owner sets (Admin › 팀 설정) */
  settings?: Partial<TeamSettings>
}

export const DEMO_PEOPLE: DemoPerson[] = [
  { username: 'dion', name: 'Dion', role: 'owner', group: null },
  { username: 'admin1', name: '관리자1', role: 'admin', group: null },
  { username: 'alice', name: 'Alice', role: 'member', group: '마케팅' },
  { username: 'bob', name: 'Bob', role: 'member', group: '재무' },
]
export const DEMO_GROUPS = [
  { name: '마케팅', description: '캠페인, 광고, 홍보' },
  { name: '재무', description: '예산, 회계, 급여' },
]
/** The demo team of `bun run demo:seed` and `bun run demo`. */
export const DEMO_COMPANY: DemoCompany = {
  teamName: DEMO_TEAM_NAME,
  people: DEMO_PEOPLE,
  groups: DEMO_GROUPS,
  rules: [
    { path: 'groups/재무/급여', rules: [{ group: '재무', access: 'none' }], why: '재무 group: none (only admins and the owner see the payroll)' },
    { path: 'projects/신제품-출시', rules: [{ group: '마케팅', access: 'write' }, { group: '재무', access: 'read' }], why: '마케팅 write, 재무 read' },
  ],
  filesDir: DEMO_FILES,
  uploaderOf(rel) {
    if (rel.startsWith('groups/마케팅/') || rel.startsWith('shared/회의록/')) return 'alice'
    if (rel.startsWith('groups/재무/') && !rel.startsWith('groups/재무/급여/')) return 'bob'
    return 'dion'
  },
  project: {
    name: '신제품 출시',
    folderPath: 'projects/신제품-출시',
    instructions: '11월 24일 신제품 출시 준비 프로젝트입니다. 일정은 출시-일정.md를 기준으로 답하고, 바뀐 일정은 그 파일에 반영해 주세요.',
  },
}

export interface SeedOptions {
  baseUrl: string
  /** needed only while the server is not set up yet */
  setupToken: string | null
  fetch?: typeof fetch
  /** which team (default: the demo team, DEMO_COMPANY) */
  company?: DemoCompany
  /** sample files from this folder instead of the company's own (and none of its extra files) */
  filesDir?: string
  /** the owner's password (default: the public demo password; `bun run demo:trina` gives its owner a random one) */
  ownerPassword?: string
  locale?: Locale
  log?: (line: string) => void
}
export interface SeedResult {
  createdTeam: boolean
  people: { username: string; role: string; created: boolean }[]
  groups: string[]
  rules: string[]
  files: { path: string; uploaded: boolean; by: string }[]
  project: string | null
  /** the company profile was saved by this run */
  profile: boolean
}

export class SeedError extends Error {}

const conflict = (e: unknown) => e instanceof ApiError && (e.status === 409 || e.code === 'conflict')

export async function seedDemo(o: SeedOptions): Promise<SeedResult> {
  const log = o.log ?? (() => {})
  const co = o.company ?? DEMO_COMPANY
  const first = co.people[0]
  if (first?.role !== 'owner') throw new SeedError('the first person of a demo company must be its owner')
  const anon = new ApiClient({ baseUrl: o.baseUrl, fetch: o.fetch })
  const as = (token: string) => new ApiClient({ baseUrl: o.baseUrl, fetch: o.fetch, token })
  const login = async (username: string, password: string) => {
    const r = await anon.call(API.login, { body: { username, password, client: 'web', tokenMode: 'bearer' } })
    if (!r.token) throw new SeedError('the server did not return a bearer token')
    return { token: r.token, me: r.me }
  }
  const result: SeedResult = { createdTeam: false, people: [], groups: [], rules: [], files: [], project: co.project?.name ?? null, profile: false }
  const ownerPassword = o.ownerPassword ?? DEMO_PASSWORD

  // 1. the team and its owner
  const status = await anon.call(API.setupStatus)
  let ownerToken: string
  if (status.needed) {
    if (!o.setupToken) throw new SeedError('the team is not set up yet and no setup token was found (start `bun run dev` first: it writes <data>/setup-token)')
    await anon.call(API.setup, {
      body: { setupToken: o.setupToken, teamName: co.teamName, locale: o.locale ?? 'ko', owner: { username: first.username, name: first.name, password: ownerPassword } },
    })
    // setup signs the owner in with a cookie; sign in again for a bearer token the script can carry
    ownerToken = (await login(first.username, ownerPassword)).token
    result.createdTeam = true
    log(`team "${co.teamName}" created, owner ${first.username}`)
  } else {
    try {
      const r = await login(first.username, ownerPassword)
      if (r.me.user.role !== 'owner') throw new SeedError(`"${first.username}" exists but is not the owner of this team`)
      ownerToken = r.token
      log(`team already set up (owner ${first.username}); filling in what is missing`)
    } catch (e) {
      if (e instanceof SeedError) throw e
      throw new SeedError(`this server is already set up${status.teamName ? ` ("${status.teamName}")` : ''} and "${first.username}" cannot sign in with ${o.ownerPassword ? 'the owner password it was given' : 'the demo password'}: seed an empty data folder instead (stop the dev server, move its data folder aside, start it again)`)
    }
  }
  const owner = as(ownerToken)
  result.people.push({ username: first.username, role: 'owner', created: result.createdTeam })

  // 2. groups
  const groups = new Map<string, Group>((await owner.call(API.listGroups)).items.map((g) => [g.name, g]))
  for (const g of co.groups) {
    if (!groups.has(g.name)) {
      groups.set(g.name, await owner.call(API.createGroup, { body: { name: g.name, description: g.description, memberIds: [] } }))
      log(`group ${g.name} created`)
    }
    result.groups.push(g.name)
  }
  const groupId = (name: string) => {
    const g = groups.get(name)
    if (!g) throw new SeedError(`the demo company has no group "${name}"`)
    return g.id
  }

  // 3. people: created with a temporary password, which each person then changes to the demo password
  const users = new Map<string, Pick<User, 'id' | 'groupIds'>>((await owner.call(API.listUsers)).items.map((u) => [u.username, u]))
  const tokens = new Map<string, string>([[first.username, ownerToken]])
  for (const p of co.people.slice(1)) {
    if (p.role === 'owner') throw new SeedError(`a demo company has one owner (${first.username}), not also ${p.username}`)
    const groupIds = p.group ? [groupId(p.group)] : []
    const existing = users.get(p.username)
    if (!existing) {
      const made = await owner.call(API.createUser, { body: { username: p.username, name: p.name, role: p.role, groupIds, locale: o.locale ?? 'ko' } })
      const temp = await login(p.username, made.temporaryPassword)
      await as(temp.token).call(API.changePassword, { body: { currentPassword: made.temporaryPassword, newPassword: DEMO_PASSWORD } })
      tokens.set(p.username, temp.token)
      users.set(p.username, { id: made.user.id, groupIds })
      log(`${p.role} ${p.username} created`)
    } else {
      const missing = groupIds.filter((id) => !existing.groupIds.includes(id))
      if (missing.length) await owner.call(API.updateUser, { params: { id: existing.id }, body: { groupIds: [...existing.groupIds, ...missing] } })
      try { tokens.set(p.username, (await login(p.username, DEMO_PASSWORD)).token) } catch { log(`${p.username} exists with another password; their files are uploaded by ${first.username}`) }
    }
    result.people.push({ username: p.username, role: p.role, created: !existing })
  }
  const ruleOf = (r: DemoRule): FolderRuleInput => {
    if ('group' in r) return { subjectType: 'group', subjectId: groupId(r.group), access: r.access }
    if ('user' in r) {
      const u = users.get(r.user)
      if (!u) throw new SeedError(`the demo company has no person "${r.user}"`)
      return { subjectType: 'user', subjectId: u.id, access: r.access }
    }
    return { subjectType: 'everyone', subjectId: null, access: r.access }
  }

  // 4. folder rules beyond the group folders
  const folders = new Map((await owner.call(API.listFolders)).items.map((f) => [f.path, f]))
  for (const r of co.rules) {
    const f = folders.get(r.path)
    const rules = r.rules.map(ruleOf)
    if (!f) {
      const parent = path.posix.dirname(r.path)
      if (parent !== '.') await mkdirs(owner, parent)
      await owner.call(API.createFolder, { body: { path: r.path, create: true, rules } })
    } else if (!f.rules.length) await owner.call(API.putFolderRules, { params: { id: f.id }, body: { rules } })
    result.rules.push(`${r.path}: ${r.why}`)
  }

  // 5. sample files, then files taken from elsewhere in the repository (a skill pack's skills)
  const dir = o.filesDir ?? co.filesDir
  const files = [
    ...listFileEntries(dir).map((e) => ({ rel: e.rel, source: e.abs })),
    ...(o.filesDir ? [] : co.extraFiles ?? []),
  ]
  for (const { rel, source } of files) {
    const folder = path.posix.dirname(rel)
    const name = path.posix.basename(rel)
    let by = co.uploaderOf(rel)
    if (!tokens.has(by)) by = first.username
    const client = as(tokens.get(by)!)
    await mkdirs(owner, folder)
    const data = fs.readFileSync(source)
    try {
      await client.call(API.upload, { body: { fields: { folder, name, onExists: 'fail' }, file: new Blob([data]), filename: name } })
      result.files.push({ path: rel, uploaded: true, by })
      log(`uploaded ${rel} as ${by}`)
    } catch (e) {
      if (!conflict(e)) throw e
      result.files.push({ path: rel, uploaded: false, by })
    }
  }

  // 6. a project on its folder
  if (co.project) {
    const projects = (await owner.call(API.listProjects)).items
    if (!projects.some((p) => p.name === co.project!.name)) {
      await owner.call(API.createProject, { body: co.project })
      log(`project ${co.project.name} created`)
    }
  }

  // 7. the company profile, only while none is saved (the owner may have edited it since)
  if (co.profile && !(await owner.call(API.getCompanyProfile)).profile) {
    await owner.call(API.saveCompanyProfile, { body: co.profile })
    result.profile = true
    log('company profile saved')
  }

  // 8. team settings
  if (co.settings && Object.keys(co.settings).length) await owner.call(API.updateSettings, { body: co.settings })

  // sign the script's own sessions out again (people sign in themselves in the browser)
  for (const t of tokens.values()) await as(t).call(API.logout).catch(() => {})
  return result
}

/** Team-relative paths (NFC, "/" separated) of the files under dir, sorted. The on-disk names are kept for reading:
 * a checkout on macOS may hold NFD names. */
export function listFiles(dir: string): string[] {
  return listFileEntries(dir).map((e) => e.rel)
}
function listFileEntries(dir: string): { rel: string; abs: string }[] {
  const out: { rel: string; abs: string }[] = []
  const walk = (abs: string, rel: string) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      const r = rel ? `${rel}/${e.name.normalize('NFC')}` : e.name.normalize('NFC')
      if (e.isDirectory()) walk(path.join(abs, e.name), r)
      else if (e.isFile()) out.push({ rel: r, abs: path.join(abs, e.name) })
    }
  }
  walk(dir, '')
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

/** Create every missing folder of `folder` (the upload endpoint needs an existing target folder). */
async function mkdirs(client: ApiClient, folder: string) {
  const parts = folder.split('/')
  for (let i = 1; i <= parts.length; i++) {
    const p = parts.slice(0, i).join('/')
    try { await client.call(API.mkdir, { body: { path: p } }) } catch (e) { if (!conflict(e)) throw e }
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

if (import.meta.main) {
  const devHome = process.env.TEAM_AX_DEV_DIR ? path.resolve(process.env.TEAM_AX_DEV_DIR) : path.join(os.homedir(), '.team-ax-dev')
  const dataDir = arg('data') ?? process.env.MYCEL_DATA_DIR ?? path.join(devHome, 'data')
  const baseUrl = arg('base') ?? 'http://localhost:19100'
  const which = arg('company') ?? 'demo'
  let setupToken: string | null = null
  try { setupToken = fs.readFileSync(path.join(dataDir, 'setup-token'), 'utf8').trim() || null } catch {}
  try {
    if (which !== 'demo' && which !== 'trina') throw new SeedError(`--company ${which}: choose demo or trina`)
    const trina = which === 'trina' ? await import('./trina/company') : null
    // 트리나's owner is not a demo person: its password is random, kept in the dev folder (0600)
    const owner = trina ? trina.ensureOwnerPassword(devHome) : null
    if (owner?.created) console.log(`[demo] owner ${trina!.TRINA_OWNER}: password ${owner.password} (shown once; kept in ${owner.file})`)
    const r = await seedDemo({ baseUrl, setupToken, company: trina?.TRINA ?? DEMO_COMPANY, ownerPassword: owner?.password, log: (s) => console.log(`[demo] ${s}`) })
    console.log(`[demo] done: ${r.people.length} people, ${r.groups.length} groups, ${r.files.filter((f) => f.uploaded).length} files uploaded (${r.files.length} samples)${r.project ? `, project "${r.project}"` : ''}`)
    const people = r.people.filter((p) => !owner || p.role !== 'owner').map((p) => p.username)
    console.log(`[demo] sign in at ${baseUrl} as ${people.join(' / ')} with the password ${DEMO_PASSWORD}${owner ? ` (the owner's password is in ${owner.file})` : ''}`)
  } catch (e) {
    console.error(`[demo] ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
}
