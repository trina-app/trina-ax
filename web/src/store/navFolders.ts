// My list folders (docs/DECISIONS.md "List folders" and "List folders on screen"): both kinds as the server last said
// them (GET /api/nav-folders), and what changes them. Only mine: the server never sends anyone else's. The Trina list
// draws its chat folders from GET /api/chats/groups (store/chatGroups.ts: counts, first rows, marks); this store is
// what the 대화 list's room folders, the row menus' "폴더로 옮기기" and a new chat's folder read. Read when a list first
// needs it, again on navFolders.changed (my other windows) and after each change made here.
// Each change shows at once (lib/optimistic.ts; docs/DECISIONS.md "Optimistic changes: the screen first, the server
// after"): a new folder is there before the server names it, a renamed or deleted one changes at once, a chat or room
// moves at once; a refusal puts it back with one toast. A read from before such a change reads again instead.
import { create } from 'zustand'
import { uuidv7, type Chat, type NavFolder, type NavFolderKind, type Room } from '@mycel/shared/api'
import { api, API, errorText } from '../lib/api'
import { currentLocale, t } from '../i18n'
import { optimistic, optimisticEdits, optimisticPending, optimisticPendingKeys, type OptimisticResult } from '../lib/optimistic'
import { readChatGroups } from './chatGroups'
import { useChats } from './chats'
import { navFoldersChanged } from './live'
import { useRooms, withRoom } from './rooms'
import { toast } from './ui'

interface NavFoldersState {
  folders: NavFolder[] | null
  reset: () => void
}

export const useNavFolders = create<NavFoldersState>((set) => ({
  folders: null,
  reset: () => {
    generation++
    set({ folders: null })
  },
}))

let generation = 0
let inFlight: Promise<void> | null = null
let again = false

/** Read my folders (one read at a time; a change during a read reads once more after it). */
export function readNavFolders(): Promise<void> {
  if (inFlight) {
    again = true
    return inFlight
  }
  const mine = generation
  const edits = optimisticEdits(isFolderKey)
  inFlight = api.call(API.listNavFolders).then(
    (r) => {
      if (mine !== generation) return
      // a folder made, renamed or deleted here while it was asked: the answer may be from before it, read once more
      if (edits !== optimisticEdits(isFolderKey)) {
        again = true
        return
      }
      useNavFolders.setState({ folders: withPendingFolders(r.items) })
    },
    () => {},
  ).finally(() => {
    inFlight = null
    if (again) {
      again = false
      void readNavFolders()
    }
  })
  return inFlight
}

let listening = false
/** Keep the folders read while something shows them (the first caller starts listening for my other windows). */
export function watchNavFolders(): void {
  // many rows ask at once: one read
  if (useNavFolders.getState().folders === null && !inFlight) void readNavFolders()
  if (listening) return
  listening = true
  navFoldersChanged.on(() => void readNavFolders())
}

/** my folders of one kind, in their order */
export const foldersOf = (all: NavFolder[] | null, kind: NavFolderKind): NavFolder[] => (all ?? []).filter((f) => f.kind === kind).sort((a, b) => a.position - b.position)

/** a name I already use for that kind (the server's rule: any letter case, NFC) */
export function nameTaken(all: NavFolder[] | null, kind: NavFolderKind, name: string, except?: string): boolean {
  const key = name.normalize('NFC').trim().toLowerCase()
  return foldersOf(all, kind).some((f) => f.id !== except && f.name.normalize('NFC').toLowerCase() === key)
}

/** after a change: my folders read again; a chat folder's change reads the Trina list's heads at once too */
function changed(kind: NavFolderKind) {
  void readNavFolders()
  if (kind === 'chats') void readChatGroups()
}

const isFolderKey = (key: string) => key.startsWith('navfolder:')
const folderKey = (id: string, what: 'make' | 'name' | 'delete') => `navfolder:${id}:${what}`
const pendingIds = (what: string) => optimisticPendingKeys((k) => isFolderKey(k) && k.endsWith(`:${what}`)).map((k) => k.slice('navfolder:'.length, -what.length - 1))

/** a read's folders with the changes still on their way as they are on screen (the read may be from before them) */
function withPendingFolders(items: NavFolder[]): NavFolder[] {
  const shown = useNavFolders.getState().folders ?? []
  const made = pendingIds('make')
  const deleted = new Set(pendingIds('delete').map(nowId))
  const named = new Map(pendingIds('name').map(nowId).map((id) => [id, shown.find((f) => f.id === id)?.name]))
  if (!made.length && !deleted.size && !named.size) return items
  const out = items.filter((f) => !deleted.has(f.id)).map((f) => (named.get(f.id) !== undefined ? { ...f, name: named.get(f.id)! } : f))
  return [...out, ...shown.filter((f) => made.includes(f.id) && !out.some((x) => x.id === f.id))]
}

const setFolders = (fn: (all: NavFolder[]) => NavFolder[]) => useNavFolders.setState((s) => ({ folders: fn(s.folders ?? []) }))

/** a folder on screen that the server has not made yet: its own id once it answers (null: it was refused) */
const making = new Map<string, Promise<string | null>>()
/** a folder made here: the id it had on screen before the server's answer → the server's id */
const madeAs = new Map<string, string>()
/** the id a folder has on screen now (one made here: the server's once it answered) */
const nowId = (id: string) => madeAs.get(id) ?? id
/** the server's id of a folder (one still being made: once it is) */
const serverId = async (id: string): Promise<string | null> => (making.has(id) ? making.get(id)! : nowId(id))

/** a change to a folder that was never made (its making was refused, and said so): no second toast */
class NotMade extends Error {}
/** the server's id of the folder, or NotMade */
const madeId = async (id: string): Promise<string> => {
  const real = await serverId(id)
  if (!real) throw new NotMade('folder not made')
  return real
}
/** a refusal of the newest change, in the person's language (not for a folder whose making was refused) */
function sayFailure(r: OptimisticResult<unknown>) {
  if (!r.ok && r.newest && !(r.error instanceof NotMade)) toast({ level: 'error', text: errorText(r.error, currentLocale(), t('error.network')) })
}

/** A new folder, last in its list at once; the server's folder once it answers, or null when it was refused (one
 * toast says so). */
export async function createFolder(kind: NavFolderKind, name: string): Promise<NavFolder | null> {
  const temp: NavFolder = { id: uuidv7(), kind, name: name.trim(), position: foldersOf(useNavFolders.getState().folders, kind).length, count: 0, top: [] }
  let made: (id: string | null) => void = () => {}
  making.set(temp.id, new Promise((r) => (made = r)))
  const r = await optimistic<boolean, NavFolder>({
    key: folderKey(temp.id, 'make'),
    from: false,
    to: true,
    show: (there) => setFolders((all) => (there ? [...all.filter((f) => f.id !== temp.id), temp] : all.filter((f) => f.id !== temp.id))),
    send: () => api.call(API.createNavFolder, { body: { kind, name } }),
    // the server's folder in its place (a rename of it meanwhile is sent to it, see serverId)
    settle: (f) => setFolders((all) => all.map((x) => (x.id === temp.id ? { ...f, name: x.name } : x))),
  })
  if (r.ok) madeAs.set(temp.id, r.reply.id)
  made(r.ok ? r.reply.id : null)
  making.delete(temp.id)
  if (!r.ok) return null
  changed(kind)
  return r.reply
}

/** A new name at once; the server's (trimmed) after. */
export async function renameFolder(f: Pick<NavFolder, 'id' | 'kind'> & { name?: string }, name: string): Promise<boolean> {
  const was = useNavFolders.getState().folders?.find((x) => x.id === f.id)?.name ?? f.name ?? name
  const r = await optimistic<string, NavFolder>({
    key: folderKey(f.id, 'name'),
    from: was,
    to: name.trim(),
    show: (n) => setFolders((all) => all.map((x) => (x.id === nowId(f.id) ? { ...x, name: n } : x))),
    send: async () => api.call(API.updateNavFolder, { params: { id: await madeId(f.id) }, body: { name } }),
    confirmed: (x) => x.name,
    failText: false,
  })
  sayFailure(r)
  if (r.ok) changed(f.kind)
  return r.ok
}

/** Delete a folder: only the folder; what was in it goes back to its usual place (each of my windows hears it). Gone
 * at once, with what was in it back in its place; a refusal puts both back. */
export async function deleteFolder(f: Pick<NavFolder, 'id' | 'kind'>): Promise<boolean> {
  const folder = useNavFolders.getState().folders?.find((x) => x.id === f.id)
  const rooms = f.kind === 'rooms' ? useRooms.getState().rooms.filter((r) => r.folderId === f.id).map((r) => r.id) : []
  const chats = f.kind === 'chats' ? useChats.getState().chats.filter((c) => c.folderId === f.id).map((c) => c.id) : []
  const r = await optimistic<boolean, unknown>({
    key: folderKey(f.id, 'delete'),
    from: false,
    to: true,
    show: (gone) => {
      if (gone) setFolders((all) => all.filter((x) => x.id !== nowId(f.id)))
      else if (folder) setFolders((all) => (all.some((x) => x.id === nowId(f.id)) ? all : [...all, { ...folder, id: nowId(f.id) }]))
      // the rooms and chats in it: in no folder now (the server sends each room again too; this is at once), or back in it
      const put = <T extends { id: string; folderId?: string }>(x: T, ids: string[]): T => (!ids.includes(x.id) ? x : gone ? withoutFolder(x) : x.folderId ? x : { ...x, folderId: f.id })
      if (rooms.length) useRooms.setState((s) => ({ rooms: s.rooms.map((x) => put(x, rooms)) }))
      for (const c of useChats.getState().chats) if (chats.includes(c.id) && put(c, chats) !== c) useChats.getState().upsertChat(put(c, chats))
    },
    // a folder whose making was refused is gone already
    send: async () => {
      const id = await serverId(f.id)
      return id ? api.call(API.deleteNavFolder, { params: { id } }) : null
    },
  })
  if (r.ok) changed(f.kind)
  return r.ok
}

/** One place up (-1) or down (+1) in its list. */
export async function moveFolder(all: NavFolder[], f: Pick<NavFolder, 'id' | 'kind'>, by: -1 | 1): Promise<void> {
  const ids = foldersOf(all, f.kind).map((x) => x.id)
  const i = ids.indexOf(f.id)
  const j = i + by
  if (i < 0 || j < 0 || j >= ids.length) return
  ;[ids[i], ids[j]] = [ids[j]!, ids[i]!]
  // at once on screen, the server's order after
  useNavFolders.setState((s) => ({ folders: (s.folders ?? []).map((x) => (x.kind === f.kind && ids.includes(x.id) ? { ...x, position: ids.indexOf(x.id) } : x)) }))
  let r
  try {
    r = await api.call(API.orderNavFolders, { body: { kind: f.kind, ids } })
  } catch (e) {
    // refused: the order as the server has it
    void readNavFolders()
    throw e
  }
  useNavFolders.setState((s) => ({ folders: [...(s.folders ?? []).filter((x) => x.kind !== f.kind), ...r.items.filter((x) => x.kind === f.kind)] }))
  if (f.kind === 'chats') void readChatGroups()
}

function withoutFolder<T extends { folderId?: string }>(x: T): T {
  const { folderId: _, ...rest } = x
  return rest as T
}

const withFolder = <T extends { folderId?: string }>(x: T, folderId: string | null): T => (folderId ? { ...x, folderId } : withoutFolder(x))

/** Put my chat in a folder of mine, or out of it (null): at once in my lists, then on the server; a refusal puts it
 * back with one toast. */
export async function fileChat(chatId: string, folderId: string | null): Promise<OptimisticResult<Chat>> {
  const was = useChats.getState().chats.find((c) => c.id === chatId)
  const r = await optimistic<string | null, Chat>({
    key: `chat:${chatId}:folder`,
    from: was?.folderId ?? null,
    to: folderId,
    show: (id) => {
      const c = useChats.getState().chats.find((x) => x.id === chatId)
      if (c) useChats.getState().upsertChat(withFolder(c, id))
    },
    send: async () => api.call(API.setChatFolder, { params: { id: chatId }, body: { folderId: folderId && (await madeId(folderId)) } }),
    confirmed: (c) => c.folderId ?? null,
    // not a chat that left my list meanwhile (put in the trash): the answer would bring it back
    settle: (c) => {
      if (!optimisticPending(`chat:${chatId}:trash`) && useChats.getState().chats.some((x) => x.id === chatId)) useChats.getState().upsertChat(c)
    },
    failText: false,
  })
  sayFailure(r)
  if (r.ok) {
    void readNavFolders()
    void readChatGroups()
  }
  return r
}

const roomFolderKey = (roomId: string) => `room:${roomId}:folder`
/** rooms whose folder change is on its way, and the folder on screen: a room read or event from before it keeps it
 * (store/rooms.ts writes the server's copies; this puts the folder back on them) */
const roomFolders = new Map<string, string | null>()
let watchingRooms = false
function keepRoomFolders() {
  if (watchingRooms) return
  watchingRooms = true
  useRooms.subscribe((s) => {
    if (!roomFolders.size) return
    const off = s.rooms.filter((r) => roomFolders.has(r.id) && optimisticPending(roomFolderKey(r.id)) && (r.folderId ?? null) !== roomFolders.get(r.id))
    if (off.length) useRooms.setState((d) => ({ rooms: d.rooms.map((r) => (off.some((x) => x.id === r.id) ? withFolder(r, roomFolders.get(r.id)!) : r)) }))
  })
}

/** Put a room I am in in a folder of mine, or out of it (null): at once in 대화, then on the server; a refusal puts it
 * back with one toast. */
export async function fileRoom(roomId: string, folderId: string | null): Promise<OptimisticResult<Room>> {
  keepRoomFolders()
  const was = useRooms.getState().rooms.find((r) => r.id === roomId)
  const r = await optimistic<string | null, Room>({
    key: roomFolderKey(roomId),
    from: was?.folderId ?? null,
    to: folderId,
    show: (id) => {
      roomFolders.set(roomId, id)
      useRooms.setState((s) => ({ rooms: s.rooms.map((x) => (x.id === roomId ? withFolder(x, id) : x)) }))
    },
    send: async () => api.call(API.setRoomFolder, { params: { id: roomId }, body: { folderId: folderId && (await madeId(folderId)) } }),
    confirmed: (x) => x.folderId ?? null,
    settle: (room) => useRooms.setState((s) => withRoom(s, room)),
    failText: false,
  })
  sayFailure(r)
  if (!optimisticPending(roomFolderKey(roomId))) roomFolders.delete(roomId)
  if (r.ok) void readNavFolders()
  return r
}
