// The team's conversation categories (shared/src/api/room-categories.ts): the same list for everyone, read when the
// Chats list first needs it and again on roomCategories.changed (an admin changed them in any window) or a reconnect.
// Admins and the owner change them here; which channels are in each comes with the rooms (Room.categoryId).
import { create } from 'zustand'
import type { Room, RoomCategory } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { reloadAsked, roomCategoriesChanged } from './live'
import { useRooms, withRoom } from './rooms'

interface RoomCategoriesState {
  categories: RoomCategory[] | null
  reset: () => void
}

export const useRoomCategories = create<RoomCategoriesState>((set) => ({
  categories: null,
  reset: () => set({ categories: null }),
}))

let watching = false
let inFlight: Promise<void> | null = null

export function readRoomCategories(): Promise<void> {
  inFlight ??= api.call(API.listRoomCategories).then(
    (r) => useRoomCategories.setState({ categories: r.items }),
    () => {},
  ).finally(() => { inFlight = null })
  return inFlight
}

/** read once, then kept current */
export function watchRoomCategories(): void {
  if (watching) return
  watching = true
  roomCategoriesChanged.on(() => void readRoomCategories())
  reloadAsked.on(() => void readRoomCategories())
  void readRoomCategories()
}

const put = (items: RoomCategory[]) => useRoomCategories.setState({ categories: items })

export async function createCategory(name: string): Promise<RoomCategory> {
  const c = await api.call(API.createRoomCategory, { body: { name } })
  put([...(useRoomCategories.getState().categories ?? []).filter((x) => x.id !== c.id), c])
  return c
}
export async function renameCategory(c: RoomCategory, name: string): Promise<void> {
  const n = await api.call(API.updateRoomCategory, { params: { id: c.id }, body: { name } })
  put((useRoomCategories.getState().categories ?? []).map((x) => (x.id === n.id ? n : x)))
}
export async function deleteCategory(c: RoomCategory): Promise<void> {
  await api.call(API.deleteRoomCategory, { params: { id: c.id } })
  put((useRoomCategories.getState().categories ?? []).filter((x) => x.id !== c.id))
  // its channels go back to Channels at once (room.updated follows from the server)
  useRooms.setState((s) => ({ rooms: s.rooms.map((r) => (r.categoryId === c.id ? withoutCategory(r) : r)) }))
}
export async function moveCategory(c: RoomCategory, by: -1 | 1): Promise<void> {
  const list = [...(useRoomCategories.getState().categories ?? [])]
  const i = list.findIndex((x) => x.id === c.id)
  const j = i + by
  if (i < 0 || j < 0 || j >= list.length) return
  ;[list[i], list[j]] = [list[j]!, list[i]!]
  put(list.map((x, k) => ({ ...x, position: k })))
  put((await api.call(API.orderRoomCategories, { body: { ids: list.map((x) => x.id) } })).items)
}
/** a channel into a category for everyone (null: out) */
export async function setCategory(roomId: string, categoryId: string | null): Promise<Room> {
  const room = await api.call(API.setRoomCategory, { params: { id: roomId }, body: { categoryId } })
  useRooms.setState((s) => withRoom(s, room))
  return room
}

function withoutCategory(r: Room): Room {
  const { categoryId: _, ...rest } = r
  return rest
}

/** a name the team already uses (any letter case), other than `except` */
export function categoryNameTaken(list: RoomCategory[] | null, name: string, except?: string): boolean {
  const key = name.normalize('NFC').trim().toLowerCase()
  return (list ?? []).some((c) => c.id !== except && c.name.normalize('NFC').trim().toLowerCase() === key)
}
