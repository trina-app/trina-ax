// Whether the list panel beside the rail shows (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1 "Widths").
// - From 1052 px (72 rail + 240 panel + 740 for a room with its thread) it always shows.
// - Below that it folds away by itself while a thread, the room's ✦ side chat or a side panel (file preview, artifact,
//   browser) is open, and comes back when it closes; the rail stays.
// - While a room shows a thread and its ✦ side chat together it folds away below the rail at its widest (88), this
//   panel's width and 1060 for the room and both panels (lib/roomColumns.ts): 1448 px with the default width (at most
//   300), more when the person dragged it wider (components/PanelDivider.tsx, up to 400 px:
//   docs/decisions/20261127-list-panel-resize.md). So whenever the panel shows, the three columns fit; it comes back
//   when either closes (docs/decisions/20261117-thread-plus-trina.md).
// - Below that the person may also hide it with the panel's own button (remembered in this browser); it then stays
//   hidden, thread or not, until they show it again from the rail.
import { create } from 'zustand'
import { LIST_PANEL, readPanelFraction } from '../../lib/panelWidth'
import { THREE_MIN } from '../../lib/roomColumns'

export const PANEL_ALWAYS_PX = 1052
/** the rail at its widest and the panel's default width at its widest (PanelFrame) */
const RAIL_MAX_PX = 88
const PANEL_DEFAULT_MAX_PX = 300
/** from this width the panel shows also beside a room with its thread and side chat both open, with the panel's default
 * width */
export const PANEL_ALWAYS_BOTH_PX = RAIL_MAX_PX + PANEL_DEFAULT_MAX_PX + THREE_MIN
/** The same for a panel the person set to `width` px (null: the default): the rail, that panel and the three columns. */
export const panelAlwaysBothPx = (width: number | null): number => (width === null ? PANEL_ALWAYS_BOTH_PX : RAIL_MAX_PX + width + THREE_MIN)
const KEY = 'mycel.rail.listHidden'

const read = () => {
  try {
    return localStorage.getItem(KEY) === 'yes'
  } catch {
    return false
  }
}

/** `width`: the list panel's width the person set (px, remembered in this browser: lib/panelWidth.ts LIST_PANEL), null
 * for the default; `setWidth`: told by its divider when it changes */
export const useRailPanel = create<{ hidden: boolean; setHidden: (v: boolean) => void; width: number | null; setWidth: (v: number | null) => void }>((set) => ({
  hidden: typeof window === 'undefined' ? false : read(),
  width: typeof window === 'undefined' ? null : readPanelFraction(LIST_PANEL),
  setWidth: (width) => set({ width }),
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
 * its side chat together, and the window is narrower than panelAlwaysBothPx (the rail, the panel, the three columns): folded, whatever the person chose
 * below PANEL_ALWAYS_PX (their choice is back when one of the two closes). */
export function panelState(o: { wide: boolean; crowded: boolean; hidden: boolean; both?: boolean }): 'shown' | 'folded' | 'hidden' {
  if (o.wide) return o.both ? 'folded' : 'shown'
  if (o.hidden) return 'hidden'
  return o.crowded || o.both ? 'folded' : 'shown'
}
