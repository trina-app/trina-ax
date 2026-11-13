// A push when an answer in my own AI chat needs me (QA TC-442, docs/DECISIONS.md "AI 답변 알림";
// server/src/notifications/chat-answers.ts): one notice per answer for the person who asked it (finished, failed, or a
// card that waits for them), pushed after a short wait only while the answer is unseen or the card still open, never
// for a person's stop, a scheduled run or a question from Slack; "AI answers" off makes none and cancels what waits; a
// shared project chat tells only the asker of that turn; the push opens /c/<chatId> and carries ids and the code only.
// With the fake engine through the real launcher and gate.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type TurnRequest } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { waitFor } from '../lib/wait'
import { PushService } from '../../server/src/notifications/push-service'
import type { NativeSend } from '../../server/src/notifications/push-native'
import { pushPathOf } from '../../server/src/notifications/push-events'
import { CHAT_ANSWER_PUSH_DELAY_MS, CHAT_CARD_PUSH_DELAY_MS, chatAnswerWanted } from '../../server/src/notifications/chat-answers'
import { notificationsOf } from '../../server/src/notifications/service'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
const ws: Record<string, TestSocket> = {}
let projectId: string
beforeAll(async () => {
  h = await startHarness({ name: 'b-chat-answer-push', askUserTimeoutMs: 8000, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  // a shared project: alice writes it, bob (finance) reads it (tests/lib/legacy-project.ts)
  const p = await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: 'Falcon notes.' })
  projectId = p.id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

type Notice = { id: string; user_id: string; source_id: string; chat_id: string; kind: string; created_at: string; push_at: string; read_at: string | null }
const notices = (chatId: string): Notice[] => h.ctx.db.query('SELECT * FROM chat_answer_notices WHERE chat_id = ? ORDER BY created_at, id').all(chatId) as Notice[]
const newChat = (user = 'alice', body: Record<string, unknown> = {}) => h.api(user).call(API.createChat, { body })
const seen = (chatId: string, user = 'alice') => h.api(user).call(API.markChatSeen, { params: { id: chatId } })
const prefs = (user: string, body: Record<string, unknown>) => h.api(user).call(API.updateNotificationPreferences, { body } as never)

/** A push service with a phone of `user` (an iPhone, through a fake gateway) and a clock the test moves. */
function phone(user: string) {
  const sent: NativeSend[] = []
  let now = Date.now()
  const p = new PushService(h.ctx, { config: () => null, native: () => ({ url: 'https://push.example.test' }), transport: async () => { throw new Error('no web push here') },
    nativeTransport: async (i) => { sent.push(i); return { statusCode: 200 } }, now: () => now,
    // the asker's own window is open here (the test's socket): "at Trina" would cancel the phone push
    // (notifications/away.ts, its own tests in b-push-away); these tests are about which answers make a notice
    phoneDecision: () => ({ kind: 'send' }) })
  const sid = (h.ctx.db.query("SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").get(user) as { id: string }).id
  p.registerDevice(user, sid, { consent: true, platform: 'ios', environment: 'production', token: crypto.randomUUID().replace(/-/g, '').repeat(2) })
  /** later: the clock `ms` after the real now (the answer itself takes a moment) */
  return { p, sent, later: (ms: number) => { now = Date.now() + ms }, tick: () => p.tick() }
}

describe('which answers make a notice', () => {
  test('finished: one notice for the asker, pushed after its wait while unseen, with the code, the chat path and the badge only', async () => {
    const chat = await newChat()
    const ph = phone('alice')
    try {
      await new Promise((r) => setTimeout(r, 5))
      await ask(h, ws.alice!, 'alice', chat.id, fake({ say: 'here you go' }))
      const [n] = notices(chat.id)
      expect(notices(chat.id)).toHaveLength(1)
      expect(n).toMatchObject({ user_id: 'alice', kind: 'done', read_at: null })
      expect(Date.parse(n!.push_at) - Date.parse(n!.created_at)).toBe(CHAT_ANSWER_PUSH_DELAY_MS)
      // before its wait: nothing
      await ph.tick()
      expect(ph.sent).toHaveLength(0)
      ph.later(CHAT_ANSWER_PUSH_DELAY_MS + 1000)
      await ph.tick()
      expect(ph.sent).toHaveLength(1)
      expect(ph.sent[0]!.payload).toMatchObject({ code: 'chat.answer_done', notificationId: n!.id, path: `/c/${chat.id}`, locale: 'en' })
      expect(Object.keys(ph.sent[0]!.payload).sort()).toEqual(['badge', 'code', 'locale', 'notificationId', 'path', 'tag'])
      expect(JSON.stringify(ph.sent[0]!.payload)).not.toContain('here you go')
      // the same answer never twice
      ph.later(60_000)
      await ph.tick()
      expect(ph.sent).toHaveLength(1)
    } finally { await ph.p.stop() }
  })

  test('not while I look at it: a window that has the chat on screen marks it seen within the wait, and nothing is pushed', async () => {
    const chat = await newChat()
    const ph = phone('alice')
    try {
      await new Promise((r) => setTimeout(r, 5))
      await ask(h, ws.alice!, 'alice', chat.id, fake({ say: 'seen right away' }))
      const [n] = notices(chat.id)
      expect(chatAnswerWanted(h.ctx, n!.id)).toBe(true)
      await seen(chat.id)
      expect(chatAnswerWanted(h.ctx, n!.id)).toBe(false)
      ph.later(CHAT_ANSWER_PUSH_DELAY_MS + 1000)
      await ph.tick()
      expect(ph.sent).toHaveLength(0)
    } finally { await ph.p.stop() }
  })

  test('failed: kind failed; stopped by the person, a scheduled run, a question from Slack or a turn the server started: none', async () => {
    const failed = await newChat()
    const r = await ask(h, ws.alice!, 'alice', failed.id, fake({ fail: 'rate limit exceeded' }))
    expect(r.done.status).toBe('error')
    expect(notices(failed.id).map((n) => n.kind)).toEqual(['failed'])

    const stopped = await newChat()
    const s = await h.api('alice').call(API.sendMessage, { params: { id: stopped.id }, body: { content: fake({ sleep: 20_000 }), clientMessageId: cm(), attachmentIds: [] } })
    await waitFor(() => h.rt().runState(stopped.id) === 'running', { timeoutMs: 10_000 })
    await h.api('alice').call(API.stop, { params: { id: stopped.id } })
    await ws.alice!.next('message.done', (f) => f.data.messageId === s.assistantMessage.id, 20_000)
    expect(notices(stopped.id)).toEqual([])

    // a turn the server starts by itself (a skill draft, a merge: no client) neither
    for (const clientKind of ['schedule', 'slack', null] as const) {
      const chat = await newChat()
      const t = h.rt().createTurn({ chat: h.rt().store.chatRow(chat.id)!, userId: 'alice', locale: 'en', windowId: null, clientKind, engine: 'claude-code', model: null,
        user: { parentId: null, content: fake({ say: `${clientKind} answer` }), attachments: [], clientMessageId: cm() } })
      await ws.alice!.next('message.done', (f) => f.data.messageId === t.assistantMessage.id, 20_000)
      expect(notices(chat.id)).toEqual([])
    }
  })

  test('a card that waits for me: one notice per turn (a longer wait), wanted while the card is open; the answer after it is its own', async () => {
    const chat = await newChat()
    const s = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ tool: 'ask_user', args: { question: 'Which one?' }, sayResult: true }), clientMessageId: cm(), attachmentIds: [] } })
    const card = await ws.alice!.next('turn.request', (f) => f.data.turnId === s.turnId, 15_000)
    const [w] = notices(chat.id)
    expect(w).toMatchObject({ user_id: 'alice', kind: 'waiting', source_id: `${s.turnId}.ask` })
    expect(Date.parse(w!.push_at) - Date.parse(w!.created_at)).toBe(CHAT_CARD_PUSH_DELAY_MS)
    expect(chatAnswerWanted(h.ctx, w!.id)).toBe(true)
    expect(pushPathOf(h.ctx, 'chat.answer_done', w!.id)).toBe(`/c/${chat.id}`)
    await h.api('alice').call(API.answerTurn, { params: { id: s.turnId }, body: { kind: 'ask_user', requestId: (card.data.request as TurnRequest).requestId, answer: 'the first' } })
    await ws.alice!.next('message.done', (f) => f.data.messageId === s.assistantMessage.id, 20_000)
    // answered: the card's push is no longer wanted; the finished answer is a notice of its own
    expect(chatAnswerWanted(h.ctx, w!.id)).toBe(false)
    expect(notices(chat.id).map((n) => n.kind)).toEqual(['waiting', 'done'])
  })
})

describe('one push per answer, the setting, shared chats', () => {
  test('a burst of answers while I do not look is one notice; once I looked, the next answer is told again', async () => {
    const chat = await newChat()
    await ask(h, ws.alice!, 'alice', chat.id, fake({ say: 'one' }))
    await ask(h, ws.alice!, 'alice', chat.id, fake({ say: 'two' }))
    expect(notices(chat.id)).toHaveLength(1)
    await seen(chat.id)
    await ask(h, ws.alice!, 'alice', chat.id, fake({ say: 'three' }))
    expect(notices(chat.id)).toHaveLength(2)
  })

  test('"AI answers" off: no notice, and a push that waited is cancelled; on again: told', async () => {
    const chat = await newChat()
    const ph = phone('alice')
    try {
      await new Promise((r) => setTimeout(r, 5))
      await ask(h, ws.alice!, 'alice', chat.id, fake({ say: 'waits for a push' }))
      await ph.tick()
      const waiting = h.ctx.db.query("SELECT state FROM chat_answer_push_deliveries WHERE notification_id = ?").all(notices(chat.id)[0]!.id) as { state: string }[]
      expect(waiting.map((d) => d.state)).toEqual(['pending'])
      expect((await prefs('alice', { chatAnswers: false })).chatAnswers).toBe(false)
      expect((h.ctx.db.query("SELECT state FROM chat_answer_push_deliveries WHERE notification_id = ?").all(notices(chat.id)[0]!.id) as { state: string }[]).map((d) => d.state)).toEqual(['cancelled'])
      ph.later(CHAT_ANSWER_PUSH_DELAY_MS + 1000)
      await ph.tick()
      expect(ph.sent).toHaveLength(0)
      const other = await newChat()
      await ask(h, ws.alice!, 'alice', other.id, fake({ say: 'nobody is told' }))
      expect(notices(other.id)).toEqual([])
    } finally {
      await prefs('alice', { chatAnswers: true })
      await ph.p.stop()
    }
    expect(notificationsOf(h.ctx).preferences('alice').chatAnswers).toBe(true)
  })

  test('a shared project chat: only the asker of that turn, not the chat\'s creator; the creator\'s seen mark does not hold it back', async () => {
    const chat = await newChat('alice', { projectId })
    expect(chat.projectId).toBe(projectId)
    await ask(h, ws.bob!, 'bob', chat.id, fake({ say: 'for bob' }))
    expect(notices(chat.id).map((n) => n.user_id)).toEqual(['bob'])
    const [n] = notices(chat.id)
    // alice looking at the chat is not bob looking at it
    await seen(chat.id, 'alice')
    expect(chatAnswerWanted(h.ctx, n!.id)).toBe(true)
    expect(pushPathOf(h.ctx, 'chat.answer_done', n!.id)).toBe(`/c/${chat.id}`)
    await ask(h, ws.alice!, 'alice', chat.id, fake({ say: 'for alice' }))
    expect(notices(chat.id).map((n) => n.user_id).sort()).toEqual(['alice', 'bob'])
  })

  test('never in the Inbox (list or count); GET of the notice (what a push opens) links the chat, a deleted chat links nothing', async () => {
    const chat = await newChat()
    await ask(h, ws.alice!, 'alice', chat.id, fake({ say: 'inbox?' }))
    const [n] = notices(chat.id)
    const list = await h.api('alice').call(API.listNotifications, { query: {} } as never) as { items: { id: string }[] }
    expect(list.items.map((i) => i.id)).not.toContain(n!.id)
    expect(await h.api('alice').call(API.getNotification, { params: { id: n!.id } } as never)).toMatchObject({ code: 'chat.answer_done', link: 'chat', chatId: chat.id })
    // another person cannot read it
    await expect(h.api('bob').call(API.getNotification, { params: { id: n!.id } } as never)).rejects.toThrow()
    await h.api('alice').call(API.deleteChat, { params: { id: chat.id } } as never)
    expect(await h.api('alice').call(API.getNotification, { params: { id: n!.id } } as never)).toMatchObject({ link: null, chatId: null })
    expect(pushPathOf(h.ctx, 'chat.answer_done', n!.id)).toBeUndefined()
    expect(chatAnswerWanted(h.ctx, n!.id)).toBe(false)
  })
})
