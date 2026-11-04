// Can this person use AI now, and which button fits (GET /api/me/ai-access). One copy for the banner above the composer
// and the button in a failed answer. Nothing shows before the first answer, so it never flashes for people with AI.
import { create } from 'zustand'
import { api, API } from '../lib/api'
import type { AiAction } from '../lib/aiAccess'

interface State {
  loaded: boolean
  usable: boolean
  action: AiAction
  requested: boolean
  sending: boolean
  failed: boolean
  load: (force?: boolean) => Promise<void>
  ask: () => Promise<void>
  /** sign-out: nothing one person saw stays for the next */
  reset: () => void
}

export const useAiAccess = create<State>((set, get) => ({
  loaded: false, usable: true, action: 'ask_owner', requested: false, sending: false, failed: false,
  async load(force) {
    if (get().loaded && !force) return
    try {
      const r = await api.call(API.getAiAccess)
      set({ loaded: true, usable: r.usable, action: r.action, requested: r.requested })
    } catch {
      // a failed check is not "no AI": nothing shows
      set({ loaded: true, usable: true })
    }
  },
  reset() { set({ loaded: false, usable: true, action: 'ask_owner', requested: false, sending: false, failed: false }) },
  async ask() {
    if (get().sending || get().requested) return
    set({ sending: true, failed: false })
    try {
      await api.call(API.requestAiAccess)
      set({ requested: true, sending: false })
    } catch {
      set({ sending: false, failed: true })
    }
  },
}))
