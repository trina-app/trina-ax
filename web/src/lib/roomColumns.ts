// How a room's page lays out a thread and the ✦ side chat when both are open (pages/Room.tsx;
// docs/decisions/20261117-thread-plus-trina.md). By the width of the page's own row (the window less the rail, the
// conversation list when it shows and a file preview panel), not the window:
// - 'three' (THREE_MIN or more): room, thread, side chat as three columns. The room keeps ROOM_MIN, each panel
//   PANEL_MIN; the two panels share what the room leaves evenly (components/rooms/RoomSideColumn.tsx `shared`).
// - 'pair' (PAIR_MIN or more): the thread and the side chat share the row half and half over the room, which waits
//   under them as it does under a sheet.
// - 'one' (narrower: a phone, a small window with a file preview): one panel at a time, the side chat over the thread.
// The conversation list folds away first while both are open (components/rail/railPanel.ts PANEL_ALWAYS_BOTH_PX), so
// three columns fit from a window of about 1132 px.
import { useLayoutEffect, useState, type RefObject } from 'react'
import { THREAD_PANEL } from './panelWidth'

/** the room's messages keep this beside a panel */
export const ROOM_MIN = THREAD_PANEL.otherMin
/** a thread or the side chat is never narrower */
export const PANEL_MIN = THREAD_PANEL.min
/** the narrowest row that holds the room and both panels */
export const THREE_MIN = ROOM_MIN + 2 * PANEL_MIN

/** the narrowest row that holds both panels side by side */
export const PAIR_MIN = 2 * PANEL_MIN

export type RoomColumns = 'three' | 'pair' | 'one'

/** `row`: the page's row in px (null or 0: not measured, a test without layout: as a wide row). */
export function roomColumns(row: number | null): RoomColumns {
  if (!row || row >= THREE_MIN) return 'three'
  return row >= PAIR_MIN ? 'pair' : 'one'
}

/** One panel (a thread, the side chat or the Files list) alone beside the room: does the row leave the room less than
 * ROOM_MIN beside a PANEL_MIN panel (a file preview beside the page takes the rest)? Then the panel is a sheet over the
 * room (pages/Room.tsx), never a room one character wide. `row`: as roomColumns (not measured: no). */
export function roomSqueezed(row: number | null): boolean {
  return !!row && row < ROOM_MIN + PANEL_MIN
}

/** The element's width, read before the first paint and again whenever it changes (null until measured, and where
 * nothing lays the page out). A caller that lays itself out by it draws again on every change. */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => setWidth(el.offsetWidth || null)
    read()
    window.addEventListener('resize', read)
    const ro = typeof globalThis.ResizeObserver === 'undefined' ? null : new ResizeObserver(read)
    ro?.observe(el)
    return () => {
      window.removeEventListener('resize', read)
      ro?.disconnect()
    }
  }, [ref])
  return width
}
