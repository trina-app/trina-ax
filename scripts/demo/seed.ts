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
// It can run again: what already exists is kept (people, groups, rules, files with the same name), so a second run
// only fills in what is missing. On a server that was set up with another owner it stops and says so.
//
//   bun run demo:seed [--base http://localhost:19100] [--data <dir with setup-token>]
// The setup token is read from <data>/setup-token (default: $TEAM_AX_DEV_DIR/data or ~/.team-ax-dev/data), where
// the dev server writes it while no account exists.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API, ApiClient, ApiError, type FolderRuleInput, type Group, type Locale } from '../../shared/src/api'

export const DEMO_PASSWORD = 'teamax-demo-1'
export const DEMO_TEAM_NAME = '데모 팀'
export const DEMO_FILES = path.join(import.meta.dir, 'files')

export interface DemoPerson { username: string; name: string; role: 'owner' | 'admin' | 'member'; group: string | null }
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
/** Who uploads which sample file (so the file history and the audit show different people). */
function uploaderOf(rel: string): string {
  if (rel.startsWith('groups/마케팅/') || rel.startsWith('shared/회의록/')) return 'alice'
  if (rel.startsWith('groups/재무/') && !rel.startsWith('groups/재무/급여/')) return 'bob'
  return 'dion'
}
const PROJECT = {
  name: '신제품 출시',
  folderPath: 'projects/신제품-출시',
  instructions: '11월 24일 신제품 출시 준비 프로젝트입니다. 일정은 출시-일정.md를 기준으로 답하고, 바뀐 일정은 그 파일에 반영해 주세요.',
}

export interface SeedOptions {
  baseUrl: string
  /** needed only while the server is not set up yet */
  setupToken: string | null
  fetch?: typeof fetch
  filesDir?: string
  locale?: Locale
  log?: (line: string) => void
}
export interface SeedResult {
  createdTeam: boolean
  people: { username: string; role: string; created: boolean }[]
  groups: string[]
  rules: string[]
  files: { path: string; uploaded: boolean; by: string }[]
  project: string
}

export class SeedError extends Error {}

const conflict = (e: unknown) => e instanceof ApiError && (e.status === 409 || e.code === 'conflict')

export async function seedDemo(o: SeedOptions): Promise<SeedResult> {
  const log = o.log ?? (() => {})
  const anon = new ApiClient({ baseUrl: o.baseUrl, fetch: o.fetch })
  const as = (token: string) => new ApiClient({ baseUrl: o.baseUrl, fetch: o.fetch, token })
  const login = async (username: string, password: string) => {
    const r = await anon.call(API.login, { body: { username, password, client: 'web', tokenMode: 'bearer' } })
    if (!r.token) throw new SeedError('the server did not return a bearer token')
    return { token: r.token, me: r.me }
  }
  const result: SeedResult = { createdTeam: false, people: [], groups: [], rules: [], files: [], project: PROJECT.name }

  // 1. the team and its owner
  const status = await anon.call(API.setupStatus)
  let ownerToken: string
  if (status.needed) {
    if (!o.setupToken) throw new SeedError('the team is not set up yet and no setup token was found (start `bun run dev` first: it writes <data>/setup-token)')
    await anon.call(API.setup, {
      body: { setupToken: o.setupToken, teamName: DEMO_TEAM_NAME, locale: o.locale ?? 'ko', owner: { username: 'dion', name: 'Dion', password: DEMO_PASSWORD } },
    })
    // setup signs the owner in with a cookie; sign in again for a bearer token the script can carry
    ownerToken = (await login('dion', DEMO_PASSWORD)).token
    result.createdTeam = true
    log(`team "${DEMO_TEAM_NAME}" created, owner dion`)
  } else {
    try {
      const r = await login('dion', DEMO_PASSWORD)
      if (r.me.user.role !== 'owner') throw new SeedError('"dion" exists but is not the owner of this team')
      ownerToken = r.token
      log(`team "${status.teamName}" already set up; filling in what is missing`)
    } catch (e) {
      if (e instanceof SeedError) throw e
      throw new SeedError(`this server is already set up ("${status.teamName}") and "dion" cannot sign in with the demo password: seed an empty data folder instead (stop the dev server, move ~/.team-ax-dev aside, start it again)`)
    }
  }
  const owner = as(ownerToken)
  result.people.push({ username: 'dion', role: 'owner', created: result.createdTeam })

  // 2. groups
  const groups = new Map<string, Group>((await owner.call(API.listGroups)).items.map((g) => [g.name, g]))
  for (const g of DEMO_GROUPS) {
    if (!groups.has(g.name)) {
      groups.set(g.name, await owner.call(API.createGroup, { body: { name: g.name, description: g.description, memberIds: [] } }))
      log(`group ${g.name} created`)
    }
    result.groups.push(g.name)
  }
  const groupId = (name: string) => groups.get(name)!.id

  // 3. people: created with a temporary password, which each person then changes to the demo password
  const users = new Map((await owner.call(API.listUsers)).items.map((u) => [u.username, u]))
  const tokens = new Map<string, string>([['dion', ownerToken]])
  for (const p of DEMO_PEOPLE.filter((x) => x.role !== 'owner')) {
    const groupIds = p.group ? [groupId(p.group)] : []
    const existing = users.get(p.username)
    if (!existing) {
      const made = await owner.call(API.createUser, { body: { username: p.username, name: p.name, role: p.role as 'admin' | 'member', groupIds, locale: o.locale ?? 'ko' } })
      const first = await login(p.username, made.temporaryPassword)
      await as(first.token).call(API.changePassword, { body: { currentPassword: made.temporaryPassword, newPassword: DEMO_PASSWORD } })
      tokens.set(p.username, first.token)
      log(`${p.role} ${p.username} created`)
    } else {
      const missing = groupIds.filter((id) => !existing.groupIds.includes(id))
      if (missing.length) await owner.call(API.updateUser, { params: { id: existing.id }, body: { groupIds: [...existing.groupIds, ...missing] } })
      try { tokens.set(p.username, (await login(p.username, DEMO_PASSWORD)).token) } catch { log(`${p.username} exists with another password; their files are uploaded by dion`) }
    }
    result.people.push({ username: p.username, role: p.role, created: !existing })
  }

  // 4. folder rules beyond the group folders
  const RULES: { path: string; rules: FolderRuleInput[]; why: string }[] = [
    { path: 'groups/재무/급여', rules: [{ subjectType: 'group', subjectId: groupId('재무'), access: 'none' }], why: '재무 group: none (only admins and the owner see the payroll)' },
    {
      path: PROJECT.folderPath,
      rules: [{ subjectType: 'group', subjectId: groupId('마케팅'), access: 'write' }, { subjectType: 'group', subjectId: groupId('재무'), access: 'read' }],
      why: '마케팅 write, 재무 read',
    },
  ]
  const folders = new Map((await owner.call(API.listFolders)).items.map((f) => [f.path, f]))
  for (const r of RULES) {
    const f = folders.get(r.path)
    if (!f) await owner.call(API.createFolder, { body: { path: r.path, create: true, rules: r.rules } })
    else if (!f.rules.length) await owner.call(API.putFolderRules, { params: { id: f.id }, body: { rules: r.rules } })
    result.rules.push(`${r.path}: ${r.why}`)
  }

  // 5. sample files
  const dir = o.filesDir ?? DEMO_FILES
  for (const rel of listFiles(dir)) {
    const folder = path.posix.dirname(rel)
    const name = path.posix.basename(rel)
    let by = uploaderOf(rel)
    if (!tokens.has(by)) by = 'dion'
    const client = as(tokens.get(by)!)
    await mkdirs(owner, folder)
    const data = fs.readFileSync(path.join(dir, ...rel.split('/').map((s) => s.normalize('NFC'))))
    try {
      await client.call(API.upload, { body: { fields: { folder, name, onExists: 'fail' }, file: new Blob([data]), filename: name } })
      result.files.push({ path: rel, uploaded: true, by })
      log(`uploaded ${rel} as ${by}`)
    } catch (e) {
      if (!conflict(e)) throw e
      result.files.push({ path: rel, uploaded: false, by })
    }
  }

  // 6. a project on the launch folder
  const projects = (await owner.call(API.listProjects)).items
  if (!projects.some((p) => p.name === PROJECT.name)) {
    await owner.call(API.createProject, { body: PROJECT })
    log(`project ${PROJECT.name} created`)
  }

  // sign the script's own sessions out again (people sign in themselves in the browser)
  for (const t of tokens.values()) await as(t).call(API.logout).catch(() => {})
  return result
}

/** Team-relative paths (NFC, "/" separated) of the files under dir, sorted. */
export function listFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (abs: string, rel: string) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      const r = rel ? `${rel}/${e.name.normalize('NFC')}` : e.name.normalize('NFC')
      if (e.isDirectory()) walk(path.join(abs, e.name), r)
      else if (e.isFile()) out.push(r)
    }
  }
  walk(dir, '')
  return out.sort()
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
  let setupToken: string | null = null
  try { setupToken = fs.readFileSync(path.join(dataDir, 'setup-token'), 'utf8').trim() || null } catch {}
  try {
    const r = await seedDemo({ baseUrl, setupToken, log: (s) => console.log(`[demo] ${s}`) })
    console.log(`[demo] done: ${r.people.length} people, ${r.groups.length} groups, ${r.files.filter((f) => f.uploaded).length} files uploaded (${r.files.length} samples), project "${r.project}"`)
    console.log(`[demo] sign in at ${baseUrl} as dion / admin1 / alice / bob with the password ${DEMO_PASSWORD}`)
  } catch (e) {
    console.error(`[demo] ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
}
