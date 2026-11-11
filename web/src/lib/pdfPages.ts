// The window math of the PDF preview's lazy pages (components/viewers/PdfView.tsx, docs/DECISIONS.md "Lazy PDF pages"):
// every page has a placeholder of its own size, and only the pages within a margin of the visible part of the scroll
// box get a canvas and a text layer. Everything here is in the page column's coordinates: 0 is the column's top, page 1
// starts one gap below it, and every page is drawn as wide as the others (fitted to the panel, times the zoom).

/** A page's size at scale 1 (pdf.js viewport: points, its own rotation applied). */
export interface PageSize {
  width: number
  height: number
}

/** The gap between pages, and above the first and below the last, in px (the column's gap-3 py-3). */
export const PAGE_GAP = 12

/** How far beyond the visible part pages are still drawn, in screens, above and below it. */
export const MARGIN_SCREENS = 1.5

/** Where each page is in the column: `tops[i]` and `heights[i]` are page i + 1's; `total` is the column's height. */
export interface PageLayout {
  tops: number[]
  heights: number[]
  total: number
}

/** The height of a page drawn `width` px wide, as react-pdf draws it (its canvas is the viewport's height, floored). */
export function pageHeight(size: PageSize, width: number): number {
  return size.width > 0 && size.height > 0 ? Math.max(1, Math.floor((width * size.height) / size.width)) : width
}

export function pageLayout(sizes: readonly PageSize[], width: number, gap = PAGE_GAP): PageLayout {
  const tops: number[] = []
  const heights: number[] = []
  let y = gap
  for (const s of sizes) {
    const h = pageHeight(s, width)
    tops.push(y)
    heights.push(h)
    y += h + gap
  }
  return { tops, heights, total: sizes.length ? y : 0 }
}

/** The part of the column in view: from `top`, `height` px tall (the scroll box minus the toolbar stuck over it). */
export interface PageView {
  top: number
  height: number
}

/** The first page (0-based) whose bottom is below `y`; the page count when none is. */
function firstBelow(layout: PageLayout, y: number): number {
  let lo = 0
  let hi = layout.tops.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (layout.tops[mid] + layout.heights[mid] > y) hi = mid
    else lo = mid + 1
  }
  return lo
}

/** The pages to draw (0-based, `first` to `last` included; `last` < `first` for none): those within `margin` px above
 * or below the view, so a page is drawn before it scrolls in and released when it is far away. */
export function pageWindow(layout: PageLayout, view: PageView, margin = view.height * MARGIN_SCREENS): { first: number; last: number } {
  const n = layout.tops.length
  if (!n) return { first: 0, last: -1 }
  const from = view.top - margin
  const to = view.top + view.height + margin
  const first = Math.min(firstBelow(layout, from), n - 1)
  let last = first
  while (last + 1 < n && layout.tops[last + 1] < to) last++
  return { first, last }
}

/** The page being read (0-based): the one that fills most of the view, the earlier one on a tie. */
export function currentPage(layout: PageLayout, view: PageView): number {
  const n = layout.tops.length
  if (!n) return 0
  const bottom = view.top + view.height
  let best = Math.min(firstBelow(layout, view.top), n - 1)
  let most = -1
  for (let i = best; i < n && layout.tops[i] < bottom; i++) {
    const shown = Math.min(bottom, layout.tops[i] + layout.heights[i]) - Math.max(view.top, layout.tops[i])
    if (shown > most) {
      most = shown
      best = i
    }
  }
  return best
}

/** A place in the document that stays put when the pages change size (zoom, a wider panel, a page's real size known):
 * a page, and how far down it the view's top is, as a part of its height (below 0 in the gap above it). */
export interface PageAnchor {
  page: number
  offset: number
}

export function anchorAt(layout: PageLayout, top: number): PageAnchor | null {
  const n = layout.tops.length
  if (!n) return null
  // the page under the view's top, or the next one when the top is in the gap above it
  const page = Math.min(firstBelow(layout, top), n - 1)
  return { page, offset: (top - layout.tops[page]) / layout.heights[page] }
}

/** The anchor of a page's start: its top just under the toolbar, with the gap above it in view. */
export function pageStart(layout: PageLayout, page: number): PageAnchor {
  const h = layout.heights[page] || 1
  return { page, offset: -PAGE_GAP / h }
}

/** The view's top that puts the anchor where it was. */
export function anchorTop(layout: PageLayout, anchor: PageAnchor): number {
  const i = Math.max(0, Math.min(anchor.page, layout.tops.length - 1))
  if (!layout.tops.length) return 0
  return layout.tops[i] + anchor.offset * layout.heights[i]
}

/** The page column's top in the layout (client y), from its top as drawn under a pinch's live `scale(k)` around a point
 * `originY` px below its layout top: the transform does not move the layout, and the place under the fingers is kept
 * in the layout's coordinates (measured on the drawn box, it was k times too far down the page; QA TC-259). */
export function layoutTop(drawnTop: number, originY: number, k: number): number {
  return drawnTop - originY * (1 - k)
}
