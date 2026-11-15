// QA TC-2260: while an update migrates the database the server answers 503 "updating" (server/src/system/
// migrate-start.ts). One place in the window knows it (lib/serverUpdating.ts) and asks /api/health until it answers;
// a message sent meanwhile waits with a note and goes once when the server is back, with the same clientMessageId.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ApiError, uuidv7, type TurnStarted } from '@mycel/shared/api'
import { api, API, isConnectionError, isServerUpdating } from '../../src/lib/api'
import { setServerUpdatingDeps, useServerUpdating, waitsForUpdate, whenServerBack } from '../../src/lib/serverUpdating'
import { useChats } from '../../src/store/chats'
import { CHAT, msg } from './fixtures'

const realFetch = globalThis.fetch
const json = (v: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } })
/** what the update's stand-in answers an API call */
const updating = () => json({ error: { code: 'unavailable', message: 'Trina is updating. It will be back in a few minutes.', params: { reason: 'updating' } } }, 503, { 'x-mycel-updating': '1', 'retry-after': '30' })
const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms))

let route: (method: string, path: string, body: any) => Response | Promise<Response>
let calls: { method: string; path: string; body: any }[] = []
/** the health check the wait asks (true: the server is back) */
let healthy: boolean | null = false
let healthAsks = 0

beforeEach(() => {
  calls = []
  healthy = false
  healthAsks = 0
  useChats.getState().reset()
  setServerUpdatingDeps({ sleep: () => tick(1), health: async () => { healthAsks++; if (healthy === null) throw new TypeError('Failed to fetch'); return healthy } })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://team.localhost')
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, body })
    return route(init?.method ?? 'GET', url.pathname, body)
  }) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
  setServerUpdatingDeps(null)
})

describe('an answer that says Trina is updating', () => {
  test('the stand-in\'s 503 becomes reason "updating": a connection error that passes by itself, and the wait starts', async () => {
    route = () => updating()
    const e = await api.call(API.listChats, { query: { limit: 5 } }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ApiError)
    expect(isServerUpdating(e)).toBe(true)
    expect(isConnectionError(e)).toBe(true)
    expect(waitsForUpdate(e)).toBe(true)
    expect(useServerUpdating.getState().updating).toBe(true)
  })

  test('the relay while a hosted team\'s server is updated (team_maintenance) says the same', async () => {
    route = () => json({ error: { code: 'unavailable', message: 'The team server is being updated' } }, 503, { 'x-relay-error': 'team_maintenance' })
    const e = await api.call(API.listChats, { query: { limit: 5 } }).catch((x: unknown) => x)
    expect(isServerUpdating(e)).toBe(true)
  })

  test('another 503 is not "updating"', async () => {
    route = () => json({ error: { code: 'unavailable', message: 'busy' } }, 503)
    const e = await api.call(API.listChats, { query: { limit: 5 } }).catch((x: unknown) => x)
    expect(isServerUpdating(e)).toBe(false)
    expect(useServerUpdating.getState().updating).toBe(false)
    // no answer at all is not "updating" either, unless an update is known
    expect(waitsForUpdate(new TypeError('Failed to fetch'))).toBe(false)
  })

  test('the wait ends when /api/health answers OK; no answer meanwhile (the new version taking over) is still waiting', async () => {
    route = () => updating()
    await api.call(API.listChats, { query: { limit: 5 } }).catch(() => {})
    let back = false
    void whenServerBack().then(() => { back = true })
    healthy = null // no answer
    await tick(20)
    expect(back).toBe(false)
    expect(waitsForUpdate(new TypeError('Failed to fetch'))).toBe(true)
    healthy = true
    await tick(20)
    expect(back).toBe(true)
    expect(useServerUpdating.getState().updating).toBe(false)
    // one wait however many answers said it
    const asked = healthAsks
    await tick(20)
    expect(healthAsks).toBe(asked)
  })
})

describe('a message sent while Trina is updating', () => {
  function started(content: string): TurnStarted {
    const userMessage = msg({ role: 'user', parentId: null, content })
    return { userMessage, assistantMessage: msg({ role: 'assistant', parentId: userMessage.id, status: 'streaming', turnId: uuidv7() }), turnId: uuidv7(), queuePosition: 0 }
  }

  test('waits on screen with the "updating" note, then goes once with the same clientMessageId', async () => {
    const s = started('hello')
    let down = true
    route = (m, p) => {
      if (m === 'POST' && p === `/api/chats/${CHAT}/messages`) return down ? updating() : json(s, 202)
      return json({}, 404)
    }
    useChats.setState({ threads: { [CHAT]: { messages: [], nextCursor: null, stale: false } } })
    await useChats.getState().send({ chatId: CHAT, content: 'hello', attachments: [], author: { id: 'olga', name: 'Olga' } })
    await tick(20)
    const local = useChats.getState().threads[CHAT]!.messages[0]!
    // still on its way (never "not sent"), with the note
    expect(local.local).toMatchObject({ state: 'sending', updating: true })
    const posts = () => calls.filter((c) => c.method === 'POST')
    // nothing is sent again while the server says it is updating: the wait asks /api/health, not the message
    expect(posts()).toHaveLength(1)
    // the update is done
    down = false
    healthy = true
    await tick(30)
    expect(posts()).toHaveLength(2)
    expect(posts()[1]!.body.clientMessageId).toBe(posts()[0]!.body.clientMessageId)
    expect(useChats.getState().threads[CHAT]!.messages.map((m) => m.id)).toEqual([s.userMessage!.id, s.assistantMessage.id])
    await tick(30)
    expect(posts()).toHaveLength(2)
  })

  test('a message let go while it waits is not sent when the server is back', async () => {
    route = () => updating()
    useChats.setState({ threads: { [CHAT]: { messages: [], nextCursor: null, stale: false } } })
    await useChats.getState().send({ chatId: CHAT, content: 'never mind', attachments: [], author: { id: 'olga', name: 'Olga' } })
    await tick(20)
    const local = useChats.getState().threads[CHAT]!.messages[0]!
    useChats.getState().discardLocal(CHAT, local.id)
    healthy = true
    await tick(30)
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1)
  })
})
