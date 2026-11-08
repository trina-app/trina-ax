// Who on the team is online or away (docs/DECISIONS.md "접속 상태"), as the socket tells it (lib/realtime.ts
// onPresence, store/live.ts): the whole list after each hello, then changes. Anyone not here is offline. Emptied when
// this window has lost the server for a while (its dots would be guesses) and on sign-out.
import { create } from 'zustand'
import type { PresenceFrame, PresenceState } from '@mycel/shared/api'

interface PresenceStore {
  byId: Record<string, Exclude<PresenceState, 'offline'>>
  apply: (f: PresenceFrame) => void
  clear: () => void
}

export const usePresence = create<PresenceStore>((set) => ({
  byId: {},
  apply: (f) =>
    set((s) => {
      const next = f.full ? {} : { ...s.byId }
      for (const p of f.people) {
        if (p.state === 'offline') delete next[p.id]
        else next[p.id] = p.state
      }
      return { byId: next }
    }),
  clear: () => set({ byId: {} }),
}))

/** A person's state now ('offline' when unknown). */
export function usePresenceOf(userId: string | null | undefined): PresenceState {
  return usePresence((s) => (userId ? s.byId[userId] : undefined) ?? 'offline')
}
