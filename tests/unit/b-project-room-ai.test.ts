// A project's shared AI chat reads the project's own chat room (chat/room-tools.ts projectRoomTools;
// docs/decisions/20261120-project-is-room.md D4), with the fake engine through the real launcher and gate: room_read and
// room_file for that one room id with no card; another room of the asker's goes through the shared chat's read card when
// someone there is not in it (docs/decisions/20261126-shared-chat-everything.md); only what
// every one of the chat's audience sees (a member with a later start, an answer hidden from one of them, a project file
// one of them cannot open), said when cut; reading marks nothing and asks nothing; post_to_room still asks; a chat of
// another project reads it as any room of the asker's (no card when everyone there is in it); the instructions name
// "this project's chat room".
//
// The fixture team: alice and erin in marketing, bob in finance, carol admin, dana owner.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { API, uuidv7, type Room, type RoomMessage } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { roomFilesOf } from '../../server/src/rooms/files'
import { sharedSection } from '../../server/src/chat/prompt'
import { AUDIENCE_CUT_EARLIER, AUDIENCE_CUT_SOME } from '../../server/src/rooms/reader'

setDefaultTimeout(180_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
const ws: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'b-project-room-ai', askUserTimeoutMs: 3000, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'erin', 'bob']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

let n = 0
/** a project of alice with these people, its chat room and its shared AI chat */
async function project(people: string[] = ['erin', 'bob']) {
  const p = await h.api('alice').call(API.createProject, { body: { name: `Harbor ${++n}`, participants: people.map((u) => ({ subjectType: 'user' as const, subjectId: u })), instructions: '' } })
  const room = await h.api('alice').call(API.openProjectRoom, { params: { id: p.id } }) as Room
  const chat = await h.api('alice').call(API.createChat, { body: { projectId: p.id } })
  expect(chat.shared).toBeTruthy()
  return { projectId: p.id, roomId: room.id, root: room.project!.folderPath, chatId: chat.id as string }
}
const send = (user: string, roomId: string, body: string, fileIds: string[] = []): Promise<RoomMessage> =>
  h.api(user).call(API.sendRoomMessage, { params: { id: roomId }, body: { body, clientMessageId: cm(), mentions: [], fileIds } })
/** one answer of `user` in `chatId`: its text, steps and whether any card was raised */
async function run(user: string, chatId: string, content: string) {
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const sock = ws[user]!
  const done = await sock.next('message.done', (f) => f.data.message.turnId === r.turnId, 60_000)
  const cards = sock.frames.filter((x) => x.type === 'turn.request' && x.data.turnId === r.turnId)
  return { text: done.data.message.content as string, steps: done.data.message.steps ?? [], cards }
}
const read = (room: string, extra: Record<string, unknown> = {}) => fake({ tool: 'room_read', args: { room, ...extra }, sayResult: true })
const roomsSeen = (chatId: string) => (h.ctx.db.query('SELECT rooms_seen FROM chats WHERE id = ?').get(chatId) as { rooms_seen: number }).rooms_seen

test('the shared chat reads its own room (no card, nothing marked); another room some people here are not in asks on the read card', async () => {
  const { roomId, chatId } = await project()
  await send('erin', roomId, 'Booth confirmed for Friday')
  const r = await run('alice', chatId, `what did we decide in the chat room?\n${read(roomId)}`)
  expect(r.text).toContain('Booth confirmed for Friday')
  expect(r.text).not.toContain(AUDIENCE_CUT_EARLIER)
  expect(r.cards).toHaveLength(0)
  expect(roomsSeen(chatId)).toBe(0)
  // a room alice is in that bob is not: the read card first, only alice sees it (no answer here: nothing read)
  const dm = (await h.api('alice').call(API.createRoom, { body: { kind: 'dm', userId: 'erin' } })).id
  await send('erin', dm, 'private between us')
  const other = await run('alice', chatId, `read it\n${read(dm)}`)
  expect(other.cards).toHaveLength(1)
  const turnOf = (x: unknown) => (x as { data: { turnId?: string } }).data.turnId
  expect(ws.bob!.frames.filter((x) => x.type === 'turn.request' && turnOf(x) === turnOf(other.cards[0]))).toHaveLength(0)
  expect(other.text).not.toContain('private between us')
})

test('only what every one of the audience sees: a later start and an answer hidden from one of them are cut, and said', async () => {
  const { roomId, chatId } = await project()
  const early = await send('erin', roomId, 'early words before bob could see')
  const later = await send('erin', roomId, 'later words everyone sees')
  await h.api('erin').call(API.sendRoomMessage, { params: { id: roomId }, body: { body: 'a reply', clientMessageId: cm(), mentions: [], fileIds: [], threadRootId: later.id } })
  // bob sees the room from after the first message (a converted channel's member keeps their start)
  h.ctx.db.query('UPDATE room_members SET history_from_seq = ? WHERE room_id = ? AND user_id = ?').run(early.seq, roomId, 'bob')
  const r = await run('alice', chatId, `summarise the room\n${read(roomId)}`)
  expect(r.text).toContain('later words everyone sees')
  expect(r.text).not.toContain('early words before bob')
  expect(r.text).toContain(AUDIENCE_CUT_EARLIER)
  // a thread's counts are one person's view: only that there is one
  expect(r.text).toContain(`[thread: read it with room_read thread="${later.id}"]`)
  expect(r.text).not.toContain('1 reply')
  // an old answer hidden from bob: left out for everyone here
  const hidden = await send('erin', roomId, 'an answer bob may not see')
  h.ctx.db.query('INSERT INTO room_hidden_answers (room_id, user_id, message_id, see_seq) VALUES (?, ?, ?, ?)').run(roomId, 'bob', hidden.id, hidden.seq)
  const r2 = await run('alice', chatId, `summarise again\n${read(roomId)}`)
  expect(r2.text).not.toContain('an answer bob may not see')
  expect(r2.text).toContain(AUDIENCE_CUT_SOME)
  // its thread is not readable here either
  const t = await run('alice', chatId, `that thread\n${read(roomId, { thread: hidden.id })}`)
  expect(t.text).toContain('No thread')
})

test('room_file: a project file everyone here may open is read; one someone of them cannot open is not', async () => {
  const { roomId, chatId, root } = await project()
  const bytes = new TextEncoder().encode('Agenda: booth, banner, flyers')
  const src = path.join(h.dataDir, `upload-${uuidv7()}`)
  fs.writeFileSync(src, bytes)
  const f = await roomFilesOf(h.ctx).create('erin', roomId, 'agenda.txt', src, createHash('sha256').update(bytes).digest('hex'))
  expect(f.teamFile).toBe(true)
  await send('erin', roomId, 'agenda attached', [f.id])
  const r = await run('alice', chatId, `read the agenda\n${fake({ tool: 'room_file', args: { room: roomId, file: f.id }, sayResult: true })}`)
  expect(r.text).toContain('Agenda: booth, banner, flyers')
  expect(r.cards).toHaveLength(0)
  // the folder narrowed so that bob no longer opens it: not for this chat (alice and erin still read it themselves)
  const folder = path.posix.dirname(f.teamPath!)
  expect(folder.startsWith(root)).toBe(true)
  const fid = 'f_' + crypto.randomUUID()
  h.ctx.db.query('INSERT INTO folders (id, path, limited) VALUES (?, ?, 1)').run(fid, folder)
  for (const u of ['alice', 'erin']) h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'user', ?, 'write')").run(crypto.randomUUID(), fid, u)
  const r2 = await run('alice', chatId, `read it again\n${fake({ tool: 'room_file', args: { room: roomId, file: f.id }, sayResult: true })}`)
  expect(r2.text).not.toContain('Agenda: booth')
  expect(r2.text).toContain('that everyone here can open')
  // and room_read names it as not available here
  const r3 = await run('alice', chatId, `the room\n${read(roomId)}`)
  expect(r3.text).toContain(`(a file that is not available here, file_id=${f.id})`)
  expect(r3.text).not.toContain('agenda.txt')
})

test('post_to_room still asks on its card; a chat of another project reads this room as a room of the asker', async () => {
  const { roomId, chatId } = await project()
  await send('erin', roomId, 'Harbor secret plan')
  const p = await run('alice', chatId, `post it\n${fake({ tool: 'post_to_room', args: { room: roomId, text: 'Summary for the room' }, sayResult: true })}`)
  expect(p.cards.length).toBeGreaterThanOrEqual(1)
  // another project of alice and erin: Harbor's room is a room alice is in, read as hers; everyone there (alice, erin)
  // is in it, so no card
  const other = await h.api('alice').call(API.createProject, { body: { name: `Other ${++n}`, participants: [{ subjectType: 'user' as const, subjectId: 'erin' }], instructions: '' } })
  const otherChat = await h.api('alice').call(API.createChat, { body: { projectId: other.id } })
  const r = await run('alice', otherChat.id, `read Harbor's room\n${read(roomId)}`)
  expect(r.text).toContain('Harbor secret plan')
  expect(r.cards).toHaveLength(0)
  // erin's own turn there reads it as erin (she is in it too); bob, who is not in that chat, is never asked
  expect(ws.bob!.frames.filter((x) => x.type === 'turn.request').length).toBe(0)
})

test('the instructions name this project\'s chat room and its id; the asker\'s other rooms are read as in their own chat', () => {
  const id = uuidv7()
  const withRoom = sharedSection({ project: 'Harbor', audience: 3, asker: 'Alice', projectRoom: id }, 'en', true)
  expect(withRoom).toContain(`this project's chat room (room_id=${id})`)
  expect(withRoom).toContain('with no card')
  expect(withRoom).not.toContain('It is the only room you can read here')
  const without = sharedSection({ project: 'Harbor', audience: 3, asker: 'Alice' }, 'en', true)
  expect(without).not.toContain("this project's chat room")
  expect(without).toContain("Alice's team chat rooms (rooms, room_read, room_file, save_room_file)")
})
