// The width of the right-hand panel (file preview, artifact, Browser pane), set by dragging its divider
// (components/SidePanelFrame.tsx). Kept per device as a FRACTION of the room the chat and the panel share (the chat
// column + the panel), so it stays sensible when the window or the sidebar changes size; px would overflow a smaller window.
export const PANEL_MIN = 320
export const CHAT_MIN = 360
export const PANEL_STEP = 24
export const PANEL_BIG_STEP = 96
export const PANEL_WIDTH_KEY = 'mycel.sidePanel.widthFraction'

/** The smallest and largest panel width when `avail` px are shared by the chat column and the panel. The chat keeps
 * CHAT_MIN; where the window is too narrow for both minimums the panel minimum wins. */
export function panelLimits(avail: number): { min: number; max: number } {
  return { min: PANEL_MIN, max: Math.max(PANEL_MIN, Math.round(avail) - CHAT_MIN) }
}

export function clampPanel(width: number, avail: number): number {
  const { min, max } = panelLimits(avail)
  if (!Number.isFinite(width)) return min
  return Math.round(Math.min(max, Math.max(min, width)))
}

/** The remembered fraction, or null (nothing saved, not a number in (0,1), storage unavailable). */
export function readPanelFraction(): number | null {
  try {
    const raw = localStorage.getItem(PANEL_WIDTH_KEY)
    if (raw === null) return null
    const v = Number(raw)
    return Number.isFinite(v) && v > 0 && v < 1 ? v : null
  } catch {
    return null
  }
}

export function writePanelFraction(f: number | null) {
  try {
    if (f === null) localStorage.removeItem(PANEL_WIDTH_KEY)
    else localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(f * 10000) / 10000))
  } catch {
    /* storage unavailable: the width lasts until the page is closed */
  }
}
