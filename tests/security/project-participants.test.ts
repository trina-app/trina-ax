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
    expect([a.status, a.body.editable]).toEqual([200, false])
    const r = await put('alice', legacy, [user('bob')], a.body.rulesHash)
    expect([r.status, r.body.error.params.reason]).toEqual([409, 'project_not_editable'])
    expect(rulesAt('groups/marketing')).toEqual([{ t: 'group', s: 'marketing', a: 'write' }])
    expect((await preview('alice', { projectId: legacy, participants: [] })).status).toBe(409)
  })
})

describe('the dry run', () => {
  test('a new project: who would see it', async () => {
    expect((await preview('alice', { participants: [] })).body).toEqual({ people: 3, added: 0, removed: 0, files: 0, othersFiles: 0, sharedChats: 0, skills: 0 })
    expect((await preview('alice', { participants: [group('marketing'), user('bob')] })).body.people).toBe(5)
    expect((await preview('alice', { participants: [group('finance')] })).status).toBe(400)
  })

  test('widening counts files others put there, shared chats and project skills; narrowing counts none', async () => {
    const p = await create('alice', { name: 'Counted', participants: [user('erin')] })
    expect((await A.json('/api/files/content', { as: 'alice', ...jsonBody({ path: `${p.folderPath}/mine.md`, content: 'a', baseSha256: null }, 'PUT') })).status).toBe(200)
    expect((await A.json('/api/files/content', { as: 'erin', ...jsonBody({ path: `${p.folderPath}/erins.md`, content: 'e', baseSha256: null }, 'PUT') })).status).toBe(200)
    write(`${p.folderPath}/dropped-in.md`, 'no event') // put there outside the app: counted as someone else's
    write(`${p.folderPath}/skills/quote/SKILL.md`, '---\nname: quote\ndescription: x\n---\n')
    write(`${p.folderPath}/skills/quote/table.md`, 'x')
    write(`${p.folderPath}/skills/readme.md`, 'not a skill')
    write(`${p.folderPath}/skills/empty/notes.md`, 'not a skill either')
    sharedChat(p.id, 'erin')
    sharedChat(p.id, 'alice')
    const r = await preview('alice', { projectId: p.id, participants: [user('erin'), user('bob')] })
    expect(r.body).toEqual({ people: 5, added: 1, removed: 0, files: 3, othersFiles: 2, sharedChats: 2, skills: 1 })
    // the admin asking: alice's file is someone else's too
    expect((await preview('carol', { projectId: p.id, participants: [user('erin'), group('finance')] })).body).toMatchObject({ added: 1, files: 3, othersFiles: 3 })
    // narrowing: nothing to confirm
    expect((await preview('alice', { projectId: p.id, participants: [] })).body).toEqual({ people: 3, added: 0, removed: 1, files: 0, othersFiles: 0, sharedChats: 0, skills: 0 })
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
