// The width of a panel set by dragging its divider (components/PanelDivider.tsx): the right-hand panel beside the chat
// (file preview, artifact, Browser pane: components/SidePanelFrame.tsx) and a thread beside its room
// (components/rooms/ThreadPanel.tsx). Kept per device as a FRACTION of the row the panel shares with the column on its
// left (that column + the panel), so it stays sensible when the window or the sidebar changes size; px would overflow a
// smaller window.

/** One resizable panel: where its width is remembered, its own minimum and the minimum of the column beside it. */
export interface PanelSizing {
  key: string
  min: number
  otherMin: number
}

/** The file preview, an artifact or the Browser pane beside the chat: the chat keeps 360 px. */
export const SIDE_PANEL: PanelSizing = { key: 'mycel.sidePanel.widthFraction', min: 320, otherMin: 360 }
/** A thread beside its room: the room's messages keep 420 px. */
export const THREAD_PANEL: PanelSizing = { key: 'mycel.threadPanel.widthFraction', min: 320, otherMin: 420 }

export const PANEL_STEP = 24
export const PANEL_BIG_STEP = 96

/** The smallest and largest panel width when `avail` px are shared by the column beside it and the panel. The column
 * keeps its minimum; where the window is too narrow for both minimums the panel minimum wins. */
export function panelLimits(avail: number, s: PanelSizing): { min: number; max: number } {
  return { min: s.min, max: Math.max(s.min, Math.round(avail) - s.otherMin) }
}

export function clampPanel(width: number, avail: number, s: PanelSizing): number {
  const { min, max } = panelLimits(avail, s)
  if (!Number.isFinite(width)) return min
  return Math.round(Math.min(max, Math.max(min, width)))
}

/** A width set for good (a drag ends, a key, a double-click with null): the width to show (null: the panel's default)
 * and the fraction of `avail` to remember (null: forget it). */
export function settlePanel(px: number | null, avail: number, s: PanelSizing): { width: number | null; fraction: number | null } {
  if (px === null) return { width: null, fraction: null }
  const width = clampPanel(px, avail, s)
  return { width, fraction: avail > 0 ? width / avail : null }
}

/** The width to show for a remembered fraction when `avail` px are there now (another window size, a larger text
 * size), kept within the limits; null when nothing is remembered. */
export function fitPanel(fraction: number | null, avail: number, s: PanelSizing): number | null {
  return fraction === null ? null : clampPanel(fraction * avail, avail, s)
}

/** The width a key asks for on the focused divider, or null for a key it does not use. The panel is on the divider's
 * right: Left widens it, Right narrows it (Shift: a bigger step); Home is the smallest, End the largest. */
export function keyWidth(key: string, shift: boolean, current: number, limits: { min: number; max: number }): number | null {
  const step = shift ? PANEL_BIG_STEP : PANEL_STEP
  if (key === 'ArrowLeft') return current + step
  if (key === 'ArrowRight') return current - step
  if (key === 'Home') return limits.min
  if (key === 'End') return limits.max
  return null
}

/** The remembered fraction, or null (nothing saved, not a number in (0,1), storage unavailable). */
export function readPanelFraction(s: PanelSizing): number | null {
  try {
    const raw = localStorage.getItem(s.key)
    if (raw === null) return null
    const v = Number(raw)
    return Number.isFinite(v) && v > 0 && v < 1 ? v : null
  } catch {
    return null
  }
}

/** Remember a fraction; null forgets it (the panel's default width again). */
export function writePanelFraction(f: number | null, s: PanelSizing) {
  try {
    if (f === null) localStorage.removeItem(s.key)
    else localStorage.setItem(s.key, String(Math.round(f * 10000) / 10000))
  } catch {
    /* storage unavailable: the width lasts until the page is closed */
  }
}
