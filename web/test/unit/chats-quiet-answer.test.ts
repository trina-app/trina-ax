// QA TC-3521: an answer whose end never reached the page stayed on "Thinking…", and Stop did nothing (the server had
// nothing left to stop). Stop that finds nothing running reads the chat again; so does an answer nothing was heard
// about for QUIET_CHECK_MS.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { uuidv7, type TurnStarted } from '@mycel/shared/api'
import { QUIET_CHECK_MAX_MS, QUIET_CHECK_MS, useChats } from '../../src/store/chats'
import { CHAT, msg } from './fixtures'

const realFetch = globalThis.fetch
const realSetTimeout = globalThis.setTimeout
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
const tick = (ms = 0) => new Promise((r) => realSetTimeout(r, ms))
let calls: { method: string; path: string }[] = []
let route: (method: string, path: string) => Response | Promise<Response>
/** the waits the store asked for (the quiet checks run after 5 ms instead) */
let waits: number[] = []

beforeEach(() => {
  calls = []
  waits = []
  useChats.getState().reset()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://team.localhost')
    calls.push({ method: init?.method ?? 'GET', path: url.pathname })
    return route(init?.method ?? 'GET', url.pathname)
  }) as typeof fetch
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...a: unknown[]) => {
    if (ms !== undefined && ms >= QUIET_CHECK_MS && ms <= QUIET_CHECK_MAX_MS) { waits.push(ms); return realSetTimeout(fn, 5) }
    return realSetTimeout(fn, ms, ...a)
  }) as typeof setTimeout
})
afterEach(() => {
  useChats.getState().reset()
  globalThis.fetch = realFetch
  globalThis.setTimeout = realSetTimeout
})

const failed = (id: string, parentId: string) => msg({ id, role: 'assistant', parentId, status: 'error', error: { code: 'engine_unavailable', message: 'x', params: { reason: 'engine_start_failed' } } })
const reads = () => calls.filter((c) => c.method === 'GET' && c.path.endsWith('/messages')).length

describe('an answer whose end never reached the page (QA TC-3521)', () => {
  test('Stop that finds nothing running reads the chat again, and the answer shows how it ended', async () => {
    const q = msg({ role: 'user', content: 'add a seal' })
    const a = msg({ role: 'assistant', parentId: q.id, status: 'streaming' })
    useChats.setState({ threads: { [CHAT]: { messages: [q, a], nextCursor: null, stale: false } } })
    route = (_m, p) => p.endsWith('/stop') ? json({ stopped: false, turnId: null }) : p.endsWith('/messages') ? json({ items: [q, failed(a.id, q.id)], nextCursor: null }) : json({ items: [] })
    await useChats.getState().stop(CHAT)
    expect(calls.map((c) => c.path)).toContain(`/api/chats/${CHAT}/stop`)
    expect(reads()).toBe(1)
    expect(useChats.getState().threads[CHAT]!.messages.at(-1)!.status).toBe('error')
  })

  test('Stop that stopped the answer does not read again (its end comes over the socket)', async () => {
    const a = msg({ role: 'assistant', status: 'streaming' })
    useChats.setState({ threads: { [CHAT]: { messages: [a], nextCursor: null, stale: false } } })
    route = () => json({ stopped: true, turnId: uuidv7() })
    await useChats.getState().stop(CHAT)
    expect(reads()).toBe(0)
  })

  test('a running answer nothing is heard about is read again; once it ended there is no more reading', async () => {
    const q = msg({ role: 'user', content: 'add a seal' })
    const a = msg({ role: 'assistant', parentId: q.id, status: 'streaming', turnId: uuidv7() })
    const s: TurnStarted = { userMessage: q, assistantMessage: a, turnId: a.turnId!, queuePosition: 0 }
    let ended = false
    route = (m, p) => m === 'POST' ? json(s, 202) : p.endsWith('/messages') ? json({ items: [q, ended ? failed(a.id, q.id) : a], nextCursor: null }) : json({ items: [] })
    useChats.setState({ threads: { [CHAT]: { messages: [], nextCursor: null, stale: false } } })
    await useChats.getState().send({ chatId: CHAT, content: 'add a seal', attachments: [], author: { id: 'olga', name: 'Olga' } })
    await tick(1)
    expect(waits).toEqual([QUIET_CHECK_MS])
    // still running on the server at each read: each next wait is twice as long, up to the most
    await tick(40)
    expect(reads()).toBeGreaterThanOrEqual(2)
    expect(waits.slice(0, 3)).toEqual([QUIET_CHECK_MS, 2 * QUIET_CHECK_MS, 4 * QUIET_CHECK_MS])
    expect(Math.max(...waits)).toBe(QUIET_CHECK_MAX_MS)
    expect(useChats.getState().threads[CHAT]!.messages.at(-1)!.status).toBe('streaming')
    ended = true
    await tick(40)
    expect(useChats.getState().threads[CHAT]!.messages.at(-1)!.status).toBe('error')
    const n = reads()
    await tick(40)
    expect(reads()).toBe(n)
  })

  test('an answer whose end came over the socket is not read again', async () => {
    const q = msg({ role: 'user', content: 'hi' })
    const a = msg({ role: 'assistant', parentId: q.id, status: 'streaming', turnId: uuidv7() })
    const s: TurnStarted = { userMessage: q, assistantMessage: a, turnId: a.turnId!, queuePosition: 0 }
    route = (m) => m === 'POST' ? json(s, 202) : json({ items: [] })
    useChats.setState({ threads: { [CHAT]: { messages: [], nextCursor: null, stale: false } } })
    await useChats.getState().send({ chatId: CHAT, content: 'hi', attachments: [], author: { id: 'olga', name: 'Olga' } })
    await tick(1)
    useChats.getState().handleEvent({ type: 'message.done', seq: 1, at: 0, data: { chatId: CHAT, messageId: a.id, status: 'done', message: { ...a, status: 'done', content: 'hello' } } })
    await tick(40)
    expect(reads()).toBe(0)
  })
})
