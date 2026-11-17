// Where a room's files are in the team folder, for this viewer (GET /api/rooms/:id/saved-files; docs/decisions/
// 20261117-room-file-save-btn.md): read once per room per page load, the first time one of its file chips shows, and
// added to when this person saves. Someone else's save shows on the next load (no live update). Never for a guest: the
// server refuses them, so nothing is asked.
import { create } from 'zustand'
import { api, API } from '../lib/api'

interface RoomSavesState {
  /** room id → file id → team path */
  byRoom: Record<string, Record<string, string> | undefined>
  /** the save sheet: the room and the message's files, with the one tapped first */
  sheet: { roomId: string; fileIds: string[]; key: number } | null
  load: (roomId: string) => void
  put: (roomId: string, saved: { fileId: string; path: string }[]) => void
  open: (roomId: string, fileIds: string[]) => void
  close: () => void
}

const asked = new Set<string>()

export const useRoomSaves = create<RoomSavesState>((set) => ({
  byRoom: {},
  sheet: null,
  load(roomId) {
    if (asked.has(roomId)) return
    asked.add(roomId)
    api.call(API.roomSavedFiles, { params: { id: roomId } }).then(
      (r) => set((s) => ({ byRoom: { ...s.byRoom, [roomId]: { ...s.byRoom[roomId], ...Object.fromEntries(r.items.map((i) => [i.fileId, i.path])) } } })),
      // not known: the chips offer the save, which finds the file there (the same bytes count as saved)
      () => asked.delete(roomId),
    )
  },
  put(roomId, saved) {
    set((s) => ({ byRoom: { ...s.byRoom, [roomId]: { ...s.byRoom[roomId], ...Object.fromEntries(saved.map((i) => [i.fileId, i.path])) } } }))
  },
  open(roomId, fileIds) {
    set((s) => ({ sheet: { roomId, fileIds, key: (s.sheet?.key ?? 0) + 1 } }))
  },
  close() {
    set({ sheet: null })
  },
}))

/** for tests: forget what was asked */
export function resetRoomSaves() {
  asked.clear()
  useRoomSaves.setState({ byRoom: {}, sheet: null })
}
