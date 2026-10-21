// Security regression, round 4 (trash-versions, critical): restoring an old version of a file whose restricted folder
// is in the trash put the file back with no rule at all. The trashed folder's rules are parked under .system/trash,
// so write access to shared/Layoffs/names.md fell back to shared/ (everyone write); restoreVersion created the folder
// and the file there and every member could read, overwrite and delete hr's content. An hr member (who still sees the
// parked versions) or any admin triggered it with a routine "restore this version". Now the restore is refused (409
// folderInTrash, or 404 for whoever cannot see the version) and history says canRestore=false; once the folder is back
// from the trash, with its rules, the version restore works.
//
// Port of scratchpad trash-versions/restore-version-trashed-folder.test.ts. Real server, real sessions.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { startInstance, SETUP_TOKEN, type Client, type Instance } from './lib/instance'

let inst: Instance
let owner: Client
let hr: Client
let mallory: Client
let hrGroup: string
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

/** a restricted folder under shared/ with names.md written twice by hr; trashed by the owner. Returns v1's id. */
async function trashedWithVersion(F: string): Promise<string> {
  await owner.ok('POST', '/api/admin/folders', { path: F, create: true, rules: [
    { subjectType: 'everyone', subjectId: null, access: 'none' },
    { subjectType: 'group', subjectId: hrGroup, access: 'write' },
  ] })
  await hr.ok('PUT', '/api/files/content', { path: `${F}/names.md`, content: 'SECRET v1: Alice, Bob, Carol\n', baseSha256: null })
  const cur = await hr.ok('GET', '/api/files/content?path=' + enc(`${F}/names.md`))
  await hr.ok('PUT', '/api/files/content', { path: `${F}/names.md`, content: 'SECRET v2: Alice, Bob\n', baseSha256: cur.sha256 })
  const versions = (await hr.ok('GET', '/api/files/history?path=' + enc(`${F}/names.md`))).items as { id: string }[]
  expect(versions.length).toBeGreaterThan(0)
  await owner.ok('DELETE', '/api/files?path=' + enc(F))
  return versions[versions.length - 1]!.id
}

async function malloryShutOut(F: string) {
  expect((await mallory.req('GET', '/api/files/content?path=' + enc(`${F}/names.md`))).status).toBe(404) // was 200 'SECRET v1'
  expect((await mallory.req('GET', '/api/files/tree?path=' + enc(F))).status).toBe(404) // was access 'write'
  const top = (await mallory.ok('GET', '/api/files/tree?path=shared')).entries as { name: string }[]
  expect(top.map((e) => e.name)).not.toContain(F.split('/').pop())
}

beforeAll(async () => {
  inst = await startInstance('r4-restore-version-trashed-folder')
  owner = inst.client('dana')
  await owner.ok('POST', '/api/setup', { setupToken: SETUP_TOKEN, teamName: 'T', locale: 'en', owner: { username: 'dana', name: 'Dana', password: 'Owner-pw-123456!' } })
  hrGroup = (await owner.ok('POST', '/api/admin/groups', { name: 'hr', memberIds: [] })).id
  hr = await newMember('hrbob', [hrGroup])
  mallory = await newMember('mallory')
})
afterAll(async () => { await inst?.close() })

describe('a version whose folder is in the trash is not restored outside its rules', () => {
  test('an hr member: refused (409), history says canRestore false, nothing recreated', async () => {
    const F = 'shared/Layoffs'
    const v1 = await trashedWithVersion(F)
    const h = await hr.ok('GET', '/api/files/history?path=' + enc(`${F}/names.md`))
    expect(h.canRestore).toBe(false)
    const r = await hr.req('POST', '/api/files/restore', { path: `${F}/names.md`, versionId: v1 })
    expect(r.status).toBe(409) // was 200
    expect(JSON.stringify(r.json ?? r.text)).toMatch(/in the trash/)
    await malloryShutOut(F)
    // mallory cannot restore it either (the version is hidden from her)
    expect((await mallory.req('POST', '/api/files/restore', { path: `${F}/names.md`, versionId: v1 })).status).toBe(404)
    await malloryShutOut(F)
  })

  test('an admin: refused the same way; after the folder comes back from the trash the restore works with hr\'s rule', async () => {
    const F = 'shared/Payroll'
    const v1 = await trashedWithVersion(F)
    expect((await owner.req('POST', '/api/files/restore', { path: `${F}/names.md`, versionId: v1 })).status).toBe(409)
    await malloryShutOut(F)
    const item = ((await owner.ok('GET', '/api/files/trash')).items as { id: string; originalPath: string }[]).find((t) => t.originalPath === F)!
    await owner.ok('POST', `/api/files/trash/${item.id}/restore`)
    expect((await hr.ok('GET', '/api/files/history?path=' + enc(`${F}/names.md`))).canRestore).toBe(true)
    await hr.ok('POST', '/api/files/restore', { path: `${F}/names.md`, versionId: v1 })
    expect((await hr.ok('GET', '/api/files/content?path=' + enc(`${F}/names.md`))).content).toContain('SECRET v1')
    await malloryShutOut(F)
  })
})
