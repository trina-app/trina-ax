// Admin > Folder permissions: rows the admin API does not remove (fix/folders-safety 1b). shared/ and skills/ keep at
// least one rule, a group's folder row stays while the group does, and a row parked with a trashed folder is neither
// listed nor edited. The refusals live in the admin routes only: deleting a group or a person, turning a skills manager
// off and the trash still change or drop these rows the way they did.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { msg } from '../../server/src/auth/messages'
import { rulesOf } from '../../server/src/admin/folders'
import { folderKeep, isParkedRow, isTeamDefaultFolder } from '../../server/src/admin/folder-keep'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

const everyone = (access: 'none' | 'read' | 'write') => ({ subjectType: 'everyone', subjectId: null, access })
const SKILLS_DEFAULT = [everyone('read'), { subjectType: 'role', subjectId: 'admin', access: 'write' }]

describe('which rows are kept (folder-keep.ts, also the mock server\'s)', () => {
  test('shared/ and skills/ as the volume compares names; subfolders and look-alikes are ordinary', () => {
    for (const ci of [true, false]) {
      for (const p of ['shared', 'skills']) expect(isTeamDefaultFolder(p, ci), p).toBe(true)
      for (const p of ['', 'shared/board', 'skills/finance', 'shared-old', 'ｓｈａｒｅｄ', 'shared\u200b', 'groups/shared']) expect(isTeamDefaultFolder(p, ci), p).toBe(false)
    }
    // a case-insensitive volume: the same folder in another case; a case-sensitive one: another folder
    for (const p of ['Shared', 'SKILLS', 'sKiLLs']) {
      expect(isTeamDefaultFolder(p, true), p).toBe(true)
      expect(isTeamDefaultFolder(p, false), p).toBe(false)
    }
    expect(folderKeep('Shared', 'g1', true)).toBe('team')
    expect(folderKeep('Shared', 'g1', false)).toBe('group')
    expect(folderKeep('groups/sales', 'g1', false)).toBe('group')
    expect(folderKeep('groups/sales', null, true)).toBeNull()
    expect(isParkedRow('.system/trash/2026-11/x')).toBe(true)
    expect(isParkedRow('.systemx')).toBe(false)
  })
})

describe('folder rows that stay', () => {
  let h: Harness
  let owner: Client
  let admin: Client
  let alice: { client: Client; id: string }
  let bob: { client: Client; id: string }
  let sales: string
  beforeAll(async () => {
    h = await harness('folders-keep')
    owner = await withOwner(h)
    admin = (await addMember(h, owner, { username: 'adam', role: 'admin' })).client
    sales = (await admin.call('POST', '/api/admin/groups', { name: 'Sales' })).id
    alice = await addMember(h, owner, { username: 'alice', groupIds: [sales] })
    bob = await addMember(h, owner, { username: 'bob' })
  })
  afterAll(() => h.close())
  const rowId = (p: string) => (h.ctx.db.query('SELECT id FROM folders WHERE path = ?').get(p) as { id: string } | null)?.id ?? null
  const rulesAt = (p: string) => rulesOf(h.ctx.db, rowId(p)!)
  const access = (userId: string, p: string) => h.ctx.files.rules().access(h.ctx.files.principal(userId), p.split('/'))
  const listed = async () => (await admin.call('GET', '/api/admin/folders')).items as { id: string; path: string; groupId?: string | null; keep?: string | null; rules: unknown[]; exists: boolean }[]
  const audits = (action: string) => (h.ctx.db.query('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?').get(action) as { n: number }).n

  test('the list says which rows stay and why', async () => {
    const by = Object.fromEntries((await listed()).map((f) => [f.path, f.keep]))
    expect(by).toMatchObject({ shared: 'team', skills: 'team', 'groups/Sales': 'group' })
    const p = await admin.call('POST', '/api/admin/folders', { path: 'projects/plain', rules: [everyone('read')] })
    expect(p.keep).toBeNull()
    expect((await admin.try('DELETE', `/api/admin/folders/${p.id}`)).status).toBe(204)
  })

  test('shared/ and skills/: removing the row or all its rules is refused, and the message says how to keep them to admins', async () => {
    const deletes = audits('folder.delete')
    const changes = audits('folder.rules')
    for (const p of ['shared', 'skills']) {
      const id = rowId(p)!
      const before = rulesAt(p)
      expect(before.length).toBeGreaterThan(0)
      const d = await admin.try('DELETE', `/api/admin/folders/${id}`)
      expect(d.status, p).toBe(409)
      expect(d.body.error.message).toBe(msg('teamFolderKeepsRules', 'ko'))
      expect(d.body.error.message).toContain('"모두: 권한 없음"')
      const put = await owner.try('PUT', `/api/admin/folders/${id}/rules`, { rules: [] })
      expect(put.status, p).toBe(400)
      expect(put.body.error.message).toBe(msg('teamFolderKeepsRules', 'ko'))
      // the same through "add folder" (it would make a rule-less row)
      expect((await admin.try('POST', '/api/admin/folders', { path: p, rules: [] })).status).toBe(400)
      expect(rowId(p)).toBe(id)
      expect(rulesAt(p)).toEqual(before)
    }
    expect(audits('folder.delete')).toBe(deletes)
    expect(audits('folder.rules')).toBe(changes)
    // in English for an English-speaking admin
    await admin.call('PATCH', '/api/me', { locale: 'en' })
    expect((await admin.try('DELETE', `/api/admin/folders/${rowId('shared')}`)).body.error.message).toBe(msg('teamFolderKeepsRules', 'en'))
    await admin.call('PATCH', '/api/me', { locale: null })
    // what the message says works: "Everyone: No access" leaves skills/ to the owner and admins
    await admin.call('PUT', `/api/admin/folders/${rowId('skills')}/rules`, { rules: [everyone('none')] })
    expect(access(alice.id, 'skills/rules.md')).toBe('none')
    expect(access('adam', 'skills/rules.md')).toBe('write')
    await admin.call('PUT', `/api/admin/folders/${rowId('skills')}/rules`, { rules: SKILLS_DEFAULT })
    expect(access(alice.id, 'skills/rules.md')).toBe('read')
    // a subfolder of skills/ is an ordinary row: it falls back to skills/
    const sub = await admin.call('POST', '/api/admin/folders', { path: 'skills/finance', rules: [everyone('none')] })
    expect((await admin.try('DELETE', `/api/admin/folders/${sub.id}`)).status).toBe(204)
    expect(access(alice.id, 'skills/finance/close.md')).toBe('read')
  })

  test('a group\'s folder row stays while the group does; deleting the group still works and frees it', async () => {
    const g = await admin.call('POST', '/api/admin/groups', { name: 'Ops', memberIds: [bob.id] })
    const f = (await listed()).find((x) => x.path === 'groups/Ops')!
    expect(f.groupId).toBe(g.id)
    expect((await listed()).find((x) => x.path === 'projects')?.groupId ?? null).toBeNull()
    const d = await owner.try('DELETE', `/api/admin/folders/${f.id}`)
    expect(d.status).toBe(409)
    expect(d.body.error.message).toBe(msg('groupFolderKeepsRow', 'ko'))
    expect(h.ctx.db.query('SELECT folder_id FROM groups WHERE id = ?').get(g.id)).toEqual({ folder_id: f.id })
    // its rules can still change (Edit)
    await admin.call('PUT', `/api/admin/folders/${f.id}/rules`, { rules: [{ subjectType: 'group', subjectId: g.id, access: 'write' }, { subjectType: 'user', subjectId: alice.id, access: 'read' }] })
    expect(access(alice.id, 'groups/Ops/plan.md')).toBe('read')
    // deleting the group (admin/groups.ts) removes the group's rules; the row is an ordinary one then
    await admin.call('DELETE', `/api/admin/groups/${g.id}`)
    const after = (await listed()).find((x) => x.path === 'groups/Ops')!
    expect(after.groupId).toBeNull()
    expect(after.rules).toHaveLength(1)
    expect(access(bob.id, 'groups/Ops/plan.md')).toBe('none')
    expect((await admin.try('DELETE', `/api/admin/folders/${f.id}`)).status).toBe(204)
    expect(rowId('groups/Ops')).toBeNull()
  })

  test('a rename that changes only the case does not take the protection away', async () => {
    const id = rowId('shared')!
    const ci = h.ctx.files.fx.caseInsensitive
    // a typed name in another case: on a case-insensitive volume the same folder, refused before anything is made; on a
    // case-sensitive one a new folder, which the app refuses as a near-duplicate of shared/
    for (const p of ['SHARED', 'Shared']) {
      const r = await admin.try('POST', '/api/admin/folders', { path: p, create: true, rules: [] })
      if (ci) expect(r.status, p).toBe(400)
      else expect(r.status, p).toBeGreaterThanOrEqual(400)
      if (!ci) expect(fs.existsSync(path.join(h.ctx.files.fx.root, p)), p).toBe(false)
    }
    // a case-insensitive volume (macOS) takes the rename and keeps the row; elsewhere the app refuses it (a near-duplicate
    // of the folder itself), so there is nothing to get around
    const mv = await admin.try('POST', '/api/files/move', { from: 'shared', to: 'Shared' })
    if (!h.ctx.files.fx.caseInsensitive) {
      expect(mv.status).toBe(409)
      expect(rowId('shared')).toBe(id)
      return
    }
    expect(mv.status).toBe(200)
    expect(h.ctx.db.query('SELECT path FROM folders WHERE id = ?').get(id)).toEqual({ path: 'Shared' })
    expect((await listed()).find((f) => f.id === id)?.keep).toBe('team')
    expect((await admin.try('PUT', `/api/admin/folders/${id}/rules`, { rules: [] })).status).toBe(400)
    expect((await admin.try('DELETE', `/api/admin/folders/${id}`)).status).toBe(409)
    expect(rulesOf(h.ctx.db, id).length).toBeGreaterThan(0)
    expect((await admin.try('POST', '/api/files/move', { from: 'Shared', to: 'shared' })).status).toBe(200)
    expect(rowId('shared')).toBe(id)
  })

  test('a case-sensitive volume: a folder named Shared beside shared/ is an ordinary one', async () => {
    if (h.ctx.files.fx.caseInsensitive) {
      // a case-insensitive volume has one folder for both names (the case-only rename above)
      expect((await listed()).find((f) => f.path === 'shared')?.keep).toBe('team')
      return
    }
    // a team folder set on an existing share, or a folder made on disk: the app does not make it, but it can be there
    const other = path.join(h.ctx.files.fx.root, 'Shared')
    fs.mkdirSync(other)
    try {
      const row = await admin.call('POST', '/api/admin/folders', { path: 'Shared', rules: [everyone('read')] })
      expect(row).toMatchObject({ path: 'Shared', keep: null })
      expect((await admin.try('PUT', `/api/admin/folders/${row.id}/rules`, { rules: [] })).status).toBe(200)
      expect((await admin.try('DELETE', `/api/admin/folders/${row.id}`)).status).toBe(204)
      // shared/ itself is still kept
      expect((await listed()).find((f) => f.path === 'shared')?.keep).toBe('team')
      expect((await admin.try('DELETE', `/api/admin/folders/${rowId('shared')}`)).status).toBe(409)
      expect((await admin.try('PUT', `/api/admin/folders/${rowId('shared')}/rules`, { rules: [] })).status).toBe(400)
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })

  test('"add folder" with no rule on shared/ is refused before the folder is made on disk', async () => {
    const dir = path.join(h.ctx.files.fx.root, 'skills')
    const keep = path.join(h.ctx.files.fx.root, '..', `skills-aside-${process.pid}`)
    fs.renameSync(dir, keep)
    try {
      const r = await admin.try('POST', '/api/admin/folders', { path: 'skills', create: true, rules: [] })
      expect(r.status).toBe(400)
      expect(fs.existsSync(dir)).toBe(false)
    } finally {
      fs.renameSync(keep, dir)
    }
  })

  test('not refused: the team root, a row whose folder is gone from disk', async () => {
    const root = await admin.call('POST', '/api/admin/folders', { path: '', rules: [everyone('read')] })
    expect(root.path).toBe('')
    expect((await admin.call('PUT', `/api/admin/folders/${root.id}/rules`, { rules: [] })).rules).toEqual([])
    expect((await admin.try('DELETE', `/api/admin/folders/${root.id}`)).status).toBe(204)
    const gone = await admin.call('POST', '/api/admin/folders', { path: 'old-area', rules: [everyone('read')] })
    fs.rmSync(path.join(h.ctx.files.fx.root, 'old-area'), { recursive: true })
    expect((await listed()).find((x) => x.id === gone.id)?.exists).toBe(false)
    expect((await admin.try('DELETE', `/api/admin/folders/${gone.id}`)).status).toBe(204)
  })

  test('a row parked with a trashed folder: not listed, not edited, not removed; it comes back with the folder', async () => {
    const f = await admin.call('POST', '/api/admin/folders', { path: 'projects/vault', create: true, rules: [{ subjectType: 'user', subjectId: alice.id, access: 'write' }] })
    await alice.client.call('PUT', '/api/files/content', { path: 'projects/vault/plan.md', content: 'plan\n', baseSha256: null })
    const { trashId } = await owner.call('DELETE', '/api/files?path=projects%2Fvault')
    const parked = h.ctx.db.query('SELECT path FROM folders WHERE id = ?').get(f.id) as { path: string }
    expect(parked.path.startsWith('.system/trash/')).toBe(true)
    expect((await listed()).some((x) => x.id === f.id || x.path.startsWith('.system'))).toBe(false)
    for (const who of [admin, owner]) {
      expect((await who.try('PUT', `/api/admin/folders/${f.id}/rules`, { rules: [everyone('write')] })).status).toBe(404)
      expect((await who.try('DELETE', `/api/admin/folders/${f.id}`)).status).toBe(404)
    }
    expect(rulesOf(h.ctx.db, f.id)).toEqual([{ subjectType: 'user', subjectId: alice.id, access: 'write' }])
    // the trash restores it with its rules, and it is an ordinary row again
    expect((await owner.call('POST', `/api/files/trash/${trashId}/restore`)).entry.path).toBe('projects/vault')
    const back = (await listed()).find((x) => x.id === f.id)!
    expect(back.path).toBe('projects/vault')
    expect(access(alice.id, 'projects/vault/plan.md')).toBe('write')
    expect(access(bob.id, 'projects/vault/plan.md')).toBe('none')
    expect((await admin.try('DELETE', `/api/admin/folders/${f.id}`)).status).toBe(204)
  })

  test('inside the server the rows still change: a skills manager turned off, a person deleted', async () => {
    // skills/managers.ts: turning off the last rule of skills/ is not the admin route's refusal
    await admin.call('PUT', `/api/admin/folders/${rowId('skills')}/rules`, { rules: [{ subjectType: 'group', subjectId: sales, access: 'write' }] })
    await admin.call('PUT', '/api/admin/skill-managers', { subjectType: 'group', subjectId: sales, path: 'skills', enabled: false })
    expect(rulesAt('skills')).toEqual([])
    await admin.call('PUT', `/api/admin/folders/${rowId('skills')}/rules`, { rules: SKILLS_DEFAULT })
    // a subfolder made only for a manager goes again when it is turned off (dropFolderRow)
    await admin.call('PUT', '/api/admin/skill-managers', { subjectType: 'user', subjectId: bob.id, path: 'skills/hr', enabled: true })
    expect(rowId('skills/hr')).not.toBeNull()
    await admin.call('PUT', '/api/admin/skill-managers', { subjectType: 'user', subjectId: bob.id, path: 'skills/hr', enabled: false })
    expect(rowId('skills/hr')).toBeNull()
    // admin/users.ts: deleting a person removes their rules everywhere, the last one of shared/ too
    const carl = await addMember(h, owner, { username: 'carl' })
    await admin.call('PUT', `/api/admin/folders/${rowId('shared')}/rules`, { rules: [{ subjectType: 'user', subjectId: carl.id, access: 'write' }] })
    expect((await owner.try('DELETE', `/api/admin/users/${carl.id}`)).status).toBe(204)
    expect(rulesAt('shared')).toEqual([])
    expect(rowId('shared')).not.toBeNull()
    // a rule-less shared/ is still refused at the admin API; giving it rules again works
    expect((await admin.try('DELETE', `/api/admin/folders/${rowId('shared')}`)).status).toBe(409)
    await admin.call('PUT', `/api/admin/folders/${rowId('shared')}/rules`, { rules: [everyone('write')] })
    expect(access(bob.id, 'shared/x.md')).toBe('write')
  })
})
