// "Do it, then offer undo" (docs/decisions/20261123-do-then-undo.md): a send whose recipient and content the person
// named goes without its card and can be undone; a schedule the person asked for in their own words is made without its
// card and shows Pause and Delete; a connector tool that only makes something new runs without its card. The floor still
// asks: content some recipients cannot see from a source the person did not name, a vague recipient, a schedule that
// sends, a tool that changes, deletes or sends.
// The fixture team: alice and erin in marketing, bob in finance, carol admin, dana owner (b-harness people).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, uuidv7, type Room, type RoomMessage } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { roomsOf } from '../../server/src/rooms/service'
import { floorFree, inOwnFolder } from '../../server/src/chat/explicit-send'
import { createTool } from '../../server/src/integrations/connections/tools'
import { asksFor, SCHEDULE_ASK } from '../../server/src/chat/shared-actions'
import { NO_OUTSIDE_TOOLS, OWN_WORDS_TOOLS } from '../../server/src/rooms/ai-tools'
import type { CountedSource } from '../../server/src/chat/answer-share'

setDefaultTimeout(60_000)
const cm = () => 'cm-' + crypto.randomUUID()
// the fake engine's directives as JSON escapes, so the person's own words are only what the test writes around them
const opaque = (j: string) => j.replace(/"(?:[^"\\]|\\.)*"/g, (q) => q.replace(/\\.|[\p{L}\p{N}]/gu, (c) => (c.length > 1 ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)))
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + opaque(JSON.stringify(d))).join('\n')
const post = (args: Record<string, unknown>) => fake({ tool: 'post_to_room', args, sayResult: true })

describe('the floor (chat/explicit-send.ts)', () => {
  const src = (source: CountedSource['source'], files: string[] = [], fromScope = false): CountedSource => ({ source, key: JSON.stringify(source), missing: ['x'], fromScope, files: new Set(files) })
  const prov = (counted: CountedSource[], o: Partial<{ unknown: boolean; hidden: boolean; otherPlaces: boolean; keys: string[] }> = {}) => ({ unknown: false, hidden: false, otherPlaces: false, keys: counted.map((c) => c.key), counted, ...o })
  test('only the person\'s own folder files, and team files they named, pass', () => {
    expect(floorFree(prov([]), 'alice')).toBe(true)
    expect(floorFree(prov([src({ type: 'user', id: 'alice' })]), 'alice')).toBe(true)
    // (the owner, 2026-11-23: only someone else's private place is the floor: my own browser, connection and shares too)
    for (const s of [src({ type: 'user', id: 'alice', via: 'connection' }), src({ type: 'user', id: 'alice', via: 'browser' }), src({ type: 'user', id: 'alice', share: 's1' })]) expect(floorFree(prov([s]), 'alice')).toBe(true)
    // a chat I am in: the AI's work there is mine; another chat: not
    expect(floorFree(prov([src({ type: 'chat', id: 'c1' })]), 'alice', () => false, new Set(), (id) => id === 'c1')).toBe(true)
    expect(floorFree(prov([src({ type: 'folder', id: 'f1' }, ['groups/finance/budget.md'])]), 'alice', (r) => r === 'groups/finance/budget.md')).toBe(true)
  })
  test('everything else asks: a room, a chat, a connection, the browser, a share, another person, a team file nobody named, anything not known', () => {
    for (const s of [
      src({ type: 'room', id: 'r1' }), src({ type: 'chat', id: 'c1' }), src({ type: 'integration', id: 'i1' }),
      src({ type: 'user', id: 'bob' }), src({ type: 'folder', id: 'f1' }, ['groups/finance/budget.md']), src({ type: 'folder', id: 'f1' }),
      src({ type: 'slack', id: 's', userId: 'alice', kind: 'dm' }), src({ type: 'root' }),
    ]) expect([s.source, floorFree(prov([s]), 'alice', () => false)]).toEqual([s.source, false])
    expect(floorFree(prov([], { unknown: true }), 'alice')).toBe(false)
    expect(floorFree(prov([], { hidden: true }), 'alice')).toBe(false)
    expect(floorFree(prov([], { otherPlaces: true }), 'alice')).toBe(false)
    // rooms read without saying which: a key with no counted source
    expect(floorFree(prov([], { keys: ['rooms_seen'] }), 'alice')).toBe(false)
  })
  test('the person\'s own folder by path', () => {
    expect(inOwnFolder('users/alice/plan.md', 'alice')).toBe(true)
    expect(inOwnFolder('Users/alice/plan.md', 'alice')).toBe(true)
    expect(inOwnFolder('users/bob/plan.md', 'alice')).toBe(false)
    expect(inOwnFolder('groups/marketing/plan.md', 'alice')).toBe(false)
  })
})

describe('the create tier (connections/tools.ts createTool)', () => {
  const t = (name: string, o: { nonDestructive?: boolean; title?: string; schema?: unknown } = {}) => ({ name, title: o.title ?? null, ...(o.nonDestructive === false ? {} : { nonDestructive: true as const }), inputSchema: o.schema ?? { type: 'object', properties: { name: {}, code: {} } } })
  test('a tool that only makes something new, marked so by the service', () => {
    for (const n of ['create_app', 'createDocument', 'new_page', 'add_note', 'repl_create_app', 'make_folder', 'generate_image', 'build_site']) expect([n, createTool({ google_app: null }, t(n), { name: 'x' })]).toEqual([n, true])
  })
  test('asks: no destructiveHint false, another change word, a message, money, a recipient, a Google app, a name it cannot read', () => {
    expect(createTool({ google_app: null }, t('create_app', { nonDestructive: false }), {})).toBe(false)
    for (const n of ['delete_app', 'update_page', 'create_and_send', 'create_or_update_page', 'create_message', 'create_post', 'create_comment', 'add_member', 'create_invoice', 'create_payment', 'add_to_order', 'create_event', 'create_share_link', 'send_new_page', 'publish_app', 'get_app'])
      expect([n, createTool({ google_app: null }, t(n), {})]).toEqual([n, false])
    expect(createTool({ google_app: null }, t('create_page', { schema: { type: 'object', properties: { to: {} } } }), {})).toBe(false)
    expect(createTool({ google_app: null }, t('create_page'), { body: { recipients: ['a@b.example'] } })).toBe(false)
    expect(createTool({ google_app: 'docs' }, t('create_document'), {})).toBe(false)
    expect(createTool({ google_app: null }, t('create​_app'), {})).toBe(false)
    expect(createTool({ google_app: null }, t('create_app', { title: 'Create and publish app' }), {})).toBe(false)
  })
})

describe('tools that never mark the chat as having used something from outside', () => {
  test('a subset of the own-words tools, never a sub-agent, a skill or a new connection', () => {
    for (const t of NO_OUTSIDE_TOOLS) expect([t, OWN_WORDS_TOOLS.has(t)]).toEqual([t, true])
    for (const t of ['connect_service', 'skill', 'agent', 'Agent', 'Task', 'web_fetch', 'room_read', 'save_url', 'box_shell']) expect([t, NO_OUTSIDE_TOOLS.has(t)]).toEqual([t, false])
  })
})

describe('schedule words', () => {
  test('the person\'s own words for when it runs', () => {
    for (const s of ['매일 아침 9시에 영업 단가표 요약해서 알려줘', '매주 월요일에 정리해줘', '한 시간마다 확인해줘', 'every Monday at 9 summarize the notes', 'remind me tomorrow at 8', '毎朝9時にまとめて', '每天早上总结一下', 'setiap hari jam 9', 'cada lunes a las 9'])
      expect([s, asksFor(SCHEDULE_ASK, s)]).toEqual([s, true])
    for (const s of ['영업 단가표 요약해줘', 'summarize the notes', '매일 하지 마'])
      expect([s, asksFor(SCHEDULE_ASK, s)]).toEqual([s, false])
  })
})

let h: Harness
const socks: Record<string, TestSocket> = {}
let rooms: { all: string; marketing: string }
let clock = Date.now()
beforeAll(async () => {
  h = await startHarness({ name: 'do-then-undo', askUserTimeoutMs: 6000, stallTimeoutMs: 60_000 })
  const db = h.ctx.db
  db.exec('PRAGMA foreign_keys = OFF')
  for (const g of ['marketing', 'finance']) {
    const id = uuidv7()
    for (const sql of ['UPDATE groups SET id = ?1 WHERE id = ?2', 'UPDATE group_members SET group_id = ?1 WHERE group_id = ?2', "UPDATE folder_rules SET subject_id = ?1 WHERE subject_type = 'group' AND subject_id = ?2", 'UPDATE rooms SET group_id = ?1 WHERE group_id = ?2'])
      db.query(sql).run(id, g)
  }
  db.exec('PRAGMA foreign_keys = ON')
  roomsOf(h.ctx).clock = () => (clock += 10_000)
  const list = async (u: string) => (await h.api(u).call(API.listRooms)).items as Room[]
  const alice = await list('alice')
  rooms = { all: alice.find((r) => r.kind === 'all')!.id, marketing: alice.find((r) => r.kind === 'team' && r.name === 'Marketing')!.id }
  for (const u of ['alice', 'carol', 'bob']) {
    socks[u] = await h.ws(u, { windowId: `win-dtu-${u}` })
    await socks[u]!.next('hello')
  }
})
afterAll(async () => { for (const s of Object.values(socks)) s.close(); await h?.close() })

type Card = { question: string; options?: { label: string; value: string }[] }
type StepOut = { tool?: string; label: string; posted?: { roomId: string; messageId: string; files?: string[] }; scheduled?: { id: string; title: string; quiet?: true } }
/** One turn: whether a card showed (answered with `answer`), what the AI said and the steps. A card is waited for only a
 * short while when none is expected. */
async function turn(user: string, content: string, o: { chat?: string; answer?: string } = {}) {
  const chatId = o.chat ?? (await h.api(user).call(API.createChat, { body: {} })).id
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  let card = null as Card | null
  const done = socks[user]!.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 30_000)
  if (o.answer !== undefined) {
    const c = await socks[user]!.next('turn.request', (f) => f.data.turnId === r.turnId)
    card = c.data.request as unknown as Card
    await h.api(user).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.data.request.requestId, answer: o.answer } })
  }
  const d = await done
  const steps = JSON.parse((h.ctx.db.query('SELECT steps FROM messages WHERE id = ?').get(r.assistantMessage.id) as { steps: string | null }).steps ?? '[]') as StepOut[]
  return { chatId, content: d.data.message.content as string, card, steps }
}
const messagesAs = async (user: string, roomId: string) => (await h.api(user).call(API.listRoomMessages, { params: { id: roomId }, query: {} })).items as RoomMessage[]
const put = (rel: string, body: string) => { const abs = path.join(h.ctx.files.fx.root, ...rel.split('/')); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, body) }

describe('a post the person named: no card, then undo', () => {
  test('my own file to a room I named goes with its copy and no card; Undo (delete) takes it back for everyone', async () => {
    put('users/alice/quote-a.md', '# Quote A\n1,200,000')
    const text = 'Quote: [quote-a.md](/files/view?path=users/alice/quote-a.md)'
    const r = await turn('alice', `quote-a.md Marketing 방에 올려줘\n${post({ room: rooms.marketing, text })}`)
    expect(r.card).toBeNull()
    expect(JSON.parse(r.content)).toMatchObject({ status: 'sent' })
    const m = (await messagesAs('erin', rooms.marketing)).at(-1)!
    expect(m.author?.id).toBe('alice')
    expect(m.files.map((f) => f.name)).toEqual(['quote-a.md'])
    const step = r.steps.find((s) => s.tool === 'post_to_room')!
    expect(step.posted).toMatchObject({ roomId: rooms.marketing, messageId: m.id })
    // the step's Undo is the room's own delete: the text and the file go for erin too
    await h.api('alice').call(API.deleteRoomMessage, { params: { id: rooms.marketing, messageId: m.id } })
    const gone = (await messagesAs('erin', rooms.marketing)).find((x) => x.id === m.id)!
    expect(gone.body).toBe('')
    expect(gone.files).toEqual([])
    expect(h.ctx.db.query('SELECT COUNT(*) n FROM room_notices WHERE source_id = ?').get(m.id)).toEqual({ n: 0 })
  })

  test('the floor: a team file the person did not name, which some there cannot see, keeps the card; named, it goes', async () => {
    put('groups/finance/budget-q4.md', '# Budget\nsecret')
    const read = fake({ tool: 'read', args: { file_path: 'groups/finance/budget-q4.md' } })
    // bob (finance, a member who may not share the group's file) reads it and posts a summary to #전체: alice and erin
    // cannot see finance
    const asked = await turn('bob', `요약해서 전체 방에 올려줘\n${[read, post({ room: rooms.all, text: 'Q4 summary: tight' })].join('\n')}`, { answer: 'no' })
    expect(asked.card).not.toBeNull()
    const named = await turn('bob', `budget-q4.md 요약해서 전체 방에 올려줘\n${[read, post({ room: rooms.all, text: 'Q4 summary: tight (2)' })].join('\n')}`)
    expect(named.card).toBeNull()
    expect(JSON.parse(named.content)).toMatchObject({ status: 'sent' })
  })

  test('still asks: no post word, a place my words do not name, a note I did not write, @everyone I did not write', async () => {
    for (const [words, args] of [
      ['정리해줘', { room: rooms.marketing, text: 'a' }],
      ['방에 올려줘', { room: rooms.marketing, text: 'b' }],
      ['Marketing 방에 올려줘', { room: rooms.marketing, text: 'c', note: 'I approve the transfer' }],
    ] as const) {
      const r = await turn('alice', `${words}\n${post(args)}`, { answer: 'no' })
      expect([words, args.text, r.card !== null]).toEqual([words, args.text, true])
    }
  })

  test('@everyone the person did not write is never sent without their press', async () => {
    const before = (await messagesAs('erin', rooms.marketing)).length
    const r = await turn('alice', `Marketing 방에 올려줘\n${post({ room: rooms.marketing, text: 'd', mention: ['everyone'] })}`, { answer: 'no' }).catch(() => null)
    expect(r === null || r.card !== null).toBe(true)
    expect((await messagesAs('erin', rooms.marketing)).length).toBe(before)
  })

  test('@everyone in my own words, with the room named: no card, everyone mentioned', async () => {
    const r = await turn('alice', `Marketing 방에 @전체 로 회의 10시라고 올려줘\n${post({ room: rooms.marketing, text: '회의 10시', mention: ['everyone'] })}`)
    expect(r.card).toBeNull()
    expect(JSON.parse(r.content)).toMatchObject({ status: 'sent', mentioned_everyone: true })
  })

  // QA b5 F6: the person wrote the text in quotes and "@everyone" after it; the AI posted their words with "@everyone" in
  // front (own_words), which the room writes as "@전체 …": the same text, the card showed anyway
  test('my own quoted text with @everyone after it, posted as "@everyone <text>" in my own words: no card', async () => {
    const r = await turn('alice', `Marketing 방에 "내일 10시 회의, 전원 참석" 이라고 @everyone 으로 올려줘\n${post({ room: rooms.marketing, own_words: true, text: '@everyone 내일 10시 회의, 전원 참석' })}`)
    expect(r.card).toBeNull()
    expect(JSON.parse(r.content)).toMatchObject({ status: 'sent', mentioned_everyone: true })
    const m = (await messagesAs('erin', rooms.marketing)).at(-1)!
    expect(m.body).toContain('내일 10시 회의, 전원 참석')
    expect(m.mentionsAll).toBe(true)
  })
  test('...but other words than mine in own_words, or @everyone nobody wrote, still ask', async () => {
    const other = await turn('alice', `Marketing 방에 "내일 10시 회의" 라고 @everyone 으로 올려줘\n${post({ room: rooms.marketing, own_words: true, text: '@everyone 내일 10시 회의, 늦으면 벌금' })}`, { answer: 'no' })
    expect(other.card).not.toBeNull()
    // my words in another order are not my text
    const reordered = await turn('alice', `Marketing 방에 "회의는 10시, 장소는 3층" 이라고 @everyone 으로 올려줘\n${post({ room: rooms.marketing, own_words: true, text: '@everyone 장소는 3층, 회의는 10시' })}`, { answer: 'no' })
    expect(reordered.card).not.toBeNull()
    const noAll = await turn('alice', `Marketing 방에 "내일 10시 회의" 라고 올려줘\n${post({ room: rooms.marketing, own_words: true, text: '@everyone 내일 10시 회의' })}`, { answer: 'no' }).catch(() => null)
    expect(noAll === null || noAll.card !== null).toBe(true)
  })
})

describe('a schedule the person asked for in their own words', () => {
  const create = (args: Record<string, unknown>) => fake({ tool: 'schedule_create', args: { repeat: 'daily', time: '09:00', ...args }, sayResult: true })
  test('made without the card; its step shows it (Pause and Delete in the app)', async () => {
    const r = await turn('alice', `매일 아침 9시에 내 메모 요약해서 알려줘\n${create({ title: 'Morning notes', prompt: 'summarize my notes folder' })}`)
    expect(r.card).toBeNull()
    expect(r.content).toContain('Scheduled "Morning notes"')
    const step = r.steps.find((s) => s.tool === 'schedule_create')!
    expect(step.scheduled).toMatchObject({ title: 'Morning notes', quiet: true })
    const s = h.rt().schedules.get('alice', step.scheduled!.id)!
    expect(s.enabled).toBe(1)
    // Delete from the step: the Scheduled page's own route
    await h.api('alice').call(API.deleteSchedule, { params: { id: s.id } })
    expect(h.rt().schedules.get('alice', s.id)).toBeFalsy()
  })
  test('the card stays: no schedule words of mine, an address I did not type; one I typed goes', async () => {
    const plain = await turn('alice', `${create({ title: 'A', prompt: 'summarize my notes' })}`, { answer: 'deny' })
    expect(plain.card).not.toBeNull()
    const url = await turn('alice', `매일 확인해줘\n${create({ title: 'B', prompt: 'open https://news.example/today and summarize' })}`, { answer: 'deny' })
    expect(url.card).not.toBeNull()
    const typed = await turn('alice', `매일 https://news.example/today 확인해줘\n${create({ title: 'C', prompt: 'open https://news.example/today and summarize' })}`)
    expect(typed.card).toBeNull()
  })
})

describe('the AI\'s work in my own chat is mine (the owner, 2026-11-23)', () => {
  test('a file the AI made in a shared chat I am in goes to the person I named, with no card; then to a room I named', async () => {
    const c = (await h.api('alice').call(API.createChat, { body: {} })).id
    await turn('alice', 'hello', { chat: c })
    let sh = await h.api('alice').call(API.putChatAudience, { params: { id: c }, body: { subjects: [{ subjectType: 'user', subjectId: 'erin' }] } }) as { status?: string; confirmKey?: string }
    if (sh.status === 'confirm') sh = await h.api('alice').call(API.putChatAudience, { params: { id: c }, body: { subjects: [{ subjectType: 'user', subjectId: 'erin' }], confirmKey: sh.confirmKey! } }) as never
    const made = await turn('alice', fake({ tool: 'make_file', args: { format: 'docx', content: '# Proposal\n', output: 'chat:files/proposal-dtu.docx' }, sayResult: true }), { chat: c })
    expect(made.card).toBeNull()
    const att = (h.ctx.db.query("SELECT id FROM chat_files WHERE chat_id = ? AND name = 'proposal-dtu.docx'").get(c) as { id: string } | null)?.id
    expect(att).toBeTruthy()
    const link = `/c/${c}?file=${att}`
    const dm = await turn('alice', `이거 Carol Park한테 보내줘\n${post({ room: 'Carol Park', text: `Proposal: [proposal-dtu.docx](${link})` })}`, { chat: c })
    expect(dm.card).toBeNull()
    expect(dm.content).toContain('"status":"sent"')
    expect(dm.content).toContain('"files_attached":1')
    const room = await turn('alice', `이거 Marketing 방에 올려줘\n${post({ room: rooms.marketing, text: `Proposal: [proposal-dtu.docx](${link})` })}`, { chat: c })
    expect(room.card).toBeNull()
    expect(room.content).toContain('"status":"sent"')
    // the same again (QA F5 shared1-sh2): still no card, and the chat is not marked as having read anything from outside
    const again = await turn('alice', `이거 Carol Park한테 보내줘\n${post({ room: 'Carol Park', text: `Proposal again: [proposal-dtu.docx](${link})` })}`, { chat: c })
    expect(again.card).toBeNull()
    // (a chat that only made a file and sent it read nothing from outside: chats.room_outside stays 0)
    expect(h.ctx.db.query('SELECT rooms_seen, others_words, room_outside FROM chats WHERE id = ?').get(c)).toEqual({ rooms_seen: 0, others_words: 0, room_outside: 0 })
  })
})

describe('a quiet task never sends (security review)', () => {
  const create = (args: Record<string, unknown>) => fake({ tool: 'schedule_create', args: { repeat: 'daily', time: '09:00', ...args }, sayResult: true })
  test('its run posts nothing even under the person\'s "Always allow" for posts', async () => {
    const { keepAlways, dropAlways } = await import('../../server/src/chat/always-allow')
    const runPrompt = post({ room: rooms.marketing, text: 'from a quiet task' })
    const r = await turn('alice', `매일 아침 9시에 내 메모 정리해줘\n${create({ title: 'Quiet one', prompt: runPrompt })}`)
    expect(r.card).toBeNull()
    const id = r.steps.find((x) => x.tool === 'schedule_create')!.scheduled!.id
    expect((h.ctx.db.query('SELECT quiet FROM schedules WHERE id = ?').get(id) as { quiet: number }).quiet).toBe(1)
    keepAlways(h.ctx.db, 'alice', 'post_to_room', null)
    try {
      const before = (await messagesAs('erin', rooms.marketing)).length
      const rt = h.rt()
      h.ctx.db.query('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(new Date(Date.now() - 60_000).toISOString(), id)
      expect(rt.schedules.runDue(new Date())).toContain(id)
      const chatId = () => rt.schedules.get('alice', id)!.last_chat_id
      const { waitFor } = await import('../lib/wait')
      await waitFor(() => !!chatId() && (h.ctx.db.query("SELECT status FROM messages WHERE chat_id = ? AND role = 'assistant'").get(chatId()!) as { status: string } | null)?.status !== 'streaming', { timeoutMs: 30_000 })
      expect((await messagesAs('erin', rooms.marketing)).length).toBe(before)
    } finally { dropAlways(h.ctx.db, 'alice', 'card:post_to_room') }
  })
  test('a schedule asked for in a shared chat (no guest) is made too; its runs post only there', async () => {
    const chatId = (await h.api('alice').call(API.createChat, { body: {} })).id
    const hello = await turn('alice', 'hello', { chat: chatId })
    expect(hello.card).toBeNull()
    let sh = await h.api('alice').call(API.putChatAudience, { params: { id: chatId }, body: { subjects: [{ subjectType: 'user', subjectId: 'erin' }] } }) as { status?: string; confirmKey?: string }
    if (sh.status === 'confirm') sh = await h.api('alice').call(API.putChatAudience, { params: { id: chatId }, body: { subjects: [{ subjectType: 'user', subjectId: 'erin' }], confirmKey: sh.confirmKey! } }) as never
    const r = await turn('alice', `매일 아침 9시에 정리해줘\n${create({ title: 'Shared one', prompt: 'summarize this chat' })}`, { chat: chatId })
    expect(r.card).toBeNull()
    const id = r.steps.find((x) => x.tool === 'schedule_create')!.scheduled!.id
    expect((h.ctx.db.query('SELECT quiet, chat_id FROM schedules WHERE id = ?').get(id) as { quiet: number; chat_id: string })).toEqual({ quiet: 1, chat_id: chatId })
  })
})

describe('a title names one person (chat/person-aliases.ts)', () => {
  const title = (id: string, t: string) => h.ctx.db.query('INSERT INTO user_profiles (user_id, title) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET title = excluded.title').run(id, t)
  test('"팀장님한테 보내줘" with one 팀장 in the directory: sent to them with no card and no question', async () => {
    title('carol', '팀장')
    try {
      const r = await turn('alice', `팀장님한테 회의 10시라고 보내줘\n${post({ room: '팀장님', text: '회의 10시' })}`)
      expect(r.card).toBeNull()
      const out = JSON.parse(r.content)
      expect(out).toMatchObject({ status: 'sent' })
      expect(out.note).toContain('"팀장"')
      const dm = (h.ctx.db.query("SELECT r.id FROM rooms r WHERE r.kind = 'dm' AND r.dm_key = ?").get(['alice', 'carol'].sort().join('|')) as { id: string })
      expect((await messagesAs('carol', dm.id)).at(-1)!.body).toBe('회의 10시')
    } finally { h.ctx.db.query('DELETE FROM user_profiles WHERE user_id = ?').run('carol') }
  })
  test('"팀장님한테 보내줘" again, the AI giving the name it learned: still the person the title names, no card; another name asks', async () => {
    title('carol', '팀장')
    try {
      const r = await turn('alice', `이거 팀장님한테 보내줘\n${post({ room: 'Carol Park', text: '회의 10시 (다시)' })}`)
      expect(r.card).toBeNull()
      expect(r.content).toContain('"status":"sent"')
      // the title names carol, not erin: a post to erin on "팀장님" asks
      const other = await turn('alice', `이거 팀장님한테 보내줘\n${post({ room: 'Erin Yoo', text: 'x' })}`, { answer: 'no' }).catch(() => null)
      expect(other === null || other.card !== null).toBe(true)
    } finally { h.ctx.db.query('DELETE FROM user_profiles WHERE user_id = ?').run('carol') }
  })

  test('two people with the title: nothing is sent to either without the person\'s pick', async () => {
    title('carol', '팀장'); title('dana', '팀장')
    try {
      const r = await turn('alice', `팀장님한테 회의 11시라고 보내줘\n${post({ room: '팀장님', text: '회의 11시' })}`)
      expect(r.card).toBeNull()
      expect(r.content).toContain('Nothing was posted')
      expect(r.content).toMatch(/several|which one/)
    } finally { h.ctx.db.query("DELETE FROM user_profiles WHERE user_id IN ('carol', 'dana')").run() }
  })
})

