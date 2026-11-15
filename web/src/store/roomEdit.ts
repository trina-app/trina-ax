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

/** the places with a box on screen: each box's focus */
const boxes = new Map<string, Set<() => void>>()

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
  // (the boxes on screen stay: they say themselves when they go)
  reset: () => {
    set({ editing: {} })
    failedEdits.clear()
  },
}))

/** A box of this place is on screen (RoomComposer), with how it takes the focus; the returned function: it went. The
 * last box of a place to go ends its edit. */
export function registerRoomBox(place: string, focus: () => void = () => {}): () => void {
  const set = boxes.get(place) ?? new Set<() => void>()
  boxes.set(place, set)
  set.add(focus)
  return () => {
    set.delete(focus)
    if (set.size) return
    boxes.delete(place)
    useRoomEdit.getState().end(place)
  }
}

/** this place has a box on screen to edit in */
export const hasRoomBox = (place: string) => (boxes.get(place)?.size ?? 0) > 0

/** the focus into the place's box, at once: from the tap on Edit itself, so a phone's keyboard comes up (iOS opens it
 * only for a focus inside the tap) */
export function focusRoomBox(place: string) {
  // the box that came last (a thread's box opened over the room's)
  ;[...(boxes.get(place) ?? [])].at(-1)?.()
}
