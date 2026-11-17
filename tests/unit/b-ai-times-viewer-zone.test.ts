// QA TC-4549 (manual MAN-023/028/029/030, qa.trina.app 2026-11-17): every time in AI answers was two hours later than
// the room showed. The team is set to Seoul, the person's browser was in Jakarta; the room screen shows times in the
// browser's zone, the AI gave them in the team's. The web app now sends the browser's zone with a turn (send, edit,
// regenerate: `timeZone`), and the AI's time line and the room tools' times use it, while the time line still names the
// team setting (#1139, docs/decisions/20261117-ai-times-viewer-zone.md). No zone, or one the server does not know:
// the team zone, as before.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, uuidv7 } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { updateTeamSettings } from '../../server/src/admin/settings'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')

let h: Harness
let ws: TestSocket
beforeAll(async () => {
  h = await startHarness({ name: 'b-ai-times-viewer-zone' })
  updateTeamSettings(h.ctx.db, { timeZone: 'Asia/Seoul' })
  ws = await h.ws('alice')
  await ws.next('hello')
})
afterAll(async () => { ws.close(); await h.close() })

const newChat = async () => (await h.api('alice').call(API.createChat, { body: {} })).id
async function send(chatId: string, content: string, timeZone?: string) {
  const r = await h.api('alice').call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [], ...(timeZone !== undefined ? { timeZone } : {}) } })
  const done = await ws.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 30_000)
  return { started: r, content: done.data.message.content as string }
}
/** a room of alice and erin with one message from erin at 02:08 UTC (11:08 in Seoul, 09:08 in Jakarta) */
async function roomWithMessage(): Promise<string> {
  const id = (await h.api('alice').call(API.createRoom, { body: { kind: 'group', userIds: ['erin', 'bob'], name: `tz-${uuidv7().slice(-6)}` } })).id
  const db = h.ctx.db
  const seq = (db.query('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq').get(id) as { last_seq: number }).last_seq
  db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, asked_by, visibility, visible_to, body, mentions, created_at, thread_root_id, thread_root_seq)
    VALUES (?, ?, ?, 'user', 'erin', NULL, 'room', NULL, ?, '[]', ?, NULL, NULL)`).run(uuidv7(), id, seq, 'the quote is ready', '2026-11-17T02:08:00.000Z')
  return id
}

describe("TC-4549: the AI gives times in the person's zone", () => {
  test("the time line: the device's zone for every time said, the team setting still named", async () => {
    const chat = await newChat()
    const r = await send(chat, fake({ echo: 'system' }), 'Asia/Jakarta')
    expect(r.content).toContain('Asia/Seoul is the team time zone, read from the team settings.')
    expect(r.content).toContain("The user's device is set to Asia/Jakarta")
    expect(r.content).toContain('give it in Asia/Jakarta')
  })

  test('room_read prints the message times in the zone the person sees, and says which', async () => {
    const room = await roomWithMessage()
    const jakarta = await send(await newChat(), fake({ tool: 'room_read', args: { room }, sayResult: true }), 'Asia/Jakarta')
    expect(jakarta.content).toContain('2026-11-17 09:08')
    expect(jakarta.content).not.toContain('2026-11-17 11:08')
    expect(jakarta.content).toContain('Times are in Asia/Jakarta')
    // no zone sent (an older app, a scheduled run): the team's, and it says so
    const team = await send(await newChat(), fake({ tool: 'room_read', args: { room }, sayResult: true }))
    expect(team.content).toContain('2026-11-17 11:08')
    expect(team.content).toContain('Times are in Asia/Seoul')
  })

  test('a zone the server does not know is not refused: the team zone is used', async () => {
    const room = await roomWithMessage()
    const r = await send(await newChat(), fake({ tool: 'room_read', args: { room }, sayResult: true }), 'Mars/Olympus')
    expect(r.content).toContain('2026-11-17 11:08')
    expect(r.content).toContain('Times are in Asia/Seoul')
    // longer than any zone name: refused by the request's shape
    await expect(h.api('alice').call(API.sendMessage, { params: { id: await newChat() }, body: { content: 'hi', clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [], timeZone: 'x'.repeat(65) } })).rejects.toThrow()
  })

  test('edit and regenerate carry the zone too', async () => {
    const chat = await newChat()
    const first = await send(chat, fake({ echo: 'system' }))
    expect(first.content).not.toContain('device is set')
    const regen = await h.api('alice').call(API.regenerate, { params: { id: chat, messageId: first.started.assistantMessage.id }, body: { timeZone: 'Asia/Jakarta' } })
    const r1 = await ws.next('message.done', (f) => f.data.messageId === regen.assistantMessage.id, 30_000)
    expect(r1.data.message.content).toContain('give it in Asia/Jakarta')
    const edit = await h.api('alice').call(API.editMessage, { params: { id: chat, messageId: first.started.userMessage!.id }, body: { content: fake({ echo: 'system' }), attachmentIds: [], clientMessageId: 'cm-' + crypto.randomUUID(), timeZone: 'Asia/Jakarta' } })
    const r2 = await ws.next('message.done', (f) => f.data.messageId === edit.assistantMessage.id, 30_000)
    expect(r2.data.message.content).toContain('give it in Asia/Jakarta')
  })
})
