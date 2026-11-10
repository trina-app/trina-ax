// POST /api/projects/access-preview for a new team project (chat/project-access.ts previewAccess): a member is never
// told anyone's role (the people directory, rooms), so the dry run a member asks must not answer differently for a
// person who is an admin and one who is not. Asked by someone who is not the owner or an admin, it counts the caller
// and the people and groups chosen, as if nobody were an admin, and says so (`adminsApart`); the owner and admins get
// the count with everyone who sees it, as before. An existing project's dry run (its creator or an admin) is unchanged.
// Fixture (tests/lib/fixtures.ts): alice, erin = marketing; bob = finance; carol = admin; dana = owner.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ProjectAccessPreview } from '@mycel/shared/api'
import { jsonBody, makeCApp, type CApp, type Person } from '../lib/c-app'

let A: CApp
beforeAll(async () => { A = await makeCApp('project-preview-roles') })
afterAll(async () => { await A.close() })

const user = (id: string) => ({ subjectType: 'user', subjectId: id })
const group = (id: string) => ({ subjectType: 'group', subjectId: id })
const preview = async (who: Person, body: Record<string, unknown>) => {
  const r = await A.json('/api/projects/access-preview', { as: who, ...jsonBody(body) })
  expect(r.status).toBe(200)
  return r.body as ProjectAccessPreview
}

describe('a new project\'s dry run tells a member nothing about roles', () => {
  test('a member: naming an admin or the owner changes the count exactly as naming a member does', async () => {
    const none = await preview('alice', { participants: [] })
    // only alice herself: the owner and admins are not counted (they see it anyway, the line says so)
    expect(none).toEqual({ people: 1, added: 0, removed: 0, files: 0, othersFiles: 0, sharedChats: 0, skills: 0, skillNames: [], adminsApart: true })
    const counts = Object.fromEntries(await Promise.all((['bob', 'carol', 'dana', 'erin'] as const).map(async (x) => [x, (await preview('alice', { participants: [user(x)] })).people])))
    expect(counts).toEqual({ bob: 2, carol: 2, dana: 2, erin: 2 })
    // with her own group: erin comes with it; one more person adds one, whoever it is
    expect((await preview('alice', { participants: [group('marketing')] })).people).toBe(2)
    for (const x of ['bob', 'carol', 'dana']) expect({ x, n: (await preview('alice', { participants: [group('marketing'), user(x)] })).people }).toEqual({ x, n: 3 })
    // the same for another member
    expect((await preview('bob', { participants: [user('carol')] })).people).toBe((await preview('bob', { participants: [user('erin')] })).people)
  })

  test('an admin or the owner: the count of everyone who would see it, as before', async () => {
    // carol (admin): herself and dana (owner)
    expect(await preview('carol', { participants: [] })).toEqual({ people: 2, added: 0, removed: 0, files: 0, othersFiles: 0, sharedChats: 0, skills: 0, skillNames: [] })
    expect((await preview('carol', { participants: [user('erin')] })).people).toBe(3)
    expect((await preview('carol', { participants: [user('dana')] })).people).toBe(2)
    expect((await preview('dana', { participants: [group('marketing'), user('bob')] }))).toMatchObject({ people: 5 })
    expect((await preview('dana', { participants: [] })).adminsApart).toBeUndefined()
  })

  test('sharing a personal project, dry run: the same for a member (the people chosen only), as before for an admin', async () => {
    const dry = async (who: Person, participants: unknown[]) => {
      const own = await A.json('/api/projects', { as: who, ...jsonBody({ name: `share-dry-${who}-${participants.length}-${Math.random()}`, scope: 'personal', instructions: '' }) })
      expect(own.status).toBe(201)
      const r = await A.json(`/api/projects/${own.body.id}/share`, { as: who, ...jsonBody({ participants, dryRun: true }) })
      expect(r.status).toBe(200)
      return r.body as { viewersAdded: number; adminsApart?: boolean }
    }
    for (const x of ['bob', 'carol', 'dana', 'erin']) expect({ x, r: await dry('alice', [user(x)]) }).toEqual({ x, r: { viewersAdded: 1, adminsApart: true } })
    expect(await dry('alice', [])).toEqual({ viewersAdded: 0, adminsApart: true })
    // carol (admin): dana (owner) already, erin one more
    expect(await dry('carol', [user('erin')])).toEqual({ viewersAdded: 2 })
    expect(await dry('carol', [user('dana')])).toEqual({ viewersAdded: 1 })
  })

  test('an existing project: its creator (who may change who sees it) keeps the count with everyone who sees it', async () => {
    const r = await A.json('/api/projects', { as: 'alice', ...jsonBody({ name: 'roles-dry-run', instructions: '', participants: [] }) })
    expect(r.status).toBe(201)
    const p = await preview('alice', { projectId: r.body.id, participants: [user('erin')] })
    // alice, erin, carol and dana; erin gains it
    expect(p).toMatchObject({ people: 4, added: 1, removed: 0 })
    expect(p.adminsApart).toBeUndefined()
  })
})
