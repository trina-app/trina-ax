// The person's yes on a card covers the same kind of action to the same target for the rest of that chat
// (server/src/chat/card-approvals.ts, docs/decisions/20261117-card-approved-once-per-chat.md, QA rows of PR "card
// approved once per chat"). Reproduces FL-08 of the AI flow check (tests/ai-scenarios, 2026-11-17 default mode: after a
// room read, the same quote fixed again showed the room card for every file once more, and the stamped copy for the
// team folder raised two cards for one call) with the fake engine through the real launcher and gate:
// - after [이번만 허용] on a file's room card, a later answer of the same chat changes that file with no card; another
//   file, another kind of change (a rename), a skill file, another chat, a [허용 안 함], an old approval: a card each;
// - stamp_pdf to a folder more people can see after a room read: ONE card (the room's and the wider-audience question
//   together), and the same save from the same sources in a later answer: none; another folder: the card;
// - post_to_room: [보내기] for a room covers later posts of the AI's text to that room in the chat; another room, a note,
//   another chat: the card.
// The fixture team: alice and erin in marketing (groups/marketing: alice, erin, carol, dana), bob in finance.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, uuidv7, type Room, type RoomMessage, type TurnRequest } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { pngRgbaOf } from '../lib/images'
import { makePagedPdf } from '../lib/pdf'
import { roomsOf } from '../../server/src/rooms/service'
import { approvalsFor, clearApprovals, dropApprovals, noteApproval } from '../../server/src/chat/card-approvals'

setDefaultTimeout(120_000)
// the fake engine's directives, their strings spelled as JSON escapes: the person's own words are only what the test
// writes around them (the explicit-ask rules read those)
const opaque = (j: string) => j.replace(/"(?:[^"\\]|\\.)*"/g, (q) => q.replace(/\\.|[\p{L}\p{N}]/gu, (c) => (c.length > 1 ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)))
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + opaque(JSON.stringify(d))).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
type Ask = Extract<TurnRequest, { kind: 'ask_user' }>

let h: Harness
const ws: Record<string, TestSocket> = {}
let clock = Date.now()
beforeAll(async () => {
  h = await startHarness({ name: 'b-card-approved-once', askUserTimeoutMs: 4000, stallTimeoutMs: 60_000 })
  const db = h.ctx.db
  db.exec('PRAGMA foreign_keys = OFF')
  for (const g of ['marketing', 'finance']) {
    const id = uuidv7()
    for (const sql of ['UPDATE groups SET id = ?1 WHERE id = ?2', 'UPDATE group_members SET group_id = ?1 WHERE group_id = ?2', "UPDATE folder_rules SET subject_id = ?1 WHERE subject_type = 'group' AND subject_id = ?2", 'UPDATE rooms SET group_id = ?1 WHERE group_id = ?2'])
      db.query(sql).run(id, g)
  }
  db.exec('PRAGMA foreign_keys = ON')
  roomsOf(h.ctx).clock = () => (clock += 10_000)
  for (const u of ['alice', 'erin']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h?.close() })

const ALL = ['alice', 'erin', 'carol', 'dana']
let groups = 0
async function teamRoom(memberIds: string[] = ALL): Promise<string> {
  const g = await h.api('dana').call(API.createGroup, { body: { name: `approved-once-${++groups}`, memberIds } })
  const r = (await h.api(memberIds[0]!).call(API.listRooms)).items.find((x) => x.kind === 'team' && x.groupId === g.id)
  if (!r) throw new Error('no team room')
  return r.id
}
const at = (rel: string) => path.join(h.team, rel)
const put = (rel: string, body: string | Uint8Array = 'x\n') => { fs.mkdirSync(path.dirname(at(rel)), { recursive: true }); fs.writeFileSync(at(rel), body) }
const exists = (rel: string) => fs.existsSync(at(rel))
const read = (rel: string) => fs.readFileSync(at(rel), 'utf8')
const values = (c: Ask) => c.options?.map((o) => o.value) ?? []
async function send(user: string, roomId: string, body: string): Promise<RoomMessage> {
  return await h.api(user).call(API.sendRoomMessage, { params: { id: roomId }, body: { body, clientMessageId: cm(), mentions: [], fileIds: [] } })
}
const newChat = async (user: string) => (await h.api(user).call(API.createChat, { body: {} })).id
/** one answer; each card is answered by `answer` ("skip" by default); its cards and the answer */
async function run(user: string, chatId: string, content: string, answer: (c: Ask) => string = (c) => (values(c).includes('no') ? 'no' : 'skip')) {
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const cards: Ask[] = []
  const end = Date.now() + 90_000
  for (;;) {
    const sock = ws[user]!
    const f = sock.frames.find((x) => x.type === 'turn.request' && x.data.turnId === r.turnId && x.data.request.kind === 'ask_user' && !cards.some((c) => c.requestId === x.data.request.requestId))
    if (f && f.type === 'turn.request') {
      const c = f.data.request as Ask
      cards.push(c)
      if (process.env.DEBUG_CARDS) console.log(JSON.stringify({ q: c.question, o: values(c) }))
      await h.api(user).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.requestId, answer: answer(c) } })
      continue
    }
    const done = sock.frames.find((x) => x.type === 'message.done' && x.data.message.turnId === r.turnId)
    if (done && done.type === 'message.done') return { turnId: r.turnId, cards, done: done.data.message }
    if (Date.now() > end) throw new Error('turn did not end')
    await Bun.sleep(25)
  }
}
const roomRead = (room: string) => ({ tool: 'room_read', args: { room } })
const write = (file_path: string, content = 'made by the AI\n') => ({ tool: 'write', args: { file_path, content } })
/** a change of a file that is there: read first (as the write tool wants), then written */
const fix = (file_path: string, content: string) => [{ tool: 'read', args: { file_path } }, write(file_path, content)]
const labels = (done: { steps?: { tool?: string; label: string }[] }, tool: string) => (done.steps ?? []).filter((s) => s.tool === tool).map((s) => s.label)
const WHY = "Messages from your conversations (other people's words) came in here, so changes are asked first."
const EARLIER = 'allowed earlier in this chat'
/** [이번만 허용] on a room card, [저장] on a wider-audience card */
const yes = (c: Ask) => (values(c).includes('save') ? 'save' : values(c).includes('send') ? 'send' : 'allow')
const approvals = (chatId: string) => h.ctx.db.query('SELECT user_id, kind, target FROM chat_card_approvals WHERE chat_id = ? ORDER BY id').all(chatId) as { user_id: string; kind: string; target: string }[]

describe('a file the person allowed on a room card (FL-08)', () => {
  test('the same file again in a later answer: no card, the step says why; another file, a rename, another chat, a no: a card each', async () => {
    const roomId = await teamRoom()
    await send('erin', roomId, '사아자 베이커리는 볼펜 단가 5,500원으로 해주세요.')
    const tag = uuidv7().slice(-6)
    const quote = `users/alice/quote-${tag}/quote.html`, other = `users/alice/quote-${tag}/terms.md`
    put(quote, 'v1\n')
    put(other, 'terms v1\n')
    const chat = await newChat('alice')
    // the first fix after the room read: the room card for that file, allowed once
    const first = await run('alice', chat, `fix it as the CEO said\n${fake(roomRead(roomId), ...fix(quote, 'v2\n'), { say: 'fixed' })}`, yes)
    expect(first.cards).toHaveLength(1)
    expect(first.cards[0]!.question).toContain(WHY)
    expect(read(quote)).toBe('v2\n')
    expect(approvals(chat)).toEqual([{ user_id: 'alice', kind: 'file_change', target: quote }])
    // the same file again (the price changed once more): no card; the step says it was allowed earlier in this chat
    const again = await run('alice', chat, `once more\n${fake(...fix(quote, 'v3\n'), { say: 'fixed' })}`)
    expect(again.cards).toHaveLength(0)
    expect(read(quote)).toBe('v3\n')
    expect(labels(again.done, 'write').some((l) => l.endsWith(EARLIER))).toBe(true)
    // another file of the same folder: its own card (declined: nothing written, nothing kept)
    const another = await run('alice', chat, `and the terms\n${fake(...fix(other, 'terms v2\n'), { say: 'done' })}`)
    expect(another.cards).toHaveLength(1)
    expect(read(other)).toBe('terms v1\n')
    // another kind of change to the allowed file (a rename): its own card
    const rename = await run('alice', chat, `rename\n${fake({ tool: 'rename_file', args: { path: quote, new_name: 'quote-old.html' }, sayResult: true }, { say: 'ok' })}`)
    expect(rename.cards).toHaveLength(1)
    expect(exists(quote)).toBe(true)
    // the declined cards kept nothing
    expect(approvals(chat).map((a) => a.target)).toEqual([quote])
    // another chat that read the room: its own card
    const chat2 = await newChat('alice')
    const elsewhere = await run('alice', chat2, `fix\n${fake(roomRead(roomId), ...fix(quote, 'v4\n'), { say: 'x' })}`)
    expect(elsewhere.cards).toHaveLength(1)
    expect(read(quote)).toBe('v3\n')
    // twelve hours on: asked once more
    h.ctx.db.query("UPDATE chat_card_approvals SET created_at = '2000-01-01T00:00:00.000Z' WHERE chat_id = ?").run(chat)
    const later = await run('alice', chat, `again\n${fake(...fix(quote, 'v5\n'), { say: 'x' })}`)
    expect(later.cards).toHaveLength(1)
    expect(read(quote)).toBe('v3\n')
  })

  test('a skill or instruction file: allowed once, asked again every time', async () => {
    const roomId = await teamRoom()
    await send('erin', roomId, 'note')
    const tag = uuidv7().slice(-6)
    const notes = `users/alice/notes-${tag}/CLAUDE.md`
    put(notes, 'old\n')
    const chat = await newChat('alice')
    const first = await run('alice', chat, `update\n${fake(roomRead(roomId), ...fix(notes, 'new\n'), { say: 'x' })}`, yes)
    expect(first.cards).toHaveLength(1)
    expect(read(notes)).toBe('new\n')
    const again = await run('alice', chat, `update\n${fake(...fix(notes, 'PLANTED\n'), { say: 'x' })}`)
    expect(again.cards).toHaveLength(1)
    expect(read(notes)).toBe('new\n')
    expect(approvals(chat)).toEqual([])
  })

  test('stamp_pdf into a folder more people can see after a room read: one card for the call; the same save again later: none; another folder: the card', async () => {
    const roomId = await teamRoom()
    await send('erin', roomId, '직인 찍어서 영업 폴더에 올려 주세요')
    const tag = uuidv7().slice(-6)
    const work = `users/alice/stamp-${tag}`
    const out = `groups/marketing/quotes-${tag}/quote.pdf`
    fs.mkdirSync(at(`groups/marketing/quotes-${tag}`), { recursive: true })
    put(`${work}/quote.pdf`, makePagedPdf([['Quote'], ['Terms (인)']]))
    put(`${work}/seal.png`, pngRgbaOf(40, 40, (x, y) => ((x - 19.5) ** 2 + (y - 19.5) ** 2 < 18 ** 2 ? [200, 0, 0, 255] : [0, 0, 0, 0])))
    put(`${work}/quote.html`, 'v1\n')
    const stamp = { tool: 'stamp_pdf', args: { file_path: `${work}/quote.pdf`, image: `${work}/seal.png`, output: out }, sayResult: true }
    const chat = await newChat('alice')
    // FL-08 step 5: fix the page (its room card), then the stamped copy for the team folder: one card, not two
    const first = await run('alice', chat, `fix and stamp\n${fake(roomRead(roomId), { tool: 'read', args: { file_path: `${work}/quote.pdf` } }, ...fix(`${work}/quote.html`, 'v2\n'), stamp, { say: 'done' })}`, yes)
    expect(first.cards).toHaveLength(2)
    expect(first.cards[1]!.question).toContain(WHY)
    expect(values(first.cards[1]!)).toContain('save')
    expect(exists(out)).toBe(true)
    // FL-08 again (a second price change): the same file fixed and stamped to the same place from the same sources: no card
    const again = await run('alice', chat, `again\n${fake(...fix(`${work}/quote.html`, 'v3\n'), stamp, { say: 'done' })}`)
    expect(again.cards).toHaveLength(0)
    expect(read(`${work}/quote.html`)).toBe('v3\n')
    // another folder: its card again (one, the room's and the wider-audience question together)
    fs.mkdirSync(at(`groups/marketing/quotes-${tag}-b`), { recursive: true })
    const elsewhere = await run('alice', chat, `there\n${fake({ ...stamp, args: { ...stamp.args, output: `groups/marketing/quotes-${tag}-b/quote.pdf` } }, { say: 'done' })}`)
    expect(elsewhere.cards).toHaveLength(1)
    expect(elsewhere.cards[0]!.question).toContain(WHY)
    expect(exists(`groups/marketing/quotes-${tag}-b/quote.pdf`)).toBe(false)
  })
})

describe('a post to a room the person sent on its card', () => {
  test('later posts of the AI\'s text to that room in the chat: no card; another room, a note, another chat: the card', async () => {
    const list = (await h.api('alice').call(API.listRooms)).items as Room[]
    const marketing = list.find((r) => r.kind === 'team' && r.name === 'Marketing')!.id
    const all = list.find((r) => r.kind === 'all')!.id
    const post = (room: string, text: string, more: Record<string, unknown> = {}) => fake({ tool: 'post_to_room', args: { room, text, ...more }, sayResult: true })
    const chat = await newChat('alice')
    const first = await run('alice', chat, `hmm\n${post(marketing, 'summary one')}`, yes)
    expect(first.cards).toHaveLength(1)
    expect(approvals(chat)).toEqual([{ user_id: 'alice', kind: 'room_post', target: JSON.stringify([marketing, null]) }])
    const second = await run('alice', chat, `hmm\n${post(marketing, 'summary two')}`)
    expect(second.cards).toHaveLength(0)
    expect(((await h.api('erin').call(API.listRoomMessages, { params: { id: marketing }, query: {} })).items as RoomMessage[]).at(-1)!.body).toBe('summary two')
    // another room: the card (declined)
    const other = await run('alice', chat, `hmm\n${post(all, 'summary three')}`)
    expect(other.cards).toHaveLength(1)
    // a note sent as alice's own words: the card
    const noted = await run('alice', chat, `hmm\n${post(marketing, 'summary four', { note: 'FYI from me' })}`)
    expect(noted.cards).toHaveLength(1)
    // another chat: the card
    const chat2 = await newChat('alice')
    const elsewhere = await run('alice', chat2, `hmm\n${post(marketing, 'summary five')}`)
    expect(elsewhere.cards).toHaveLength(1)
  })
})

describe('the store (chat/card-approvals.ts)', () => {
  test('only the person who said yes, in that chat, for that kind and target, for 12 hours; a new session clears it', async () => {
    const chat = await newChat('alice')
    const db = h.ctx.db
    const now = Date.parse('2026-11-17T00:00:00Z')
    noteApproval(db, { chatId: chat, userId: 'alice', kind: 'connector', target: 't1', detail: { pins: ['a@x.example'] } }, now)
    expect(approvalsFor(db, { chatId: chat, userId: 'alice', kind: 'connector', target: 't1' }, now + 3600_000)).toEqual([{ pins: ['a@x.example'] }])
    expect(approvalsFor(db, { chatId: chat, userId: 'erin', kind: 'connector', target: 't1' }, now)).toEqual([])
    expect(approvalsFor(db, { chatId: chat, userId: 'alice', kind: 'connector', target: 't2' }, now)).toEqual([])
    expect(approvalsFor(db, { chatId: chat, userId: 'alice', kind: 'room_post', target: 't1' }, now)).toEqual([])
    expect(approvalsFor(db, { chatId: chat, userId: 'alice', kind: 'connector', target: 't1' }, now + 12 * 3600_000 + 1)).toEqual([])
    noteApproval(db, { chatId: chat, userId: 'alice', kind: 'connector_made', target: 'm', detail: { id: 'd1' } }, now)
    noteApproval(db, { chatId: chat, userId: 'alice', kind: 'connector_made', target: 'm', detail: { id: 'd2' } }, now)
    dropApprovals(db, { chatId: chat, kind: 'connector_made', target: 'm' }, (d) => d.id === 'd1')
    expect(approvalsFor(db, { chatId: chat, userId: 'alice', kind: 'connector_made', target: 'm' }, now)).toEqual([{ id: 'd2' }])
    clearApprovals(db, chat)
    expect(approvalsFor(db, { chatId: chat, userId: 'alice', kind: 'connector_made', target: 'm' }, now)).toEqual([])
  })
})
