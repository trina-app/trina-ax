// POST /api/projects/access-preview for a new team project (chat/project-access.ts previewAccess): a member is never
// told anyone's role (the people directory, rooms), so the dry run a member asks must not answer differently for a
// person who is an admin and one who is not. A team project is members only (docs/DECISIONS.md "Project contents only
// for members"): for every caller the count is the caller and the people and groups chosen, the owner and admins only
// when chosen, so nobody is left out by role and nothing says so (no `adminsApart`); the owner and admins also get the
// count apart, all of it `direct`. An existing project's dry run (its creator or an admin) counts its members only.
// Fixture (tests/lib/fixtures.ts): alice, erin = marketing; bob = finance; carol = admin; dana = owner.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
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
    // only alice herself: the owner and admins are not counted (they do not see it unless chosen), and no `adminsApart`
    // (nobody is left out by role)
    expect(none).toEqual({ people: 1, added: 0, removed: 0, files: 0, othersFiles: 0, sharedChats: 0, skills: 0, skillNames: [] })
    expect(none).not.toHaveProperty('adminsApart')
    const counts = Object.fromEntries(await Promise.all((['bob', 'carol', 'dana', 'erin'] as const).map(async (x) => [x, (await preview('alice', { participants: [user(x)] })).people])))
    expect(counts).toEqual({ bob: 2, carol: 2, dana: 2, erin: 2 })
    // with her own group: erin comes with it; one more person adds one, whoever it is
    expect((await preview('alice', { participants: [group('marketing')] })).people).toBe(2)
    for (const x of ['bob', 'carol', 'dana']) expect({ x, n: (await preview('alice', { participants: [group('marketing'), user(x)] })).people }).toEqual({ x, n: 3 })
    // the same for another member
    expect((await preview('bob', { participants: [user('carol')] })).people).toBe((await preview('bob', { participants: [user('erin')] })).people)
  })

  test('an admin or the owner: the same count (the caller and the people chosen), nobody by role', async () => {
    // carol (admin): herself only; dana (owner) is not counted unless chosen
    expect(await preview('carol', { participants: [] })).toEqual({ people: 1, added: 0, removed: 0, files: 0, othersFiles: 0, sharedChats: 0, skills: 0, skillNames: [], split: { direct: 1, byRole: 0 } })
    expect((await preview('carol', { participants: [user('erin')] })).people).toBe(2)
    // naming the owner adds one, as naming a member does
    expect((await preview('carol', { participants: [user('dana')] })).people).toBe(2)
    // dana, alice and erin (marketing), bob; carol is not counted
    expect((await preview('dana', { participants: [group('marketing'), user('bob')] }))).toMatchObject({ people: 4, split: { direct: 4, byRole: 0 } })
    expect((await preview('dana', { participants: [] })).adminsApart).toBeUndefined()
  })

  test('sharing a personal project, dry run: the people chosen only, for a member and an admin alike', async () => {
    const dry = async (who: Person, participants: unknown[]) => {
      const own = await A.json('/api/projects', { as: who, ...jsonBody({ name: `share-dry-${who}-${participants.length}-${Math.random()}`, scope: 'personal', instructions: '' }) })
      expect(own.status).toBe(201)
      const r = await A.json(`/api/projects/${own.body.id}/share`, { as: who, ...jsonBody({ participants, dryRun: true }) })
      expect(r.status).toBe(200)
      return r.body as { viewersAdded: number; adminsApart?: boolean }
    }
    // whoever it is, one more; no `adminsApart` (nobody sees it by role)
    for (const x of ['bob', 'carol', 'dana', 'erin']) expect({ x, r: await dry('alice', [user(x)]) }).toEqual({ x, r: { viewersAdded: 1 } })
    expect(await dry('alice', [])).toEqual({ viewersAdded: 0 })
    // carol (admin): erin one more; dana (owner) only when chosen
    expect(await dry('carol', [user('erin')])).toEqual({ viewersAdded: 1 })
    expect(await dry('carol', [user('dana')])).toEqual({ viewersAdded: 1 })
    expect(await dry('carol', [])).toEqual({ viewersAdded: 0 })
  })

  test('an existing project: its creator (who may change who sees it) gets the count of its members', async () => {
    const r = await A.json('/api/projects', { as: 'alice', ...jsonBody({ name: 'roles-dry-run', instructions: '', participants: [] }) })
    expect(r.status).toBe(201)
    const p = await preview('alice', { projectId: r.body.id, participants: [user('erin')] })
    // alice and erin (carol and dana are not members); erin gains it
    expect(p).toMatchObject({ people: 2, added: 1, removed: 0 })
    expect(p.adminsApart).toBeUndefined()
    // carol (admin) manages it without being a member: the same people, and nothing of what is in it counted for her
    fs.writeFileSync(path.join(A.team, r.body.folderPath, 'plan.md'), 'x')
    expect(await preview('alice', { projectId: r.body.id, participants: [user('erin')] })).toMatchObject({ files: 1 })
    const admin = await preview('carol', { projectId: r.body.id, participants: [user('erin')] })
    expect(admin).toMatchObject({ people: 2, added: 1, removed: 0, contentsHidden: true, files: 0, othersFiles: 0, sharedChats: 0, skills: 0, skillNames: [] })
    expect(admin.split).toEqual({ direct: 2, byRole: 0 })
  })
})
