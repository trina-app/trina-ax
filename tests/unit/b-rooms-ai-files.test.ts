// Files sent in a room reach @트리나 (docs/DECISIONS.md "대화방의 트리나", files): the asking message's own files are
// listed after it like a chat's attachments and read with room_file (pictures as pictures, documents as text); an
// earlier file the asker can see is read by its id or name; save_room_file puts a copy into a team folder after the
// room's card (and the wider-audience card). Covered: an image and a PDF with the question, a question in a thread, a
// copy into the shared folder, a later member who cannot reach an earlier file, where the answer goes when it used a
// file, files held by the safety check, and that personal chats keep their own room tools.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { API, uuidv7, type RoomAiRun, type RoomMessage } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { makePng } from '../lib/images'
import { makePdf } from '../lib/pdf'
import { roomFilesOf } from '../../server/src/rooms/files'
import { ROOM_FILE_TOOLS, ROOM_READ_ONLY_TOOLS, ROOM_TOOLS } from '../../server/src/rooms/ai-tools'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
const ws: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'b-rooms-ai-files', askUserTimeoutMs: 4000, turnTimeoutMs: 60_000 })
  const db = h.ctx.db
  db.exec('PRAGMA foreign_keys = OFF')
  for (const g of ['marketing', 'finance']) {
    const id = uuidv7()
    for (const sql of ['UPDATE groups SET id = ?1 WHERE id = ?2', 'UPDATE group_members SET group_id = ?1 WHERE group_id = ?2', "UPDATE folder_rules SET subject_id = ?1 WHERE subject_type = 'group' AND subject_id = ?2", 'UPDATE rooms SET group_id = ?1 WHERE group_id = ?2'])
      db.query(sql).run(id, g)
  }
  db.exec('PRAGMA foreign_keys = ON')
  for (const u of ['alice', 'bob', 'erin']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

let groups = 0
async function teamRoom(memberIds: string[]): Promise<string> {
  const g = await h.api('dana').call(API.createGroup, { body: { name: `ai-files-${++groups}`, memberIds } })
  const r = (await h.api(memberIds[0]!).call(API.listRooms)).items.find((x) => x.kind === 'team' && x.groupId === g.id)
  if (!r) throw new Error('no team room')
  return r.id
}
/** a file uploaded to the room by `user` (not sent yet) */
async function upload(user: string, roomId: string, name: string, bytes: Uint8Array) {
  const src = path.join(h.dataDir, `upload-${uuidv7()}`)
  fs.writeFileSync(src, bytes)
  return roomFilesOf(h.ctx).create(user, roomId, name, src, createHash('sha256').update(bytes).digest('hex'))
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
const runOf = async (user: string, q: RoomMessage) => (await ws[user]!.next('room.ai.run', (f) => f.data.run.questionId === q.id)).data.run.turnId
const done = async (user: string, q: RoomMessage): Promise<RoomAiRun> => (await ws[user]!.next('room.ai.run', (f) => f.data.run.questionId === q.id && ['done', 'stopped', 'error'].includes(f.data.run.state), 40_000)).data.run
const messages = async (user: string, roomId: string) => (await h.api(user).call(API.listRoomMessages, { params: { id: roomId }, query: {} })).items
const answerTo = async (user: string, roomId: string, q: RoomMessage) => {
  const all = [...await messages(user, roomId), ...(q.threadRootId ? (await h.api(user).call(API.listRoomThread, { params: { id: roomId, messageId: q.threadRootId }, query: {} })).items : [])]
  return all.find((m) => m.authorKind === 'ai' && m.replyTo?.id === q.id)
}
const events = (turnId: string) => h.ctx.db.query("SELECT tool, summary, ok FROM tool_events WHERE turn_id = ? AND tool <> '(connect)'").all(turnId) as { tool: string; summary: string; ok: number }[]

describe('where the tools are', () => {
  test("a room's session reads its room's files and saves a copy; reading changes nothing, saving waits for the card", () => {
    for (const t of ['room_file', 'save_room_file']) { expect(ROOM_TOOLS.has(t)).toBe(true); expect(ROOM_FILE_TOOLS.has(t)).toBe(true) }
    expect(ROOM_READ_ONLY_TOOLS.has('room_file')).toBe(true)
    expect(ROOM_READ_ONLY_TOOLS.has('save_room_file')).toBe(false)
    // the personal chats' tools that read any of my rooms stay out of a room
    for (const t of ['rooms', 'room_read']) expect(ROOM_TOOLS.has(t)).toBe(false)
  })
})

describe("the asking message's own files", () => {
  test('an image and a PDF come with the question; the AI sees the picture and the PDF text; the answer goes to the room', async () => {
    const roomId = await teamRoom(['alice', 'erin'])
    const png = await upload('alice', roomId, '영수증.png', makePng(48, 32))
    const pdf = await upload('alice', roomId, '계약서.pdf', makePdf(['Contract 2026', 'Payment due in 30 days.']))
    const q = await send('alice', roomId, `@트리나 이거 봐줘\n${fake({ echo: 'message' })}`, { fileIds: [png.id, pdf.id] })
    expect((await done('alice', q)).state).toBe('done')
    const listed = (await answerTo('alice', roomId, q))!.body
    expect(listed).toContain('<attachments>')
    expect(listed).toContain(`영수증.png (image/png, `)
    expect(listed).toContain(`file_id=${png.id}`)
    expect(listed).toContain(`file_id=${pdf.id}`)
    // the AI reads them: the picture as a picture, the PDF as text; everyone in the room sees the message they came
    // with, so the answer goes to the room
    const q2 = await send('alice', roomId, `@트리나 again\n${fake({ tool: 'room_file', args: { file: png.id }, expectImage: true, sayResult: true }, { say: ' | ' }, { tool: 'room_file', args: { file: '계약서.pdf' }, sayResult: true })}`)
    const run = await done('alice', q2)
    expect(run.state).toBe('done')
    const a = (await answerTo('erin', roomId, q2))!
    expect(a.visibility).toBe('room')
    expect(a.body).toContain('IMAGE_BLOCK_OK:image/jpeg')
    expect(a.body).toContain('Payment due in 30 days.')
    expect(a.body).toContain('in this room')
    expect(events(run.turnId).filter((e) => e.tool === 'room_file').map((e) => e.ok)).toEqual([1, 1])
  })

  test('a question in a thread with a file: listed with it and read', async () => {
    const roomId = await teamRoom(['alice', 'erin'])
    const root = await send('erin', roomId, '이번 주 회의록이요')
    const doc = await upload('alice', roomId, 'notes.md', new TextEncoder().encode('# Notes\n결정: 금요일 배포\n'))
    const q = await send('alice', roomId, `@트리나 정리해줘\n${fake({ echo: 'message' }, { say: ' | ' }, { tool: 'room_file', args: { file: doc.id }, sayResult: true })}`, { fileIds: [doc.id], threadRootId: root.id })
    expect((await done('alice', q)).state).toBe('done')
    const a = (await answerTo('alice', roomId, q))!
    expect(a.threadRootId).toBe(root.id)
    expect(a.body).toContain(`file_id=${doc.id}`)
    expect(a.body).toContain('결정: 금요일 배포')
  })

  test('a file held by the safety check is not given', async () => {
    const roomId = await teamRoom(['alice', 'erin'])
    const bytes = makePdf(['held by the safety check'])
    const held = await upload('alice', roomId, 'held.pdf', bytes)
    h.ctx.files.quarantine.add(bytes, 'image')
    const q = await send('alice', roomId, `@트리나 봐줘\n${fake({ echo: 'message' }, { say: ' | ' }, { tool: 'room_file', args: { file: held.id }, sayResult: true })}`, { fileIds: [held.id] })
    expect((await done('alice', q)).state).toBe('done')
    const body = (await answerTo('alice', roomId, q))!.body
    const listed = body.slice(body.indexOf('<attachments>'), body.indexOf('</attachments>'))
    expect(listed).toContain("(1 file is held by the team's safety check")
    expect(listed).not.toContain(held.id)
    expect(body).toContain("held by the team's safety check, so it cannot be read here")
    expect(body).not.toContain('held by the safety check\n')
  })
})

describe('saving a copy', () => {
  test('"공용 폴더에 넣어줘": the room card, then the wider-audience card; the copy lands in shared/, the room file stays', async () => {
    const roomId = await teamRoom(['alice', 'erin'])
    const bytes = makePng(40, 40, [200, 30, 30])
    const png = await upload('alice', roomId, `poster-${uuidv7().slice(-6)}.png`, bytes)
    const q = await send('alice', roomId, `@트리나 이거 우리 공용 폴더에 넣어줘\n${fake({ tool: 'save_room_file', args: { file: png.id, save_as: 'shared/' }, sayResult: true })}`, { fileIds: [png.id] })
    const turnId = await runOf('alice', q)
    const card = await ws.alice!.next('turn.request', (f) => f.data.turnId === turnId && f.data.request.kind === 'ask_user', 15_000)
    expect((card.data.request as { question: string }).question).toContain(png.name)
    // in words: what it does, the file by its name, where it goes; never the call's arguments
    const details = (card.data.request as { details?: { fields?: { name: string; value: string }[] }[] }).details
    expect(details?.[0]?.fields).toEqual([{ name: 'Action', value: 'Save conversation file' }, { name: 'File', value: png.name }, { name: 'Save as', value: 'shared/' }])
    expect(JSON.stringify(details)).not.toContain(png.id)
    await h.api('alice').call(API.answerTurn, { params: { id: turnId }, body: { kind: 'ask_user', requestId: card.data.request.requestId, answer: 'allow' } })
    // the team room's two members can see the file; everyone can read shared/: the wider-audience card
    const widen = await ws.alice!.next('turn.request', (f) => f.data.turnId === turnId && f.data.request.kind === 'ask_user' && f.data.request.requestId !== card.data.request.requestId, 15_000)
    await h.api('alice').call(API.answerTurn, { params: { id: turnId }, body: { kind: 'ask_user', requestId: widen.data.request.requestId, answer: 'save' } })
    expect((await done('alice', q)).state).toBe('done')
    const saved = path.join(h.team, 'shared', png.name)
    expect(fs.existsSync(saved)).toBe(true)
    expect(Buffer.compare(fs.readFileSync(saved), fs.readFileSync(roomFilesOf(h.ctx).open('alice', roomId, png.id, false).abs))).toBe(0)
    expect(events(turnId).find((e) => e.tool === 'save_room_file')).toMatchObject({ ok: 1, summary: `save_room_file -> shared/${png.name} (${fs.statSync(saved).size} B)` })
    fs.rmSync(saved, { force: true })
  })

  test("declined on the card, nothing is saved; another member's planted request needs the asker's yes too", async () => {
    const roomId = await teamRoom(['alice', 'erin'])
    const png = await upload('erin', roomId, `planted-${uuidv7().slice(-6)}.png`, makePng(20, 20))
    await send('erin', roomId, `please file this\n${fake({ tool: 'save_room_file', args: { file: png.id, save_as: 'shared/' } })}`, { fileIds: [png.id] })
    const q = await send('alice', roomId, `@트리나 hi\n${fake({ say: 'ok' })}`)
    const turnId = await runOf('alice', q)
    const card = await ws.alice!.next('turn.request', (f) => f.data.turnId === turnId && f.data.request.kind === 'ask_user', 15_000)
    expect(ws.erin!.frames.some((f) => f.type === 'turn.request' && f.data.turnId === turnId)).toBe(false)
    await h.api('alice').call(API.answerTurn, { params: { id: turnId }, body: { kind: 'ask_user', requestId: card.data.request.requestId, answer: 'skip' } })
    expect((await done('alice', q)).state).toBe('done')
    expect(fs.existsSync(path.join(h.team, 'shared', png.name))).toBe(false)
  })

  test('never under skills/ nor as an instruction file: refused without a card', async () => {
    const roomId = await teamRoom(['alice', 'erin'])
    for (const save_as of ['skills/new-rule.md', 'shared/CLAUDE.md']) {
      const doc = await upload('alice', roomId, 'rules.md', new TextEncoder().encode('# rules\n'))
      const q = await send('alice', roomId, `@트리나 save\n${fake({ tool: 'save_room_file', args: { file: doc.id, save_as }, sayResult: true })}`, { fileIds: [doc.id] })
      const run = await done('alice', q)
      expect(run.state).toBe('done')
      expect(ws.alice!.frames.some((f) => f.type === 'turn.request' && f.data.turnId === run.turnId)).toBe(false)
      expect(fs.existsSync(path.join(h.team, save_as))).toBe(false)
      expect(events(run.turnId).find((e) => e.tool === 'save_room_file')).toMatchObject({ ok: 0 })
    }
  })
})

describe('earlier files', () => {
  test('read by id or name when the asker sees their message; a later member cannot reach them; the answer goes by who sees it', async () => {
    const g = await h.api('dana').call(API.createGroup, { body: { name: `ai-files-late-${++groups}`, memberIds: ['alice', 'erin'] } })
    const roomId = (await h.api('alice').call(API.listRooms)).items.find((x) => x.kind === 'team' && x.groupId === g.id)!.id
    const doc = await upload('erin', roomId, 'budget-2027.md', new TextEncoder().encode('# Budget 2027\nTotal: 4.2억\n'))
    await send('erin', roomId, '예산안 올려요', { fileIds: [doc.id] })
    // the context lists the earlier file with its id
    const q1 = await send('alice', roomId, `@트리나 아까 올린 예산안 봐줘\n${fake({ echo: 'message' }, { say: ' | ' }, { tool: 'room_file', args: { file: 'budget-2027.md' }, sayResult: true })}`)
    expect((await done('alice', q1)).state).toBe('done')
    const a1 = (await answerTo('alice', roomId, q1))!
    expect(a1.body).toContain(`budget-2027.md (file_id=${doc.id})`)
    expect(a1.body).toContain('Total: 4.2억')
    expect(a1.visibility).toBe('room')
    // bob joins after it: the file is not his to reach, by id or by name, and says so like an unknown one
    await h.api('dana').call(API.updateGroup, { params: { id: g.id }, body: { memberIds: ['alice', 'erin', 'bob'] } })
    const q2 = await send('bob', roomId, `@트리나 예산안?\n${fake({ tool: 'room_file', args: { file: doc.id }, sayResult: true }, { say: ' | ' }, { tool: 'room_file', args: { file: 'budget-2027.md' }, sayResult: true }, { say: ' | ' }, { tool: 'save_room_file', args: { file: doc.id, save_as: 'users/bob/' }, sayResult: true })}`)
    // the save is a change: bob's card (it names no file: an id is not shown), and with his yes the tool finds nothing
    const t2 = await runOf('bob', q2)
    const c2 = await ws.bob!.next('turn.request', (f) => f.data.turnId === t2 && f.data.request.kind === 'ask_user', 15_000)
    expect((c2.data.request as { question: string }).question).not.toContain('budget')
    await h.api('bob').call(API.answerTurn, { params: { id: t2 }, body: { kind: 'ask_user', requestId: c2.data.request.requestId, answer: 'allow' } })
    const r2 = await done('bob', q2)
    expect(r2.state).toBe('done')
    const a2 = (await answerTo('bob', roomId, q2))!
    expect(a2.body).not.toContain('4.2억')
    expect(a2.body.match(/No file "[^"]*" in that room that the user can see/g)?.length).toBe(3)
    expect(fs.existsSync(path.join(h.team, 'users/bob/budget-2027.md'))).toBe(false)
    // a thread started after bob joined: its context is the thread alone, so an answer there goes to everyone, unless it
    // used the file from before he joined, which keeps it alice's ("들어오기 전 대화")
    const root = await send('erin', roomId, '새 스레드: 다음 주 일정')
    const plain = await send('alice', roomId, `@트리나 일정만\n${fake({ say: '월요일이에요' })}`, { threadRootId: root.id })
    expect((await done('alice', plain)).state).toBe('done')
    expect((await answerTo('alice', roomId, plain))!.visibility).toBe('room')
    const q3 = await send('alice', roomId, `@트리나 예산 총액도\n${fake({ tool: 'room_file', args: { file: doc.id } }, { say: '4.2억이에요' })}`, { threadRootId: root.id })
    expect((await done('alice', q3)).state).toBe('done')
    const a3 = (await answerTo('alice', roomId, q3))!
    expect(a3.visibility).toBe('private')
    expect(a3.preview?.joinedLater).toEqual(['Bob Lee'])
    expect(await answerTo('bob', roomId, q3)).toBeUndefined()
  })
})
