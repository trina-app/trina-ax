// Session markers on the server (docs/DECISIONS.md "Session markers"; the seen state itself is phone-nav's
// b-chat-seen.test.ts): how the newest finished answer ended (Chat.lastOutcome, read with Chat.unseen in one query) and
// which live changes are worth telling the person (chat.updated notify: a card that opened, an answer that ran about a
// minute or longer), never a person's stop, a server stop, a scheduled run or a question from Slack. Claude, Codex and the
// API engine alike, with the fake engine through the real launcher and gate. /seen tells only a real change. The room's
// "?" (Room.aiWaits) and the per-recipient notices of room messages are in b-rooms-markers.test.ts.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type Chat, type EngineId, type ServerFrame, type TurnRequest } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { writeApiEngine } from '../../server/src/engine/api-agent'
import { setMemberChoice } from '../../server/src/admin/engine-choice'
import { LONG_ANSWER_MS } from '../../server/src/chat/runtime'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const W1 = 'win-markers-main'
const W2 = 'win-markers-other'

let h: Harness
let main: TestSocket
let other: TestSocket
let mock: ReturnType<typeof Bun.serve>
const script: string[] = []
/** in the script: the provider answers 500 */
const FAIL = '<fail>'
/** the API engine's provider (an OpenAI-style stream): tool calls and text */
function sse(calls: { id: string; name: string; args: unknown }[], text?: string): string {
  const lines: string[] = []
  if (text) lines.push(JSON.stringify({ choices: [{ delta: { content: text } }] }))
  calls.forEach((c, i) => lines.push(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: i, id: c.id, function: { name: c.name, arguments: JSON.stringify(c.args) } }] } }] })))
  lines.push(JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
  return lines.map((l) => `data: ${l}\n\n`).join('') + 'data: [DONE]\n\n'
}

beforeAll(async () => {
  mock = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) { if (req.method === 'GET') return Response.json({ data: [{ id: 'm-1' }] }); await req.json(); const next = script.shift() ?? sse([], '(no script)'); return next === FAIL ? Response.json({ error: { message: 'provider down' } }, { status: 500 }) : new Response(next) } })
  h = await startHarness({ name: 'b-session-markers', askUserTimeoutMs: 8000, turnTimeoutMs: 60_000 })
  writeApiEngine(h.ctx.config.dataDir, { baseUrl: `http://127.0.0.1:${mock.port}/v1`, model: 'm-1', label: 'M1' })
  const confs = h.rt().engines.get()
  confs.api = { baseUrl: `http://127.0.0.1:${mock.port}/v1`, model: 'm-1', label: 'M1', key: null }
  delete confs.problems.api
  setMemberChoice(h.ctx, { mode: 'everyone', groupIds: [], userIds: [] })
  main = await h.ws('alice', { windowId: W1 })
  other = await h.ws('alice', { windowId: W2 })
  await main.next('hello')
  await other.next('hello')
})
afterAll(async () => { main?.close(); other?.close(); await h.close(); mock?.stop(true) })

const newChat = (engine?: EngineId) => h.api('alice').call(API.createChat, { body: engine ? { engine } : {} })
const listed = async (id: string): Promise<Chat | undefined> => (await h.api('alice').call(API.listChats, { query: {} })).items.find((c) => c.id === id)
type Updated = Extract<ServerFrame, { type: 'chat.updated' }>
/** chat.updated frames of a chat a socket got after `from` frames */
const updates = (s: TestSocket, chatId: string, from = 0): Updated[] => s.frames.slice(from).filter((f): f is Updated => f.type === 'chat.updated' && f.data.chatId === chatId)
const until = async (s: TestSocket, chatId: string, ok: (f: Updated) => boolean, from = 0) => {
  await waitFor(() => updates(s, chatId, from).some(ok), { timeoutMs: 15_000 })
  return updates(s, chatId, from).filter(ok).at(-1)!
}
const sendTo = (chatId: string, content: string, o: { window?: string; engine?: EngineId } = {}) =>
  h.api('alice', { window: o.window ?? W1 }).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [], ...(o.engine ? { engine: o.engine } : {}) } })
const openCard = (s: TestSocket, turnId: string) => s.next('turn.request', (f) => f.data.turnId === turnId, 15_000)
const answerCard = (turnId: string, request: TurnRequest, answer = 'ok') => h.api('alice').call(API.answerTurn, { params: { id: turnId }, body: { kind: 'ask_user', requestId: request.requestId, answer } })
/** a turn the server starts by itself for this chat (a scheduled run, a question asked in Slack) */
const serverTurn = (chatId: string, clientKind: 'schedule' | 'slack', content: string) =>
  h.rt().createTurn({ chat: h.rt().store.chatRow(chatId)!, userId: 'alice', locale: 'en', windowId: null, clientKind, engine: 'claude-code', model: null,
    user: { parentId: null, content, attachments: [], clientMessageId: cm() } })

describe('Chat.lastOutcome: how the newest finished answer ended', () => {
  test('done: unseen, no outcome; failed: "error" until seen, and seeing keeps the outcome but not unseen', async () => {
    const ok = await newChat()
    expect(ok.lastOutcome).toBeUndefined()
    await ask(h, main, 'alice', ok.id, fake({ say: 'fine' }))
    expect(await listed(ok.id)).toMatchObject({ unseen: true })
    expect((await listed(ok.id))!.lastOutcome).toBeUndefined()

    const failed = await newChat()
    const r = await ask(h, main, 'alice', failed.id, fake({ fail: 'rate limit exceeded' }))
    expect(r.done.status).toBe('error')
    expect(await listed(failed.id)).toMatchObject({ unseen: true, lastOutcome: 'error' })
    // the same on the live event every window gets, and on GET
    await until(other, failed.id, (f) => f.data.chat?.lastOutcome === 'error' && f.data.chat.unseen === true)
    expect(await h.api('alice').call(API.getChat, { params: { id: failed.id } })).toMatchObject({ unseen: true, lastOutcome: 'error' })
    const seen = await h.api('alice', { window: W1 }).call(API.markChatSeen, { params: { id: failed.id } })
    expect(seen.unseen).toBeUndefined()
    expect(seen.lastOutcome).toBe('error') // the "?" needs both: seen, it is gone
  })

  test('stopped by the person: no outcome', async () => {
    const chat = await newChat()
    const s = await sendTo(chat.id, fake({ sleep: 20_000 }))
    await waitFor(() => h.rt().runState(chat.id) === 'running', { timeoutMs: 10_000 })
    await h.api('alice').call(API.stop, { params: { id: chat.id } })
    const d = await main.next('message.done', (f) => f.data.messageId === s.assistantMessage.id, 20_000)
    expect(d.data.status).toBe('stopped')
    const c = await listed(chat.id)
    expect(c?.runState).toBe('idle')
    expect(c?.lastOutcome).toBeUndefined()
    // and no dot: the person stopped it themselves
    expect(c?.unseen).toBeUndefined()
  })

  test('paused at the per-answer limit of tool rounds: "paused"; at the time limit too', async () => {
    const chat = await newChat()
    h.rt().maxEngineTurns = 1
    try {
      const read = { tool: 'read', args: { file_path: 'users/alice/todo.md' } }
      const r = await ask(h, main, 'alice', chat.id, fake(read, read, read, { say: 'never' }))
      expect(r.done.stopReason).toBe('tool_limit')
    } finally { h.rt().maxEngineTurns = 150 }
    expect(await listed(chat.id)).toMatchObject({ unseen: true, lastOutcome: 'paused' })
    // the time limit is the other stop reason (Message.stopReason 'time_limit'): the same "paused"
    h.ctx.db.query("UPDATE messages SET stop_reason = 'time_limit' WHERE chat_id = ? AND role = 'assistant'").run(chat.id)
    expect((await listed(chat.id))?.lastOutcome).toBe('paused')
  })

  test('a server stop cuts an answer off: "error", and nothing is told', async () => {
    const chat = await newChat()
    const c = await sendTo(chat.id, fake({ sleep: 20_000 }))
    await waitFor(() => h.rt().runState(chat.id) === 'running', { timeoutMs: 10_000 })
    const from = other.frames.length
    h.rt().longAnswerMs = 0
    try {
      h.rt().execFor(c.turnId)!.stop('shutdown')
      await main.next('message.done', (f) => f.data.messageId === c.assistantMessage.id, 20_000)
      const end = await until(other, chat.id, (f) => f.data.chat?.runState === 'idle', from)
      expect(end.data.chat).toMatchObject({ unseen: true, lastOutcome: 'error' })
      expect(updates(other, chat.id, from).some((f) => f.data.notify)).toBe(false)
    } finally { h.rt().longAnswerMs = LONG_ANSWER_MS }
  })

  test('the newest finished answer decides: a good answer after a failure clears the outcome', async () => {
    const chat = await newChat()
    await ask(h, main, 'alice', chat.id, fake({ fail: 'boom' }))
    expect((await listed(chat.id))?.lastOutcome).toBe('error')
    await ask(h, main, 'alice', chat.id, fake({ say: 'better now' }))
    const c = await listed(chat.id)
    expect(c?.unseen).toBe(true)
    expect(c?.lastOutcome).toBeUndefined()
  })
})

describe('notify: what is worth telling', () => {
  test(`an answer that ran ${LONG_ANSWER_MS / 1000} s or more: 'answer'; a shorter one: nothing`, async () => {
    expect(LONG_ANSWER_MS).toBe(60_000)
    const short = await newChat()
    const f0 = other.frames.length
    await ask(h, main, 'alice', short.id, fake({ say: 'quick' }))
    const ended = await until(other, short.id, (f) => f.data.chat?.runState === 'idle' && f.data.chat.unseen === true, f0)
    expect(ended.data.notify).toBeUndefined()

    h.rt().longAnswerMs = 0
    try {
      const long = await newChat()
      const f1 = other.frames.length
      await ask(h, main, 'alice', long.id, fake({ say: 'long one' }))
      const done = await until(other, long.id, (f) => f.data.chat?.runState === 'idle', f1)
      expect(done.data).toMatchObject({ notify: 'answer', chat: { unseen: true } })
      // one per answer: the cards and steps before it told nothing
      expect(updates(other, long.id, f1).filter((f) => f.data.notify).length).toBe(1)
    } finally { h.rt().longAnswerMs = LONG_ANSWER_MS }
  })

  test('never for an answer the person stopped', async () => {
    h.rt().longAnswerMs = 0
    try {
      const chat = await newChat()
      const s = await sendTo(chat.id, fake({ sleep: 20_000 }))
      await waitFor(() => h.rt().runState(chat.id) === 'running', { timeoutMs: 10_000 })
      const from = other.frames.length
      await h.api('alice').call(API.stop, { params: { id: chat.id } })
      await main.next('message.done', (f) => f.data.messageId === s.assistantMessage.id, 20_000)
      await until(other, chat.id, (f) => f.data.chat?.runState === 'idle', from)
      expect(updates(other, chat.id, from).some((f) => f.data.notify)).toBe(false)
    } finally { h.rt().longAnswerMs = LONG_ANSWER_MS }
  })

  test('never for a scheduled run or a question asked from Slack; a scheduled run gets its dot, a Slack answer none (it was delivered in Slack)', async () => {
    h.rt().longAnswerMs = 0
    try {
      for (const kind of ['schedule', 'slack'] as const) {
        const chat = await newChat()
        const from = other.frames.length
        const t = serverTurn(chat.id, kind, fake({ say: `${kind} answer` }))
        await main.next('message.done', (f) => f.data.messageId === t.assistantMessage.id, 20_000)
        const done = await until(other, chat.id, (f) => f.data.chat?.runState === 'idle', from)
        expect(updates(other, chat.id, from).some((f) => f.data.notify)).toBe(false)
        if (kind === 'schedule') {
          expect(done.data.chat!.unseen).toBe(true)
          expect((await listed(chat.id))?.unseen).toBe(true)
        } else {
          // every Slack thread would otherwise add a dot and one to the count until it was opened in the app
          expect(done.data.chat!.unseen).toBeUndefined()
          expect((await listed(chat.id))?.unseen).toBeUndefined()
        }
      }
    } finally { h.rt().longAnswerMs = LONG_ANSWER_MS }
  })

  test('a Slack turn\'s card: Chat.waiting, but nothing told (Slack says a card waits in the app)', async () => {
    const chat = await newChat()
    const from = other.frames.length
    const t = serverTurn(chat.id, 'slack', fake({ tool: 'ask_user', args: { question: 'From Slack?' }, sayResult: true }))
    const card = await openCard(main, t.turnId)
    await until(other, chat.id, (f) => f.data.chat?.waiting === true, from)
    expect(updates(other, chat.id, from).some((f) => f.data.notify)).toBe(false)
    expect((await listed(chat.id))?.waiting).toBe(true) // its "?" stays until answered in the app
    await answerCard(t.turnId, card.data.request)
    await main.next('message.done', (f) => f.data.messageId === t.assistantMessage.id, 20_000)
    await waitFor(async () => (await listed(chat.id))?.runState === 'idle', { timeoutMs: 10_000 })
    expect((await listed(chat.id))?.unseen).toBeUndefined()
  })

  test('a card opens: \'card\' with Chat.waiting in every window; its close and the turn\'s end tell nothing more', async () => {
    const chat = await newChat()
    const from = other.frames.length
    const s = await sendTo(chat.id, fake({ tool: 'ask_user', args: { question: 'Which one?' }, sayResult: true }))
    const card = await openCard(main, s.turnId)
    const opened = await until(other, chat.id, (f) => f.data.chat?.waiting === true, from)
    expect(opened.data).toMatchObject({ notify: 'card', chat: { runState: 'running' } })
    // /seen never clears a card's wait, and tells nobody (nothing finished is unseen)
    const mark = other.frames.length
    expect((await h.api('alice').call(API.markChatSeen, { params: { id: chat.id } })).waiting).toBe(true)
    const m2 = other.frames.length
    expect(m2).toBe(mark)
    await answerCard(s.turnId, card.data.request)
    await until(other, chat.id, (f) => f.data.chat !== null && f.data.chat.waiting === undefined, m2)
    await main.next('message.done', (f) => f.data.messageId === s.assistantMessage.id, 20_000)
    await until(other, chat.id, (f) => f.data.chat?.runState === 'idle', m2)
    expect(updates(other, chat.id, from).filter((f) => f.data.notify).map((f) => f.data.notify)).toEqual(['card'])
  })

  test('a card one desktop window shows alone: that window hears \'card\'; no list changes, no other window hears it', async () => {
    const chat = await newChat()
    const s = await sendTo(chat.id, fake({ sleep: 4000 }, { say: 'done' }))
    await waitFor(() => !!h.rt().execFor(s.turnId), { timeoutMs: 10_000 })
    const exec = h.rt().execFor(s.turnId)!
    const fromMain = main.frames.length, fromOther = other.frames.length
    const site: TurnRequest = { kind: 'browser_site', requestId: 'site-' + crypto.randomUUID(), url: 'http://10.0.0.7/', host: '10.0.0.7' }
    const waiting = exec.waitForPerson(site, { window: W1, timeoutMs: 1500 })
    const mine = await until(main, chat.id, (f) => f.data.notify === 'card', fromMain)
    expect(mine.data.chat!.waiting).toBeUndefined()
    expect((await listed(chat.id))?.waiting).toBeUndefined()
    expect(await waiting).toBeNull() // timed out
    // the other window may hear unrelated updates of this chat meanwhile (its title, the run state): only the card
    // must never reach it, neither as a notify nor as Chat.waiting
    expect(updates(other, chat.id, fromOther).filter((f) => f.data.notify === 'card' || f.data.chat?.waiting === true)).toEqual([])
    await main.next('message.done', (f) => f.data.messageId === s.assistantMessage.id, 20_000)
  })
})

describe('/seen tells only a real change', () => {
  test('an answer dated after the server\'s clock stays unseen: nothing is told, so no window asks again and again', async () => {
    const chat = await newChat()
    const f0 = other.frames.length
    await ask(h, main, 'alice', chat.id, fake({ say: 'from the future' }))
    await until(other, chat.id, (f) => f.data.chat?.runState === 'idle' && f.data.chat.unseen === true, f0)
    h.ctx.db.query("UPDATE messages SET updated_at = '2999-01-01T00:00:00.000Z' WHERE chat_id = ? AND role = 'assistant'").run(chat.id)
    const from = other.frames.length
    for (let i = 0; i < 3; i++) expect((await h.api('alice').call(API.markChatSeen, { params: { id: chat.id } })).unseen).toBe(true)
    await Bun.sleep(300)
    expect(updates(other, chat.id, from)).toEqual([])
  })
})

describe('every engine alike', () => {
  test('Codex: unseen when done, Chat.waiting with \'card\' for its ask_user card (our own TurnRequest), "error" when it fails', async () => {
    const chat = await newChat('codex')
    const r = await ask(h, main, 'alice', chat.id, fake({ say: 'from codex' }))
    expect(r.done.engine).toBe('codex')
    expect(await listed(chat.id)).toMatchObject({ engine: 'codex', unseen: true })
    const from = other.frames.length
    const s = await sendTo(chat.id, fake({ tool: 'ask_user', args: { question: 'Codex asks' }, sayResult: true }))
    const card = await openCard(main, s.turnId)
    expect((await until(other, chat.id, (f) => f.data.chat?.waiting === true, from)).data.notify).toBe('card')
    await answerCard(s.turnId, card.data.request)
    await main.next('message.done', (f) => f.data.messageId === s.assistantMessage.id, 20_000)
    expect((await listed(chat.id))?.lastOutcome).toBeUndefined()
    await ask(h, main, 'alice', chat.id, fake({ fail: 'codex fell over' }))
    expect(await listed(chat.id)).toMatchObject({ unseen: true, lastOutcome: 'error' })
  })

  test('the API engine: its ask_user card, its end, and a failure', async () => {
    const chat = await newChat('api')
    script.push(sse([{ id: 'c1', name: 'ask_user', args: { question: 'API asks' } }]), sse([], 'API done.'))
    const from = other.frames.length
    const s = await sendTo(chat.id, 'please ask me', { engine: 'api' })
    const card = await openCard(main, s.turnId)
    expect((await until(other, chat.id, (f) => f.data.chat?.waiting === true, from)).data.notify).toBe('card')
    expect(await listed(chat.id)).toMatchObject({ engine: 'api', waiting: true })
    await answerCard(s.turnId, card.data.request)
    const d = await main.next('message.done', (f) => f.data.messageId === s.assistantMessage.id, 20_000)
    expect(d.data.status).toBe('done')
    expect(await listed(chat.id)).toMatchObject({ unseen: true })
    expect((await listed(chat.id))?.lastOutcome).toBeUndefined()

    script.push(FAIL, FAIL, FAIL, FAIL) // the provider fails (and every retry): the answer fails
    const f = await sendTo(chat.id, 'again', { engine: 'api' })
    const e = await main.next('message.done', (x) => x.data.messageId === f.assistantMessage.id, 20_000)
    expect(e.data.status).toBe('error')
    expect(await listed(chat.id)).toMatchObject({ unseen: true, lastOutcome: 'error' })
  })
})
