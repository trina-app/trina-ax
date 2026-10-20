// Small app-wide UI state: toasts / notices, the connection banner, the mobile sidebar drawer, a newer server.
import { create } from 'zustand'
import type { ConnState } from '../lib/realtime'

export interface Toast {
  id: number
  level: 'info' | 'warn' | 'error' | 'success'
  text: string
  /** stays until closed */
  sticky?: boolean
  action?: { label: string; run: () => void }
}

interface UiState {
  toasts: Toast[]
  conn: ConnState
  drawerOpen: boolean
  /** the server reported a different version than the one this page was loaded with */
  updateReady: boolean
  searchOpen: boolean
  /** answers that finished while the window was hidden (the tab title shows "(N) …" until it is seen again) */
  unseenDone: number
  toast: (t: Omit<Toast, 'id'>) => number
  dismiss: (id: number) => void
  setConn: (s: ConnState) => void
  setDrawer: (open: boolean) => void
  setUpdateReady: (v: boolean) => void
  setSearchOpen: (v: boolean) => void
  setUnseenDone: (n: number) => void
}

let nextId = 1
export const useUi = create<UiState>((set, get) => ({
  toasts: [],
  conn: 'idle',
  drawerOpen: false,
  updateReady: false,
  searchOpen: false,
  unseenDone: 0,
  toast(t) {
    const id = nextId++
    set((s) => ({ toasts: [...s.toasts.slice(-4), { ...t, id }] }))
    if (!t.sticky) setTimeout(() => get().dismiss(id), t.level === 'error' ? 8000 : 4500)
    return id
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
  setConn: (conn) => set({ conn }),
  setDrawer: (drawerOpen) => set({ drawerOpen }),
  setUpdateReady: (updateReady) => set({ updateReady }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setUnseenDone: (unseenDone) => set({ unseenDone }),
}))

export const toast = (t: Omit<Toast, 'id'>) => useUi.getState().toast(t)
