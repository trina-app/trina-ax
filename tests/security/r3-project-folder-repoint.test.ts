// Security round 3 (sharing-works #6): a team project's folder could be moved into one member's personal folder,
// taking the project, its instructions and its files away from the whole team, once it had no folders row: after an
// admin re-pointed the project (PATCH folderPath) or removed the folder's empty entry in Admin > Folders. Fixed by
// r2 (a folder a team project uses is managed through the projects table itself, not only a folders row); this locks
// the audit's two paths in. Fixture: alice, erin = marketing; bob = finance; carol = admin; dana = owner;
// shared/ everyone write.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { jsonBody, makeCApp, type CApp } from '../lib/c-app'

let A: CApp
beforeAll(async () => { A = await makeCApp('sec-r3-project-repoint') })
afterAll(async () => { await A.close() })
type Who = 'alice' | 'bob' | 'carol' | 'dana' | 'erin'
const save = (who: Who, p: string, content: string) => A.json('/api/files/content', { as: who, ...jsonBody({ path: p, content, baseSha256: null }, 'PUT') })
const move = (who: Who, from: string, to: string) => A.json('/api/files/move', { as: who, ...jsonBody({ from, to, onExists: 'fail', confirm: true }) })
const sees = async (who: Who, id: string) => ((await A.json('/api/projects', { as: who })).body.items as { id: string }[]).some((p) => p.id === id)
const create = async (folderPath: string) => { const r = await A.json('/api/projects', { as: 'carol', ...jsonBody({ name: 'P ' + folderPath, folderPath, instructions: 'team instructions' }) }); expect(r.status).toBe(201); return r.body.id as string }
const folderPathOf = (id: string) => (A.ctx.db.query('SELECT folder_path FROM projects WHERE id = ?').get(id) as { folder_path: string }).folder_path

async function stillTheTeams(id: string, folder: string, file: string) {
  expect(folderPathOf(id)).toBe(folder)
  for (const who of ['alice', 'bob', 'carol', 'dana'] as const) expect(await sees(who, id)).toBe(true)
  expect((await A.json('/api/files/content?path=' + encodeURIComponent(`${folder}/${file}`), { as: 'erin' })).status).toBe(200)
}

describe('a team project\'s folder never moves into a member\'s personal folder', () => {
  test('after an admin re-points the project (the new folder has no folders row)', async () => {
    const id = await create('shared/launch-v1')
    expect((await A.json(`/api/projects/${id}`, { as: 'carol', ...jsonBody({ folderPath: 'shared/launch-v2' }, 'PATCH') })).status).toBe(200)
    expect((await save('alice', 'shared/launch-v2/plan.md', 'plan\n')).status).toBe(200)
    for (const [from, to] of [['shared/launch-v2', 'users/bob/launch-v2'], ['shared', 'users/bob/all']] as const) {
      const r = await move('bob', from, to)
      expect(r.status).toBe(403)
    }
    await stillTheTeams(id, 'shared/launch-v2', 'plan.md')
  })

  test('after an admin removes the folder\'s empty entry in Admin > Folders', async () => {
    const id = await create('shared/plan-a')
    expect((await save('alice', 'shared/plan-a/notes.md', 'notes\n')).status).toBe(200)
    const row = A.ctx.db.query("SELECT id FROM folders WHERE path = 'shared/plan-a'").get() as { id: string } | null
    expect(row).not.toBeNull()
    expect((await A.json(`/api/admin/folders/${row!.id}`, { as: 'carol', method: 'DELETE' })).status).toBe(204)
    expect((await move('bob', 'shared/plan-a', 'users/bob/plan-a')).status).toBe(403)
    expect((await move('bob', 'shared/plan-a', 'shared/plan-b')).status).toBe(403) // a rename is admin-only too
    await stillTheTeams(id, 'shared/plan-a', 'notes.md')
  })
})
