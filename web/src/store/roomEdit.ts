// A message of mine being edited in a room's box at the bottom (a phone: components/rooms/RoomMessages.tsx moves the
// edit there when that place has a box on screen, RoomComposer.tsx takes it). By place (store/rooms.ts placeKey: the
// room's box or a thread's box), the message's id. A computer edits inside the message and never comes here.
import { create } from 'zustand'

interface RoomEditStore {
  /** place → the message being edited in its box */
  editing: Record<string, string>
  start: (place: string, messageId: string) => void
  /** the edit in that place ends (saved, cancelled, the box went) */
  end: (place: string) => void
  reset: () => void
}

/** the places with a box on screen, and how many */
const boxes = new Map<string, number>()

/** an edit that failed, by message: its box opens again with the words typed and the people they mention; kept a moment
 * only (the box opens at once, or not: another message is being edited, the room was left) */
export const failedEdits = new Map<string, { text: string; mentions: string[] }>()

export const useRoomEdit = create<RoomEditStore>((set) => ({
  editing: {},
  start: (place, messageId) => set((s) => ({ editing: { ...s.editing, [place]: messageId } })),
  end: (place) =>
    set((s) => {
      if (!(place in s.editing)) return s
      const { [place]: _gone, ...rest } = s.editing
      return { editing: rest }
    }),
  reset: () => {
    boxes.clear()
    failedEdits.clear()
  },
}))

/** A box of this place is on screen (RoomComposer); the returned function: it went. The last box of a place to go ends
 * its edit. */
export function registerRoomBox(place: string): () => void {
  boxes.set(place, (boxes.get(place) ?? 0) + 1)
  return () => {
    const n = (boxes.get(place) ?? 1) - 1
    if (n > 0) return void boxes.set(place, n)
    boxes.delete(place)
    useRoomEdit.getState().end(place)
  }
}

/** this place has a box on screen to edit in */
export const hasRoomBox = (place: string) => (boxes.get(place) ?? 0) > 0
