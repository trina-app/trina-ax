// "You're no longer a member of <project>" (QA TC-1067; server/src/chat/project-joins.ts noLongerMember): someone taken
// out of a team project (or who left it) opens their old link to it, or to one of its shared chats they saw, and gets a
// 404 with one reason, `no_longer_member`, and the project's name. Nothing more: no other 404 body changes (a private
// chat of someone else, a chat shared after they left, a project they were never in, a missing one), and adding them
// back clears it. Every loss leaves an audit row `project.member_lost`. The members dialog's dry run names up to three
// of the people who would lose it (`removedNames`).
// Fixture (tests/lib/fixtures.ts): alice, erin = marketing; bob = finance; carol = admin; dana = owner.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, ApiError, uuidv7, type ProjectParticipant } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'

setDefaultTimeout(60_000)
const user = (id: string): ProjectParticipant => ({ subjectType: 'user', subjectId: id })
const group = (id: string): ProjectParticipant => ({ subjectType: 'group', subjectId: id })
/** the error a call ends with: status, code, its params and message */
const err = async (p: Promise<unknown>) => {
  try { await p; return null } catch (e) { if (!(e instanceof ApiError)) throw e; return { status: e.status, code: e.code, params: e.body.params ?? null, message: e.body.message } }
}

let h: Harness
beforeAll(async () => { h = await startHarness({ name: 'b-no-longer-member' }) })
afterAll(async () => { await h?.close() })

const db = () => h.ctx.db
const make = (by: string, name: string, participants: ProjectParticipant[]) => h.api(by).call(API.createProject, { body: { name, participants, instructions: '' } })
const access = (who: string, id: string) => h.api(who).call(API.getProjectAccess, { params: { id } })
const put = async (who: string, id: string, participants: ProjectParticipant[]) => h.api(who).call(API.putProjectParticipants, { params: { id }, body: { participants, expectedHash: (await access(who, id)).rulesHash } })
const getProject = (who: string, id: string) => h.api(who).call(API.getProject, { params: { id } })
const getChat = (who: string, id: string) => h.api(who).call(API.getChat, { params: { id } })
const chat = (projectId: string, by: string, shared: boolean) => {
  const id = uuidv7()
  db().query(`INSERT INTO chats (id, user_id, project_id, title, shared_at) VALUES (?, ?, ?, 'c', ${shared ? "strftime('%Y-%m-%dT%H:%M:%fZ','now', '-1 second')" : 'NULL'})`).run(id, by, projectId)
  return id
}
const GONE = (name: string) => ({ status: 404, code: 'not_found', params: { reason: 'no_longer_member', project: name } })
const lostRows = (projectId: string, userId: string) => db().query("SELECT actor_id AS actor, detail FROM audit_log WHERE action = 'project.member_lost' AND target = ? AND json_extract(detail, '$.userId') = ?").all(projectId, userId) as { actor: string; detail: string }[]

describe('no longer a member', () => {
  test('taken out: the project and a shared chat they saw say so, by name; nothing else changes; added back, it is gone', async () => {
    const p = await make('dana', 'Atlas', [user('bob'), user('alice')])
    const seen = chat(p.id, 'alice', true)
    const theirs = chat(p.id, 'alice', false)
    const plain = await err(getChat('erin', seen))
    await put('dana', p.id, [user('alice')])
    // the audit row of the loss: who, by whom, how
    const rows = lostRows(p.id, 'bob')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.actor).toBe('dana')
    expect(JSON.parse(rows[0]!.detail)).toMatchObject({ projectId: p.id, userId: 'bob', via: 'project' })
    // the old links
    expect(await err(getProject('bob', p.id))).toMatchObject(GONE('Atlas'))
    expect((await err(getProject('bob', p.id)))!.message).toBe("더 이상 'Atlas' 프로젝트의 멤버가 아니에요.")
    expect(await err(getChat('bob', seen))).toMatchObject(GONE('Atlas'))
    // someone else's private chat there: the one 404 of a missing chat, as before
    expect((await err(getChat('bob', theirs)))!.params).toBeNull()
    // a chat shared after he was out: he never saw it, so nothing about it
    const later = chat(p.id, 'alice', false)
    db().query("UPDATE chats SET shared_at = strftime('%Y-%m-%dT%H:%M:%fZ','now', '+1 second') WHERE id = ?").run(later)
    expect((await err(getChat('bob', later)))!.params).toBeNull()
    // someone never in it: the plain 404, the same as before
    expect(await err(getChat('erin', seen))).toEqual(plain)
    expect((await err(getProject('erin', p.id)))!.params).toBeNull()
    // a project that is not there: the plain 404
    expect((await err(getProject('bob', uuidv7())))!.params).toBeNull()
    // added back: he reads it again, and if taken out again the reason comes back
    await put('dana', p.id, [user('alice'), user('bob')])
    expect((await getProject('bob', p.id)).id).toBe(p.id)
    expect((await getChat('bob', seen)).id).toBe(seen)
    await put('dana', p.id, [user('alice')])
    expect(await err(getProject('bob', p.id))).toMatchObject(GONE('Atlas'))
  })

  test('left it (through a group): the same reason', async () => {
    const p = await make('dana', 'Boreal', [group('marketing')])
    const seen = chat(p.id, 'alice', true)
    await h.api('erin').call(API.leaveProject, { params: { id: p.id } })
    expect(lostRows(p.id, 'erin')).toHaveLength(1)
    expect(JSON.parse(lostRows(p.id, 'erin')[0]!.detail)).toMatchObject({ self: true })
    expect(await err(getProject('erin', p.id))).toMatchObject(GONE('Boreal'))
    expect(await err(getChat('erin', seen))).toMatchObject(GONE('Boreal'))
    // alice, still in the group, reads it
    expect((await getChat('alice', seen)).id).toBe(seen)
  })

  test('the members dialog\'s dry run names who loses it: three by name, sorted, the count says how many', async () => {
    const p = await make('dana', 'Cobalt', [user('alice'), user('bob'), user('erin'), user('carol')])
    const r = await h.api('dana').call(API.previewProjectAccess, { body: { projectId: p.id, participants: [] } })
    expect(r.removed).toBe(4)
    expect(r.removedNames).toHaveLength(3)
    expect([...r.removedNames!]).toEqual([...r.removedNames!].sort((a, b) => a.localeCompare(b)))
    // nobody loses it: no names
    const none = await h.api('dana').call(API.previewProjectAccess, { body: { projectId: p.id, participants: [user('alice'), user('bob'), user('erin'), user('carol')] } })
    expect(none.removed).toBe(0)
    expect(none.removedNames).toBeUndefined()
  })
})
