// Projects: a folder with instructions (docs/DECISIONS.md "Projects: a folder with instructions").
// - One project per folder: each way to make a project (an existing folder, a personal one, a new team project folder),
//   an admin's repoint, a personal project shared by copy and a folder move refuse a folder another project names
//   (409 naming it). Rows from before the rule that share a folder are left as they are.
// - The lock a project puts on its folder (admin-only to move, rename or trash) may only come from someone who could
//   get around it: on a folder that is not managed yet, the creator must also write the folder it is in. That check is
//   a guard: under today's rules (a folder without rules inherits its parent's access) it refuses nothing.
// - Moving a chat into a project still needs read access to the project's folder.
// Fixture: alice, erin = marketing (groups/marketing write); bob = finance; carol = admin; dana = owner;
// shared/ everyone write; projects/falcon: alice write, finance read (projects/ itself: no rule for members).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { RuleSet, type Access, type Principal } from '../../server/src/policy/access'
import { componentC } from '../../server/src/team-files/component'
import { exists, jsonBody, makeCApp, type CApp } from '../lib/c-app'

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

describe('one project per folder', () => {
  test('an existing folder: a second project on it is 409 and names the first; nothing is added', async () => {
    expect((await mkdir('alice', 'shared/one')).status).toBe(201)
    const first = await ok(create('alice', { name: 'Launch plan', folderPath: 'shared/one' }))
    const rows = (A.ctx.db.query('SELECT COUNT(*) AS n FROM folders').get() as { n: number }).n
    for (const [who, typed] of [['erin', 'shared/one'], ['carol', 'shared/one'], ['alice', 'shared/one']] as const) {
      const r = await create(who, { name: 'Again', folderPath: typed })
      expect(r.status).toBe(409)
      expect(r.body.error.message).toContain('Launch plan')
      expect(r.body.error.params).toEqual({ reason: 'project_folder_taken', projectId: first.id })
    }
    expect(countOn('shared/one')).toBe(1)
    expect((A.ctx.db.query('SELECT COUNT(*) AS n FROM folders').get() as { n: number }).n).toBe(rows)
  })

  test('an older row that names the folder in another case is the same folder (case-insensitive volume)', async () => {
    // On a case-sensitive volume (Linux) `Shared/Case-Old` is another folder, so this case does not apply there and
    // the test is skipped; the macOS volume this repository's tests run on is case-insensitive.
    if (!A.ctx.files.fx.caseInsensitive) return
    expect((await mkdir('alice', 'shared/case-old')).status).toBe(201)
    staleProject('01900000-0000-7000-8000-00000000a009', 'Case old', 'Shared/CASE-OLD')
    const r = await create('erin', { name: 'Lower', folderPath: 'shared/case-old' })
    expect(r.status).toBe(409)
    // rules match exact names, so erin cannot see a project stored as Shared/CASE-OLD: the 409 does not name it
    expect(r.body.error.message).not.toContain('Case old')
    const admin = await create('carol', { name: 'Lower', folderPath: 'shared/case-old' })
    expect(admin.status).toBe(409)
    expect(admin.body.error.message).toContain('Case old')
    expect(countOn('shared/case-old')).toBe(0)
  })

  test('a personal project: the same folder twice is 409; an automatic name steps around a project whose folder is gone', async () => {
    const a = await ok(create('alice', { name: 'Notes', scope: 'personal', folderPath: 'users/alice/notes-p' }))
    const r = await create('alice', { name: 'Notes again', scope: 'personal', folderPath: 'users/alice/notes-p' })
    expect(r.status).toBe(409)
    expect(r.body.error.message).toContain('Notes')
    expect(countOn(a.folderPath)).toBe(1)
    staleProject('01900000-0000-7000-8000-00000000a001', 'Gone', 'users/alice/projects/Gone')
    const b = await ok(create('alice', { name: 'Gone', scope: 'personal' }))
    expect(b.folderPath).toBe('users/alice/projects/Gone-2')
  })

  test('a new team project folder: an explicit path a project names is 409 and leaves no folder; an automatic one steps around it', async () => {
    staleProject('01900000-0000-7000-8000-00000000a002', 'Old atlas', 'projects/old-atlas')
    const r = await create('carol', { name: 'New atlas', folderPath: 'projects/old-atlas' })
    expect(r.status).toBe(409)
    expect(r.body.error.message).toContain('Old atlas')
    expect(exists(A.team, 'projects/old-atlas')).toBe(false)
    expect(A.ctx.db.query("SELECT 1 FROM folders WHERE path = 'projects/old-atlas'").get()).toBeNull()
    const b = await ok(create('carol', { name: 'old-atlas' }))
    expect(b.folderPath).toBe('projects/old-atlas-2')
  })

  test('an admin repoint onto a folder another project uses is 409; a folder made for it goes again', async () => {
    expect((await mkdir('alice', 'shared/two')).status).toBe(201)
    const a = await ok(create('alice', { name: 'Alpha', folderPath: 'shared/one-a' }))
    const b = await ok(create('alice', { name: 'Beta', folderPath: 'shared/two' }))
    const r = await patch('carol', b.id, { folderPath: a.folderPath })
    expect(r.status).toBe(409)
    expect(r.body.error.message).toContain('Alpha')
    expect(folderOf(b.id)).toBe('shared/two')
    staleProject('01900000-0000-7000-8000-00000000a003', 'Ghost', 'shared/ghost')
    const g = await patch('dana', b.id, { folderPath: 'shared/ghost' })
    expect(g.status).toBe(409)
    expect(g.body.error.message).toContain('Ghost')
    expect(exists(A.team, 'shared/ghost')).toBe(false)
    expect(folderOf(b.id)).toBe('shared/two')
    // the repoint itself still works
    expect((await patch('carol', b.id, { folderPath: 'shared/two-b' })).status).toBe(200)
    expect(folderOf(b.id)).toBe('shared/two-b')
  })

  test('sharing a personal project by copy: the copy steps around a path a project still names; the old project stays without a folder', async () => {
    const p = await ok(create('alice', { name: 'Share me', scope: 'personal', slug: 'share-me' }))
    fs.writeFileSync(path.join(A.team, p.folderPath, 'a.md'), 'a\n')
    staleProject('01900000-0000-7000-8000-00000000a004', 'Old share', 'shared/share-me')
    const r = await A.json(`/api/projects/${p.id}/share`, { as: 'alice', ...jsonBody({ toParent: 'shared' }) })
    expect(r.status).toBe(200)
    expect(r.body.folderPath).toBe('shared/share-me (2)')
    expect(exists(A.team, 'shared/share-me (2)/a.md')).toBe(true)
    // the old project did not come alive: no folder at its path, and it is still the only one naming it
    expect(exists(A.team, 'shared/share-me')).toBe(false)
    expect(folderOf('01900000-0000-7000-8000-00000000a004')).toBe('shared/share-me')
    expect(countOn('shared/share-me')).toBe(1)
  })

  test('sharing by copy: a project made on the copy\'s path in the moment since is 409, and the copy goes again', async () => {
    const p = await ok(create('alice', { name: 'Share race', scope: 'personal', slug: 'share-race' }))
    fs.writeFileSync(path.join(A.team, p.folderPath, 'b.md'), 'b\n')
    const files = componentC(A.ctx).files as unknown as { copyFolderTree: (...a: unknown[]) => { path?: string } }
    const real = files.copyFolderTree
    files.copyFolderTree = (...a: unknown[]) => {
      const out = real.apply(componentC(A.ctx).files, a)
      if (out.path) staleProject('01900000-0000-7000-8000-00000000a010', 'Raced', out.path)
      return out
    }
    try {
      const r = await A.json(`/api/projects/${p.id}/share`, { as: 'alice', ...jsonBody({ toParent: 'shared' }) })
      expect(r.status).toBe(409)
      expect(r.body.error.message).toContain('Raced')
    } finally { files.copyFolderTree = real }
    expect(exists(A.team, 'shared/share-race')).toBe(false)
    expect(folderOf(p.id)).toBe(p.folderPath)
    expect(exists(A.team, p.folderPath + '/b.md')).toBe(true)
  })

  test('a folder move cannot put a project on a folder another project names; projects that already shared a folder move together', async () => {
    expect((await mkdir('alice', 'shared/mv-a')).status).toBe(201)
    const p = await ok(create('alice', { name: 'Mover', folderPath: 'shared/mv-a' }))
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

describe('a project locks its folder only for someone who could get around the lock', () => {
  test('a rule folder the person writes but whose parent they cannot write keeps today\'s rule (it is admin-only already)', async () => {
    expect(A.ctx.files.rules().access(A.ctx.files.principal('alice'), ['projects'])).toBe('none')
    await ok(create('alice', { name: 'Falcon', folderPath: 'projects/falcon' }))
  })

  test('nothing is locked in a personal folder: the person\'s own folder works although users/ is read-only', async () => {
    await ok(create('erin', { name: 'Mine', folderPath: 'users/erin' }))
  })

  test('guard (refuses nothing under today\'s rules): a folder not managed yet whose parent the person cannot write is 403, nothing made; an admin may', async () => {
    // A guard test. Today a folder without rules has its parent's access (it inherits), so write on a folder that is not
    // managed is write on its parent and the check never refuses anything. It stays in case inheritance changes. This
    // permission function gives erin write on groups/marketing/erin-x but only read on its parent, to test the guard.
    class Narrow extends RuleSet {
      override access(p: Principal, segs: readonly string[]): Access {
        return p.id === 'erin' && segs.join('/') === 'groups/marketing' ? 'read' : super.access(p, segs)
      }
    }
    const files = A.ctx.files as unknown as { rules: () => RuleSet }
    const real = files.rules
    files.rules = () => new Narrow(A.ctx.db.query('SELECT f.path, r.subject_type, r.subject_id, r.access FROM folder_rules r JOIN folders f ON f.id = r.folder_id').all() as never)
    try {
      expect(files.rules().access(A.ctx.files.principal('erin'), ['groups', 'marketing', 'erin-x'])).toBe('write')
      const r = await create('erin', { name: 'Erin X', folderPath: 'groups/marketing/erin-x' })
      expect(r.status).toBe(403)
      expect(r.body.error.params).toEqual({ reason: 'parent_not_writable' })
      expect(exists(A.team, 'groups/marketing/erin-x')).toBe(false)
      expect(A.ctx.db.query("SELECT 1 FROM folders WHERE path = 'groups/marketing/erin-x'").get()).toBeNull()
      // a managed folder below that parent (one with rules of its own) keeps today's rule
      A.ctx.db.query("INSERT INTO folders (id, path) VALUES ('f_erin_rules', 'groups/marketing/erin-rules')").run()
      A.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('r_erin_rules', 'f_erin_rules', 'group', 'marketing', 'write')").run()
      await ok(create('erin', { name: 'Erin rules', folderPath: 'groups/marketing/erin-rules' }))
    } finally { files.rules = real }
    await ok(create('carol', { name: 'Erin X', folderPath: 'groups/marketing/erin-x' }))
  })

  test('the usual case: a member with write on the folder above makes a project on a teammate\'s folder', async () => {
    expect((await mkdir('erin', 'groups/marketing/erin-drafts')).status).toBe(201)
    await ok(create('alice', { name: 'Drafts', folderPath: 'groups/marketing/erin-drafts' }))
    expect((await move('erin', 'groups/marketing/erin-drafts', 'groups/marketing/erin-drafts-2')).status).toBe(403)
  })
})

describe('a chat moves into a project and out of it', () => {
  test('only into a project whose folder the person can read; out of it always', async () => {
    const mkt = await ok(create('alice', { name: 'Campaign', folderPath: 'groups/marketing/campaigns' }))
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
