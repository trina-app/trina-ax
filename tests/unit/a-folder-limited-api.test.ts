// Admin › Folder permissions since folder access adds up (docs/DECISIONS.md "Folder access adds up like Google Drive
// (P2)"): `limited` on create, save and previews (missing keeps it: review 2 H1), 409 client_outdated for a page from
// before the limit, 400 for "no access" and role rules, origin rows kept on an unrelated save (review 3 S1), the
// group screens and the connector naming people who keep access by name (C1-A; review 3 S5), and the safe-ops policy
// generation advancing on the limit (review 2 H2).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { Folder } from '@mycel/shared/api'
import { rulesHashV1 } from '../../server/src/admin/access-edit'
import { policyGeneration } from '../../server/src/safe-ops/publication'
import { folderAccessProblems } from '../../server/src/policy/invariants'
import { newId } from '../../server/src/db'
import { audit } from '../../server/src/admin/audit'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

let h: Harness
let owner: Client
let design: string
let sales: string
let kim: string
let bob: string
let bobClient: Client
const access = (id: string, p: string) => h.ctx.files.rules().access(h.ctx.files.principal(id), p.split('/'))
const folder = async (p: string) => ((await owner.call('GET', '/api/admin/folders')).items as Folder[]).find((f) => f.path === p)!

beforeAll(async () => {
  h = await harness('folder-limited-api')
  owner = await withOwner(h)
  design = (await owner.call('POST', '/api/admin/groups', { name: 'Design' })).id
  sales = (await owner.call('POST', '/api/admin/groups', { name: 'Sales' })).id
  kim = (await addMember(h, owner, { username: 'kim', groupIds: [design] })).id
  const b = await addMember(h, owner, { username: 'bob' })
  bob = b.id
  bobClient = b.client
  fs.mkdirSync(path.join(h.ctx.files.fx.root, 'shared', 'hr'), { recursive: true })
})
afterAll(() => h.close())

describe('limited through the API', () => {
  test('create limited with no rules: members lose it; the folder says limited; invariants hold', async () => {
    const f = await owner.call('POST', '/api/admin/folders', { path: 'shared/hr', create: false, rules: [], limited: true }) as Folder
    expect(f.limited).toBe(true)
    expect(f.rules).toEqual([])
    expect(access(bob, 'shared/hr')).toBe('none')
    expect(access(bob, 'shared')).toBe('write')
    expect(folderAccessProblems(h.ctx.db)).toEqual([])
  })

  test('a save without `limited` keeps the limit (H1); false lifts it; true puts it back', async () => {
    let f = await folder('shared/hr')
    f = await owner.call('PUT', `/api/admin/folders/${f.id}/rules`, { rules: [{ subjectType: 'user', subjectId: kim, access: 'read' }], expectedHash: f.rulesHash })
    expect(f.limited).toBe(true)
    expect(access(bob, 'shared/hr')).toBe('none')
    expect(access(kim, 'shared/hr')).toBe('read')
    f = await owner.call('PUT', `/api/admin/folders/${f.id}/rules`, { rules: f.rules.map((r) => ({ subjectType: r.subjectType, subjectId: r.subjectId, access: r.access })), expectedHash: f.rulesHash, limited: false })
    expect(f.limited).toBe(false)
    // access adds up: kim keeps write from shared/, bob too
    expect(access(kim, 'shared/hr')).toBe('write')
    expect(access(bob, 'shared/hr')).toBe('write')
    f = await owner.call('PUT', `/api/admin/folders/${f.id}/rules`, { rules: [], expectedHash: f.rulesHash, limited: true })
    expect(access(bob, 'shared/hr')).toBe('none')
    expect(folderAccessProblems(h.ctx.db)).toEqual([])
  })

  test('a page from before the limit (no hash, or a rules-v1 hash) saving a limited folder is told to reload: 409 client_outdated', async () => {
    const f = await folder('shared/hr')
    const noHash = await owner.try('PUT', `/api/admin/folders/${f.id}/rules`, { rules: [] })
    expect(noHash.status).toBe(409)
    expect(noHash.body.error?.params?.reason).toBe('client_outdated')
    const v1 = rulesHashV1((h.ctx.db.query('SELECT subject_type, subject_id, access FROM folder_rules WHERE folder_id = ?').all(f.id) as { subject_type: string; subject_id: string | null; access: string }[]).map((r) => ({ subjectType: r.subject_type, subjectId: r.subject_id, access: r.access })))
    const old = await owner.try('PUT', `/api/admin/folders/${f.id}/rules`, { rules: [], expectedHash: v1 })
    expect(old.status).toBe(409)
    expect(old.body.error?.params?.reason).toBe('client_outdated')
    expect(access(bob, 'shared/hr')).toBe('none')
  })

  test('"no access" and role rules: 400 with the field and the reason', async () => {
    const f = await folder('shared')
    const none = await owner.try('PUT', `/api/admin/folders/${f.id}/rules`, { rules: [{ subjectType: 'everyone', subjectId: null, access: 'write' }, { subjectType: 'user', subjectId: bob, access: 'none' }], expectedHash: f.rulesHash })
    expect(none.status).toBe(400)
    expect(none.body.error?.fields?.['body.rules.1.access']).toBe('no_deny_rules')
    const role = await owner.try('PUT', `/api/admin/folders/${f.id}/rules`, { rules: [{ subjectType: 'role', subjectId: 'member', access: 'read' }], expectedHash: f.rulesHash })
    expect(role.status).toBe(400)
    expect(role.body.error?.fields?.['body.rules.0.subjectType']).toBe('no_role_rules')
    const preview = await owner.try('POST', '/api/admin/access/edit-preview', { path: 'shared', rules: [{ subjectType: 'group', subjectId: sales, access: 'none' }] })
    expect(preview.status).toBe(400)
  })

  test('12-A at save time: not limited, a rule lower than what shared/ gives is stored at that level; limited, kept as asked', async () => {
    fs.mkdirSync(path.join(h.ctx.files.fx.root, 'shared', 'low'), { recursive: true })
    const low = [{ subjectType: 'user', subjectId: kim, access: 'read' }, { subjectType: 'group', subjectId: sales, access: 'read' }, { subjectType: 'everyone', subjectId: null, access: 'read' }]
    let f = await owner.call('POST', '/api/admin/folders', { path: 'shared/low', create: false, rules: low }) as Folder
    // shared/ lets everyone edit: each read row restricts nobody, so it is stored as Editor
    expect(f.rules.map((r) => r.access)).toEqual(['write', 'write', 'write'])
    expect(access(kim, 'shared/low')).toBe('write')
    f = await owner.call('PUT', `/api/admin/folders/${f.id}/rules`, { rules: low, expectedHash: f.rulesHash, limited: true })
    expect(f.limited).toBe(true)
    expect(f.rules.filter((r) => r.access !== 'none').map((r) => r.access)).toEqual(['read', 'read', 'read'])
    // the limit taken off with the low rows: raised again
    f = await owner.call('PUT', `/api/admin/folders/${f.id}/rules`, { rules: low, expectedHash: f.rulesHash, limited: false })
    expect(f.rules.map((r) => r.access)).toEqual(['write', 'write', 'write'])
    expect(folderAccessProblems(h.ctx.db)).toEqual([])
  })

  test('12-A never raises a person through their group: after leaving the group they keep only their own row (re-review of #787)', async () => {
    // Company (limited) gives Sales Editor; Contracts below it is not limited and lists Bob as Viewer
    fs.mkdirSync(path.join(h.ctx.files.fx.root, 'shared', 'co', 'contracts'), { recursive: true })
    await owner.call('PATCH', `/api/admin/groups/${sales}`, { memberIds: [bob] })
    await owner.call('POST', '/api/admin/folders', { path: 'shared/co', create: false, rules: [{ subjectType: 'group', subjectId: sales, access: 'write' }], limited: true })
    let f = await owner.call('POST', '/api/admin/folders', { path: 'shared/co/contracts', create: false, rules: [{ subjectType: 'user', subjectId: bob, access: 'read' }] }) as Folder
    // an unrelated save (Kim added): Bob's own row stays Viewer
    f = await owner.call('PUT', `/api/admin/folders/${f.id}/rules`, { rules: [{ subjectType: 'user', subjectId: bob, access: 'read' }, { subjectType: 'user', subjectId: kim, access: 'read' }], expectedHash: f.rulesHash })
    expect(f.rules.find((r) => r.subjectId === bob)?.access).toBe('read')
    expect(access(bob, 'shared/co/contracts')).toBe('write')
    // Bob leaves Sales: only his own Viewer row is left
    await owner.call('PATCH', `/api/admin/groups/${sales}`, { memberIds: [] })
    expect(access(bob, 'shared/co/contracts')).toBe('read')
  })

  test('12-A never raises a person through their role: an admin demoted keeps only their own row (re-review of #787)', async () => {
    const ada = (await addMember(h, owner, { username: 'ada', role: 'admin' })).id
    let f = await folder('shared/co/contracts')
    f = await owner.call('PUT', `/api/admin/folders/${f.id}/rules`, { rules: [{ subjectType: 'user', subjectId: ada, access: 'read' }], expectedHash: f.rulesHash })
    expect(f.rules.find((r) => r.subjectId === ada)?.access).toBe('read')
    await owner.call('PATCH', `/api/admin/users/${ada}`, { role: 'member' })
    expect(access(ada, 'shared/co/contracts')).toBe('read')
  })

  test('shared/ may be limited with no rules (M3): the team folder keeps a rule or a limit', async () => {
    const f = await folder('shared')
    const empty = await owner.try('PUT', `/api/admin/folders/${f.id}/rules`, { rules: [], expectedHash: f.rulesHash })
    expect(empty.status).toBe(400)
    const lim = await owner.call('PUT', `/api/admin/folders/${f.id}/rules`, { rules: [], expectedHash: f.rulesHash, limited: true })
    expect(lim.limited).toBe(true)
    const back = await owner.call('PUT', `/api/admin/folders/${f.id}/rules`, { rules: [{ subjectType: 'everyone', subjectId: null, access: 'write' }], expectedHash: lim.rulesHash, limited: false })
    expect(back.limited).toBe(false)
  })

  test('the edit preview and its hash know the limit', async () => {
    const r = await owner.call('POST', '/api/admin/access/edit-preview', { path: 'shared/hr', rules: [], limited: false })
    expect(r.limited).toBe(true)
    expect(r.hash).toBe((await folder('shared/hr')).rulesHash)
    expect(r.changes.some((c: { direction: string }) => c.direction === 'more')).toBe(true)
  })
})

describe('origin rows (C1-A)', () => {
  test('an unrelated save keeps the origin of person rules saved with the same access (review 3 S1); changing the access clears it', async () => {
    const f = await folder('shared/hr')
    h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access, origin) VALUES (?, ?, 'user', ?, 'write', ?)").run(newId(), f.id, kim, JSON.stringify({ v: 1, by: 'conversion', groups: [{ id: design, member: true }], base: null }))
    let now = await folder('shared/hr')
    expect(now.rules.find((r) => r.subjectId === kim)?.byConversion).toBe(true)
    // add bob: kim's rule as it was
    now = await owner.call('PUT', `/api/admin/folders/${f.id}/rules`, { rules: [{ subjectType: 'user', subjectId: kim, access: 'write' }, { subjectType: 'user', subjectId: bob, access: 'read' }], expectedHash: now.rulesHash })
    expect(now.rules.find((r) => r.subjectId === kim)?.byConversion).toBe(true)
    expect((h.ctx.db.query('SELECT origin FROM folder_rules WHERE folder_id = ? AND subject_id = ?').get(f.id, kim) as { origin: string | null }).origin).not.toBeNull()
  })

  test('before and after a group change, the people who keep access by name are named: origin-check, the audit row', async () => {
    const check = await owner.call('POST', '/api/admin/groups/origin-check', { changes: [{ userId: kim, groupId: design }] })
    expect(check.kept).toEqual([{ user: { id: kim, name: 'KIM' }, path: 'shared/hr', access: 'write', groupId: design }])
    expect((await owner.call('POST', '/api/admin/groups/origin-check', { changes: [{ userId: kim, groupId: sales }] })).kept).toEqual([])
    await owner.call('PATCH', `/api/admin/groups/${design}`, { memberIds: [] })
    // Drive: access given by name stays
    expect(access(kim, 'shared/hr')).toBe('write')
    const row = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'group.update' ORDER BY id DESC LIMIT 1").get() as { detail: string }
    expect(JSON.parse(row.detail).originKept).toEqual([{ userId: kim, path: 'shared/hr', access: 'write' }])
  })

  test('changing the access clears the origin: an admin set it now', async () => {
    const f = await folder('shared/hr')
    await owner.call('PUT', `/api/admin/folders/${f.id}/rules`, { rules: [{ subjectType: 'user', subjectId: kim, access: 'read' }], expectedHash: f.rulesHash })
    expect((h.ctx.db.query('SELECT origin FROM folder_rules WHERE folder_id = ? AND subject_id = ?').get(f.id, kim) as { origin: string | null }).origin).toBeNull()
  })
})

describe('the one-time Admin notice after the conversion', () => {
  test('lists the folders the conversion named people on that are still there (not in projects/), until an admin closes it', async () => {
    expect((await owner.call('GET', '/api/admin/folder-access/notice')).notice).toBeNull()
    audit(h.ctx.db, { actor: null, action: 'folders.additive_conversion', detail: { byName: [{ path: 'shared/hr', count: 2 }, { path: 'shared/gone', count: 1 }, { path: 'projects/x', count: 3 }, { path: 'shared', count: 0 }] } })
    const n = (await owner.call('GET', '/api/admin/folder-access/notice')).notice
    expect(n.folders).toEqual([{ path: 'shared/hr', count: 2 }])
    expect(typeof n.at).toBe('string')
    const member = bobClient
    expect((await member.try('GET', '/api/admin/folder-access/notice')).status).toBe(403)
    expect((await member.try('POST', '/api/admin/folder-access/notice/dismiss')).status).toBe(403)
    const r = await owner.try('POST', '/api/admin/folder-access/notice/dismiss')
    expect(r.status).toBe(204)
    expect((await owner.call('GET', '/api/admin/folder-access/notice')).notice).toBeNull()
    expect(h.ctx.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'folders.notice_dismissed'").get()).toEqual({ n: 1 })
  })
})

test('the safe-ops policy generation advances when the limit changes (H2)', () => {
  const db = h.ctx.db
  const f = db.query("SELECT id, limited FROM folders WHERE path = 'shared/hr'").get() as { id: string; limited: number }
  const g = policyGeneration(db)
  db.query('UPDATE folders SET limited = ? WHERE id = ?').run(f.limited ? 0 : 1, f.id)
  expect(policyGeneration(db)).toBe(g + 1)
  db.query('UPDATE folders SET limited = ? WHERE id = ?').run(f.limited, f.id)
  expect(policyGeneration(db)).toBe(g + 2)
  const r = db.query("SELECT id FROM folder_rules WHERE subject_type = 'user' LIMIT 1").get() as { id: string }
  db.query("UPDATE folder_rules SET origin = '{}' WHERE id = ?").run(r.id)
  expect(policyGeneration(db)).toBe(g + 3)
})
