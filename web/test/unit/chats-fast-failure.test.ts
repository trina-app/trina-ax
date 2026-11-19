// An answer that failed at once (the team's AI usage used up: the server ended the turn ~100 ms after it began) stayed
// on "Thinking…" with Stop showing until the page was reloaded (owner report 2026-11-19). The chat's messages
// were being read when the events came: the answer's "created" copy (still running) waited for the read and was
// applied after its end, which had already come; the end was taken back and, since the page knew the answer had
// ended, nothing read it again. An older running copy never replaces a finished answer.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { uuidv7, type Message, type TurnStarted } from '@mycel/shared/api'
import { QUIET_CHECK_MAX_MS, QUIET_CHECK_MS, useChats } from '../../src/store/chats'
import { applyCreated } from '../../src/store/thread'
import { CHAT, msg } from './fixtures'

const realFetch = globalThis.fetch
const realSetTimeout = globalThis.setTimeout
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
const tick = (ms = 0) => new Promise((r) => realSetTimeout(r, ms))
let calls: { method: string; path: string }[] = []
let route: (method: string, path: string) => Response | Promise<Response>

beforeEach(() => {
  calls = []
  useChats.getState().reset()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://team.localhost')
    calls.push({ method: init?.method ?? 'GET', path: url.pathname })
    return route(init?.method ?? 'GET', url.pathname)
  }) as typeof fetch
  // the quiet checks run after 5 ms instead of 20 s
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...a: unknown[]) => {
    if (ms !== undefined && ms >= QUIET_CHECK_MS && ms <= QUIET_CHECK_MAX_MS) return realSetTimeout(fn, 5)
    return realSetTimeout(fn, ms, ...a)
  }) as typeof setTimeout
})
afterEach(() => {
  useChats.getState().reset()
  globalThis.fetch = realFetch
  globalThis.setTimeout = realSetTimeout
})

const usedUp = (a: Message): Message => ({ ...a, status: 'error', error: { code: 'rate_limited', message: 'The AI usage limit was reached for now. Try again a bit later.', params: { reason: 'rate_limit' }, retryAfter: 191239 } })
const created = (m: Message, seq: number) => ({ type: 'message.created' as const, seq, at: 0, data: { chatId: CHAT, message: m } })
const done = (m: Message, seq: number) => ({ type: 'message.done' as const, seq, at: 0, data: { chatId: CHAT, messageId: m.id, status: m.status as 'error', message: m } })
const last = () => useChats.getState().threads[CHAT]!.messages.at(-1)!

describe('an answer that ends at once while the page is open', () => {
  test('its end comes while the chat is being read: the running copy that waited for the read does not take it back', async () => {
    const q = msg({ role: 'user', content: 'hi' })
    const a = msg({ role: 'assistant', parentId: q.id, status: 'streaming', turnId: uuidv7() })
    const s: TurnStarted = { userMessage: q, assistantMessage: a, turnId: a.turnId!, queuePosition: 0 }
    let answerRead!: () => void
    const readGate = new Promise<void>((r) => { answerRead = r })
    let firstRead = true
    route = async (m, p) => {
      if (m === 'POST') return json(s, 202)
      if (p.endsWith('/messages')) {
        // the first read left the server before the turn ended (a running copy); it answers late
        if (firstRead) { firstRead = false; await readGate; return json({ items: [q, a], nextCursor: null }) }
        return json({ items: [q, usedUp(a)], nextCursor: null })
      }
      return json({ items: [] })
    }
    useChats.setState({ threads: { [CHAT]: { messages: [], nextCursor: null, stale: false } } })
    // the page opens the chat (a read starts) and sends at once
    const reading = useChats.getState().loadThread(CHAT)
    await useChats.getState().send({ chatId: CHAT, content: 'hi', attachments: [], author: { id: 'olga', name: 'Olga' } })
    await tick(1)
    // the server's events: the question and the running answer (held for the read), then the end (100 ms later)
    useChats.getState().handleEvent(created(q, 1))
    useChats.getState().handleEvent(created(a, 2))
    useChats.getState().handleEvent(done(usedUp(a), 3))
    answerRead()
    await reading
    await tick(1)
    expect(last().id).toBe(a.id)
    expect(last().status).toBe('error')
    expect(last().error?.params?.reason).toBe('rate_limit')
    // and the chat is idle again (the composer shows send, not Stop)
    expect(useChats.getState().chats.find((c) => c.id === CHAT)?.runState ?? 'idle').not.toBe('running')
  })

  test('its end comes before the send is answered and before the page knows the answer', async () => {
    const q = msg({ role: 'user', content: 'hi' })
    const a = msg({ role: 'assistant', parentId: q.id, status: 'streaming', turnId: uuidv7() })
    const s: TurnStarted = { userMessage: q, assistantMessage: a, turnId: a.turnId!, queuePosition: 0 }
    let answerPost!: () => void
    const postGate = new Promise<void>((r) => { answerPost = r })
    route = async (m) => { if (m === 'POST') { await postGate; return json(s, 202) } return json({ items: [] }) }
    useChats.setState({ threads: { [CHAT]: { messages: [], nextCursor: null, stale: false } } })
    await useChats.getState().send({ chatId: CHAT, content: 'hi', attachments: [], author: { id: 'olga', name: 'Olga' } })
    useChats.getState().handleEvent(done(usedUp(a), 1))
    // the running copy of the answer comes after its end (events of two publishes can cross)
    useChats.getState().handleEvent(created(a, 2))
    answerPost()
    await tick(5)
    expect(last().id).toBe(a.id)
    expect(last().status).toBe('error')
  })
})

describe('applyCreated', () => {
  test('a running copy never replaces a finished answer; a finished copy replaces a running one', () => {
    const a = msg({ role: 'assistant', status: 'streaming' })
    const ended = usedUp(a)
    expect(applyCreated([ended], a)).toEqual([ended])
    expect(applyCreated([a], ended)).toEqual([ended])
  })
})
