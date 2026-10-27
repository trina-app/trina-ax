// The chat store against a fake REST server (global fetch) and hand-made WebSocket events.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Chat, uuidv7, type TurnStarted } from '@mycel/shared/api'
import { PENDING_EVENTS_MAX, SEND_RETRY_MS, useChats } from '../../src/store/chats'
import { CHAT, msg } from './fixtures'

const realFetch = globalThis.fetch
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
const chat = Chat.parse({ id: CHAT, projectId: null, title: 't', engine: 'claude-code', model: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null, runState: 'idle' })
const me = { id: 'olga', name: 'Olga' }

let calls: { method: string; path: string; body: any }[] = []
let route: (method: string, path: string, body: any) => Response | Promise<Response>

beforeEach(() => {
  calls = []
  useChats.getState().reset()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://team.localhost')
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, body })
    expect(new Headers(init?.headers).get('x-mycel-window')).toBeTruthy()
    return route(init?.method ?? 'GET', url.pathname, body)
  }) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
})

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

function started(parentId: string | null, content: string): TurnStarted {
  const userMessage = msg({ role: 'user', parentId, content })
  return { userMessage, assistantMessage: msg({ role: 'assistant', parentId: userMessage.id, status: 'streaming', turnId: uuidv7() }), turnId: uuidv7(), queuePosition: 2 }
}

describe('sending', () => {
  test('a new chat: create, optimistic message, then the saved messages and queue position', async () => {
    const s = started(null, 'hello')
    route = (m, p) => (m === 'POST' && p === '/api/chats' ? json(chat, 201) : json(s, 202))
    const { chatId } = await useChats.getState().send({ chatId: null, content: 'hello', attachments: [], author: me })
    expect(chatId).toBe(CHAT)
    // optimistic first
    expect(useChats.getState().threads[CHAT]!.messages[0]!.local?.state).toBe('sending')
    await tick()
    const t = useChats.getState().threads[CHAT]!
    expect(t.messages.map((m) => m.id)).toEqual([s.userMessage!.id, s.assistantMessage.id])
    expect(useChats.getState().queue[s.assistantMessage.id]).toBe(2)
    expect(calls[1]!.body.clientMessageId).toMatch(/^[0-9a-f-]{36}$/)
    expect(useChats.getState().chats[0]!.runState).toBe('queued')
  })

  test('team files no longer available: the message says so, marks them, and "send again" sends without them', async () => {
    const gone = uuidv7()
    const kept = uuidv7()
    const team = (id: string, name: string) => ({ id, name, path: `shared/${name}`, size: 3, mime: 'text/plain', kind: 'text' as const, source: 'team' as const })
    const s = started(null, 'two files')
    let n = 0
    route = (_m, _p, body) => {
      if (++n === 1) return json({ error: { code: 'validation', message: 'A team file you added is no longer available to you. Send again to send the message without it.', params: { reason: 'team_files_unavailable', ids: gone } } }, 400)
      expect(body.attachmentIds).toEqual([kept])
      return json(s, 202)
    }
    useChats.setState({ threads: { [CHAT]: { messages: [], nextCursor: null, stale: false } } })
    await useChats.getState().send({ chatId: CHAT, content: 'two files', attachments: [team(gone, 'a.txt'), team(kept, 'b.txt')], author: me })
    await tick()
    const local = useChats.getState().threads[CHAT]!.messages[0]!
    expect(local.local?.state).toBe('failed')
    expect(local.attachments.find((a) => a.id === gone)).toMatchObject({ unavailable: true, name: '', path: '' })
    expect(local.attachments.find((a) => a.id === kept)).toMatchObject({ name: 'b.txt' })
    await useChats.getState().resend(CHAT, local.id)
    expect(n).toBe(2)
  })

  test('network failures are retried with the same clientMessageId', async () => {
    const s = started(null, 'hi')
    let n = 0
    route = () => {
      if (++n < 3) throw new TypeError('Failed to fetch')
      return json(s, 202)
    }
    useChats.setState({ threads: { [CHAT]: { messages: [], nextCursor: null, stale: false } } })
    await useChats.getState().send({ chatId: CHAT, content: 'hi', attachments: [], author: me })
    await tick(3500)
    expect(calls).toHaveLength(3)
    expect(new Set(calls.map((c) => c.body.clientMessageId)).size).toBe(1)
    expect(useChats.getState().threads[CHAT]!.messages.some((m) => m.local)).toBe(false)
  }, 10_000)

  test('a server refusal marks the message "not sent"; resend keeps the same id', async () => {
    route = () => json({ error: { code: 'budget_exceeded', message: 'limit' } }, 429)
    useChats.setState({ threads: { [CHAT]: { messages: [], nextCursor: null, stale: false } } })
    await useChats.getState().send({ chatId: CHAT, content: 'hi', attachments: [], author: me })
    await tick()
    const local = useChats.getState().threads[CHAT]!.messages[0]!
    expect(local.local).toMatchObject({ state: 'failed', error: 'limit' })
    const s = started(null, 'hi')
    route = () => json(s, 202)
    await useChats.getState().resend(CHAT, local.id)
    expect(calls[0]!.body.clientMessageId).toBe(calls[1]!.body.clientMessageId)
    expect(useChats.getState().threads[CHAT]!.messages[0]!.id).toBe(s.userMessage!.id)
    expect(SEND_RETRY_MS).toBe(30_000)
  })
})

describe('events', () => {
  test('deltas that arrive before the POST answer are kept and applied', async () => {
    const s = started(null, 'q')
    let release!: () => void
    route = () => new Promise<Response>((r) => (release = () => r(json(s, 202))))
    useChats.setState({ threads: { [CHAT]: { messages: [], nextCursor: null, stale: false } } })
    await useChats.getState().send({ chatId: CHAT, content: 'q', attachments: [], author: me })
    const h = useChats.getState().handleEvent
    h({ type: 'message.delta', seq: 1, at: 0, data: { chatId: CHAT, messageId: s.assistantMessage.id, offset: 0, text: 'Hel' } })
    h({ type: 'message.delta', seq: 2, at: 0, data: { chatId: CHAT, messageId: s.assistantMessage.id, offset: 3, text: 'lo' } })
    release()
    await tick()
    const a = useChats.getState().threads[CHAT]!.messages.at(-1)!
    expect(a.content).toBe('Hello')
    // first delta clears the queue position
    expect(useChats.getState().queue[s.assistantMessage.id]).toBeUndefined()
  })

  test('a gap reloads the thread from REST', async () => {
    const a = msg({ role: 'assistant', status: 'streaming', content: 'abc' })
    useChats.setState({ threads: { [CHAT]: { messages: [a], nextCursor: null, stale: false } } })
    route = (_m, p) => (p.endsWith('/requests') ? json({ items: [] }) : json({ items: [{ ...a, content: 'abcdefgh' }], nextCursor: null }))
    useChats.getState().handleEvent({ type: 'message.delta', seq: 1, at: 0, data: { chatId: CHAT, messageId: a.id, offset: 6, text: 'gh' } })
    await tick()
    expect(calls.map((c) => c.path).sort()).toEqual([`/api/chats/${CHAT}/messages`, `/api/chats/${CHAT}/queue`, `/api/chats/${CHAT}/requests`])
    expect(useChats.getState().threads[CHAT]!.messages[0]!.content).toBe('abcdefgh')
  })

  test('ask_user requests open and close; answering posts to the turn', async () => {
    const turnId = uuidv7()
    const messageId = uuidv7()
    const h = useChats.getState().handleEvent
    h({ type: 'turn.request', seq: 1, at: 0, data: { turnId, chatId: CHAT, messageId, request: { kind: 'ask_user', requestId: 'r1', question: 'Q?' } } })
    expect(Object.keys(useChats.getState().requests)).toEqual(['r1'])
    route = () => new Response(null, { status: 204 })
    await useChats.getState().answer('r1', { kind: 'ask_user', answer: 'yes' })
    expect(calls[0]).toEqual({ method: 'POST', path: `/api/turns/${turnId}/answer`, body: { kind: 'ask_user', answer: 'yes', requestId: 'r1' } })
    expect(useChats.getState().requests).toEqual({})
    h({ type: 'turn.request', seq: 2, at: 0, data: { turnId, chatId: CHAT, messageId, request: { kind: 'ask_user', requestId: 'r2', question: 'Q?' } } })
    h({ type: 'turn.request.closed', seq: 3, at: 0, data: { turnId, requestId: 'r2', reason: 'timeout' } })
    expect(useChats.getState().requests).toEqual({})
  })

  test('loading a thread brings back the open cards of its running turn (page reload, resync)', async () => {
    const turnId = uuidv7()
    const messageId = uuidv7()
    const card = (requestId: string, chatId = CHAT) => ({ turnId, chatId, messageId, request: { kind: 'ask_user' as const, requestId, question: 'Q?' } })
    const other = uuidv7()
    // r-gone was open before but the server no longer lists it (closed while we were away); another chat's card stays
    useChats.setState({ requests: { 'r-gone': card('r-gone'), 'r-other': card('r-other', other) } })
    route = (_m, p) => (p.endsWith('/requests') ? json({ items: [card('r-open')] }) : json({ items: [], nextCursor: null }))
    await useChats.getState().loadThread(CHAT)
    expect(Object.keys(useChats.getState().requests).sort()).toEqual(['r-open', 'r-other'])
  })

  test('cards that open or close over the socket while the list is on its way are not undone by it', async () => {
    const turnId = uuidv7()
    const messageId = uuidv7()
    const card = (requestId: string) => ({ turnId, chatId: CHAT, messageId, request: { kind: 'ask_user' as const, requestId, question: 'Q?' } })
    const h = useChats.getState().handleEvent
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    route = async (_m, p) => {
      if (!p.endsWith('/requests')) return json({ items: [], nextCursor: null })
      await gate
      return json({ items: [card('r-closing')] }) // computed before r-closing closed and before r-new opened
    }
    const loading = useChats.getState().loadThread(CHAT)
    await tick()
    h({ type: 'turn.request', seq: 1, at: 0, data: { turnId, chatId: CHAT, messageId, request: card('r-new').request } })
    h({ type: 'turn.request.closed', seq: 2, at: 0, data: { turnId, requestId: 'r-closing', reason: 'answered' } })
    release()
    await loading
    expect(Object.keys(useChats.getState().requests)).toEqual(['r-new'])
  })

  test('artifact writing opens the panel once and keeps the code; done bumps the list', () => {
    const h = useChats.getState().handleEvent
    const base = { chatId: CHAT, messageId: null, key: 'k', type: 'html' as const, title: 'T' }
    h({ type: 'artifact.updated', seq: 1, at: 0, data: { ...base, status: 'writing', content: '<h1>', artifact: null } })
    const first = useChats.getState().autoOpen
    expect(first).toMatchObject({ chatId: CHAT, key: 'k' })
    h({ type: 'artifact.updated', seq: 2, at: 0, data: { ...base, status: 'writing', content: '<h1>Hi', artifact: null } })
    expect(useChats.getState().autoOpen).toBe(first)
    expect(useChats.getState().liveArtifacts[CHAT]!.k!.content).toBe('<h1>Hi')
    h({ type: 'artifact.updated', seq: 3, at: 0, data: { ...base, status: 'done', artifact: null } })
    expect(useChats.getState().artifactsRev[CHAT]).toBe(1)
    expect(useChats.getState().liveArtifacts[CHAT]!.k!.status).toBe('done')
  })

  test('chat.updated keeps the list sorted and drops deleted chats', () => {
    const h = useChats.getState().handleEvent
    const older = { ...chat, id: uuidv7(), updatedAt: '2026-01-01T00:00:00.000Z' }
    h({ type: 'chat.updated', seq: 1, at: 0, data: { chatId: older.id, change: 'created', chat: older } })
    h({ type: 'chat.updated', seq: 2, at: 0, data: { chatId: chat.id, change: 'created', chat } })
    expect(useChats.getState().chats.map((c) => c.id)).toEqual([chat.id, older.id])
    h({ type: 'chat.updated', seq: 3, at: 0, data: { chatId: chat.id, change: 'deleted', chat: null } })
    expect(useChats.getState().chats.map((c) => c.id)).toEqual([older.id])
  })
})

describe('robustness', () => {
  test('sending in a chat whose messages are not loaded yet answers under the server\'s active leaf, not a new root', async () => {
    const s = started(uuidv7(), 'hi')
    route = () => json(s, 202)
    await useChats.getState().send({ chatId: CHAT, content: 'hi', attachments: [], author: me })
    await tick()
    const post = calls.find((c) => c.method === 'POST')!
    expect('parentId' in post.body).toBe(false)
  })

  test('sending after the thread loaded answers under the last message shown', async () => {
    const last = msg({ role: 'assistant', status: 'done' })
    useChats.setState({ threads: { [CHAT]: { messages: [last], nextCursor: null, stale: false } } })
    route = () => json(started(last.id, 'next'), 202)
    await useChats.getState().send({ chatId: CHAT, content: 'next', attachments: [], author: me })
    await tick()
    expect(calls.find((c) => c.method === 'POST')!.body.parentId).toBe(last.id)
  })

  test('events for a message that never shows up are bounded; past the cap the thread reloads from REST', async () => {
    useChats.setState({ threads: { [CHAT]: { messages: [], nextCursor: null, stale: false } } })
    route = () => json({ items: [], nextCursor: null })
    const ghost = uuidv7()
    let seq = 0
    for (let i = 0; i <= PENDING_EVENTS_MAX; i++) useChats.getState().handleEvent({ type: 'message.delta', seq: ++seq, at: 0, data: { chatId: CHAT, messageId: ghost, offset: i, text: 'x' } } as never)
    await tick()
    expect(calls.filter((c) => c.method === 'GET' && c.path === `/api/chats/${CHAT}/messages`).length).toBe(1)
  })
})
