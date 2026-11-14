// Apps posting in a room (docs/DECISIONS.md "Apps posting in rooms"; components/rooms/apps/*): the list of a room's apps
// for the people who manage them, and which of its screens is open. Only a room's managers read the list (in a team room
// or the everyone room its owners and admins; in a 1:1 or a group chat its members: shared rooms.ts mayManageApps on
// the server): a member's request would get 403, so the room page never asks for them.
// Nothing is made by opening the screens: an app is added on its guide's first Copy (create), so a guide closed before
// that leaves nothing behind.
import { create } from 'zustand'
import type { Me } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import type { Room, RoomApp, RoomAppKind, RoomAppList, UpdateRoomAppBody } from '@mycel/shared/api'

/** May I manage this room's apps (the server's rooms/store.ts mayManageApps)? A room I see is a room I am in. */
export const mayManageApps = (room: Pick<Room, 'kind'> | null | undefined, me: Pick<Me, 'user'> | null | undefined): boolean =>
  !!room && !!me && (room.kind === 'dm' || room.kind === 'group' || me.user.role === 'owner' || me.user.role === 'admin')

/** Which screen the apps dialog starts on: the picker (or the list when there are apps), one app's settings, or a kind's
 * guide (a new app, or one being set up again). */
export type AppsStart = { view: 'auto' } | { view: 'pick' } | { view: 'list' } | { view: 'settings'; appId: string } | { view: 'guide'; kind: RoomAppKind; appId?: string }

interface RoomAppsState {
  lists: Record<string, RoomAppList | undefined>
  dialog: { roomId: string; start: AppsStart; key: number } | null
  load: (roomId: string) => Promise<RoomAppList>
  open: (roomId: string, start?: AppsStart) => void
  close: () => void
  /** an app changed (its own answer): put it in the room's list */
  put: (app: RoomApp) => void
  drop: (roomId: string, appId: string) => void
  update: (roomId: string, appId: string, body: UpdateRoomAppBody) => Promise<RoomApp>
}

export const useRoomApps = create<RoomAppsState>((set, get) => ({
  lists: {},
  dialog: null,
  async load(roomId) {
    const list = await api.call(API.listRoomApps, { params: { id: roomId } })
    set((s) => ({ lists: { ...s.lists, [roomId]: list } }))
    return list
  },
  open(roomId, start = { view: 'auto' }) { set((s) => ({ dialog: { roomId, start, key: (s.dialog?.key ?? 0) + 1 } })) },
  close() { set({ dialog: null }) },
  put(app) {
    set((s) => {
      const list = s.lists[app.roomId]
      if (!list) return s
      const has = list.items.some((a) => a.id === app.id)
      return { lists: { ...s.lists, [app.roomId]: { ...list, items: has ? list.items.map((a) => (a.id === app.id ? app : a)) : [...list.items, app] } } }
    })
  },
  drop(roomId, appId) {
    set((s) => {
      const list = s.lists[roomId]
      return list ? { lists: { ...s.lists, [roomId]: { ...list, items: list.items.filter((a) => a.id !== appId) } } } : s
    })
  },
  /** a switch, Quiet: on screen at once, the old state back when it fails (the caller says so) */
  async update(roomId, appId, body) {
    const before = get().lists[roomId]?.items.find((a) => a.id === appId)
    if (before) get().put({ ...before, ...(body.events ? { events: { ...before.events, ...body.events } } : {}), ...(body.quiet !== undefined ? { quiet: body.quiet } : {}) })
    try {
      const app = await api.call(API.updateRoomApp, { params: { id: roomId, appId }, body })
      get().put(app)
      return app
    } catch (e) {
      if (before) get().put(before)
      throw e
    }
  },
}))
