// Who is in a team project (GET /api/projects/:id/people, docs/DECISIONS.md "Who is in a project, by face"): each person
// once with their photo, the creator first; the groups it was shared with, expanded, only for whoever manages it; its
// members and the owner and admins who manage it read it, anyone else gets 404 as for no project; nothing for a
// personal project, one made before outside projects/, or one in the trash.
// Fixture (tests/lib/fixtures.ts): alice, erin = marketing; bob = finance; carol = admin; dana = owner.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, ApiError, type Project } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'

setDefaultTimeout(60_000)
const code = async (p: Promise<unknown>) => { try { await p; return 'ok' } catch (e) { return e instanceof ApiError ? `${e.status} ${e.code}${e.body.params?.reason ? ` ${e.body.params.reason}` : ''}` : String(e) } }
const ids = (r: { people: { id: string }[] }) => r.people.map((x) => x.id)

let h: Harness
let both: Project, small: Project
beforeAll(async () => {
  h = await startHarness({ name: 'b-project-people' })
  // alice and erin are in both groups the project is shared with: each is still one person
  h.ctx.db.query("INSERT INTO group_members VALUES ('finance','erin'), ('finance','alice')").run()
  h.ctx.db.query('INSERT INTO user_profiles (user_id, avatar_version) VALUES (?, ?)').run('erin', 1700000000123)
  both = await h.api('alice').call(API.createProject, { body: { name: 'People plan', participants: [{ subjectType: 'group', subjectId: 'marketing' }, { subjectType: 'group', subjectId: 'finance' }], instructions: '' } })
  small = await h.api('alice').call(API.createProject, { body: { name: 'Small plan', participants: [{ subjectType: 'group', subjectId: 'marketing' }], instructions: '' } })
})
afterAll(async () => { await h?.close() })

describe('GET /api/projects/:id/people', () => {
  test('each person once, the creator first then by name, with their photo', async () => {
    const r = await h.api('alice').call(API.getProjectPeople, { params: { id: both.id } })
    expect(ids(r)).toEqual(['alice', 'bob', 'erin'])
    expect(r.people[0]).toEqual({ id: 'alice', name: 'Alice Kim', creator: true })
    expect(r.people.find((x) => x.id === 'erin')).toEqual({ id: 'erin', name: 'Erin Yoo', avatarVersion: 1700000000123 })
    // the owner and admins are not in it: they are not members
    expect(ids(r)).not.toContain('carol')
    expect(ids(r)).not.toContain('dana')
  })

  test('the creator, who manages it, gets the groups expanded to the people in it', async () => {
    const r = await h.api('alice').call(API.getProjectPeople, { params: { id: both.id } })
    expect(r.groups).toEqual([
      { id: 'finance', name: 'Finance', people: ['alice', 'bob', 'erin'] },
      { id: 'marketing', name: 'Marketing', people: ['alice', 'erin'] },
    ])
  })

  test('a member who does not manage it reads the people, never the groups', async () => {
    for (const who of ['bob', 'erin']) {
      const r = await h.api(who).call(API.getProjectPeople, { params: { id: both.id } })
      expect(ids(r)).toEqual(['alice', 'bob', 'erin'])
      expect(r.groups).toBeUndefined()
    }
  })

  test('the owner and an admin who manage it without being members read it, groups included', async () => {
    for (const who of ['carol', 'dana']) {
      const r = await h.api(who).call(API.getProjectPeople, { params: { id: both.id } })
      expect(ids(r)).toEqual(['alice', 'bob', 'erin'])
      expect(r.groups?.map((g) => g.id)).toEqual(['finance', 'marketing'])
    }
  })

  test('someone who is not in it and does not manage it: 404, as for no project', async () => {
    expect(await code(h.api('bob').call(API.getProjectPeople, { params: { id: small.id } }))).toBe('404 not_found')
    expect(await code(h.api('bob').call(API.getProjectPeople, { params: { id: '01900000-0000-7000-8000-000000000000' } }))).toBe('404 not_found')
    expect(ids(await h.api('erin').call(API.getProjectPeople, { params: { id: small.id } }))).toEqual(['alice', 'erin'])
  })

  test('a person who leaves the project leaves the list at once', async () => {
    const access = await h.api('alice').call(API.getProjectAccess, { params: { id: small.id } })
    await h.api('alice').call(API.putProjectParticipants, { params: { id: small.id }, body: { participants: [{ subjectType: 'user', subjectId: 'bob' }], expectedHash: access.rulesHash } })
    expect(ids(await h.api('bob').call(API.getProjectPeople, { params: { id: small.id } }))).toEqual(['alice', 'bob'])
    expect(await code(h.api('erin').call(API.getProjectPeople, { params: { id: small.id } }))).toBe('404 not_found')
  })

  test('a deactivated person is not listed', async () => {
    h.ctx.db.query("UPDATE users SET status = 'disabled' WHERE id = 'erin'").run()
    try {
      const r = await h.api('alice').call(API.getProjectPeople, { params: { id: both.id } })
      expect(ids(r)).toEqual(['alice', 'bob'])
      expect(r.groups).toEqual([{ id: 'finance', name: 'Finance', people: ['alice', 'bob'] }, { id: 'marketing', name: 'Marketing', people: ['alice'] }])
    } finally { h.ctx.db.query("UPDATE users SET status = 'active' WHERE id = 'erin'").run() }
  })

  test('no list for a personal project or one made before outside projects/', async () => {
    const mine = await h.api('alice').call(API.createProject, { body: { name: 'Mine', scope: 'personal', participants: [], instructions: '' } })
    expect(await code(h.api('alice').call(API.getProjectPeople, { params: { id: mine.id } }))).toBe('409 conflict project_personal')
    // the owner and admins never reach someone's personal project
    expect(await code(h.api('dana').call(API.getProjectPeople, { params: { id: mine.id } }))).toBe('404 not_found')
    const old = await oldProject(h, 'alice', { name: 'Old', folderPath: 'groups/marketing' })
    expect(await code(h.api('alice').call(API.getProjectPeople, { params: { id: old.id } }))).toBe('409 conflict project_legacy')
    expect(await code(h.api('erin').call(API.getProjectPeople, { params: { id: old.id } }))).toBe('409 conflict project_legacy')
    expect(await code(h.api('bob').call(API.getProjectPeople, { params: { id: old.id } }))).toBe('404 not_found')
  })

  test('in the trash: nobody is in it, and only those who manage it ask', async () => {
    const gone = await h.api('alice').call(API.createProject, { body: { name: 'Gone plan', participants: [{ subjectType: 'user', subjectId: 'bob' }], instructions: '' } })
    await h.api('alice').call(API.deleteProject, { params: { id: gone.id } })
    expect(await code(h.api('bob').call(API.getProjectPeople, { params: { id: gone.id } }))).toBe('404 not_found')
    expect(await code(h.api('alice').call(API.getProjectPeople, { params: { id: gone.id } }))).toBe('404 not_found')
    expect(await h.api('dana').call(API.getProjectPeople, { params: { id: gone.id } })).toEqual({ people: [], groups: [] })
  })
})
