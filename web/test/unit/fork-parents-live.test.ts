// QA 11-27: a continuation left its chat in the history after a live update (a reply, a rename with "···", the same in
// another tab, a new continuation heard live) until a reload. The server's chat.updated to the chat's own person now says
// where it rows (Chat.forkParents, [] for a top-level row); the stores (store/chats.ts, store/projectPage.ts) keep the
// parents they know when an event says nothing of them (an older server), make none up, and drop them on [] (a detach
// in another window): lib/forkTree.ts withForkParents.
import { beforeEach, describe, expect, test } from 'bun:test'
import { uuidv7, type Chat, type ServerEvent } from '@mycel/shared/api'
import { useChats } from '../../src/store/chats'
import { withChatEvent } from '../../src/store/projectPage'
import { forkRows, withForkParents } from '../../src/lib/forkTree'

const A = uuidv7()
const F = uuidv7()
const chat = (id: string, o: Partial<Chat> = {}): Chat =>
  ({ id, projectId: null, title: id === A ? 'Plan' : 'Plan (continued)', engine: 'claude-code', model: null, createdAt: '2026-11-27T09:00:00.000Z', updatedAt: '2026-11-27T09:00:00.000Z', deletedAt: null, runState: 'idle', ...o })
let seq = 0
const updated = (c: Chat, change: 'created' | 'updated' = 'updated'): ServerEvent => ({ type: 'chat.updated', seq: ++seq, at: 0, data: { chatId: c.id, change, chat: c } } as ServerEvent)
const heard = (c: Chat, change?: 'created' | 'updated') => useChats.getState().handleEvent(updated(c, change))
const row = (id: string) => useChats.getState().chats.find((c) => c.id === id)
const depthOf = (id: string) => forkRows(useChats.getState().chats).find((r) => r.chat.id === id)?.depth

beforeEach(() => {
  useChats.getState().reset()
  useChats.setState({ chats: [chat(F, { forkParents: [A], updatedAt: '2026-11-27T09:05:00.000Z' }), chat(A)], chatsLoaded: true })
})

describe('store/chats.ts chat.updated', () => {
  test('a message sent in the continuation: the event says its parents, or nothing of them (an older server); it stays under its chat', () => {
    heard(chat(F, { forkParents: [A], runState: 'running', updatedAt: '2026-11-27T10:00:00.000Z' }))
    expect(row(F)?.forkParents).toEqual([A])
    expect(depthOf(F)).toBe(1)
    heard(chat(F, { runState: 'idle', updatedAt: '2026-11-27T10:01:00.000Z' }))
    expect(row(F)?.forkParents).toEqual([A])
    expect(row(F)?.runState).toBe('idle')
    expect(depthOf(F)).toBe(1)
  })

  test('a rename ("···", here or in another tab): the new name, still under its chat', () => {
    heard(chat(F, { title: 'Budget follow-up', updatedAt: '2026-11-27T10:02:00.000Z' }))
    expect(row(F)?.title).toBe('Budget follow-up')
    expect(row(F)?.forkParents).toEqual([A])
    expect(depthOf(F)).toBe(1)
  })

  test('a new continuation heard live sits under its chat at once; none is made up for a chat that has none', () => {
    const G = uuidv7()
    heard(chat(G, { forkParents: [F, A], updatedAt: '2026-11-27T10:03:00.000Z' }), 'created')
    expect(row(G)?.forkParents).toEqual([F, A])
    expect(depthOf(G)).toBe(1)
    const top = uuidv7()
    heard(chat(top, { updatedAt: '2026-11-27T10:04:00.000Z' }), 'created')
    expect('forkParents' in row(top)!).toBe(false)
    heard(chat(top, { forkParents: [], updatedAt: '2026-11-27T10:05:00.000Z' }))
    expect('forkParents' in row(top)!).toBe(false)
    // the original itself, told about, stays a row of its own
    heard(chat(A, { forkParents: [], updatedAt: '2026-11-27T10:06:00.000Z' }))
    expect('forkParents' in row(A)!).toBe(false)
    expect(depthOf(A)).toBe(0)
  })

  test('a detach in another window ([]): the row stands at the top, in the list\'s own shape', () => {
    heard(chat(F, { forkParents: [] }))
    expect(row(F) && 'forkParents' in row(F)!).toBe(false)
    expect(depthOf(F)).toBe(0)
    // and a later event that says nothing of it brings none back
    heard(chat(F, { title: 'Alone' }))
    expect(row(F) && 'forkParents' in row(F)!).toBe(false)
  })
})

describe('store/projectPage.ts withChatEvent (a project\'s page)', () => {
  const P = uuidv7()
  test('keeps known parents, takes new ones, drops them on []', () => {
    const cur = [chat(F, { projectId: P, forkParents: [A] }), chat(A, { projectId: P })]
    const sent = withChatEvent(cur, P, { chatId: F, change: 'updated', chat: chat(F, { projectId: P, title: 'Renamed' }) })
    expect(sent.find((c) => c.id === F)).toMatchObject({ title: 'Renamed', forkParents: [A] })
    const gone = withChatEvent(sent, P, { chatId: F, change: 'updated', chat: chat(F, { projectId: P, forkParents: [] }) })
    expect('forkParents' in gone.find((c) => c.id === F)!).toBe(false)
  })
})

test('withForkParents: given wins, absent keeps, nothing invented', () => {
  expect(withForkParents({ forkParents: [A] }, chat(F)).forkParents).toEqual([A])
  expect(withForkParents({ forkParents: [A] }, chat(F, { forkParents: [F] })).forkParents).toEqual([F])
  expect('forkParents' in withForkParents(undefined, chat(F))).toBe(false)
  expect('forkParents' in withForkParents({}, chat(F))).toBe(false)
})
