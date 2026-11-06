// Small app-wide UI state: toasts / notices, the connection banner, the mobile sidebar drawer, a newer server.
import { create } from 'zustand'
import type { ConnState } from '../lib/realtime'

export interface Toast {
  id: number
  level: 'info' | 'warn' | 'error' | 'success'
  text: string
  /** stays until closed */
  sticky?: boolean
  /** how long it stays when not sticky (default 4.5 s, 8 s for errors) */
  ms?: number
  /** a quiet second line */
  detail?: string
  /** a small picture on the left (a finished deck's cover) */
  image?: string
  /** `primary`: the toast's one main action as a button (else an underlined link like Undo) */
  action?: { label: string; run: () => void; primary?: boolean }
}

interface UiState {
  toasts: Toast[]
  conn: ConnState
  drawerOpen: boolean
  /** the server reported a different version than the one this page was loaded with */
  updateReady: boolean
  searchOpen: boolean
  toast: (t: Omit<Toast, 'id'>) => number
  dismiss: (id: number) => void
  setConn: (s: ConnState) => void
  setDrawer: (open: boolean) => void
  setUpdateReady: (v: boolean) => void
  setSearchOpen: (v: boolean) => void
}

let nextId = 1
/** Toasts a screen holds back while it is on screen (holdToasts): each match is asked before a toast shows. */
const holds = new Set<(t: Omit<Toast, 'id'>) => boolean>()
/**
 * While a screen already shows what a toast would say, it holds that toast back: `match` is asked for every toast
 * until the returned function is called (on unmount). A held toast is dropped, not queued (docs/DECISIONS.md "W5":
 * 내 스킬 가져오기 lists a Claude Code or Codex proposal itself, so the live notice about it would only cover the step).
 */
export function holdToasts(match: (t: Omit<Toast, 'id'>) => boolean): () => void {
  holds.add(match)
  return () => { holds.delete(match) }
}
export const useUi = create<UiState>((set, get) => ({
  toasts: [],
  conn: 'idle',
  drawerOpen: false,
  updateReady: false,
  searchOpen: false,
  toast(t) {
    const id = nextId++
    for (const match of holds) { try { if (match(t)) return id } catch { /* a broken match holds nothing */ } }
    set((s) => ({ toasts: [...s.toasts.slice(-4), { ...t, id }] }))
    if (!t.sticky) setTimeout(() => get().dismiss(id), t.ms ?? (t.level === 'error' ? 8000 : 4500))
    return id
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
  setConn: (conn) => set({ conn }),
  setDrawer: (drawerOpen) => set({ drawerOpen }),
  setUpdateReady: (updateReady) => set({ updateReady }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
}))

export const toast = (t: Omit<Toast, 'id'>) => useUi.getState().toast(t)
