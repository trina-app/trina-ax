// Security round 3 (realtime #2): an admin trashing a restricted folder (or an ordinary folder that holds one) parks
// the folder's rules under .system/trash with it. Old versions of the files that were in it were then judged with the
// LIVE rules only, where those rules no longer are, so the path fell back to shared/ (everyone write): any member
// listed GET /api/files/history for a file of the hidden folder and downloaded hr's earlier versions. (The trash side,
// files trashed from inside the folder before it went to the trash, was closed in round 2 by trashHome; it is checked
// here again, together with the realtime restore notice that went to every member's socket.) A version whose folder
// is parked in the trash is now judged as if that folder were still in place: its own parked rules at the path it had,
// plus the parked rules of every folder that held it and was trashed after it.
// Real server, real sessions, real WebSocket (tests/security/lib/instance.ts).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { startInstance, SETUP_TOKEN, type Client, type Instance, type Socket } from './lib/instance'

let inst: Instance
let owner: Client
let hr: Client
let mallory: Client
let bob: Client
let hrGroup: string
let leadsGroup: string
const enc = encodeURIComponent
let n = 0

async function newMember(username: string, groups: string[] = []): Promise<Client> {
  const u = await owner.ok('POST', '/api/admin/users', { username, name: username.toUpperCase(), role: 'member', id: username, locale: 'en' })
  const c = inst.client(username)
  await c.login(username, u.temporaryPassword)
  await c.ok('POST', '/api/auth/password', { currentPassword: u.temporaryPassword, newPassword: `Kx7-quartz-plover-${n++}-91!` })
  if (groups.length) await owner.ok('PATCH', `/api/admin/users/${username}`, { groupIds: groups })
  return c
}

const ruleFolder = (p: string, rules: { subjectType: string; subjectId: string | null; access: string }[]) =>
  owner.ok('POST', '/api/admin/folders', { path: p, create: true, rules })
const restricted = (p: string) => ruleFolder(p, [{ subjectType: 'everyone', subjectId: null, access: 'none' }, { subjectType: 'group', subjectId: hrGroup, access: 'write' }])

/** hr writes names.md twice (v1 kept as a version) and trashes severance.md; returns hr's version ids of names.md */
async function fill(F: string): Promise<string[]> {
  await hr.ok('PUT', '/api/files/content', { path: `${F}/names.md`, content: 'SECRET v1: Alice, Bob, Carol\n', baseSha256: null })
  const cur = await hr.ok('GET', '/api/files/content?path=' + enc(`${F}/names.md`))
  await hr.ok('PUT', '/api/files/content', { path: `${F}/names.md`, content: 'SECRET v2: Alice, Bob\n', baseSha256: cur.sha256 })
  await hr.ok('PUT', '/api/files/content', { path: `${F}/severance.md`, content: 'SECRET severance: 3 months\n', baseSha256: null })
  await hr.ok('DELETE', '/api/files?path=' + enc(`${F}/severance.md`))
  const h = await hr.ok('GET', '/api/files/history?path=' + enc(`${F}/names.md`))
  expect(h.items.length).toBeGreaterThan(0)
  return h.items.map((v: { id: string }) => v.id)
}

/** what a member without access gets: nothing about the folder's files, from any of the file screens */
async function locked(c: Client, F: string, versions: string[], under: string) {
  const trash = (await c.ok('GET', '/api/files/trash')).items as { id: string; originalPath: string }[]
  expect(trash.filter((t) => t.originalPath === `${F}/severance.md`)).toEqual([])
  const h = await c.req('GET', '/api/files/history?path=' + enc(`${F}/names.md`))
  expect(h.status).toBe(404)
  expect(h.text).not.toContain('HR')
  for (const id of versions) {
    const d = await c.req('GET', `/api/files/history/${id}/download`)
    expect(d.status).toBe(404)
    expect(d.text).not.toContain('SECRET')
    const r = await c.req('POST', '/api/files/restore', { path: `${F}/names.md`, versionId: id })
    expect(r.status).toBe(404)
  }
  const c2 = await c.req('GET', '/api/files/content?path=' + enc(`${F}/severance.md`))
  expect(c2.status).toBe(404)
  // nothing under the trashed folder was recreated by any of the above
  expect((await c.req('GET', '/api/files/tree?path=' + enc(under))).status).toBe(404)
}

async function sock(c: Client): Promise<Socket> {
  const s = await c.ws({ windowId: `win-${c.label}-${++n}` })
  await s.next('hello')
  return s
}

beforeAll(async () => {
  inst = await startInstance('r3-trashed-restricted-folder')
  owner = inst.client('dana')
  await owner.ok('POST', '/api/setup', { setupToken: SETUP_TOKEN, teamName: 'T', locale: 'en', owner: { username: 'dana', name: 'Dana', password: 'Owner-pw-123456!' } })
  hrGroup = (await owner.ok('POST', '/api/admin/groups', { name: 'hr', memberIds: [] })).id
  leadsGroup = (await owner.ok('POST', '/api/admin/groups', { name: 'hr-leads', memberIds: [] })).id
  hr = await newMember('hrbob', [hrGroup, leadsGroup])
  mallory = await newMember('mallory')
  bob = await newMember('bob')
})
afterAll(async () => { await inst?.close() })

describe('a restricted folder in the trash keeps its files and versions to the people it was restricted to', () => {
  test('the restricted folder itself is trashed: no trash item, history, version or restore for other members', async () => {
    const F = 'shared/Layoffs-A'
    await restricted(F)
    const versions = await fill(F)
    await locked(mallory, F, versions, F)
    const watch = await sock(bob)
    await owner.ok('DELETE', '/api/files?path=' + enc(F))
    await locked(mallory, F, versions, F)
    // hr (the folder's own group) still sees the old versions while it is in the trash
    const h = await hr.req('GET', '/api/files/history?path=' + enc(`${F}/names.md`))
    expect(h.status).toBe(200)
    expect(h.json.items.map((v: { id: string }) => v.id)).toEqual(versions)
    expect((await hr.req('GET', `/api/files/history/${versions[0]}/download`)).text).toContain('SECRET v1')
    await Bun.sleep(200)
    expect(watch.all()).not.toContain('Layoffs-A/')
    watch.close()
    // the owner restores it: rules come back with it and the members are still locked out
    const item = ((await owner.ok('GET', '/api/files/trash')).items as { id: string; originalPath: string }[]).find((t) => t.originalPath === F)!
    await owner.ok('POST', `/api/files/trash/${item.id}/restore`)
    await locked(mallory, F, versions, F)
    expect((await hr.req('GET', `/api/files/history/${versions[0]}/download`)).status).toBe(200)
  })

  test('an ordinary parent holding a restricted subfolder is trashed: the same', async () => {
    const P = 'shared/Proj-B', F = `${P}/Secret`
    await owner.ok('POST', '/api/files/mkdir', { path: P })
    await restricted(F)
    const versions = await fill(F)
    await owner.ok('DELETE', '/api/files?path=' + enc(P))
    await locked(mallory, F, versions, P)
    expect((await hr.req('GET', `/api/files/history/${versions[0]}/download`)).status).toBe(200)
  })

  test('a subfolder trashed first, then the restricted folder that held it: the outer folder\'s rules still count', async () => {
    // Inner only names hr-leads; everyone else is shut out by Outer (everyone none), which is trashed after Inner
    const O = 'shared/Outer-C', F = `${O}/Inner`
    await restricted(O)
    await ruleFolder(F, [{ subjectType: 'group', subjectId: leadsGroup, access: 'write' }])
    const versions = await fill(F)
    await locked(mallory, F, versions, O)
    await owner.ok('DELETE', '/api/files?path=' + enc(F))
    await owner.ok('DELETE', '/api/files?path=' + enc(O))
    await locked(mallory, F, versions, O)
    expect((await hr.req('GET', `/api/files/history/${versions[0]}/download`)).status).toBe(200)
    // the outer folder comes back under a new name: Inner (still in the trash) moves along with it
    await owner.ok('POST', '/api/files/mkdir', { path: O })
    const outer = ((await owner.ok('GET', '/api/files/trash')).items as { id: string; originalPath: string }[]).find((t) => t.originalPath === O)!
    const back = await owner.ok('POST', `/api/files/trash/${outer.id}/restore`)
    expect(back.entry.path).toBe(`${O} (restored)`)
    const inner = ((await owner.ok('GET', '/api/files/trash')).items as { id: string; originalPath: string }[]).find((t) => t.originalPath.endsWith('/Inner'))
    expect(inner?.originalPath).toBe(`${O} (restored)/Inner`)
    await locked(mallory, F, versions, `${O} (restored)/Inner`)
    expect((await hr.req('GET', `/api/files/history/${versions[0]}/download`)).status).toBe(200)
  })

  test('control: a member who may read the folder keeps old versions of an ordinary trashed folder', async () => {
    const F = 'shared/Plain-D'
    await owner.ok('POST', '/api/files/mkdir', { path: F })
    await bob.ok('PUT', '/api/files/content', { path: `${F}/a.md`, content: 'one\n', baseSha256: null })
    const cur = await bob.ok('GET', '/api/files/content?path=' + enc(`${F}/a.md`))
    await bob.ok('PUT', '/api/files/content', { path: `${F}/a.md`, content: 'two\n', baseSha256: cur.sha256 })
    await bob.ok('DELETE', '/api/files?path=' + enc(F))
    const h = await mallory.ok('GET', '/api/files/history?path=' + enc(`${F}/a.md`))
    expect(h.items.length).toBe(1)
    expect((await mallory.req('GET', `/api/files/history/${h.items[0].id}/download`)).text).toBe('one\n')
  })
})
