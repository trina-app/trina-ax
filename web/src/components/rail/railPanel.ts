// Whether the list panel beside the rail shows (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1 "Widths").
// - From 1052 px (72 rail + 240 panel + 740 for a room with its thread) it always shows.
// - Below that it folds away by itself while a thread, the room's ✦ side chat or a side panel (file preview, artifact,
//   browser) is open, and comes back when it closes; the rail stays.
// - Below that the person may also hide it with the panel's own button (remembered in this browser); it then stays
//   hidden, thread or not, until they show it again from the rail.
import { create } from 'zustand'

export const PANEL_ALWAYS_PX = 1052
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
 * 'hidden' (the person's choice). `wide`: the window is PANEL_ALWAYS_PX or wider. */
export function panelState(o: { wide: boolean; crowded: boolean; hidden: boolean }): 'shown' | 'folded' | 'hidden' {
  if (o.wide) return 'shown'
  if (o.hidden) return 'hidden'
  return o.crowded ? 'folded' : 'shown'
}
