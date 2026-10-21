// Security round 2 (sharing-works #1 and #5): what the trash shows and where a restore lands follow the folder an item
// was trashed from, not only the path it had.
// #1 (fix incomplete after r1): files trashed from a group / project folder that an admin then trashed kept their old
// path. A new group (or an admin rule folder) that took the old name saw those files in its trash and restored them
// into its own folder, contents and all. They are now hidden while their folder is in the trash, come back into the
// trash of the folder wherever it is restored (" (restored)" name included), and go for good when it is purged.
// #5: a trashed group / project / rule folder was listed in its members' trash, but their restore failed with 404
// (they cannot write groups/ or projects/). Trashing those folders is admin-only, and so is seeing and restoring them.
// Fixture: alice, erin = marketing (groups/marketing write); bob = finance (groups/finance, projects/atlas write);
// carol = admin; dana = owner; shared/ everyone write.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { FolderRuleInput } from '@mycel/shared/api'
import { ensureFolderRow, replaceRules } from '../../server/src/admin/folders'
import { jsonBody, makeCApp, type CApp } from '../lib/c-app'

let A: CApp
beforeAll(async () => { A = await makeCApp('sec-r2-trash-home') })
afterAll(async () => { await A.close() })
type Who = 'alice' | 'bob' | 'carol' | 'dana' | 'erin'
const q = (o: Record<string, string>) => '?' + new URLSearchParams(o).toString()
const save = (who: Who, p: string, content: string) => A.json('/api/files/content', { as: who, ...jsonBody({ path: p, content, baseSha256: null }, 'PUT') })
const del = async (who: Who, p: string) => { const r = await A.json('/api/files' + q({ path: p }), { as: who, method: 'DELETE' }); expect(r.status).toBe(200); return r.body.trashId as string }
const trashOf = async (who: Who) => (await A.json('/api/files/trash', { as: who })).body.items as { id: string; originalPath: string; type: string }[]
const ids = async (who: Who) => (await trashOf(who)).map((t) => t.id)
const restore = (who: Who, id: string) => A.json(`/api/files/trash/${id}/restore`, { as: who, method: 'POST' })
const read = (who: Who, p: string) => A.json('/api/files/content' + q({ path: p }), { as: who })
// what POST /api/admin/folders does (the fixture's group ids are not UUIDv7, which the route's schema wants)
function ruleFolder(p: string, group: string) {
  fs.mkdirSync(path.join(A.team, ...p.split('/')), { recursive: true, mode: 0o700 })
  const rules = [{ subjectType: 'group', subjectId: group, access: 'write' }, { subjectType: 'everyone', subjectId: null, access: 'none' }] as FolderRuleInput[]
  A.ctx.db.transaction(() => replaceRules(A.ctx.db, ensureFolderRow(A.ctx.db, p).id, rules, 'carol'))()
}

describe('#1 trash items follow the folder they were trashed from', () => {
  test('group folder trashed, a new group gets the old name: it neither sees nor restores the old files', async () => {
    expect((await save('erin', 'groups/marketing/secret-plan.md', 'MARKETING-SECRET-PLAN\n')).status).toBe(200)
    const file = await del('erin', 'groups/marketing/secret-plan.md')
    expect(await ids('alice')).toContain(file)
    const folder = await del('carol', 'groups/marketing')
    // while the folder is in the trash its earlier-trashed files are nobody's to restore (they come back with it)
    for (const who of ['alice', 'erin', 'carol'] as const) expect(await ids(who)).not.toContain(file)
    expect((await restore('carol', file)).status).toBe(404)
    // an admin gives the old name to finance
    ruleFolder('groups/marketing', 'finance')
    expect(await ids('bob')).not.toContain(file)
    expect(await ids('bob')).not.toContain(folder)
    expect((await restore('bob', file)).status).toBe(404)
    expect((await read('bob', 'groups/marketing/secret-plan.md')).status).toBe(404)
    // the owner restores the old folder under " (restored)": the file is back in its members' trash, at the new name
    const rf = await restore('dana', folder)
    expect(rf.status).toBe(200)
    expect(rf.body.entry.path).toBe('groups/marketing (restored)')
    const item = (await trashOf('erin')).find((t) => t.id === file)
    expect(item?.originalPath).toBe('groups/marketing (restored)/secret-plan.md')
    expect(await ids('bob')).not.toContain(file)
    const r = await restore('erin', file)
    expect(r.status).toBe(200)
    expect(r.body.entry.path).toBe('groups/marketing (restored)/secret-plan.md')
    expect((await read('alice', 'groups/marketing (restored)/secret-plan.md')).body.content).toBe('MARKETING-SECRET-PLAN\n')
    expect((await read('bob', 'groups/marketing (restored)/secret-plan.md')).status).toBe(404)
    expect((await A.json('/api/files/tree' + q({ path: 'groups/marketing' }), { as: 'bob' })).body.entries).toEqual([])
  })

  test('project folder trashed, an admin rule folder takes the path for another group; a purge takes the old files too', async () => {
    expect((await save('bob', 'projects/atlas/launch-secret.md', 'LAUNCH-SECRET\n')).status).toBe(200)
    const file = await del('bob', 'projects/atlas/launch-secret.md')
    expect(await ids('bob')).toContain(file)
    const folder = await del('carol', 'projects/atlas')
    ruleFolder('projects/atlas', 'marketing')
    expect(await ids('alice')).not.toContain(file)
    expect((await restore('alice', file)).status).toBe(404)
    expect((await read('alice', 'projects/atlas/launch-secret.md')).status).toBe(404)
    // purging the folder purges what was trashed from inside it: nothing is left for the new folder to pick up
    expect((await A.json(`/api/files/trash/${folder}`, { as: 'carol', method: 'DELETE' })).status).toBe(204)
    expect(A.ctx.db.query('SELECT 1 AS x FROM trash_items WHERE id = ?').get(file)).toBeNull()
    for (const who of ['alice', 'carol', 'dana'] as const) expect(await ids(who)).not.toContain(file)
  })

  test('removing a folder\'s rules (admin) keeps its trashed files restorable by whoever may write there now', async () => {
    ruleFolder('shared/board', 'marketing')
    expect((await save('alice', 'shared/board/agenda.md', 'agenda\n')).status).toBe(200)
    const file = await del('alice', 'shared/board/agenda.md')
    expect(await ids('bob')).not.toContain(file)
    const f = A.ctx.db.query("SELECT id FROM folders WHERE path = 'shared/board'").get() as { id: string }
    expect((await A.json(`/api/admin/folders/${f.id}`, { as: 'carol', method: 'DELETE' })).status).toBe(204)
    // shared/ (everyone write) governs it now
    expect(await ids('bob')).toContain(file)
    const r = await restore('bob', file)
    expect(r.status).toBe(200)
    expect(r.body.entry.path).toBe('shared/board/agenda.md')
  })
})

describe('#5 a trashed group / project / rule folder: listed and restored by admins and the owner only', () => {
  test('team project folder: participants do not see it, the admin restores it, the participants have it back', async () => {
    const p = await A.json('/api/projects', { as: 'carol', ...jsonBody({ name: 'Launch', folderPath: 'projects/launch', participants: [{ subjectType: 'group', subjectId: 'marketing' }] }) })
    expect(p.status).toBe(201)
    expect((await save('alice', 'projects/launch/memo.md', 'memo\n')).status).toBe(200)
    const folder = await del('carol', 'projects/launch')
    for (const who of ['alice', 'erin'] as const) {
      expect(await ids(who)).not.toContain(folder)
      expect((await restore(who, folder)).status).toBe(404)
    }
    expect(await ids('carol')).toContain(folder)
    expect(await ids('dana')).toContain(folder)
    const r = await restore('carol', folder)
    expect(r.status).toBe(200)
    expect((await read('alice', 'projects/launch/memo.md')).status).toBe(200)
    expect((await A.json(`/api/projects/${p.body.id}`, { as: 'alice' })).status).toBe(200)
  })

  test('group folder and shared/ rule folder: same; an ordinary folder a member trashed stays theirs to restore', async () => {
    const g = await del('carol', 'groups/finance')
    ruleFolder('shared/경영', 'marketing')
    const s = await del('carol', 'shared/경영')
    expect((await A.json('/api/files/mkdir', { as: 'alice', ...jsonBody({ path: 'shared/plain' }) })).status).toBe(201)
    expect((await save('alice', 'shared/plain/a.md', 'a\n')).status).toBe(200)
    const plain = await del('alice', 'shared/plain')
    expect(await ids('bob')).not.toContain(g)
    expect((await restore('bob', g)).status).toBe(404)
    expect(await ids('alice')).not.toContain(s)
    expect((await restore('alice', s)).status).toBe(404)
    expect(await ids('alice')).toContain(plain)
    expect((await restore('alice', plain)).status).toBe(200)
    expect((await restore('carol', g)).status).toBe(200)
    expect((await restore('carol', s)).status).toBe(200)
    expect((await read('bob', 'groups/finance/budget.md')).status).toBe(200)
  })
})
