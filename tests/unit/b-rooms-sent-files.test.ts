// "Files you sent" and "Ask people to clean up" (docs/decisions/20261116-room-files-cleanup.md): my own files in the
// conversations I am in now, largest first, with their total; and an owner's or admin's ask, which reaches the people
// whose files take the most space and never says who or how many.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { API, uuidv7, type MyRoomFilesPage, type RoomFile, type RoomMessage } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { roomFilesOf } from '../../server/src/rooms/files'
import { CLEANUP_KEY, peopleOver } from '../../server/src/system/storage-cleanup'

setDefaultTimeout(60_000)
const MB = 1024 * 1024, GB = 1024 * MB
let h: Harness
beforeAll(async () => { h = await startHarness({ name: 'b-rooms-sent-files' }) })
afterAll(async () => { await h.close() })

async function upload(user: string, roomId: string, name: string): Promise<RoomFile> {
  const bytes = new TextEncoder().encode(`fake ${name} ${uuidv7()}`)
  const src = path.join(h.dataDir, `upload-${uuidv7()}`)
  fs.writeFileSync(src, bytes)
  return roomFilesOf(h.ctx).create(user, roomId, name, src, createHash('sha256').update(bytes).digest('hex'))
}
/** files sent by `user` in one message; their recorded sizes set to `sizes` (bytes on disk stay small) */
async function sendFiles(user: string, roomId: string, files: [string, number][]) {
  const up: RoomFile[] = []
  for (const [n] of files) up.push(await upload(user, roomId, n))
  const m = await h.api(user).call(API.sendRoomMessage, { params: { id: roomId }, body: { body: '', clientMessageId: 'cm-' + uuidv7(), mentions: [], fileIds: up.map((f) => f.id) } }).catch((e) => { throw new Error(JSON.stringify(e.body)) }) as RoomMessage
  files.forEach(([, size], i) => h.ctx.db.query('UPDATE room_files SET size = ? WHERE id = ?').run(size, up[i]!.id))
  return { message: m, files: up }
}
const groupChat = async (by: string, others: string[]) => (await h.api(by).call(API.createRoom, { body: { kind: 'group', userIds: others } })).id
const mine = (user: string, cursor?: string) => h.api(user).call(API.listMyRoomFiles, { query: cursor ? { cursor, limit: 2 } : { limit: 2 } }) as Promise<MyRoomFilesPage>
const names = (p: MyRoomFilesPage) => p.items.map((i) => i.file.name)

test('Files you sent: only mine, in the conversations I am in now, of messages not deleted; largest first, page by page; the total of all', async () => {
  const a = await groupChat('alice', ['erin', 'bob'])
  const b = await groupChat('alice', ['erin', 'carol'])
  await sendFiles('alice', a, [['big.mp4', 300 * MB], ['small.pdf', 1 * MB]])
  await sendFiles('alice', b, [['mid.zip', 50 * MB]])
  const gone = await sendFiles('alice', a, [['deleted.pdf', 900 * MB]])
  await h.api('alice').call(API.deleteRoomMessage, { params: { id: a, messageId: gone.message.id } })
  await sendFiles('erin', a, [['erins.mov', 800 * MB]])
  const left = await groupChat('alice', ['bob', 'erin'])
  await sendFiles('alice', left, [['left.pdf', 700 * MB]])
  await h.api('alice').call(API.leaveRoom, { params: { id: left } })

  const p1 = await mine('alice')
  expect(names(p1)).toEqual(['big.mp4', 'mid.zip'])
  expect(p1.totalBytes).toBe(351 * MB)
  expect(p1.nextCursor).toBeTruthy()
  const p2 = await mine('alice', p1.nextCursor!)
  expect(names(p2)).toEqual(['small.pdf'])
  expect(p2.nextCursor).toBeNull()
  // the conversation named as the search names it, the sender is me
  expect(p1.rooms.map((r) => r.id).sort()).toEqual([a, b].sort())
  expect(p1.items[0]!.author?.id).toBe('alice')
  // erin sees only hers; bob has none
  expect(names(await mine('erin'))).toEqual(['erins.mov'])
  expect(await mine('bob')).toMatchObject({ items: [], totalBytes: 0, nextCursor: null })
  // a bad cursor
  expect((await h.req('alice', '/api/room-files/mine?cursor=x')).status).toBe(400)
})

test('Ask people to clean up: over 1 GB (else over 100 MB), only where they can still delete; once a day; the answer, audit and card say nobody', async () => {
  const db = h.ctx.db
  db.query('DELETE FROM settings WHERE key = ?').run(CLEANUP_KEY)
  // erin: 800 MB + 300 MB = over 1 GB; alice: 351 MB in conversations she is in (her 700 MB in the one she left does not count)
  const r = await groupChat('erin', ['alice', 'bob'])
  await sendFiles('erin', r, [['erin2.mov', 300 * MB]])
  expect(peopleOver(db, GB).sort()).toEqual(['erin'])
  expect(peopleOver(db, 100 * MB).sort()).toEqual(['alice', 'erin'])

  const res = await h.req('carol', '/api/admin/storage/ask-cleanup', { method: 'POST', headers: { 'x-mycel-csrf': '1' } })
  expect(res.status).toBe(200)
  const body = await res.json() as Record<string, unknown>
  expect(Object.keys(body)).toEqual(['askedAt'])
  await new Promise((r) => setTimeout(r, 50))
  const got = (db.query("SELECT user_id FROM storage_notices WHERE event_type = 'storage.cleanup'").all() as { user_id: string }[]).map((x) => x.user_id)
  expect(got).toEqual(['erin'])
  const audit = db.query("SELECT actor_id, target, detail FROM audit_log WHERE action = 'storage.ask_cleanup'").all() as { actor_id: string; target: string | null; detail: string }[]
  expect(audit).toEqual([{ actor_id: 'carol', target: null, detail: '{}' }])
  // the notice: who asked, Files you sent
  const n = (await h.api('erin').call(API.listNotifications, { query: {} })).items.find((i) => i.code === 'storage.cleanup')
  expect(n).toMatchObject({ link: 'sent_files', cleanup: { by: 'Carol Park' } })
  // the card: "Asked today" for every admin; a second press the same day sends nothing and answers the same time
  expect((await h.api('dana').call(API.storage)).cleanupAskedAt).toBe(body.askedAt as string)
  const again = await h.api('dana').call(API.askStorageCleanup)
  expect(again.askedAt).toBe(body.askedAt as string)
  await new Promise((r) => setTimeout(r, 50))
  expect(db.query("SELECT COUNT(*) AS n FROM storage_notices WHERE event_type = 'storage.cleanup'").get()).toEqual({ n: 1 })
  expect(db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'storage.ask_cleanup'").get()).toEqual({ n: 1 })
  // a member may not ask
  expect((await h.req('bob', '/api/admin/storage/ask-cleanup', { method: 'POST', headers: { 'x-mycel-csrf': '1' } })).status).toBe(403)

  // nobody over 1 GB: those over 100 MB are asked (the next day)
  db.query("UPDATE room_files SET size = 10 WHERE user_id = 'erin'").run()
  db.query('DELETE FROM settings WHERE key = ?').run(CLEANUP_KEY)
  await h.api('carol').call(API.askStorageCleanup)
  await new Promise((r) => setTimeout(r, 50))
  const second = (db.query("SELECT user_id FROM storage_notices WHERE event_type = 'storage.cleanup' ORDER BY created_at").all() as { user_id: string }[]).map((x) => x.user_id)
  expect(second).toContain('alice')
  // the asker's account gone: "An admin"
  db.query("UPDATE users SET status = 'disabled' WHERE id = 'carol'").run()
  const plain = (await h.api('alice').call(API.listNotifications, { query: {} })).items.find((i) => i.code === 'storage.cleanup')
  expect(plain).toMatchObject({ cleanup: { by: null } })
  db.query("UPDATE users SET status = 'active' WHERE id = 'carol'").run()
})

test('Files you sent: equal sizes split across pages without a gap or a repeat; an archived conversation is out; a message with several files', async () => {
  const r = await groupChat('bob', ['erin', 'carol'])
  await sendFiles('bob', r, [['same-1.bin', 5 * MB]])
  await sendFiles('bob', r, [['same-2.bin', 5 * MB]])
  await sendFiles('bob', r, [['same-3.bin', 5 * MB]])
  const two = await sendFiles('bob', r, [['pair-a.pdf', 2 * MB], ['pair-b.pdf', 2 * MB]])
  const seen: string[] = []
  let cursor: string | undefined
  for (let i = 0; i < 5; i++) {
    const p = await mine('bob', cursor)
    seen.push(...names(p))
    if (!p.nextCursor) break
    cursor = p.nextCursor
  }
  expect(seen).toEqual(['same-1.bin', 'same-2.bin', 'same-3.bin', 'pair-a.pdf', 'pair-b.pdf'])
  // both files of one message point at it (the page deletes it once, and both leave)
  const first = await mine('bob')
  expect(first.totalBytes).toBe(19 * MB)
  await h.api('bob').call(API.deleteRoomMessage, { params: { id: r, messageId: two.message.id } })
  expect((await mine('bob')).totalBytes).toBe(15 * MB)
  // the conversation archived (nobody in it any more): none of it is listed or counted
  h.ctx.db.query('UPDATE rooms SET archived_at = ? WHERE id = ?').run(new Date().toISOString(), r)
  expect(await mine('bob')).toMatchObject({ items: [], totalBytes: 0 })
  expect(peopleOver(h.ctx.db, 1)).not.toContain('bob')
})
