// The room features work the same with the Codex engine as with Claude (the owner: "우리 전체 codex도 고려해야 해").
// Codex gets our tools through its MCP server entry, limited to the names in mcp_servers.team.enabled_tools
// (engine/codex.ts): every room tool must be in that list, or real Codex never sees it (the fake engine calls any tool
// the bridge lists, so the list itself is checked here). Covered with the fake engine in Codex mode: a person's own
// chat (rooms, room_read, room_file offered; a "#" room token; the change card after a room read), and a room's
// session (room_file and save_room_file offered; the asking message's files; the asker's own words; a thread).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { API, roomRefToken, uuidv7, type RoomAiRun, type RoomMessage } from '@mycel/shared/api'
import { ask as askChat, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { roomFilesOf } from '../../server/src/rooms/files'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
const ws: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'b-codex-rooms', askUserTimeoutMs: 4000, turnTimeoutMs: 60_000 })
  for (const u of ['alice', 'erin']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const groupChat = async (by: string, others: string[], name: string) => (await h.api(by).call(API.createRoom, { body: { kind: 'group', userIds: others, name } })).id
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
async function upload(user: string, roomId: string, name: string, bytes: Uint8Array) {
  const src = path.join(h.dataDir, `upload-${uuidv7()}`)
  fs.writeFileSync(src, bytes)
  return roomFilesOf(h.ctx).create(user, roomId, name, src, createHash('sha256').update(bytes).digest('hex'))
}
const codexChat = async (user: string) => (await h.api(user).call(API.createChat, { body: { engine: 'codex' } })).id
const turn = (user: string, chatId: string, content: string) => askChat(h, ws[user]!, user, chatId, content, { ms: 30_000 })
/** the names Codex is told it may use (mcp_servers.team.enabled_tools), from the argv the engine got */
const enabledTools = (argvJson: string): string[] => {
  const argv = JSON.parse(argvJson) as string[]
  const entry = argv.find((a) => a.startsWith('mcp_servers.team.enabled_tools='))
  if (!entry) throw new Error('no enabled_tools')
  return JSON.parse(entry.slice('mcp_servers.team.enabled_tools='.length)) as string[]
}
const done = async (user: string, q: RoomMessage): Promise<RoomAiRun> => (await ws[user]!.next('room.ai.run', (f) => f.data.run.questionId === q.id && ['done', 'stopped', 'error'].includes(f.data.run.state), 40_000)).data.run
const answerTo = async (user: string, roomId: string, q: RoomMessage) => {
  const all = [...(await h.api(user).call(API.listRoomMessages, { params: { id: roomId }, query: {} })).items, ...(q.threadRootId ? (await h.api(user).call(API.listRoomThread, { params: { id: roomId, messageId: q.threadRootId }, query: {} })).items : [])]
  return all.find((m) => m.authorKind === 'ai' && m.replyTo?.id === q.id)
}

describe("a person's own Codex chat", () => {
  test('rooms, room_read and room_file are in Codex\'s enabled tools and its tool list; a read works and marks the chat', async () => {
    const roomId = await groupChat('alice', ['erin', 'carol'], 'codex 확인방')
    await send('erin', roomId, 'codex can read this')
    const chat = await codexChat('alice')
    expect((h.ctx.db.query('SELECT engine FROM chats WHERE id = ?').get(chat) as { engine: string }).engine).toBe('codex')
    const args = await turn('alice', chat, fake({ echo: 'args' }))
    const enabled = enabledTools(args.done.content)
    for (const t of ['rooms', 'room_read', 'room_file']) expect(enabled).toContain(t)
    // a personal chat never gets the room session's own tools
    expect(enabled).not.toContain('save_room_file')
    expect(enabled).not.toContain('room_thread')
    const listed = await turn('alice', chat, fake({ echo: 'tools' }))
    for (const t of ['rooms', 'room_read', 'room_file']) expect(listed.done.content.split(',')).toContain(t)
    const read = await turn('alice', chat, fake({ tool: 'room_read', args: { room: roomId }, sayResult: true }))
    expect(read.done.content).toContain('codex can read this')
    expect(read.done.steps!.find((s) => s.tool === 'room_read')!.label).toBe('Read conversation · codex 확인방')
    expect((h.ctx.db.query('SELECT rooms_seen FROM chats WHERE id = ?').get(chat) as { rooms_seen: number }).rooms_seen).toBe(1)
  })

  test('a "#" room token reaches Codex as the <room_refs> block; after a room read a write waits for the card', async () => {
    const roomId = await groupChat('alice', ['erin', 'carol'], 'codex 토큰방')
    await send('erin', roomId, 'token message for codex')
    const chat = await codexChat('alice')
    const seen = await turn('alice', chat, `${roomRefToken(roomId, 'codex 토큰방')} 봐봐\n${fake({ echo: 'message' })}`)
    expect(seen.done.content).toContain('<room_refs>')
    expect(seen.done.content).toContain(`room_id=${roomId}`)
    expect(seen.done.content).toContain('[#room 1] 봐봐')
    // the token alone marked the chat: a write now waits for the person's yes, as with Claude
    const target = 'shared/codex-rooms-card.md'
    fs.writeFileSync(path.join(h.team, target), 'original\n')
    const sent = await h.api('alice').call(API.sendMessage, { params: { id: chat }, body: { content: fake({ tool: 'read', args: { file_path: target } }, { tool: 'write', args: { file_path: target, content: 'changed\n' } }, { say: 'tried' }), clientMessageId: cm(), attachmentIds: [] } })
    const card = await ws.alice!.next('turn.request', (f) => f.data.turnId === sent.turnId && f.data.request.kind === 'ask_user', 15_000)
    expect((card.data.request as { question: string }).question).toContain('Messages from your conversations')
    await h.api('alice').call(API.answerTurn, { params: { id: sent.turnId }, body: { kind: 'ask_user', requestId: card.data.request.requestId, answer: 'skip' } })
    await ws.alice!.next('message.done', (f) => f.data.message.turnId === sent.turnId, 30_000)
    expect(fs.readFileSync(path.join(h.team, target), 'utf8')).toBe('original\n')
  })
})

describe("a room's session on Codex", () => {
  test('room_file and save_room_file are enabled; the asking message\'s file, the asker\'s own words and the thread reach Codex', async () => {
    const db = h.ctx.db
    const before = (db.query('SELECT prefs FROM users WHERE id = ?').get('alice') as { prefs: string | null }).prefs
    // alice's own default engine is Codex: her room session runs on it
    db.query('UPDATE users SET prefs = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(before ?? '{}'), engine: 'codex' }), 'alice')
    try {
      const roomId = await groupChat('alice', ['erin', 'carol'], 'codex 세션방')
      const root = await send('erin', roomId, '이번 주 배포 일정 스레드예요')
      await send('alice', roomId, '금요일 배포는 제가 맡을게요', { threadRootId: root.id })
      const doc = await upload('alice', roomId, 'plan.md', new TextEncoder().encode('# Plan\n배포: 금요일 오후 3시\n'))
      const q = await send('alice', roomId, `@트리나 ㄱㄱ\n${fake({ echo: 'args' }, { say: ' | ' }, { echo: 'message' }, { say: ' | ' }, { tool: 'room_file', args: { file: doc.id }, sayResult: true })}`, { fileIds: [doc.id], threadRootId: root.id })
      const run = await done('alice', q)
      expect(run.state).toBe('done')
      const session = db.query("SELECT c.engine FROM chats c JOIN turns t ON t.chat_id = c.id WHERE t.id = ?").get(run.turnId) as { engine: string }
      expect(session.engine).toBe('codex')
      const a = (await answerTo('alice', roomId, q))!
      const [argv] = a.body.split(' | ') as [string]
      const enabled = enabledTools(argv)
      for (const t of ['room_file', 'save_room_file', 'room_thread']) expect(enabled).toContain(t)
      // the personal chats' tools that read any of the person's rooms stay out of a room
      for (const t of ['rooms', 'room_read']) expect(enabled).not.toContain(t)
      // the file listed with the question, the thread's first message, the asker's own earlier words, the file's text
      expect(a.body).toContain('<attachments>')
      expect(a.body).toContain(`file_id=${doc.id}`)
      expect(a.body).toContain('이번 주 배포 일정 스레드예요')
      expect(a.body).toContain('금요일 배포는 제가 맡을게요')
      expect(a.body).toContain('배포: 금요일 오후 3시')
    } finally { db.query('UPDATE users SET prefs = ? WHERE id = ?').run(before, 'alice') }
  })
})
