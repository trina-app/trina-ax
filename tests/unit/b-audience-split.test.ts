// Who sees it, apart (docs/DECISIONS.md "Who sees it: the project's own people first"): the owner and admins get each
// count apart, `direct` (the people who see it by its own rules, judged as a member would be, so an admin in a rule
// counts once, there) and `byRole` (the owner and admins who see it only by their role): Project.audienceSplit, the
// project dry run's `split` and GET /api/files/audience's `split`. Totals stay as they were. A member gets no split at
// all, editor or not: beside the total they already get, it would tell them how many see it only by role. In projects/
// nobody sees it by role (docs/DECISIONS.md "Project contents only for members"): `byRole` is 0 there.
// alice and erin are in marketing, bob in finance; carol is an admin, dana the owner.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type ProjectParticipant } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { Audiences } from '../../server/src/chat/shared'
import { PROJECT_COLS, type ProjectRow } from '../../server/src/chat/store'

setDefaultTimeout(60_000)

let h: Harness
beforeAll(async () => { h = await startHarness({ name: 'b-audience-split' }) })
afterAll(async () => { await h.close() })

const user = (id: string): ProjectParticipant => ({ subjectType: 'user', subjectId: id })
const group = (id: string): ProjectParticipant => ({ subjectType: 'group', subjectId: id })
const project = async (by: string, name: string, participants: ProjectParticipant[] = []) => (await h.api(by).call(API.createProject, { body: { name, instructions: '', participants } })).id
const seen = (who: string, id: string) => h.api(who).call(API.getProject, { params: { id } })
const listed = async (who: string, id: string) => (await h.api(who).call(API.listProjects, {})).items.find((x) => x.id === id)
const preview = (who: string, participants: ProjectParticipant[], projectId?: string) => h.api(who).call(API.previewProjectAccess, { body: { participants, ...(projectId ? { projectId } : {}) } })
const audience = (who: string, path: string) => h.api(who).call(API.folderAudience, { query: { path } })

describe('a project apart', () => {
  // docs/DECISIONS.md "Project contents only for members": in projects/ nobody sees a project by role, so `byRole` is 0
  // there and the total is its members; the owner and admins who are not members see the count with manage=1
  const managed = (who: string, id: string) => h.api(who).call(API.getProject, { params: { id }, query: { manage: '1' } })
  const listedManaged = async (who: string, id: string) => (await h.api(who).call(API.listProjects, { query: { manage: '1' } })).items.find((x) => x.id === id)
  test('the creator and a group the creator is in (the owner\'s case): the creator counts once, admins are not counted', async () => {
    const id = await project('alice', 'Quotes', [group('marketing')])
    // alice (creator, in marketing) and erin by its rules; carol and dana are not members
    for (const who of ['carol', 'dana']) {
      expect(await managed(who, id)).toMatchObject({ member: false, audience: 2, audienceSplit: { direct: 2, byRole: 0 } })
      expect((await listedManaged(who, id))?.audienceSplit).toEqual({ direct: 2, byRole: 0 })
      expect(await listed(who, id)).toBeUndefined()
    }
    // the members, its creator (who may change its members) included: the total, nothing apart
    for (const who of ['alice', 'erin']) {
      const p = await seen(who, id)
      expect(p.audience).toBe(2)
      expect(p).not.toHaveProperty('audienceSplit')
      expect(await listed(who, id)).not.toHaveProperty('audienceSplit')
    }
  })

  test('an admin who is also in the group counts once, as a member', async () => {
    h.ctx.db.query("INSERT INTO group_members VALUES ('marketing','carol')").run()
    try {
      const id = await project('alice', 'With Carol', [group('marketing')])
      // alice, erin and carol by the group; dana is not a member
      expect(await managed('dana', id)).toMatchObject({ member: false, audience: 3, audienceSplit: { direct: 3, byRole: 0 } })
      expect((await seen('carol', id)).audienceSplit).toEqual({ direct: 3, byRole: 0 })
    } finally {
      h.ctx.db.query("DELETE FROM group_members WHERE group_id = 'marketing' AND user_id = 'carol'").run()
    }
  })

  test('an admin who made it is there by her creator\'s rule', async () => {
    const id = await project('carol', 'For Bob', [user('bob')])
    expect(await seen('carol', id)).toMatchObject({ audience: 2, audienceSplit: { direct: 2, byRole: 0 } })
    expect(await seen('bob', id)).not.toHaveProperty('audienceSplit')
  })

  test('while its folder is in the trash nobody sees it, by a rule or by role', async () => {
    const id = await project('alice', 'Binned', [user('erin')])
    const row = h.ctx.db.query(`SELECT ${PROJECT_COLS} FROM projects WHERE id = ?`).get(id) as ProjectRow
    expect(new Audiences(h.ctx.db, h.ctx.files).split(row)).toEqual({ direct: 2, byRole: 0 })
    expect(new Audiences(h.ctx.db, h.ctx.files).split({ ...row, trashed_with: 'trash-1' })).toEqual({ direct: 0, byRole: 0 })
  })
})

describe('the dry run apart', () => {
  test('a new project, the owner or an admin: the caller and the people chosen, nobody by role', async () => {
    expect(await preview('carol', [user('erin')])).toMatchObject({ people: 2, split: { direct: 2, byRole: 0 } })
    expect(await preview('carol', [user('dana')])).toMatchObject({ people: 2, split: { direct: 2, byRole: 0 } })
    expect(await preview('dana', [group('marketing'), user('bob')])).toMatchObject({ people: 4, split: { direct: 4, byRole: 0 } })
  })

  test('an existing project an admin manages without being a member: its people after the change, no contents', async () => {
    const id = await project('alice', 'Growing', [user('erin')])
    expect(await preview('carol', [user('erin'), group('finance')], id)).toMatchObject({ people: 3, added: 1, contentsHidden: true, split: { direct: 3, byRole: 0 } })
    expect(await preview('carol', [], id)).toMatchObject({ people: 1, removed: 1, contentsHidden: true, split: { direct: 1, byRole: 0 } })
  })

  test('a member gets no split, a new project or one they manage', async () => {
    const mine = await preview('alice', [user('erin')])
    expect(mine.people).toBe(2)
    expect(mine).not.toHaveProperty('split')
    expect(mine).not.toHaveProperty('adminsApart')
    const id = await project('alice', 'Managed', [user('erin')])
    const p = await preview('alice', [user('erin'), user('bob')], id)
    expect(p.people).toBe(3)
    expect(p).not.toHaveProperty('split')
  })
})

describe('a folder apart', () => {
  test('its own rules against role-only access', async () => {
    // marketing writes: alice and erin by the rule, carol and dana by role
    expect(await audience('carol', 'groups/marketing')).toMatchObject({ people: 4, everyone: false, split: { direct: 2, byRole: 2 } })
    // everyone writes: all five by the rule
    expect(await audience('dana', 'shared')).toMatchObject({ people: 5, everyone: true, split: { direct: 5, byRole: 0 } })
    // finance writes: bob by the rule; carol and dana by role
    expect(await audience('carol', 'groups/finance')).toMatchObject({ people: 3, split: { direct: 1, byRole: 2 } })
  })

  test('a member who can write there: the total, nothing apart', async () => {
    const a = await audience('alice', 'groups/marketing')
    expect(a).toEqual({ path: 'groups/marketing', access: 'write', people: 4, everyone: false })
    expect(await audience('bob', 'groups/finance')).toEqual({ path: 'groups/finance', access: 'write', people: 3, everyone: false })
  })
})
