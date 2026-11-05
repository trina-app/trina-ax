// `bun run demo:seed --company trina` / `bun run demo:trina` (scripts/demo/trina/): the fictional company "트리나". Seeds a
// real app (all route modules, temp team folder) and checks who can see what, the team skills, the company profile, a
// second run, and the starter's options and environment (docs/DECISIONS.md "Demo company: a new hire at 트리나").
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API, ApiClient, DemoFile } from '../../shared/src/api'
import { checkSkill } from '../../server/src/chat/skills'
import { DEMO_PASSWORD, listFiles, seedDemo } from '../../scripts/demo/seed'
import { copula, ensureOwnerPassword, SHOWCASE, TRINA, TRINA_CEO, TRINA_LEADS, TRINA_NEW_HIRE, TRINA_OWNER, trinaDemoFile } from '../../scripts/demo/trina/company'
import { SCENARIOS } from '../../scripts/demo/trina/scenarios'
import { demoEnv, lanAddresses, NETWORK_WARNING, options } from '../../scripts/demo/trina/start'
import { harness, SETUP_TOKEN, type Harness } from './a-lib'

let h: Harness
const BASE = 'http://team.localhost'
const appFetch = ((url: string | URL | Request, init?: RequestInit) =>
  h.app.fetch(new Request(url, init), { ip: '127.0.0.1', via: 'test' })) as typeof fetch

const OWNER_PASSWORD = 'a random owner password for tests 1'
async function as(username: string) {
  const password = username === TRINA_OWNER ? OWNER_PASSWORD : DEMO_PASSWORD
  const r = await new ApiClient({ baseUrl: BASE, fetch: appFetch }).call(API.login, { body: { username, password, client: 'web', tokenMode: 'bearer' } })
  return new ApiClient({ baseUrl: BASE, fetch: appFetch, token: r.token! })
}
/** can this person open the file (read its bytes)? */
async function opens(api: ApiClient, file: string): Promise<boolean> {
  try { await api.call(API.download, { query: { path: file, disposition: 'attachment' } }); return true } catch { return false }
}
const skillNames = async (api: ApiClient) => (await api.call(API.listSkills)).items.map((s) => s.name).sort()

const BUDGET = (team: string) => `shared/경영/팀별/${team}/2026-4분기-${team}-예산.xlsx`
const COMPANY_BUDGET = 'shared/경영/2026-4분기-예산-전사.xlsx'
const PAYROLL = 'groups/인사팀/급여표.xlsx'
const REVIEW = 'groups/인사팀/2026-상반기-평가.xlsx'
const LEAVE = 'shared/규정/복지-휴가-안내.md'
const MKT_NOTES = 'groups/마케팅팀/회의록/2026-11-03-마케팅-주간회의.md'

beforeAll(async () => { h = await harness('demo-trina') })
afterAll(async () => { await h.close() })

describe('트리나 seed', () => {
  test('the team, its owner account and 15 people, four groups, the rules, every file and the company profile', async () => {
    const r = await seedDemo({ baseUrl: BASE, setupToken: SETUP_TOKEN, fetch: appFetch, company: TRINA, ownerPassword: OWNER_PASSWORD })
    expect(r.createdTeam).toBe(true)
    expect(r.people.length).toBe(16)
    // the owner is an account of its own, never a demo person; nobody else is an owner or an admin
    expect(r.people.filter((p) => p.role !== 'member').map((p) => `${p.username}:${p.role}`)).toEqual([`${TRINA_OWNER}:owner`])
    expect(trinaDemoFile().personas.map((p) => p.username)).not.toContain(TRINA_OWNER)
    expect(r.groups).toEqual(['마케팅팀', '영업팀', '인사팀', '경영지원'])
    expect(r.files.length).toBe(listFiles(TRINA.filesDir).length + 2)
    expect(r.files.every((f) => f.uploaded)).toBe(true)
    expect(r.files.find((f) => f.path === PAYROLL)!.by).toBe(TRINA_LEADS.인사팀)
    expect(r.profile).toBe(true)
    const owner = await as(TRINA_OWNER)
    const me = await owner.call(API.me)
    expect(me.team.name).toBe('트리나')
    expect(me.user.role).toBe('owner')
    expect((await owner.call(API.getCompanyProfile)).profile?.name).toBe('트리나')
    // the CEO is a member: the public password reaches nothing an owner or admin could do
    const ceo = await as(TRINA_CEO)
    expect((await ceo.call(API.me)).user.role).toBe('member')
    await expect(ceo.call(API.listUsers)).rejects.toThrow()
    // the owner's password is not the public one
    await expect(new ApiClient({ baseUrl: BASE, fetch: appFetch }).call(API.login, { body: { username: TRINA_OWNER, password: DEMO_PASSWORD, client: 'web', tokenMode: 'bearer' } })).rejects.toThrow()
  }, 120_000)

  test('the new hire: the rules, the team folder and its notes; no budget, payroll or reviews', async () => {
    const jiwoo = await as(TRINA_NEW_HIRE)
    expect((await jiwoo.call(API.me)).groups.map((g) => g.name)).toEqual(['마케팅팀'])
    for (const f of [LEAVE, MKT_NOTES, 'shared/신입-온보딩-가이드.md', 'groups/마케팅팀/2026-11-캠페인-기획.md']) expect(await opens(jiwoo, f), f).toBe(true)
    for (const f of [COMPANY_BUDGET, BUDGET('마케팅팀'), PAYROLL, REVIEW, 'groups/영업팀/고객사-현황.xlsx']) expect(await opens(jiwoo, f), f).toBe(false)
  }, 60_000)

  test('budgets: each team lead opens only their own team sheet, the CEO all of them', async () => {
    for (const [team, lead] of Object.entries(TRINA_LEADS)) {
      const api = await as(lead)
      for (const other of Object.keys(TRINA_LEADS)) expect(await opens(api, BUDGET(other)), `${lead} ${other}`).toBe(other === team)
      expect(await opens(api, COMPANY_BUDGET), lead).toBe(false)
    }
    const ceo = await as(TRINA_CEO)
    for (const f of [COMPANY_BUDGET, ...Object.keys(TRINA_LEADS).map(BUDGET), PAYROLL, REVIEW]) expect(await opens(ceo, f), f).toBe(true)
  }, 60_000)

  test('payroll and reviews: 인사팀 and the CEO only (not the marketing lead)', async () => {
    expect(await opens(await as('eunbi'), PAYROLL)).toBe(true)
    expect(await opens(await as('seoyoon'), REVIEW)).toBe(true)
    expect(await opens(await as(TRINA_LEADS.마케팅팀), REVIEW)).toBe(false)
  }, 60_000)

  test('team skills: everyone gets the two general ones, 마케팅팀 and the CEO also the pack\'s two', async () => {
    const general = ['meeting-action-items', 'new-hire-first-week']
    expect(await skillNames(await as(TRINA_NEW_HIRE))).toEqual(['ad-copy', ...general, 'weekly-report'].sort())
    expect(await skillNames(await as('sungmin'))).toEqual(general)
    // the CEO reads the marketing skills too: what they say may be saved in the marketing folder without a wider-audience card
    expect(await skillNames(await as(TRINA_CEO))).toEqual(['ad-copy', ...general, 'weekly-report'].sort())
    // the team rule is a rule, not a skill, and it is there for everyone
    expect(await opens(await as('sungmin'), 'skills/사내-규정-답변.md')).toBe(true)
    for (const name of general) {
      const rel = `skills/${name}/SKILL.md`
      const parsed = checkSkill(fs.readFileSync(path.join(TRINA.filesDir, rel), 'utf8'), rel)
      expect(parsed.ok && parsed.title, rel).toBeTruthy()
    }
  }, 60_000)

  test('a second run only fills in what is missing', async () => {
    const r = await seedDemo({ baseUrl: BASE, setupToken: null, fetch: appFetch, company: TRINA, ownerPassword: OWNER_PASSWORD })
    expect(r.createdTeam).toBe(false)
    expect(r.people.every((p) => !p.created)).toBe(true)
    expect(r.files.every((f) => !f.uploaded)).toBe(true)
    expect(r.profile).toBe(false)
    expect((await (await as(TRINA_OWNER)).call(API.listUsers)).items.length).toBe(16)
    // without its owner password a second run stops (an older demo folder whose owner was the CEO, say)
    await expect(seedDemo({ baseUrl: BASE, setupToken: null, fetch: appFetch, company: TRINA })).rejects.toThrow(/cannot sign in/)
  }, 120_000)
})

describe('the demo file and the starter', () => {
  test('the demo file: three seeded people, the new hire\'s three questions, the same question for the others', () => {
    const d = DemoFile.parse(trinaDemoFile())
    expect(d.password).toBe(DEMO_PASSWORD)
    expect(d.personas.map((p) => p.key)).toEqual(['newHire', 'lead', 'ceo'])
    for (const p of d.personas) expect(TRINA.people.some((x) => x.username === p.username)).toBe(true)
    expect(d.personas[0]!.intro).toBe('오늘 트리나 마케팅팀에 입사한 한지우예요')
    expect(d.personas[0]!.questions).toEqual(['우리 회사 휴가 규정 알려줘', '이번 주 마케팅팀 회의록에서 내 할 일 정리해 줘', '신입 첫 주에 뭘 하면 돼?'])
    for (const p of d.personas.slice(1)) expect(p.questions[0]).toBe(d.sameQuestion!)
    expect(['서민재', '정해온', '한지우'].map(copula)).toEqual(['예요', '이에요', '예요'])
    expect(d.replays).toBeUndefined()
  })

  test('a showcase prompt is suggested only to the person whose recording of it is there', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trina-rec-'))
    try {
      fs.writeFileSync(path.join(dir, 'newhire-cardnews.json'), '{}')
      fs.writeFileSync(path.join(dir, 'lead-report.json'), '{}')
      const d = DemoFile.parse(trinaDemoFile({ replays: dir }))
      expect(d.replays).toBe(dir)
      expect(d.personas[0]!.questions).toEqual([...trinaDemoFile().personas[0]!.questions, SHOWCASE.cardNews])
      expect(d.personas[1]!.questions).toEqual([d.sameQuestion!, SHOWCASE.report])
      expect(d.personas[2]!.questions).toEqual(trinaDemoFile().personas[2]!.questions)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  test('every scenario is one demo person\'s, its showcase prompts are the suggested ones, slugs are unique', () => {
    const personas = new Set(trinaDemoFile().personas.map((p) => p.username))
    expect(new Set(SCENARIOS.map((s) => s.slug)).size).toBe(SCENARIOS.length)
    for (const s of SCENARIOS) {
      expect(personas.has(s.username), s.slug).toBe(true)
      if (s.kind === 'showcase') expect(Object.values(SHOWCASE) as string[]).toContain(s.prompt)
      else expect(s.daysAgo, s.slug).toBeGreaterThanOrEqual(0)
    }
  })

  test('the owner\'s password: random, kept in the demo folder for this Mac user only, the same on the next start', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trina-owner-'))
    try {
      const a = ensureOwnerPassword(home)
      expect(a.created).toBe(true)
      expect(a.password.length).toBeGreaterThanOrEqual(20)
      expect(a.password).not.toBe(DEMO_PASSWORD)
      expect(fs.statSync(a.file).mode & 0o777).toBe(0o600)
      const b = ensureOwnerPassword(home)
      expect(b).toEqual({ ...a, created: false })
      expect(ensureOwnerPassword(fs.mkdtempSync(path.join(os.tmpdir(), 'trina-owner-'))).password).not.toBe(a.password)
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('the start-up warning names every network, not only the Wi-Fi', () => {
    expect(NETWORK_WARNING).toContain("anyone on any network this Mac is on (Wi-Fi, VPN, Tailscale) can use this demo with this Mac's Claude login")
  })

  test('options: the default ports and folder, --local, refusals', () => {
    expect(options([], '/home/x')).toEqual({ port: 19830, relayPort: 19831, home: '/home/x/.trinademo', local: false, record: false })
    expect(options(['--port', '19900', '--relay-port', '19901', '--local'], '/home/x')).toMatchObject({ port: 19900, relayPort: 19901, local: true })
    expect(options(['--record'], '/home/x').record).toBe(true)
    for (const a of [['--port', '80'], ['--port', '19830', '--relay-port', '19830'], ['--port'], ['--what', '1']]) expect(() => options(a, '/home/x')).toThrow()
  })

  test('environment: the demo flag and LAN origins; nothing of another server\'s configuration', () => {
    const o = options([], '/home/x')
    const env = demoEnv(o, '/home/x/.trinademo/demo.json', ['192.168.0.12'], { PATH: '/bin', MYCEL_MODE: 'prod', MYCEL_CONFIG: '/etc/x.json', TEAM_AX_DEV_DIR: '/other', HOME: '/home/x' })
    expect(env.MYCEL_MODE).toBeUndefined()
    expect(env.MYCEL_CONFIG).toBeUndefined()
    expect(env).toMatchObject({ PATH: '/bin', HOME: '/home/x', TEAM_AX_DEV_DIR: '/home/x/.trinademo', TEAM_AX_DEV_PORT: '19830', TEAM_AX_DEV_RELAY_PORT: '19831', MYCEL_HOST: '0.0.0.0', MYCEL_DEMO: '/home/x/.trinademo/demo.json' })
    expect(env.MYCEL_PUBLIC_ORIGINS!.split(',')).toContain('http://192.168.0.12:19830')
    const local = demoEnv({ ...o, local: true }, 'f', ['192.168.0.12'], {})
    expect(local.MYCEL_HOST).toBe('127.0.0.1')
    expect(local.MYCEL_PUBLIC_ORIGINS).not.toContain('192.168.0.12')
  })

  test('LAN addresses: IPv4, not loopback or link-local, private ranges first', () => {
    const i = (address: string, internal = false) => ({ address, family: 'IPv4', internal, netmask: '', mac: '', cidr: null }) as never
    expect(lanAddresses({ lo0: [i('127.0.0.1', true)], en0: [i('100.64.1.2'), i('192.168.1.20')], en1: [i('169.254.3.4')], utun: [{ address: 'fe80::1', family: 'IPv6', internal: false } as never] })).toEqual(['192.168.1.20', '100.64.1.2'])
  })
})
