// Security round 2 (sharing-works #1 and #5): what the trash shows and where a restore lands follow the folder an item
// was trashed from, not only the path it had.
// #1 (fix incomplete after r1): files trashed from a group / project folder that an admin then trashed kept their old
// path. A new group (or an admin rule folder) that took the old name saw those files in its trash and restored them
// into its own folder, contents and all. They are now hidden while their folder is in the trash, come back into the
// trash of the folder wherever it is restored (" (restored)" name included), and go for good when it is purged.
// #5: a trashed group / project / rule folder was listed in its members' trash, but their restore failed with 404
// (they cannot write groups/ or projects/). Trashing those folders is admin-only, and so is seeing and restoring them.
// Inside projects/<name> the owner and admins act only as members (docs/DECISIONS.md "Project contents only for
// members"): a project folder's trash is its members' and the owner's and admins' who are members; the others put it
// back through the project (POST /api/projects/:id/restore).
// Fixture: alice, erin = marketing (groups/marketing write); bob = finance (groups/finance, projects/atlas write);
// carol = admin; dana = owner; shared/ everyone write.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { FolderRuleInput } from '@mycel/shared/api'
import { ensureFolderRow, replaceRules } from '../../server/src/admin/folders'
import { jsonBody, makeCApp, type CApp } from '../lib/c-app'
import { legacyProjectFolder } from '../lib/legacy-project'

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
    // an admin who is not a member of it neither sees nor trashes it (the same 404 as for a missing path)
    for (const who of ['carol', 'dana'] as const) {
      expect(await ids(who)).not.toContain(file)
      expect((await A.json('/api/files' + q({ path: 'projects/atlas' }), { as: who, method: 'DELETE' })).status).toBe(404)
    }
    expect(fs.existsSync(path.join(A.team, 'projects/atlas'))).toBe(true)
    // carol, made a member of it, does
    legacyProjectFolder(A.ctx.db, A.team, 'projects/atlas', [{ subjectType: 'group', subjectId: 'finance', access: 'write' }, { subjectType: 'user', subjectId: 'carol', access: 'write' }])
    const folder = await del('carol', 'projects/atlas')
    // Admin › Folder permissions no longer makes a folder at a projects/<name>: an older build's admin did
    const made = await A.json('/api/admin/folders', { as: 'carol', ...jsonBody({ path: 'projects/atlas', rules: [{ subjectType: 'everyone', subjectId: null, access: 'none' }] }) })
    expect([made.status, made.body.error?.params?.reason]).toEqual([409, 'project_members_only'])
    legacyProjectFolder(A.ctx.db, A.team, 'projects/atlas', [{ subjectType: 'group', subjectId: 'marketing', access: 'write' }, { subjectType: 'everyone', subjectId: null, access: 'none' }], 'carol')
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
    // carol made it: she is a member of it
    const folder = await del('carol', 'projects/launch')
    for (const who of ['alice', 'erin'] as const) {
      expect(await ids(who)).not.toContain(folder)
      expect((await restore(who, folder)).status).toBe(404)
    }
    expect(await ids('carol')).toContain(folder)
    // the owner, no member of it: not in her files trash, no restore from there (she restores the project instead)
    expect(await ids('dana')).not.toContain(folder)
    expect((await restore('dana', folder)).status).toBe(404)
    const r = await restore('carol', folder)
    expect(r.status).toBe(200)
    expect((await read('alice', 'projects/launch/memo.md')).status).toBe(200)
    expect((await A.json(`/api/projects/${p.body.id}`, { as: 'alice' })).status).toBe(200)
    // in the trash again: the owner puts it back through the project, as the system, without reading it
    const again = await del('carol', 'projects/launch')
    expect((await A.json(`/api/projects/${p.body.id}`, { as: 'alice' })).status).toBe(404)
    const back = await A.json(`/api/projects/${p.body.id}/restore`, { as: 'dana', method: 'POST' })
    expect([back.status, back.body.member, back.body.inTrash]).toEqual([200, false, false])
    expect(JSON.stringify(back.body)).not.toContain('memo')
    expect(A.ctx.db.query('SELECT restored_at IS NOT NULL AS r FROM trash_items WHERE id = ?').get(again)).toEqual({ r: 1 })
    expect((await read('alice', 'projects/launch/memo.md')).status).toBe(200)
    expect((await read('dana', 'projects/launch/memo.md')).status).toBe(404)
    // a member may not (the owner and admins only)
    expect((await A.json(`/api/projects/${p.body.id}/restore`, { as: 'alice', method: 'POST' })).status).toBe(403)
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
