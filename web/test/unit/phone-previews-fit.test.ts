// Phone previews fit the screen (QA TC-259). An HTML page wider than its frame (a quotation drawn as a 794 px page in a
// 390 px phone preview) is fitted to the width with CSS zoom, with "실제 크기" to see it at its own size, and a pinch or
// double tap zooms the page inside its frame, not the app (lib/pageFit.ts); a PDF pinches through lib/usePinch.ts; on
// a phone only Markdown and .txt files offer edit (components/FilePanel.tsx phoneCanEdit). How it looks and the real
// touches are checked in WebKit (scratch screenshots in the PR).
import { describe, expect, test } from 'bun:test'
import { wrapHtml } from '../../src/lib/artifacts'
import { installPageFit, PAGE_FIT_SCRIPT, pageFitState, type PageFitState } from '../../src/lib/pageFit'
import { clamp, distance, isDoubleTap, midpoint } from '../../src/lib/usePinch'
import { phoneCanEdit } from '../../src/components/FilePanel'

type Handler = (e: unknown) => void
/** a frame's window, just what installPageFit reads: the page's natural width, the frame's width, scrolling, events */
function fakeWindow(natural: number, width: number) {
  const on: Record<string, Handler[]> = {}
  const add = (type: string, fn: Handler) => { (on[type] ??= []).push(fn) }
  const root = {
    style: { zoom: '', touchAction: '' },
    get scrollWidth() { return natural },
    clientWidth: width,
  }
  const doc = { documentElement: root, body: { scrollWidth: natural }, readyState: 'complete', addEventListener: add }
  const win = { document: doc, innerWidth: width, scrollX: 0, scrollY: 0, addEventListener: add, scrollTo(x: number, y: number) { win.scrollX = x; win.scrollY = y } }
  const fire = (type: string, e: Record<string, unknown>) => {
    const ev = { type, timeStamp: 0, touches: [], changedTouches: [], defaultPrevented: false, preventDefault() { ev.defaultPrevented = true }, ...e }
    for (const fn of on[type] ?? []) fn(ev)
    return ev
  }
  return { win: win as unknown as Window, root, fire, setWidth: (w: number) => { root.clientWidth = w; win.innerWidth = w } }
}
const touch = (x: number, y: number) => ({ clientX: x, clientY: y })

describe('an HTML page fitted to its frame', () => {
  test('a 794 px page in a 390 px frame: zoomed to the width, and it says it is wide', () => {
    const f = fakeWindow(794, 390)
    const states: PageFitState[] = []
    installPageFit(f.win, (s) => states.push(s))
    expect(Number(f.root.style.zoom)).toBeCloseTo(390 / 794, 3)
    expect(states.at(-1)).toEqual({ wide: true, zoom: 'fit' })
    expect(f.root.style.touchAction).toBe('pan-x pan-y')
  })

  test('"실제 크기" shows it at its own size, "화면에 맞추기" fits it again', () => {
    const f = fakeWindow(794, 390)
    const states: PageFitState[] = []
    const c = installPageFit(f.win, (s) => states.push(s))
    c.show('actual')
    expect(f.root.style.zoom).toBe('')
    expect(states.at(-1)).toEqual({ wide: true, zoom: 'actual' })
    c.show('fit')
    expect(Number(f.root.style.zoom)).toBeCloseTo(390 / 794, 3)
    expect(states.at(-1)).toEqual({ wide: true, zoom: 'fit' })
  })

  test('a page that fits (a responsive one) is left as it is, with nothing to toggle', () => {
    const f = fakeWindow(390, 390)
    const states: PageFitState[] = []
    installPageFit(f.win, (s) => states.push(s))
    expect(f.root.style.zoom).toBe('')
    expect(states).toEqual([{ wide: false, zoom: 'fit' }])
  })

  test('a wider frame (a computer, the panel made wider) measures again: the page fits as it is', () => {
    const f = fakeWindow(794, 390)
    const states: PageFitState[] = []
    installPageFit(f.win, (s) => states.push(s))
    f.setWidth(900)
    f.fire('resize', {})
    expect(f.root.style.zoom).toBe('')
    expect(states.at(-1)).toEqual({ wide: false, zoom: 'fit' })
  })

  test('a pinch inside the page zooms the page and keeps the browser from zooming the app', () => {
    const f = fakeWindow(794, 390)
    const states: PageFitState[] = []
    installPageFit(f.win, (s) => states.push(s))
    const start = f.fire('touchstart', { touches: [touch(100, 300), touch(200, 300)] })
    expect(start.defaultPrevented).toBe(true)
    // the fingers twice as far apart: twice the fitted zoom
    const move = f.fire('touchmove', { touches: [touch(50, 300), touch(250, 300)] })
    expect(move.defaultPrevented).toBe(true)
    expect(Number(f.root.style.zoom)).toBeCloseTo((2 * 390) / 794, 3)
    expect(states.at(-1)).toEqual({ wide: true, zoom: 'custom' })
    // not further than 400 %, not smaller than the fitted page
    f.fire('touchmove', { touches: [touch(0, 300), touch(5000, 300)] })
    expect(Number(f.root.style.zoom)).toBe(4)
    f.fire('touchmove', { touches: [touch(149, 300), touch(151, 300)] })
    expect(Number(f.root.style.zoom)).toBeCloseTo(390 / 794, 3)
    expect(f.fire('gesturestart', {}).defaultPrevented).toBe(true)
  })

  test("a page's own gesture (it cancelled the touches already) is left to the page", () => {
    const f = fakeWindow(794, 390)
    installPageFit(f.win, () => {})
    const zoom = f.root.style.zoom
    f.fire('touchstart', { touches: [touch(100, 300), touch(200, 300)], defaultPrevented: true })
    f.fire('touchmove', { touches: [touch(50, 300), touch(250, 300)], defaultPrevented: true })
    expect(f.root.style.zoom).toBe(zoom)
  })

  test('a double tap goes from the fitted page to its own size and back', () => {
    const f = fakeWindow(794, 390)
    const states: PageFitState[] = []
    installPageFit(f.win, (s) => states.push(s))
    const tap = (t: number) => {
      f.fire('touchstart', { touches: [touch(200, 200)], timeStamp: t })
      return f.fire('touchend', { changedTouches: [touch(200, 200)], timeStamp: t + 50 })
    }
    expect(tap(0).defaultPrevented).toBe(false)
    expect(tap(200).defaultPrevented).toBe(true)
    expect(f.root.style.zoom).toBe('')
    expect(states.at(-1)?.zoom).toBe('actual')
    tap(2000)
    tap(2200)
    expect(Number(f.root.style.zoom)).toBeCloseTo(390 / 794, 3)
    expect(states.at(-1)?.zoom).toBe('fit')
  })

  test('the script frame gets the same code as its source, and it runs on its own', () => {
    const html = wrapHtml('<div style="width:794px">견적서</div>', 'https://team.example', { gutter: true, fit: true })
    expect(html).toContain(PAGE_FIT_SCRIPT)
    expect(wrapHtml('<p>x</p>', 'https://team.example', { gutter: true })).not.toContain('"fit"')
    // run the script's body against a fake frame: it fits the page and tells its parent
    const f = fakeWindow(794, 390)
    const posted: unknown[] = []
    const parent = { postMessage: (m: unknown) => posted.push(m) }
    const body = PAGE_FIT_SCRIPT.replace(/^<script>/, '').replace(/<\/script>$/, '')
    new Function('window', 'parent', 'document', body)(f.win, parent, f.win.document)
    expect(Number(f.root.style.zoom)).toBeCloseTo(390 / 794, 3)
    expect(posted.at(-1)).toEqual({ source: 'mycel-frame', type: 'fit', wide: true, zoom: 'fit' })
  })

  test('the host takes only well-formed fit messages', () => {
    expect(pageFitState({ type: 'fit', wide: true, zoom: 'actual' })).toEqual({ wide: true, zoom: 'actual' })
    expect(pageFitState({ type: 'fit', wide: 'yes', zoom: 'fit' })).toBeNull()
    expect(pageFitState({ type: 'fit', wide: true, zoom: 'huge' })).toBeNull()
    expect(pageFitState({ type: 'error' })).toBeNull()
    expect(pageFitState(null)).toBeNull()
  })
})

describe('pinch and double tap math (lib/usePinch.ts)', () => {
  test('distance, midpoint, clamp', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
    expect(midpoint({ x: 0, y: 10 }, { x: 20, y: 30 })).toEqual({ x: 10, y: 20 })
    expect(clamp(5, 0.5, 3)).toBe(3)
    expect(clamp(0.1, 0.5, 3)).toBe(0.5)
  })

  test('a double tap: quick and at the same place', () => {
    expect(isDoubleTap(null, { x: 0, y: 0, t: 100 })).toBe(false)
    expect(isDoubleTap({ x: 0, y: 0, t: 0 }, { x: 10, y: 10, t: 250 })).toBe(true)
    expect(isDoubleTap({ x: 0, y: 0, t: 0 }, { x: 10, y: 10, t: 400 })).toBe(false)
    expect(isDoubleTap({ x: 0, y: 0, t: 0 }, { x: 100, y: 0, t: 100 })).toBe(false)
  })
})

describe('edit on a phone', () => {
  test('only Markdown and .txt: no raw source of a page, a table, a picture or code', () => {
    for (const n of ['readme.md', 'Notes.MD', 'guide.markdown', 'note.txt']) expect(phoneCanEdit(n)).toBe(true)
    for (const n of ['quote.html', 'data.csv', 'logo.svg', 'feed.xml']) expect(phoneCanEdit(n)).toBe(false)
    // the 'text' preview kind is more than .txt: code and config files are not edited on a phone (QA TC-259)
    for (const n of ['conf.json', 'ci.yml', 'app.ts', 'run.py', 'q.sql', 'go.sh', '.env', 'server.log', 'txt', 'md']) expect(phoneCanEdit(n)).toBe(false)
    expect(phoneCanEdit(null)).toBe(false)
  })
})
