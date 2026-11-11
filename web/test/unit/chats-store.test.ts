// The chat store against a fake REST server (global fetch) and hand-made WebSocket events.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { CARD_NEWS_ARTIFACT_KEY, Chat, DECK_ARTIFACT_KEY, PROMO_ARTIFACT_KEY, uuidv7, type TurnStarted } from '@mycel/shared/api'
import { typingOnPhone } from '../../src/lib/sidePanel'
import { LOAD_RETRY_MS, PENDING_EVENTS_MAX, SEND_RETRY_MS, useChats } from '../../src/store/chats'
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

  test('Stop while the message is still on its way: the stop goes once the send returns its turn, never before', async () => {
    const s = started(null, 'hello')
    let answer!: (r: Response) => void
    route = (m, p) => {
      if (m === 'POST' && p === '/api/chats') return json(chat, 201)
      if (p.endsWith('/stop')) return json({ stopped: true, turnId: s.turnId })
      return new Promise<Response>((r) => { answer = r })
    }
    await useChats.getState().send({ chatId: null, content: 'hello', attachments: [], author: me })
    let stopped = false
    const stop = useChats.getState().stop(CHAT).then(() => { stopped = true })
    await tick(5)
    // a stop now would find no turn on the server and the answer would start anyway
    expect(calls.some((c) => c.path.endsWith('/stop'))).toBe(false)
    expect(stopped).toBe(false)
    answer(json({ ...s, queuePosition: 0 }, 202))
    await stop
    const order = calls.map((c) => c.path)
    expect(order.at(-1)).toBe(`/api/chats/${CHAT}/stop`)
    expect(order.indexOf(`/api/chats/${CHAT}/messages`)).toBeLessThan(order.length - 1)
  })

  test('Stop while a send fails: the stop still goes (nothing waits forever) and nothing else is sent', async () => {
    route = (m, p) => (p.endsWith('/stop') ? json({ stopped: false, turnId: null }) : json({ error: { code: 'limit', message: 'limit' } }, 429))
    useChats.setState({ threads: { [CHAT]: { messages: [], nextCursor: null, stale: false } } })
    const { sent } = await useChats.getState().send({ chatId: CHAT, content: 'hi', attachments: [], author: me })
    await useChats.getState().stop(CHAT)
    await sent.catch(() => {})
    expect(calls.map((c) => c.path)).toEqual([`/api/chats/${CHAT}/messages`, `/api/chats/${CHAT}/stop`])
  })

  test('Stop with nothing on its way stops at once', async () => {
    route = () => json({ stopped: true, turnId: uuidv7() })
    await useChats.getState().stop(CHAT)
    expect(calls.map((c) => c.path)).toEqual([`/api/chats/${CHAT}/stop`])
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

  test('a saved card news opens the panel by itself (no "writing" first, as from the team server); other saved artifacts do not', () => {
    const h = useChats.getState().handleEvent
    const saved = (key: string, version: number, seq: number) => h({ type: 'artifact.updated', seq, at: 0, data: { chatId: CHAT, messageId: null, key, type: 'html', title: 'Acme 카드뉴스', status: 'done', artifact: { id: uuidv7(), chatId: CHAT, messageId: null, key, version, type: 'html', title: 'Acme 카드뉴스', language: null, createdAt: '2026-11-05T00:00:00.000Z', size: 10 } } })
    saved('report', 1, 1)
    expect(useChats.getState().autoOpen).toBeNull()
    saved(CARD_NEWS_ARTIFACT_KEY, 1, 2)
    expect(useChats.getState().autoOpen).toMatchObject({ chatId: CHAT, key: 'card-news' })
    // used once (Layout clears it); the next version in the same session does not open it again over the person
    useChats.setState({ autoOpen: null })
    saved(CARD_NEWS_ARTIFACT_KEY, 2, 3)
    expect(useChats.getState().autoOpen).toBeNull()
  })

  test('a saved promo video (the welcome steps\' first result, docs/DECISIONS.md "V") opens the panel by itself too, once', () => {
    const h = useChats.getState().handleEvent
    const saved = (version: number, seq: number) => h({ type: 'artifact.updated', seq, at: 0, data: { chatId: CHAT, messageId: null, key: PROMO_ARTIFACT_KEY, type: 'html', title: 'Acme 홍보 영상', status: 'done', artifact: { id: uuidv7(), chatId: CHAT, messageId: null, key: PROMO_ARTIFACT_KEY, version, type: 'html', title: 'Acme 홍보 영상', language: null, createdAt: '2026-11-05T00:00:00.000Z', size: 10 } } })
    saved(1, 1)
    expect(useChats.getState().autoOpen).toMatchObject({ chatId: CHAT, key: 'promo-video' })
    useChats.setState({ autoOpen: null })
    saved(2, 2)
    expect(useChats.getState().autoOpen).toBeNull()
  })

  test('a saved intro deck (the welcome steps\' first result, docs/DECISIONS.md "D2") opens the panel by itself too, once', () => {
    const h = useChats.getState().handleEvent
    const saved = (version: number, seq: number) => h({ type: 'artifact.updated', seq, at: 0, data: { chatId: CHAT, messageId: null, key: DECK_ARTIFACT_KEY, type: 'html', title: 'Acme 회사 소개서', status: 'done', artifact: { id: uuidv7(), chatId: CHAT, messageId: null, key: DECK_ARTIFACT_KEY, version, type: 'html', title: 'Acme 회사 소개서', language: null, createdAt: '2026-11-06T00:00:00.000Z', size: 10 } } })
    saved(1, 1)
    expect(useChats.getState().autoOpen).toMatchObject({ chatId: CHAT, key: 'intro-deck' })
    useChats.setState({ autoOpen: null })
    saved(2, 2)
    expect(useChats.getState().autoOpen).toBeNull()
  })

  test('on a phone the sheet never opens over someone writing (focus alone is not writing)', () => {
    const g = globalThis as Record<string, unknown>
    const saved = { window: g.window, document: g.document }
    const set = (width: number, active: Record<string, unknown> | null) => {
      g.window = { matchMedia: (q: string) => ({ matches: q.includes('max-width: 767.98px') && width < 768 }) }
      g.document = { activeElement: active }
    }
    try {
      set(390, { tagName: 'TEXTAREA', value: '2장 사진 바꿔', isContentEditable: false })
      expect(typingOnPhone()).toBe(true)
      set(390, { tagName: 'INPUT', type: 'text', value: 'x', isContentEditable: false })
      expect(typingOnPhone()).toBe(true)
      set(390, { tagName: 'DIV', isContentEditable: true, textContent: 'x' })
      expect(typingOnPhone()).toBe(true)
      // the composer focused by itself, empty: the cards open
      set(390, { tagName: 'TEXTAREA', value: '  ', isContentEditable: false })
      expect(typingOnPhone()).toBe(false)
      set(390, { tagName: 'INPUT', type: 'checkbox', value: 'on', isContentEditable: false })
      expect(typingOnPhone()).toBe(false)
      set(390, { tagName: 'BODY', isContentEditable: false })
      expect(typingOnPhone()).toBe(false)
      set(390, null)
      expect(typingOnPhone()).toBe(false)
      // a computer: the panel opens beside the chat, writing or not
      set(1280, { tagName: 'TEXTAREA', value: 'x', isContentEditable: false })
      expect(typingOnPhone()).toBe(false)
    } finally {
      g.window = saved.window
      g.document = saved.document
    }
  })

  test('chat.updated keeps the list sorted and drops deleted chats', () => {
    const h = useChats.getState().handleEvent
    const older = { ...chat, id: uuidv7(), updatedAt: '2026-01-01T00:00:00.000Z' }
    h({ type: 'chat.updated', seq: 1, at: 0, data: { chatId: older.id, change: 'created', chat: older } })
    h({ type: 'chat.updated', seq: 2, at: 0, data: { chatId: chat.id, change: 'created', chat } })
    expect(useChats.getState().chats.map((c) => c.id)).toEqual([chat.id, older.id])
    h({ type: 'chat.updated', seq: 3, at: 0, data: { chatId: chat.id, change: 'deleted', chat: null } })
    expect(useChats.getState().chats.map((c) => c.id)).toEqual([older.id])
    // a chat in the trash is in no list, also when an 'updated' says so (the end of a turn after the delete)
    h({ type: 'chat.updated', seq: 4, at: 0, data: { chatId: older.id, change: 'updated', chat: { ...older, deletedAt: '2026-01-02T00:00:00.000Z' } } })
    expect(useChats.getState().chats).toEqual([])
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

describe('reloads while an answer streams', () => {
  const gets = () => calls.filter((c) => c.method === 'GET' && c.path === `/api/chats/${CHAT}/messages`).length
  /** REST answers that wait until `open()`: the page is read at that moment */
  function slowServer(page: () => unknown) {
    const waiting: (() => void)[] = []
    route = (_m, p) => {
      if (p.endsWith('/requests')) return json({ items: [] })
      if (p.endsWith('/queue')) return json({ state: 'idle', turnId: null, messageId: null, position: null })
      return new Promise<Response>((r) => waiting.push(() => r(json(page()))))
    }
    return () => { for (const w of waiting.splice(0)) w() }
  }
  const delta = (seq: number, messageId: string, offset: number, text: string) =>
    useChats.getState().handleEvent({ type: 'message.delta', seq, at: 0, data: { chatId: CHAT, messageId, offset, text } })

  test('opening a chat while its answer streams: the pieces that arrive during the read are kept, one read only', async () => {
    const a = msg({ role: 'assistant', status: 'streaming', content: '' })
    let saved = 'Hello'
    const open = slowServer(() => ({ items: [{ ...a, content: saved }], nextCursor: null }))
    const loading = useChats.getState().loadThread(CHAT)
    // the server saved "Hello" when it read the page; these went out meanwhile, the last one past the saved text
    delta(1, a.id, 3, 'lo')
    delta(2, a.id, 5, ' wor')
    delta(3, a.id, 9, 'ld')
    saved = 'Hello'
    open()
    await loading
    await tick()
    expect(useChats.getState().threads[CHAT]!.messages[0]!.content).toBe('Hello world')
    expect(gets()).toBe(1)
    expect(calls.length).toBe(3)
  })

  test('a gap during a reload that is running does not start a second one; the pieces are applied after it', async () => {
    const a = msg({ role: 'assistant', status: 'streaming', content: 'ab' })
    useChats.setState({ threads: { [CHAT]: { messages: [a], nextCursor: null, stale: false } } })
    const open = slowServer(() => ({ items: [{ ...a, content: 'abcdef' }], nextCursor: null }))
    delta(1, a.id, 4, 'ef') // gap: reload
    await tick()
    expect(gets()).toBe(1)
    for (let i = 0; i < 5; i++) delta(2 + i, a.id, 6 + i, String(i)) // more pieces while it runs
    await tick()
    expect(gets()).toBe(1)
    open()
    await tick()
    await tick()
    expect(useChats.getState().threads[CHAT]!.messages[0]!.content).toBe('abcdef01234')
    expect(gets()).toBe(1)
    expect(calls.length).toBe(3)
    expect(useChats.getState().threads[CHAT]!.stale).toBe(false)
  })

  test('a reload that answers after my send was answered is not used: the question and answer stay', async () => {
    const u = msg({ role: 'user', content: 'first' })
    const a = msg({ role: 'assistant', parentId: u.id, content: 'one' })
    useChats.setState({ threads: { [CHAT]: { messages: [u, a], nextCursor: null, stale: false } } })
    const s = started(a.id, 'second')
    let afterSend = false
    const waiting: (() => void)[] = []
    route = (m, p) => {
      if (m === 'POST') return json(s, 202)
      if (p.endsWith('/requests')) return json({ items: [] })
      if (p.endsWith('/queue')) return json({ state: 'idle', turnId: null, messageId: null, position: null })
      const items = afterSend ? [u, a, s.userMessage!, s.assistantMessage] : [u, a]
      return new Promise<Response>((r) => waiting.push(() => r(json({ items, nextCursor: null }))))
    }
    const loading = useChats.getState().loadThread(CHAT) // slow: read before the send
    await useChats.getState().send({ chatId: CHAT, content: 'second', attachments: [], author: me })
    await tick()
    afterSend = true
    for (const w of waiting.splice(0)) w() // the old read answers late
    await tick()
    expect(useChats.getState().threads[CHAT]!.messages.map((m) => m.id)).toEqual([u.id, a.id, s.userMessage!.id, s.assistantMessage.id])
    for (const w of waiting.splice(0)) w() // it read again, now with the new messages
    await loading
    expect(useChats.getState().threads[CHAT]!.messages.map((m) => m.id)).toEqual([u.id, a.id, s.userMessage!.id, s.assistantMessage.id])
    expect(gets()).toBe(2)
  })

  test('a branch switch is not undone by a reload that was on its way', async () => {
    const u = msg({ role: 'user', content: 'q' })
    const other = msg({ role: 'assistant', parentId: u.id, content: 'other branch' })
    const old = msg({ role: 'assistant', parentId: u.id, content: 'old branch' })
    useChats.setState({ threads: { [CHAT]: { messages: [u, old], nextCursor: null, stale: false } } })
    let switched = false
    const waiting: (() => void)[] = []
    route = (m, p) => {
      if (m === 'POST') { switched = true; return json({ items: [u, other], nextCursor: null }) }
      if (p.endsWith('/requests')) return json({ items: [] })
      if (p.endsWith('/queue')) return json({ state: 'idle', turnId: null, messageId: null, position: null })
      const items = switched ? [u, other] : [u, old]
      return new Promise<Response>((r) => waiting.push(() => r(json({ items, nextCursor: null }))))
    }
    const loading = useChats.getState().loadThread(CHAT) // read before the switch: the old branch
    await tick()
    await useChats.getState().selectBranch(CHAT, other.id)
    await tick()
    for (const w of waiting.splice(0)) w()
    await tick()
    for (const w of waiting.splice(0)) w()
    await loading
    expect(useChats.getState().threads[CHAT]!.messages.map((m) => m.id)).toEqual([u.id, other.id])
  })

  test('my own question and its answer coming over the socket do not reload the chat, and older messages stay', async () => {
    const older = msg({ role: 'user', content: 'older' })
    const a = msg({ role: 'assistant', parentId: older.id, content: 'one' })
    useChats.setState({ threads: { [CHAT]: { messages: [older, a], nextCursor: 'more', stale: false } } })
    const s = started(a.id, 'two')
    const user = { ...s.userMessage!, author: { id: me.id, name: me.name } }
    let release!: () => void
    route = () => new Promise<Response>((r) => (release = () => r(json({ ...s, userMessage: user }, 202))))
    await useChats.getState().send({ chatId: CHAT, content: 'two', attachments: [], author: me })
    const h = useChats.getState().handleEvent
    // the server's events come before the POST's answer
    h({ type: 'message.created', seq: 1, at: 0, data: { chatId: CHAT, message: user } })
    h({ type: 'message.created', seq: 2, at: 0, data: { chatId: CHAT, message: s.assistantMessage } })
    h({ type: 'message.delta', seq: 3, at: 0, data: { chatId: CHAT, messageId: s.assistantMessage.id, offset: 0, text: 'Hi' } })
    let t = useChats.getState().threads[CHAT]!
    expect(t.messages.map((m) => m.id)).toEqual([older.id, a.id, user.id, s.assistantMessage.id])
    expect(t.messages.at(-1)!.content).toBe('Hi')
    release()
    await tick()
    t = useChats.getState().threads[CHAT]!
    expect(t.messages.map((m) => m.id)).toEqual([older.id, a.id, user.id, s.assistantMessage.id])
    expect(t.messages.at(-1)!.content).toBe('Hi')
    expect(t.nextCursor).toBe('more')
    expect(calls.filter((c) => c.method === 'GET')).toEqual([])
  })

  test('asking to read again while a read is on its way reads once more after it (another person\'s turn ended meanwhile)', async () => {
    const a = msg({ role: 'assistant', status: 'streaming', content: '' })
    let ended = false
    const open = slowServer(() => ({ items: [ended ? { ...a, status: 'done', content: 'all' } : a], nextCursor: null }))
    const first = useChats.getState().loadThread(CHAT)
    await tick()
    ended = true // the read above was answered before this
    const second = useChats.getState().loadThread(CHAT)
    ended = false
    open()
    await tick()
    ended = true
    open()
    await Promise.all([first, second])
    expect(gets()).toBe(2)
    expect(useChats.getState().threads[CHAT]!.messages[0]!.content).toBe('all')
  })

  test('a read that fails: no read per piece held during it, what can be applied is, and one more read a moment later', async () => {
    const a = msg({ role: 'assistant', content: 'one' })
    const b = msg({ role: 'assistant', parentId: a.id, status: 'streaming', content: 'ab' })
    useChats.setState({ threads: { [CHAT]: { messages: [a, b], nextCursor: null, stale: false } } })
    let down = true
    const waiting: (() => void)[] = []
    route = (_m, p) => {
      if (!p.endsWith('/messages')) return json({ items: [] })
      if (!down) return json({ items: [a, b], nextCursor: null })
      return new Promise<Response>((r) => waiting.push(() => r(json({ error: { code: 'internal', message: 'down' } }, 500))))
    }
    delta(1, b.id, 4, 'ef') // gap: reload
    for (let i = 0; i < 10; i++) delta(2 + i, b.id, 6 + i, 'x')
    // a question from my phone during the read
    const phone = msg({ role: 'user', parentId: b.id, content: 'from the phone' })
    useChats.getState().handleEvent({ type: 'message.created', seq: 20, at: 0, data: { chatId: CHAT, message: phone } })
    for (const w of waiting.splice(0)) w()
    await tick()
    await tick()
    expect(gets()).toBe(1)
    const t = useChats.getState().threads[CHAT]!
    expect(t.stale).toBe(true)
    expect(t.messages.map((m) => m.id)).toEqual([a.id, b.id, phone.id])
    down = false
    await tick(LOAD_RETRY_MS + 100)
    expect(gets()).toBe(2)
    expect(useChats.getState().threads[CHAT]!.stale).toBe(false)
  })

  test('a message from another device after one I am still sending goes after the last saved one, no reload', () => {
    const a = msg({ role: 'assistant', content: 'one' })
    useChats.setState({ threads: { [CHAT]: { messages: [a], nextCursor: null, stale: false } } })
    route = () => new Promise<Response>(() => {})
    void useChats.getState().send({ chatId: CHAT, content: 'mine', attachments: [], author: me })
    const there = msg({ role: 'user', parentId: a.id, content: 'from the phone', author: { id: me.id, name: me.name } })
    useChats.getState().handleEvent({ type: 'message.created', seq: 1, at: 0, data: { chatId: CHAT, message: there } })
    const t = useChats.getState().threads[CHAT]!
    expect(t.messages.map((m) => m.content)).toEqual(['one', 'from the phone', 'mine'])
    expect(calls.filter((c) => c.method === 'GET')).toEqual([])
  })
})
