// The Trina side chat of each room as it stands on this page (components/rooms/SideChatPanel.tsx): which of my side
// chats of the room it shows, what is typed in its box and the message or file quoted above it. Kept per room, like a
// room's draft (store/rooms.ts roomDrafts), so every panel of the room shows the same chat and draft: the room page's
// and one opened beside a file in the viewer. Gone at sign-out (store/rooms.ts reset).
import { create } from 'zustand'
import type { SideSeed } from '../components/rooms/SideChatPanel'

export interface SideChatState {
  /** undefined: not looked for yet (the panel asks for the room's newest side chat); null: none yet, or "new chat" (the
   * next question makes one) */
  chatId: string | null | undefined
  draft: string
  /** a message or file asked about: quoted in front of the next question, until it is sent or taken off */
  quoted: SideSeed | null
  /** the last ask taken in (SideSeed.key): a panel drawn again with the same ask does not quote it again */
  seedKey: string | null
}

const EMPTY: SideChatState = { chatId: undefined, draft: '', quoted: null, seedKey: null }

interface SideChatsState {
  byRoom: Record<string, SideChatState>
  patch: (roomId: string, p: Partial<SideChatState>) => void
  reset: () => void
}

export const useSideChats = create<SideChatsState>((set) => ({
  byRoom: {},
  patch: (roomId, p) => set((s) => ({ byRoom: { ...s.byRoom, [roomId]: { ...(s.byRoom[roomId] ?? EMPTY), ...p } } })),
  reset: () => set({ byRoom: {} }),
}))

/** The room's side chat as it stands (nothing yet: not looked for). */
export const sideChatOf = (s: Pick<SideChatsState, 'byRoom'>, roomId: string): SideChatState => s.byRoom[roomId] ?? EMPTY
