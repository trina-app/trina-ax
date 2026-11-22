// A message sent while offline (QA TC-r2d-06): it stays "sending", is kept on this device over a reload, and goes by
// itself once the connection is back, in a chat and in a room. Never silently lost.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { uuidv7, type Me, type TurnStarted } from '@mycel/shared/api'
import { connectionDown, whenConnected } from '../../src/lib/connectionWait'
import { readUnsentChat } from '../../src/lib/unsentChats'
import { useChats } from '../../src/store/chats'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { CHAT, msg } from './fixtures'
import { ME, message, room } from './rooms-fixtures'

const realFetch = globalThis.fetch
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const stored = new Map<string, string>()
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
const me = { id: ME.id, name: ME.name }
let calls: { method: string; path: string; body: any }[] = []
let route: (method: string, path: string, body: any) => Response | Promise<Response>

beforeEach(() => {
  stored.clear()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v), removeItem: (k: string) => void stored.delete(k),
    key: (i: number) => [...stored.keys()][i] ?? null, get length() { return stored.size },
  } })
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: ME.id, name: ME.name } } as unknown as Me } })
  useChats.getState().reset()
  useRooms.getState().reset()
  useUi.setState({ conn: 'open' })
  calls = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://team.localhost')
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, body })
    return route(init?.method ?? 'GET', url.pathname, body)
  }) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
  useChats.getState().reset()
  useRooms.getState().reset()
  useUi.setState({ conn: 'idle' })
  useSession.setState({ status: { kind: 'loading' } })
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor)
  else Reflect.deleteProperty(globalThis, 'localStorage')
})

function started(parentId: string | null, content: string): TurnStarted {
  const userMessage = msg({ role: 'user', parentId, content, author: me })
  return { userMessage, assistantMessage: msg({ role: 'assistant', parentId: userMessage.id, status: 'streaming', turnId: uuidv7() }), turnId: uuidv7(), queuePosition: 0 }
}

describe('connection wait', () => {
  test('down while the live connection is offline or reconnecting; settles when it opens', async () => {
    useUi.setState({ conn: 'offline' })
    expect(connectionDown()).toBe(true)
    let back = false
    void whenConnected().then(() => { back = true })
    await tick()
    expect(back).toBe(false)
    useUi.setState({ conn: 'reconnecting' })
    await tick()
    expect(back).toBe(false)
    useUi.setState({ conn: 'open' })
    await tick()
    expect(back).toBe(true)
  })

  test('a state that never changes still tries again after the recheck time', async () => {
    useUi.setState({ conn: 'offline' })
    let back = false
    void whenConnected(5).then(() => { back = true })
    await tick(20)
    expect(back).toBe(true)
  })
})

describe('chat', () => {
  test('sent offline: stays "sending", kept on the device, and goes once the connection is back under the newest end', async () => {
    const answer = msg({ role: 'assistant', content: 'earlier' })
    useChats.setState({ threads: { [CHAT]: { messages: [answer], nextCursor: null, stale: false } } })
    useUi.setState({ conn: 'offline' })
    let online = false
    const s = started(answer.id, '확인할게요')
    route = () => { if (!online) throw new TypeError('Failed to fetch'); return json(s, 202) }
    await useChats.getState().send({ chatId: CHAT, content: '확인할게요', attachments: [], author: me })
    await tick(10)
    const local = useChats.getState().threads[CHAT]!.messages.find((m) => m.local)!
    expect(local.local?.state).toBe('sending')
    // marked as waiting for the connection: a shared chat's box lets go of the text (pages/Chat.tsx)
    expect(local.local?.offline).toBe(true)
    // one try, then it waits for the connection (no "not sent" however long)
    expect(calls).toHaveLength(1)
    expect(readUnsentChat(ME.id, CHAT)).toMatchObject([{ content: '확인할게요', after: answer.id }])
    online = true
    useUi.setState({ conn: 'open' })
    await tick(10)
    expect(calls).toHaveLength(2)
    expect(calls[1]!.body).toMatchObject({ clientMessageId: calls[0]!.body.clientMessageId, after: answer.id })
    expect(calls[1]!.body.parentId).toBeUndefined()
    expect(useChats.getState().threads[CHAT]!.messages.some((m) => m.local)).toBe(false)
    expect(readUnsentChat(ME.id, CHAT)).toEqual([])
  })

  test('a reload while it is on its way: the chat opened again shows it and sends it by itself, with the same id', async () => {
    const answer = msg({ role: 'assistant', content: 'earlier' })
    useChats.setState({ threads: { [CHAT]: { messages: [answer], nextCursor: null, stale: false } } })
    useUi.setState({ conn: 'offline' })
    route = () => { throw new TypeError('Failed to fetch') }
    await useChats.getState().send({ chatId: CHAT, content: 'kept', attachments: [], author: me })
    await tick(10)
    const cid = calls[0]!.body.clientMessageId
    // the page goes (the store starts empty), the device keeps the send
    useChats.getState().reset()
    expect(readUnsentChat(ME.id, CHAT)).toHaveLength(1)
    useUi.setState({ conn: 'open' })
    calls = []
    const s = started(answer.id, 'kept')
    route = (m, p) => {
      if (m === 'GET' && p === `/api/chats/${CHAT}/messages`) return json({ items: [answer], nextCursor: null })
      if (m === 'GET') return json({ items: [] })
      return json(s, 202)
    }
    await useChats.getState().loadThread(CHAT)
    await tick(10)
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.body).toMatchObject({ clientMessageId: cid, content: 'kept', after: answer.id })
    expect(useChats.getState().threads[CHAT]!.messages.map((m) => m.id)).toEqual([answer.id, s.userMessage!.id, s.assistantMessage.id])
    expect(readUnsentChat(ME.id, CHAT)).toEqual([])
  })

  test('one the server already has (its answer was lost when the page went): sent again, the server copy stays in its place', async () => {
    const answer = msg({ role: 'assistant', content: 'earlier' })
    useChats.setState({ threads: { [CHAT]: { messages: [answer], nextCursor: null, stale: false } } })
    useUi.setState({ conn: 'offline' })
    route = () => { throw new TypeError('Failed to fetch') }
    await useChats.getState().send({ chatId: CHAT, content: 'landed', attachments: [], author: me })
    await tick(10)
    useChats.getState().reset()
    useUi.setState({ conn: 'open' })
    calls = []
    const saved = msg({ role: 'user', parentId: answer.id, content: 'landed', author: me })
    const reply = msg({ role: 'assistant', parentId: saved.id, content: 'echo' })
    const later = msg({ role: 'user', parentId: reply.id, content: 'later', author: me })
    route = (m, p) => {
      if (m === 'GET' && p === `/api/chats/${CHAT}/messages`) return json({ items: [answer, saved, reply, later], nextCursor: null })
      if (m === 'GET') return json({ items: [] })
      return json({ userMessage: saved, assistantMessage: reply, turnId: uuidv7(), queuePosition: 0 }, 202)
    }
    await useChats.getState().loadThread(CHAT)
    await tick(10)
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1)
    expect(useChats.getState().threads[CHAT]!.messages.map((m) => m.id)).toEqual([answer.id, saved.id, reply.id, later.id])
    expect(readUnsentChat(ME.id, CHAT)).toEqual([])
  })

  test('a send that did not go comes back after a reload as "not sent", and "send again" sends it', async () => {
    route = () => json({ error: { code: 'budget_exceeded', message: 'limit' } }, 429)
    useChats.setState({ threads: { [CHAT]: { messages: [], nextCursor: null, stale: false } } })
    await useChats.getState().send({ chatId: CHAT, content: 'over', attachments: [], author: me })
    await tick(10)
    useChats.getState().reset()
    route = (m) => (m === 'GET' ? json({ items: [], nextCursor: null }) : json({ error: { code: 'budget_exceeded', message: 'limit' } }, 429))
    calls = []
    await useChats.getState().loadThread(CHAT)
    await tick(10)
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
    const local = useChats.getState().threads[CHAT]!.messages.find((m) => m.local)!
    expect(local.local).toMatchObject({ state: 'failed', error: 'limit' })
    const s = started(null, 'over')
    route = () => json(s, 202)
    await useChats.getState().resend(CHAT, local.id)
    expect(useChats.getState().threads[CHAT]!.messages.some((m) => m.local)).toBe(false)
    expect(readUnsentChat(ME.id, CHAT)).toEqual([])
  })
})

describe('room', () => {
  test('sent offline: stays on its way and goes once the connection is back, with the same client id', async () => {
    const r = room()
    useRooms.setState({ rooms: [r], loaded: true })
    useUi.setState({ conn: 'offline' })
    let online = false
    route = (_m, _p, body) => {
      if (!online) throw new TypeError('Failed to fetch')
      return json(message({ roomId: r.id, seq: 1, author: me, body: body.body, clientMessageId: body.clientMessageId }))
    }
    useRooms.getState().send(r.id, { body: '확인할게요', mentions: [], files: [] })
    await tick(10)
    expect(useRooms.getState().pending[r.id]).toMatchObject([{ body: '확인할게요', state: 'sending' }])
    expect(calls).toHaveLength(1)
    online = true
    useUi.setState({ conn: 'open' })
    await tick(10)
    expect(calls).toHaveLength(2)
    expect(calls[1]!.body.clientMessageId).toBe(calls[0]!.body.clientMessageId)
    expect(useRooms.getState().pending[r.id]).toBeUndefined()
  })

  test('a reload while it is on its way: the room opened again sends it by itself', async () => {
    const r = room()
    useRooms.setState({ rooms: [r], loaded: true })
    useUi.setState({ conn: 'offline' })
    route = () => { throw new TypeError('Failed to fetch') }
    useRooms.getState().open(r.id)
    useRooms.getState().send(r.id, { body: 'kept', mentions: [], files: [] })
    await tick(10)
    const cid = calls.find((c) => c.method === 'POST')!.body.clientMessageId
    useRooms.getState().reset()
    useUi.setState({ conn: 'open' })
    calls = []
    route = (m, p, body) => {
      if (m === 'POST' && p === `/api/rooms/${r.id}/messages`) return json(message({ roomId: r.id, seq: 1, author: me, body: body.body, clientMessageId: body.clientMessageId }))
      if (m === 'GET' && p === `/api/rooms/${r.id}/messages`) return json({ items: [], nextCursor: null, newerCursor: null })
      return json({ items: [] })
    }
    useRooms.setState({ rooms: [r], loaded: true })
    useRooms.getState().open(r.id)
    await tick(20)
    const post = calls.find((c) => c.method === 'POST' && c.path === `/api/rooms/${r.id}/messages`)
    expect(post?.body).toMatchObject({ body: 'kept', clientMessageId: cid })
  })
})
