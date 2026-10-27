import { afterEach, beforeEach, expect, test } from 'bun:test'
import { uuidv7, type ChatQueueSnapshot } from '@mycel/shared/api'
import { useChats } from '../../src/store/chats'
import { CHAT, msg } from './fixtures'

const originalFetch = globalThis.fetch
const assistant = msg({ role: 'assistant', status: 'streaming', turnId: uuidv7() })
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } })
const snapshot = (revision = 1, position = 3, epoch = 'server-one'): ChatQueueSnapshot => ({
  state: position ? 'queued' : 'running', turnId: assistant.turnId, messageId: assistant.id, position, epoch, revision,
})
let queueReply: () => Response | Promise<Response>
beforeEach(() => {
  useChats.getState().reset()
  queueReply = () => json(snapshot())
  globalThis.fetch = (async (url: any) => {
    const p = new URL(String(url), 'http://test.localhost').pathname
    if (p.endsWith('/queue')) return queueReply()
    if (p.endsWith('/requests')) return json({ items: [] })
    if (p === '/api/chats') return json({ items: [], nextCursor: null })
    return json({ items: [assistant], nextCursor: null })
  }) as unknown as typeof fetch
})
afterEach(() => { globalThis.fetch = originalFetch; useChats.getState().reset() })
const event = (s: ChatQueueSnapshot) => useChats.getState().handleEvent({
  type: 'queue.position', seq: s.revision, at: 0,
  data: { chatId: CHAT, turnId: s.turnId!, messageId: s.messageId!, position: s.position!, epoch: s.epoch, revision: s.revision },
})
const done = () => useChats.getState().handleEvent({ type: 'message.done', seq: 10, at: 0,
  data: { chatId: CHAT, messageId: assistant.id, status: 'done', message: { ...assistant, status: 'done', content: 'finished' } },
})

test('opening a chat and reconnecting restore its current estimated queue position', async () => {
  await useChats.getState().loadThread(CHAT)
  expect(useChats.getState().queue[assistant.id]).toBe(3)
  queueReply = () => json(snapshot(2, 2))
  await useChats.getState().reloadAll()
  expect(useChats.getState().queue[assistant.id]).toBe(2)
})

test('an older REST response cannot replace a newer socket revision', async () => {
  let resolve!: (r: Response) => void
  queueReply = () => new Promise(r => { resolve = r })
  const loading = useChats.getState().loadThread(CHAT)
  event(snapshot(3, 1))
  resolve?.(json(snapshot(2, 4)))
  await loading
  expect(useChats.getState().queue[assistant.id]).toBe(1)
})

test('a completion before opening the chat prevents late queue events and snapshots', async () => {
  done()
  event(snapshot(2, 4))
  await useChats.getState().loadThread(CHAT)
  expect(useChats.getState().queue[assistant.id]).toBeUndefined()
  expect(useChats.getState().threads[CHAT]!.messages.find(m => m.id === assistant.id)?.status).toBe('done')
})

test('late events from a retired server epoch cannot roll back the new server', async () => {
  event(snapshot(10, 4))
  event(snapshot(1, 2, 'server-two'))
  event(snapshot(11, 3))
  expect(useChats.getState().queue[assistant.id]).toBe(2)
})

test('a response started before an epoch change cannot replace that new epoch', async () => {
  let resolve!: (r: Response) => void
  queueReply = () => new Promise(r => { resolve = r })
  const loading = useChats.getState().loadThread(CHAT)
  event(snapshot(1, 2, 'server-two'))
  resolve?.(json(snapshot(20, 4)))
  await loading
  expect(useChats.getState().queue[assistant.id]).toBe(2)
})

test('logout discards in-flight queue and thread responses', async () => {
  let resolve!: (r: Response) => void
  queueReply = () => new Promise(r => { resolve = r })
  const loading = useChats.getState().loadThread(CHAT)
  useChats.getState().reset()
  resolve?.(json(snapshot()))
  await loading
  expect(useChats.getState().queue).toEqual({})
  expect(useChats.getState().threads).toEqual({})
})

test('actual output and terminal messages cannot regress to waiting', async () => {
  await useChats.getState().loadThread(CHAT)
  useChats.getState().handleEvent({ type: 'message.delta', seq: 2, at: 0,
    data: { chatId: CHAT, messageId: assistant.id, offset: 0, text: 'started' } })
  event(snapshot(3, 2))
  expect(useChats.getState().queue[assistant.id]).toBeUndefined()
  done()
  event(snapshot(4, 0))
  expect(useChats.getState().queue[assistant.id]).toBeUndefined()
})

test('a POST computed before completion cannot restore a streaming answer or a queue badge', async () => {
  let resolve!: (r: Response) => void
  const userMessage = msg({ role: 'user', content: 'question' })
  globalThis.fetch = (async () => new Promise<Response>(r => { resolve = r })) as unknown as typeof fetch
  useChats.setState({ threads: { [CHAT]: { messages: [assistant], nextCursor: null, stale: false } } })
  await useChats.getState().send({ chatId: CHAT, content: 'question', attachments: [], author: { id: 'u', name: 'U' } })
  done()
  resolve(json({ userMessage, assistantMessage: assistant, turnId: assistant.turnId, queuePosition: 3, queueEpoch: 'server-one', queueRevision: 1 }))
  await Bun.sleep(0)
  expect(useChats.getState().queue[assistant.id]).toBeUndefined()
  expect(useChats.getState().threads[CHAT]!.messages.find(m => m.id === assistant.id)).toMatchObject({ status: 'done', content: 'finished' })
})

test('a late POST cannot overwrite a newer socket rank', async () => {
  let resolve!: (r: Response) => void
  const userMessage = msg({ role: 'user', content: 'question' })
  globalThis.fetch = (async () => new Promise<Response>(r => { resolve = r })) as unknown as typeof fetch
  await useChats.getState().send({ chatId: CHAT, content: 'question', attachments: [], author: { id: 'u', name: 'U' } })
  event(snapshot(4, 1))
  resolve(json({ userMessage, assistantMessage: assistant, turnId: assistant.turnId, queuePosition: 3, queueEpoch: 'server-one', queueRevision: 2 }))
  await Bun.sleep(0)
  expect(useChats.getState().queue[assistant.id]).toBe(1)
})

test('a POST cannot erase text and steps already delivered to a known streaming answer', async () => {
  let resolve!: (r: Response) => void
  globalThis.fetch = (async () => new Promise<Response>(r => { resolve = r })) as unknown as typeof fetch
  const userMessage = msg({ role: 'user', content: 'question' })
  useChats.setState({ threads: { [CHAT]: { messages: [assistant], nextCursor: null, stale: false } } })
  await useChats.getState().send({ chatId: CHAT, content: 'question', attachments: [], author: { id: 'u', name: 'U' } })
  useChats.getState().handleEvent({ type: 'message.delta', seq: 1, at: 0,
    data: { chatId: CHAT, messageId: assistant.id, offset: 0, text: 'already visible' } })
  const step = { id: 's1', kind: 'tool' as const, label: 'Checking', status: 'ok' as const, startedAt: new Date().toISOString(), endedAt: new Date().toISOString() }
  useChats.getState().handleEvent({ type: 'message.step', seq: 2, at: 0, data: { chatId: CHAT, messageId: assistant.id, step } })
  resolve(json({ userMessage, assistantMessage: assistant, turnId: assistant.turnId, queuePosition: 3, queueEpoch: 'server-one', queueRevision: 1 }))
  await Bun.sleep(0)
  expect(useChats.getState().threads[CHAT]!.messages.find(m => m.id === assistant.id)).toMatchObject({ content: 'already visible', steps: [step] })
})
