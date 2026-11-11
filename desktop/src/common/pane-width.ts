// The width of the in-app browser beside the team page (docs/DECISIONS.md "브라우저 너비는 끌어서"): the person drags
// the edge between them (or focuses it and uses the arrow keys), double-click resets. It behaves like the web app's
// PanelDivider (web/src/lib/panelWidth.ts): remembered as a FRACTION of the window's width (window.json), so it stays
// sensible when the window changes size; the team page keeps PAGE_MIN px and the browser PANE_MIN px. Where the window
// is too narrow for both, the browser's minimum wins (the window's own minimum width, 900 px, leaves room for both).
// Pure (no Electron): unit-tested in tests/unit/e-pane-width.test.ts.

/** the browser's smallest width */
export const PANE_MIN = 400
/** the team page's smallest width beside the browser */
export const PAGE_MIN = 360
/** the browser's share of the window when nothing is remembered (and after a double-click on the edge) */
export const PANE_DEFAULT_FRACTION = 0.45
/** one arrow key on the focused edge; Shift: the big step */
export const PANE_STEP = 24
export const PANE_BIG_STEP = 96
/** the edge's grab strip over the team page's right edge (the browser toolbar's view reaches this far to the left) */
export const PANE_GRAB = 6

/** The grab strip's width for a browser whose left edge is at `paneX` (none when the browser fills the window). */
export function paneGrab(paneX: number): number {
  return Math.max(0, Math.min(PANE_GRAB, Math.round(paneX)))
}

export interface PaneLimits {
  min: number
  max: number
}

/** The smallest and largest browser width in a window `windowWidth` px wide. */
export function paneLimits(windowWidth: number): PaneLimits {
  const w = Math.max(0, Math.round(windowWidth))
  return { min: Math.min(PANE_MIN, w), max: Math.min(w, Math.max(PANE_MIN, w - PAGE_MIN)) }
}

export function clampPane(px: number, windowWidth: number): number {
  const { min, max } = paneLimits(windowWidth)
  if (!Number.isFinite(px)) return min
  return Math.round(Math.min(max, Math.max(min, px)))
}

/** The browser's width for a remembered fraction (null: the default) in a window this wide. */
export function paneWidthFor(fraction: number | null, windowWidth: number): number {
  return clampPane((fraction ?? PANE_DEFAULT_FRACTION) * windowWidth, windowWidth)
}

/** The browser's width when its left edge is dragged to `edgeX`, in the same coordinates as the window content's
 * left `contentX` (screen coordinates: the views move while the edge is dragged). */
export function paneFromEdge(edgeX: number, contentX: number, windowWidth: number): number {
  return clampPane(contentX + windowWidth - edgeX, windowWidth)
}

/** A width set for good (a drag ends, a key; null: double-click, back to the default): the fraction to remember (null:
 * the default). In a window with no room to choose (smallest width = largest) nothing was chosen: the `previous`
 * fraction stays, so a wider window later brings back the width picked before. */
export function settlePane(px: number | null, windowWidth: number, previous: number | null): number | null {
  if (px === null) return null
  const { min, max } = paneLimits(windowWidth)
  if (max <= min || windowWidth <= 0) return previous
  return Math.round((clampPane(px, windowWidth) / windowWidth) * 10_000) / 10_000
}

/** The width a key asks for on the focused edge, or null for a key it does not use. The browser is right of the edge:
 * Left widens it, Right narrows it (Shift: the big step); Home is the smallest, End the largest. */
export function paneKeyWidth(key: string, shift: boolean, current: number, limits: PaneLimits): number | null {
  const step = shift ? PANE_BIG_STEP : PANE_STEP
  if (key === 'ArrowLeft') return current + step
  if (key === 'ArrowRight') return current - step
  if (key === 'Home') return limits.min
  if (key === 'End') return limits.max
  return null
}

/** The fraction remembered in window.json, or null (nothing saved, not a number strictly between 0 and 1). */
export function readPaneFraction(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1 ? v : null
}
