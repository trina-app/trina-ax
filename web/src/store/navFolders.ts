// My list folders (docs/DECISIONS.md "List folders" and "List folders on screen"): both kinds as the server last said
// them (GET /api/nav-folders), and what changes them. Only mine: the server never sends anyone else's. The Trina list
// draws its chat folders from GET /api/chats/groups (store/chatGroups.ts: counts, first rows, marks); this store is
// what the 대화 list's room folders, the row menus' "폴더로 옮기기" and a new chat's folder read. Read when a list first
// needs it, again on navFolders.changed (my other windows) and after each change made here.
import { create } from 'zustand'
import type { Chat, NavFolder, NavFolderKind, Room } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { readChatGroups } from './chatGroups'
import { useChats } from './chats'
import { navFoldersChanged } from './live'
import { useRooms, withRoom } from './rooms'

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
  inFlight = api.call(API.listNavFolders).then(
    (r) => {
      if (mine === generation) useNavFolders.setState({ folders: r.items })
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

export async function createFolder(kind: NavFolderKind, name: string): Promise<NavFolder> {
  const f = await api.call(API.createNavFolder, { body: { kind, name } })
  changed(kind)
  return f
}

export async function renameFolder(f: Pick<NavFolder, 'id' | 'kind'>, name: string): Promise<void> {
  await api.call(API.updateNavFolder, { params: { id: f.id }, body: { name } })
  changed(f.kind)
}

/** Delete a folder: only the folder; what was in it goes back to its usual place (each of my windows hears it). */
export async function deleteFolder(f: Pick<NavFolder, 'id' | 'kind'>): Promise<void> {
  await api.call(API.deleteNavFolder, { params: { id: f.id } })
  // the rooms in it: in no folder now (the server sends each room again too; this is at once)
  if (f.kind === 'rooms') useRooms.setState((s) => ({ rooms: s.rooms.map((r) => (r.folderId === f.id ? withoutFolder(r) : r)) }))
  else for (const c of useChats.getState().chats) if (c.folderId === f.id) useChats.getState().upsertChat(withoutFolder(c))
  changed(f.kind)
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

/** Put my chat in a folder of mine, or out of it (null). */
export async function fileChat(chatId: string, folderId: string | null): Promise<Chat> {
  const c = await api.call(API.setChatFolder, { params: { id: chatId }, body: { folderId } })
  useChats.getState().upsertChat(c)
  void readNavFolders()
  void readChatGroups()
  return c
}

/** Put a room I am in in a folder of mine, or out of it (null). */
export async function fileRoom(roomId: string, folderId: string | null): Promise<Room> {
  const room = await api.call(API.setRoomFolder, { params: { id: roomId }, body: { folderId } })
  useRooms.setState((s) => withRoom(s, room))
  void readNavFolders()
  return room
}
