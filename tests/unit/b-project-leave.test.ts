// Leaving a team project (docs/DECISIONS.md "Leaving a project"; QA TC-1020; chat/project-leave.ts).
// - By name: their rule goes. Through a group: a "no access" rule of their own (an exception), the group stays and the
//   others in it keep the project; the members screen shows it on the group ("except"), not as another rule.
// - Added back by name: the exception becomes write. The group taken out: its exceptions go with it.
// - The creator may leave: the project forgets its creator, no save puts their rule back.
// - The last person who reads it may not (the owner and admins who manage it without being members do not count).
// - Their private chats move to their own chats; shared chats stay; scheduled tasks pause at their next run.
// Fixture (tests/lib/fixtures.ts): alice, erin = marketing; bob = finance; carol = admin; dana = owner.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, ApiError, uuidv7, type ProjectParticipant } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { CONFIRMED } from '../lib/schedule-card'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const code = async (p: Promise<unknown>) => { try { await p; return 'ok' } catch (e) { return e instanceof ApiError ? `${e.status} ${e.code}${e.body.params?.reason ? ` ${e.body.params.reason}` : ''}` : String(e) } }
const user = (id: string): ProjectParticipant => ({ subjectType: 'user', subjectId: id })
const group = (id: string): ProjectParticipant => ({ subjectType: 'group', subjectId: id })

let h: Harness
beforeAll(async () => { h = await startHarness({ name: 'b-project-leave', turnTimeoutMs: 60_000 }) })
afterAll(async () => { await h?.close() })

const db = () => h.ctx.db
const rulesAt = (p: string) => db().query('SELECT r.subject_type AS t, r.subject_id AS s, r.access AS a FROM folder_rules r JOIN folders f ON f.id = r.folder_id WHERE f.path = ? ORDER BY t, s').all(p) as { t: string; s: string | null; a: string }[]
const make = (by: string, name: string, participants: ProjectParticipant[]) => h.api(by).call(API.createProject, { body: { name, participants, instructions: '' } })
const leave = (who: string, id: string) => h.api(who).call(API.leaveProject, { params: { id } })
const sees = async (who: string, id: string) => (await code(h.api(who).call(API.getProject, { params: { id } }))) === 'ok'
const access = (who: string, id: string) => h.api(who).call(API.getProjectAccess, { params: { id } })
const put = async (who: string, id: string, participants: ProjectParticipant[]) => h.api(who).call(API.putProjectParticipants, { params: { id }, body: { participants, expectedHash: (await access(who, id)).rulesHash } })
const leaveOf = async (who: string, id: string) => (await h.api(who).call(API.getProject, { params: { id } })).leave
const privateChat = (projectId: string, by: string) => {
  const id = uuidv7()
  db().query("INSERT INTO chats (id, user_id, project_id, title) VALUES (?, ?, ?, 'mine')").run(id, by, projectId)
  return id
}
const sharedChat = (projectId: string, by: string) => {
  const id = uuidv7()
  db().query("INSERT INTO chats (id, user_id, project_id, title, shared_at) VALUES (?, ?, ?, 'ours', strftime('%Y-%m-%dT%H:%M:%fZ','now'))").run(id, by, projectId)
  return id
}

describe('leaving a team project', () => {
  test('by name: their rule goes, audited like a removal; the others keep it', async () => {
    const p = await make('dana', 'By name', [user('bob'), user('alice')])
    expect(await leaveOf('bob', p.id)).toBe('yes')
    expect(await leave('bob', p.id)).toEqual({ movedChats: 0 })
    expect(rulesAt(p.folderPath)).toEqual([{ t: 'everyone', s: null, a: 'none' }, { t: 'user', s: 'alice', a: 'write' }, { t: 'user', s: 'dana', a: 'write' }])
    expect(await sees('bob', p.id)).toBe(false)
    expect(await sees('alice', p.id)).toBe(true)
    const rules = db().query("SELECT actor_id AS actor, detail FROM audit_log WHERE action = 'folder.rules' AND target = ? ORDER BY rowid DESC LIMIT 1").get(p.folderPath) as { actor: string; detail: string }
    expect(rules.actor).toBe('bob')
    expect(JSON.parse(rules.detail)).toMatchObject({ via: 'leave', projectId: p.id, self: true })
    const left = db().query("SELECT actor_id AS actor, detail FROM audit_log WHERE action = 'project.leave' AND target = ?").get(p.id) as { actor: string; detail: string }
    expect(left.actor).toBe('bob')
    expect(JSON.parse(left.detail)).toEqual({ name: 'By name', folderPath: p.folderPath })
    // losing it is audited as any narrowing is
    expect(db().query("SELECT 1 FROM audit_log WHERE action = 'folder.access_lost' AND target = ? AND detail LIKE '%\"bob\"%'").get(p.folderPath)).toBeTruthy()
  })

  test('through a group: an exception of their own; the group and the others in it keep the project', async () => {
    const p = await make('dana', 'Via group', [group('marketing')])
    await leave('erin', p.id)
    expect(rulesAt(p.folderPath)).toEqual([{ t: 'everyone', s: null, a: 'none' }, { t: 'group', s: 'marketing', a: 'write' }, { t: 'user', s: 'dana', a: 'write' }, { t: 'user', s: 'erin', a: 'none' }])
    expect(await sees('erin', p.id)).toBe(false)
    expect(await sees('alice', p.id)).toBe(true)
    // the members screen: on the group's row, not another rule
    const a = await access('dana', p.id)
    expect(a.participants.find((x) => x.subjectId === 'marketing')).toEqual({ subjectType: 'group', subjectId: 'marketing', name: 'Marketing', except: [{ id: 'erin', name: 'Erin Yoo' }] })
    expect(a.otherRules).toEqual([])
    expect(a.people).toBe(2)
    expect((JSON.parse((db().query("SELECT detail FROM audit_log WHERE action = 'project.leave' AND target = ?").get(p.id) as { detail: string }).detail)).exception).toBe(true)
    // a save that does not name her keeps the exception
    await put('dana', p.id, [group('marketing'), user('bob')])
    expect(rulesAt(p.folderPath)).toContainEqual({ t: 'user', s: 'erin', a: 'none' })
    expect(await sees('erin', p.id)).toBe(false)

    // added back by name: the exception becomes write
    await put('dana', p.id, [group('marketing'), user('bob'), user('erin')])
    expect(rulesAt(p.folderPath)).toContainEqual({ t: 'user', s: 'erin', a: 'write' })
    expect(rulesAt(p.folderPath).filter((x) => x.s === 'erin')).toHaveLength(1)
    expect(await sees('erin', p.id)).toBe(true)
    expect((await access('dana', p.id)).participants.find((x) => x.subjectId === 'marketing')?.except).toBeUndefined()

    // she leaves again (by name now, and the group still holds her): the exception again
    await leave('erin', p.id)
    expect(rulesAt(p.folderPath)).toContainEqual({ t: 'user', s: 'erin', a: 'none' })
    // the group taken out: its exceptions go with it (no rule left for nobody), nobody gains it
    await put('dana', p.id, [user('bob')])
    expect(rulesAt(p.folderPath)).toEqual([{ t: 'everyone', s: null, a: 'none' }, { t: 'user', s: 'bob', a: 'write' }, { t: 'user', s: 'dana', a: 'write' }])
    expect(await sees('erin', p.id)).toBe(false)
  })

  test('an exception another rule still needs stays when its group goes', async () => {
    const p = await make('dana', 'Two groups', [group('marketing'), group('finance')])
    db().query("INSERT INTO group_members VALUES ('finance','erin')").run()
    try {
      await leave('erin', p.id)
      // marketing goes, finance still holds her: the exception stays, and shows on finance's row
      await put('dana', p.id, [group('finance')])
      expect(rulesAt(p.folderPath)).toContainEqual({ t: 'user', s: 'erin', a: 'none' })
      expect(await sees('erin', p.id)).toBe(false)
      expect((await access('dana', p.id)).participants.find((x) => x.subjectId === 'finance')?.except).toEqual([{ id: 'erin', name: 'Erin Yoo' }])
    } finally { db().query("DELETE FROM group_members WHERE group_id = 'finance' AND user_id = 'erin'").run() }
  })

  test('the creator may leave: the project forgets its creator and no save puts them back', async () => {
    const p = await make('alice', 'Creator leaves', [user('bob')])
    await leave('alice', p.id)
    expect((db().query('SELECT created_by FROM projects WHERE id = ?').get(p.id) as { created_by: string | null }).created_by).toBeNull()
    expect(rulesAt(p.folderPath)).toEqual([{ t: 'everyone', s: null, a: 'none' }, { t: 'user', s: 'bob', a: 'write' }])
    expect(await sees('alice', p.id)).toBe(false)
    // no creator's powers left: its members, its delete are the admins'
    expect(await code(access('alice', p.id))).toBe('404 not_found')
    expect(await code(h.api('alice').call(API.deleteProject, { params: { id: p.id } }))).toBe('404 not_found')
    const bob = await h.api('bob').call(API.getProject, { params: { id: p.id } })
    expect(bob.createdBy).toBeNull()
    expect(bob.creatorChangesMembers).toBe(false)
    // an admin's save does not put her back
    await put('carol', p.id, [user('bob'), user('erin')])
    expect(rulesAt(p.folderPath).some((x) => x.s === 'alice')).toBe(false)
  })

  test('the last person may not leave; the owner and admins who manage it do not count', async () => {
    const p = await make('alice', 'Alone', [])
    expect(await leaveOf('alice', p.id)).toBe('last')
    expect(await code(leave('alice', p.id))).toBe('409 conflict project_last_member')
    expect(await sees('alice', p.id)).toBe(true)
    // a personal project: nothing to leave
    const mine = await h.api('alice').call(API.createProject, { body: { name: 'Mine', scope: 'personal', instructions: '' } as never })
    expect(mine.folderPath.startsWith('users/')).toBe(true)
    expect(await leaveOf('alice', mine.id)).toBeUndefined()
    expect(await code(leave('alice', mine.id))).toBe('409 conflict project_personal')
  })

  test('someone who is not in it cannot leave it (404, as for no project)', async () => {
    const p = await make('alice', 'Not mine', [user('bob')])
    for (const who of ['erin', 'carol', 'dana']) expect(await code(leave(who, p.id))).toBe('404 not_found')
    // the owner's manage view has no Leave
    expect((await h.api('dana').call(API.getProject, { params: { id: p.id }, query: { manage: '1' } })).leave).toBeUndefined()
    expect(rulesAt(p.folderPath)).toEqual([{ t: 'everyone', s: null, a: 'none' }, { t: 'user', s: 'alice', a: 'write' }, { t: 'user', s: 'bob', a: 'write' }])
  })

  test('their private chats move to their own chats; shared chats stay for the others', async () => {
    const p = await make('dana', 'Chats', [user('bob'), user('alice')])
    const mine = privateChat(p.id, 'bob')
    const trashed = privateChat(p.id, 'bob')
    db().query("UPDATE chats SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(trashed)
    const ours = sharedChat(p.id, 'bob')
    const hers = privateChat(p.id, 'alice')
    expect(await leave('bob', p.id)).toEqual({ movedChats: 2 })
    const projectOf = (id: string) => (db().query('SELECT project_id AS p, user_id AS u FROM chats WHERE id = ?').get(id) as { p: string | null; u: string })
    expect(projectOf(mine)).toEqual({ p: null, u: 'bob' })
    expect(projectOf(trashed)).toEqual({ p: null, u: 'bob' })
    expect(projectOf(ours)).toEqual({ p: p.id, u: 'bob' })
    expect(projectOf(hers)).toEqual({ p: p.id, u: 'alice' })
    // bob opens his own chat still; the shared one is alice's to see, not his
    expect(await code(h.api('bob').call(API.getChat, { params: { id: mine } }))).toBe('ok')
    expect(await code(h.api('bob').call(API.getChat, { params: { id: ours } }))).toBe('404 not_found')
    expect(await code(h.api('alice').call(API.getChat, { params: { id: ours } }))).toBe('ok')
  })

  test('their scheduled tasks in it pause at their next run, as after a removal', async () => {
    const p = await make('dana', 'Tasks', [user('bob'), user('alice')])
    const rt = h.rt()
    const t = rt.schedules.create('bob', { title: 'Daily', prompt: fake({ say: 'ok' }), repeat: 'daily', time: '09:00', projectId: p.id } as never, new Date(Date.now() - 2 * 86_400_000), CONFIRMED)
    await leave('bob', p.id)
    expect(rt.schedules.runDue(new Date())).toEqual([])
    expect((db().query('SELECT enabled FROM schedules WHERE id = ?').get(t.id) as { enabled: number }).enabled).toBe(0)
    expect(rt.schedules.lastOutcome('bob', t.id)).toBe('project_gone')
  })
})
