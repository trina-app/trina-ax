// Security round 3 (sharing-works #1, fix incomplete after r2): moving a folder carries the items trashed from inside
// it (their original_path), so a restore lands where the folder is now. Two ways that went wrong:
//  - alice deleted a private file in users/alice/sub/, then shared the folder by moving it to shared/. The trashed
//    file went along: everyone who can write shared/ saw its name in their trash, restored it and read it. Items now
//    follow a moved folder only on the same side of a personal folder's edge, and an item with no folder stamp
//    (a personal one moved by an older build) also needs read where it was deleted.
//  - a file trashed in an ordinary subfolder of a group folder, then the subfolder moved to shared/: the item was
//    nobody's any more (not even the group's) until it was purged. It now shows to whoever could read the folder it
//    was deleted from and can write where it goes back to.
// Fixture: alice, erin = marketing (groups/marketing write); bob = finance; carol = admin; shared/ everyone write.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { jsonBody, makeCApp, type CApp } from '../lib/c-app'

let A: CApp
beforeAll(async () => { A = await makeCApp('sec-r3-trash-edge') })
afterAll(async () => { await A.close() })
type Who = 'alice' | 'bob' | 'carol' | 'dana' | 'erin'
const q = (o: Record<string, string>) => '?' + new URLSearchParams(o).toString()
const save = (who: Who, p: string, content: string) => A.json('/api/files/content', { as: who, ...jsonBody({ path: p, content, baseSha256: null }, 'PUT') })
const mkdir = (who: Who, p: string) => A.json('/api/files/mkdir', { as: who, ...jsonBody({ path: p }) })
const del = async (who: Who, p: string) => { const r = await A.json('/api/files' + q({ path: p }), { as: who, method: 'DELETE' }); expect(r.status).toBe(200); return r.body.trashId as string }
const move = (who: Who, from: string, to: string, confirm = false) => A.json('/api/files/move', { as: who, ...jsonBody({ from, to, ...(confirm ? { confirm: true } : {}) }) })
const trashOf = async (who: Who) => (await A.json('/api/files/trash', { as: who })).body.items as { id: string; originalPath: string }[]
const item = async (who: Who, id: string) => (await trashOf(who)).find((t) => t.id === id)
const restore = (who: Who, id: string) => A.json(`/api/files/trash/${id}/restore`, { as: who, method: 'POST' })
const read = (who: Who, p: string) => A.json('/api/files/content' + q({ path: p }), { as: who })

describe('a personal folder shared by moving it: what its owner deleted stays theirs', () => {
  test('the team neither sees nor restores it; the owner restores it back into their own folder', async () => {
    expect((await mkdir('alice', 'users/alice/sub')).status).toBe(201)
    expect((await save('alice', 'users/alice/sub/keep.md', 'shared on purpose\n')).status).toBe(200)
    expect((await save('alice', 'users/alice/sub/secret.md', 'ALICE-PRIVATE-TRASHED\n')).status).toBe(200)
    const id = await del('alice', 'users/alice/sub/secret.md')
    expect((await move('alice', 'users/alice/sub', 'shared/sub')).status).toBe(200)
    expect((await read('bob', 'shared/sub/keep.md')).status).toBe(200) // the folder itself is shared
    for (const who of ['bob', 'carol', 'dana', 'erin'] as const) {
      expect(await item(who, id)).toBeUndefined()
      expect((await restore(who, id)).status).toBe(404)
    }
    expect((await item('alice', id))?.originalPath).toBe('users/alice/sub/secret.md')
    const r = await restore('alice', id)
    expect(r.status).toBe(200)
    expect(r.body.entry.path).toBe('users/alice/sub/secret.md')
    expect((await read('bob', 'shared/sub/secret.md')).status).toBe(404)
    expect((await read('alice', 'users/alice/sub/secret.md')).body.content).toBe('ALICE-PRIVATE-TRASHED\n')
  })

  test('an item an older build already moved into the team folder: only its owner sees it', async () => {
    expect((await save('alice', 'users/alice/old/diary.md', 'ALICE-DIARY\n')).status).toBe(200)
    const id = await del('alice', 'users/alice/old/diary.md')
    expect((await move('alice', 'users/alice/old', 'shared/old')).status).toBe(200)
    // what move() did before this fix
    A.ctx.db.query("UPDATE trash_items SET original_path = 'shared/old/diary.md' WHERE id = ?").run(id)
    expect(await item('bob', id)).toBeUndefined()
    expect((await restore('bob', id)).status).toBe(404)
    expect((await item('alice', id))?.originalPath).toBe('shared/old/diary.md')
  })

  test('renames inside one\'s own folder still carry the trash along', async () => {
    expect((await save('alice', 'users/alice/r1/a.md', 'a\n')).status).toBe(200)
    const id = await del('alice', 'users/alice/r1/a.md')
    expect((await move('alice', 'users/alice/r1', 'users/alice/r2')).status).toBe(200)
    expect((await item('alice', id))?.originalPath).toBe('users/alice/r2/a.md')
  })

  test('a team folder moved into someone\'s personal folder leaves the team\'s trash with the team', async () => {
    expect((await save('bob', 'shared/notes/team.md', 'TEAM-NOTE\n')).status).toBe(200)
    const id = await del('bob', 'shared/notes/team.md')
    expect((await move('alice', 'shared/notes', 'users/alice/notes', true)).status).toBe(200)
    expect((await item('bob', id))?.originalPath).toBe('shared/notes/team.md')
    const r = await restore('bob', id)
    expect(r.status).toBe(200)
    expect(r.body.entry.path).toBe('shared/notes/team.md')
  })
})

describe('an ordinary subfolder moved out of a group folder: its trash stays the group\'s', () => {
  test('the group still sees and restores it at the new place; nobody outside the group sees it', async () => {
    expect((await save('erin', 'groups/marketing/sub2/plan.md', 'MKT-PLAN\n')).status).toBe(200)
    const id = await del('erin', 'groups/marketing/sub2/plan.md')
    expect((await move('alice', 'groups/marketing/sub2', 'shared/sub2')).status).toBe(200)
    for (const who of ['alice', 'erin'] as const) expect((await item(who, id))?.originalPath).toBe('shared/sub2/plan.md')
    expect(await item('bob', id)).toBeUndefined()
    expect((await restore('bob', id)).status).toBe(404)
    const r = await restore('erin', id)
    expect(r.status).toBe(200)
    expect(r.body.entry.path).toBe('shared/sub2/plan.md')
  })
})
