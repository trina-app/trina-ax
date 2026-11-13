// Pin and unpin show at once (lib/optimistic.ts; docs/DECISIONS.md "Optimistic changes: the screen first, the server
// after"): a Trina chat (components/chat/chatActions.ts togglePin: 최근 기록, 고정 and a list's own copy) and a room
// (store/rooms.ts setPinned) change before the server answers; a refusal puts the pin back with one toast; a list read
// that was asked before the pin does not move the row back.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { Chat, type ChatGroups, type Me } from '@mycel/shared/api'
import { useChatActions } from '../../src/components/chat/chatActions'
import { useLocaleStore } from '../../src/i18n'
import { resetOptimistic } from '../../src/lib/optimistic'
import { readChatGroups, useChatGroups } from '../../src/store/chatGroups'
import { useChats } from '../../src/store/chats'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { installDom, mount, removeDom } from './dom-host'
import { ME, room } from './rooms-fixtures'

setDefaultTimeout(30_000)
const ID = '01900000-0000-7000-8000-0000000000c2'
const me = {
  user: { id: ME.id, username: ME.id, name: ME.name, email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko', chatTrashRetentionDays: 14 }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted' },
} as unknown as Me
const chat = (pinnedAt?: string) => Chat.parse({
  id: ID, projectId: null, title: 'Acme board summary', engine: 'claude-code', model: null,
  createdAt: '2026-11-08T00:00:00.000Z', updatedAt: '2026-11-08T00:00:00.000Z', deletedAt: null, runState: 'idle', ...(pinnedAt ? { pinnedAt } : {}),
})
const groups = (pinned: Chat[]): ChatGroups => ({ pinned, folders: [], projects: [], projectsMore: 0, other: { items: [], nextCursor: null }, projectActivity: [] } as unknown as ChatGroups)
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })

/** requests waiting for the test's answer, by "METHOD path" */
const waiting: { key: string; answer: (r: Response) => void }[] = []
const take = (key: string) => {
  const i = waiting.findIndex((w) => w.key === key)
  if (i < 0) throw new Error(`no request ${key}; waiting: ${waiting.map((w) => w.key).join(', ')}`)
  return waiting.splice(i, 1)[0]!
}
const tick = () => new Promise((r) => setTimeout(r, 0))
const toasts = () => (useUi.getState() as unknown as { toasts: { level: string; text: string }[] }).toasts

const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((answer) => waiting.push({ key: `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`, answer }))) as unknown as typeof fetch
})
afterEach(() => {
  waiting.length = 0
  resetOptimistic()
  useChats.getState().reset()
  useChatGroups.getState().reset()
  useRooms.getState().reset()
  useUi.setState({ toasts: [] } as never)
})
afterAll(() => {
  globalThis.fetch = realFetch
  useSession.setState({ status })
  useLocaleStore.setState({ locale })
  removeDom()
})

/** the chat actions, as a menu has them */
async function chatActions() {
  const out: { actions?: ReturnType<typeof useChatActions> } = {}
  function Probe() {
    out.actions = useChatActions()
    return null
  }
  const m = await mount(<MemoryRouter><Probe /></MemoryRouter>)
  return { actions: out.actions!, unmount: m.unmount }
}
const listed = () => useChats.getState().chats.find((c) => c.id === ID)

test('a chat pinned: in 고정 and out of 최근 기록 before the server answers; the answer settles it', async () => {
  useChats.setState({ chats: [chat()], chatsLoaded: true })
  useChatGroups.setState({ groups: groups([]) })
  const { actions, unmount } = await chatActions()
  try {
    const shown: (string | undefined)[] = []
    const done = actions.togglePin(chat(), (c) => shown.push(c.pinnedAt))
    // at once: the store's row has a pin (최근 기록 leaves it out) and 고정 has it
    expect(listed()?.pinnedAt).toBeTruthy()
    expect(useChatGroups.getState().groups!.pinned.map((c) => c.id)).toEqual([ID])
    expect(shown).toHaveLength(1)
    await tick()
    take(`POST /api/chats/${ID}/pin`).answer(json(chat('2026-11-13T01:00:00.000Z')))
    expect((await done)?.pinnedAt).toBe('2026-11-13T01:00:00.000Z')
    expect(listed()?.pinnedAt).toBe('2026-11-13T01:00:00.000Z')
    expect(useChatGroups.getState().groups!.pinned[0]!.pinnedAt).toBe('2026-11-13T01:00:00.000Z')
    expect(shown.at(-1)).toBe('2026-11-13T01:00:00.000Z')
  } finally {
    await unmount()
  }
})

test('a refused pin (50 pins): back where it was, the server\'s words in one toast', async () => {
  useChats.setState({ chats: [chat()], chatsLoaded: true })
  useChatGroups.setState({ groups: groups([]) })
  const { actions, unmount } = await chatActions()
  try {
    const done = actions.togglePin(chat())
    await tick()
    take(`POST /api/chats/${ID}/pin`).answer(json({ error: { code: 'conflict', message: 'Up to 50 pins.' } }, 409))
    expect(await done).toBeNull()
    expect(listed()?.pinnedAt).toBeUndefined()
    expect(useChatGroups.getState().groups!.pinned).toEqual([])
    expect(toasts().map((x) => x.text)).toEqual(['Up to 50 pins.'])
  } finally {
    await unmount()
  }
})

test('an unpin: out of 고정 at once; a groups read asked before it does not put it back, it reads again', async () => {
  const was = chat('2026-11-12T00:00:00.000Z')
  useChats.setState({ chats: [was], chatsLoaded: true })
  useChatGroups.setState({ groups: groups([was]) })
  const read = readChatGroups()
  await tick()
  const { actions, unmount } = await chatActions()
  try {
    const done = actions.togglePin(was)
    expect(useChatGroups.getState().groups!.pinned).toEqual([])
    // the read from before the unpin answers with the pin: not written
    take('GET /api/chats/groups').answer(json(groups([was])))
    await read
    expect(useChatGroups.getState().groups!.pinned).toEqual([])
    take(`DELETE /api/chats/${ID}/pin`).answer(json(chat()))
    await done
    // the read once more, after it
    await tick()
    take('GET /api/chats/groups').answer(json(groups([])))
    await tick()
    expect(useChatGroups.getState().groups!.pinned).toEqual([])
    expect(listed()?.pinnedAt).toBeUndefined()
  } finally {
    await unmount()
  }
})

test('a room pinned: first in the list before the server answers; a list read meanwhile keeps the pin', async () => {
  const r = room({ name: 'acme' })
  useRooms.setState({ rooms: [r], loaded: true })
  const done = useRooms.getState().setPinned(r.id, true)
  expect(useRooms.getState().rooms[0]!.pinnedAt).toBeTruthy()
  const load = useRooms.getState().loadRooms()
  await tick()
  take('GET /api/rooms').answer(json({ items: [r] }))
  await load
  expect(useRooms.getState().rooms[0]!.pinnedAt).toBeTruthy()
  take(`POST /api/rooms/${r.id}/pin`).answer(json({ ...r, pinnedAt: '2026-11-13T02:00:00.000Z' }))
  await done
  expect(useRooms.getState().rooms[0]!.pinnedAt).toBe('2026-11-13T02:00:00.000Z')
})

test('a room unpin that fails: the pin comes back, with the network words', async () => {
  const r = room({ name: 'acme', pinnedAt: '2026-11-12T00:00:00.000Z' })
  useRooms.setState({ rooms: [r], loaded: true })
  const done = useRooms.getState().setPinned(r.id, false)
  expect(useRooms.getState().rooms[0]!.pinnedAt).toBeUndefined()
  await tick()
  take(`DELETE /api/rooms/${r.id}/pin`).answer(json({ error: { code: 'internal', message: 'Something went wrong.' } }, 500))
  await done
  expect(useRooms.getState().rooms[0]!.pinnedAt).toBe('2026-11-12T00:00:00.000Z')
  expect(toasts()).toHaveLength(1)
  expect(toasts()[0]!.level).toBe('error')
})

test("a chat's event from before the pin's answer (a turn running) keeps the pin on screen; the answer then writes", async () => {
  useChats.setState({ chats: [chat()], chatsLoaded: true })
  useChatGroups.setState({ groups: groups([]) })
  const { actions, unmount } = await chatActions()
  try {
    const done = actions.togglePin(chat())
    useChats.getState().handleEvent({ type: 'chat.updated', data: { chatId: ID, change: 'updated', chat: { ...chat(), runState: 'running' } } } as never)
    expect(listed()?.pinnedAt).toBeTruthy()
    expect(listed()?.runState).toBe('running')
    await tick()
    take(`POST /api/chats/${ID}/pin`).answer(json(chat('2026-11-13T01:00:00.000Z')))
    await done
    // answered: the events after it write the server's copy as before
    useChats.getState().handleEvent({ type: 'chat.updated', data: { chatId: ID, change: 'updated', chat: chat('2026-11-13T01:00:00.000Z') } } as never)
    expect(listed()?.pinnedAt).toBe('2026-11-13T01:00:00.000Z')
  } finally {
    await unmount()
  }
})

test('a groups read asked after the tap but answered before the pin: the row stays in 고정', async () => {
  useChats.setState({ chats: [chat()], chatsLoaded: true })
  useChatGroups.setState({ groups: groups([]) })
  const { actions, unmount } = await chatActions()
  try {
    const done = actions.togglePin(chat())
    const read = readChatGroups()
    await tick()
    take('GET /api/chats/groups').answer(json(groups([])))
    await read
    expect(useChatGroups.getState().groups!.pinned.map((c) => c.id)).toEqual([ID])
    take(`POST /api/chats/${ID}/pin`).answer(json(chat('2026-11-13T01:00:00.000Z')))
    await done
    expect(useChatGroups.getState().groups!.pinned.map((c) => c.pinnedAt)).toEqual(['2026-11-13T01:00:00.000Z'])
  } finally {
    await unmount()
  }
})

test('another person signs in while a pin is on its way: its answer writes nothing', async () => {
  const r = room({ name: 'acme' })
  useRooms.setState({ rooms: [r], loaded: true })
  const done = useRooms.getState().setPinned(r.id, true)
  await tick()
  resetOptimistic()
  useRooms.setState({ rooms: [{ ...r }], loaded: true })
  take(`POST /api/rooms/${r.id}/pin`).answer(json({ ...r, pinnedAt: '2026-11-13T02:00:00.000Z' }))
  await done
  expect(useRooms.getState().rooms[0]!.pinnedAt).toBeUndefined()
})
