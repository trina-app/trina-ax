// A project whose folder is in the trash, decided by the project's own state (projects.trashed_with, docs/DECISIONS.md
// "Projects: a folder with instructions"), not by looking up its path in the trash. Review round 2 found three ways the
// path lookup went wrong: a purge deleted the trash row and the finance-only project showed to every member again; a
// restore under a " (restored)" name left the project on its old path, now someone else's folder; and an old, unrelated
// trash row at a path hid a new project there from its own maker. Also: the dev environment (who may use the box, who
// hears that it stopped, who may open its preview), moves, one project per folder through a restore, and the backfill.
// While its folder is in the trash or purged nobody reads a project, the owner and admins included; they manage it
// (list it with manage=1, rename, delete, restore), and repoint it only as members of what it held (docs/DECISIONS.md
// "Project contents only for members").
// Fixture: alice, erin = marketing; bob = finance; carol = admin; dana = owner; shared/ everyone write.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, ApiError } from '@mycel/shared/api'
import { MIGRATIONS_DIR, migrate, openDb, readMigrations } from '../../server/src/db'
import { setBoxdClient, type BoxdClient } from '../../server/src/devenv/boxd'
import { pollJobs, pollStops } from '../../server/src/devenv/jobs'
import { issuePreview, previewFetch } from '../../server/src/devenv/preview'
import { mayUseBox, newConsent, OFF_SETTING, saveDevEnvSetting } from '../../server/src/devenv/setting'
import { notificationsOf, notifyDevEnv } from '../../server/src/notifications/service'
import { startHarness, type Harness } from '../lib/b-harness'
import { legacyProjectFolder, oldProject } from '../lib/legacy-project'
import { WORK } from '../lib/env'

setDefaultTimeout(30_000)
let h: Harness
beforeAll(async () => { h = await startHarness({ name: 'sec-project-trash-state' }) })
afterAll(async () => { await h.close() })

const listed = async (who: string) => (await h.api(who).call(API.listProjects)).items.map((p) => p.name)
/** the list with manage=1 (the owner and admins: also the team projects they manage without reading them) */
const managed = async (who: string) => (await h.api(who).call(API.listProjects, { query: { manage: '1' } })).items
const status = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof ApiError ? e.status : 0))
const get = (who: string, id: string) => status(h.api(who).call(API.getProject, { params: { id } }))
const row = (id: string) => h.rt().store.projectRow(id)!
const project = (who: string, folderPath: string, name: string, instructions = '') => oldProject(h, who, { name, folderPath, instructions })
/** a finance-only folder under shared/ (everyone else: nothing) */
function financeOnly(dir: string, id: string) {
  fs.mkdirSync(path.join(h.team, dir), { recursive: true })
  h.ctx.db.query('INSERT INTO folders (id, path) VALUES (?, ?)').run(`f_${id}`, dir)
  h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'group', 'finance', 'write'), (?, ?, 'everyone', NULL, 'none')").run(`r_${id}_f`, `f_${id}`, `r_${id}_e`, `f_${id}`)
}
const trash = (who: string, p: string) => h.api(who).call(API.remove, { query: { path: p } })
const restore = (who: string, id: string) => h.api(who).call(API.restoreTrash, { params: { id } })
/** realtime notices with this code, by person, while `fn` runs */
async function noticesDuring(code: string, fn: () => Promise<unknown>): Promise<string[]> {
  const told: string[] = []
  const real = h.ctx.services.realtime.publish.bind(h.ctx.services.realtime)
  h.ctx.services.realtime.publish = ((user: string, frame: never) => { if ((frame as { data?: { code?: string } }).data?.code === code) told.push(user); return real(user, frame) }) as typeof h.ctx.services.realtime.publish
  try { await fn() } finally { h.ctx.services.realtime.publish = real }
  return told.sort()
}

describe('a purge does not bring the project back', () => {
  test('purged from the trash, the finance project stays the admins\': not listed, 404, nothing in a member\'s AI', async () => {
    financeOnly('shared/s1', 's1')
    const p = await project('bob', 'shared/s1', 'Purged plan', 'CANARY-P')
    const { trashId } = await trash('carol', 'shared/s1')
    await h.api('carol').call(API.purgeTrash, { params: { id: trashId } })
    expect(h.ctx.db.query('SELECT 1 FROM trash_items WHERE id = ?').get(trashId)).toBeNull()
    for (const who of ['alice', 'bob']) {
      expect(await listed(who)).not.toContain('Purged plan')
      expect(await get(who, p.id)).toBe(404)
      expect(h.rt().projectForChat(p.id, h.ctx.files.principal(who))).toBeNull()
    }
    // the admins do not read it either; they still manage it (the manage list, without its instructions), to delete it
    for (const who of ['carol', 'dana']) {
      expect(await listed(who)).not.toContain('Purged plan')
      expect(await get(who, p.id)).toBe(404)
      expect(h.rt().projectForChat(p.id, h.ctx.files.principal(who))).toBeNull()
      const m = (await managed(who)).find((x) => x.id === p.id)
      expect(m).toMatchObject({ name: 'Purged plan', member: false, instructions: '', inTrash: true })
      expect(JSON.stringify(await managed(who))).not.toContain('CANARY-P')
    }
    // a purged project is never pointed at a folder (nobody is known to have read what it held: security review M4),
    // only deleted for good
    fs.mkdirSync(path.join(h.team, 'projects/s1-new'), { recursive: true })
    h.ctx.db.query("INSERT INTO folders (id, path) VALUES ('f_s1_new', 'projects/s1-new')").run()
    h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('r_s1_new', 'f_s1_new', 'group', 'marketing', 'read'), ('r_s1_new_c', 'f_s1_new', 'user', 'carol', 'write')").run()
    const e = await h.api('carol').call(API.updateProject, { params: { id: p.id }, body: { folderPath: 'projects/s1-new' } }).then(() => null, (x: ApiError) => x)
    expect([e?.status, e?.body.params]).toEqual([403, { reason: 'project_not_member' }])
    expect(row(p.id).trashed_with).not.toBeNull()
    expect(await listed('alice')).not.toContain('Purged plan')
    await h.api('carol').call(API.deleteProject, { params: { id: p.id } })
    expect(h.ctx.db.query('SELECT 1 AS x FROM projects WHERE id = ?').get(p.id)).toBeNull()
  })
})

describe('a restore takes the project along', () => {
  test('back under a new name (a member made a folder at the old path): the project follows; the member\'s folder is hers', async () => {
    financeOnly('shared/s2', 's2')
    const p = await project('bob', 'shared/s2', 'Restored plan', 'CANARY-R')
    const { trashId } = await trash('carol', 'shared/s2')
    await h.api('alice').call(API.mkdir, { body: { path: 'shared/s2' } })
    // an admin's view of alice's access does not call her new shared/s2 the project's folder (it lists marked folders)
    const view = await h.api('carol').call(API.explainPersonAccess, { params: { id: 'alice' }, query: { prefix: 'shared' } })
    expect(JSON.stringify(view)).not.toContain('Restored plan')
    // nor does the admin folder tree
    const tree = await h.api('carol').call(API.explainAccessTree, { query: { path: 'shared' } })
    expect(JSON.stringify(tree)).toContain('s2')
    expect(JSON.stringify(tree)).not.toContain('Restored plan')
    const back = await h.api('carol').call(API.restoreTrash, { params: { id: trashId } })
    expect(back.entry.path).not.toBe('shared/s2')
    expect(row(p.id)).toMatchObject({ folder_path: back.entry.path, trashed_with: null })
    expect(await listed('bob')).toContain('Restored plan')
    expect(await listed('alice')).not.toContain('Restored plan')
    // alice's new shared/s2 is no project folder: she may move it, and make her own project on it
    expect(await status(h.api('alice').call(API.move, { body: { from: 'shared/s2', to: 'shared/s2-mine' } }))).toBe(200)
  })

  test('one project per folder through a restore: a project in place already naming the path keeps it; the restored one stays detached', async () => {
    financeOnly('shared/s3', 's3')
    const p = await project('bob', 'shared/s3', 'Detached plan')
    const { trashId } = await trash('carol', 'shared/s3')
    // a project in place that names shared/s3 although its folder is gone from disk (not through the trash)
    h.ctx.db.query("INSERT INTO projects (id, name, folder_path, instructions, created_by) VALUES ('01900000-0000-7000-8000-0000000000d3', 'Named it', 'shared/s3', '', 'carol')").run()
    const back = await h.api('carol').call(API.restoreTrash, { params: { id: trashId } })
    expect(back.entry.path).toBe('shared/s3')
    expect(row(p.id).trashed_with).toBe(trashId) // still the admins' only, for them to point at a folder
    expect(await listed('bob')).not.toContain('Detached plan')
    expect(h.ctx.db.query('SELECT COUNT(*) AS n FROM projects WHERE folder_path = ? AND trashed_with IS NULL').get('shared/s3')).toEqual({ n: 1 })
  })

  test('a folder moved while a project folder inside it is in the trash: the project still comes back with it', async () => {
    fs.mkdirSync(path.join(h.team, 'shared/outer/inner'), { recursive: true })
    const p = await project('alice', 'shared/outer/inner', 'Inner plan')
    const { trashId } = await trash('carol', 'shared/outer/inner')
    expect(await status(h.api('alice').call(API.move, { body: { from: 'shared/outer', to: 'shared/outer-2' } }))).toBe(200)
    expect(row(p.id)).toMatchObject({ folder_path: 'shared/outer-2/inner', trashed_with: trashId })
    const back = await h.api('carol').call(API.restoreTrash, { params: { id: trashId } })
    expect(back.entry.path).toBe('shared/outer-2/inner')
    expect(row(p.id)).toMatchObject({ folder_path: 'shared/outer-2/inner', trashed_with: null })
    expect(await listed('alice')).toContain('Inner plan')
  })
})

describe('an old trash row does not hide a new project', () => {
  test('an ordinary folder trashed, made again and made a project: its maker sees and opens it', async () => {
    fs.mkdirSync(path.join(h.team, 'shared/plain'), { recursive: true })
    await trash('alice', 'shared/plain')
    await h.api('alice').call(API.mkdir, { body: { path: 'shared/plain' } })
    const p = await project('alice', 'shared/plain', 'Fresh')
    expect(await listed('alice')).toContain('Fresh')
    expect(await get('alice', p.id)).toBe(200)
  })

  test('a project folder moved onto a path that was trashed before: still seen', async () => {
    fs.mkdirSync(path.join(h.team, 'shared/was-here'), { recursive: true })
    await trash('alice', 'shared/was-here')
    fs.mkdirSync(path.join(h.team, 'shared/moving'), { recursive: true })
    const p = await project('alice', 'shared/moving', 'Moving')
    expect(await status(h.api('carol').call(API.move, { body: { from: 'shared/moving', to: 'shared/was-here' } }))).toBe(200)
    expect(row(p.id).folder_path).toBe('shared/was-here')
    expect(await get('alice', p.id)).toBe(200)
  })
})

describe('who hears of it and who may restore it', () => {
  test('nobody edits its instructions while its folder is in the trash, and nobody is told: not the members reading the path above', async () => {
    financeOnly('shared/c4', 'c4')
    const p = await project('bob', 'shared/c4', 'S4 Finance plan', 'v1')
    await trash('carol', 'shared/c4')
    // its contents are nobody's while it is in the trash, the admins' included (they used to edit them)
    const told = await noticesDuring('project_instructions_changed', async () => {
      for (const who of ['carol', 'bob']) expect(await status(h.api(who).call(API.updateProject, { params: { id: p.id }, body: { instructions: 'v2' } }))).toBe(who === 'carol' ? 409 : 404) // (carol manages it: 409 project_in_trash)
    })
    expect(told).toEqual([])
    expect(row(p.id).instructions).toBe('v1')
  })

  test('a project folder an admin trashed is the admins\' in the trash too: members neither see nor restore it', async () => {
    fs.mkdirSync(path.join(h.team, 'shared/plainp'), { recursive: true })
    const p = await project('alice', 'shared/plainp', 'Plain p')
    expect(await status(trash('alice', 'shared/plainp'))).toBe(403) // a project folder: admin-only
    const { trashId } = await trash('carol', 'shared/plainp')
    const items = (await h.api('alice').call(API.trash, { query: {} })).items.map((i) => i.id)
    expect(items).not.toContain(trashId)
    expect(await status(restore('alice', trashId))).toBe(404)
    expect((await h.api('carol').call(API.trash, { query: {} })).items.map((i) => i.id)).toContain(trashId)
    await restore('carol', trashId)
    expect(row(p.id).trashed_with).toBeNull()
  })
})

describe('trashed folders inside and above a project', () => {
  test('a folder above the project: trashing it hides the project, restoring it shows it again', async () => {
    fs.mkdirSync(path.join(h.team, 'shared/up/deep/er'), { recursive: true })
    const p = await project('alice', 'shared/up/deep/er', 'Deep plan')
    const { trashId } = await trash('carol', 'shared/up')
    expect(row(p.id).trashed_with).toBe(trashId)
    expect(await get('alice', p.id)).toBe(404)
    await restore('carol', trashId)
    expect(row(p.id)).toMatchObject({ folder_path: 'shared/up/deep/er', trashed_with: null })
    expect(await get('alice', p.id)).toBe(200)
  })

  test('the child, then its parent: restoring the parent leaves the project hidden while its own folder is still in the trash', async () => {
    fs.mkdirSync(path.join(h.team, 'shared/cp/child'), { recursive: true })
    const p = await project('alice', 'shared/cp/child', 'Child plan')
    const child = (await trash('carol', 'shared/cp/child')).trashId
    const parent = (await trash('carol', 'shared/cp')).trashId
    expect(row(p.id).trashed_with).toBe(child) // the folder trashed first
    await restore('carol', parent)
    expect(row(p.id).trashed_with).toBe(child)
    expect(await get('alice', p.id)).toBe(404)
    await restore('carol', child)
    expect(row(p.id)).toMatchObject({ folder_path: 'shared/cp/child', trashed_with: null })
    expect(await get('alice', p.id)).toBe(200)
  })

  test('the child, then its parent, and the parent back under a new name: the project still comes back with its child folder', async () => {
    fs.mkdirSync(path.join(h.team, 'shared/pn/child'), { recursive: true })
    const p = await project('alice', 'shared/pn/child', 'Renamed parent plan')
    const child = (await trash('carol', 'shared/pn/child')).trashId
    const parent = (await trash('carol', 'shared/pn')).trashId
    await h.api('alice').call(API.mkdir, { body: { path: 'shared/pn' } })
    const back = await restore('carol', parent)
    expect(back.entry.path).not.toBe('shared/pn')
    expect(row(p.id)).toMatchObject({ folder_path: `${back.entry.path}/child`, trashed_with: child })
    const again = await restore('carol', child)
    expect(again.entry.path).toBe(`${back.entry.path}/child`)
    expect(row(p.id)).toMatchObject({ folder_path: `${back.entry.path}/child`, trashed_with: null })
    expect(await get('alice', p.id)).toBe(200)
  })

  test('a folder moved onto the old path of a project whose folder is in the trash: the project holds no path', async () => {
    fs.mkdirSync(path.join(h.team, 'shared/held'), { recursive: true })
    await project('alice', 'shared/held', 'Held plan')
    await trash('carol', 'shared/held')
    fs.mkdirSync(path.join(h.team, 'shared/mover'), { recursive: true })
    const m = await project('alice', 'shared/mover', 'Mover plan')
    expect(await status(h.api('carol').call(API.move, { body: { from: 'shared/mover', to: 'shared/held' } }))).toBe(200)
    expect(row(m.id).folder_path).toBe('shared/held')
  })
})

describe('an admin points a project whose folder is in the trash', () => {
  test('at the folder now at the same path: the project is in place again, seen by that folder\'s readers', async () => {
    // carol made it and is a member of it (an admin repoints only a project whose contents she read)
    legacyProjectFolder(h.ctx.db, h.team, 'projects/same', [{ subjectType: 'user', subjectId: 'carol', access: 'write' }])
    const p = await project('carol', 'projects/same', 'Same plan')
    await trash('carol', 'projects/same')
    // the folder now at that path: alice writes it
    fs.mkdirSync(path.join(h.team, 'projects/same'), { recursive: true })
    h.ctx.db.query("INSERT INTO folders (id, path) VALUES ('f_same_new', 'projects/same')").run()
    h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('r_same_new', 'f_same_new', 'user', 'alice', 'write')").run()
    // in the trash nobody reads it, carol neither: she manages it
    expect(await get('carol', p.id)).toBe(404)
    expect(await h.api('carol').call(API.getProject, { params: { id: p.id }, query: { manage: '1' } })).toMatchObject({ inTrash: true, member: false })
    // the owner, no member of what it held, may not point it anywhere
    const e = await h.api('dana').call(API.updateProject, { params: { id: p.id }, body: { folderPath: 'projects/same' } }).then(() => null, (x: ApiError) => x)
    expect([e?.status, e?.body.params]).toEqual([403, { reason: 'project_not_member' }])
    // carol, a member of what it held, only at a folder she writes herself (no role there): alice's alone is refused
    expect(await status(h.api('carol').call(API.updateProject, { params: { id: p.id }, body: { folderPath: 'projects/same' } }))).toBe(403)
    expect(row(p.id).trashed_with).not.toBeNull()
    h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('r_same_new_c', 'f_same_new', 'user', 'carol', 'write')").run()
    await h.api('carol').call(API.updateProject, { params: { id: p.id }, body: { folderPath: 'projects/same' } })
    expect(row(p.id)).toMatchObject({ folder_path: 'projects/same', trashed_with: null })
    expect(await get('alice', p.id)).toBe(200)
  })

  test('deleting it, or pointing it elsewhere, leaves the rule-less row of the folder now at its old path alone', async () => {
    for (const how of ['delete', 'repoint'] as const) {
      const dir = `projects/dm-${how}`
      // carol's own project, she a member of it
      legacyProjectFolder(h.ctx.db, h.team, dir, [{ subjectType: 'user', subjectId: 'carol', access: 'write' }])
      const p = await project('carol', dir, `Marker ${how}`)
      await trash('carol', dir)
      fs.mkdirSync(path.join(h.team, dir), { recursive: true })
      // the folder now there has a rule-less row of its own (an admin's "follow the folder above")
      h.ctx.db.query('INSERT INTO folders (id, path) VALUES (?, ?)').run(`f_live_${how}`, dir)
      if (how === 'delete') await h.api('carol').call(API.deleteProject, { params: { id: p.id } })
      else {
        legacyProjectFolder(h.ctx.db, h.team, `${dir}-elsewhere`, [{ subjectType: 'user', subjectId: 'carol', access: 'write' }])
        await h.api('carol').call(API.updateProject, { params: { id: p.id }, body: { folderPath: `${dir}-elsewhere` } })
      }
      expect(h.ctx.db.query('SELECT path FROM folders WHERE id = ?').get(`f_live_${how}`)).toEqual({ path: dir })
    }
  })
})

describe('an admin edits a project whose folder is in the trash (review round 4)', () => {
  test('a save of its name keeps it marked (its instructions nobody\'s): no folder is made, members neither hear of it nor see it', async () => {
    financeOnly('shared/fin', 'fin')
    const p = await project('bob', 'shared/fin', 'Finance plan', 'SECRET-1')
    await trash('carol', 'shared/fin')
    // its instructions are its contents: nobody's while it is in the trash, the admins' neither (refused, unchanged)
    const told = await noticesDuring('project_instructions_changed', async () => {
      expect(await status(h.api('carol').call(API.updateProject, { params: { id: p.id }, body: { name: 'Finance plan', instructions: 'SECRET-2' } }))).toBe(409) // project_in_trash: its instructions nobody's
      // a new name alone is management: the admin's
      expect(await status(h.api('carol').call(API.updateProject, { params: { id: p.id }, body: { name: 'Finance plan 2026' } }))).toBe(200)
    })
    expect(told).toEqual([])
    expect(row(p.id)).toMatchObject({ name: 'Finance plan 2026', instructions: 'SECRET-1' })
    expect(fs.existsSync(path.join(h.team, 'shared/fin'))).toBe(false)
    expect(row(p.id).trashed_with).not.toBeNull()
    expect(await listed('alice')).not.toContain('Finance plan 2026')
    expect(await get('alice', p.id)).toBe(404)
  })

  test('pointing it at a folder that is not there is refused, also its old path; nothing is made', async () => {
    financeOnly('projects/fin2', 'fin2')
    // carol is a member of it (an admin who is not one may not repoint it at all: below)
    h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('r_fin2_c', 'f_fin2', 'user', 'carol', 'write')").run()
    const p = await project('bob', 'projects/fin2', 'Finance plan 2', 'SECRET-3')
    await trash('carol', 'projects/fin2')
    // a projects/<name> she was given that is not on disk (an older build's folder row): no folder is made
    h.ctx.db.query("INSERT INTO folders (id, path) VALUES ('f_fin2_new', 'projects/fin2-new')").run()
    h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('r_fin2_new', 'f_fin2_new', 'user', 'carol', 'write')").run()
    // [path, status, reason]: its old path has no rule for her now (its rules are in the trash with it), so she may not
    // write there; the other is hers but missing
    for (const [to, want, reason] of [['projects/fin2', 403, undefined], ['projects/fin2-new', 409, 'project_folder_missing']] as const) {
      const r = await h.api('carol').call(API.updateProject, { params: { id: p.id }, body: { instructions: 'SECRET-4', folderPath: to } }).then(() => null, (e: ApiError) => e)
      expect({ to, status: r?.status, reason: r?.body.params?.reason }).toEqual({ to, status: want, reason })
      expect(fs.existsSync(path.join(h.team, to))).toBe(false)
    }
    // the owner, no member of what it held: refused before any folder is looked at
    for (const to of ['projects/fin2', 'projects/fin2-new']) {
      const r = await h.api('dana').call(API.updateProject, { params: { id: p.id }, body: { instructions: 'SECRET-4', folderPath: to } }).then(() => null, (e: ApiError) => e)
      expect({ to, status: r?.status, reason: r?.body.params?.reason }).toEqual({ to, status: 403, reason: 'project_not_member' })
      expect(fs.existsSync(path.join(h.team, to))).toBe(false)
    }
    expect(row(p.id)).toMatchObject({ trashed_with: expect.any(String), instructions: 'SECRET-3' })
    expect(await listed('alice')).not.toContain('Finance plan 2')
  })

  test('another project on a folder made at its old path does not stop the admin from saving it', async () => {
    fs.mkdirSync(path.join(h.team, 'shared/held2'), { recursive: true })
    const p = await project('alice', 'shared/held2', 'Held 2')
    await trash('carol', 'shared/held2')
    await h.api('alice').call(API.mkdir, { body: { path: 'shared/held2' } })
    await project('alice', 'shared/held2', 'Held 2 new')
    // (its instructions are nobody's while it is in the trash: refused; its name is the admin's)
    expect(await status(h.api('carol').call(API.updateProject, { params: { id: p.id }, body: { name: 'Held 2 renamed', instructions: 'x' } }))).toBe(409) // project_in_trash
    expect(await status(h.api('carol').call(API.updateProject, { params: { id: p.id }, body: { name: 'Held 2 renamed' } }))).toBe(200)
    expect(row(p.id)).toMatchObject({ name: 'Held 2 renamed', instructions: '' })
    expect(row(p.id).trashed_with).not.toBeNull()
  })

  test('no chat is made in it or moved into it: 404 for everyone, admins included', async () => {
    fs.mkdirSync(path.join(h.team, 'shared/mk'), { recursive: true })
    const p = await project('alice', 'shared/mk', 'Marked')
    const own = (await h.api('carol').call(API.createChat, { body: {} })).id
    await trash('carol', 'shared/mk')
    for (const call of [
      () => h.api('carol').call(API.createChat, { body: { projectId: p.id } }),
      () => h.api('carol').call(API.updateChat, { params: { id: own }, body: { projectId: p.id } }),
    ]) {
      // (it was 409 project_in_trash for admins: nobody reads a project in the trash now)
      const e = await call().then(() => null, (x: ApiError) => x)
      expect(e?.status).toBe(404)
    }
    expect(h.ctx.db.query('SELECT COUNT(*) AS n FROM chats WHERE project_id = ?').get(p.id)).toEqual({ n: 0 })
    expect(await status(h.api('alice').call(API.createChat, { body: { projectId: p.id } }))).toBe(404)
    // out of it is always fine
    h.ctx.db.query('UPDATE chats SET project_id = ? WHERE id = ?').run(p.id, own)
    expect((await h.api('carol').call(API.updateChat, { params: { id: own }, body: { projectId: null } })).projectId).toBeNull()
  })
})

describe('the dev environment of a project whose folder is in the trash', () => {
  const boxes: { box: string; state: 'stopped'; startedAt: null; lastActiveAt: null; memoryMiB: null; stopCode: string; stopReason: string; stoppedAt: string }[] = []
  const fake: BoxdClient = {
    async status() { return { ok: true, value: { ev: 'status', available: true, boxes } } },
    async ensure() { return { ok: true, value: { ev: 'ok' } } },
    async stop() { return { ok: true, value: { ev: 'ok' } } },
    async ps() { return { ok: true, value: { ev: 'ps', processes: [] } } },
    async preview() { return { ok: true, value: { ev: 'preview', socket: '/nonexistent/preview.sock' } } },
    async exec() { return { ok: true, value: { ev: 'exit', code: 0, signal: '', stdout: '', stderr: '', truncated: false, ms: 1 } } },
  } as BoxdClient
  beforeAll(() => { process.env.MYCEL_DEV_ENV = '1'; process.env.MYCEL_DEV_PREVIEW_ORIGIN = 'https://*.preview.example.net'; setBoxdClient(fake) })
  afterAll(() => { delete process.env.MYCEL_DEV_ENV; delete process.env.MYCEL_DEV_PREVIEW_ORIGIN; setBoxdClient(null) })

  test('nobody uses the box, only admins hear that it stopped, and an open preview stops working for members', async () => {
    financeOnly('shared/s4', 's4')
    const p = await project('bob', 'shared/s4', 'Box plan')
    saveDevEnvSetting(h.ctx.db, p.id, { ...OFF_SETTING, enabled: true, consent: newConsent({ id: 'carol', name: 'Carol Park' }) })
    const ref = { id: p.id, folderPath: 'shared/s4' }
    expect(mayUseBox(h.ctx.db, h.ctx.files, ref, 'bob')).toBe(true)
    // bob opens a preview while he may
    const link = issuePreview(h.ctx, { projectId: p.id, folderPath: 'shared/s4', port: 5173, userId: 'bob' }) as { url: string }
    const u = new URL(link.url)
    const upstream = async () => new Response('<h1>dev</h1>')
    const open = (p2: string, cookie?: string) => previewFetch(h.ctx, new Request(`https://${u.host}${p2}`, { headers: { host: u.host, ...(cookie ? { cookie } : {}) } }), upstream)
    const cookie = (await open(u.pathname + u.search)).headers.get('set-cookie')!.split(';')[0]!
    expect((await open('/', cookie)).status).toBe(200)

    await trash('carol', 'shared/s4')
    // shared/s4 now falls back to shared/ (everyone writes): before, alice and bob could use the box and hear of it
    for (const who of ['alice', 'bob', 'carol']) expect(mayUseBox(h.ctx.db, h.ctx.files, ref, who)).toBe(false)
    expect((await open('/', cookie)).status).toBe(403)
    const told: string[] = []
    const real = h.ctx.services.realtime.publish.bind(h.ctx.services.realtime)
    h.ctx.services.realtime.publish = ((user: string, frame: never) => { if ((frame as { data?: { code?: string } }).data?.code === 'dev_env_box_stopped') told.push(user); return real(user, frame) }) as typeof h.ctx.services.realtime.publish
    try {
      boxes.splice(0, boxes.length, { box: p.id, state: 'stopped', startedAt: null, lastActiveAt: null, memoryMiB: null, stopCode: 'disk', stopReason: 'disk', stoppedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z') })
      await pollStops(h.ctx)
    } finally { h.ctx.services.realtime.publish = real }
    expect(told.sort()).toEqual(['carol', 'dana'])

    // a job of bob's that ends now: no notice for him (its log stays out)
    h.ctx.db.query("INSERT INTO dev_env_jobs (id, project_id, name, user_id, started_at) VALUES ('job-s4', ?, 'build', 'bob', '2020-01-01T00:00:00.000Z')").run(p.id)
    expect(await noticesDuring('dev_env_job', () => pollJobs(h.ctx, p.id))).toEqual([])
    expect(h.ctx.db.query("SELECT ended_at IS NOT NULL AS ended FROM dev_env_jobs WHERE id = 'job-s4'").get()).toEqual({ ended: 1 })
    // bob's inbox entry for a stop of this box does not name the project, also once a folder is made at its old path
    fs.mkdirSync(path.join(h.team, 'shared/s4'), { recursive: true })
    h.ctx.db.query("INSERT INTO dev_env_stops (id, project_id, code, reason, stopped_at) VALUES ('stop-s4', ?, 'disk', '', '2026-11-02T10:00:00Z')").run(p.id)
    notifyDevEnv(h.ctx, 'bob', 'dev_env.box', 'stop-s4')
    const entry = notificationsOf(h.ctx).list('bob', {}).items.find((i) => i.sourceId === 'stop-s4')!
    expect(entry).toBeDefined()
    expect(entry.devEnv).toBeUndefined()
    expect(entry.link).toBeNull()
  })

  test('the inbox entry of a scheduled run in a chat of that project does not link the chat', async () => {
    financeOnly('shared/s5', 's5')
    const p = await project('bob', 'shared/s5', 'Inbox plan')
    const chat = (await h.api('alice').call(API.createChat, { body: {} })).id
    h.ctx.db.query('UPDATE chats SET project_id = ? WHERE id = ?').run(p.id, chat)
    const turn = '01900000-0000-7000-8000-0000000000f5'
    h.ctx.db.query("INSERT INTO turns (id, chat_id, user_id, engine, status, queued_at, started_at, ended_at) VALUES (?, ?, 'alice', 'claude-code', 'done', ?, ?, ?)").run(turn, chat, new Date().toISOString(), new Date().toISOString(), new Date().toISOString())
    h.ctx.db.query("INSERT INTO notification_inbox (id, user_id, event_type, source_id, created_at) VALUES ('inbox-s5', 'alice', 'schedule.success', ?, ?)").run(turn, new Date().toISOString())
    await trash('carol', 'shared/s5')
    // a new folder at the old path: shared/s5 falls back to shared/ (alice reads it), but the project is not hers to see
    await h.api('alice').call(API.mkdir, { body: { path: 'shared/s5' } })
    const entry = notificationsOf(h.ctx).list('alice', {}).items.find((i) => i.id === 'inbox-s5')!
    expect(entry).toBeDefined()
    expect(entry.chatId).toBeNull()
  })
})

describe('the backfill of projects whose folder is in the trash (migration 332)', () => {
  test('the earliest unrestored folder item at or above a team project\'s folder, deleted after the project was made', () => {
    const dir = path.join(WORK, 'sec-project-trash-332'), part = path.join(dir, 'before')
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(part, { recursive: true })
    for (const m of readMigrations().filter((m) => m.version !== 332)) fs.copyFileSync(path.join(MIGRATIONS_DIR, m.name), path.join(part, m.name))
    const db = openDb(path.join(dir, 'app.db'), { migrationsDir: part })
    try {
      db.query("INSERT INTO users (id, username, name, role) VALUES ('alice','alice','Alice','member')").run()
      const proj = (id: string, folder: string) => db.query("INSERT INTO projects (id, name, folder_path, created_by, created_at) VALUES (?, ?, ?, 'alice', '2026-10-10T00:00:00.000Z')").run(id, id, folder)
      const item = (id: string, original: string, kind: string, at: string, restored: string | null = null) =>
        db.query("INSERT INTO trash_items (id, original_path, storage_path, size, deleted_by, purge_at, kind, deleted_at, restored_at) VALUES (?, ?, ?, 0, 'alice', '2027-01-01T00:00:00Z', ?, ?, ?)").run(id, original, `.system/trash/2026-10/${id}`, kind, at, restored)
      proj('in-trash', 'shared/a/b'); item('t-a', 'shared/a', 'folder', '2026-10-12T00:00:00.000Z'); item('t-b', 'shared/a/b', 'folder', '2026-10-11T00:00:00.000Z')
      proj('restored', 'shared/r'); item('t-r', 'shared/r', 'folder', '2026-10-12T00:00:00.000Z', '2026-10-13T00:00:00.000Z')
      proj('older-row', 'shared/o'); item('t-o', 'shared/o', 'folder', '2026-10-01T00:00:00.000Z') // trashed before the project: another folder
      proj('a-file', 'shared/f'); item('t-f', 'shared/f', 'file', '2026-10-12T00:00:00.000Z')
      proj('prefix', 'shared/ab'); // 'shared/a' is not above 'shared/ab'
      proj('personal', 'users/alice/p'); item('t-p', 'users/alice/p', 'folder', '2026-10-12T00:00:00.000Z')
      proj('root', '')
      // the trashed folder took rows with it: one must be the project's own, parked at its place
      proj('with-row', 'shared/w/p'); item('t-w', 'shared/w', 'folder', '2026-10-12T00:00:00.000Z')
      db.query("INSERT INTO folders (id, path) VALUES ('f-w', '.system/trash/2026-10/t-w'), ('f-w-p', '.system/trash/2026-10/t-w/p')").run()
      // moved later onto a path where an unrelated folder (with a row elsewhere inside) had been trashed: its row is in place
      proj('moved-later', 'shared/m'); item('t-m', 'shared/m', 'folder', '2026-10-12T00:00:00.000Z')
      db.query("INSERT INTO folders (id, path) VALUES ('f-m-sub', '.system/trash/2026-10/t-m/sub'), ('f-m-live', 'shared/m')").run()
      migrate(db, { backupDir: path.join(dir, 'backups') })
      // in-trash: its folders took no rows; failing closed, it counts
      expect(db.query('SELECT id, trashed_with AS t FROM projects ORDER BY id').all()).toEqual([
        { id: 'a-file', t: null }, { id: 'in-trash', t: 't-b' }, { id: 'moved-later', t: null }, { id: 'older-row', t: null },
        { id: 'personal', t: null }, { id: 'prefix', t: null }, { id: 'restored', t: null }, { id: 'root', t: null },
        { id: 'with-row', t: 't-w' },
      ])
      expect(db.query("SELECT name FROM sqlite_master WHERE name LIKE '%332%'").all()).toEqual([])
    } finally { db.close() }
  })
})
