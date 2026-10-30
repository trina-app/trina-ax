// Messages sent while an answer runs (lib/sendQueue.ts rules, store/sendQueue.ts runner) against a fake REST server.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { uuidv7, type Attachment, type TurnStarted } from '@mycel/shared/api'
import { combine, combinedClientId, nextStep, parseQueue, queueKey, restoredQueue, serializeQueue, QUEUE_CONTENT_MAX, QUEUE_ITEMS_MAX, type QueuedMessage } from '../../src/lib/sendQueue'
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
})
