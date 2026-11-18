// Messages sent while an answer runs (lib/sendQueue.ts rules, store/sendQueue.ts runner) against a fake REST server.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { uuidv7, type Attachment, type Chat, type TurnStarted } from '@mycel/shared/api'
import { combine, combinedClientId, declaredCount, nextStep, parseQueue, queueKey, restoredQueue, serializeQueue, QUEUE_CONTENT_MAX, QUEUE_ITEMS_MAX, type QueuedMessage } from '../../src/lib/sendQueue'
import { useChats } from '../../src/store/chats'
import { QueueFull, useSendQueue } from '../../src/store/sendQueue'
import { CHAT, msg } from './fixtures'

const me = { id: 'olga', name: 'Olga' }
const att = (name: string): Attachment => ({ id: uuidv7(), name, path: `users/olga/.attachments/${CHAT}/${name}`, size: 3, mime: 'text/plain', kind: 'text' })
const item = (content: string, attachments: Attachment[] = []): QueuedMessage => ({ id: uuidv7(), content, attachments, author: me, createdAt: new Date().toISOString() })
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })

describe('rules', () => {
  test('what waiting messages do, from the visible branch', () => {
    const q = msg({ role: 'user', content: 'q' })
    expect(nextStep([])).toBe('send')
    expect(nextStep([q, msg({ role: 'assistant', status: 'streaming' })])).toBe('wait')
    expect(nextStep([q, msg({ role: 'assistant', status: 'done' })])).toBe('send')
    // an answer that paused at the per-answer limit is a finished answer: what waits goes (the AI is told it paused)
    expect(nextStep([q, msg({ role: 'assistant', status: 'done', stopReason: 'tool_limit' })])).toBe('send')
    expect(nextStep([q, msg({ role: 'assistant', status: 'stopped' })])).toEqual({ pause: 'stopped' })
    expect(nextStep([q, msg({ role: 'assistant', status: 'error' })])).toEqual({ pause: 'error' })
    const sending = { ...msg({ role: 'user', content: 'x' }), local: { clientMessageId: 'c-12345678', state: 'sending' as const } }
    const failed = { ...sending, local: { ...sending.local, state: 'failed' as const } }
    expect(nextStep([q, msg({ role: 'assistant' }), sending])).toBe('wait')
    expect(nextStep([q, msg({ role: 'assistant' }), failed])).toEqual({ pause: 'error' })
    expect(nextStep([q])).toBe('wait')
  })

  test('several waiting messages go as one, in order, within the attachment and length limits', () => {
    const shared = att('shared.txt')
    const a = item('first', [shared]), b = item('', [att('b.txt')]), c = item('third', [shared])
    const r = combine([a, b, c])
    expect(r.take).toEqual([a, b, c])
    expect(r.content).toBe('first\n\nthird')
    expect(r.attachments.map((x) => x.name)).toEqual(['shared.txt', 'b.txt'])
    expect(combinedClientId(r.take)).toBe(`${a.id}.3`)
    const many = Array.from({ length: 16 }, (_, i) => att(`f${i}.txt`))
    const big = combine([item('one', many), item('two', many.slice(0, 5).map((x) => ({ ...x, id: uuidv7() }))), item('three')])
    expect(big.take.map((x) => x.content)).toEqual(['one'])
    const long = combine([item('x'.repeat(150_000)), item('y'.repeat(60_000)), item('z')])
    expect(long.take).toHaveLength(1)
  })

  test('a queue read back after a reload sends by itself only while its answer runs or just ended', () => {
    const answer = msg({ role: 'assistant', status: 'done' })
    const stored = { items: [item('later')], paused: null, after: answer.id }
    expect(restoredQueue(stored, [msg({ role: 'user' }), { ...answer, status: 'streaming' }])).toEqual(stored)
    expect(restoredQueue(stored, [msg({ role: 'user' }), answer])).toEqual(stored)
    expect(restoredQueue(stored, [msg({ role: 'user' }), answer, msg({ role: 'user' }), msg({ role: 'assistant' })]).paused).toBe('away')
    expect(restoredQueue({ ...stored, after: null }, [answer]).paused).toBe('away')
    expect(restoredQueue({ ...stored, paused: 'stopped' }, [answer]).paused).toBe('stopped')
  })

  test('a shared chat: someone else\'s stopped or failed answer does not pause mine; a paused or edited queue says 0', () => {
    const mine = msg({ role: 'user', content: 'q', author: me })
    const theirs = msg({ role: 'user', content: 'q', author: { id: 'bob', name: 'Bob' } })
    for (const status of ['stopped', 'error'] as const) {
      expect(nextStep([theirs, msg({ role: 'assistant', parentId: theirs.id, status })], { me: me.id })).toBe('send')
      expect(nextStep([mine, msg({ role: 'assistant', parentId: mine.id, status })], { me: me.id })).toEqual({ pause: status })
    }
    // someone else's question with no answer shown yet (their turn started): wait
    expect(nextStep([theirs], { me: me.id })).toBe('wait')
    // a question with no author (kept before authors were) is the chat's creator's
    const old = msg({ role: 'user', content: 'q' })
    expect(nextStep([old, msg({ role: 'assistant', parentId: old.id, status: 'stopped' })], { me: me.id, creator: me.id })).toEqual({ pause: 'stopped' })
    expect(nextStep([old, msg({ role: 'assistant', parentId: old.id, status: 'stopped' })], { me: me.id, creator: 'bob' })).toBe('send')
    const q = { items: [item('a'), item('b')], paused: null, after: null }
    expect(declaredCount(q, false)).toBe(2)
    expect(declaredCount(q, true)).toBe(0)
    expect(declaredCount({ ...q, paused: 'away' }, false)).toBe(0)
    expect(declaredCount(undefined, false)).toBe(0)
  })

  test('stored queues round-trip; anything else is ignored', () => {
    const q = { items: [item('a', [att('a.txt')])], paused: 'error' as const, after: uuidv7() }
    expect(parseQueue(serializeQueue(q))).toEqual(q)
    expect(parseQueue(null)).toBeNull()
    expect(parseQueue('{')).toBeNull()
    expect(parseQueue(JSON.stringify({ v: 2, items: [] }))).toBeNull()
    expect(parseQueue(serializeQueue({ ...q, items: [] }))).toBeNull()
  })
})

describe('the runner', () => {
  const realFetch = globalThis.fetch
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const stored = new Map<string, string>()
  let calls: { method: string; path: string; body: any }[] = []
  let route: (method: string, path: string, body: any) => Response | Promise<Response>

  beforeEach(() => {
    calls = []
    stored.clear()
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v), removeItem: (k: string) => void stored.delete(k),
    } })
    useChats.getState().reset()
    useSendQueue.getState().reset()
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://team.localhost')
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      calls.push({ method: init?.method ?? 'GET', path: url.pathname, body })
      return route(init?.method ?? 'GET', url.pathname, body)
    }) as typeof fetch
  })
  afterEach(() => {
    useSendQueue.getState().reset()
    useChats.getState().reset()
    globalThis.fetch = realFetch
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor)
    else delete (globalThis as { localStorage?: unknown }).localStorage
  })

  /** a chat with a question and a running answer */
  function running() {
    const q = msg({ role: 'user', content: 'long task' })
    const a = msg({ role: 'assistant', parentId: q.id, status: 'streaming', turnId: uuidv7() })
    useChats.setState({ threads: { [CHAT]: { messages: [q, a], nextCursor: null, stale: false } } })
    return a
  }
  const done = (a: ReturnType<typeof running>, status: 'done' | 'stopped' | 'error') =>
    useChats.getState().handleEvent({ type: 'message.done', seq: 1, at: 0, data: { chatId: CHAT, messageId: a.id, status, message: { ...a, status, content: 'ok' } } })
  function started(parentId: string, content: string): TurnStarted {
    const userMessage = msg({ role: 'user', parentId, content })
    return { userMessage, assistantMessage: msg({ role: 'assistant', parentId: userMessage.id, status: 'streaming', turnId: uuidv7() }), turnId: uuidv7(), queuePosition: 0 }
  }
  const sends = () => calls.filter((c) => c.method === 'POST' && c.path === `/api/chats/${CHAT}/messages`)

  test('messages sent during an answer wait, then go together when it is done', async () => {
    const a = running()
    const files = [att('notes.txt')]
    useSendQueue.getState().enqueue(me.id, CHAT, { content: 'also check Q4', attachments: files, author: me })
    useSendQueue.getState().enqueue(me.id, CHAT, { content: 'and make it short', attachments: [], author: me })
    await tick()
    expect(sends()).toHaveLength(0)
    const q = useSendQueue.getState().queues[CHAT]!
    expect(q.items.map((i) => i.content)).toEqual(['also check Q4', 'and make it short'])
    expect(q.after).toBe(a.id)
    expect(parseQueue(stored.get(queueKey(me.id, CHAT))!)?.items).toHaveLength(2)
    route = (_m, _p, body) => json(started(a.id, body.content), 202)
    done(a, 'done')
    await tick(10)
    expect(sends()).toHaveLength(1)
    expect(sends()[0]!.body).toMatchObject({ content: 'also check Q4\n\nand make it short', attachmentIds: [files[0]!.id], parentId: a.id, clientMessageId: `${q.items[0]!.id}.2` })
    expect(useSendQueue.getState().queues[CHAT]).toBeUndefined()
    expect(stored.has(queueKey(me.id, CHAT))).toBe(false)
    const shown = useChats.getState().threads[CHAT]!.messages
    expect(shown.at(-2)!.content).toBe('also check Q4\n\nand make it short')
    expect(shown.at(-1)!.status).toBe('streaming')
  })

  test('Stop keeps them, paused, until "send now"; a failed answer pauses them too', async () => {
    const a = running()
    useSendQueue.getState().enqueue(me.id, CHAT, { content: 'next', attachments: [], author: me })
    done(a, 'stopped')
    await tick(10)
    expect(sends()).toHaveLength(0)
    expect(useSendQueue.getState().queues[CHAT]!.paused).toBe('stopped')
    expect(parseQueue(stored.get(queueKey(me.id, CHAT))!)?.paused).toBe('stopped')
    route = (_m, _p, body) => json(started(a.id, body.content), 202)
    // a message typed now goes with them, after them
    useSendQueue.getState().sendNow(CHAT, { content: 'and this', attachments: [], author: me })
    await tick(10)
    expect(sends().map((c) => c.body.content)).toEqual(['next\n\nand this'])

    useChats.getState().reset()
    calls = []
    const b = running()
    useSendQueue.getState().enqueue(me.id, CHAT, { content: 'after error', attachments: [], author: me })
    done(b, 'error')
    await tick(10)
    expect(sends()).toHaveLength(0)
    expect(useSendQueue.getState().queues[CHAT]!.paused).toBe('error')
  })

  test('a failed or stopped answer tried again: the pause no longer says it did not finish (QA TC-4930)', async () => {
    for (const end of ['error', 'stopped'] as const) {
      useChats.getState().reset(); useSendQueue.getState().reset(); calls = []
      const a = running()
      useSendQueue.getState().enqueue(me.id, CHAT, { content: 'next', attachments: [], author: me })
      done(a, end)
      await tick(10)
      expect(useSendQueue.getState().queues[CHAT]!.paused).toBe(end)
      // the person tries again: a new answer in its place (regenerate), and it finishes
      const again = msg({ role: 'assistant', parentId: a.parentId, status: 'streaming', turnId: uuidv7() })
      const t = useChats.getState().threads[CHAT]!
      useChats.setState({ threads: { [CHAT]: { ...t, messages: [...t.messages.slice(0, -1), again] } } })
      await tick(10)
      expect(useSendQueue.getState().queues[CHAT]!.paused).toBe('away')
      done(again, 'done')
      await tick(10)
      // still waits for "Send now": nothing drops into the conversation by itself
      expect(sends()).toHaveLength(0)
      expect(useSendQueue.getState().queues[CHAT]!.paused).toBe('away')
    }
  })

  test('another answer already running (409): the messages wait again, nothing shows as failed', async () => {
    const a = running()
    useSendQueue.getState().enqueue(me.id, CHAT, { content: 'next', attachments: [], author: me })
    route = (m, p) => (m === 'POST' ? json({ error: { code: 'conflict', message: 'An answer is still in progress in this chat.' } }, 409)
      : p.endsWith('/messages') ? json({ items: useChats.getState().threads[CHAT]!.messages.filter((x) => !x.local), nextCursor: null })
      : p.endsWith('/queue') ? json({ state: 'idle', turnId: null, messageId: null, position: null, epoch: 'e', revision: 1 }) : json({ items: [] }))
    done(a, 'done')
    await tick(30)
    expect(sends()).toHaveLength(1)
    expect(useSendQueue.getState().queues[CHAT]!.items.map((i) => i.content)).toEqual(['next'])
    expect(useChats.getState().threads[CHAT]!.messages.some((m) => m.local)).toBe(false)
    expect(calls.some((c) => c.method === 'GET' && c.path === `/api/chats/${CHAT}/messages`)).toBe(true)
  })

  test('nothing is sent while one is being edited; edit and remove change what goes', async () => {
    const a = running()
    const s = useSendQueue.getState()
    s.enqueue(me.id, CHAT, { content: 'frist', attachments: [], author: me })
    s.enqueue(me.id, CHAT, { content: 'drop me', attachments: [], author: me })
    const [one, two] = useSendQueue.getState().queues[CHAT]!.items
    s.setEditing(CHAT, one!.id)
    route = (_m, _p, body) => json(started(a.id, body.content), 202)
    done(a, 'done')
    await tick(10)
    expect(sends()).toHaveLength(0)
    s.update(CHAT, one!.id, 'first')
    s.remove(CHAT, two!.id)
    s.setEditing(CHAT, null)
    await tick(10)
    expect(sends().map((c) => c.body.content)).toEqual(['first'])
    expect(sends()[0]!.body.clientMessageId).toBe(`${one!.id}.1`)
  })

  test('at most ten wait per chat', () => {
    running()
    for (let i = 0; i < QUEUE_ITEMS_MAX; i++) useSendQueue.getState().enqueue(me.id, CHAT, { content: `m${i}`, attachments: [], author: me })
    expect(() => useSendQueue.getState().enqueue(me.id, CHAT, { content: 'one more', attachments: [], author: me })).toThrow(QueueFull)
  })

  test('ten paused plus one typed now all go; what the runner stores always reads back', async () => {
    const a = running()
    for (let i = 0; i < QUEUE_ITEMS_MAX; i++) useSendQueue.getState().enqueue(me.id, CHAT, { content: `m${i}`, attachments: [], author: me })
    done(a, 'stopped')
    await tick(10)
    expect(useSendQueue.getState().queues[CHAT]!.paused).toBe('stopped')
    // eleven in storage for a moment (the send is handed over right away): it must not read as an empty queue
    const eleven = { items: Array.from({ length: QUEUE_ITEMS_MAX + 1 }, (_, i) => item(`x${i}`)), paused: null, after: null }
    expect(parseQueue(serializeQueue(eleven))?.items).toHaveLength(QUEUE_ITEMS_MAX + 1)
    route = (_m, _p, body) => json(started(a.id, body.content), 202)
    useSendQueue.getState().sendNow(CHAT, { content: 'and this', attachments: [], author: me })
    await tick(10)
    expect(sends().map((c) => c.body.content)).toEqual([[...Array.from({ length: QUEUE_ITEMS_MAX }, (_, i) => `m${i}`), 'and this'].join('\n\n')])
    expect(useSendQueue.getState().queues[CHAT]).toBeUndefined()
  })

  test('a message longer than the send limit stays readable and goes like any message (the server refuses it)', async () => {
    const a = running()
    const long = 'x'.repeat(QUEUE_CONTENT_MAX + 10)
    useSendQueue.getState().enqueue(me.id, CHAT, { content: long, attachments: [], author: me })
    expect(parseQueue(stored.get(queueKey(me.id, CHAT))!)?.items[0]!.content).toHaveLength(long.length)
    route = (m) => (m === 'POST' ? json({ error: { code: 'validation', message: 'Too long.' } }, 400) : json({ items: [] }))
    done(a, 'done')
    await tick(10)
    expect(sends()).toHaveLength(1)
    expect(useSendQueue.getState().queues[CHAT]).toBeUndefined()
    expect(useChats.getState().threads[CHAT]!.messages.at(-1)!.local?.state).toBe('failed')
  })

  test('storage full: this window keeps the newest message and the older stored copy is not taken as the truth', async () => {
    const a = running()
    useSendQueue.getState().enqueue(me.id, CHAT, { content: 'first', attachments: [], author: me })
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { ...localStorage, setItem: () => { throw new Error('QuotaExceededError') } } })
    useSendQueue.getState().enqueue(me.id, CHAT, { content: 'second', attachments: [], author: me })
    expect(useSendQueue.getState().queues[CHAT]!.items.map((i) => i.content)).toEqual(['first', 'second'])
    // the stored copy without "second" is gone, so neither a reload nor another window brings it back as the truth
    expect(stored.has(queueKey(me.id, CHAT))).toBe(false)
    route = (_m, _p, body) => json(started(a.id, body.content), 202)
    done(a, 'done')
    await tick(10)
    expect(sends().map((c) => c.body.content)).toEqual(['first\n\nsecond'])
  })

  test('after a reload: still waits for its answer, or asks first when the chat moved on', async () => {
    const a = running()
    const waiting = { items: [item('typed before reload')], paused: null, after: a.id }
    stored.set(queueKey(me.id, CHAT), serializeQueue(waiting))
    useSendQueue.getState().restore(me.id, CHAT)
    expect(useSendQueue.getState().queues[CHAT]!.paused).toBeNull()
    route = (_m, _p, body) => json(started(a.id, body.content), 202)
    done(a, 'done')
    await tick(10)
    expect(sends().map((c) => c.body.content)).toEqual(['typed before reload'])

    useSendQueue.getState().reset()
    useChats.getState().reset()
    calls = []
    const q = msg({ role: 'user', content: 'other device' })
    useChats.setState({ threads: { [CHAT]: { messages: [q, msg({ role: 'assistant', parentId: q.id })], nextCursor: null, stale: false } } })
    stored.set(queueKey(me.id, CHAT), serializeQueue(waiting))
    useSendQueue.getState().restore(me.id, CHAT)
    await tick(10)
    expect(sends()).toHaveLength(0)
    expect(useSendQueue.getState().queues[CHAT]!.paused).toBe('away')
  })
  describe('a shared chat', () => {
    const bob = { id: 'bob', name: 'Bob' }
    const sharedChat = (o: Partial<NonNullable<Chat['shared']>> = {}) => ({ id: CHAT, title: 'Launch', projectId: uuidv7(), engine: 'claude-code', model: null, runState: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      shared: { kind: 'project', by: bob, audience: 3, answering: null, mine: true, canDelete: false, ...o } }) as unknown as Chat
    const waits = () => calls.filter((c) => c.method === 'PUT' && c.path === `/api/chats/${CHAT}/waiting`).map((c) => c.body.count)

    test('mine wait for Bob\'s turn, the server hears how many, and they go under the chat\'s end', async () => {
      // Bob's question is being answered: his question shows, no answer yet (no live text for the others)
      const theirs = msg({ role: 'user', content: 'Bob asks', author: bob })
      const before = msg({ role: 'assistant', status: 'done' })
      useChats.setState({ chats: [sharedChat({ answering: { name: 'Bob' } })], threads: { [CHAT]: { messages: [before, { ...theirs, parentId: before.id }], nextCursor: null, stale: false } } })
      route = (m, _p, body) => (m === 'PUT' ? new Response(null, { status: 204 }) : json(started(before.id, body?.content ?? ''), 202))
      useSendQueue.getState().enqueue(me.id, CHAT, { content: 'this too', attachments: [att('b.zip')], author: me })
      await tick(10)
      expect(sends()).toHaveLength(0)
      expect(waits()).toEqual([1])
      // his turn ended, but this page has not read his answer yet: mine go now, under the server's end of the chat
      useChats.setState({ chats: [sharedChat()], threads: { [CHAT]: { messages: [before], nextCursor: null, stale: false } } })
      await tick(20)
      expect(sends()).toHaveLength(1)
      expect(sends()[0]!.body.parentId).toBeUndefined()
      // under the newest end of the branch this page last saw (SendMessageBody.after)
      expect(sends()[0]!.body.after).toBe(before.id)
      expect(sends()[0]!.body.content).toBe('this too')
      // still counted while on its way, then 0 when nothing waits any more
      await tick(10)
      expect(waits()).toEqual([1, 0])
    })

    test('Bob queued first (409 shared_chat_next): mine wait again, nothing shows as failed, and go after his', async () => {
      const a = msg({ role: 'assistant', status: 'done' })
      useChats.setState({ chats: [sharedChat({ waiting: 1 })], threads: { [CHAT]: { messages: [a], nextCursor: null, stale: false } } })
      route = (m, p) => (m === 'PUT' ? new Response(null, { status: 204 })
        : m === 'POST' ? json({ error: { code: 'conflict', message: "Bob's message has been waiting longer.", params: { reason: 'shared_chat_next' } } }, 409)
        : p.endsWith('/messages') ? json({ items: useChats.getState().threads[CHAT]!.messages.filter((x) => !x.local), nextCursor: null })
        : p.endsWith('/queue') ? json({ state: 'idle', turnId: null, messageId: null, position: null, epoch: 'e', revision: 1 }) : json({ items: [] }))
      useSendQueue.getState().enqueue(me.id, CHAT, { content: 'after Bob', attachments: [], author: me })
      await tick(30)
      expect(sends()).toHaveLength(1)
      const q = useSendQueue.getState().queues[CHAT]!
      expect(q.items.map((i) => i.content)).toEqual(['after Bob'])
      expect(q.paused).toBeNull()
      expect(useChats.getState().threads[CHAT]!.messages.some((m) => m.local)).toBe(false)
      // the place in line was never given up (1 while waiting, 1 while on its way, 1 again)
      expect(waits().every((n) => n === 1)).toBe(true)
    })

    test('with another chat on screen: Bob\'s turn ending reads the chat again here, so mine still go; a chat not loaded says 0', async () => {
      const before = msg({ role: 'assistant', status: 'done' })
      const theirs = { ...msg({ role: 'user', content: 'Bob asks', author: bob }), parentId: before.id }
      const answer = msg({ role: 'assistant', parentId: theirs.id, status: 'done' })
      useChats.setState({ chats: [sharedChat({ answering: { name: 'Bob' } })], threads: { [CHAT]: { messages: [before, theirs], nextCursor: null, stale: false } } })
      route = (m, p, body) => (m === 'PUT' ? new Response(null, { status: 204 })
        : m === 'GET' && p.endsWith('/messages') ? json({ items: [before, theirs, answer], nextCursor: null })
        : m === 'GET' && p.endsWith('/queue') ? json({ state: 'idle', turnId: null, messageId: null, position: null, epoch: 'e', revision: 1 })
        : json(started(answer.id, body?.content ?? ''), 202))
      useSendQueue.getState().enqueue(me.id, CHAT, { content: 'this too', attachments: [], author: me })
      await tick(10)
      expect(sends()).toHaveLength(0)
      // his turn ends (chat.updated): no page reads the chat, the queue's runner does
      useChats.setState({ chats: [sharedChat()] })
      await tick(30)
      expect(calls.some((c) => c.method === 'GET' && c.path === `/api/chats/${CHAT}/messages`)).toBe(true)
      expect(sends()).toHaveLength(1)
      expect(sends()[0]!.body.after).toBe(answer.id)

      // a shared chat whose messages this window does not have: its waiting messages hold no place
      useSendQueue.getState().reset()
      useChats.getState().reset()
      calls = []
      useChats.setState({ chats: [sharedChat({ answering: { name: 'Bob' } })] })
      stored.set(queueKey(me.id, CHAT), serializeQueue({ items: [item('later')], paused: null, after: null }))
      useSendQueue.setState({ userId: me.id, queues: { [CHAT]: { items: [item('later')], paused: null, after: null } } })
      await tick(10)
      expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0)
    })

    test('Bob stopped his answer: mine still go; my own stopped answer pauses them', async () => {
      const theirs = msg({ role: 'user', content: 'Bob asks', author: bob })
      const ans = msg({ role: 'assistant', parentId: theirs.id, status: 'streaming', turnId: uuidv7() })
      useChats.setState({ chats: [sharedChat()], threads: { [CHAT]: { messages: [theirs, ans], nextCursor: null, stale: false } } })
      route = (m, _p, body) => (m === 'PUT' ? new Response(null, { status: 204 }) : json(started(ans.id, body?.content ?? ''), 202))
      useSendQueue.getState().enqueue(me.id, CHAT, { content: 'go anyway', attachments: [], author: me })
      done(ans, 'stopped')
      await tick(20)
      expect(sends().map((c) => c.body.content)).toEqual(['go anyway'])
    })
  })
})
