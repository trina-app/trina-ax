// Who sees a chat, always (docs/DECISIONS.md "Who sees it, always"): Project.alone says that nobody but the caller sees
// the project by a rule of its folder. A team project in projects/ is members only (docs/DECISIONS.md "Project contents
// only for members"): the owner and admins read it only as members, so its count (`audience`) is its members, and alone
// there means nobody else reads it at all. The check is role-blind: an admin who sees it by a rule (its creator, someone
// chosen) counts like anyone else. It goes only to a caller who may read the project's rules anyway (an owner or admin,
// or whoever may change its members), and never to the owner or an admin who manages it without being a member (it would
// be about the others). alice, bob and erin are members, carol an admin, dana the owner.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, ApiError, type ProjectParticipant } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { Audiences } from '../../server/src/chat/shared'
import { PROJECT_COLS, type ProjectRow } from '../../server/src/chat/store'

setDefaultTimeout(60_000)

let h: Harness
beforeAll(async () => { h = await startHarness({ name: 'b-who-sees' }) })
afterAll(async () => { await h.close() })

/** a team project of `user` with these participants, its chats shared (or not) */
async function project(user: string, name: string, participants: ProjectParticipant[] = [], share = true) {
  const p = await h.api(user).call(API.createProject, { body: { name, instructions: '', participants } })
  if (share) await h.api(user).call(API.updateProject, { params: { id: p.id }, body: { shareChats: true } })
  return p.id
}
const seen = (user: string, id: string) => h.api(user).call(API.getProject, { params: { id } })
/** the project as the owner or an admin manages it (GET with manage=1): also one they are not a member of */
const managed = (user: string, id: string) => h.api(user).call(API.getProject, { params: { id }, query: { manage: '1' } })
const errOf = async (p: Promise<unknown>) => { try { await p } catch (e) { return e as ApiError } throw new Error('expected an error') }
const listed = async (user: string, id: string) => (await h.api(user).call(API.listProjects, {})).items.find((x) => x.id === id)

describe('Project.alone', () => {
  test('a member alone in a shared project: the owner and the admin are not members, so nobody else reads it', async () => {
    const id = await project('alice', 'Solo')
    // alice only: carol (admin) and dana (owner) are not counted by their role
    expect(await seen('alice', id)).toMatchObject({ shareChats: true, audience: 1, membersEditable: true, alone: true })
    expect((await listed('alice', id))?.alone).toBe(true)
    // carol and dana do not read it (not found); managing it, they get its member count and never `alone`
    for (const u of ['carol', 'dana']) {
      expect((await errOf(seen(u, id))).status).toBe(404)
      const m = await managed(u, id)
      expect(m).toMatchObject({ member: false, audience: 1 })
      expect(m.alone).toBeUndefined()
    }
    // the chat itself carries no such field: the page reads its project
    const chat = await h.api('alice').call(API.createChat, { body: { projectId: id } })
    expect(chat.shared).toMatchObject({ audience: 1 })
    expect(chat.shared).not.toHaveProperty('alone')

    // bob added: he sees it by a rule now
    const access = await h.api('alice').call(API.getProjectAccess, { params: { id } })
    await h.api('alice').call(API.putProjectParticipants, { params: { id }, body: { participants: [{ subjectType: 'user', subjectId: 'bob' }], expectedHash: access.rulesHash } })
    const after = await seen('alice', id)
    expect(after.audience).toBe(2)
    expect(after.alone).toBeUndefined()
  })

  test('the owner alone: nobody else, the admin neither', async () => {
    const id = await project('dana', 'Lead')
    // dana by her creator's rule; carol (admin) is not counted, by role or otherwise
    expect(await seen('dana', id)).toMatchObject({ audience: 1, alone: true, audienceSplit: { direct: 1, byRole: 0 } })
    // carol is not a member: she does not read it, and managing it she is not told `alone`
    expect((await errOf(seen('carol', id))).status).toBe(404)
    expect((await managed('carol', id)).alone).toBeUndefined()
  })

  test('role-blind: an admin who made a project for one member counts as someone who sees it by a rule', async () => {
    const id = await project('carol', 'For Bob', [{ subjectType: 'user', subjectId: 'bob' }])
    // bob and carol; carol, its creator, sees it by her rule whatever her role; dana (owner) is not a member
    expect((await seen('carol', id)).alone).toBeUndefined()
    expect((await errOf(seen('dana', id))).status).toBe(404)
    expect((await managed('dana', id)).alone).toBeUndefined()
    expect((await seen('bob', id)).audience).toBe(2)
  })

  test('nothing for someone who may not read the rules: a member in another\'s project, also once only admins are left', async () => {
    const id = await project('carol', 'Carol and Alice', [{ subjectType: 'user', subjectId: 'alice' }])
    const alice = await seen('alice', id)
    // alice and carol (dana, the owner, is not a member)
    expect(alice).toMatchObject({ audience: 2, membersEditable: false })
    expect(alice.alone).toBeUndefined()
    // carol's account switched off: alice alone reads it. She may not read its rules, so she is not told `alone` (outside
    // projects/ it would say that the others are admins); she reads the count instead
    h.ctx.db.query("UPDATE users SET status = 'disabled' WHERE id = 'carol'").run()
    try {
      const now = await seen('alice', id)
      expect(now.audience).toBe(1)
      expect(now.alone).toBeUndefined()
      expect((await listed('alice', id))?.alone).toBeUndefined()
      // (the check itself would say so: the gate is what keeps it from her)
      const row = h.ctx.db.query(`SELECT ${PROJECT_COLS} FROM projects WHERE id = ?`).get(id) as ProjectRow
      expect(new Audiences(h.ctx.db, h.ctx.files).alone('alice', row)).toBe(true)
      // dana is not a member: she does not read it, and managing it she is not told `alone`
      expect((await errOf(seen('dana', id))).status).toBe(404)
      expect((await managed('dana', id)).alone).toBeUndefined()
    } finally {
      h.ctx.db.query("UPDATE users SET status = 'active' WHERE id = 'carol'").run()
    }
  })

  test('a project that does not share its chats says the same (the web uses it only while it shares them)', async () => {
    const id = await project('erin', 'Quiet', [], false)
    expect(await seen('erin', id)).toMatchObject({ shareChats: false, alone: true })
  })
})
