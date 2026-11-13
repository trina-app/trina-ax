// store/chatGroups.ts: the Trina list listens for changes of my chats only while it is on screen (panels/TrinaList.tsx).
// A change while it is not (a phone's /new or a chat; a computer's 트리나 panel hidden) marks the groups stale, so the
// list shown again reads at once instead of keeping its 5 s rule: a new chat made on /new was missing from the 트리나
// list after Back until a reload (found by phone-home-projects.spec.ts).
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { readChatGroups, useChatGroups } from '../../src/store/chatGroups'
import { chatChanged, navFoldersChanged } from '../../src/store/live'

const groups = { pinned: [], folders: [], projects: [], projectsMore: 0, other: { items: [], nextCursor: null } }
let reads = 0
const realFetch = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (new URL(String(input), 'http://x').pathname === '/api/chats/groups') reads++
    return new Response(JSON.stringify(groups), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
})
beforeEach(() => {
  useChatGroups.getState().reset()
  reads = 0
})

// the list on show again (TrinaList's first read)
const shownAgain = () => readChatGroups({ minAgeMs: 5_000 })

test('shown again soon after a read with nothing changed: no second read', async () => {
  await shownAgain()
  await shownAgain()
  expect(reads).toBe(1)
  expect(useChatGroups.getState().groups).not.toBeNull()
})

test('a chat of mine changed while the list was not on screen: shown again, it reads at once', async () => {
  await shownAgain()
  chatChanged.emit({ chatId: 'c1', change: 'updated' } as never)
  await shownAgain()
  expect(reads).toBe(2)
  // read once: not stale any more
  await shownAgain()
  expect(reads).toBe(2)
})

test('my chat folders changed: stale too; a change of room folders is not', async () => {
  await shownAgain()
  navFoldersChanged.emit('rooms')
  await shownAgain()
  expect(reads).toBe(1)
  navFoldersChanged.emit('chats')
  await shownAgain()
  expect(reads).toBe(2)
})

test("someone else's shared chat I never wrote in does not make it stale", async () => {
  await shownAgain()
  chatChanged.emit({ chatId: 'c2', change: 'updated', chat: { shared: { mine: false } } } as never)
  await shownAgain()
  expect(reads).toBe(1)
})
