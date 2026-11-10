// Who sees a chat, always (docs/DECISIONS.md "Who sees it, always"): Project.alone and Chat.shared.alone say that nobody
// but the caller sees the project by a rule of its folder, so anyone else of its audience is the owner or an admin (the
// line under the box: "나와 관리자만 봐요"). The count (`audience`) includes the owner and every admin for every caller.
// The check is role-blind: an admin who sees it by a rule (its creator, someone chosen) counts like anyone else, so the
// answer never tells a member who is an admin. alice, bob and erin are members, carol an admin, dana the owner.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type ProjectParticipant } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'

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

describe('Project.alone and Chat.shared.alone', () => {
  test('a member alone in a shared project: the owner and the admin are counted, and nobody else sees it by a rule', async () => {
    const id = await project('alice', 'Solo')
    // alice, carol (admin) and dana (owner)
    expect(await seen('alice', id)).toMatchObject({ shareChats: true, audience: 3, alone: true })
    // for carol and dana, alice sees it by a rule
    expect((await seen('carol', id)).alone).toBeUndefined()
    expect((await seen('dana', id)).alone).toBeUndefined()
    const chat = await h.api('alice').call(API.createChat, { body: { projectId: id } })
    expect(chat.shared).toMatchObject({ audience: 3, alone: true })
    expect((await h.api('carol').call(API.getChat, { params: { id: chat.id } })).shared?.alone).toBeUndefined()

    // bob added: he sees it by a rule now
    const access = await h.api('alice').call(API.getProjectAccess, { params: { id } })
    await h.api('alice').call(API.putProjectParticipants, { params: { id }, body: { participants: [{ subjectType: 'user', subjectId: 'bob' }], expectedHash: access.rulesHash } })
    const after = await seen('alice', id)
    expect(after.audience).toBe(4)
    expect(after.alone).toBeUndefined()
    expect((await h.api('alice').call(API.getChat, { params: { id: chat.id } })).shared).toMatchObject({ audience: 4 })
    expect((await h.api('alice').call(API.getChat, { params: { id: chat.id } })).shared?.alone).toBeUndefined()
  })

  test('the owner alone: the admin is the only other one', async () => {
    const id = await project('dana', 'Lead')
    expect(await seen('dana', id)).toMatchObject({ audience: 2, alone: true })
    // for carol, dana sees it by a rule (her creator's rule), not as the owner
    expect((await seen('carol', id)).alone).toBeUndefined()
  })

  test('role-blind: an admin who made a project for one member counts as someone who sees it by a rule', async () => {
    const id = await project('carol', 'For Bob', [{ subjectType: 'user', subjectId: 'bob' }])
    // bob, carol and dana: bob is not told that only admins are there besides him (carol is its creator)
    const bob = await seen('bob', id)
    expect(bob.audience).toBe(3)
    expect(bob.alone).toBeUndefined()
    expect((await seen('carol', id)).alone).toBeUndefined()
    // a member who made one for bob reads the same: the same answer whatever the creator's role
    const same = await project('alice', 'For Bob too', [{ subjectType: 'user', subjectId: 'bob' }])
    expect((await seen('bob', same)).alone).toBeUndefined()
  })

  test('a project that does not share its chats has no alone (its chats are each one person\'s)', async () => {
    const id = await project('alice', 'Quiet', [], false)
    const p = await seen('alice', id)
    expect(p.shareChats).toBe(false)
    expect(p.alone).toBeUndefined()
    // the list says the same
    const listed = (await h.api('alice').call(API.listProjects, {})).items
    expect(listed.find((x) => x.id === id)?.alone).toBeUndefined()
    expect(listed.find((x) => x.name === 'Solo')).toBeDefined()
  })
})
