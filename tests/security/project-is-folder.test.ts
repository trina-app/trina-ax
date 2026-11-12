// Projects: a folder with instructions (docs/DECISIONS.md "Projects: a folder with instructions", "Projects live only in
// projects/").
// - One project per folder: a personal project on a named folder, an admin's repoint and a folder move refuse a folder
//   another project names (409 naming it); a new team project folder and a shared personal project step around such a
//   path ("-2"). Rows from before the rule that share a folder are left as they are.
// - No project is made on an existing team folder any more (tests/security/r1-project-create.test.ts); projects older
//   builds made there keep working and are made here as those builds made them (tests/lib/legacy-project.ts).
// - Moving a chat into a project still needs read access to the project's folder.
// - Inside projects/<name> the owner and admins act only as members (docs/DECISIONS.md "Project contents only for
//   members"): an admin repoints only a project whose contents she read, at a folder she writes.
// Fixture: alice, erin = marketing (groups/marketing write); bob = finance; carol = admin; dana = owner;
// shared/ everyone write; projects/falcon: alice write, finance read (projects/ itself: no rule for members).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { componentC } from '../../server/src/team-files/component'
import { exists, jsonBody, makeCApp, type CApp } from '../lib/c-app'
import { legacyProject } from '../lib/legacy-project'

let A: CApp
beforeAll(async () => { A = await makeCApp('sec-project-is-folder') })
afterAll(async () => { await A.close() })
type Who = 'alice' | 'bob' | 'carol' | 'dana' | 'erin'
const create = (who: Who, body: Record<string, unknown>) => A.json('/api/projects', { as: who, ...jsonBody({ name: 'P', ...body }) })
const patch = (who: Who, id: string, body: Record<string, unknown>) => A.json(`/api/projects/${id}`, { as: who, ...jsonBody(body, 'PATCH') })
const mkdir = (who: Who, p: string) => A.json('/api/files/mkdir', { as: who, ...jsonBody({ path: p }) })
const move = (who: Who, from: string, to: string) => A.json('/api/files/move', { as: who, ...jsonBody({ from, to }) })
const folderOf = (id: string) => (A.ctx.db.query('SELECT folder_path AS f FROM projects WHERE id = ?').get(id) as { f: string } | null)?.f
const countOn = (p: string) => (A.ctx.db.query('SELECT COUNT(*) AS n FROM projects WHERE folder_path = ?').get(p) as { n: number }).n
/** a project row whose folder is not on disk (its folder went to the trash, or was removed outside the app) */
const staleProject = (id: string, name: string, folder: string) =>
  A.ctx.db.query("INSERT INTO projects (id, name, folder_path, instructions, created_by) VALUES (?, ?, ?, '', 'carol')").run(id, name, folder)
const ok = async (r: Promise<{ status: number; body: any }>, status = 201) => { const x = await r; expect(x.status).toBe(status); return x.body }
/** a rule for one person on a folder (a folders row, also for a folder that is not on disk, as older builds left them) */
const ruleFor = (who: Who, folder: string) => {
  let row = A.ctx.db.query('SELECT id FROM folders WHERE path = ?').get(folder) as { id: string } | null
  if (!row) { row = { id: crypto.randomUUID() }; A.ctx.db.query('INSERT INTO folders (id, path) VALUES (?, ?)').run(row.id, folder) }
  A.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'user', ?, 'write')").run(crypto.randomUUID(), row.id, who)
}

describe('one project per folder', () => {
  test('an older row that names a personal folder in another case is the same folder (case-insensitive volume)', async () => {
    // On a case-sensitive volume (Linux) another case is another folder, so this case does not apply there and the test
    // is skipped; the macOS volume this repository's tests run on is case-insensitive.
    if (!A.ctx.files.fx.caseInsensitive) return
    staleProject('01900000-0000-7000-8000-00000000a009', 'Case old', 'users/alice/projects/CASE-OLD')
    const r = await create('alice', { name: 'Lower', scope: 'personal', folderPath: 'users/alice/projects/case-old' })
    expect(r.status).toBe(409)
    expect(r.body.error.message).toContain('Case old')
    expect(countOn('users/alice/projects/case-old')).toBe(0)
  })

  test('a personal project: the same folder twice is 409; an automatic name steps around a project whose folder is gone', async () => {
    const a = await ok(create('alice', { name: 'Notes', scope: 'personal', folderPath: 'users/alice/projects/notes-p' }))
    const r = await create('alice', { name: 'Notes again', scope: 'personal', folderPath: 'users/alice/projects/notes-p' })
    expect(r.status).toBe(409)
    expect(r.body.error.message).toContain('Notes')
    expect(countOn(a.folderPath)).toBe(1)
    staleProject('01900000-0000-7000-8000-00000000a001', 'Gone', 'users/alice/projects/Gone')
    const b = await ok(create('alice', { name: 'Gone', scope: 'personal' }))
    expect(b.folderPath).toBe('users/alice/projects/Gone-2')
  })

  test('a new team project folder steps around a path a project names, named or not, and makes nothing there', async () => {
    staleProject('01900000-0000-7000-8000-00000000a002', 'Old atlas', 'projects/old-atlas')
    const named = await ok(create('carol', { name: 'New atlas', folderPath: 'projects/old-atlas' }))
    expect(named.folderPath).toBe('projects/old-atlas-2')
    expect(exists(A.team, 'projects/old-atlas')).toBe(false)
    expect(A.ctx.db.query("SELECT 1 FROM folders WHERE path = 'projects/old-atlas'").get()).toBeNull()
    const b = await ok(create('alice', { name: 'old-atlas' }))
    expect(b.folderPath).toBe('projects/old-atlas-3')
  })

  test('an admin repoint onto a folder another project uses is 409; nothing is made for it', async () => {
    // carol is one of Alpha's people (she writes its folder, so she may point at it at all)
    const a = await ok(create('alice', { name: 'Alpha', participants: [{ subjectType: 'user', subjectId: 'carol' }] }))
    // b's folder is gone (only such a project is pointed again); carol was a member of it
    const b = '01900000-0000-7000-8000-00000000a00b'
    staleProject(b, 'Beta', 'projects/beta-gone')
    ruleFor('carol', 'projects/beta-gone')
    const r = await patch('carol', b, { folderPath: a.folderPath })
    expect(r.status).toBe(409)
    expect(r.body.error.message).toContain('Alpha')
    expect(folderOf(b)).toBe('projects/beta-gone')
    // the owner, no member of what it held, may not repoint it at all (it was hers to by her role): before any folder
    // is looked at
    staleProject('01900000-0000-7000-8000-00000000a003', 'Ghost', 'projects/ghost')
    const d = await patch('dana', b, { folderPath: 'projects/ghost' })
    expect([d.status, d.body.error.params.reason]).toEqual([403, 'project_not_member'])
    ruleFor('carol', 'projects/ghost')
    const g = await patch('carol', b, { folderPath: 'projects/ghost' })
    expect([g.status, g.body.error.params.reason]).toEqual([409, 'project_folder_missing'])
    expect(exists(A.team, 'projects/ghost')).toBe(false)
    fs.mkdirSync(path.join(A.team, 'projects/ghost'))
    const taken = await patch('carol', b, { folderPath: 'projects/ghost' })
    expect([taken.status, taken.body.error.message.includes('Ghost')]).toEqual([409, true])
    expect(folderOf(b)).toBe('projects/beta-gone')
    // not at a projects/<name> she does not write (no role there now)
    fs.mkdirSync(path.join(A.team, 'projects/beta-new'))
    expect((await patch('carol', b, { folderPath: 'projects/beta-new' })).status).toBe(403)
    expect(folderOf(b)).toBe('projects/beta-gone')
    // the repoint itself still works
    ruleFor('carol', 'projects/beta-new')
    expect((await patch('carol', b, { folderPath: 'projects/beta-new' })).status).toBe(200)
    expect(folderOf(b)).toBe('projects/beta-new')
  })

  test('sharing a personal project: the new folder steps around a path a project still names; the old project stays without a folder', async () => {
    const p = await ok(create('alice', { name: 'Share me', scope: 'personal', slug: 'share-me' }))
    fs.writeFileSync(path.join(A.team, p.folderPath, 'a.md'), 'a\n')
    staleProject('01900000-0000-7000-8000-00000000a004', 'Old share', 'projects/Share me')
    const r = await A.json(`/api/projects/${p.id}/share`, { as: 'alice', ...jsonBody({ participants: [] }) })
    expect(r.status).toBe(200)
    expect(r.body.folderPath).toBe('projects/Share me-2')
    expect(exists(A.team, 'projects/Share me-2/a.md')).toBe(true)
    // the old project did not come alive: no folder at its path, and it is still the only one naming it
    expect(exists(A.team, 'projects/Share me')).toBe(false)
    expect(folderOf('01900000-0000-7000-8000-00000000a004')).toBe('projects/Share me')
    expect(countOn('projects/Share me')).toBe(1)
  })

  test('sharing: a project made on the new folder\'s path in the moment since is 409, and the folder goes again', async () => {
    const p = await ok(create('alice', { name: 'Share race', scope: 'personal', slug: 'share-race' }))
    fs.writeFileSync(path.join(A.team, p.folderPath, 'b.md'), 'b\n')
    const files = componentC(A.ctx).files as unknown as { copyFolderInto: (...a: unknown[]) => unknown }
    const real = files.copyFolderInto
    files.copyFolderInto = (...a: unknown[]) => {
      const out = real.apply(componentC(A.ctx).files, a)
      staleProject('01900000-0000-7000-8000-00000000a010', 'Raced', a[2] as string)
      return out
    }
    try {
      const r = await A.json(`/api/projects/${p.id}/share`, { as: 'alice', ...jsonBody({ participants: [] }) })
      expect(r.status).toBe(409)
      expect(r.body.error.message).toContain('Raced')
    } finally { files.copyFolderInto = real }
    expect(exists(A.team, 'projects/Share race')).toBe(false)
    expect(A.ctx.db.query("SELECT 1 FROM folders WHERE path = 'projects/Share race'").get()).toBeNull()
    expect(folderOf(p.id)).toBe(p.folderPath)
    expect(exists(A.team, p.folderPath + '/b.md')).toBe(true)
  })

  test('a folder move cannot put a project on a folder another project names; projects that already shared a folder move together', async () => {
    expect((await mkdir('alice', 'shared/mv-a')).status).toBe(201)
    const p = { id: legacyProject(A.ctx.db, A.team, 'alice', { name: 'Mover', folderPath: 'shared/mv-a' }) }
    staleProject('01900000-0000-7000-8000-00000000a005', 'Parked', 'shared/mv-b')
    const r = await move('carol', 'shared/mv-a', 'shared/mv-b')
    expect(r.status).toBe(409)
    expect(r.body.error.params).toEqual({ reason: 'project_folder_taken' })
    expect(exists(A.team, 'shared/mv-a')).toBe(true)
    expect(folderOf(p.id)).toBe('shared/mv-a')
    // a folder above the project: its new path is checked too
    expect((await mkdir('carol', 'shared/mv-top')).status).toBe(201)
    expect((await move('carol', 'shared/mv-a', 'shared/mv-top/mv-a')).status).toBe(200)
    staleProject('01900000-0000-7000-8000-00000000a006', 'Parked 2', 'shared/mv-top2/mv-a')
    expect((await move('carol', 'shared/mv-top', 'shared/mv-top2')).status).toBe(409)
    expect(folderOf(p.id)).toBe('shared/mv-top/mv-a')
    expect((await move('carol', 'shared/mv-top', 'shared/mv-top3')).status).toBe(200)
    expect(folderOf(p.id)).toBe('shared/mv-top3/mv-a')
    // two rows from before the rule on one folder: left alone, they move together and can still be edited
    expect((await mkdir('alice', 'shared/dup')).status).toBe(201)
    A.ctx.db.query("INSERT INTO projects (id, name, folder_path, instructions, created_by) VALUES ('01900000-0000-7000-8000-00000000a007', 'Dup 1', 'shared/dup', '', 'alice'), ('01900000-0000-7000-8000-00000000a008', 'Dup 2', 'shared/dup', '', 'alice')").run()
    expect((await move('carol', 'shared/dup', 'shared/dup-moved')).status).toBe(200)
    expect(countOn('shared/dup-moved')).toBe(2)
    expect((await patch('alice', '01900000-0000-7000-8000-00000000a007', { name: 'Dup one', instructions: 'x' })).status).toBe(200)
  })
})

describe('a chat moves into a project and out of it', () => {
  test('only into a project whose folder the person can read; out of it always', async () => {
    const mkt = { id: legacyProject(A.ctx.db, A.team, 'alice', { name: 'Campaign', folderPath: 'groups/marketing/campaigns' }) }
    const chatOf = (who: Who) => A.chat(who)
    const bobChat = chatOf('bob')
    const r = await A.json(`/api/chats/${bobChat}`, { as: 'bob', ...jsonBody({ projectId: mkt.id }, 'PATCH') })
    expect(r.status).toBe(404)
    expect((A.ctx.db.query('SELECT project_id AS p FROM chats WHERE id = ?').get(bobChat) as { p: string | null }).p).toBeNull()
    const erinChat = chatOf('erin')
    const inside = await A.json(`/api/chats/${erinChat}`, { as: 'erin', ...jsonBody({ projectId: mkt.id }, 'PATCH') })
    expect(inside.status).toBe(200)
    expect(inside.body.projectId).toBe(mkt.id)
    const out = await A.json(`/api/chats/${erinChat}`, { as: 'erin', ...jsonBody({ projectId: null }, 'PATCH') })
    expect(out.status).toBe(200)
    expect(out.body.projectId).toBeNull()
  })
})
