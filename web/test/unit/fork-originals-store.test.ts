// store/chats.ts readOriginals: a continuation whose original no page has brought (the original is far older than the
// pages read) gets it in one read, GET /api/chats?ids=, so it sits under it (docs/decisions/20261127-fork-in-history.md).
// Every parent of such a row is asked once; one the server leaves out (hidden, deleted, no longer mine) is not asked
// again until the list is read from its start, and the continuation stands alone. A read from the start keeps the
// originals page 1 still points to while it asks again.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { uuidv7, type Chat } from '@mycel/shared/api'
import { missingOriginals, useChats } from '../../src/store/chats'

// the server checks ids (UUIDv7): each letter stands for one, and back
const idOf = new Map<string, string>()
const nameOf = new Map<string, string>()
const id = (n: string) => { if (!idOf.has(n)) { const x = uuidv7(); idOf.set(n, x); nameOf.set(x, n) } return idOf.get(n)! }
const names = (ids: readonly string[]) => ids.map((x) => nameOf.get(x) ?? x)
const chat = (n: string, forkParents?: string[], updatedAt = '2026-11-27T09:00:00.000Z'): Chat =>
  ({ id: id(n), projectId: null, title: n, engine: 'claude-code', model: null, createdAt: updatedAt, updatedAt, deletedAt: null, runState: 'idle', ...(forkParents ? { forkParents: forkParents.map(id) } : {}) })

let page: Chat[] = []
/** an older server: `ids` ignored, its first page answered */
let older: Chat[] | null = null
const known: Record<string, Chat> = {}
const asked: string[][] = []
const realFetch = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = new URL(String(input), 'http://x')
    const body = (() => {
      if (u.pathname !== '/api/chats') return {}
      const ids = u.searchParams.get('ids')
      if (ids && older) { asked.push(names(ids.split(','))); return { items: older, nextCursor: null } }
      if (ids) { asked.push(names(ids.split(','))); return { items: names(ids.split(',')).flatMap((n) => (known[n] ? [known[n]] : [])), nextCursor: null } }
      return { items: u.searchParams.get('unread') ? [] : page, nextCursor: null }
    })()
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
})
afterAll(() => { globalThis.fetch = realFetch })
beforeEach(() => {
  useChats.getState().reset()
  page = []
  older = null
  asked.length = 0
  for (const k of Object.keys(known)) delete known[k]
})

test('which ids: every parent of a row none of whose parents is in the list, once', () => {
  const list = [chat('F', ['A', 'R']), chat('G', ['B']), chat('B'), chat('H', ['X'])]
  expect(names(missingOriginals(list, new Set()))).toEqual(['A', 'R', 'X'])
  expect(names(missingOriginals(list, new Set([id('A'), id('R')])))).toEqual(['X'])
})

test('a missing original is read by ids and joins the list; one the server leaves out is not asked again', async () => {
  page = [chat('F', ['A']), chat('B'), chat('K', ['H'])]
  known.A = chat('A', undefined, '2026-09-01T09:00:00.000Z')
  await useChats.getState().loadChats(true)
  await Bun.sleep(10)
  expect(asked).toEqual([['A', 'H']])
  expect(names(useChats.getState().chats.map((c) => c.id))).toEqual(['F', 'B', 'K', 'A'])
  // H (hidden from my list, say) never came: not asked again while the list is not read from its start
  await useChats.getState().readOriginals()
  expect(asked).toEqual([['A', 'H']])
  expect(names(useChats.getState().chats.map((c) => c.id))).toEqual(['F', 'B', 'K', 'A'])
  // read from its start again (a reload): asked again, once
  await useChats.getState().loadChats(true)
  await Bun.sleep(10)
  expect(asked).toEqual([['A', 'H'], ['A', 'H']])
  expect(names(useChats.getState().chats.map((c) => c.id))).toEqual(['F', 'B', 'K', 'A'])
})

test('an older server that ignores ids and answers its first page: nothing but the asked ids joins the list', async () => {
  page = [chat('F', ['A'])]
  // its first page as that server reads it now: one chat the list here does not hold (say, on its way to the trash)
  older = [chat('F', ['A']), chat('Z')]
  await useChats.getState().loadChats(true)
  await Bun.sleep(10)
  expect(asked).toEqual([['A']])
  expect(names(useChats.getState().chats.map((c) => c.id))).toEqual(['F'])
})

// a read from the start (a reconnect's reloadAll, the access_changed notice) brings only page 1: the originals its
// continuations point to keep their old copy while ?ids= asks again, so no continuation jumps to 오늘 alone and back;
// one the server now leaves out goes
test('a reload from the start keeps the fetched originals until ?ids= answers, and drops one it leaves out', async () => {
  page = [chat('F', ['A']), chat('G', ['C']), chat('B')]
  known.A = chat('A', undefined, '2026-09-01T09:00:00.000Z')
  known.C = chat('C', undefined, '2026-08-01T09:00:00.000Z')
  await useChats.getState().loadChats(true)
  await Bun.sleep(10)
  expect(names(useChats.getState().chats.map((c) => c.id))).toEqual(['F', 'G', 'B', 'A', 'C'])
  // C is hidden from my list meanwhile; A is renamed
  delete known.C
  known.A = { ...chat('A', undefined, '2026-09-01T09:00:00.000Z'), title: 'A renamed' }
  await useChats.getState().loadChats(true)
  // right after page 1: both originals still there (the old copies), under their continuations
  expect(names(useChats.getState().chats.map((c) => c.id))).toEqual(['F', 'G', 'B', 'A', 'C'])
  await Bun.sleep(10)
  expect(asked.at(-1)!.sort()).toEqual(['A', 'C'])
  expect(names(useChats.getState().chats.map((c) => c.id))).toEqual(['F', 'G', 'B', 'A'])
  expect(useChats.getState().chats.find((c) => c.id === id('A'))!.title).toBe('A renamed')
})

test('a reload keeps nothing a continuation on page 1 does not point to', async () => {
  page = [chat('F', ['A'])]
  known.A = chat('A', undefined, '2026-09-01T09:00:00.000Z')
  await useChats.getState().loadChats(true)
  await Bun.sleep(10)
  page = [chat('B')]
  await useChats.getState().loadChats(true)
  expect(names(useChats.getState().chats.map((c) => c.id))).toEqual(['B'])
})
