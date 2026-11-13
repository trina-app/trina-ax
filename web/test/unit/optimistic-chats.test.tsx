// Trina chats, history and list folders show each change at once (lib/optimistic.ts; docs/DECISIONS.md "Optimistic
// changes: the screen first, the server after"): a chat's rename, its trash and restore, its engine, its project and its
// list folder (components/chat/chatActions.ts, components/chat/ChatProject.tsx moveChat), and a list folder's create,
// rename and delete (store/navFolders.ts) change before the server answers; a refusal puts them back with one toast;
// a read or an event from before the change does not undo it on screen.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { Chat, uuidv7, type ChatGroups, type Me, type NavFolder } from '@mycel/shared/api'
import { changeChat, trashChat, undoDelete, useChatActions } from '../../src/components/chat/chatActions'
import { moveChat } from '../../src/components/chat/ChatProject'
import { DialogHost } from '../../src/components/ui'
import { api, API } from '../../src/lib/api'
import { useLocaleStore } from '../../src/i18n'
import { resetOptimistic } from '../../src/lib/optimistic'
import { readChatGroups, useChatGroups } from '../../src/store/chatGroups'
import { useChats } from '../../src/store/chats'
import { createFolder, deleteFolder, fileChat, fileRoom, readNavFolders, renameFolder, useNavFolders } from '../../src/store/navFolders'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { installDom, mount, removeDom } from './dom-host'
import { ME, room } from './rooms-fixtures'

setDefaultTimeout(30_000)
const ID = '01900000-0000-7000-8000-0000000000c3'
const OTHER = '01900000-0000-7000-8000-0000000000c4'
const PROJECT = '01900000-0000-7000-8000-0000000000d1'
const FOLDER = '01900000-0000-7000-8000-0000000000e1'
const me = {
  user: { id: ME.id, username: ME.id, name: ME.name, email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko', chatTrashRetentionDays: 14 }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted' },
} as unknown as Me
const chat = (o: Partial<Chat> = {}) => Chat.parse({
  id: ID, projectId: null, title: 'Acme board summary', engine: 'claude-code', model: null,
  createdAt: '2026-11-08T00:00:00.000Z', updatedAt: '2026-11-08T00:00:00.000Z', deletedAt: null, runState: 'idle', ...o,
})
const older = chat({ id: OTHER, title: 'Acme older', updatedAt: '2026-11-09T00:00:00.000Z' })
const groups = (pinned: Chat[]): ChatGroups => ({ pinned, folders: [], projects: [], projectsMore: 0, other: { items: [], nextCursor: null }, projectActivity: [] } as unknown as ChatGroups)
const folder = (o: Partial<NavFolder> = {}): NavFolder => ({ id: FOLDER, kind: 'rooms', name: 'Acme team', position: 0, count: 0, top: [], ...o })
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
const refused = (message: string, code = 409) => json({ error: { code: code === 409 ? 'conflict' : 'internal', message } }, code)

/** requests waiting for the test's answer, by "METHOD path" */
const waiting: { key: string; body: unknown; answer: (r: Response) => void }[] = []
const take = (key: string) => {
  const i = waiting.findIndex((w) => w.key === key)
  if (i < 0) throw new Error(`no request ${key}; waiting: ${waiting.map((w) => w.key).join(', ')}`)
  return waiting.splice(i, 1)[0]!
}
const tick = async (n = 1) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
}
const toasts = () => (useUi.getState() as unknown as { toasts: { level: string; text: string }[] }).toasts
const listed = (id = ID) => useChats.getState().chats.find((c) => c.id === id)
const event = (c: Chat, change = 'updated') => useChats.getState().handleEvent({ type: 'chat.updated', data: { chatId: c.id, change, chat: c } } as never)

const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((answer) => waiting.push({ key: `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`, body: init?.body ? JSON.parse(String(init.body)) : undefined, answer }))) as unknown as typeof fetch
})
afterEach(() => {
  waiting.length = 0
  resetOptimistic()
  useChats.getState().reset()
  useChatGroups.getState().reset()
  useRooms.getState().reset()
  useNavFolders.getState().reset()
  useUi.setState({ toasts: [] } as never)
})
afterAll(() => {
  globalThis.fetch = realFetch
  useSession.setState({ status })
  useLocaleStore.setState({ locale })
  removeDom()
})

/** the chat actions, as a menu has them, with the dialogs they open */
async function chatActions() {
  const out: { actions?: ReturnType<typeof useChatActions> } = {}
  function Probe() {
    out.actions = useChatActions()
    return null
  }
  const m = await mount(<MemoryRouter><Probe /><DialogHost /></MemoryRouter>)
  return { actions: out.actions!, m }
}

test('rename: the new name and the row at the top of 최근 기록 before the server answers; an event from before keeps it; the answer settles it', async () => {
  useChats.setState({ chats: [older, chat()], chatsLoaded: true })
  const { actions, m } = await chatActions()
  try {
    const shown: string[] = []
    const done = actions.rename(chat(), (c) => shown.push(c.title))
    await m.until(() => m.find('dialog-input'), 'the name field')
    await m.type('dialog-input', '  Acme Q4 plan ')
    await m.click('dialog-confirm')
    expect(listed()?.title).toBe('Acme Q4 plan')
    expect(useChats.getState().chats[0]!.id).toBe(ID)
    expect(shown).toEqual(['Acme Q4 plan'])
    // a turn's event from before the rename: the name on screen stays
    event({ ...chat(), runState: 'running' })
    expect(listed()?.title).toBe('Acme Q4 plan')
    expect(useChats.getState().chats[0]!.id).toBe(ID)
    await tick()
    const req = take(`PATCH /api/chats/${ID}`)
    expect(req.body).toEqual({ title: 'Acme Q4 plan' })
    req.answer(json(chat({ title: 'Acme Q4 plan', updatedAt: '2026-11-13T01:00:00.000Z' })))
    expect((await done)?.title).toBe('Acme Q4 plan')
    expect(listed()?.updatedAt).toBe('2026-11-13T01:00:00.000Z')
    expect(toasts()).toEqual([])
  } finally {
    await m.unmount()
  }
})

test('rename refused: the old name and place come back, the server\'s words in one toast', async () => {
  useChats.setState({ chats: [older, chat()], chatsLoaded: true })
  const { actions, m } = await chatActions()
  try {
    const done = actions.rename(chat())
    await m.until(() => m.find('dialog-input'), 'the name field')
    await m.type('dialog-input', 'Acme Q4 plan')
    await m.click('dialog-confirm')
    expect(listed()?.title).toBe('Acme Q4 plan')
    await tick()
    take(`PATCH /api/chats/${ID}`).answer(refused('Only its creator can rename it.', 403))
    expect(await done).toBeNull()
    expect(listed()?.title).toBe('Acme board summary')
    expect(useChats.getState().chats.map((c) => c.id)).toEqual([OTHER, ID])
    expect(toasts().map((x) => x.text)).toEqual(['Only its creator can rename it.'])
  } finally {
    await m.unmount()
  }
})

test('delete: out of 최근 기록 and 고정 right after the confirm; a list read from before does not bring it back; "deleted" with Undo once the server has it', async () => {
  const pinned = chat({ pinnedAt: '2026-11-12T00:00:00.000Z' })
  useChats.setState({ chats: [pinned], chatsLoaded: true })
  useChatGroups.setState({ groups: groups([pinned]) })
  const { actions, m } = await chatActions()
  try {
    const done = actions.remove(pinned)
    await m.until(() => m.find('dialog-confirm'), 'the confirm')
    await m.click('dialog-confirm')
    expect(listed()).toBeUndefined()
    expect(useChatGroups.getState().groups!.pinned).toEqual([])
    // a list read and a groups read asked before the delete answered, both with the chat
    const load = useChats.getState().loadChats(true)
    const read = readChatGroups()
    await tick()
    take('GET /api/chats').answer(json({ items: [pinned], nextCursor: null }))
    take('GET /api/chats/groups').answer(json(groups([pinned])))
    await load
    await read
    expect(listed()).toBeUndefined()
    expect(useChatGroups.getState().groups!.pinned).toEqual([])
    // the server's own event of it, before the answer: nothing changes
    event({ ...pinned, deletedAt: '2026-11-13T01:00:00.000Z' }, 'deleted')
    expect(toasts()).toEqual([])
    take(`DELETE /api/chats/${ID}`).answer(json({ id: ID, deletedAt: '2026-11-13T01:00:00.000Z', purgeAt: '2026-11-27T01:00:00.000Z' }))
    expect(await done).toBe(true)
    expect(toasts().map((x) => x.level)).toEqual(['info'])
  } finally {
    await m.unmount()
  }
})

test('delete refused: the chat is back in 최근 기록 and 고정, with one error toast and no "deleted"', async () => {
  const pinned = chat({ pinnedAt: '2026-11-12T00:00:00.000Z' })
  useChats.setState({ chats: [pinned], chatsLoaded: true })
  useChatGroups.setState({ groups: groups([pinned]) })
  const { actions, m } = await chatActions()
  try {
    const done = actions.remove(pinned)
    await m.until(() => m.find('dialog-confirm'), 'the confirm')
    await m.click('dialog-confirm')
    expect(listed()).toBeUndefined()
    await tick()
    take(`DELETE /api/chats/${ID}`).answer(refused('Something went wrong.', 500))
    expect(await done).toBe(false)
    expect(listed()?.pinnedAt).toBe('2026-11-12T00:00:00.000Z')
    expect(useChatGroups.getState().groups!.pinned.map((c) => c.id)).toEqual([ID])
    expect(toasts().map((x) => [x.level, x.text])).toEqual([['error', 'Something went wrong.']])
  } finally {
    await m.unmount()
  }
})

test('restore (삭제한 기록, the chat\'s banner, Undo): back in my list and off the trash page at once; refused, back in the trash with the given words', async () => {
  const trashed = chat({ deletedAt: '2026-11-12T00:00:00.000Z', pinnedAt: '2026-11-11T00:00:00.000Z' })
  const page: { c: Chat; inTrash: boolean }[] = []
  const done = trashChat(trashed, false, { onShown: (c, inTrash) => page.push({ c, inTrash }) })
  // restored unpinned and in no folder, as the server brings it back
  expect(listed()?.deletedAt).toBeNull()
  expect(listed()?.pinnedAt).toBeUndefined()
  expect(page.map((p) => p.inTrash)).toEqual([false])
  await tick()
  take(`POST /api/chats/${ID}/restore`).answer(json(chat()))
  expect((await done).ok).toBe(true)
  expect(listed()?.deletedAt).toBeNull()

  useChats.getState().reset()
  const undo = undoDelete(trashed, 'Could not bring it back.')
  expect(listed()).toBeTruthy()
  await tick()
  take(`POST /api/chats/${ID}/restore`).answer(refused('Not found', 404))
  await undo
  expect(listed()).toBeUndefined()
  expect(toasts().map((x) => [x.level, x.text])).toEqual([['error', 'Could not bring it back.']])
})

test('engine / model (the chat\'s picker): the new one at once and kept through an older event; refused, the old one back with a toast', async () => {
  useChats.setState({ chats: [chat()], chatsLoaded: true })
  const pick = (engine: string, model: string | null) => {
    const was = listed()!
    type P = { engine: Chat['engine']; model: string | null }
    return changeChat<P>({
      chat: was, field: 'engine', from: { engine: was.engine, model: was.model }, to: { engine: engine as Chat['engine'], model },
      apply: (c, v) => ({ ...c, ...v }), send: () => api.call(API.updateChat, { params: { id: ID }, body: { engine: engine as Chat['engine'], model } }), confirmed: (c) => ({ engine: c.engine, model: c.model }),
    })
  }
  const done = pick('codex', 'gpt-5')
  expect(listed()?.engine).toBe('codex')
  expect(listed()?.model).toBe('gpt-5')
  event(chat({ runState: 'running' }))
  expect(listed()?.engine).toBe('codex')
  await tick()
  take(`PATCH /api/chats/${ID}`).answer(json(chat({ engine: 'codex', model: 'gpt-5' })))
  await done
  expect(listed()?.model).toBe('gpt-5')

  const again = pick('claude-code', 'opus')
  expect(listed()?.engine).toBe('claude-code')
  await tick()
  take(`PATCH /api/chats/${ID}`).answer(refused('Something went wrong.', 500))
  await again
  expect(listed()?.engine).toBe('codex')
  expect(listed()?.model).toBe('gpt-5')
  expect(toasts().map((x) => x.level)).toEqual(['error'])
})

test('move to a project: in it (and out of its list folder) at once; a list read from before keeps it; refused, back with the server\'s words', async () => {
  const filed = chat({ folderId: FOLDER })
  useChats.setState({ chats: [older, filed], chatsLoaded: true })
  const moved: (string | null)[] = []
  const done = moveChat(filed, PROJECT, (c) => moved.push(c.projectId))
  expect(listed()?.projectId).toBe(PROJECT)
  expect(listed()?.folderId).toBeUndefined()
  expect(useChats.getState().chats[0]!.id).toBe(ID)
  expect(moved).toEqual([PROJECT])
  const load = useChats.getState().loadChats(true)
  await tick()
  take('GET /api/chats').answer(json({ items: [older, filed], nextCursor: null }))
  await load
  expect(listed()?.projectId).toBe(PROJECT)
  expect(listed()?.folderId).toBeUndefined()
  const req = take(`PATCH /api/chats/${ID}`)
  expect(req.body).toEqual({ projectId: PROJECT })
  req.answer(refused('That project is in the trash.'))
  expect((await done).ok).toBe(false)
  expect(listed()?.projectId).toBeNull()
  expect(listed()?.folderId).toBe(FOLDER)
  expect(moved).toEqual([PROJECT, null])
  expect(toasts().map((x) => x.text)).toEqual(['That project is in the trash.'])
})

test('a chat into a list folder: at once; refused, back out with one toast', async () => {
  useChats.setState({ chats: [chat()], chatsLoaded: true })
  const done = fileChat(ID, FOLDER)
  expect(listed()?.folderId).toBe(FOLDER)
  await tick()
  take(`PUT /api/chats/${ID}/folder`).answer(refused('Something went wrong.', 500))
  expect((await done).ok).toBe(false)
  expect(listed()?.folderId).toBeUndefined()
  expect(toasts()).toHaveLength(1)
})

test('a room into a list folder: in it at once; a rooms read from before keeps it there; the answer settles it', async () => {
  const r = room({ name: 'acme' })
  useRooms.setState({ rooms: [r], loaded: true })
  const done = fileRoom(r.id, FOLDER)
  expect(useRooms.getState().rooms[0]!.folderId).toBe(FOLDER)
  const load = useRooms.getState().loadRooms()
  await tick()
  take('GET /api/rooms').answer(json({ items: [r] }))
  await load
  expect(useRooms.getState().rooms[0]!.folderId).toBe(FOLDER)
  take(`PUT /api/rooms/${r.id}/folder`).answer(json({ ...r, folderId: FOLDER }))
  expect((await done).ok).toBe(true)
  expect(useRooms.getState().rooms[0]!.folderId).toBe(FOLDER)
  await tick()
  take('GET /api/nav-folders').answer(json({ items: [folder()] }))
})

test('a room out of its folder, refused: back in it with one toast', async () => {
  const r = room({ name: 'acme', folderId: FOLDER })
  useRooms.setState({ rooms: [r], loaded: true })
  const done = fileRoom(r.id, null)
  expect(useRooms.getState().rooms[0]!.folderId).toBeUndefined()
  await tick()
  take(`PUT /api/rooms/${r.id}/folder`).answer(refused('Something went wrong.', 500))
  await done
  expect(useRooms.getState().rooms[0]!.folderId).toBe(FOLDER)
  expect(toasts()).toHaveLength(1)
})

test('a new folder: last in its list at once; a read from before keeps it; the server\'s folder takes its place', async () => {
  useNavFolders.setState({ folders: [folder()] })
  const done = createFolder('rooms', 'Acme ops')
  expect(useNavFolders.getState().folders!.map((f) => f.name)).toEqual(['Acme team', 'Acme ops'])
  const read = readNavFolders()
  await tick()
  // the read answers first, without it (from before the server made it): the new folder stays
  take('GET /api/nav-folders').answer(json({ items: [folder()] }))
  await read
  expect(useNavFolders.getState().folders!.map((f) => f.name)).toEqual(['Acme team', 'Acme ops'])
  const made_ = folder({ id: uuidv7(), name: 'Acme ops', position: 1 })
  take('POST /api/nav-folders').answer(json(made_, 201))
  const made = await done
  expect(made?.name).toBe('Acme ops')
  expect(useNavFolders.getState().folders!.map((f) => f.id)).toEqual([FOLDER, made!.id])
})

test('a new folder refused: gone again, the server\'s words in one toast', async () => {
  useNavFolders.setState({ folders: [] })
  const done = createFolder('rooms', 'Acme ops')
  expect(useNavFolders.getState().folders!.map((f) => f.name)).toEqual(['Acme ops'])
  await tick()
  take('POST /api/nav-folders').answer(refused('You already have a folder with that name.'))
  expect(await done).toBeNull()
  expect(useNavFolders.getState().folders).toEqual([])
  expect(toasts().map((x) => x.text)).toEqual(['You already have a folder with that name.'])
})

test('a folder renamed: at once; refused, the old name back with one toast', async () => {
  useNavFolders.setState({ folders: [folder()] })
  const ok = renameFolder(folder(), 'Acme sales')
  expect(useNavFolders.getState().folders![0]!.name).toBe('Acme sales')
  await tick()
  take(`PATCH /api/nav-folders/${FOLDER}`).answer(json(folder({ name: 'Acme sales' })))
  expect(await ok).toBe(true)
  const bad = renameFolder(folder({ name: 'Acme sales' }), 'Acme x')
  expect(useNavFolders.getState().folders![0]!.name).toBe('Acme x')
  await tick(2)
  take(`PATCH /api/nav-folders/${FOLDER}`).answer(refused('Something went wrong.', 500))
  expect(await bad).toBe(false)
  expect(useNavFolders.getState().folders![0]!.name).toBe('Acme sales')
  expect(toasts()).toHaveLength(1)
})

test('a folder deleted: gone at once with its rooms back in their place; refused, the folder and its rooms come back', async () => {
  const inIt = room({ name: 'acme-in', folderId: FOLDER })
  const outside = room({ name: 'acme-out' })
  useRooms.setState({ rooms: [inIt, outside], loaded: true })
  useNavFolders.setState({ folders: [folder()] })
  const done = deleteFolder(folder())
  expect(useNavFolders.getState().folders).toEqual([])
  expect(useRooms.getState().rooms.find((r) => r.id === inIt.id)!.folderId).toBeUndefined()
  await tick()
  take(`DELETE /api/nav-folders/${FOLDER}`).answer(refused('Something went wrong.', 500))
  expect(await done).toBe(false)
  expect(useNavFolders.getState().folders!.map((f) => f.id)).toEqual([FOLDER])
  expect(useRooms.getState().rooms.find((r) => r.id === inIt.id)!.folderId).toBe(FOLDER)
  expect(useRooms.getState().rooms.find((r) => r.id === outside.id)!.folderId).toBeUndefined()
  expect(toasts()).toHaveLength(1)
})

test('a list read asked before a change and answered after its answer reads again instead of writing the old copy', async () => {
  useChats.setState({ chats: [chat()], chatsLoaded: true })
  const load = useChats.getState().loadChats(true)
  await tick()
  const done = moveChat(chat(), PROJECT)
  await tick()
  take(`PATCH /api/chats/${ID}`).answer(json(chat({ projectId: PROJECT, updatedAt: '2026-11-13T01:00:00.000Z' })))
  await done
  // the read from before the move answers now, with the chat outside the project: not written, asked again
  take('GET /api/chats').answer(json({ items: [chat()], nextCursor: null }))
  await tick(3)
  expect(listed()?.projectId).toBe(PROJECT)
  take('GET /api/chats').answer(json({ items: [chat({ projectId: PROJECT, updatedAt: '2026-11-13T01:00:00.000Z' })], nextCursor: null }))
  await load
  expect(listed()?.projectId).toBe(PROJECT)
})

test('a move answered after the chat was deleted here does not bring it back into the list', async () => {
  useChats.setState({ chats: [chat()], chatsLoaded: true })
  const move = moveChat(chat(), PROJECT)
  const del = trashChat(chat(), true)
  expect(listed()).toBeUndefined()
  await tick()
  take(`PATCH /api/chats/${ID}`).answer(json(chat({ projectId: PROJECT })))
  await move
  expect(listed()).toBeUndefined()
  await tick()
  take(`DELETE /api/chats/${ID}`).answer(json({ id: ID, deletedAt: '2026-11-13T01:00:00.000Z', purgeAt: '2026-11-27T01:00:00.000Z' }))
  await del
  expect(listed()).toBeUndefined()
})

test('a room dropped on a folder whose making is refused: one toast (the folder\'s), and the room is back out', async () => {
  const r = room({ name: 'acme' })
  useRooms.setState({ rooms: [r], loaded: true })
  useNavFolders.setState({ folders: [] })
  const made = createFolder('rooms', 'Acme ops')
  const temp = useNavFolders.getState().folders![0]!.id
  const filed = fileRoom(r.id, temp)
  expect(useRooms.getState().rooms[0]!.folderId).toBe(temp)
  await tick()
  take('POST /api/nav-folders').answer(refused('You already have a folder with that name.'))
  await made
  expect((await filed).ok).toBe(false)
  expect(useRooms.getState().rooms[0]!.folderId).toBeUndefined()
  expect(toasts().map((x) => x.text)).toEqual(['You already have a folder with that name.'])
})
