// `bun run demo:seed` (scripts/demo/seed.ts): the demo team the owner tries the product with. Runs the seeder
// against a real app (all route modules, temp team folder) and checks what each demo person can then see.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { API, ApiClient } from '../../shared/src/api'
import { DEMO_FILES, DEMO_PASSWORD, listFiles, seedDemo, SeedError } from '../../scripts/demo/seed'
import { harness, SETUP_TOKEN, type Harness } from './a-lib'

let h: Harness
const BASE = 'http://team.localhost'
const appFetch = ((url: string | URL | Request, init?: RequestInit) =>
  h.app.fetch(new Request(url, init), { ip: '127.0.0.1', via: 'test' })) as typeof fetch

async function signIn(username: string, password = DEMO_PASSWORD) {
  const r = await new ApiClient({ baseUrl: BASE, fetch: appFetch }).call(API.login, { body: { username, password, client: 'web', tokenMode: 'bearer' } })
  return { me: r.me, api: new ApiClient({ baseUrl: BASE, fetch: appFetch, token: r.token! }) }
}
async function canSee(api: ApiClient, folder: string, name: string): Promise<'none' | 'read' | 'write'> {
  try {
    const t = await api.call(API.tree, { query: { path: folder } })
    const e = t.entries.find((x) => x.name.normalize('NFC') === name)
    return e ? (e.access === 'none' ? 'none' : t.access === 'none' ? 'read' : t.access) : 'none'
  } catch { return 'none' }
}

beforeAll(async () => { h = await harness('demo-seed') })
afterAll(async () => { await h.close() })

describe('demo seed', () => {
  test('sets up the team, the four people, groups, rules, files and the project', async () => {
    const lines: string[] = []
    const r = await seedDemo({ baseUrl: BASE, setupToken: SETUP_TOKEN, fetch: appFetch, log: (s) => lines.push(s) })
    expect(r.createdTeam).toBe(true)
    expect(r.people.map((p) => `${p.username}:${p.role}`)).toEqual(['dion:owner', 'admin1:admin', 'alice:member', 'bob:member'])
    expect(r.files.length).toBe(listFiles(DEMO_FILES).length)
    expect(r.files.every((f) => f.uploaded)).toBe(true)
    expect(r.files.find((f) => f.path.startsWith('groups/재무/2026'))!.by).toBe('bob')
    expect(r.files.find((f) => f.path.startsWith('groups/마케팅/'))!.by).toBe('alice')
    expect(lines.some((l) => l.includes('created'))).toBe(true)
  }, 60_000)

  test('every demo person signs in with the demo password, without a forced password change', async () => {
    for (const u of ['dion', 'admin1', 'alice', 'bob']) {
      const { me } = await signIn(u)
      expect(me.user.mustChangePassword).toBe(false)
      expect(me.team.name).toBe('데모 팀')
    }
    const alice = await signIn('alice')
    expect(alice.me.groups.map((g) => g.name)).toEqual(['마케팅'])
  }, 60_000)

  test('folder rules: each person sees only their part of the team folder', async () => {
    const alice = (await signIn('alice')).api
    const bob = (await signIn('bob')).api
    const admin = (await signIn('admin1')).api
    // group folders
    expect(await canSee(alice, 'groups/마케팅', '2026-10-14-마케팅-회의록.md')).toBe('write')
    expect(await canSee(alice, 'groups/재무', '2026-4분기-예산.xlsx')).toBe('none')
    expect(await canSee(bob, 'groups/재무', '2026-4분기-예산.xlsx')).toBe('write')
    // payroll: hidden from the 재무 group, visible to the admin
    expect(await canSee(bob, 'groups/재무/급여', '2026-10-급여대장.xlsx')).toBe('none')
    expect(await canSee(admin, 'groups/재무/급여', '2026-10-급여대장.xlsx')).toBe('write')
    // project folder: 마케팅 writes, 재무 reads
    expect(await canSee(alice, 'projects/신제품-출시', '출시-일정.md')).toBe('write')
    expect(await canSee(bob, 'projects/신제품-출시', '출시-일정.md')).toBe('read')
    // shared files and the PDF are there for everyone
    expect(await canSee(bob, 'shared', '회사소개서.pdf')).toBe('write')
    const pdf = await bob.call(API.download, { query: { path: 'shared/회사소개서.pdf', disposition: 'inline' } })
    expect(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 5))).toBe('%PDF-')
    const notes = await alice.call(API.content, { query: { path: 'shared/회의록/2026-10-20-주간-전체회의.md' } })
    expect(notes.content).toContain('주간 전체회의')
    // the project is listed for both (bob can read its folder)
    expect((await bob.call(API.listProjects)).items.map((p) => p.name)).toContain('신제품 출시')
  }, 60_000)

  test('a second run only fills in what is missing', async () => {
    const r = await seedDemo({ baseUrl: BASE, setupToken: null, fetch: appFetch })
    expect(r.createdTeam).toBe(false)
    expect(r.people.every((p) => !p.created)).toBe(true)
    expect(r.files.every((f) => !f.uploaded)).toBe(true)
    const owner = (await signIn('dion')).api
    expect((await owner.call(API.listUsers)).items.length).toBe(4)
    expect((await owner.call(API.listGroups)).items.length).toBe(2)
    expect((await owner.call(API.listProjects)).items.length).toBe(1)
  }, 60_000)

  test('refuses a server that another owner set up', async () => {
    const other = await harness('demo-seed-other')
    try {
      const f = ((url: string | URL | Request, init?: RequestInit) => other.app.fetch(new Request(url, init), { ip: '127.0.0.1', via: 'test' })) as typeof fetch
      await new ApiClient({ baseUrl: BASE, fetch: f }).call(API.setup, { body: { setupToken: SETUP_TOKEN, teamName: 'Acme', locale: 'ko', owner: { username: 'olga', name: 'Olga', password: 'owner horse battery 42' } } })
      await expect(seedDemo({ baseUrl: BASE, setupToken: null, fetch: f })).rejects.toBeInstanceOf(SeedError)
    } finally { await other.close() }
  }, 60_000)
})
