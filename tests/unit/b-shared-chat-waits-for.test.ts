// Everyone else in a shared chat sees whose confirmation the AI is stopped on (Chat.waitsFor), for every kind of card and
// until it ends, with the fake engine through the real launcher and gate (docs/AGENTS/plan/*-shared-chat-waiting.md).
// That no card content reaches them: tests/security/shared-chat-waits-for.test.ts.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, attentionCount, markerOf, type Chat, type ServerFrame } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { waitFor } from '../lib/wait'
import { saveQuestion } from '../../server/src/chat/open-questions'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const WIN = '22222222-2222-4222-8222-222222222222'
const NAME = 'Alice Kim'

let h: Harness
let alice: TestSocket, bob: TestSocket
let projectId: string
beforeAll(async () => {
  h = await startHarness({ name: 'b-shared-chat-waits-for', askUserTimeoutMs: 1500, stallTimeoutMs: 60_000 })
  alice = await h.ws('alice', { windowId: WIN }); await alice.next('hello')
  bob = await h.ws('bob'); await bob.next('hello')
  projectId = (await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })).id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
})
afterAll(async () => { alice?.close(); bob?.close(); await h?.close() })

const newChat = () => h.api('alice').call(API.createChat, { body: { projectId } })
const send = (user: string, id: string, content: string) => h.api(user).call(API.sendMessage, { params: { id }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
const view = (user: string, id: string): Promise<Chat> => h.api(user).call(API.getChat, { params: { id } })
/** the newest chat.updated of this chat that reached bob since `from` */
const liveFor = (from: number, id: string) => bob.frames.slice(from).flatMap((f: ServerFrame) => (f.type === 'chat.updated' && f.data.chatId === id && f.data.chat ? [f.data.chat] : [])).at(-1)
const liveWaits = (from: number, id: string, name: string | undefined) => waitFor(() => { const c = liveFor(from, id); return !!c && c.waitsFor === name }, { timeoutMs: 2000 })
const idle = (id: string) => waitFor(() => !h.rt().activeTurn(id), { timeoutMs: 20_000 })
const ASK = { tool: 'ask_user', args: { question: 'Which color?', options: [{ label: 'Red', value: 'red' }, { label: 'Blue', value: 'blue' }] } }
const execOf = (turnId: string) => h.rt().execFor(turnId) as unknown as { showCard(r: unknown, o: { window?: string | null; timeoutMs: number }): Promise<unknown> }
const serverCard = (requestId: string) => ({ kind: 'ask_user', requestId, question: 'Allow?', origin: 'server', options: [{ label: 'Yes', value: 'yes' }] })

describe('the others see who the AI waits for', () => {
  test('a question kept after the answer ended: told live, kept on reload, gone once answered', async () => {
    const chat = await newChat()
    const from = bob.frames.length
    const r = await send('alice', chat.id, fake(ASK))
    const card = await alice.next('turn.request', (f) => f.data.turnId === r.turnId)
    await idle(chat.id)
    expect(await liveWaits(from, chat.id, NAME)).toBe(true)
    const seen = await view('bob', chat.id)
    expect([seen.runState, seen.waitsFor, seen.waiting, seen.shared?.answering]).toEqual(['idle', NAME, undefined, null])
    // the asker has the card and no line about themselves
    const own = await view('alice', chat.id)
    expect([own.waiting, own.waitsFor]).toEqual([true, undefined])
    const after = bob.frames.length
    await h.api('alice').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: card.data.request.requestId, answer: 'red' } })
    expect(await liveWaits(after, chat.id, undefined)).toBe(true)
    await idle(chat.id)
    expect((await view('bob', chat.id)).waitsFor).toBeUndefined()
  })

  test('a card inside a running answer: named while it waits, the running line after it times out', async () => {
    const chat = await newChat()
    const r = await send('alice', chat.id, fake({ sleep: 3500 }, { say: 'done' }))
    await waitFor(() => !!h.rt().execFor(r.turnId), { timeoutMs: 5000 })
    expect((await view('bob', chat.id)).shared?.answering).toEqual({ name: NAME })
    const from = bob.frames.length
    void execOf(r.turnId).showCard(serverCard('in-call-1'), { timeoutMs: 700 })
    expect(await liveWaits(from, chat.id, NAME)).toBe(true)
    expect((await view('bob', chat.id)).shared?.answering).toEqual({ name: NAME, waiting: true })
    const after = bob.frames.length
    expect(await waitFor(() => { const c = liveFor(after, chat.id); return !!c && !c.waitsFor }, { timeoutMs: 2000 })).toBe(true)
    expect((await view('bob', chat.id)).shared?.answering).toEqual({ name: NAME })
    await idle(chat.id)
  })

  test("a card for one desktop window: the others are told both ways, the person's own lists do not change", async () => {
    const chat = await newChat()
    const r = await send('alice', chat.id, fake({ sleep: 3500 }, { say: 'done' }))
    await waitFor(() => !!h.rt().execFor(r.turnId), { timeoutMs: 5000 })
    const from = bob.frames.length
    void execOf(r.turnId).showCard(serverCard('window-1'), { window: WIN, timeoutMs: 700 })
    expect(await liveWaits(from, chat.id, NAME)).toBe(true)
    expect((await view('alice', chat.id)).waiting).toBeUndefined()
    const after = bob.frames.length
    expect(await waitFor(() => { const c = liveFor(after, chat.id); return !!c && !c.waitsFor }, { timeoutMs: 2000 })).toBe(true)
    await idle(chat.id)
  })

  test('a stopped answer closes the wait', async () => {
    const chat = await newChat()
    const r = await send('alice', chat.id, fake({ sleep: 8000 }, { say: 'never' }))
    await waitFor(() => !!h.rt().execFor(r.turnId), { timeoutMs: 5000 })
    void execOf(r.turnId).showCard(serverCard('stop-1'), { timeoutMs: 30_000 })
    await waitFor(async () => (await view('bob', chat.id)).waitsFor === NAME, { timeoutMs: 2000 })
    const from = bob.frames.length
    await h.api('alice').call(API.stop, { params: { id: chat.id } })
    await idle(chat.id)
    expect(await waitFor(() => { const c = liveFor(from, chat.id); return !!c && !c.waitsFor }, { timeoutMs: 3000 })).toBe(true)
  })

  test("another person's answer running past a kept card names nobody wrongly", async () => {
    const chat = await newChat()
    const first = await send('alice', chat.id, fake({ say: 'one' }))
    await idle(chat.id)
    saveQuestion(h.ctx.db, { request: serverCard('kept-1') as never, chatId: chat.id, messageId: first.assistantMessage.id, turnId: first.turnId, userId: 'alice', call: { tool: 'remember', args: {}, window: null } })
    expect((await view('bob', chat.id)).waitsFor).toBe(NAME)
    const second = await send('bob', chat.id, fake({ sleep: 1500 }, { say: 'two' }))
    await waitFor(() => !!h.rt().execFor(second.turnId), { timeoutMs: 5000 })
    const forAlice = await view('alice', chat.id)
    expect(forAlice.shared?.answering).toEqual({ name: 'Bob Lee' })
    expect(forAlice.waitsFor).toBeUndefined()
    expect((await view('bob', chat.id)).waitsFor).toBeUndefined()
    await idle(chat.id)
    expect((await view('bob', chat.id)).waitsFor).toBe(NAME)
    h.ctx.db.query('DELETE FROM open_questions WHERE chat_id = ?').run(chat.id)
  })

  test('a person who no longer sees the chat holds nobody up', async () => {
    const chat = await newChat()
    const first = await send('alice', chat.id, fake({ say: 'one' }))
    await idle(chat.id)
    saveQuestion(h.ctx.db, { request: serverCard('gone-1') as never, chatId: chat.id, messageId: first.assistantMessage.id, turnId: first.turnId, userId: 'erin' })
    expect((await view('bob', chat.id)).waitsFor).toBeUndefined()
    h.ctx.db.query('DELETE FROM open_questions WHERE chat_id = ?').run(chat.id)
  })

  test('the list marks it for the others without counting it as needing them', async () => {
    const chat = await newChat()
    // bob wrote in it, so it is in his own list
    await send('bob', chat.id, fake({ say: 'hello' }))
    await idle(chat.id)
    const r = await send('alice', chat.id, fake(ASK))
    await alice.next('turn.request', (f) => f.data.turnId === r.turnId)
    await idle(chat.id)
    const seen = await view('bob', chat.id)
    const clean = { ...seen, unseen: undefined, unreadCount: undefined }
    expect(markerOf(clean)).toEqual({ kind: 'running', reason: 'someone' })
    expect(attentionCount([clean], []).n).toBe(0)
    const groups = await h.api('bob').call(API.listChatGroups, {})
    const marks = groups.projects.flatMap((p) => p.marked)
    expect(marks.find((m) => m.id === chat.id)?.waitsFor).toBe(NAME)
    h.ctx.db.query('DELETE FROM open_questions WHERE chat_id = ?').run(chat.id)
  })
})
