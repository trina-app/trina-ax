// Component A: folder rules by folder id and their resolution (design tab 2), the "who sees what" preview, and
// fresh engine sessions for people who lose read access (H7).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { openDb } from '../../server/src/db'
import { RuleSet, type Access, type Principal } from '../../server/src/policy/access'
import { captureState, readLosses } from '../../server/src/admin/folders'
import { uuidv7 } from '@mycel/shared/api'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

// ---------------- resolution table (pure) ----------------
type R = [path: string, type: 'everyone' | 'role' | 'group' | 'user', subject: string | null, access: Access]
const RULES: R[] = [
  ['', 'everyone', null, 'read'], // a root rule must never open personal folders
  ['shared', 'everyone', null, 'write'],
  ['skills', 'everyone', null, 'read'],
  ['skills', 'role', 'admin', 'write'],
  ['groups/sales', 'group', 'sales', 'write'],
  ['groups/sales', 'role', 'member', 'none'],
  ['groups/sales/archive', 'group', 'sales', 'read'],
  ['groups/ops', 'group', 'ops', 'read'],
  ['projects/x', 'group', 'sales', 'read'],
  ['projects/x', 'group', 'ops', 'write'], // several groups: the widest wins
  ['projects/x', 'user', 'mia', 'none'], // personal beats group
  ['projects/x', 'everyone', null, 'write'], // everyone is the weakest
  ['projects/x/drafts', 'user', 'leo', 'write'], // only leo has a rule here; others inherit from projects/x
  ['projects/y', 'role', 'member', 'read'],
  ['projects/y', 'everyone', null, 'write'], // role beats everyone
  ['users/leo', 'everyone', null, 'write'], // ignored: rules under users/ never apply
  ['users', 'everyone', null, 'write'], // ignored too: users/ itself is read-only and never opens users/<id>/
]
const P: Record<string, Principal> = {
  olga: { id: 'olga', name: 'Olga', role: 'owner', groups: [] },
  adam: { id: 'adam', name: 'Adam', role: 'admin', groups: [] },
  mia: { id: 'mia', name: 'Mia', role: 'member', groups: ['sales', 'ops'] },
  leo: { id: 'leo', name: 'Leo', role: 'member', groups: ['sales'] },
  ola: { id: 'ola', name: 'Ola', role: 'member', groups: ['ops'] },
  nobody: { id: 'nobody', name: 'No', role: 'member', groups: [] },
}
const TABLE: [string, string, Access][] = [
  // owner / admin: everything except other people's personal folders and .system
  ['olga', 'groups/sales/plan.md', 'write'], ['olga', 'users/olga/a.md', 'write'], ['olga', 'users/leo/a.md', 'none'], ['olga', '.system/history/x', 'none'],
  ['adam', 'groups/ops', 'write'], ['adam', 'skills/rules.md', 'write'], ['adam', 'users/leo', 'none'], ['adam', 'users/adam/x', 'write'],
  // root everyone read reaches plain folders, never personal ones
  ['nobody', 'readme.md', 'read'], ['nobody', 'users/leo/a.md', 'none'], ['nobody', 'users', 'read'], ['olga', 'users', 'read'], ['nobody', 'users/nobody/x', 'write'],
  ['leo', 'users/leo/a.md', 'write'], ['mia', 'users/leo/a.md', 'none'],
  // deepest folder with a rule that applies to the person
  ['leo', 'groups/sales/plan.md', 'write'], ['leo', 'groups/sales/archive/old.md', 'read'], ['nobody', 'groups/sales/plan.md', 'none'],
  ['nobody', 'groups/sales/archive/old.md', 'none'], // archive has no rule for them -> groups/sales (role member none)
  ['ola', 'groups/ops/a', 'read'], ['ola', 'groups/sales/a', 'none'],
  // personal > group (widest) > role > everyone
  ['mia', 'projects/x/a', 'none'], ['leo', 'projects/x/a', 'read'], ['ola', 'projects/x/a', 'write'], ['nobody', 'projects/x/a', 'write'],
  ['leo', 'projects/x/drafts/d.md', 'write'], ['ola', 'projects/x/drafts/d.md', 'write'], ['mia', 'projects/x/drafts/d.md', 'none'],
  ['nobody', 'projects/y/a', 'read'], ['adam', 'projects/y/a', 'write'],
  ['nobody', 'skills/a', 'read'], ['nobody', 'shared/a', 'write'], ['nobody', '.system/x', 'none'],
]

describe('permission resolution table (tab 2)', () => {
  const rules = new RuleSet(RULES.map(([p, t, s, a]) => ({ path: p, subject_type: t, subject_id: s, access: a })))
  for (const [u, p, want] of TABLE) {
    test(`${u} ${p} -> ${want}`, () => { expect(rules.access(P[u]!, p.split('/'))).toBe(want) })
  }
  test('navigation: users/ is listable for everyone (own folder), other personal folders never', () => {
    expect(rules.canList(P.nobody!, ['users'])).toBe(true)
    expect(rules.canList(P.olga!, ['users', 'leo'])).toBe(false)
    expect(rules.canList(P.adam!, ['users', 'leo'])).toBe(false)
    expect(rules.canList(P.olga!, ['users', 'olga'])).toBe(true)
  })
  test('readLosses reports the top-most folders where read access disappears', () => {
    const before = { principals: Object.values(P), rules }
    const after = { principals: Object.values(P), rules: new RuleSet(RULES.filter(([p]) => p !== 'groups/sales/archive').map(([p, t, s, a]) => ({ path: p, subject_type: t, subject_id: s, access: a })).concat([{ path: 'groups/sales', subject_type: 'group', subject_id: 'sales', access: 'none' }]).filter((r) => !(r.path === 'groups/sales' && r.access === 'write'))) }
    const lost = readLosses(before, after)
    expect(lost.get('leo')).toEqual(['groups/sales'])
    expect(lost.get('mia')).toEqual(['groups/sales'])
    expect(lost.has('olga')).toBe(false)
    expect(lost.has('ola')).toBe(false)
  })
})

// ---------------- API ----------------
describe('folders API', () => {
  let h: Harness
  let owner: Client
  let admin: Client
  let alice: { client: Client; id: string }
  let bob: { client: Client; id: string }
  let sales: string
  beforeAll(async () => {
    h = await harness('folders')
    owner = await withOwner(h)
    admin = (await addMember(h, owner, { username: 'adam', role: 'admin' })).client
    sales = (await admin.call('POST', '/api/admin/groups', { name: 'Sales' })).id
    alice = await addMember(h, owner, { username: 'alice', groupIds: [sales] })
    bob = await addMember(h, owner, { username: 'bob' })
  })
  afterAll(() => h.close())
  const root = () => h.ctx.files.fx.root

  test('creating a group creates groups/<name>/ with "this group writes"', async () => {
    const f = (await admin.call('GET', '/api/admin/folders')).items.find((x: any) => x.path === 'groups/Sales')
    expect(f.exists).toBe(true)
    expect(f.rules).toMatchObject([{ subjectType: 'group', subjectId: sales, access: 'write', updatedBy: { id: 'adam' } }])
    const ko = await admin.call('POST', '/api/admin/groups', { name: '재무팀', memberIds: [bob.id] })
    expect(fs.statSync(path.join(root(), 'groups', '재무팀')).isDirectory()).toBe(true)
    expect(ko.memberIds).toEqual([bob.id])
    const odd = await admin.call('POST', '/api/admin/groups', { name: 'R&D: lab?' })
    expect((await admin.call('GET', '/api/admin/folders')).items.some((x: any) => x.path === `groups/group-${odd.id.slice(-8)}`)).toBe(true)
    expect((await admin.try('POST', '/api/admin/groups', { name: 'sales' })).status).toBe(409)
    expect((await admin.try('POST', '/api/admin/groups', { name: 'X', memberIds: ['ghost'] })).status).toBe(400)
  })

  test('create folder + rules: on disk, by actual name, not inside users/ or .system, no duplicates', async () => {
    const f = await admin.call('POST', '/api/admin/folders', { path: 'projects/apollo', rules: [{ subjectType: 'user', subjectId: alice.id, access: 'write' }, { subjectType: 'group', subjectId: sales, access: 'read' }] })
    expect(f).toMatchObject({ path: 'projects/apollo', exists: true })
    expect(f.rules).toHaveLength(2)
    expect(fs.statSync(path.join(root(), 'projects', 'apollo')).isDirectory()).toBe(true)
    if (h.ctx.files.fx.caseInsensitive) {
      // the stored path is the on-disk name, whatever case the admin typed
      const g = await admin.call('POST', '/api/admin/folders', { path: 'PROJECTS/Apollo/notes', rules: [] })
      expect(g.path).toBe('projects/apollo/notes')
    }
    for (const bad of ['users/alice', 'users', 'users/alice/x', '.system', '.system/history']) {
      const r = await admin.try('POST', '/api/admin/folders', { path: bad, rules: [] })
      expect(r.status, bad).toBe(400)
    }
    expect((await admin.try('POST', '/api/admin/folders', { path: '../etc', rules: [] })).status).toBe(400)
    expect((await admin.try('POST', '/api/admin/folders', { path: 'missing/one', create: false, rules: [] })).status).toBe(404)
    expect((await admin.try('POST', '/api/admin/folders', { path: 'projects/apollo', rules: [] })).status).toBe(409)
    expect((await admin.try('POST', '/api/admin/folders', { path: 'p2', rules: [{ subjectType: 'everyone', subjectId: null, access: 'read' }, { subjectType: 'everyone', subjectId: null, access: 'write' }] })).status).toBe(400)
    expect((await admin.try('POST', '/api/admin/folders', { path: 'p3', rules: [{ subjectType: 'group', subjectId: uuidv7(), access: 'read' }] })).status).toBe(400)
    expect((await admin.try('POST', '/api/admin/folders', { path: 'p4', rules: [{ subjectType: 'role', subjectId: 'owner', access: 'read' }] })).status).toBe(400)
    fs.writeFileSync(path.join(root(), 'shared', 'file.md'), 'x')
    expect((await admin.try('POST', '/api/admin/folders', { path: 'shared/file.md', rules: [] })).status).toBe(400)
    // and the stored rules take effect for the file tools right away
    expect(h.ctx.files.rules().access(h.ctx.files.principal(alice.id), ['projects', 'apollo', 'x.md'])).toBe('write')
    expect(h.ctx.files.rules().access(h.ctx.files.principal(bob.id), ['projects', 'apollo', 'x.md'])).toBe('none')
  })

  test('preview shows before/after per person and who loses access, without saving', async () => {
    const before = (await admin.call('GET', '/api/admin/folders')).items
    const p = await admin.call('POST', '/api/admin/folder-rules/preview', { changes: [{ path: 'projects/apollo', rules: [{ subjectType: 'user', subjectId: bob.id, access: 'read' }] }] })
    const row = p.folders.find((f: any) => f.path === 'projects/apollo')
    const by = Object.fromEntries(row.users.map((u: any) => [u.user.id, `${u.before}->${u.after}`]))
    expect(by).toMatchObject({ [alice.id]: 'write->none', [bob.id]: 'none->read', adam: 'write->write', olga: 'write->write' })
    expect(p.losing).toEqual([{ user: { id: alice.id, name: 'ALICE' }, paths: ['projects/apollo'], chatsReset: 0 }])
    expect((await admin.call('GET', '/api/admin/folders')).items).toEqual(before)
    expect((await admin.try('POST', '/api/admin/folder-rules/preview', { changes: [{ path: 'users/bob', rules: [] }] })).status).toBe(400)
    // a new (not yet existing) folder can be previewed
    const n = await admin.call('POST', '/api/admin/folder-rules/preview', { changes: [{ path: 'shared/new-area', rules: [{ subjectType: 'everyone', subjectId: null, access: 'none' }] }] })
    expect(n.losing.map((l: any) => l.user.id).sort()).toEqual([alice.id, bob.id].sort())
  })

  test('saving rules that remove read access resets that person\'s engine sessions (H7), audits and notifies', async () => {
    const chatA = uuidv7(), chatB = uuidv7()
    h.ctx.db.query("INSERT INTO chats (id, user_id, engine_session_id) VALUES (?, ?, 'sess-a'), (?, ?, 'sess-b')").run(chatA, alice.id, chatB, bob.id)
    for (const c of [chatA, chatB]) { fs.mkdirSync(path.join(h.ctx.config.dataDir, 'sessions', c), { recursive: true }); fs.writeFileSync(path.join(h.ctx.config.dataDir, 'sessions', c, 's.jsonl'), '{}') }
    const preview = await admin.call('POST', '/api/admin/folder-rules/preview', { changes: [{ path: 'projects/apollo', rules: [{ subjectType: 'user', subjectId: bob.id, access: 'read' }] }] })
    expect(preview.losing[0].chatsReset).toBe(1)
    const f = (await admin.call('GET', '/api/admin/folders')).items.find((x: any) => x.path === 'projects/apollo')
    h.hub.events = []
    const put = await admin.call('PUT', `/api/admin/folders/${f.id}/rules`, { rules: [{ subjectType: 'user', subjectId: bob.id, access: 'read' }] })
    expect(put.rules.map((r: any) => r.subjectId)).toEqual([bob.id])
    expect(h.ctx.db.query('SELECT engine_session_id FROM chats WHERE id = ?').get(chatA)).toEqual({ engine_session_id: null })
    expect(fs.existsSync(path.join(h.ctx.config.dataDir, 'sessions', chatA))).toBe(false)
    expect(h.ctx.db.query('SELECT engine_session_id FROM chats WHERE id = ?').get(chatB)).toEqual({ engine_session_id: 'sess-b' }) // bob gained access only
    expect(fs.existsSync(path.join(h.ctx.config.dataDir, 'sessions', chatB))).toBe(true)
    const notices = h.hub.events.filter((e) => e.kind === 'publish').map((e) => [e.target, (e.data as any).data.code])
    expect(notices).toContainEqual([alice.id, 'access_changed'])
    expect(notices).toContainEqual([bob.id, 'access_changed'])
    const audit = await owner.call('GET', '/api/admin/audit?source=admin')
    const lost = audit.items.find((e: any) => e.action === 'folder.access_lost')
    expect(lost.detail.losing).toEqual([{ userId: alice.id, paths: ['projects/apollo'], chatsReset: 1 }])
    expect(audit.items.find((e: any) => e.action === 'folder.rules').detail.after).toEqual([{ subjectType: 'user', subjectId: bob.id, access: 'read' }])
  })

  test('removing someone from a group is an access change too (H7)', async () => {
    const chat = uuidv7()
    h.ctx.db.query("INSERT INTO chats (id, user_id, engine_session_id) VALUES (?, ?, 'sess-g')").run(chat, alice.id)
    await admin.call('PATCH', `/api/admin/groups/${sales}`, { memberIds: [] })
    expect(h.ctx.db.query('SELECT engine_session_id FROM chats WHERE id = ?').get(chat)).toEqual({ engine_session_id: null })
    expect(h.ctx.files.rules().access(h.ctx.files.principal(alice.id), ['groups', 'Sales', 'a.md'])).toBe('none')
    await admin.call('PATCH', `/api/admin/groups/${sales}`, { memberIds: [alice.id] })
    expect(h.ctx.files.rules().access(h.ctx.files.principal(alice.id), ['groups', 'Sales', 'a.md'])).toBe('write')
  })

  test('deleting rules / folders / groups', async () => {
    const f = await admin.call('POST', '/api/admin/folders', { path: 'tmp-area', rules: [{ subjectType: 'everyone', subjectId: null, access: 'read' }] })
    await admin.call('DELETE', `/api/admin/folders/${f.id}`)
    expect((await admin.call('GET', '/api/admin/folders')).items.some((x: any) => x.id === f.id)).toBe(false)
    expect(fs.existsSync(path.join(root(), 'tmp-area'))).toBe(true) // the folder on disk stays
    expect((await admin.try('DELETE', `/api/admin/folders/${f.id}`)).status).toBe(404)
    const g = await admin.call('POST', '/api/admin/groups', { name: 'Temp', memberIds: [bob.id] })
    await admin.call('DELETE', `/api/admin/groups/${g.id}`)
    const tempFolder = (await admin.call('GET', '/api/admin/folders')).items.find((x: any) => x.path === 'groups/Temp')
    expect(tempFolder.rules).toEqual([])
    expect((await admin.call('GET', '/api/admin/groups')).items.some((x: any) => x.id === g.id)).toBe(false)
  })

  test('a moved / restored rule under users/ is ignored by the permission function', async () => {
    const fid = uuidv7()
    h.ctx.db.query("INSERT INTO folders (id, path) VALUES (?, 'users/' || ?)").run(fid, alice.id)
    h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'everyone', NULL, 'write')").run(uuidv7(), fid)
    expect(h.ctx.files.rules().access(h.ctx.files.principal(bob.id), ['users', alice.id, 'x'])).toBe('none')
    expect(h.ctx.files.rules().access(h.ctx.files.principal('olga'), ['users', alice.id, 'x'])).toBe('none')
    const s = captureState(h.ctx.db)
    expect(s.rules.ruleFolders()).toContain(`users/${alice.id}`)
  })
})

describe('resolution against the stage-1 fixture DB', () => {
  test('captureState loads active people with their groups', () => {
    const db = openDb(':memory:')
    db.exec("INSERT INTO users (id, username, name, role) VALUES ('a','a','A','member'), ('b','b','B','member')")
    db.exec("UPDATE users SET status = 'disabled' WHERE id = 'b'")
    db.exec("INSERT INTO groups (id, name) VALUES ('g','G'); INSERT INTO group_members VALUES ('g','a')")
    const s = captureState(db)
    expect(s.principals).toEqual([{ id: 'a', name: 'A', role: 'member', groups: ['g'] }])
    db.close()
  })
})
