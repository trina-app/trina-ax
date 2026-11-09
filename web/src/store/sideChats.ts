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
  /** the asks taken in (SideSeed.key, the latest last): a panel drawn again with one of them (the room page keeps its
   * last ask) does not quote it again */
  seedKeys: string[]
}

const EMPTY: SideChatState = { chatId: undefined, draft: '', quoted: null, seedKeys: [] }
/** how many asks a room remembers taking in */
export const SEED_KEYS_MAX = 20

interface SideChatsState {
  byRoom: Record<string, SideChatState>
  patch: (roomId: string, p: Partial<SideChatState>) => void
  /** the room is gone from my list: its side chat state goes too */
  drop: (roomId: string) => void
  reset: () => void
}

export const useSideChats = create<SideChatsState>((set) => ({
  byRoom: {},
  patch: (roomId, p) => set((s) => ({ byRoom: { ...s.byRoom, [roomId]: { ...(s.byRoom[roomId] ?? EMPTY), ...p } } })),
  drop: (roomId) => set((s) => {
    if (!(roomId in s.byRoom)) return {}
    const byRoom = { ...s.byRoom }
    delete byRoom[roomId]
    return { byRoom }
  }),
  reset: () => set({ byRoom: {} }),
}))

/** The room's side chat as it stands (nothing yet: not looked for). */
export const sideChatOf = (s: Pick<SideChatsState, 'byRoom'>, roomId: string): SideChatState => s.byRoom[roomId] ?? EMPTY
