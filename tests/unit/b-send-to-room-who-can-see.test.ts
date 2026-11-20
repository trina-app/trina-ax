// "대화에 보내기" from a project channel's ✦ side chat (chat/answer-share.ts; docs/decisions/
// 20261120-send-to-room-who-can-see.md). The owner's case, 2026-11-20: in a 3-person private channel linked to a project,
// the side chat answered from the channel's messages and the project folder, and pressing "대화에 보내기" asked first.
// The test of the ask is "can every room member open what the AI read", never "someone else wrote it":
//   - this room's own messages and the project folder every member reads: sent at once, also when another person
//     wrote the file;
//   - a search that read the asker's own folder and a department folder some members cannot read: asked, and the card
//     names each place with how many files there ("내 파일 2개");
//   - the person's own "Always allow" for room posts: sent at once (Rule A), links only; with "Always allow" for posts
//     with their files, the files they may share go as copies;
// The guest case (a guest who cannot open the project folder makes it count) is in a-guests-answer-share.test.ts.
// Real turns through the scripted engine (room_read, grep, read), real routes.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, type Room } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { roomsOf } from '../../server/src/rooms/service'
import { sideRoomSection } from '../../server/src/chat/prompt'

setDefaultTimeout(120_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
let sock: TestSocket
let room: Room
let projectFolder: string
let clock = Date.now()

beforeAll(async () => {
  h = await startHarness({ name: 'b-send-to-room-who-can-see' })
  roomsOf(h.ctx).clock = () => (clock += 10_000)
  sock = await h.ws('alice')
  await sock.next('hello')
  // a team project of alice with bob (finance) and erin (marketing), and a private channel of the three linked to it
  const project = await h.api('alice').call(API.createProject, { body: { name: 'Lumanesis', participants: [{ subjectType: 'user', subjectId: 'bob' }, { subjectType: 'user', subjectId: 'erin' }], instructions: '' } })
  projectFolder = (h.ctx.db.query('SELECT folder_path FROM projects WHERE id = ?').get(project.id) as { folder_path: string }).folder_path
  room = await h.api('alice').call(API.createRoom, { body: { kind: 'group', userIds: ['bob', 'erin'], name: '루마네시스템' } })
  const linked = await h.req('alice', `/api/rooms/${room.id}/project`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: project.id }) })
  expect(linked.status).toBe(200)
  // the room's own talk: bob asks
  await h.api('bob').call(API.sendRoomMessage, { params: { id: room.id }, body: { body: '루마네 보증 기간이 어떻게 되죠?', mentions: [], fileIds: [], clientMessageId: cm() } })
  // files: the project's warranty sheet, written by bob (someone else's words, and every member opens it); alice's own
  // notes; a marketing file (bob is in finance: he cannot open it)
  const put = (rel: string, text: string) => { const abs = path.join(h.ctx.files.fx.root, ...rel.split('/')); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, text) }
  put(`${projectFolder}/warranty.md`, '# 루마네 보증\n보증 기간 3년, 소모품 1년.\n')
  h.ctx.db.query("INSERT INTO file_events (user_id, path, action, size) VALUES ('bob', ?, 'create', 1)").run(`${projectFolder}/warranty.md`)
  put('users/alice/notes.md', '보증 연장 협상 메모: 비공개\n')
  put('users/alice/todo.md', '보증서 원본 찾기\n')
  put('groups/marketing/leads.md', '리드 목록: 보증 문의 3건\n')
})
afterAll(async () => { sock?.close(); await h?.close() })

/** a side chat question of alice in the channel, its answer done */
async function sideAnswer(directives: unknown[]) {
  const chat = await h.api('alice').call(API.createChat, { body: { sideRoomId: room.id } })
  const r = await ask(h, sock, 'alice', chat.id, `보증 기간 정리해 줘\n${fake(...directives)}`, { ms: 60_000 })
  if (r.done.status !== 'done') console.log('ERR', JSON.stringify(r.done).slice(0, 800))
  expect(r.done.status).toBe('done')
  return { chatId: chat.id, answerId: r.done.id as string }
}
async function share(a: { chatId: string; answerId: string }, body: Record<string, unknown> = {}) {
  const r = await h.req('alice', `/api/chats/${a.chatId}/messages/${a.answerId}/share-to-room`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roomId: room.id, clientMessageId: cm(), ...body }) })
  return { status: r.status, json: await r.json() as any }
}
const lastAudit = () => JSON.parse((h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'room.answer_share' ORDER BY id DESC LIMIT 1").get() as { detail: string }).detail)
const setAlways = (kind: string | null) => {
  h.ctx.db.query("DELETE FROM card_always_allow WHERE user_id = 'alice'").run()
  if (kind) h.ctx.db.query("INSERT INTO card_always_allow (user_id, kind, created_at) VALUES ('alice', ?, ?)").run(kind, new Date().toISOString())
}

test("this room's messages and the project folder every member opens (a file bob wrote): sent at once, no ask", async () => {
  setAlways(null)
  const a = await sideAnswer([
    { tool: 'room_read', args: { room: room.id } },
    { tool: 'grep', args: { pattern: '보증', path: projectFolder, output_mode: 'content' } },
    { tool: 'read', args: { file_path: `${projectFolder}/warranty.md` } },
    { say: '보증 기간은 3년, 소모품은 1년이에요.' },
  ])
  const r = await share(a)
  expect(r.status).toBe(200)
  expect(r.json.status).toBe('sent')
  expect(lastAudit()).toMatchObject({ people: 0, confirmed: false })
})

test('a search over the whole team folder read my own files and a department folder bob cannot open: asked, each place named with its count', async () => {
  setAlways(null)
  const a = await sideAnswer([
    { tool: 'room_read', args: { room: room.id } },
    { tool: 'grep', args: { pattern: '보증', output_mode: 'content' } },
    { say: '보증 기간은 3년이에요.' },
  ])
  const r = await share(a)
  expect(r.status).toBe(200)
  expect(r.json.status).toBe('confirm')
  // bob misses the marketing folder; bob and erin miss alice's own folder: 2 people, never who
  expect(r.json.provenance.people).toBe(2)
  const places = r.json.provenance.places as { kind: string; path?: string; files?: number }[]
  expect(places).toContainEqual({ kind: 'mine', files: 2 })
  expect(places).toContainEqual({ kind: 'folder', path: 'groups/marketing', files: 1 })
  // the project folder and this room are not among them
  expect(places.some((p) => p.kind === 'conversation' || p.path === projectFolder)).toBe(false)
  // the yes sends it
  const yes = await share(a, { confirmKey: r.json.confirmKey, attach: [] })
  expect(yes.json.status).toBe('sent')
})

test('"Always allow" for room posts is final (Rule A): the same answer goes at once, links only, audited as such', async () => {
  setAlways('post_to_room')
  try {
    const a = await sideAnswer([
      { tool: 'grep', args: { pattern: '보증', output_mode: 'content' } },
      { say: '정리: [notes.md](/files/view?path=users/alice/notes.md)' },
    ])
    const r = await share(a)
    expect(r.json.status).toBe('sent')
    expect(r.json.message.files).toEqual([])
    expect(lastAudit()).toMatchObject({ always: true, confirmed: true, files: 0 })
    // "Always allow" for posts with their files: my own linked file goes as a copy
    setAlways('post_files')
    const b = await sideAnswer([
      { tool: 'grep', args: { pattern: '보증', output_mode: 'content' } },
      { say: '정리: [notes.md](/files/view?path=users/alice/notes.md)' },
    ])
    const s = await share(b)
    expect(s.json.status).toBe('sent')
    expect(s.json.message.files.length).toBe(1)
    expect(lastAudit()).toMatchObject({ always: true, files: 1 })
  } finally { setAlways(null) }
})

test("a project channel's side chat is told to look in the project folder first", () => {
  const line = sideRoomSection({ id: 'r1', kind: 'group', name: '루마네시스템', saveIn: 'projects/Lumanesis', project: { name: 'Lumanesis', folderPath: 'projects/Lumanesis' } }, 'ko')
  expect(line).toContain("For a question about this channel's work, look in that folder first")
  expect(line).toContain('"대화에 보내기" ask the person first')
})
