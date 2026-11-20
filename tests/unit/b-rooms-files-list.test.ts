// A room's Files list and ⌘K's recent files (rooms/search.ts listRoomFiles, recentRoomFiles;
// docs/decisions/20261120-project-is-room.md D8): GET /api/rooms/:id/files gives the files sent in a channel, a 1:1 or
// a group chat I am in, newest first, in pages, each checked as on read (a member now, a message I see: from where I
// see the room, never someone's private preview, an answer hidden from me or what is in its thread, nothing deleted or
// not sent yet). A project's chat room has no list of its own (404: its files are the project's). GET
// /api/room-files/recent gives the newest five of all my rooms with the same checks, a project room's file only while
// I can open it in the team folder. A guest gets both for their own room only. File names are made up.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { uuidv7, type RoomFile } from '@mycel/shared/api'
import { roomFilesOf } from '../../server/src/rooms/files'
import { roomsOf } from '../../server/src/rooms/service'
import { roomFileListSql, roomFilesSql } from '../../server/src/rooms/search'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { addGuest } from './guest-lib'

setDefaultTimeout(120_000)
const cm = () => 'cm-' + crypto.randomUUID()
const user = (id: string) => ({ subjectType: 'user', subjectId: id })

let h: Harness
let owner: Client
let mia: { client: Client; id: string }
let nora: { client: Client; id: string }
let otto: { client: Client; id: string }
let clock = Date.now()
beforeAll(async () => {
  h = await harness('b-rooms-files-list')
  owner = await withOwner(h)
  mia = await addMember(h, owner, { username: 'mia' })
  nora = await addMember(h, owner, { username: 'nora' })
  otto = await addMember(h, owner, { username: 'otto' })
  // ten seconds a call: the sending budget never runs out here
  roomsOf(h.ctx).clock = () => (clock += 10_000)
})
afterAll(async () => { await h?.close() })

async function up(userId: string, roomId: string, name: string): Promise<RoomFile> {
  const bytes = new TextEncoder().encode(`content of ${name} ${crypto.randomUUID()}`)
  const src = path.join(h.ctx.config.dataDir, `upload-${crypto.randomUUID()}`)
  fs.writeFileSync(src, bytes)
  return roomFilesOf(h.ctx).create(userId, roomId, name, src, createHash('sha256').update(bytes).digest('hex'))
}
const send = (c: Client, roomId: string, fileIds: string[], extra: Record<string, unknown> = {}) => c.call('POST', `/api/rooms/${roomId}/messages`, { body: '', clientMessageId: cm(), mentions: [], fileIds, ...extra })
async function sendFile(by: { client: Client; id: string }, roomId: string, name: string, extra: Record<string, unknown> = {}) {
  const f = await up(by.id, roomId, name)
  const m = await send(by.client, roomId, [f.id], extra)
  return { file: f, message: m }
}
const list = (c: Client, roomId: string, q = '') => c.call('GET', `/api/rooms/${roomId}/files${q}`)
const names = (p: { items: { file: { name: string } }[] }) => p.items.map((i) => i.file.name)
const recent = (c: Client) => c.call('GET', '/api/room-files/recent')
const groupChat = async (by: Client, others: string[], name?: string) => (await by.call('POST', '/api/rooms', { kind: 'group', userIds: others, ...(name ? { name } : {}) })).id as string
const dm = async (by: Client, other: string) => (await by.call('POST', '/api/rooms', { kind: 'dm', userId: other })).id as string
const next = (roomId: string) => (h.ctx.db.query('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq').get(roomId) as { last_seq: number }).last_seq
/** a message straight into the database: someone's private preview from the AI (visible to `privateTo` only) */
async function privatePreview(roomId: string, to: { id: string }, name: string) {
  const mid = uuidv7()
  h.ctx.db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, visibility, visible_to, body, mentions, created_at) VALUES (?, ?, ?, 'ai', NULL, 'private', ?, 'preview', '[]', ?)`)
    .run(mid, roomId, next(roomId), to.id, new Date().toISOString())
  const f = await up(to.id, roomId, name)
  h.ctx.db.query('UPDATE room_files SET message_id = ? WHERE id = ?').run(mid, f.id)
}

describe('a room\'s Files list', () => {
  test('newest first, in pages, with who sent each, when and the size', async () => {
    const chat = await groupChat(mia.client, [nora.id], 'Paging')
    const sent: string[] = []
    for (let i = 1; i <= 5; i++) { sent.push(`page-${i}.pdf`); await sendFile(i % 2 ? mia : nora, chat, `page-${i}.pdf`) }
    const first = await list(nora.client, chat, '?limit=2')
    expect(names(first)).toEqual(['page-5.pdf', 'page-4.pdf'])
    expect(first.items[0]).toMatchObject({ roomId: chat, threadRootId: null, author: { id: mia.id }, file: { kind: 'pdf' } })
    expect(first.items[0].file.size).toBeGreaterThan(0)
    expect(first.items[1].author.id).toBe(nora.id)
    expect(typeof first.items[0].createdAt).toBe('string')
    const second = await list(nora.client, chat, `?limit=2&cursor=${first.nextCursor}`)
    expect(names(second)).toEqual(['page-3.pdf', 'page-2.pdf'])
    const third = await list(nora.client, chat, `?limit=2&cursor=${second.nextCursor}`)
    expect(names(third)).toEqual(['page-1.pdf'])
    expect(third.nextCursor).toBeNull()
    // a cursor that is not one: 400
    expect((await nora.client.try('GET', `/api/rooms/${chat}/files?cursor=nope`)).status).toBe(400)
    // an unsent upload, a deleted message's file: never in it
    await up(mia.id, chat, 'unsent.pdf')
    const gone = await sendFile(mia, chat, 'deleted.pdf')
    await mia.client.call('DELETE', `/api/rooms/${chat}/messages/${gone.message.id}`)
    expect(names(await list(mia.client, chat))).toEqual([...sent].reverse())
  })

  test('a 1:1 chat: both see its files, nobody else (an owner included); a former member of a group chat gets 404', async () => {
    const room = await dm(mia.client, nora.id)
    await sendFile(nora, room, 'dm-quote.xlsx')
    for (const c of [mia.client, nora.client]) expect(names(await list(c, room))).toEqual(['dm-quote.xlsx'])
    for (const c of [otto.client, owner]) expect((await c.try('GET', `/api/rooms/${room}/files`)).status).toBe(404)
    const chat = await groupChat(mia.client, [nora.id, otto.id], 'Leavers')
    await sendFile(mia, chat, 'leavers.pdf')
    expect(names(await list(otto.client, chat))).toEqual(['leavers.pdf'])
    await otto.client.call('POST', `/api/rooms/${chat}/leave`)
    const r = await otto.client.try('GET', `/api/rooms/${chat}/files`)
    expect(r.status).toBe(404)
    expect(JSON.stringify(r.body)).not.toContain('leavers')
  })

  test('a member who joined later sees no file from before; a private preview and an answer hidden from me are left out', async () => {
    const chat = await groupChat(mia.client, [nora.id], 'Later')
    const before = await sendFile(mia, chat, 'before-otto.pdf')
    await mia.client.call('POST', `/api/rooms/${chat}/members`, { userIds: [otto.id] })
    await sendFile(mia, chat, 'after-otto.pdf')
    // a reply in a thread from before otto joined: not his either
    await sendFile(nora, chat, 'old-thread.pdf', { threadRootId: before.message.id })
    expect(names(await list(otto.client, chat))).toEqual(['after-otto.pdf'])
    expect(names(await list(nora.client, chat))).toEqual(['old-thread.pdf', 'after-otto.pdf', 'before-otto.pdf'])
    // nora's own private preview: hers alone
    await privatePreview(chat, nora, 'private-preview.pdf')
    expect(names(await list(mia.client, chat))).not.toContain('private-preview.pdf')
    expect(names(await list(nora.client, chat))).not.toContain('private-preview.pdf')
    // an old answer hidden from mia (rooms/history.ts room_hidden_answers): its file is not hers
    const hidden = await sendFile(nora, chat, 'hidden-answer.pdf')
    h.ctx.db.query('INSERT INTO room_hidden_answers (room_id, user_id, message_id, see_seq) SELECT ?1, ?2, ?3, seq FROM room_messages WHERE id = ?3').run(chat, mia.id, hidden.message.id)
    expect(names(await list(mia.client, chat))).not.toContain('hidden-answer.pdf')
    expect(names(await list(nora.client, chat))).toContain('hidden-answer.pdf')
  })

  test('a project\'s chat room has no list of its own (404 for its members too), and a team room has one', async () => {
    const p = await mia.client.call('POST', '/api/projects', { name: 'Files list project', participants: [user(nora.id)] })
    const room = await mia.client.call('POST', `/api/projects/${p.id}/room`)
    await sendFile(mia, room.id, 'in-project.pdf')
    for (const c of [mia.client, nora.client]) {
      const r = await c.try('GET', `/api/rooms/${room.id}/files`)
      expect(r.status).toBe(404)
      expect(JSON.stringify(r.body)).not.toContain('in-project')
    }
    // the everyone room is a channel like any other
    const everyone = ((await mia.client.call('GET', '/api/rooms')).items as any[]).find((r) => r.kind === 'all')
    await sendFile(mia, everyone.id, 'for-everyone.pdf')
    expect(names(await list(otto.client, everyone.id))).toEqual(['for-everyone.pdf'])
  })

  test('a guest: their own room only', async () => {
    const chat = await groupChat(mia.client, [nora.id], 'With a client')
    const other = await groupChat(mia.client, [nora.id], 'Internal')
    await sendFile(mia, other, 'internal.pdf')
    const g = await addGuest(h, mia.client, { username: 'gail', place: { kind: 'room', id: chat } })
    // (a guest sees a group chat from their join, as any later member)
    await sendFile(mia, chat, 'client-brief.pdf')
    expect(names(await list(g.client, chat))).toEqual(['client-brief.pdf'])
    expect((await g.client.try('GET', `/api/rooms/${other}/files`)).status).toBe(404)
    const r = await recent(g.client)
    expect(names(r)).toEqual(['client-brief.pdf'])
    expect(r.rooms.map((x: { id: string }) => x.id)).toEqual([chat])
  })
})

describe('review probes', () => {
  test('a reply in the thread of an answer hidden from me is left out, with the answer itself', async () => {
    const chat = await groupChat(mia.client, [nora.id, otto.id], 'Hidden thread')
    const root = await sendFile(nora, chat, 'hidden-root.pdf')
    await sendFile(otto, chat, 'reply-under-hidden.pdf', { threadRootId: root.message.id })
    h.ctx.db.query('INSERT INTO room_hidden_answers (room_id, user_id, message_id, see_seq) SELECT ?1, ?2, ?3, seq FROM room_messages WHERE id = ?3').run(chat, mia.id, root.message.id)
    for (const n of ['hidden-root.pdf', 'reply-under-hidden.pdf']) {
      expect(names(await list(mia.client, chat))).not.toContain(n)
      expect(names(await recent(mia.client))).not.toContain(n)
    }
    expect(names(await list(nora.client, chat))).toEqual(['reply-under-hidden.pdf', 'hidden-root.pdf'])
  })

  test('an archived room: its list answers 404 and its files leave recent', async () => {
    const chat = await groupChat(mia.client, [nora.id], 'Archived')
    await sendFile(mia, chat, 'archived-room.pdf')
    expect(names(await recent(nora.client))).toContain('archived-room.pdf')
    h.ctx.db.query('UPDATE rooms SET archived_at = ? WHERE id = ?').run(new Date().toISOString(), chat)
    expect((await nora.client.try('GET', `/api/rooms/${chat}/files`)).status).toBe(404)
    expect(names(await recent(nora.client))).not.toContain('archived-room.pdf')
  })

  test('a project in the trash: its room\'s files leave recent', async () => {
    const p = await mia.client.call('POST', '/api/projects', { name: 'Trashed for recent', participants: [user(nora.id)] })
    const room = await mia.client.call('POST', `/api/projects/${p.id}/room`)
    await sendFile(mia, room.id, 'trashed-project.pdf')
    expect(names(await recent(nora.client))).toContain('trashed-project.pdf')
    await mia.client.call('DELETE', `/api/projects/${p.id}`)
    expect(names(await recent(nora.client))).not.toContain('trashed-project.pdf')
    expect(names(await recent(mia.client))).not.toContain('trashed-project.pdf')
  })

  test('a forged but well-formed cursor: a member gets only what they see below it, a non-member the room\'s 404', async () => {
    const chat = await groupChat(mia.client, [nora.id], 'Cursors')
    await sendFile(mia, chat, 'cursor.pdf')
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
    // a huge rowid: everything is below it, still only the room's own files
    const big = await nora.client.call('GET', `/api/rooms/${chat}/files?cursor=${enc({ f: '999999999999999999' })}`)
    expect(names(big)).toEqual(['cursor.pdf'])
    // a rowid below every file: nothing
    expect(names(await nora.client.call('GET', `/api/rooms/${chat}/files?cursor=${enc({ f: '1' })}`))).toEqual([])
    // not a rowid: refused
    for (const bad of [enc({ f: '-1' }), enc({ f: '1e5' }), enc({ f: 1 }), 'x'.repeat(600)]) expect((await nora.client.try('GET', `/api/rooms/${chat}/files?cursor=${bad}`)).status).toBe(400)
    // a non-member: the room's 404 whatever the cursor (the room is checked first), the same as a room that is not there
    const forged = await otto.client.try('GET', `/api/rooms/${chat}/files?cursor=${enc({ f: '999999999999999999' })}`)
    const missing = await otto.client.try('GET', `/api/rooms/${uuidv7()}/files`)
    expect(forged.status).toBe(404)
    const bare = (b: { error: Record<string, unknown> }) => ({ ...b.error, requestId: undefined })
    expect(bare(forged.body)).toEqual(bare(missing.body))
  })
})

describe('⌘K recent files', () => {
  test('the newest five across my rooms, readable rows only, with their rooms; nothing after leaving', async () => {
    // two people of their own, so other tests' rooms are not theirs (only the everyone room, older)
    const ray = await addMember(h, owner, { username: 'ray' })
    const sky = await addMember(h, owner, { username: 'sky' })
    const a = await groupChat(ray.client, [sky.id], 'Recent A')
    const b = await dm(ray.client, sky.id)
    await sendFile(ray, a, 'recent-1.pdf')
    await sendFile(sky, b, 'recent-2.pdf')
    await sendFile(ray, a, 'recent-3.pdf')
    // a project room's file: in it while sky can open it, left out once its folder is narrowed away from sky
    const proj = await ray.client.call('POST', '/api/projects', { name: 'Recent project', participants: [user(sky.id)] })
    const pr = await ray.client.call('POST', `/api/projects/${proj.id}/room`)
    const pf = await sendFile(ray, pr.id, 'recent-project.pdf')
    await sendFile(sky, b, 'recent-5.pdf')
    await sendFile(ray, a, 'recent-6.pdf')
    // hidden from sky: left out, and the walk goes past it to fill five
    const hidden = await sendFile(ray, a, 'recent-hidden.pdf')
    h.ctx.db.query('INSERT INTO room_hidden_answers (room_id, user_id, message_id, see_seq) SELECT ?1, ?2, ?3, seq FROM room_messages WHERE id = ?3').run(a, sky.id, hidden.message.id)
    const r = await recent(sky.client)
    expect(names(r)).toEqual(['recent-6.pdf', 'recent-5.pdf', 'recent-project.pdf', 'recent-3.pdf', 'recent-2.pdf'])
    expect(r.rooms.map((x: { id: string }) => x.id).sort()).toEqual([a, b, pr.id].sort())
    expect(names(await recent(ray.client))[0]).toBe('recent-hidden.pdf')
    // the project room's Chat attachments narrowed to ray: sky no longer gets it (never as "unavailable")
    const ref = h.ctx.db.query('SELECT path FROM room_file_refs WHERE room_file_id = ?').get(pf.file.id) as { path: string }
    const folder = ref.path.split('/').slice(0, -1).join('/')
    const fid = 'f_' + crypto.randomUUID()
    h.ctx.db.query('INSERT INTO folders (id, path, limited) VALUES (?, ?, 1)').run(fid, folder)
    h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'user', ?, 'write')").run(crypto.randomUUID(), fid, ray.id)
    const narrowed = await recent(sky.client)
    expect(names(narrowed)).toEqual(['recent-6.pdf', 'recent-5.pdf', 'recent-3.pdf', 'recent-2.pdf', 'recent-1.pdf'])
    expect(narrowed.items.every((i: { file: { state?: string } }) => !i.file.state)).toBe(true)
    expect(names(await recent(ray.client))).toContain('recent-project.pdf')
    // leaving the group chat: its files go from sky's recent at once
    await sky.client.call('POST', `/api/rooms/${a}/leave`)
    const left = names(await recent(sky.client))
    expect(left.slice(0, 2)).toEqual(['recent-5.pdf', 'recent-2.pdf'])
    for (const n of ['recent-1.pdf', 'recent-3.pdf', 'recent-6.pdf']) expect(left).not.toContain(n)
  })

  test('someone in no room with files gets an empty answer', async () => {
    const zed = await addMember(h, owner, { username: 'zed' })
    const r = await recent(zed.client)
    // the everyone room's files are zed's too (a channel of the whole team): only those
    for (const i of r.items) expect(r.rooms.find((x: { id: string }) => x.id === i.roomId)?.kind).toBe('all')
  })
})

test('one room\'s list reads its own index, newest first with no sort; the search across rooms keeps its walk', () => {
  const plan = (sql: string, args: unknown[]) => (h.ctx.db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as never[])) as { detail: string }[]).map((r) => r.detail)
  for (const after of [false, true]) {
    const p = plan(roomFileListSql(after), ['u', 'r', ...(after ? [1] : []), 21])
    expect(p[0]).toMatch(/^SEARCH f USING INDEX room_files_by_room \(room_id=\?/)
    expect(p.join('\n')).not.toMatch(/TEMP B-TREE/)
  }
  expect(plan(roomFilesSql(0, false), ['u', '[]', 21])[0]).toMatch(/^SCAN f\b/)
})
