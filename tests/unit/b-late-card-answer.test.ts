// A card answered after its answer ended runs exactly the waiting call, as it was asked
// (docs/decisions/20261122-late-card-answer-resumes.md). QA of #403: in a shared chat the share card waited, the person
// pressed it later, and the call ran again against the answer message ("이번만 허용"), which names no file: the share was
// refused and "항상 허용" was never kept. Now the call's checks read the asking turn; a connector's and a room post's
// cards wait the same way; a no runs nothing; a typed message keeps the card (the AI points to it); a card that reads
// differently now asks again with one line first; a call with two cards asks each once. With the fake engine through
// the real launcher and gate, safety cards waiting after the answer (as in production).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type Message, type Room, type TurnRequest } from '@mycel/shared/api'
import { uuidv7 } from '@mycel/shared'
import fs from 'node:fs'
import path from 'node:path'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { waitFor } from '../lib/wait'
import { FakeServices, MCP_KEY } from '../lib/fake-services'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { CONNECTION_RESULT, FIND_TOOLS } from '../../server/src/integrations/connections/tools'
import { NOT_LATER } from '../../server/src/chat/tools'
import { CHANGED_MARK, declined, sameCard } from '../../server/src/chat/open-questions'
import { ALWAYS_VALUE } from '../../server/src/chat/always-allow'
import { tr } from '../../server/src/chat/i18n'
import { updateTeamSettings } from '../../server/src/admin/settings'

setDefaultTimeout(90_000)

const cm = () => 'cm-' + crypto.randomUUID()
// the fake engine's directives with their strings as JSON escapes: the person's own words are only what the test
// writes around them
const opaque = (j: string) => j.replace(/"(?:[^"\\]|\\.)*"/g, (q) => q.replace(/\\.|[\p{L}\p{N}]/gu, (c) => (c.length > 1 ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)))
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + opaque(JSON.stringify(d))).join('\n')
const MINE_WRITE = 'my_alicemail__create_task'

let h: Harness, svc: FakeServices
const ws: Record<string, TestSocket> = {}
let projectId = '', teamRoom = ''
const db = () => h.ctx.db
const put = (rel: string, body = 'x\n') => { const abs = path.join(h.ctx.files.fx.root, ...rel.split('/')); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, body) }

beforeAll(async () => {
  h = await startHarness({ name: 'b-late-card-answer', askUserTimeoutMs: 1500, stallTimeoutMs: 60_000, safetyCardsWait: true })
  // the contract's group ids (and a team room's groupId) are UUIDv7; the fixture's are short
  db().exec('PRAGMA foreign_keys = OFF')
  for (const g of ['marketing', 'finance']) {
    const id = uuidv7()
    for (const sql of ['UPDATE groups SET id = ?1 WHERE id = ?2', 'UPDATE group_members SET group_id = ?1 WHERE group_id = ?2', "UPDATE folder_rules SET subject_id = ?1 WHERE subject_type = 'group' AND subject_id = ?2", 'UPDATE rooms SET group_id = ?1 WHERE group_id = ?2'])
      db().query(sql).run(id, g)
  }
  db().exec('PRAGMA foreign_keys = ON')
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u, { windowId: `win-late-${u}` }); await ws[u]!.next('hello') }
  projectId = (await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })).id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
  teamRoom = ((await h.api('alice').call(API.listRooms)).items as Room[]).find((r) => r.kind === 'team')!.id
  svc = new FakeServices()
  integrationsOf(h.ctx, { net: svc.net() })
  const mine = await h.api('alice').call(API.createIntegration, { body: { kind: 'mcp', name: 'Alice Mail', url: `${svc.base}/mcp-key`, auth: 'bearer', secret: MCP_KEY, writePolicy: 'ask' } as never })
  expect(mine.status).toBe('connected')
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); svc?.stop(); await h?.close() })

const ownChat = async () => (await h.api('alice').call(API.createChat, { body: {} })).id as string
const sharedChat = async () => (await h.api('alice').call(API.createChat, { body: { projectId } })).id as string
const doneOf = async (messageId: string) => (await ws.alice!.next('message.done', (f) => f.data.messageId === messageId, 40_000)).data.message as Message
const post = (turnId: string, requestId: string, answer: unknown) =>
  h.req('alice', `/api/turns/${turnId}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'ask_user', requestId, answer }) })
const openCards = (chatId: string) => (db().query('SELECT request_id, call_tool FROM open_questions WHERE chat_id = ? AND answer IS NULL').all(chatId) as { request_id: string; call_tool: string | null }[])
const cardsOf = (turnId: string) => ws.alice!.frames.filter((f) => f.type === 'turn.request' && (f as { data: { turnId?: string } }).data.turnId === turnId)
  .map((f) => (f as unknown as { data: { request: Extract<TurnRequest, { kind: 'ask_user' }> } }).data.request)
const events = (turnId: string) => db().query('SELECT tool, summary FROM tool_events WHERE turn_id = ? ORDER BY id').all(turnId) as { tool: string; summary: string }[]

/** Ask: the card opens, the answer ends with it open (the call did nothing), the chat is idle */
async function askAndWait(chatId: string, content: string) {
  const r = await h.api('alice').call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const card = (await ws.alice!.next('turn.request', (f) => f.data.turnId === r.turnId, 20_000)).data.request as Extract<TurnRequest, { kind: 'ask_user' }>
  const done = await doneOf(r.assistantMessage.id)
  expect(JSON.parse(done.content)).toMatchObject({ waiting_for_user: true })
  expect(await waitFor(() => h.rt().runState(chatId) === 'idle', { timeoutMs: 10_000 })).toBe(true)
  return { turnId: r.turnId as string, answerId: r.assistantMessage.id as string, card }
}
/** the turn a press started: its user message and finished answer */
async function nextTurn(chatId: string, parentId: string) {
  const u = await ws.alice!.next('message.created', (f) => f.data.chatId === chatId && f.data.message.parentId === parentId && f.data.message.role === 'user', 20_000)
  const a = await ws.alice!.next('message.created', (f) => f.data.chatId === chatId && f.data.message.parentId === u.data.message.id, 20_000)
  const done = await doneOf(a.data.message.id)
  await waitFor(() => h.rt().runState(chatId) === 'idle', { timeoutMs: 10_000 })
  return { user: u.data.message as Message, done, turnId: a.data.message.turnId as string }
}

describe('a share card in a shared chat (QA of #403)', () => {
  test('pressed late with "Always allow": the file the asker named is shared, and Always allow is kept for good', async () => {
    put('users/alice/QA-late/ledger-1.txt', 'ledger')
    const chatId = await sharedChat()
    const w = await askAndWait(chatId, `send ledger-1.txt to Bob Lee\n${fake({ tool: 'share_with_person', args: { paths: ['users/alice/QA-late/ledger-1.txt'], people: ['Bob Lee'] }, sayResult: true })}`)
    expect(w.card.options!.map((o) => o.value)).toEqual(['share', ALWAYS_VALUE, 'no'])
    expect(db().query("SELECT COUNT(*) n FROM file_shares WHERE path = 'users/alice/QA-late/ledger-1.txt'").get()).toEqual({ n: 0 })
    // past the old wait: still open
    await Bun.sleep(1800)
    expect(openCards(chatId).map((c) => c.request_id)).toEqual([w.card.requestId])
    expect((await post(w.turnId, w.card.requestId, ALWAYS_VALUE)).status).toBe(204)
    const next = await nextTurn(chatId, w.answerId)
    expect(next.done.status).toBe('done')
    // shared, once, in the press's turn; no card again
    expect(db().query("SELECT COUNT(*) n FROM file_shares WHERE path = 'users/alice/QA-late/ledger-1.txt'").get()).toEqual({ n: 1 })
    expect(events(next.turnId).filter((e) => e.tool === 'share_with_person').map((e) => e.summary)).toEqual([expect.stringContaining('shared 1 files')])
    expect(cardsOf(next.turnId)).toEqual([])
    expect(db().query("SELECT COUNT(*) n FROM card_always_allow WHERE user_id = 'alice' AND kind = 'share_files'").get()).toEqual({ n: 1 })
    db().query("DELETE FROM card_always_allow WHERE user_id = 'alice'").run()
  })
})

describe('Always allow pressed on a waiting card', () => {
  const always = () => (db().query("SELECT COUNT(*) n FROM card_always_allow WHERE user_id = 'alice' AND kind = 'share_files'").get() as { n: number }).n
  const waitingShare = async (name: string) => {
    put(`users/alice/QA-late/${name}`, 'x')
    // (a send word is no ask to share a file: the card shows, docs/decisions/20261123-do-then-undo.md)
    const chatId = await sharedChat()
    const w = await askAndWait(chatId, `send ${name} to Bob Lee\n${fake({ tool: 'share_with_person', args: { paths: [`users/alice/QA-late/${name}`], people: ['Bob Lee'] }, sayResult: true })}`)
    return { chatId, w }
  }
  test('kept even when the run ends before its card (the file is gone now): the person\'s choice for that kind', async () => {
    db().query("DELETE FROM card_always_allow WHERE user_id = 'alice'").run()
    const { chatId, w } = await waitingShare('gone-later.txt')
    fs.rmSync(path.join(h.ctx.files.fx.root, 'users/alice/QA-late/gone-later.txt'))
    expect((await post(w.turnId, w.card.requestId, ALWAYS_VALUE)).status).toBe(204)
    const next = await nextTurn(chatId, w.answerId)
    expect(cardsOf(next.turnId)).toEqual([])
    expect(always()).toBe(1)
    db().query("DELETE FROM card_always_allow WHERE user_id = 'alice'").run()
  })

  // one Always (docs/decisions/20261123-one-always-allow.md, replacing #412's guest guard): a guest in the room of a ✦
  // side chat does not stop the person's Always from being kept
  test('kept in a side chat whose room has a guest too', async () => {
    db().query("DELETE FROM card_always_allow WHERE user_id = 'alice'").run()
    put('users/alice/QA-late/side-guest.txt', 'x')
    const chatId = await ownChat()
    db().query('UPDATE chats SET side_room_id = ? WHERE id = ?').run(teamRoom, chatId)
    db().query("INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at) VALUES (?, 'bob', ?)").run(teamRoom, new Date().toISOString())
    // (a side chat holds the room's words: the asker names the file, and the card asks)
    const w = await askAndWait(chatId, `share side-guest.txt with Bob Lee\n${fake({ tool: 'share_with_person', args: { paths: ['users/alice/QA-late/side-guest.txt'], people: ['Bob Lee'] }, sayResult: true })}`)
    expect(w.card.options!.map((o) => o.value)).toContain(ALWAYS_VALUE)
    fs.rmSync(path.join(h.ctx.files.fx.root, 'users/alice/QA-late/side-guest.txt'))
    db().query("UPDATE users SET guest = 1 WHERE id = 'bob'").run()
    try {
      expect((await post(w.turnId, w.card.requestId, ALWAYS_VALUE)).status).toBe(204)
      await nextTurn(chatId, w.answerId)
      expect(always()).toBe(1)
    } finally { db().query("UPDATE users SET guest = 0 WHERE id = 'bob'").run() }
  })

  test('not kept when the team turned Always allow off meanwhile', async () => {
    db().query("DELETE FROM card_always_allow WHERE user_id = 'alice'").run()
    const { chatId, w } = await waitingShare('switch-off.txt')
    fs.rmSync(path.join(h.ctx.files.fx.root, 'users/alice/QA-late/switch-off.txt'))
    updateTeamSettings(db(), { roomAlwaysAllow: false })
    try {
      expect((await post(w.turnId, w.card.requestId, ALWAYS_VALUE)).status).toBe(204)
      await nextTurn(chatId, w.answerId)
      expect(always()).toBe(0)
    } finally { updateTeamSettings(db(), { roomAlwaysAllow: true }) }
  })
})

describe('a connector card', () => {
  test('a write to the person\'s own connection waits after the answer (nothing sent); the late press sends it once, with its arguments', async () => {
    const chatId = await ownChat()
    const n = svc.calls.filter((c) => c.name === 'create_task').length
    const w = await askAndWait(chatId, fake({ tool: MINE_WRITE, args: { title: 'late task' }, sayResult: true }))
    expect(w.card.options!.map((o) => o.value)).toContain('allow')
    expect(svc.calls.filter((c) => c.name === 'create_task').length).toBe(n)
    await Bun.sleep(1800)
    expect(openCards(chatId)).toEqual([{ request_id: w.card.requestId, call_tool: MINE_WRITE }])
    expect((await post(w.turnId, w.card.requestId, 'allow')).status).toBe(204)
    const next = await nextTurn(chatId, w.answerId)
    expect(next.done.status).toBe('done')
    const made = svc.calls.filter((c) => c.name === 'create_task')
    expect(made.length).toBe(n + 1)
    expect(made.at(-1)!.args).toMatchObject({ title: 'late task' })
    expect(cardsOf(next.turnId)).toEqual([])
  })

  test('in a shared chat, two cards (the shared answer, then the write): each is asked once over two presses', async () => {
    const chatId = await sharedChat()
    const n = svc.calls.filter((c) => c.name === 'create_task').length
    const w = await askAndWait(chatId, fake({ tool: MINE_WRITE, args: { title: 'two cards' }, sayResult: true }))
    const first = w.card
    expect((await post(w.turnId, first.requestId, first.options![0]!.value)).status).toBe(204)
    const second = await nextTurn(chatId, w.answerId)
    const asked = cardsOf(second.turnId)
    expect(asked.length).toBe(1)
    expect(sameCard(first, asked[0]!)).toBe(false)
    expect(svc.calls.filter((c) => c.name === 'create_task').length).toBe(n)
    expect((await post(second.turnId, asked[0]!.requestId, 'allow')).status).toBe(204)
    const third = await nextTurn(chatId, second.done.id)
    // the first card took its earlier answer: nothing asked again, the task made once
    expect(cardsOf(third.turnId)).toEqual([])
    expect(svc.calls.filter((c) => c.name === 'create_task').length).toBe(n + 1)
  })
})

describe('a room post card', () => {
  test('waits after the answer (nothing posted); the late press posts it once', async () => {
    const chatId = await ownChat()
    const count = () => (db().query("SELECT COUNT(*) n FROM room_messages WHERE room_id = ? AND body LIKE '%late post body%'").get(teamRoom) as { n: number }).n
    const w = await askAndWait(chatId, `post it to the team room\n${fake({ tool: 'post_to_room', args: { room: teamRoom, text: 'late post body' }, sayResult: true })}`)
    expect(count()).toBe(0)
    await Bun.sleep(1800)
    expect(openCards(chatId).map((c) => c.call_tool)).toEqual(['post_to_room'])
    expect((await post(w.turnId, w.card.requestId, w.card.options![0]!.value)).status).toBe(204)
    const next = await nextTurn(chatId, w.answerId)
    expect(next.done.status).toBe('done')
    expect(count()).toBe(1)
    expect(cardsOf(next.turnId)).toEqual([])
  })

  // QA b5 F12: in mode (a) a late "보내기" on an @everyone own-words post card seemed to post nothing in 2 of 3 runs.
  // The press itself posts it, once, with everyone mentioned (the QA script's button lookup took the chat box's own
  // "보내기" button, which has the same name: it never pressed the card's)
  test('an @everyone post in the person\'s own words, pressed late with Send: posted once, everyone mentioned', async () => {
    const chatId = await ownChat()
    const count = () => (db().query("SELECT COUNT(*) n FROM room_messages WHERE room_id = ? AND body LIKE '%dinner vote please%' AND mentions_all = 1").get(teamRoom) as { n: number }).n
    const w = await askAndWait(chatId, `post "dinner vote please" there with @everyone\n${fake({ tool: 'post_to_room', args: { room: teamRoom, own_words: true, text: '@everyone dinner vote please' }, sayResult: true })}`)
    expect(w.card.options!.map((o) => o.value)).toEqual(['send', ALWAYS_VALUE, 'no'])
    expect(count()).toBe(0)
    await Bun.sleep(1800)
    expect((await post(w.turnId, w.card.requestId, 'send')).status).toBe(204)
    const next = await nextTurn(chatId, w.answerId)
    expect(next.done.status).toBe('done')
    expect(cardsOf(next.turnId)).toEqual([])
    expect(count()).toBe(1)
  })

  // QA of #414 (qa.trina.app): the answer read b4-note.txt and sent b4-sum.pdf to a teammate; the first card said
  // "(my files)", the run after the press "(1 file in my files)" (the same source, now counted from the answer's saved
  // list), and the card was asked again with "Something changed". The same post to the same person with the same file
  // takes the press
  test('a source counted file by file after the press is the same card: the press sends it, no second card', async () => {
    put('users/alice/QA-late/note.txt', 'alpha 3, beta 5\n')
    put('users/alice/QA-late/sum.pdf', '%PDF-1.4 sum\n')
    const chatId = await ownChat()
    const dmHas = () => (db().query("SELECT COUNT(*) n FROM room_messages m JOIN rooms r ON r.id = m.room_id WHERE r.kind = 'dm' AND m.author_id = 'alice' AND m.body LIKE '%sum of the note%'").get() as { n: number }).n
    const text = 'The sum of the note is 8: [sum.pdf](/files/view?path=users%2Falice%2FQA-late%2Fsum.pdf)'
    // (the recipient not named in the person's own words, so the post card shows: a named one from their own folder
    // goes without a card since docs/decisions/20261123-do-then-undo.md)
    const w = await askAndWait(chatId, `Send the sum to my teammate\n${fake({ tool: 'read', args: { file_path: 'users/alice/QA-late/note.txt' } }, { tool: 'post_to_room', args: { room: 'Bob Lee', text }, sayResult: true })}`)
    expect(w.card.question).toContain("can't see some of the sources")
    expect(dmHas()).toBe(0)
    await Bun.sleep(1800)
    expect((await post(w.turnId, w.card.requestId, w.card.options![0]!.value)).status).toBe(204)
    const next = await nextTurn(chatId, w.answerId)
    expect(next.done.status).toBe('done')
    expect(cardsOf(next.turnId)).toEqual([])
    expect(dmHas()).toBe(1)
  })
})

describe('never a free-text message that loses the target', () => {
  test('a typed message keeps the card: the AI is told it waits, and a later press runs the call from the chat\'s newest answer', async () => {
    put('users/alice/QA-late/typed.txt')
    const chatId = await ownChat()
    const w = await askAndWait(chatId, fake({ tool: 'delete_files', args: { paths: ['users/alice/QA-late/typed.txt'] }, sayResult: true }))
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chatId }, body: { content: 'go ahead\n' + fake({ echo: 'message' }), clientMessageId: cm(), attachmentIds: [] } })
    const typed = await doneOf(r.assistantMessage.id)
    await waitFor(() => h.rt().runState(chatId) === 'idle', { timeoutMs: 10_000 })
    expect(typed.content).toContain('<waiting_card>')
    expect(typed.content).toContain('delete_files')
    // the card stays (no close event for it) and still answers
    expect(openCards(chatId).map((c) => c.request_id)).toEqual([w.card.requestId])
    expect(ws.alice!.frames.some((f) => f.type === 'turn.request.closed' && (f as { data: { requestId?: string } }).data.requestId === w.card.requestId)).toBe(false)
    expect(fs.existsSync(path.join(h.ctx.files.fx.root, 'users/alice/QA-late/typed.txt'))).toBe(true)
    expect((await post(w.turnId, w.card.requestId, 'trash')).status).toBe(204)
    const next = await nextTurn(chatId, typed.id)
    expect(next.done.status).toBe('done')
    expect(fs.existsSync(path.join(h.ctx.files.fx.root, 'users/alice/QA-late/typed.txt'))).toBe(false)
    // the turn the press started is not told of its own card
    expect(openCards(chatId)).toEqual([])
  })

  test('a regenerate of the asking answer goes on without it: the card closes (an edit or another branch the same)', async () => {
    put('users/alice/QA-late/regen.txt')
    const chatId = await ownChat()
    const w = await askAndWait(chatId, fake({ tool: 'delete_files', args: { paths: ['users/alice/QA-late/regen.txt'] }, sayResult: true }))
    const re = await h.api('alice').call(API.regenerate, { params: { id: chatId, messageId: w.answerId }, body: {} })
    await ws.alice!.next('turn.request.closed', (f) => f.data.requestId === w.card.requestId, 20_000)
    // (the regenerate asks again with its own card, which waits)
    await waitFor(() => h.rt().runState(chatId) === 'idle', { timeoutMs: 20_000 })
    expect(openCards(chatId).map((c) => c.request_id)).not.toContain(w.card.requestId)
    expect((await post(w.turnId, w.card.requestId, 'trash')).status).toBe(409)
    expect(re.turnId).toBeTruthy()
  })

  test('a card that reads differently now asks again, its first line saying so; that card waits the same way', async () => {
    put('users/alice/QA-late/changed.txt')
    const chatId = await ownChat()
    const w = await askAndWait(chatId, fake({ tool: 'delete_files', args: { paths: ['users/alice/QA-late/changed.txt'] }, sayResult: true }))
    // what the person saw differs from what the call asks now (as if the file changed meanwhile)
    const row = db().query('SELECT request FROM open_questions WHERE request_id = ?').get(w.card.requestId) as { request: string }
    db().query('UPDATE open_questions SET request = ? WHERE request_id = ?').run(JSON.stringify({ ...JSON.parse(row.request), question: 'Move 3 files to the trash?' }), w.card.requestId)
    expect((await post(w.turnId, w.card.requestId, 'trash')).status).toBe(204)
    const next = await nextTurn(chatId, w.answerId)
    expect(fs.existsSync(path.join(h.ctx.files.fx.root, 'users/alice/QA-late/changed.txt'))).toBe(true)
    const again = cardsOf(next.turnId)
    expect(again.length).toBe(1)
    expect(again[0]!.question.startsWith(CHANGED_MARK + 'Something changed since you answered.')).toBe(true)
    expect(openCards(chatId).map((c) => c.request_id)).toEqual([again[0]!.requestId])
    // one press: done
    expect((await post(next.turnId, again[0]!.requestId, 'trash')).status).toBe(204)
    const last = await nextTurn(chatId, next.done.id)
    expect(last.done.status).toBe('done')
    expect(fs.existsSync(path.join(h.ctx.files.fx.root, 'users/alice/QA-late/changed.txt'))).toBe(false)
  })
})

describe('the rules, alone', () => {
  test('a no is the last option of a server card, Skip, or a site\'s deny; a yes is not', () => {
    const card: TurnRequest = { kind: 'ask_user', origin: 'server', requestId: 'a', question: 'Share?', options: [{ label: 'Share', value: 'share' }, { label: 'Always', value: ALWAYS_VALUE }, { label: 'No', value: 'no' }] }
    expect(declined(card, 'no')).toBe(true)
    expect(declined(card, ['no'])).toBe(true)
    expect(declined(card, null)).toBe(true)
    expect(declined(card, 'share')).toBe(false)
    expect(declined(card, ALWAYS_VALUE)).toBe(false)
    expect(declined({ kind: 'browser_site', requestId: 'b', url: 'http://10.0.0.1/', host: '10.0.0.1' }, 'deny')).toBe(true)
    expect(declined({ kind: 'browser_site', requestId: 'b', url: 'http://10.0.0.1/', host: '10.0.0.1' }, 'once')).toBe(false)
  })

  test('the same card: a reason line ("rooms were read here") fewer is the same card; any other paragraph fewer, a new one or other words are not', () => {
    const why = tr('roomsSeenWhy', 'en')
    const base: TurnRequest = { kind: 'ask_user', origin: 'server', requestId: 'a', question: `${why}\n\nPractice mode: nothing really goes out.\n\nShare 1 file with Bob?\n\nThey can view it.`, options: [{ label: 'Share', value: 'share' }, { label: 'No', value: 'no' }] }
    const q = (question: string) => ({ ...base, requestId: 'b', question })
    expect(sameCard(base, q('Practice mode: nothing really goes out.\n\nShare 1 file with Bob?\n\nThey can view it.'))).toBe(true)
    expect(sameCard(base, q(`${CHANGED_MARK}Something changed.\n\n${base.question}`))).toBe(true)
    // a reason line more, a practice line fewer, another person, the last line gone: other cards
    expect(sameCard(q('Practice mode: nothing really goes out.\n\nShare 1 file with Bob?\n\nThey can view it.'), base)).toBe(false)
    expect(sameCard(base, q(`${why}\n\nShare 1 file with Bob?\n\nThey can view it.`))).toBe(false)
    expect(sameCard(base, q(`${why}\n\nPractice mode: nothing really goes out.\n\nShare 1 file with Carol?\n\nThey can view it.`))).toBe(false)
    expect(sameCard(base, q(`${why}\n\nPractice mode: nothing really goes out.\n\nShare 1 file with Bob?`))).toBe(false)
  })

  test('the same card: a source place with or without its file count is the same; another place or another number of people is not', () => {
    // the two cards of the QA run of #414 (qa.trina.app), word for word
    const card = (line: string): Extract<TurnRequest, { kind: 'ask_user' }> => ({ kind: 'ask_user', origin: 'server', requestId: crypto.randomUUID(), question: `QA Admin님과의 1:1 대화(2명)에 보낼까요?\n\nQA Admin 님은 아직 파일을 열 수 없어요. 보내면 함께 공유돼요.\n${line}`, options: [{ label: '보내기', value: 'send_files' }, { label: '보내지 않기', value: 'no' }] })
    const pressed = card('1명은 이 내용의 일부 출처(내 파일)를 볼 수 없어요.')
    expect(sameCard(pressed, card('1명은 이 내용의 일부 출처(내 파일의 파일 1개)를 볼 수 없어요.'))).toBe(true)
    expect(sameCard(card('1명은 이 내용의 일부 출처(내 파일의 파일 2개)를 볼 수 없어요.'), pressed)).toBe(true)
    expect(sameCard(pressed, card('2명은 이 내용의 일부 출처(내 파일의 파일 1개)를 볼 수 없어요.'))).toBe(false)
    expect(sameCard(pressed, card('1명은 이 내용의 일부 출처(내 파일의 파일 1개, 부서 › 영업)를 볼 수 없어요.'))).toBe(false)
    expect(sameCard(pressed, card('1명은 이 내용의 일부 출처(부서 › 영업의 파일 1개)를 볼 수 없어요.'))).toBe(false)
    // every language (English puts the count first)
    const en = (places: string): TurnRequest => ({ ...pressed, question: `Send to Bob Lee in a new 1:1 chat?\n\n1 person there can't see some of the sources of this (${places}).` })
    expect(sameCard(en('My folder, Teams › Sales'), en('1 file in My folder, 3 files in Teams › Sales'))).toBe(true)
    expect(sameCard(en('My folder'), en('1 file in Teams › Sales'))).toBe(false)
    const ja = (places: string): TurnRequest => ({ ...pressed, question: `送りますか？\n\n1人はこの内容の一部の出典（${places}）を見られません。` })
    expect(sameCard(ja('自分のフォルダー'), ja('自分のフォルダーのファイル2件'))).toBe(true)
    expect(sameCard(ja('自分のフォルダー'), ja('チーム › 営業のファイル1件'))).toBe(false)
    const es = (places: string): TurnRequest => ({ ...pressed, question: `¿Enviar?\n\n1 persona no puede ver parte de las fuentes de esto (${places}).` })
    expect(sameCard(es('Mi carpeta'), es('1 archivo en Mi carpeta'))).toBe(true)
    expect(sameCard(es('Mi carpeta'), es('2 archivos en Mi carpeta'))).toBe(true)
    expect(sameCard(es('Mi carpeta'), es('2 archivos en Ventas'))).toBe(false)
  })

  test('the connected-service tools that never wait are the provider\'s own names', () => {
    expect([...NOT_LATER].sort()).toEqual([CONNECTION_RESULT, FIND_TOOLS].sort())
  })
})
