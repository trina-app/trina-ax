// `bun run demo:company` / `bun run demo:seed --content <dir>` (scripts/demo/company/): a fictional company from a demo
// content folder (scripts/demo/company/README.md; docs/DECISIONS.md "Demo content: the mechanism is open, a company's
// content is a folder"). Seeds a real app (all route modules, temp team folder) from the open example, Acme, and checks
// what the content promises (company.json `checks`: who opens which file, who sees which team skills), the owner
// account, a second run, the demo file, the format's refusals, and the starter's options and environment.
//
// MYCEL_DEMO_CONTENT=<dir> runs the same seed checks on that content too (a company's private content, say).
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API, ApiClient, DemoFile } from '../../shared/src/api'
import { checkSkill } from '../../server/src/chat/skills'
import { DEMO_PASSWORD, ensureOwnerPassword, seedDemo } from '../../scripts/demo/seed'
import { CONTENT_ENV, contentDir, DEFAULT_CONTENT, loadContent, type DemoContent } from '../../scripts/demo/company/content'
import { dataHome, demoEnv, lanAddresses, NETWORK_WARNING, options, PRIVATE_CONTENT, resolveContent } from '../../scripts/demo/company/start'
import { harness, SETUP_TOKEN, type Harness } from './a-lib'

const OWNER_PASSWORD = 'a random owner password for tests 1'
const BASE = 'http://team.localhost'
const CONTENTS = [DEFAULT_CONTENT, ...(process.env[CONTENT_ENV] ? [path.resolve(process.env[CONTENT_ENV]!)] : [])]

/** can this person open the file (read its bytes)? */
async function opens(api: ApiClient, file: string): Promise<boolean> {
  try { await api.call(API.download, { query: { path: file, disposition: 'attachment' } }); return true } catch { return false }
}
const skillNames = async (api: ApiClient) => (await api.call(API.listSkills)).items.map((s) => s.name).sort()

for (const dir of CONTENTS) {
  describe(`seeding the demo content ${path.basename(dir)}`, () => {
    let h: Harness
    let c: DemoContent
    const appFetch = ((url: string | URL | Request, init?: RequestInit) => h.app.fetch(new Request(url, init), { ip: '127.0.0.1', via: 'test' })) as typeof fetch
    const as = async (username: string) => {
      const password = username === c.company.owner.username ? OWNER_PASSWORD : DEMO_PASSWORD
      const r = await new ApiClient({ baseUrl: BASE, fetch: appFetch }).call(API.login, { body: { username, password, client: 'web', tokenMode: 'bearer' } })
      return new ApiClient({ baseUrl: BASE, fetch: appFetch, token: r.token! })
    }
    afterAll(async () => { await h?.close() })

    test('the team, its owner account and its people, the groups, every file, the profile and the memories', async () => {
      c = loadContent(dir)
      h = await harness(`demo-content-${c.company.id}`)
      const r = await seedDemo({ baseUrl: BASE, setupToken: SETUP_TOKEN, fetch: appFetch, company: c.seed, ownerPassword: OWNER_PASSWORD, locale: c.company.locale })
      expect(r.createdTeam).toBe(true)
      expect(r.people.length).toBe(c.company.people.length + 1)
      // the owner is an account of its own, never a demo person; nobody else is an owner or an admin
      expect(r.people.filter((p) => p.role !== 'member').map((p) => `${p.username}:${p.role}`)).toEqual([`${c.company.owner.username}:owner`])
      expect(c.demoFile().personas.map((p) => p.username)).not.toContain(c.company.owner.username)
      expect(r.groups).toEqual(c.company.groups.map((g) => g.name))
      expect(r.files.map((f) => f.path).sort()).toEqual([...c.files].sort())
      expect(r.files.every((f) => f.uploaded)).toBe(true)
      for (const f of r.files) expect(f.by, f.path).toBe(c.seed.uploaderOf(f.path))
      expect(r.profile).toBe(!!c.company.profile)
      const owner = await as(c.company.owner.username)
      const me = await owner.call(API.me)
      expect([me.team.name, me.user.role]).toEqual([c.company.teamName, 'owner'])
      if (c.company.profile) expect((await owner.call(API.getCompanyProfile)).profile?.oneLine).toBe(c.company.profile.oneLine)
      for (const m of c.company.memories) expect((await (await as(m.username)).call(API.listMemories, { query: { limit: 20 } })).items.map((x) => x.text)).toContain(m.text)
      // every demo person is a member: the public password reaches nothing an owner or admin could do
      for (const p of c.company.demo.personas) {
        const api = await as(p.username)
        expect((await api.call(API.me)).user.role, p.username).toBe('member')
        await expect(api.call(API.listUsers)).rejects.toThrow()
      }
      // the owner's password is not the public one
      await expect(new ApiClient({ baseUrl: BASE, fetch: appFetch }).call(API.login, { body: { username: c.company.owner.username, password: DEMO_PASSWORD, client: 'web', tokenMode: 'bearer' } })).rejects.toThrow()
    }, 180_000)

    test('what the content promises: who opens which file, who sees which team skills', async () => {
      expect(c.company.checks.length).toBeGreaterThan(0)
      for (const k of c.company.checks) {
        const api = await as(k.username)
        for (const f of k.opens) expect(await opens(api, f), `${k.username} opens ${f}`).toBe(true)
        for (const f of k.closed) expect(await opens(api, f), `${k.username} must not open ${f}`).toBe(false)
        if (k.skills) expect(await skillNames(api), k.username).toEqual([...k.skills].sort())
      }
    }, 120_000)

    test('the team skills in the files are skills', () => {
      for (const rel of c.files.filter((f) => /^skills\/.+\/SKILL\.md$/.test(f) && !f.startsWith('skills/work/'))) {
        const parsed = checkSkill(fs.readFileSync(path.join(c.filesDir, rel), 'utf8'), rel)
        expect(parsed.ok && parsed.title, rel).toBeTruthy()
      }
    })

    test('a second run only fills in what is missing; without its owner password it stops', async () => {
      const r = await seedDemo({ baseUrl: BASE, setupToken: null, fetch: appFetch, company: c.seed, ownerPassword: OWNER_PASSWORD, locale: c.company.locale })
      expect(r.createdTeam).toBe(false)
      expect(r.people.every((p) => !p.created)).toBe(true)
      expect(r.files.every((f) => !f.uploaded)).toBe(true)
      expect(r.profile).toBe(false)
      for (const m of c.company.memories) expect((await (await as(m.username)).call(API.listMemories, { query: { limit: 20 } })).items.filter((x) => x.text === m.text).length).toBe(1)
      expect((await (await as(c.company.owner.username)).call(API.listUsers)).items.length).toBe(c.company.people.length + 1)
      await expect(seedDemo({ baseUrl: BASE, setupToken: null, fetch: appFetch, company: c.seed })).rejects.toThrow(/cannot sign in/)
    }, 120_000)

    test('the demo file: the personas, the same question first for the lead and the CEO, a showcase prompt once recorded', () => {
      const d = DemoFile.parse(c.demoFile({ replays: null }))
      expect(d.password).toBe(DEMO_PASSWORD)
      expect(d.company).toBe(c.company.teamName)
      expect(d.replays).toBeUndefined()
      expect(d.personas.map((p) => p.questions)).toEqual(c.company.demo.personas.map((p) => p.questions))
      for (const p of d.personas.filter((x) => x.key !== 'newHire')) if (d.sameQuestion) expect(p.questions[0]).toBe(d.sameQuestion)
      const withReplays = c.demoFile()
      expect(withReplays.replays).toBe(c.recordingsDir)
      for (const p of withReplays.personas) {
        const shown = c.company.scenarios.filter((s) => s.kind === 'showcase' && s.username === p.username && fs.existsSync(path.join(c.recordingsDir, `${s.slug}.json`)))
        expect(p.questions).toEqual([...c.company.demo.personas.find((x) => x.key === p.key)!.questions, ...shown.map((s) => s.prompt)])
      }
    })
  })
}

describe('the open example, Acme', () => {
  const c = loadContent(DEFAULT_CONTENT)
  test('is small, plain English, every person and file fictional, and the default', () => {
    expect(contentDir(null, {})).toBe(DEFAULT_CONTENT)
    expect(c.company.locale).toBe('en')
    expect(c.company.people.length).toBeLessThanOrEqual(8)
    expect(c.company.groups.map((g) => g.name)).toEqual(['Marketing', 'Sales'])
    expect(c.company.demo.personas.map((p) => p.key)).toEqual(['newHire', 'lead', 'ceo'])
    // one restricted folder: the same question gives the CEO, the lead and the new hire different answers
    expect(c.company.demo.sameQuestion).toBe("Summarize this quarter's budget")
    // no brand of this product's editions in the open example
    const all = [JSON.stringify(c.company), ...c.files.filter((f) => f.endsWith('.md') && !f.startsWith('skills/work/')).map((f) => fs.readFileSync(path.join(c.filesDir, f), 'utf8')),
      ...fs.readdirSync(c.recordingsDir).map((n) => fs.readFileSync(path.join(c.recordingsDir, n), 'utf8'))].join('\n')
    expect(all).not.toMatch(/트리나|trina/i)
    expect(c.files.filter((f) => /\.(png|jpe?g|gif|webp|pptx)$/i.test(f))).toEqual([])
  })
})

describe('the format refuses a content folder that does not hold together', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-content-'))
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const base = JSON.parse(fs.readFileSync(path.join(DEFAULT_CONTENT, 'company.json'), 'utf8'))
  let n = 0
  /** a copy of Acme with company.json changed (and files/recordings as given) */
  const variant = (change: (j: any) => void, o: { files?: Record<string, string>; recordings?: Record<string, unknown> } = {}) => {
    const dir = path.join(tmp, `v${++n}`)
    fs.cpSync(path.join(DEFAULT_CONTENT, 'files'), path.join(dir, 'files'), { recursive: true })
    for (const [rel, text] of Object.entries(o.files ?? {})) { fs.mkdirSync(path.dirname(path.join(dir, 'files', rel)), { recursive: true }); fs.writeFileSync(path.join(dir, 'files', rel), text) }
    if (o.recordings) {
      fs.mkdirSync(path.join(dir, 'recordings'))
      for (const [name, r] of Object.entries(o.recordings)) fs.writeFileSync(path.join(dir, 'recordings', name), JSON.stringify(r))
    }
    const j = structuredClone(base)
    change(j)
    fs.writeFileSync(path.join(dir, 'company.json'), JSON.stringify(j))
    return dir
  }
  const problems = (dir: string) => { try { loadContent(dir); return '' } catch (e) { return (e as Error).message } }

  test('a copy loads; a missing folder or company.json, an unknown field, another format do not', () => {
    expect(problems(variant(() => {}))).toBe('')
    expect(problems(path.join(tmp, 'nothing'))).toMatch(/there is no folder/)
    const empty = path.join(tmp, 'empty'); fs.mkdirSync(empty)
    expect(problems(empty)).toMatch(/company\.json cannot be read/)
    expect(problems(variant((j) => { j.extra = 1 }))).toMatch(/company\.json/)
    expect(problems(variant((j) => { j.format = 2 }))).toMatch(/format/)
  })

  test('every name it uses must be one of its people, groups or demo people', () => {
    expect(problems(variant((j) => { j.people[0].group = 'Finance' }))).toContain('dana: no group "Finance"')
    expect(problems(variant((j) => { j.rules[0].rules[0].user = 'nobody' }))).toContain('rule groups: no person "nobody"')
    expect(problems(variant((j) => { j.rules[0].rules[0] = { group: 'Finance', access: 'read' } }))).toContain('no group "Finance"')
    expect(problems(variant((j) => { j.uploaders[0].username = 'nobody' }))).toContain('no account "nobody"')
    expect(problems(variant((j) => { j.memories = [{ username: 'nobody', text: 'x' }] }))).toContain('memories: no person "nobody"')
    expect(problems(variant((j) => { j.people.push({ username: 'Sam', name: 'Twice', group: null }) }))).toContain('is there twice')
    expect(problems(variant((j) => { j.scenarios[0].username = 'leo' }))).toContain('"leo" is not a demo persona')
    expect(problems(variant((j) => { delete j.scenarios[2].daysAgo }))).toContain('needs daysAgo')
    expect(problems(variant((j) => { j.scenarios.push({ ...j.scenarios[0] }) }))).toContain('is there twice')
  })

  test('the owner can never be a demo person, a person never the owner or an admin', () => {
    expect(problems(variant((j) => { j.demo.personas[0].username = 'acme-admin' }))).toContain('the owner can never be a demo person')
    expect(problems(variant((j) => { j.people[0].role = 'admin' }))).toMatch(/company\.json people\.0/)
    expect(problems(variant((j) => { j.demo.personas[1].username = j.demo.personas[0].username }))).toContain('each person once')
  })

  test('files only at team paths the seed can upload to; pack skills that exist', () => {
    expect(problems(variant(() => {}, { files: { 'users/alex/x.md': 'x' } }))).toContain('files/users/alex/x.md: sample files go under')
    expect(problems(variant(() => {}, { files: { 'groups/Finance/x.md': 'x' } }))).toContain('no group "Finance"')
    expect(problems(variant((j) => { j.packSkills[0].skills.push('no-such-skill') }))).toContain('resources/skill-packs/work/en/no-such-skill/SKILL.md is not in this repository')
    expect(problems(variant((j) => { j.settings.answerStepLimit = 3 }))).toMatch(/settings/)
    expect(problems(variant((j) => { j.rules[0].path = '../outside' }))).toMatch(/a team path/)
  })

  test('recordings: each one of a scenario, by its person, with its prompt', () => {
    const rec = JSON.parse(fs.readFileSync(path.join(DEFAULT_CONTENT, 'recordings', 'lead-tasks.json'), 'utf8'))
    expect(problems(variant(() => {}, { recordings: { 'lead-tasks.json': rec } }))).toBe('')
    expect(problems(variant(() => {}, { recordings: { 'other.json': rec } }))).toContain('recordings/other.json: no scenario "other"')
    expect(problems(variant(() => {}, { recordings: { 'lead-tasks.json': { ...rec, prompt: 'something else' } } }))).toContain('(record it again)')
    expect(problems(variant(() => {}, { recordings: { 'lead-tasks.json': { ...rec, events: [] } } }))).toContain('recordings/lead-tasks.json: not a recording')
    expect(problems(variant((j) => { j.demo.personas[1].questions = ['a', 'b', 'c', 'd', 'e', 'f'] }))).toContain('at most 6')
  })
})

describe('the starter', () => {
  test('options: the default ports, --content, --local, --record, refusals', () => {
    expect(options([])).toEqual({ port: 19830, relayPort: 19831, data: null, content: null, requireContent: null, local: false, record: false })
    expect(options(['--port', '19900', '--relay-port', '19901', '--local', '--content', 'x', '--data', '/d'])).toMatchObject({ port: 19900, relayPort: 19901, local: true, content: 'x', data: '/d' })
    expect(options(['--record']).record).toBe(true)
    for (const a of [['--port', '80'], ['--port', '19830', '--relay-port', '19830'], ['--port'], ['--content'], ['--what', '1']]) expect(() => options(a)).toThrow()
  })

  test('the content: --content, else MYCEL_DEMO_CONTENT, else Acme; the data folder follows the content', () => {
    expect(resolveContent(options([]), {})).toBe(DEFAULT_CONTENT)
    expect(resolveContent(options([]), { [CONTENT_ENV]: '/env/content' })).toBe('/env/content')
    expect(resolveContent(options(['--content', '/flag/content']), { [CONTENT_ENV]: '/env/content' })).toBe('/flag/content')
    const acme = loadContent(DEFAULT_CONTENT)
    expect(dataHome(options([]), acme, '/home/x')).toBe('/home/x/.acmedemo')
    expect(dataHome(options(['--data', '/d']), acme, '/home/x')).toBe('/d')
  })

  test('`bun run demo:trina` needs its content and says where it is (not in this repository)', () => {
    const o = options(['--require-content', 'trina'])
    expect(() => resolveContent(o, {})).toThrow(PRIVATE_CONTENT.trina!)
    expect(PRIVATE_CONTENT.trina).toContain('trina-ax-core')
    expect(PRIVATE_CONTENT.trina).toContain('editions/trina/demo')
    expect(resolveContent(o, { [CONTENT_ENV]: '/private/demo' })).toBe('/private/demo')
    expect(resolveContent(options(['--require-content', 'trina', '--content', '/c']), {})).toBe('/c')
    expect(() => resolveContent(options(['--require-content', 'other']), {})).toThrow(/needs its content/)
    expect(JSON.parse(fs.readFileSync(path.join(import.meta.dir, '..', '..', 'package.json'), 'utf8')).scripts['demo:trina']).toContain('--require-content trina')
  })

  test('the owner\'s password: random, kept in the demo folder for this Mac user only, the same on the next start', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-owner-'))
    try {
      const a = ensureOwnerPassword(home)
      expect(a.created).toBe(true)
      expect(a.password.length).toBeGreaterThanOrEqual(20)
      expect(a.password).not.toBe(DEMO_PASSWORD)
      expect(fs.statSync(a.file).mode & 0o777).toBe(0o600)
      expect(ensureOwnerPassword(home)).toEqual({ ...a, created: false })
      expect(ensureOwnerPassword(fs.mkdtempSync(path.join(os.tmpdir(), 'demo-owner-'))).password).not.toBe(a.password)
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('the start-up warning names every network, not only the Wi-Fi', () => {
    expect(NETWORK_WARNING).toContain("anyone on any network this Mac is on (Wi-Fi, VPN, Tailscale) can use this demo with this Mac's Claude login")
  })

  test('environment: the demo flag and LAN origins; nothing of another server\'s configuration, not even the content variable', () => {
    const o = { ...options([]), home: '/home/x/.acmedemo', id: 'acme' }
    const env = demoEnv(o, '/home/x/.acmedemo/demo.json', ['192.168.0.12'], { PATH: '/bin', MYCEL_MODE: 'prod', MYCEL_CONFIG: '/etc/x.json', [CONTENT_ENV]: '/c', TEAM_AX_DEV_DIR: '/other', HOME: '/home/x' })
    for (const k of ['MYCEL_MODE', 'MYCEL_CONFIG', CONTENT_ENV]) expect(env[k]).toBeUndefined()
    expect(env).toMatchObject({ PATH: '/bin', HOME: '/home/x', TEAM_AX_DEV_DIR: '/home/x/.acmedemo', TEAM_AX_DEV_PORT: '19830', TEAM_AX_DEV_RELAY_PORT: '19831', MYCEL_HOST: '0.0.0.0', MYCEL_DEMO: '/home/x/.acmedemo/demo.json' })
    expect(env.MYCEL_PUBLIC_ORIGINS!.split(',')).toEqual(['http://localhost:19830', 'http://127.0.0.1:19830', 'http://acme.localhost:19831', 'http://192.168.0.12:19830'])
    const local = demoEnv({ ...o, local: true }, 'f', ['192.168.0.12'], {})
    expect(local.MYCEL_HOST).toBe('127.0.0.1')
    expect(local.MYCEL_PUBLIC_ORIGINS).not.toContain('192.168.0.12')
  })

  test('LAN addresses: IPv4, not loopback or link-local, private ranges first', () => {
    const i = (address: string, internal = false) => ({ address, family: 'IPv4', internal, netmask: '', mac: '', cidr: null }) as never
    expect(lanAddresses({ lo0: [i('127.0.0.1', true)], en0: [i('100.64.1.2'), i('192.168.1.20')], en1: [i('169.254.3.4')], utun: [{ address: 'fe80::1', family: 'IPv6', internal: false } as never] })).toEqual(['192.168.1.20', '100.64.1.2'])
  })
})
