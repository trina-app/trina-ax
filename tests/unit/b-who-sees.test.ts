// Who sees a chat, always (docs/DECISIONS.md "Who sees it, always"): Project.alone says that nobody but the caller sees
// the project by a rule of its folder, so anyone else of its audience is the owner or an admin (the line under the box:
// "나와 관리자만 봐요"). The count (`audience`) includes the owner and every admin for every caller. The check is
// role-blind: an admin who sees it by a rule (its creator, someone chosen) counts like anyone else. It goes only to a
// caller who may read the project's rules anyway (an owner or admin, or whoever may change its members): to anyone else
// it would say that the others are admins. alice, bob and erin are members, carol an admin, dana the owner.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type ProjectParticipant } from '@mycel/shared/api'
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
const listed = async (user: string, id: string) => (await h.api(user).call(API.listProjects, {})).items.find((x) => x.id === id)

describe('Project.alone', () => {
  test('a member alone in a shared project: the owner and the admin are counted, and nobody else sees it by a rule', async () => {
    const id = await project('alice', 'Solo')
    // alice, carol (admin) and dana (owner)
    expect(await seen('alice', id)).toMatchObject({ shareChats: true, audience: 3, membersEditable: true, alone: true })
    expect((await listed('alice', id))?.alone).toBe(true)
    // for carol and dana, alice sees it by a rule
    expect((await seen('carol', id)).alone).toBeUndefined()
    expect((await seen('dana', id)).alone).toBeUndefined()
    // the chat itself carries no such field: the page reads its project
    const chat = await h.api('alice').call(API.createChat, { body: { projectId: id } })
    expect(chat.shared).toMatchObject({ audience: 3 })
    expect(chat.shared).not.toHaveProperty('alone')

    // bob added: he sees it by a rule now
    const access = await h.api('alice').call(API.getProjectAccess, { params: { id } })
    await h.api('alice').call(API.putProjectParticipants, { params: { id }, body: { participants: [{ subjectType: 'user', subjectId: 'bob' }], expectedHash: access.rulesHash } })
    const after = await seen('alice', id)
    expect(after.audience).toBe(4)
    expect(after.alone).toBeUndefined()
  })

  test('the owner alone: the admin is the only other one', async () => {
    const id = await project('dana', 'Lead')
    expect(await seen('dana', id)).toMatchObject({ audience: 2, alone: true })
    // for carol, dana sees it by a rule (her creator's rule), not as the owner
    expect((await seen('carol', id)).alone).toBeUndefined()
  })

  test('role-blind: an admin who made a project for one member counts as someone who sees it by a rule', async () => {
    const id = await project('carol', 'For Bob', [{ subjectType: 'user', subjectId: 'bob' }])
    // bob, carol and dana; carol, its creator, sees it by her rule whatever her role
    expect((await seen('carol', id)).alone).toBeUndefined()
    expect((await seen('dana', id)).alone).toBeUndefined()
    expect((await seen('bob', id)).audience).toBe(3)
  })

  test('nothing for someone who may not read the rules: a member in another\'s project, also once only admins are left', async () => {
    const id = await project('carol', 'Carol and Alice', [{ subjectType: 'user', subjectId: 'alice' }])
    const alice = await seen('alice', id)
    expect(alice).toMatchObject({ audience: 3, membersEditable: false })
    expect(alice.alone).toBeUndefined()
    // carol's account switched off: alice, dana and nobody else by a rule. Told to alice, it would say that dana (whose
    // question she may see answered there) is an admin; she reads the count instead
    h.ctx.db.query("UPDATE users SET status = 'disabled' WHERE id = 'carol'").run()
    try {
      const now = await seen('alice', id)
      expect(now.audience).toBe(2)
      expect(now.alone).toBeUndefined()
      expect((await listed('alice', id))?.alone).toBeUndefined()
      // (the check itself would say so: the gate is what keeps it from her)
      const row = h.ctx.db.query(`SELECT ${PROJECT_COLS} FROM projects WHERE id = ?`).get(id) as ProjectRow
      expect(new Audiences(h.ctx.db, h.ctx.files).alone('alice', row)).toBe(true)
      // for dana, alice sees it by a rule
      expect((await seen('dana', id)).alone).toBeUndefined()
    } finally {
      h.ctx.db.query("UPDATE users SET status = 'active' WHERE id = 'carol'").run()
    }
  })

  test('a project that does not share its chats says the same (the web uses it only while it shares them)', async () => {
    const id = await project('erin', 'Quiet', [], false)
    expect(await seen('erin', id)).toMatchObject({ shareChats: false, alone: true })
  })
})
