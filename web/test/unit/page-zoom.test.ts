// lib/pageZoom.ts (QA TC-246): where the web app is an app (the phone app's WebView, the installed web app) the whole
// page never zooms: the viewport meta holds the scale at 1 and <html data-page-zoom="off"> gets touch-action pan-x pan-y
// (index.css). A plain browser tab keeps the browser's own zoom. The phone app's bridge arriving after the page loaded
// turns it on then.
import { describe, expect, test } from 'bun:test'
import { holdPageZoom, pageZoomOff, shownIn, viewportContent, type ZoomWindow } from '../../src/lib/pageZoom'

const BASE = 'width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content'
const BRIDGE = { protocol: 1, appVersion: '0.3.0', platform: 'ios', generation: 1, nonce: 'a'.repeat(64), capabilities: [] }

type Listener = (e: { preventDefault(): void }) => void
/** A window with a viewport meta, as the page has it; `more`: what the phone app or the browser puts on it. */
function fakeWindow(more: { webView?: boolean; bridge?: boolean; displayStandalone?: boolean; navStandalone?: boolean; framed?: boolean; coarse?: boolean } = {}) {
  const attrs: Record<string, string> = { content: BASE }
  const meta = { getAttribute: (k: string) => attrs[k] ?? null, setAttribute: (k: string, v: string) => { attrs[k] = v } }
  const docListeners = new Map<string, Listener>()
  const winListeners = new Map<string, () => void>()
  const dataset: Record<string, string> = {}
  const document = {
    querySelector: (sel: string) => (sel === 'meta[name="viewport"]' ? meta : null),
    documentElement: { dataset },
    addEventListener: (type: string, fn: Listener, o?: AddEventListenerOptions) => {
      expect(o?.passive).toBe(false)
      docListeners.set(type, fn)
    },
    removeEventListener: (type: string) => void docListeners.delete(type),
  }
  const w: Record<string, unknown> = {
    document,
    navigator: more.navStandalone ? { standalone: true } : {},
    matchMedia: (q: string) => ({ matches: (q === '(display-mode: standalone)' && !!more.displayStandalone) || (q === '(pointer: coarse)' && !!more.coarse), addEventListener: () => {} }),
    addEventListener: (type: string, fn: () => void) => void winListeners.set(type, fn),
  }
  w.self = w
  w.top = more.framed ? {} : w
  if (more.webView) w.ReactNativeWebView = { postMessage: () => {} }
  if (more.bridge) w.mycelMobile = BRIDGE
  return {
    win: w as unknown as ZoomWindow,
    raw: w,
    content: () => attrs.content,
    held: () => dataset.pageZoom,
    gestures: () => [...docListeners.keys()].sort(),
    fire: (type: string) => winListeners.get(type)?.(),
  }
}

describe('where the page holds its zoom', () => {
  test('the phone app (with its bridge, or before it came), the installed app: yes; a browser tab: no', () => {
    expect(pageZoomOff({ app: true, standalone: false, handheld: true })).toBe(true)
    expect(pageZoomOff({ app: true, standalone: false, handheld: false })).toBe(true)
    expect(pageZoomOff({ app: false, standalone: true, handheld: true })).toBe(true)
    // an app installed on a computer (Chrome/Edge "Install app", Safari "Add to Dock"): its pinch is the person's zoom
    expect(pageZoomOff({ app: false, standalone: true, handheld: false })).toBe(false)
    expect(pageZoomOff({ app: false, standalone: false, handheld: true })).toBe(false)

    expect(shownIn(fakeWindow({ webView: true, bridge: true }).win)).toEqual({ app: true, standalone: false, handheld: false })
    // react-native-webview's object is there before the page's scripts; the bridge only after the page loaded
    expect(shownIn(fakeWindow({ webView: true }).win)).toEqual({ app: true, standalone: false, handheld: false })
    expect(shownIn(fakeWindow({ displayStandalone: true }).win)).toEqual({ app: false, standalone: true, handheld: false })
    // an iPhone's Home Screen app
    expect(shownIn(fakeWindow({ navStandalone: true }).win)).toEqual({ app: false, standalone: true, handheld: false })
    expect(shownIn(fakeWindow().win)).toEqual({ app: false, standalone: false, handheld: false })
    // a page that only names the bridge is no app: the app's WebView object is what says so
    expect(shownIn(fakeWindow({ bridge: true }).win)).toEqual({ app: false, standalone: false, handheld: false })
  })

  test('the viewport: the scale held at 1, its width, initial scale, viewport-fit and keyboard rule kept', () => {
    expect(viewportContent(BASE, true)).toBe(`${BASE}, maximum-scale=1, user-scalable=no`)
    expect(viewportContent(BASE, false)).toBe(BASE)
    // limits it had are replaced, not doubled
    expect(viewportContent('width=device-width, minimum-scale=0.5, Maximum-Scale=5, user-scalable=yes, viewport-fit=cover', true))
      .toBe('width=device-width, viewport-fit=cover, maximum-scale=1, user-scalable=no')
  })
})

describe('holdPageZoom', () => {
  test('the phone app: the meta, the root mark and Safari gesture events held at once', () => {
    const f = fakeWindow({ webView: true, bridge: true })
    holdPageZoom(f.win)
    expect(f.content()).toBe(`${BASE}, maximum-scale=1, user-scalable=no`)
    expect(f.content()).toContain('viewport-fit=cover')
    expect(f.held()).toBe('off')
    expect(f.gestures()).toEqual(['gesturechange', 'gesturestart'])
  })

  test('the web app installed on a computer (a fine pointer): the browser default, untouched', () => {
    const f = fakeWindow({ displayStandalone: true })
    holdPageZoom(f.win)
    expect(f.content()).not.toContain('user-scalable=no')
    expect(f.held()).toBeUndefined()
  })

  test('the installed web app on a phone or tablet: held', () => {
    const f = fakeWindow({ displayStandalone: true, coarse: true })
    holdPageZoom(f.win)
    expect(f.content()).toContain('user-scalable=no')
    expect(f.held()).toBe('off')
  })

  test('a plain browser tab: the browser default, untouched', () => {
    const f = fakeWindow()
    holdPageZoom(f.win)
    expect(f.content()).toBe(BASE)
    expect(f.held()).toBeUndefined()
    expect(f.gestures()).toEqual([])
  })

  test('the app\'s WebView object late: held when the bridge says it is ready', () => {
    const f = fakeWindow()
    holdPageZoom(f.win)
    expect(f.held()).toBeUndefined()
    f.raw.ReactNativeWebView = { postMessage: () => {} }
    f.raw.mycelMobile = BRIDGE
    f.fire('mycel:mobile-ready')
    expect(f.content()).toBe(`${BASE}, maximum-scale=1, user-scalable=no`)
    expect(f.held()).toBe('off')
  })

  test('a page in a frame: left alone', () => {
    const f = fakeWindow({ webView: true, framed: true })
    holdPageZoom(f.win)
    expect(f.content()).toBe(BASE)
    expect(f.held()).toBeUndefined()
  })
})
