// Security round 2 (sharing-works #3): a project on an existing folder adds a rule-less folders row, and every folders
// row made a folder (and each folder above it) admin-only to move, rename or trash. Deleting the project left the row,
// so the folder stayed locked for good, its author's own included, and one member could lock a teammate's folder that
// way. Now a rule-less row counts only while a project uses that folder, and it is dropped with the last project
// (delete, repoint, share). Rule folders, group folders, shared/ and skills/ stay admin-only.
// Fixture: alice, erin = marketing (groups/marketing write); bob = finance; carol = admin; shared/ everyone write.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { jsonBody, makeCApp, type CApp } from '../lib/c-app'

let A: CApp
beforeAll(async () => { A = await makeCApp('sec-r2-project-unlock') })
afterAll(async () => { await A.close() })
type Who = 'alice' | 'bob' | 'carol' | 'dana' | 'erin'
const q = (o: Record<string, string>) => '?' + new URLSearchParams(o).toString()
const mkdir = (who: Who, p: string) => A.json('/api/files/mkdir', { as: who, ...jsonBody({ path: p }) })
const move = (who: Who, from: string, to: string) => A.json('/api/files/move', { as: who, ...jsonBody({ from, to }) })
const trash = (who: Who, p: string) => A.json('/api/files' + q({ path: p }), { as: who, method: 'DELETE' })
const create = async (who: Who, folderPath: string) => { const r = await A.json('/api/projects', { as: who, ...jsonBody({ name: 'P ' + folderPath, folderPath }) }); expect(r.status).toBe(201); return r.body.id as string }
const remove = async (who: Who, id: string) => expect((await A.json(`/api/projects/${id}`, { as: who, method: 'DELETE' })).status).toBe(204)
const row = (p: string) => A.ctx.db.query('SELECT id FROM folders WHERE path = ?').get(p)

describe('a project folder is admin-only while the project lasts, and only then', () => {
  test('a teammate\'s project on erin\'s folder: locked while it exists, erin\'s again once it is deleted', async () => {
    expect((await mkdir('erin', 'groups/marketing/erin-drafts')).status).toBe(201)
    expect((await move('erin', 'groups/marketing/erin-drafts', 'groups/marketing/erin-drafts2')).status).toBe(200) // control
    const id = await create('alice', 'groups/marketing/erin-drafts2')
    expect((await move('erin', 'groups/marketing/erin-drafts2', 'groups/marketing/x')).status).toBe(403) // tab 4: admin-only
    await remove('alice', id)
    expect(row('groups/marketing/erin-drafts2')).toBeNull()
    expect((await move('erin', 'groups/marketing/erin-drafts2', 'groups/marketing/erin-drafts3')).status).toBe(200)
    expect((await move('erin', 'groups/marketing/erin-drafts3', 'shared/erin-drafts3')).status).toBe(200)
    expect((await trash('erin', 'shared/erin-drafts3')).status).toBe(200)
  })

  test('the folder above a deleted project\'s folder is free again too', async () => {
    expect((await mkdir('erin', 'groups/marketing/p')).status).toBe(201)
    expect((await mkdir('erin', 'groups/marketing/p/inner')).status).toBe(201)
    const id = await create('erin', 'groups/marketing/p/inner')
    expect((await move('erin', 'groups/marketing/p', 'groups/marketing/q')).status).toBe(403)
    await remove('erin', id)
    expect((await move('erin', 'groups/marketing/p', 'groups/marketing/q')).status).toBe(200)
    expect((await trash('erin', 'groups/marketing/q')).status).toBe(200)
  })

  test('two projects on one folder: it stays locked until the last one goes', async () => {
    expect((await mkdir('alice', 'shared/two')).status).toBe(201)
    const a = await create('alice', 'shared/two')
    const b = await create('erin', 'shared/two')
    await remove('alice', a)
    expect(row('shared/two')).not.toBeNull()
    expect((await move('alice', 'shared/two', 'shared/two-x')).status).toBe(403)
    await remove('erin', b)
    expect((await move('alice', 'shared/two', 'shared/two-x')).status).toBe(200)
  })

  test('an admin repoints a project: the old folder is free, the new one is the project\'s (admin-only)', async () => {
    expect((await mkdir('alice', 'shared/old-home')).status).toBe(201)
    expect((await mkdir('alice', 'shared/new-home')).status).toBe(201)
    const id = await create('alice', 'shared/old-home')
    expect((await A.json(`/api/projects/${id}`, { as: 'carol', ...jsonBody({ folderPath: 'shared/new-home' }, 'PATCH') })).status).toBe(200)
    expect(row('shared/old-home')).toBeNull()
    expect((await move('alice', 'shared/old-home', 'shared/old-home-2')).status).toBe(200)
    expect((await move('alice', 'shared/new-home', 'shared/new-home-2')).status).toBe(403)
  })

  test('a row that still means something stays: a group folder\'s rules, a stale marker counts for nothing', async () => {
    const id = await create('carol', 'groups/marketing')
    await remove('carol', id)
    expect(row('groups/marketing')).not.toBeNull()
    expect((A.ctx.db.query("SELECT COUNT(*) AS n FROM folder_rules r JOIN folders f ON f.id = r.folder_id WHERE f.path = 'groups/marketing'").get() as { n: number }).n).toBeGreaterThan(0)
    expect((await move('alice', 'groups/marketing', 'groups/mkt')).status).toBe(403)
    expect((await trash('alice', 'shared')).status).toBe(403)
    // a rule-less row left behind by an older build (no project uses it): ordinary folder
    expect((await mkdir('alice', 'shared/stale')).status).toBe(201)
    A.ctx.db.query("INSERT INTO folders (id, path) VALUES ('f_stale', 'shared/stale')").run()
    expect((await move('alice', 'shared/stale', 'shared/stale-2')).status).toBe(200)
  })
})
