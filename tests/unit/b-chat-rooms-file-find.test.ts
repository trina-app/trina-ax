// The AI finds files people sent in their conversations (docs/AGENTS/plan/20261117-1200-chat-file-find.md): the rooms
// search matches the names of the files sent with a message, in 1:1 chats and thread replies too, a file-only message
// included; from_me, with_person and files narrow it; every hit names its file_id and room_id for room_file. Kept: only
// rooms the person is in and messages they can see, the rooms shown join the chat's read scope, the output is bounded.
// Then room_file reads a thread reply's PDF and spreadsheet, and a copy saved to the person's own folder (no card) is a
// team file the other file tools take.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { API, uuidv7, type RoomMessage } from '@mycel/shared/api'
import { RoomsInput } from '@mycel/shared'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { makePdf } from '../lib/pdf'
import { roomFilesOf } from '../../server/src/rooms/files'
import { roomMatchCount, searchRooms } from '../../server/src/rooms/reader'
import { ROOM_TOOL_DESCRIPTIONS } from '../../server/src/chat/room-tools'

setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const TZ = 'UTC'

let h: Harness
const ws: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'b-chat-rooms-file-find', askUserTimeoutMs: 4000, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob', 'erin']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

async function upload(user: string, roomId: string, name: string, bytes: Uint8Array) {
  const src = path.join(h.dataDir, `upload-${uuidv7()}`)
  fs.writeFileSync(src, bytes)
  return roomFilesOf(h.ctx).create(user, roomId, name, src, sha(bytes))
}
async function send(user: string, roomId: string, body: string, o: { fileIds?: string[]; threadRootId?: string } = {}): Promise<RoomMessage> {
  const clientMessageId = cm()
  for (let i = 0; ; i++) {
    try {
      return await h.api(user).call(API.sendRoomMessage, { params: { id: roomId }, body: { body, clientMessageId, mentions: [], fileIds: o.fileIds ?? [], ...(o.threadRootId ? { threadRootId: o.threadRootId } : {}) } })
    } catch (e) {
      const err = e as { status?: number; body?: { retryAfter?: number } }
      if (err.status !== 429 || i >= 5) throw e
      await Bun.sleep(1000 * (err.body?.retryAfter ?? 1))
    }
  }
}
const sheet = (rows: (string | number)[][]) => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1'); return new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })) }
const newChat = async (user: string) => (await h.api(user).call(API.createChat, { body: {} })).id
type Card = { requestId: string; question: string }
async function run(user: string, chatId: string, content: string, answer: (c: Card) => string = () => 'skip') {
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const cards: Card[] = []
  const end = Date.now() + 60_000
  for (;;) {
    const sock = ws[user]!
    const f = sock.frames.find((x) => x.type === 'turn.request' && x.data.turnId === r.turnId && x.data.request.kind === 'ask_user' && !cards.some((c) => c.requestId === (x.data.request as Card).requestId))
    if (f && f.type === 'turn.request') {
      const c = f.data.request as unknown as Card
      cards.push(c)
      await h.api(user).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.requestId, answer: answer(c) } })
      continue
    }
    const done = sock.frames.find((x) => x.type === 'message.done' && x.data.message.turnId === r.turnId)
    if (done && done.type === 'message.done') return { turnId: r.turnId, cards, done: done.data.message }
    if (Date.now() > end) throw new Error('turn did not end')
    await Bun.sleep(25)
  }
}
const scope = (chatId: string) => (h.ctx.db.query('SELECT session_read_scope AS s FROM chats WHERE id = ?').get(chatId) as { s: string | null } | null)?.s ?? ''

// the fixture: a 1:1 chat alice ↔ erin where alice sent a form with no words; a group chat "leads" (alice, erin, bob)
// whose thread holds file-only replies; bob is in no 1:1 chat with alice
let dmId = '', leadsId = '', rootId = ''
let form = { id: '' }, reg = { id: '' }, list = { id: '' }
let regBytes: Uint8Array = new Uint8Array()
beforeAll(async () => {
  dmId = (await h.api('alice').call(API.createRoom, { body: { kind: 'dm', userId: 'erin' } })).id
  await send('erin', dmId, 'hi, can you send the form?')
  form = await upload('alice', dmId, '계좌신고서.xlsx', sheet([['은행', '계좌번호', '예금주'], ['가짜은행', '000-0000-0000-00', '']]))
  await send('alice', dmId, '', { fileIds: [form.id] })
  leadsId = (await h.api('alice').call(API.createRoom, { body: { kind: 'group', userIds: ['erin', 'bob'], name: 'leads' } })).id
  const root = await send('alice', leadsId, 'new lead documents go here')
  rootId = root.id
  regBytes = makePdf(['Business registration (test)', 'Trade name: Ganada Trading (fake)', 'No. 000-00-00000'])
  reg = await upload('alice', leadsId, '사업자등록증.pdf', regBytes)
  await send('alice', leadsId, '', { fileIds: [reg.id], threadRootId: rootId })
  list = await upload('erin', leadsId, 'lead-list.xlsx', sheet([['company', 'contact'], ['Ganada Trading (fake)', 'Hong (fake)']]))
  await send('erin', leadsId, '', { fileIds: [list.id], threadRootId: rootId })
})

describe('search finds files by their names', () => {
  test('a file-only message in a 1:1 chat, by a word of its name; its file_id and room_id are in the hit', () => {
    const r = searchRooms(h.ctx.db, 'alice', TZ, { query: '계좌신고서' })
    expect(r.count).toBe(1)
    expect(r.text).toContain(`file_id=${form.id}`)
    expect(r.text).toContain(`room_id="${dmId}"`)
    expect(r.text).toContain('who="your user')
    expect(r.seen).toEqual([{ roomId: dmId, fromSeq: expect.any(Number) }])
  })
  test('a file in a thread reply, with the thread it is in', () => {
    const r = searchRooms(h.ctx.db, 'alice', TZ, { query: '사업자등록증' })
    expect(r.count).toBe(1)
    expect(r.text).toContain(`file_id=${reg.id}`)
    expect(r.text).toContain(`thread_reply_of="${rootId}"`)
    expect(r.text).toContain(`room_id="${leadsId}"`)
  })
  test('a word for the file type matches the file (엑셀 → .xlsx, PDF → .pdf), with the other words', () => {
    expect(searchRooms(h.ctx.db, 'alice', TZ, { query: '계좌신고서 엑셀' }).count).toBe(1)
    expect(searchRooms(h.ctx.db, 'alice', TZ, { query: '사업자등록증 PDF' }).count).toBe(1)
    expect(searchRooms(h.ctx.db, 'alice', TZ, { query: '계좌신고서 PDF' }).count).toBe(0)
    // a type word alone in the 1:1 chat: the form, not the words-only message
    expect(searchRooms(h.ctx.db, 'alice', TZ, { query: 'excel', room: dmId }).count).toBe(1)
    // "%" and "_" are letters here too
    expect(searchRooms(h.ctx.db, 'alice', TZ, { query: '계좌%' }).count).toBe(0)
  })
  test('words of a thread reply and of a 1:1 chat are found, my own and others\' (as before)', async () => {
    await send('erin', leadsId, 'the registration is the newest one', { threadRootId: rootId })
    const r = searchRooms(h.ctx.db, 'alice', TZ, { query: 'newest one' })
    expect(r.count).toBe(1)
    expect(r.text).toContain(`thread_reply_of="${rootId}"`)
    expect(searchRooms(h.ctx.db, 'alice', TZ, { query: 'send the form' }).text).toContain(`room_id="${dmId}"`)
    expect(searchRooms(h.ctx.db, 'erin', TZ, { query: 'send the form' }).text).toContain('who="your user')
  })
  test('the grep count for the prompt counts file names too', () => {
    expect(roomMatchCount(h.ctx.db, 'alice', '사업자등록증').messages).toBe(1)
  })
})

describe('from_me, with_person, files', () => {
  test('files I sent to a person: their 1:1 chat and the rooms they are in', () => {
    const r = searchRooms(h.ctx.db, 'alice', TZ, { from_me: true, with_person: 'Erin님', files: true })
    expect(r.count).toBe(2)
    expect(r.text).toContain(`file_id=${form.id}`)
    expect(r.text).toContain(`file_id=${reg.id}`)
    expect(r.text).not.toContain(`file_id=${list.id}`)
    // bob is in leads only
    const b = searchRooms(h.ctx.db, 'alice', TZ, { from_me: true, with_person: 'Bob', files: true })
    expect(b.count).toBe(1)
    expect(b.text).toContain(`file_id=${reg.id}`)
    // somebody in none of my rooms, or no such person: nothing, said plainly
    const none = searchRooms(h.ctx.db, 'alice', TZ, { with_person: 'nobody by that name', files: true })
    expect(none.count).toBe(0)
    expect(none.ok).toBe(true)
  })
  test('files someone else sent me; files alone lists messages with files, newest first', () => {
    const r = searchRooms(h.ctx.db, 'alice', TZ, { person: 'Erin', files: true })
    expect(r.count).toBe(1)
    expect(r.text).toContain(`file_id=${list.id}`)
    const all = searchRooms(h.ctx.db, 'alice', TZ, { files: true })
    expect(all.count).toBe(3)
    expect(all.text).not.toContain('can you send the form')
    expect(all.text.indexOf(list.id)).toBeLessThan(all.text.indexOf(form.id))
  })
  test('from_me alone: only my own messages', () => {
    const r = searchRooms(h.ctx.db, 'erin', TZ, { from_me: true })
    expect(r.text).toContain('can you send the form')
    expect(r.text).toContain(`file_id=${list.id}`)
    expect(r.text).not.toContain(`file_id=${form.id}`)
  })
  test('the schema takes them; any of them alone is a search', () => {
    expect(RoomsInput.safeParse({ from_me: true, with_person: 'Erin', files: true }).success).toBe(true)
    expect(RoomsInput.safeParse({ files: 'yes' }).success).toBe(false)
  })
})

describe('only what the person can see', () => {
  test('someone outside the 1:1 chat finds nothing of it, by name or by person', () => {
    expect(searchRooms(h.ctx.db, 'bob', TZ, { query: '계좌신고서' }).count).toBe(0)
    expect(searchRooms(h.ctx.db, 'bob', TZ, { with_person: 'Alice', files: true }).text).not.toContain(form.id)
    expect(roomMatchCount(h.ctx.db, 'bob', '계좌신고서').messages).toBe(0)
  })
  test('a member invited after the thread was written does not see its files', async () => {
    await h.api('alice').call(API.inviteRoomMembers, { params: { id: leadsId }, body: { userIds: ['carol'] } })
    expect(searchRooms(h.ctx.db, 'carol', TZ, { query: '사업자등록증' }).count).toBe(0)
    expect(searchRooms(h.ctx.db, 'carol', TZ, { files: true }).count).toBe(0)
  })
  test('a deleted message\'s file is not found', async () => {
    const extra = await upload('alice', dmId, 'old-draft.xlsx', sheet([['x']]))
    const m = await send('alice', dmId, '', { fileIds: [extra.id] })
    expect(searchRooms(h.ctx.db, 'alice', TZ, { query: 'old-draft' }).count).toBe(1)
    await h.api('alice').call(API.deleteRoomMessage, { params: { id: dmId, messageId: m.id } })
    expect(searchRooms(h.ctx.db, 'alice', TZ, { query: 'old-draft' }).count).toBe(0)
  })
})

describe('in a chat', () => {
  test('the tool text says file names, from_me, with_person and files, and how to use a room file', () => {
    expect(ROOM_TOOL_DESCRIPTIONS.rooms).toContain('file name')
    expect(ROOM_TOOL_DESCRIPTIONS.room_file).toContain('thread')
    expect(ROOM_TOOL_DESCRIPTIONS.room_file).toContain('save_room_file')
  })
  test('search by a file name, read the thread reply\'s PDF and spreadsheet; the chat is marked and the rooms are in its read scope', async () => {
    const chat = await newChat('alice')
    const r = await run('alice', chat, fake(
      { tool: 'rooms', args: { query: '사업자등록증', from_me: true }, sayResult: true },
      { tool: 'room_file', args: { room: leadsId, file: reg.id }, sayResult: true },
      { tool: 'room_file', args: { room: leadsId, file: list.id }, sayResult: true },
    ))
    expect(r.cards).toHaveLength(0)
    expect(r.done.content).toContain(`file_id=${reg.id}`)
    expect(r.done.content).toContain('Ganada Trading (fake)')
    expect(r.done.content).toContain('Hong (fake)')
    expect((h.ctx.db.query('SELECT rooms_seen FROM chats WHERE id = ?').get(chat) as { rooms_seen: number }).rooms_seen).toBe(1)
    expect(scope(chat)).toContain(leadsId)
    // the audit line names no word, room or file
    const lines = h.ctx.db.query("SELECT summary FROM tool_events WHERE turn_id = ? AND tool = 'rooms'").all(r.turnId) as { summary: string }[]
    expect(lines.map((l) => l.summary)).toEqual(['rooms -> search, 1 shown'])
  })
  test('a 1:1 chat\'s file found by search joins the read scope (the warning when the chat is shared later)', async () => {
    const chat = await newChat('alice')
    await run('alice', chat, fake({ tool: 'rooms', args: { with_person: 'Erin', files: true, from_me: true }, sayResult: true }))
    expect(scope(chat)).toContain(dmId)
    expect(scope(chat)).toContain(leadsId)
  })
  test('"use that file": a copy in my own folder without a card, then the team-file tools read it', async () => {
    const chat = await newChat('alice')
    const r = await run('alice', chat, fake(
      { tool: 'save_room_file', args: { room: leadsId, file: reg.id }, sayResult: true },
      { tool: 'read', args: { file_path: 'users/alice/downloads/사업자등록증.pdf' }, sayResult: true },
    ))
    expect(r.cards).toHaveLength(0)
    expect(sha(fs.readFileSync(path.join(h.team, 'users/alice/downloads/사업자등록증.pdf')))).toBe(sha(regBytes))
    expect(r.done.content).toContain('Ganada Trading (fake)')
  })
})
