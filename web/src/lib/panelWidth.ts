// The width of a panel set by dragging its divider (components/PanelDivider.tsx): the right-hand panel beside the chat
// (file preview, artifact, Browser pane: components/SidePanelFrame.tsx), a thread beside its room
// (components/rooms/ThreadPanel.tsx) and the list panel beside the rail (components/panels/PanelFrame.tsx).
// - The right-hand panels are kept per device as a FRACTION of the row the panel shares with the column on its left
//   (that column + the panel), so they stay sensible when the window or the list panel changes size.
// - The list panel is kept per device in PX (docs/decisions/20261127-list-panel-resize.md): the point is "my width on
//   this screen". A narrower window clamps it for the time being and gives it back when the window is wider again.

/** One resizable panel: where its width is remembered, its own minimum and the minimum of the column beside it.
 * `side`: where the panel is in its row, 'end' (right of the column it shares the row with: the divider on its left
 * edge; the default) or 'start' (left of it: the divider on its right edge). `remember`: a share of the row
 * ('fraction', the default) or px. `max`: a largest width of its own, whatever the room. */
export interface PanelSizing {
  key: string
  min: number
  otherMin: number
  side?: 'start' | 'end'
  remember?: 'px' | 'fraction'
  max?: number
}

/** The file preview, an artifact or the Browser pane beside the chat: the chat keeps 360 px. */
export const SIDE_PANEL: PanelSizing = { key: 'mycel.sidePanel.widthFraction', min: 320, otherMin: 360 }
/** A thread beside its room: the room's messages keep 420 px. */
export const THREAD_PANEL: PanelSizing = { key: 'mycel.threadPanel.widthFraction', min: 320, otherMin: 420 }
/** The same right-hand panel (and its remembered width) while a thread is open beside its room: the page beside it
 * keeps the room's 420 px and the thread's 320. */
export const SIDE_PANEL_BESIDE_THREAD: PanelSizing = { ...SIDE_PANEL, otherMin: THREAD_PANEL.otherMin + THREAD_PANEL.min }

/** The list panel beside the rail, in every place (트리나, 대화, 활동, 프로젝트, 파일): 240 to 400 px, and the main area
 * keeps 740 px (a room with its thread: components/rail/railPanel.ts PANEL_ALWAYS_PX = 72 + 240 + 740). */
export const LIST_PANEL: PanelSizing = { key: 'mycel.listPanel.width', min: 240, otherMin: 740, side: 'start', remember: 'px', max: 400 }

export const PANEL_STEP = 24
export const PANEL_BIG_STEP = 96

/** The smallest and largest panel width when `avail` px are shared by the column beside it and the panel. The column
 * keeps its minimum; where the window is too narrow for both minimums the panel minimum wins. */
export function panelLimits(avail: number, s: PanelSizing): { min: number; max: number } {
  return { min: s.min, max: Math.max(s.min, Math.min(s.max ?? Number.POSITIVE_INFINITY, Math.round(avail) - s.otherMin)) }
}

export function clampPanel(width: number, avail: number, s: PanelSizing): number {
  const { min, max } = panelLimits(avail, s)
  if (!Number.isFinite(width)) return min
  return Math.round(Math.min(max, Math.max(min, width)))
}

/** A width set for good (a drag ends, a key, a double-click with null): the width to show (null: the panel's default)
 * and what to remember (`fraction`: the share of `avail`, or the px for `remember: 'px'`; null: forget it). In a row
 * with no room to choose (the smallest width is also the largest) nothing was chosen: the `previous` one stays, so a
 * wider window later brings back the width picked before, not the cramped row's. */
export function settlePanel(px: number | null, avail: number, s: PanelSizing, previous: number | null): { width: number | null; fraction: number | null } {
  if (px === null) return { width: null, fraction: null }
  const { min, max } = panelLimits(avail, s)
  if (max <= min) return { width: fitPanel(previous, avail, s), fraction: previous }
  const width = clampPanel(px, avail, s)
  if (s.remember === 'px') return { width, fraction: width }
  return { width, fraction: avail > 0 ? width / avail : null }
}

/** The width to show for a remembered fraction (or px, `remember: 'px'`) when `avail` px are there now (another window
 * size, a larger text size), kept within the limits; null when nothing is remembered. */
export function fitPanel(fraction: number | null, avail: number, s: PanelSizing): number | null {
  if (fraction === null) return null
  return clampPanel(s.remember === 'px' ? fraction : fraction * avail, avail, s)
}

/** The width a key asks for on the focused divider, or null for a key it does not use. A panel on the divider's right
 * (`side` 'end'): Left widens it, Right narrows it; a panel on its left ('start', the list panel): Right widens it, Left
 * narrows it (Shift: a bigger step). Home is the smallest, End the largest. */
export function keyWidth(key: string, shift: boolean, current: number, limits: { min: number; max: number }, side: 'start' | 'end' = 'end'): number | null {
  const step = shift ? PANEL_BIG_STEP : PANEL_STEP
  const wider = side === 'start' ? 'ArrowRight' : 'ArrowLeft', narrower = side === 'start' ? 'ArrowLeft' : 'ArrowRight'
  if (key === wider) return current + step
  if (key === narrower) return current - step
  if (key === 'Home') return limits.min
  if (key === 'End') return limits.max
  return null
}

/** The remembered fraction (px for `remember: 'px'`), or null (nothing saved, not a number in (0,1) or not a px width
 * of at least the minimum, storage unavailable). */
export function readPanelFraction(s: PanelSizing): number | null {
  try {
    const raw = localStorage.getItem(s.key)
    if (raw === null) return null
    const v = Number(raw)
    if (s.remember === 'px') return Number.isFinite(v) && v >= s.min && v <= 4000 ? Math.round(v) : null
    return Number.isFinite(v) && v > 0 && v < 1 ? v : null
  } catch {
    return null
  }
}

/** Remember a fraction (px for `remember: 'px'`); null forgets it (the panel's default width again). */
export function writePanelFraction(f: number | null, s: PanelSizing) {
  try {
    if (f === null) localStorage.removeItem(s.key)
    else localStorage.setItem(s.key, s.remember === 'px' ? String(Math.round(f)) : String(Math.round(f * 10000) / 10000))
  } catch {
    /* storage unavailable: the width lasts until the page is closed */
  }
}
