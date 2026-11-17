// Second security review of share_folder (P6-1): Undo of a removal is an ADD. The owner may always take people off their
// own file (also without edit access), but bringing a grant back needs what an add needs: edit access. An owner who lost
// edit after removing someone gets 404 on Undo, and the grant is not restored (it would stay dormant and turn live again
// when edit came back). The review's proving test, turned into the guard (files/share-undo.ts stillTheirs).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { uuidv7 } from '@mycel/shared'
import { roomsOf } from '../../server/src/rooms/service'
import { addMember, harness, withOwner, type Client, type Harness } from '../unit/a-lib'

let h: Harness, owner: Client, alice: Client, bob: Client, ids: Record<string, string>
const budget = () => (roomsOf(h.ctx) as unknown as { sendBudget: Map<string, unknown> }).sendBudget.clear()
beforeAll(async () => {
  h = await harness('sr2-undo', { folderShares: true })
  owner = await withOwner(h)
  const a = await addMember(h, owner, { username: 'alice' })
  const b = await addMember(h, owner, { username: 'bob' })
  alice = a.client; bob = b.client; ids = { alice: a.id, bob: b.id }
}, 120_000)
afterAll(() => h.close())

const bobGrants = () => (h.ctx.db.query("SELECT COUNT(*) n FROM file_share_grants g JOIN file_shares s ON s.id = g.share_id WHERE s.path = 'proj/secret.md' AND g.subject_id = ?").get(ids.bob) as { n: number }).n

test('owner removes Bob, loses edit: Undo is refused like a direct add, and nothing comes back when edit returns', async () => {
  const fid = uuidv7()
  h.ctx.db.query("INSERT INTO folders (id, path) VALUES (?, 'proj')").run(fid)
  const rid = uuidv7()
  h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'user', ?, 'write')").run(rid, fid, ids.alice)
  fs.mkdirSync(path.join(h.ctx.files.fx.root, 'proj'), { recursive: true })
  // the file is alice's (she made it through the app)
  budget(); await alice.call('PUT', '/api/files/content', { path: 'proj/secret.md', content: 'secret', baseSha256: null })
  budget()
  const added = await alice.try('PUT', '/api/files/shares', { path: 'proj/secret.md', add: [{ subjectType: 'user', subjectId: ids.bob }], remove: [] })
  expect(added.status).toBe(200)
  budget()
  const removed = await alice.call('PUT', '/api/files/shares', { path: 'proj/secret.md', add: [], remove: [{ subjectType: 'user', subjectId: ids.bob }] })
  const undoId = removed.undo?.id
  expect(undoId).toBeTruthy()
  // the admin narrows alice to view only
  h.ctx.db.query("UPDATE folder_rules SET access = 'read' WHERE id = ?").run(rid)
  budget()
  const direct = await alice.try('PUT', '/api/files/shares', { path: 'proj/secret.md', add: [{ subjectType: 'user', subjectId: ids.bob }], remove: [] })
  expect(direct.status).toBe(403)
  const u = await alice.try('POST', '/api/files/shares/undo', { id: undoId })
  expect(u.status).toBe(404)
  expect(bobGrants()).toBe(0)
  // edit comes back: still nothing for bob (no dormant grant turned live)
  h.ctx.db.query("UPDATE folder_rules SET access = 'write' WHERE id = ?").run(rid)
  const lid = added.body.link.id
  const page = await bob.call('GET', `/api/files/shared/${lid}`)
  expect(page.status).not.toBe('open')
  expect(bobGrants()).toBe(0)
  // with edit back, the (unused) Undo works again for the actor, once
  const again = await alice.try('POST', '/api/files/shares/undo', { id: undoId })
  expect(again.status).toBe(200)
  expect(bobGrants()).toBe(1)
})

test('P6-2: a folder save that removes the links under it closes their open Undo snapshots, also of a share with nobody left on it', async () => {
  const { removeLinksIn } = await import('../../server/src/files/shares')
  // (after the first test bob is on proj/secret.md again)
  budget()
  const removed = await alice.call('PUT', '/api/files/shares', { path: 'proj/secret.md', add: [], remove: [{ subjectType: 'user', subjectId: ids.bob }] })
  expect(removed.undo?.id).toBeTruthy()
  expect(bobGrants()).toBe(0)
  removeLinksIn(h.ctx.db, ids.alice, 'proj')
  const u = await alice.try('POST', '/api/files/shares/undo', { id: removed.undo.id })
  expect(u.status).toBe(404)
  expect(bobGrants()).toBe(0)
})
