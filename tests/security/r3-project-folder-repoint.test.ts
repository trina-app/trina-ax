// Security round 3 (sharing-works #6): a team project's folder could be moved into one member's personal folder,
// taking the project, its instructions and its files away from the whole team, once it had no folders row: after an
// admin re-pointed the project (PATCH folderPath) or removed the folder's empty entry in Admin > Folders. Fixed by
// r2 (a folder a team project uses is managed through the projects table itself, not only a folders row); this locks
// the audit's two paths in. Since "Projects live only in projects/" (docs/DECISIONS.md) an admin points only a project
// whose folder is in the trash or missing, only at an existing projects/<name>: the first path is that now. Older
// projects on shared/ are made as older builds made them (tests/lib/legacy-project.ts). Since "Project contents only for
// members" the admin also needs write on the projects/<name> she points it at, as a member of it (no role there).
// Fixture: alice, erin = marketing; bob = finance; carol = admin; dana = owner; shared/ everyone write.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { jsonBody, makeCApp, type CApp } from '../lib/c-app'
import { legacyProject, legacyProjectFolder } from '../lib/legacy-project'

let A: CApp
beforeAll(async () => { A = await makeCApp('sec-r3-project-repoint') })
afterAll(async () => { await A.close() })
type Who = 'alice' | 'bob' | 'carol' | 'dana' | 'erin'
const save = (who: Who, p: string, content: string) => A.json('/api/files/content', { as: who, ...jsonBody({ path: p, content, baseSha256: null }, 'PUT') })
const move = (who: Who, from: string, to: string) => A.json('/api/files/move', { as: who, ...jsonBody({ from, to, onExists: 'fail', confirm: true }) })
const sees = async (who: Who, id: string) => ((await A.json('/api/projects', { as: who })).body.items as { id: string }[]).some((p) => p.id === id)
const create = async (folderPath: string) => legacyProject(A.ctx.db, A.team, 'carol', { name: 'P ' + folderPath, folderPath, instructions: 'team instructions' })
const repoint = (who: Who, id: string, folderPath: string) => A.json(`/api/projects/${id}`, { as: who, ...jsonBody({ folderPath }, 'PATCH') })
const folderPathOf = (id: string) => (A.ctx.db.query('SELECT folder_path FROM projects WHERE id = ?').get(id) as { folder_path: string }).folder_path

async function stillTheTeams(id: string, folder: string, file: string) {
  expect(folderPathOf(id)).toBe(folder)
  for (const who of ['alice', 'bob', 'carol', 'dana'] as const) expect(await sees(who, id)).toBe(true)
  expect((await A.json('/api/files/content?path=' + encodeURIComponent(`${folder}/${file}`), { as: 'erin' })).status).toBe(200)
}

describe('a team project\'s folder never moves into a member\'s personal folder', () => {
  test('an admin points a project whose folder is gone, only at an existing projects/<name>', async () => {
    const id = await create('shared/launch-v1')
    expect((await save('alice', 'shared/launch-v1/plan.md', 'plan\n')).status).toBe(200)
    // in place: never pointed elsewhere, not even by an admin
    const inPlace = await repoint('carol', id, 'projects/falcon')
    expect([inPlace.status, inPlace.body.error.params.reason]).toEqual([409, 'project_location'])
    // its folder goes to the trash (an admin: it is a project folder)
    expect((await A.json('/api/files?path=' + encodeURIComponent('shared/launch-v1'), { as: 'carol', method: 'DELETE' })).status).toBe(200)
    for (const folderPath of ['shared/launch-v2', 'shared', 'users/carol', 'projects']) {
      const r = await repoint('carol', id, folderPath)
      expect([folderPath, r.status, r.body.error.params.reason]).toEqual([folderPath, 400, 'project_location'])
    }
    // inside a project she is not a member of she writes nothing (it was 400 project_location by her role's write)
    const inside = await repoint('carol', id, 'projects/falcon/public')
    expect(inside.status).toBe(403)
    expect(folderPathOf(id)).toBe('shared/launch-v1')
    // a projects/<name> she was given (an older build's folder row) that is not on disk
    A.ctx.db.query("INSERT INTO folders (id, path) VALUES ('f_r3_launch', 'projects/launch')").run()
    A.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('r_r3_launch', 'f_r3_launch', 'user', 'carol', 'write')").run()
    expect((await repoint('carol', id, 'projects/launch')).body.error.params.reason).toBe('project_folder_missing')
    expect((await repoint('alice', id, 'projects/falcon')).status).toBe(404) // nobody reads it now; alice does not manage it
    fs.mkdirSync(path.join(A.team, 'projects/launch'), { recursive: true })
    expect((await repoint('carol', id, 'projects/launch')).status).toBe(200)
    expect(folderPathOf(id)).toBe('projects/launch')
    // members cannot move a project folder anywhere, their personal folder included
    expect((await move('bob', 'projects/launch', 'users/bob/launch')).status).not.toBe(200)
    // a folder gone from disk another way (not the trash) counts as gone too
    fs.rmSync(path.join(A.team, 'projects/launch'), { recursive: true })
    // not at a project she is not a member of (it was allowed by her role): she does not write there
    expect((await repoint('carol', id, 'projects/falcon')).status).toBe(403)
    expect(folderPathOf(id)).toBe('projects/launch')
    legacyProjectFolder(A.ctx.db, A.team, 'projects/launch-2', [{ subjectType: 'user', subjectId: 'carol', access: 'write' }])
    expect((await repoint('carol', id, 'projects/launch-2')).status).toBe(200)
    expect(folderPathOf(id)).toBe('projects/launch-2')
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
