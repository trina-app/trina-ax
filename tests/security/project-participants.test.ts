// Who sees a team project (docs/DECISIONS.md "Projects live only in projects/"): its creator and admins see and change
// its participants from the project's edit screen, which writes the folder rules the same way Admin › Folder permissions
// does (the rules hash, afterAccessChange, the audit). A dry run says what the people who gain it would see.
// Fixture: alice, erin = marketing (group id 'marketing'); bob = finance ('finance'); carol = admin; dana = owner.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { uuidv7 } from '@mycel/shared/api'
import { jsonBody, makeCApp, type CApp } from '../lib/c-app'
import { ensureFolderRow, replaceRules, rulesHashAt } from '../../server/src/admin/folders'

let A: CApp
beforeAll(async () => { A = await makeCApp('sec-project-participants') })
afterAll(async () => { await A.close() })
type Who = 'alice' | 'bob' | 'carol' | 'dana' | 'erin'
const create = async (who: Who, body: Record<string, unknown>) => {
  const r = await A.json('/api/projects', { as: who, ...jsonBody({ instructions: '', ...body }) })
  expect(r.status).toBe(201)
  return r.body as { id: string; folderPath: string }
}
const access = (who: Who, id: string) => A.json(`/api/projects/${id}/access`, { as: who })
const put = (who: Who, id: string, participants: unknown[], expectedHash: string) => A.json(`/api/projects/${id}/participants`, { as: who, ...jsonBody({ participants, expectedHash }, 'PUT') })
const preview = (who: Who, body: Record<string, unknown>) => A.json('/api/projects/access-preview', { as: who, ...jsonBody(body) })
const listed = async (who: Who, id: string) => ((await A.json('/api/projects', { as: who })).body.items as { id: string }[]).some((p) => p.id === id)
const rulesAt = (p: string) => (A.ctx.db.query('SELECT r.subject_type AS t, r.subject_id AS s, r.access AS a FROM folder_rules r JOIN folders f ON f.id = r.folder_id WHERE f.path = ? ORDER BY t, s').all(p) as { t: string; s: string | null; a: string }[])
const user = (id: string) => ({ subjectType: 'user', subjectId: id })
const group = (id: string) => ({ subjectType: 'group', subjectId: id })
const write = (rel: string, text: string) => { const p = path.join(A.team, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) }
const sharedChat = (projectId: string, by: string) => {
  const id = uuidv7()
  A.ctx.db.query("INSERT INTO chats (id, user_id, project_id, title, shared_at) VALUES (?, ?, ?, 'plan', strftime('%Y-%m-%dT%H:%M:%fZ','now'))").run(id, by, projectId)
  return id
}

describe('who may see and change participants', () => {
  test('the creator and admins; a participant or anyone else may not', async () => {
    const p = await create('alice', { name: 'Who', participants: [user('erin')] })
    for (const who of ['alice', 'carol', 'dana'] as const) {
      const r = await access(who, p.id)
      expect(r.status).toBe(200)
      expect(r.body).toMatchObject({ editable: true, people: 4, otherRules: [] })
      expect(r.body.participants).toEqual([{ subjectType: 'user', subjectId: 'alice', name: 'Alice Kim', creator: true }, { subjectType: 'user', subjectId: 'erin', name: 'Erin Yoo' }])
    }
    // erin sees the project but did not make it; bob does not see it at all
    expect((await access('erin', p.id)).status).toBe(403)
    expect((await access('bob', p.id)).status).toBe(404)
    const hash = (await access('alice', p.id)).body.rulesHash
    expect((await put('erin', p.id, [user('erin'), user('bob')], hash)).status).toBe(403)
    expect((await put('bob', p.id, [user('bob')], hash)).status).toBe(404)
    expect((await preview('erin', { projectId: p.id, participants: [] })).status).toBe(403)
    expect((await preview('bob', { projectId: p.id, participants: [] })).status).toBe(404)
    expect(rulesAt(p.folderPath)).toEqual([{ t: 'everyone', s: null, a: 'none' }, { t: 'user', s: 'alice', a: 'write' }, { t: 'user', s: 'erin', a: 'write' }])
  })

  test('saved like Admin › Folder permissions: the creator is always kept, audited, the people who gained it told', async () => {
    const p = await create('alice', { name: 'Grow' })
    A.hub.clear()
    const hash = (await access('alice', p.id)).body.rulesHash
    // the creator left out by the screen: kept anyway
    const r = await put('alice', p.id, [group('marketing'), user('bob')], hash)
    expect(r.status).toBe(200)
    expect(rulesAt(p.folderPath)).toEqual([{ t: 'everyone', s: null, a: 'none' }, { t: 'group', s: 'marketing', a: 'write' }, { t: 'user', s: 'alice', a: 'write' }, { t: 'user', s: 'bob', a: 'write' }])
    for (const who of ['bob', 'erin'] as const) expect(await listed(who, p.id)).toBe(true)
    const row = A.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'folder.rules' AND target = ? ORDER BY rowid DESC LIMIT 1").get(p.folderPath) as { detail: string }
    expect(JSON.parse(row.detail)).toMatchObject({ via: 'project', projectId: p.id })
    expect(A.hub.events.filter((e) => e.ev.type === 'notice' && (e.ev.data as any).code === 'access_changed').map((e) => e.userId).sort()).toEqual(['bob', 'erin'])
    // a member adds only their own groups: finance is bob's, not alice's
    const again = (await access('alice', p.id)).body.rulesHash
    expect((await put('alice', p.id, [group('marketing'), group('finance')], again)).status).toBe(400)
    // an admin may add any group; the member creator may then keep it
    expect((await put('carol', p.id, [group('marketing'), group('finance')], again)).status).toBe(200)
    const kept = await put('alice', p.id, [group('finance')], (await access('alice', p.id)).body.rulesHash)
    expect(kept.status).toBe(200)
    expect(kept.body.participants.map((x: { subjectId: string }) => x.subjectId)).toEqual(['alice', 'finance'])
  })

  test('rules the screen does not change stay as they are and are shown read-only', async () => {
    const p = await create('alice', { name: 'Ruled', participants: [user('erin')] })
    const row = ensureFolderRow(A.ctx.db, p.folderPath)
    A.ctx.db.transaction(() => replaceRules(A.ctx.db, row.id, [
      { subjectType: 'user', subjectId: 'alice', access: 'write' }, { subjectType: 'user', subjectId: 'erin', access: 'write' },
      { subjectType: 'group', subjectId: 'finance', access: 'read' }, { subjectType: 'everyone', subjectId: null, access: 'none' },
    ], 'carol'))()
    const sub = ensureFolderRow(A.ctx.db, `${p.folderPath}/hr`)
    A.ctx.db.transaction(() => replaceRules(A.ctx.db, sub.id, [{ subjectType: 'user', subjectId: 'erin', access: 'none' }], 'carol'))()
    const a = (await access('alice', p.id)).body
    expect(a.otherRules).toEqual([
      { path: p.folderPath, subjectType: 'group', subjectId: 'finance', name: 'Finance', access: 'read' },
      { path: `${p.folderPath}/hr`, subjectType: 'user', subjectId: 'erin', name: 'Erin Yoo', access: 'none' },
    ])
    // dropping erin keeps finance's read rule and the sub-rule; finance cannot be made a writer from here
    expect((await put('alice', p.id, [], a.rulesHash)).status).toBe(200)
    expect(rulesAt(p.folderPath)).toEqual([{ t: 'everyone', s: null, a: 'none' }, { t: 'group', s: 'finance', a: 'read' }, { t: 'user', s: 'alice', a: 'write' }])
    expect(rulesAt(`${p.folderPath}/hr`)).toEqual([{ t: 'user', s: 'erin', a: 'none' }])
    const fixed = await put('carol', p.id, [group('finance')], (await access('alice', p.id)).body.rulesHash)
    expect([fixed.status, fixed.body.error.params.reason]).toEqual([400, 'participant_fixed'])
  })

  test('a project outside projects/ is not changed from its screen (Admin › Folder permissions)', async () => {
    const legacy = uuidv7()
    A.ctx.db.query("INSERT INTO projects (id, name, folder_path, instructions, created_by, created_at) VALUES (?, 'Old', 'groups/marketing', '', 'alice', '2026-01-01T00:00:00Z')").run(legacy)
    const a = await access('alice', legacy)
    // a member gets the count only: the folder's rules are an admin's
    expect(a.status).toBe(200)
    expect(a.body).toMatchObject({ editable: false, participants: [], otherRules: [] })
    expect(a.body.rulesHash).toBe('') // no hash of an admin's rules for a member
    const r = await put('alice', legacy, [user('bob')], 'any-hash')
    expect([r.status, r.body.error.params.reason]).toEqual([409, 'project_not_editable'])
    expect(rulesAt('groups/marketing')).toEqual([{ t: 'group', s: 'marketing', a: 'write' }])
    expect((await preview('alice', { projectId: legacy, participants: [] })).status).toBe(409)
  })
})

describe('what a member may not reach through a project (review)', () => {
  test('an older project of hers on an admin\'s projects/<name> folder: its rules stay the admins\'', async () => {
    // an admin made projects/hr for marketing; alice, a member who could write it, made a project on it in an older build
    fs.mkdirSync(path.join(A.team, 'projects/hr'), { recursive: true })
    const row = ensureFolderRow(A.ctx.db, 'projects/hr')
    A.ctx.db.transaction(() => replaceRules(A.ctx.db, row.id, [{ subjectType: 'group', subjectId: 'marketing', access: 'write' }], 'carol'))()
    const id = uuidv7()
    A.ctx.db.query("INSERT INTO projects (id, name, folder_path, instructions, created_by, created_at) VALUES (?, 'HR', 'projects/hr', '', 'alice', '2026-01-01T00:00:00Z')").run(id)
    const a = await access('alice', id)
    expect(a.body).toMatchObject({ editable: false, participants: [], otherRules: [], rulesHash: '' })
    const r = await put('alice', id, [user('bob')], 'any-hash')
    expect([r.status, r.body.error.params.reason]).toEqual([409, 'project_not_editable'])
    expect((await preview('alice', { projectId: id, participants: [user('bob')] })).status).toBe(409)
    const del = await A.json(`/api/projects/${id}?trashFolder=1`, { as: 'alice', method: 'DELETE' })
    expect([del.status, del.body.error.params.reason]).toEqual([409, 'project_folder_stays'])
    expect(rulesAt('projects/hr')).toEqual([{ t: 'group', s: 'marketing', a: 'write' }])
    expect(fs.existsSync(path.join(A.team, 'projects/hr'))).toBe(true)
    // an admin sees and changes it
    const c = await access('carol', id)
    expect(c.body.editable).toBe(true)
    expect(c.body.participants).toEqual([{ subjectType: 'group', subjectId: 'marketing', name: 'Marketing' }])
  })

  test('a folder inside her project that she cannot see is neither named nor counted', async () => {
    const p = await create('alice', { name: 'Hidden inside', participants: [user('erin')] })
    write(`${p.folderPath}/brief.md`, 'b')
    // an admin's restricted folder inside: finance only
    const sub = ensureFolderRow(A.ctx.db, `${p.folderPath}/payroll-2027`)
    A.ctx.db.transaction(() => replaceRules(A.ctx.db, sub.id, [{ subjectType: 'everyone', subjectId: null, access: 'none' }, { subjectType: 'group', subjectId: 'finance', access: 'write' }], 'carol'))()
    write(`${p.folderPath}/payroll-2027/a.md`, 'x')
    write(`${p.folderPath}/payroll-2027/b.md`, 'x')
    const mine = await access('alice', p.id)
    expect(JSON.stringify(mine.body)).not.toContain('payroll-2027')
    expect(JSON.stringify(mine.body)).not.toContain('Finance')
    // a folder she can only list (something below it is readable): its rules stay the admins' too
    const v = ensureFolderRow(A.ctx.db, `${p.folderPath}/vault`)
    A.ctx.db.transaction(() => replaceRules(A.ctx.db, v.id, [{ subjectType: 'everyone', subjectId: null, access: 'none' }, { subjectType: 'group', subjectId: 'finance', access: 'write' }], 'carol'))()
    const vb = ensureFolderRow(A.ctx.db, `${p.folderPath}/vault/open`)
    A.ctx.db.transaction(() => replaceRules(A.ctx.db, vb.id, [{ subjectType: 'user', subjectId: 'alice', access: 'read' }], 'carol'))()
    const listed2 = (await access('alice', p.id)).body.otherRules.map((r: { path: string }) => r.path)
    expect(listed2).toContain(`${p.folderPath}/vault/open`)
    expect(listed2).not.toContain(`${p.folderPath}/vault`)
    expect((await access('carol', p.id)).body.otherRules.map((r: { path: string }) => r.path)).toContain(`${p.folderPath}/payroll-2027`)
    // bob (finance) would read the payroll files once added: alice is told of the brief only
    expect((await preview('alice', { projectId: p.id, participants: [user('erin'), user('bob')] })).body).toMatchObject({ added: 1, files: 1 })
    expect((await preview('carol', { projectId: p.id, participants: [user('erin'), user('bob')] })).body).toMatchObject({ added: 1, files: 3 })
  })

  test('trashing her project\'s folder never takes what is managed inside it: another project, a rule folder', async () => {
    const p = await create('alice', { name: 'Outer', participants: [user('erin')] })
    // erin's older project on a folder inside it
    write(`${p.folderPath}/sub/x.md`, 'x')
    const inner = uuidv7()
    A.ctx.db.query("INSERT INTO projects (id, name, folder_path, instructions, created_by, created_at) VALUES (?, 'Inner', ?, '', 'erin', '2026-01-01T00:00:00Z')").run(inner, `${p.folderPath}/sub`)
    const r = await A.json(`/api/projects/${p.id}?trashFolder=1`, { as: 'alice', method: 'DELETE' })
    expect(r.status).toBe(403)
    expect(fs.existsSync(path.join(A.team, p.folderPath))).toBe(true)
    expect(A.ctx.db.query('SELECT trashed_with FROM projects WHERE id = ?').get(inner)).toEqual({ trashed_with: null })
    expect(A.ctx.db.query('SELECT 1 AS x FROM projects WHERE id = ?').get(p.id)).toEqual({ x: 1 })
    A.ctx.db.query('DELETE FROM projects WHERE id = ?').run(inner)
    // an admin's rule folder inside it that alice can write: still the admins' to trash (managed inside)
    const w = await create('alice', { name: 'Writable inside', participants: [user('erin')] })
    const ws = ensureFolderRow(A.ctx.db, `${w.folderPath}/contracts`)
    A.ctx.db.transaction(() => replaceRules(A.ctx.db, ws.id, [{ subjectType: 'user', subjectId: 'alice', access: 'write' }, { subjectType: 'group', subjectId: 'finance', access: 'write' }], 'carol'))()
    expect((await A.json(`/api/projects/${w.id}?trashFolder=1`, { as: 'alice', method: 'DELETE' })).status).toBe(403)
    expect(fs.existsSync(path.join(A.team, w.folderPath))).toBe(true)
    // a rule folder inside it alice cannot write stops it too, and nothing changes
    const q = await create('alice', { name: 'Ruled inside', participants: [user('erin')] })
    const sub = ensureFolderRow(A.ctx.db, `${q.folderPath}/legal`)
    A.ctx.db.transaction(() => replaceRules(A.ctx.db, sub.id, [{ subjectType: 'user', subjectId: 'alice', access: 'read' }], 'carol'))()
    const chat = sharedChat(q.id, 'erin')
    const s2 = await A.json(`/api/projects/${q.id}?trashFolder=1`, { as: 'alice', method: 'DELETE' })
    expect(s2.status).toBe(403)
    expect(A.ctx.db.query('SELECT shared_at IS NOT NULL AS s, deleted_at FROM chats WHERE id = ?').get(chat)).toEqual({ s: 1, deleted_at: null })
    expect(fs.existsSync(path.join(A.team, q.folderPath))).toBe(true)
    // an admin may
    expect((await A.json(`/api/projects/${q.id}?trashFolder=1`, { as: 'carol', method: 'DELETE' })).status).toBe(204)
    expect(fs.existsSync(path.join(A.team, q.folderPath))).toBe(false)
  })
})

describe('the dry run', () => {
  test('a new project: who would see it', async () => {
    expect((await preview('alice', { participants: [] })).body).toEqual({ people: 3, added: 0, removed: 0, files: 0, othersFiles: 0, sharedChats: 0, skills: 0, skillNames: [] })
    expect((await preview('alice', { participants: [group('marketing'), user('bob')] })).body.people).toBe(5)
    expect((await preview('alice', { participants: [group('finance')] })).status).toBe(400)
  })

  test('widening counts files others put there, shared chats and project skills; narrowing counts none', async () => {
    const p = await create('alice', { name: 'Counted', participants: [user('erin')] })
    expect((await A.json('/api/files/content', { as: 'alice', ...jsonBody({ path: `${p.folderPath}/mine.md`, content: 'a', baseSha256: null }, 'PUT') })).status).toBe(200)
    expect((await A.json('/api/files/content', { as: 'erin', ...jsonBody({ path: `${p.folderPath}/erins.md`, content: 'e', baseSha256: null }, 'PUT') })).status).toBe(200)
    write(`${p.folderPath}/dropped-in.md`, 'no event') // put there outside the app: counted as someone else's
    write(`${p.folderPath}/skills/견적서/SKILL.md`, '---\nname: 견적서\ndescription: x\n---\n')
    write(`${p.folderPath}/skills/견적서/table.md`, 'x')
    write(`${p.folderPath}/skills/견적-현장/SKILL.md`, '---\nname: 견적-현장\ndescription: x\n---\n')
    write(`${p.folderPath}/skills/readme.md`, 'not a skill')
    write(`${p.folderPath}/skills/empty/notes.md`, 'not a skill either')
    // a SKILL.md folder one level further down loads too (chat/skills.ts); one more level down does not
    write(`${p.folderPath}/skills/현장/점검/SKILL.md`, '---\nname: 점검\ndescription: x\n---\n')
    write(`${p.folderPath}/skills/현장/깊이/너무/SKILL.md`, '---\nname: 너무\ndescription: x\n---\n')
    sharedChat(p.id, 'erin')
    sharedChat(p.id, 'alice')
    const r = await preview('alice', { projectId: p.id, participants: [user('erin'), user('bob')] })
    // the project skills are counted and named: the people who gain the project use them in its chats
    expect(r.body).toEqual({ people: 5, added: 1, removed: 0, files: 3, othersFiles: 2, sharedChats: 2, skills: 3, skillNames: ['견적-현장', '견적서', '점검'].sort((a, b) => a.localeCompare(b)) })
    // the admin asking: alice's file is someone else's too
    expect((await preview('carol', { projectId: p.id, participants: [user('erin'), group('finance')] })).body).toMatchObject({ added: 1, files: 3, othersFiles: 3 })
    // narrowing: nothing to confirm
    expect((await preview('alice', { projectId: p.id, participants: [] })).body).toEqual({ people: 3, added: 0, removed: 1, files: 0, othersFiles: 0, sharedChats: 0, skills: 0, skillNames: [] })
    // a sub-folder nobody added may read is not counted
    const sub = ensureFolderRow(A.ctx.db, `${p.folderPath}/private`)
    A.ctx.db.transaction(() => replaceRules(A.ctx.db, sub.id, [{ subjectType: 'everyone', subjectId: null, access: 'none' }], 'carol'))()
    write(`${p.folderPath}/private/payroll.md`, 'x')
    expect((await preview('alice', { projectId: p.id, participants: [user('erin'), user('bob')] })).body.files).toBe(3)
  })

  test('the people who saw it before hear it widened; the person changing it does not', async () => {
    const p = await create('alice', { name: 'Heard', participants: [user('erin')] })
    A.hub.clear()
    expect((await put('alice', p.id, [user('erin'), user('bob')], (await access('alice', p.id)).body.rulesHash)).status).toBe(200)
    const told = A.hub.events.filter((e) => e.ev.type === 'notice' && (e.ev.data as any).code === 'project_access_widened')
    expect(told.map((e) => e.userId).sort()).toEqual(['carol', 'dana', 'erin'])
    expect((told[0]!.ev.data as any).message).toContain('Heard')
  })
})

describe('narrowing, conflicts, the creator gone', () => {
  test('narrowing hides the project\'s shared chats from whoever lost it, at once', async () => {
    const p = await create('alice', { name: 'Shared', participants: [user('bob'), user('erin')] })
    const chat = sharedChat(p.id, 'alice')
    expect((await A.json(`/api/chats/${chat}`, { as: 'bob' })).status).toBe(200)
    A.hub.clear()
    expect((await put('alice', p.id, [user('erin')], (await access('alice', p.id)).body.rulesHash)).status).toBe(200)
    expect((await A.json(`/api/chats/${chat}`, { as: 'bob' })).status).toBe(404)
    expect((await A.json(`/api/chats/${chat}`, { as: 'erin' })).status).toBe(200)
    expect(A.hub.of('chat.updated', 'bob').map((e) => e.data)).toEqual([{ chatId: chat, change: 'deleted', chat: null }])
    expect(A.hub.of('chat.updated', 'erin')).toEqual([])
  })

  test('an admin\'s change in between: the project screen gets 409 rules_changed, and so does the admin screen after it', async () => {
    const p = await create('alice', { name: 'Raced', participants: [user('erin')] })
    const hash = (await access('alice', p.id)).body.rulesHash
    const row = A.ctx.db.query('SELECT id FROM folders WHERE path = ?').get(p.folderPath) as { id: string }
    // the hash Admin › Folder permissions shows for the folder (Folder.rulesHash) is the project screen's
    const adminHash = rulesHashAt(A.ctx.db, p.folderPath)
    expect(adminHash).toBe(hash)
    // carol adds bob in Admin › Folder permissions
    const next = [...rulesAt(p.folderPath).map((r) => ({ subjectType: r.t, subjectId: r.s, access: r.a })), { subjectType: 'user', subjectId: 'bob', access: 'read' }]
    expect((await A.json(`/api/admin/folders/${row.id}/rules`, { as: 'carol', ...jsonBody({ rules: next, expectedHash: adminHash }, 'PUT') })).status).toBe(200)
    // alice's screen started before it: refused, nothing undone
    const r = await put('alice', p.id, [], hash)
    expect([r.status, r.body.error.params.reason]).toEqual([409, 'rules_changed'])
    expect(rulesAt(p.folderPath).some((x) => x.s === 'bob')).toBe(true)
    // the other way round: alice saves, then the admin's stale save is refused
    const fresh = (await access('alice', p.id)).body.rulesHash
    expect((await put('alice', p.id, [], fresh)).status).toBe(200)
    const stale = await A.json(`/api/admin/folders/${row.id}/rules`, { as: 'carol', ...jsonBody({ rules: [], expectedHash: fresh }, 'PUT') })
    expect([stale.status, stale.body.error.params.reason]).toEqual([409, 'rules_changed'])
  })

  test('a deleted creator: their rule goes, the project fails closed to the owner and admins', async () => {
    // a member of its own: deleting alice would disturb the other tests
    A.ctx.db.query("INSERT INTO users (id, username, name, role) VALUES ('fay', 'fay', 'Fay Han', 'member')").run()
    A.ctx.db.query("INSERT INTO group_members VALUES ('marketing', 'fay')").run()
    const id = uuidv7()
    fs.mkdirSync(path.join(A.team, 'projects/fays'), { recursive: true })
    const row = ensureFolderRow(A.ctx.db, 'projects/fays')
    // as createProject writes it
    A.ctx.db.transaction(() => replaceRules(A.ctx.db, row.id, [{ subjectType: 'user', subjectId: 'fay', access: 'write' }, { subjectType: 'everyone', subjectId: null, access: 'none' }], 'fay'))()
    A.ctx.db.query("INSERT INTO projects (id, name, folder_path, instructions, created_by, created_at) VALUES (?, 'Fay', 'projects/fays', '', 'fay', '2026-01-01T00:00:00Z')").run(id)
    // and one made before the floor existed: only the creator's rule
    fs.mkdirSync(path.join(A.team, 'projects/fays-old'), { recursive: true })
    const old = ensureFolderRow(A.ctx.db, 'projects/fays-old')
    A.ctx.db.transaction(() => replaceRules(A.ctx.db, old.id, [{ subjectType: 'user', subjectId: 'fay', access: 'write' }], 'fay'))()
    const oldId = uuidv7()
    A.ctx.db.query("INSERT INTO projects (id, name, folder_path, instructions, created_by, created_at) VALUES (?, 'Fay old', 'projects/fays-old', '', 'fay', '2026-01-01T00:00:00Z')").run(oldId)
    const root = ensureFolderRow(A.ctx.db, '')
    A.ctx.db.transaction(() => replaceRules(A.ctx.db, root.id, [{ subjectType: 'everyone', subjectId: null, access: 'read' }], 'carol'))()
    try {
      expect((await A.json('/api/admin/users/fay?personalFolder=delete', { as: 'dana', ...jsonBody({}, 'DELETE') })).status).toBe(204)
      expect(rulesAt('projects/fays')).toEqual([{ t: 'everyone', s: null, a: 'none' }])
      expect(rulesAt('projects/fays-old')).toEqual([{ t: 'everyone', s: null, a: 'none' }])
      for (const pid of [id, oldId]) {
        for (const who of ['alice', 'bob', 'erin'] as const) expect(await listed(who, pid)).toBe(false)
        expect(await listed('carol', pid)).toBe(true)
      }
      // admins manage it now: participants empty, the creator no longer listed
      const a = (await access('carol', id)).body
      expect([a.participants, a.people]).toEqual([[], 2])
      expect((await put('carol', id, [user('erin')], a.rulesHash)).status).toBe(200)
      expect(await listed('erin', id)).toBe(true)
    } finally { A.ctx.db.transaction(() => replaceRules(A.ctx.db, root.id, [], 'carol'))() }
  })
})

describe('the members panel (docs/DECISIONS.md "Project members in one panel")', () => {
  const view = async (who: Who, id: string) => {
    const one = (await A.json(`/api/projects/${id}`, { as: who })).body as Record<string, unknown>
    const inList = ((await A.json('/api/projects', { as: who })).body.items as Record<string, unknown>[]).find((x) => x.id === id)
    expect(inList?.membersEditable).toBe(one.membersEditable)
    expect(inList?.creatorChangesMembers).toBe(one.creatorChangesMembers)
    return { membersEditable: one.membersEditable, creatorChangesMembers: one.creatorChangesMembers }
  }

  test('membersEditable: the creator and admins of a project the server made; a participant reads the creator changes them', async () => {
    const p = await create('alice', { name: 'Panel', participants: [user('erin')] })
    expect(await view('alice', p.id)).toEqual({ membersEditable: true, creatorChangesMembers: true })
    expect(await view('carol', p.id)).toEqual({ membersEditable: true, creatorChangesMembers: true })
    expect(await view('erin', p.id)).toEqual({ membersEditable: false, creatorChangesMembers: true })
    // a personal project has no members: neither field
    const own = await create('alice', { name: 'Panel mine', scope: 'personal' })
    expect(await view('alice', own.id)).toEqual({ membersEditable: undefined, creatorChangesMembers: undefined })
  })

  test('an older project: a member creator on an admin\'s projects/<name> gets no 관리 (only admins), one outside projects/ nobody', async () => {
    fs.mkdirSync(path.join(A.team, 'projects/panel-old'), { recursive: true })
    const row = ensureFolderRow(A.ctx.db, 'projects/panel-old')
    A.ctx.db.transaction(() => replaceRules(A.ctx.db, row.id, [{ subjectType: 'group', subjectId: 'marketing', access: 'write' }], 'carol'))()
    const old = uuidv7()
    A.ctx.db.query("INSERT INTO projects (id, name, folder_path, instructions, created_by, created_at) VALUES (?, 'Panel old', 'projects/panel-old', '', 'alice', '2026-01-01T00:00:00Z')").run(old)
    // alice may edit its name (she writes the folder) but not its members: those are the admins'
    expect((await A.json(`/api/projects/${old}`, { as: 'alice' })).body.canEdit).toBe(true)
    expect(await view('alice', old)).toEqual({ membersEditable: false, creatorChangesMembers: false })
    expect(await view('carol', old)).toEqual({ membersEditable: true, creatorChangesMembers: false })
    expect(await view('erin', old)).toEqual({ membersEditable: false, creatorChangesMembers: false })
    // and what the dialog would have answered: not editable for her, so the page offers nothing that ends there
    expect((await access('alice', old)).body.editable).toBe(false)
    const legacy = uuidv7()
    A.ctx.db.query("INSERT INTO projects (id, name, folder_path, instructions, created_by, created_at) VALUES (?, 'Panel legacy', 'groups/marketing/panel', '', 'alice', '2026-01-01T00:00:00Z')").run(legacy)
    fs.mkdirSync(path.join(A.team, 'groups/marketing/panel'), { recursive: true })
    expect(await view('alice', legacy)).toEqual({ membersEditable: false, creatorChangesMembers: false })
    expect(await view('carol', legacy)).toEqual({ membersEditable: false, creatorChangesMembers: false })
  })

  test('a creator whose account is off is not named as the one who changes members; a folder in the trash has no 관리', async () => {
    // a member of its own, as createProject writes a project (disabling alice would disturb the other tests)
    A.ctx.db.query("INSERT INTO users (id, username, name, role) VALUES ('gus', 'gus', 'Gus Lee', 'member')").run()
    A.ctx.db.query("INSERT INTO group_members VALUES ('marketing', 'gus')").run()
    fs.mkdirSync(path.join(A.team, 'projects/panel-gus'), { recursive: true })
    const row = ensureFolderRow(A.ctx.db, 'projects/panel-gus')
    A.ctx.db.transaction(() => replaceRules(A.ctx.db, row.id, [{ subjectType: 'user', subjectId: 'gus', access: 'write' }, { subjectType: 'user', subjectId: 'erin', access: 'write' }, { subjectType: 'everyone', subjectId: null, access: 'none' }], 'gus'))()
    const p = { id: uuidv7() }
    A.ctx.db.query("INSERT INTO projects (id, name, folder_path, instructions, created_by, created_at, folder_made) VALUES (?, 'Panel gus', 'projects/panel-gus', '', 'gus', '2026-01-01T00:00:00Z', 1)").run(p.id)
    expect(await view('erin', p.id)).toEqual({ membersEditable: false, creatorChangesMembers: true })
    A.ctx.db.query("UPDATE users SET status = 'disabled' WHERE id = 'gus'").run()
    expect(await view('erin', p.id)).toEqual({ membersEditable: false, creatorChangesMembers: false })
    expect(await view('carol', p.id)).toEqual({ membersEditable: true, creatorChangesMembers: false })
    A.ctx.db.query('UPDATE projects SET trashed_with = ? WHERE id = ?').run(uuidv7(), p.id)
    expect(await view('carol', p.id)).toEqual({ membersEditable: false, creatorChangesMembers: false })
  })

  test('the dry run says when the save also writes the floor rule or puts the creator\'s rule back (the screen asks then)', async () => {
    // a folder an older build made: the creator's rule only, no floor; the root opens to everyone
    fs.mkdirSync(path.join(A.team, 'projects/panel-nofloor'), { recursive: true })
    const nf = ensureFolderRow(A.ctx.db, 'projects/panel-nofloor')
    A.ctx.db.transaction(() => replaceRules(A.ctx.db, nf.id, [{ subjectType: 'user', subjectId: 'alice', access: 'write' }], 'alice'))()
    const id = uuidv7()
    A.ctx.db.query("INSERT INTO projects (id, name, folder_path, instructions, created_by, created_at, folder_made) VALUES (?, 'No floor', 'projects/panel-nofloor', '', 'alice', '2026-01-01T00:00:00Z', 1)").run(id)
    const root = ensureFolderRow(A.ctx.db, '')
    A.ctx.db.transaction(() => replaceRules(A.ctx.db, root.id, [{ subjectType: 'everyone', subjectId: null, access: 'read' }], 'carol'))()
    try {
      // nobody gains it and nobody was chosen to go, yet bob and erin lose it: the screen must ask
      const r = await preview('alice', { projectId: id, participants: [] })
      expect(r.body).toMatchObject({ added: 0, addsFloor: true })
      expect(r.body.removed).toBeGreaterThan(0)
      expect(r.body.restoresCreator).toBeUndefined()
    } finally { A.ctx.db.transaction(() => replaceRules(A.ctx.db, root.id, [], 'carol'))() }
    // the creator's rule taken out in Admin › Folder permissions: the save puts it back
    const p = await create('alice', { name: 'Panel creator', participants: [user('erin')] })
    const row = ensureFolderRow(A.ctx.db, p.folderPath)
    A.ctx.db.transaction(() => replaceRules(A.ctx.db, row.id, [{ subjectType: 'user', subjectId: 'erin', access: 'write' }, { subjectType: 'everyone', subjectId: null, access: 'none' }], 'carol'))()
    const c = await preview('carol', { projectId: p.id, participants: [user('erin')] })
    expect(c.body).toMatchObject({ added: 1, restoresCreator: true })
    expect(c.body.addsFloor).toBeUndefined()
    // an ordinary change: neither
    const q = await create('alice', { name: 'Panel plain', participants: [user('erin')] })
    const plain = await preview('alice', { projectId: q.id, participants: [] })
    expect(plain.body).toEqual({ people: 3, added: 0, removed: 1, files: 0, othersFiles: 0, sharedChats: 0, skills: 0, skillNames: [] })
  })
})

describe('share and delete', () => {
  test('sharing a personal project makes projects/<name> with participants and copies the files; nowhere else', async () => {
    const own = await create('alice', { name: '보고서', scope: 'personal' })
    write(`${own.folderPath}/draft.md`, '# draft')
    write(`${own.folderPath}/img/a.txt`, 'a')
    expect((await A.json(`/api/projects/${own.id}/share`, { as: 'alice', ...jsonBody({ toParent: 'shared', participants: [] }) })).status).toBe(400)
    expect((await A.json(`/api/projects/${own.id}/share`, { as: 'alice', ...jsonBody({ toParent: 'groups/marketing', participants: [] }) })).status).toBe(400)
    expect((await A.json(`/api/projects/${own.id}/share`, { as: 'alice', ...jsonBody({ participants: [group('finance')] }) })).status).toBe(400)
    const dry = await A.json(`/api/projects/${own.id}/share`, { as: 'alice', ...jsonBody({ participants: [user('erin')], dryRun: true }) })
    expect(dry.body).toEqual({ viewersAdded: 3 })
    expect(fs.existsSync(path.join(A.team, 'projects/보고서'))).toBe(false)
    const r = await A.json(`/api/projects/${own.id}/share`, { as: 'alice', ...jsonBody({ participants: [user('erin')] }) })
    expect(r.status).toBe(200)
    expect(r.body.folderPath).toBe('projects/보고서')
    expect(fs.readFileSync(path.join(A.team, 'projects/보고서/draft.md'), 'utf8')).toBe('# draft')
    expect(fs.readFileSync(path.join(A.team, 'projects/보고서/img/a.txt'), 'utf8')).toBe('a')
    expect(fs.existsSync(path.join(A.team, own.folderPath, 'draft.md'))).toBe(true)
    expect(rulesAt('projects/보고서')).toEqual([{ t: 'everyone', s: null, a: 'none' }, { t: 'user', s: 'alice', a: 'write' }, { t: 'user', s: 'erin', a: 'write' }])
    expect(await listed('erin', own.id)).toBe(true)
    expect(await listed('bob', own.id)).toBe(false)
    // the copied files are alice's: an admin widening it later counts them as someone else's, alice does not
    expect((await preview('alice', { projectId: own.id, participants: [user('erin'), user('bob')] })).body).toMatchObject({ files: 2, othersFiles: 0 })
    // shared once: a team project now
    expect((await A.json(`/api/projects/${own.id}/share`, { as: 'alice', ...jsonBody({ participants: [] }) })).status).toBe(400)
  })

  test('deleting a project may put its projects/<name> folder in the trash (a member creator too)', async () => {
    const p = await create('alice', { name: 'Gone', participants: [user('erin')] })
    write(`${p.folderPath}/x.md`, 'x')
    // without it the folder stays, and stays admin-only to trash (it carries rules)
    const kept = await create('alice', { name: 'Kept' })
    expect((await A.json(`/api/projects/${kept.id}`, { as: 'alice', method: 'DELETE' })).status).toBe(204)
    expect(fs.existsSync(path.join(A.team, kept.folderPath))).toBe(true)
    expect((await A.json(`/api/projects/${p.id}?trashFolder=1`, { as: 'erin', method: 'DELETE' })).status).toBe(403)
    expect((await A.json(`/api/projects/${p.id}?trashFolder=1`, { as: 'alice', method: 'DELETE' })).status).toBe(204)
    expect(fs.existsSync(path.join(A.team, p.folderPath))).toBe(false)
    expect(A.ctx.db.query('SELECT 1 AS x FROM trash_items WHERE original_path = ? AND restored_at IS NULL').get(p.folderPath)).toEqual({ x: 1 })
    expect(A.ctx.db.query('SELECT 1 AS x FROM projects WHERE id = ?').get(p.id)).toBeNull()
    // a project outside projects/ keeps its folder
    const legacy = uuidv7()
    A.ctx.db.query("INSERT INTO projects (id, name, folder_path, instructions, created_by, created_at) VALUES (?, 'Old', 'groups/marketing/campaigns', '', 'alice', '2026-01-01T00:00:00Z')").run(legacy)
    const r = await A.json(`/api/projects/${legacy}?trashFolder=1`, { as: 'alice', method: 'DELETE' })
    expect([r.status, r.body.error.params.reason]).toEqual([409, 'project_folder_stays'])
    expect(fs.existsSync(path.join(A.team, 'groups/marketing/campaigns'))).toBe(true)
    expect(A.ctx.db.query('SELECT 1 AS x FROM projects WHERE id = ?').get(legacy)).toEqual({ x: 1 })
  })
})
