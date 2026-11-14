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
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

let h: Harness
let owner: Client
let design: string
let sales: string
let kim: string
let bob: string
const access = (id: string, p: string) => h.ctx.files.rules().access(h.ctx.files.principal(id), p.split('/'))
const folder = async (p: string) => ((await owner.call('GET', '/api/admin/folders')).items as Folder[]).find((f) => f.path === p)!

beforeAll(async () => {
  h = await harness('folder-limited-api')
  owner = await withOwner(h)
  design = (await owner.call('POST', '/api/admin/groups', { name: 'Design' })).id
  sales = (await owner.call('POST', '/api/admin/groups', { name: 'Sales' })).id
  kim = (await addMember(h, owner, { username: 'kim', groupIds: [design] })).id
  bob = (await addMember(h, owner, { username: 'bob' })).id
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
