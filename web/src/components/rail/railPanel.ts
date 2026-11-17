// Whether the list panel beside the rail shows (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1 "Widths").
// - From 1052 px (72 rail + 240 panel + 740 for a room with its thread) it always shows.
// - Below that it folds away by itself while a thread, the room's ✦ side chat or a side panel (file preview, artifact,
//   browser) is open, and comes back when it closes; the rail stays.
// - While a room shows a thread and its ✦ side chat together it folds away below 1448 px (the rail at its widest, 88,
//   this panel at its widest, 300, and 1060 for the room and both panels: lib/roomColumns.ts), so whenever the panel
//   shows, the three columns fit; it comes back when either closes (docs/decisions/20261117-thread-plus-trina.md).
// - Below that the person may also hide it with the panel's own button (remembered in this browser); it then stays
//   hidden, thread or not, until they show it again from the rail.
import { create } from 'zustand'

export const PANEL_ALWAYS_PX = 1052
/** from this width the panel shows also beside a room with its thread and side chat both open */
export const PANEL_ALWAYS_BOTH_PX = 1448
const KEY = 'mycel.rail.listHidden'

const read = () => {
  try {
    return localStorage.getItem(KEY) === 'yes'
  } catch {
    return false
  }
}

export const useRailPanel = create<{ hidden: boolean; setHidden: (v: boolean) => void }>((set) => ({
  hidden: typeof window === 'undefined' ? false : read(),
  setHidden: (hidden) => {
    try {
      if (hidden) localStorage.setItem(KEY, 'yes')
      else localStorage.removeItem(KEY)
    } catch {
      /* not kept: a private window may refuse */
    }
    set({ hidden })
  },
}))

/** The panel's state for a place that has one: 'shown', 'folded' (by itself, beside a thread or a side panel) or
 * 'hidden' (the person's choice). `wide`: the window is PANEL_ALWAYS_PX or wider. `both`: the room shows a thread and
 * its side chat together, and the window is narrower than PANEL_ALWAYS_BOTH_PX: folded, whatever the person chose
 * below PANEL_ALWAYS_PX (their choice is back when one of the two closes). */
export function panelState(o: { wide: boolean; crowded: boolean; hidden: boolean; both?: boolean }): 'shown' | 'folded' | 'hidden' {
  if (o.wide) return o.both ? 'folded' : 'shown'
  if (o.hidden) return 'hidden'
  return o.crowded || o.both ? 'folded' : 'shown'
}
