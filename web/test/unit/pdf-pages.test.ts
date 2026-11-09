// The window math of the PDF preview's lazy pages (lib/pdfPages.ts, used by components/viewers/PdfView.tsx): where
// each page sits, which pages get a canvas for a scroll position and a view size, which page is being read, and the
// place kept when the pages change size. Drawing, the thumbnails and scrolling are checked in the browser
// (test/e2e/pdf-lazy-pages.spec.ts).
import { describe, expect, test } from 'bun:test'
import { anchorAt, anchorTop, currentPage, MARGIN_SCREENS, PAGE_GAP, pageHeight, pageLayout, pageStart, pageWindow } from '../../src/lib/pdfPages'

const A4 = { width: 595, height: 842 }
const LANDSCAPE = { width: 842, height: 595 }
/** 60 A4 pages fitted to the viewer's column (960 px less the padding): 1,313 px tall, a page every 1,325 px */
const sixty = () => pageLayout(Array.from({ length: 60 }, () => A4), 928)

describe('the placeholders', () => {
  test('a page is as tall as react-pdf draws it at that width (floored), from its own shape', () => {
    expect(pageHeight(A4, 928)).toBe(1313)
    expect(pageHeight(LANDSCAPE, 928)).toBe(655)
    // a size pdf.js could not give: square, never zero or NaN
    expect(pageHeight({ width: 0, height: 0 }, 300)).toBe(300)
    expect(pageHeight({ width: 10_000, height: 1 }, 300)).toBe(1)
  })

  test('pages follow each other with the gap, and one above the first and below the last', () => {
    const l = pageLayout([A4, LANDSCAPE, A4], 928)
    expect(l.tops).toEqual([12, 12 + 1313 + 12, 12 + 1313 + 12 + 655 + 12])
    expect(l.heights).toEqual([1313, 655, 1313])
    expect(l.total).toBe(12 + 1313 + 12 + 655 + 12 + 1313 + 12)
    expect(pageLayout([], 928)).toEqual({ tops: [], heights: [], total: 0 })
  })
})

describe('the pages drawn', () => {
  test('at the top of 60 pages in the viewer (an 800 px view): the first two, nothing far away', () => {
    // 1.5 screens below the view's bottom: down to 2,000 px, pages 1 and 2 (page 3 starts at 2,662)
    expect(pageWindow(sixty(), { top: 0, height: 800 })).toEqual({ first: 0, last: 1 })
  })

  test('in the middle: the pages within 1.5 screens above and below the view, three of sixty', () => {
    const l = sixty()
    // page 30 at the top of the view
    const top = l.tops[29]
    const w = pageWindow(l, { top, height: 800 })
    // from 1,200 px above (in page 29) to 2,000 px below the view's top (page 31)
    expect(w).toEqual({ first: 28, last: 30 })
  })

  test('at the bottom: the last pages, never past the end', () => {
    const l = sixty()
    const w = pageWindow(l, { top: l.total - 800, height: 800 })
    expect(w).toEqual({ first: 58, last: 59 })
  })

  test('the margin is the view height times MARGIN_SCREENS: a page just inside it is drawn, one just past it is not', () => {
    const l = sixty()
    // the view and its margin below reach (1 + MARGIN_SCREENS) view heights down: page 3 is drawn once they pass its top
    const reaching = (y: number) => ({ top: 0, height: y / (1 + MARGIN_SCREENS) })
    expect(pageWindow(l, reaching(l.tops[2] + 1)).last).toBe(2)
    expect(pageWindow(l, reaching(l.tops[2] - 1)).last).toBe(1)
    // and the same above: page 1 is released once the view's top is more than a margin below its bottom
    const bottom1 = l.tops[0] + l.heights[0]
    expect(pageWindow(l, { top: bottom1 + 799, height: 800 }).first).toBe(0)
    expect(pageWindow(l, { top: bottom1 + MARGIN_SCREENS * 800 + 1, height: 800 }).first).toBe(1)
  })

  test('zoomed out (small pages) more of them, all within the same reach; zoomed in fewer', () => {
    const small = pageLayout(Array.from({ length: 60 }, () => A4), 240)
    const w = pageWindow(small, { top: small.tops[20], height: 800 })
    // 1,200 px above and 2,000 px below page 21's top, a page every 351 px: pages 17 to 26
    expect(w).toEqual({ first: 16, last: 25 })
    // 3,939 px tall pages: page 21 and the bottom of page 20 within the margin above
    const big = pageLayout(Array.from({ length: 60 }, () => A4), 928 * 3)
    expect(pageWindow(big, { top: big.tops[20], height: 800 })).toEqual({ first: 19, last: 20 })
  })

  test('a view in the gap between two pages draws both neighbours; no pages, nothing', () => {
    const l = sixty()
    const w = pageWindow(l, { top: l.tops[10] - 6, height: 10 }, 0)
    expect(w).toEqual({ first: 10, last: 10 })
    expect(pageWindow(l, { top: l.tops[10] - 15, height: 20 }, 0)).toEqual({ first: 9, last: 10 })
    expect(pageWindow(pageLayout([], 928), { top: 0, height: 800 })).toEqual({ first: 0, last: -1 })
  })

  test('scrolled past the end or above the start (an elastic scroll): the nearest pages', () => {
    const l = sixty()
    expect(pageWindow(l, { top: l.total + 5000, height: 800 }, 0)).toEqual({ first: 59, last: 59 })
    expect(pageWindow(l, { top: -5000, height: 800 }, 0).first).toBe(0)
  })
})

describe('the page being read', () => {
  test('the page that fills most of the view, the earlier on a tie', () => {
    const l = sixty()
    expect(currentPage(l, { top: 0, height: 800 })).toBe(0)
    expect(currentPage(l, { top: l.tops[29], height: 800 })).toBe(29)
    // the view straddles pages 30 and 31: 31 has more of it
    expect(currentPage(l, { top: l.tops[30] - 300, height: 800 })).toBe(30)
    expect(currentPage(l, { top: l.tops[30] - 500, height: 800 })).toBe(29)
    // small pages, two whole ones in view: the first
    const small = pageLayout(Array.from({ length: 4 }, () => LANDSCAPE), 240)
    expect(currentPage(small, { top: 0, height: 400 })).toBe(0)
  })

  test('at the very end, the last page', () => {
    const l = sixty()
    expect(currentPage(l, { top: l.total - 800, height: 800 })).toBe(59)
  })
})

describe('the place kept when the pages change size', () => {
  test('a third of the way down page 30 stays a third of the way down it at twice the width', () => {
    const l = sixty()
    const top = l.tops[29] + l.heights[29] / 3
    const a = anchorAt(l, top)!
    expect(a.page).toBe(29)
    expect(a.offset).toBeCloseTo(1 / 3, 5)
    const zoomed = pageLayout(Array.from({ length: 60 }, () => A4), 928 * 2)
    expect(anchorTop(zoomed, a)).toBeCloseTo(zoomed.tops[29] + zoomed.heights[29] / 3, 5)
  })

  test('in the gap above a page: that page, a little above its top', () => {
    const l = sixty()
    const a = anchorAt(l, l.tops[5] - 6)!
    expect(a.page).toBe(5)
    expect(a.offset).toBeLessThan(0)
    expect(anchorTop(l, a)).toBeCloseTo(l.tops[5] - 6, 5)
  })

  test("a page's start puts its top just under the toolbar with the gap above it in view", () => {
    const l = sixty()
    expect(anchorTop(l, pageStart(l, 39))).toBeCloseTo(l.tops[39] - PAGE_GAP, 5)
    expect(anchorTop(l, pageStart(l, 0))).toBeCloseTo(0, 5)
  })

  test('a page whose real size comes in later: the place on the page being read stays', () => {
    const before = pageLayout(Array.from({ length: 10 }, () => A4), 600)
    const a = anchorAt(before, before.tops[6] + 100)!
    // page 3 turns out to be landscape: everything below it moves up, the anchor on page 7 moves with it
    const after = pageLayout(Array.from({ length: 10 }, (_, i) => (i === 2 ? LANDSCAPE : A4)), 600)
    expect(anchorTop(after, a)).toBeCloseTo(after.tops[6] + 100, 5)
    expect(after.tops[6]).toBeLessThan(before.tops[6])
  })

  test('no pages: no anchor, and the top', () => {
    const none = pageLayout([], 600)
    expect(anchorAt(none, 100)).toBeNull()
    expect(anchorTop(none, { page: 3, offset: 0.5 })).toBe(0)
  })
})
