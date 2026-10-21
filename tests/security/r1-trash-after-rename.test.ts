// Security round 1 (sharing-works #3): after an admin renamed a group or project folder, the files trashed from it
// kept the old original_path. The group lost them from its trash (write access is checked on the old path, which no
// longer carries a rule), and a restore recreated the old name with no rule, or landed in another group's folder that
// took the old name. Moving a folder now moves its pending trash items' original_path with it.
// Fixture: alice, erin = members of marketing (groups/marketing write); bob = finance; carol = admin; dana = owner;
// projects/falcon: alice write, finance read.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { jsonBody, makeCApp, type CApp } from '../lib/c-app'

let A: CApp
beforeAll(async () => { A = await makeCApp('sec-r1-trash-rename') })
afterAll(async () => { await A.close() })
const q = (o: Record<string, string>) => '?' + new URLSearchParams(o).toString()

async function saveAndTrash(who: 'alice' | 'erin', p: string): Promise<string> {
  expect((await A.json('/api/files/content', { as: who, ...jsonBody({ path: p, content: `${p} by ${who}\n`, baseSha256: null }, 'PUT') })).status).toBe(200)
  const del = await A.json('/api/files' + q({ path: p }), { as: who, method: 'DELETE' })
  expect(del.status).toBe(200)
  return del.body.trashId
}
const trashOf = async (who: string) => (await A.json('/api/files/trash', { as: who as any })).body.items as { id: string; originalPath: string }[]
const move = (who: string, from: string, to: string) => A.json('/api/files/move', { as: who as any, ...jsonBody({ from, to }) })

describe('trash follows a renamed group / project folder', () => {
  test('group folder rename: members still see and restore their trash, and it lands in the renamed folder', async () => {
    const id = await saveAndTrash('erin', 'groups/marketing/brief.md')
    expect((await trashOf('alice')).map((t) => t.id)).toContain(id)
    expect((await move('carol', 'groups/marketing', 'groups/marketing-team')).status).toBe(200)
    for (const who of ['alice', 'erin']) {
      const item = (await trashOf(who)).find((t) => t.id === id)
      expect(item?.originalPath).toBe('groups/marketing-team/brief.md')
    }
    const r = await A.json(`/api/files/trash/${id}/restore`, { as: 'alice', method: 'POST' })
    expect(r.status).toBe(200)
    expect(r.body.entry.path).toBe('groups/marketing-team/brief.md')
    expect((await A.json('/api/files/content' + q({ path: 'groups/marketing-team/brief.md' }), { as: 'erin' })).status).toBe(200)
    expect(fs.existsSync(path.join(A.team, 'groups/marketing'))).toBe(false) // the old name is not recreated
  })

  test('a new folder that takes the old name (another group) neither sees the old items nor receives an admin restore', async () => {
    const id = await saveAndTrash('alice', 'groups/marketing-team/plan.md')
    expect((await move('carol', 'groups/marketing-team', 'groups/mkt')).status).toBe(200)
    // the old name is taken by a new folder for finance
    fs.mkdirSync(path.join(A.team, 'groups/marketing-team'), { mode: 0o700 })
    A.ctx.db.query("INSERT INTO folders (id, path) VALUES ('f_new_mt', 'groups/marketing-team')").run()
    A.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('r_new_mt', 'f_new_mt', 'group', 'finance', 'write')").run()
    expect((await trashOf('bob')).map((t) => t.id)).not.toContain(id)
    expect((await trashOf('erin')).find((t) => t.id === id)?.originalPath).toBe('groups/mkt/plan.md')
    const r = await A.json(`/api/files/trash/${id}/restore`, { as: 'carol', method: 'POST' })
    expect(r.status).toBe(200)
    expect(r.body.entry.path).toBe('groups/mkt/plan.md')
    expect(fs.readdirSync(path.join(A.team, 'groups/marketing-team'))).toEqual([])
    expect((await A.json('/api/files/content' + q({ path: 'groups/marketing-team/plan.md' }), { as: 'bob' })).status).toBe(404)
  })

  test('project folder rename: the creator still sees the item and the restore lands under the new name', async () => {
    const id = await saveAndTrash('alice', 'projects/falcon/spec.md')
    expect((await move('carol', 'projects/falcon', 'projects/falcon-2')).status).toBe(200)
    expect((await trashOf('alice')).find((t) => t.id === id)?.originalPath).toBe('projects/falcon-2/spec.md')
    const r = await A.json(`/api/files/trash/${id}/restore`, { as: 'alice', method: 'POST' })
    expect(r.status).toBe(200)
    expect(r.body.entry.path).toBe('projects/falcon-2/spec.md')
    expect((await A.json('/api/files/content' + q({ path: 'projects/falcon-2/spec.md' }), { as: 'bob' })).status).toBe(200) // finance reads the project
    expect(fs.existsSync(path.join(A.team, 'projects/falcon'))).toBe(false)
  })
})
