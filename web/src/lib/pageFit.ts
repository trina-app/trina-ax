// An HTML file's page fitted to its preview's width (QA TC-259): a quotation drawn as a fixed 794 px page was cut on the
// right in a phone's 390 px preview. A page wider than its frame is zoomed out (CSS `zoom` on its root) until it fits;
// "실제 크기" shows it at its own size again, and a pinch or a double tap zooms it inside the frame (between the fitted
// size and 400 %), never the app around it. A page that already fits (a responsive one) is left as it is.
//
// installPageFit runs in the page's window. In the script frame (SandboxFrame) it is part of the document
// (lib/artifacts.ts wrapHtml `fit`, as its source text: so it uses nothing from outside itself and plain JavaScript
// only); in the static frame (no scripts) the host calls it on the frame's same-origin window. It tells the host
// whether the page is wider than the frame and how it is shown; the host's bar (components/SandboxFrame.tsx PageFitBar)
// asks for 'fit' or 'actual'.

/** How a page is shown: fitted to the width, at its own size, or zoomed by a pinch. */
export type PageZoom = 'fit' | 'actual' | 'custom'
/** What the page tells its host: `wide`, whether it is wider than the frame (only then is there anything to toggle). */
export interface PageFitState { wide: boolean; zoom: PageZoom }
export interface PageFitControl {
  /** shows the page fitted or at its own size */
  show: (to: 'fit' | 'actual') => void
  /** measures the page again (its frame changed width, its pictures came in) */
  refit: () => void
}

export function installPageFit(win: Window, report: (state: PageFitState) => void): PageFitControl {
  var doc = win.document
  var root = doc.documentElement
  // the zoom a pinch can reach; a double tap on a page that fits goes to DOUBLE
  var MAX = 4
  var DOUBLE = 2
  var TAP_MS = 300
  var TAP_PX = 30
  var SLOP = 10
  var fit = 1
  var zoom = 1
  var mode: PageZoom = 'fit'
  var told = ''

  var near = function (a: number, b: number) { return Math.abs(a - b) < 0.005 }
  var tell = function () {
    var state: PageFitState = { wide: fit < 1, zoom: near(zoom, fit) ? 'fit' : near(zoom, 1) ? 'actual' : 'custom' }
    var key = state.wide + state.zoom
    if (key === told) return
    told = key
    report(state)
  }
  var measure = function () {
    var was = root.style.zoom
    root.style.zoom = ''
    var natural = Math.max(root.scrollWidth, doc.body ? doc.body.scrollWidth : 0)
    var width = root.clientWidth || win.innerWidth
    root.style.zoom = was
    fit = width > 0 && natural > width + 1 ? width / natural : 1
  }
  /** shows the page at `to`, keeping the point `at` (in the frame's viewport) where it is */
  var set = function (to: number, at: { x: number; y: number }) {
    var z = Math.min(MAX, Math.max(Math.min(fit, 1), to))
    var k = z / zoom
    var sx = win.scrollX
    var sy = win.scrollY
    zoom = z
    root.style.zoom = near(z, 1) ? '' : String(z)
    if (!near(k, 1)) win.scrollTo((sx + at.x) * k - at.x, (sy + at.y) * k - at.y)
    tell()
  }
  var corner = { x: 0, y: 0 }
  var refit = function () {
    measure()
    set(mode === 'fit' ? fit : mode === 'actual' ? 1 : zoom, corner)
  }
  var show = function (to: 'fit' | 'actual') {
    mode = to
    set(to === 'fit' ? fit : 1, corner)
  }

  // ---- a pinch and a double tap inside the page (the same as lib/usePinch.ts, which the page cannot import) ----
  type P = { x: number; y: number }
  var pt = function (t: Touch): P { return { x: t.clientX, y: t.clientY } }
  var dist = function (a: P, b: P) { return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)) }
  var mid = function (a: P, b: P): P { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }
  var pinch: { from: number; zoom: number } | null = null
  var tap: (P & { t: number }) | null = null
  var lastTap: (P & { t: number }) | null = null
  doc.addEventListener('touchstart', function (e: TouchEvent) {
    if (e.touches.length >= 2) {
      e.preventDefault()
      tap = lastTap = null
      pinch = { from: Math.max(1, dist(pt(e.touches[0]!), pt(e.touches[1]!))), zoom: zoom }
    } else if (e.touches.length === 1) {
      var p = pt(e.touches[0]!)
      tap = { x: p.x, y: p.y, t: e.timeStamp }
    }
  }, { passive: false })
  doc.addEventListener('touchmove', function (e: TouchEvent) {
    if (pinch && e.touches.length >= 2) {
      e.preventDefault()
      var a = pt(e.touches[0]!)
      var b = pt(e.touches[1]!)
      mode = 'custom'
      set(pinch.zoom * dist(a, b) / pinch.from, mid(a, b))
    } else if (tap && e.touches[0] && dist(tap, pt(e.touches[0])) > SLOP) tap = null
  }, { passive: false })
  var end = function (e: TouchEvent) {
    if (pinch) {
      if (e.touches.length < 2) pinch = null
      return
    }
    var start = tap
    tap = null
    var lifted = e.changedTouches[0]
    if (!start || !lifted || e.touches.length || e.type === 'touchcancel') return
    var now = { x: lifted.clientX, y: lifted.clientY, t: e.timeStamp }
    if (dist(start, now) > SLOP || now.t - start.t > TAP_MS) {
      lastTap = null
      return
    }
    if (lastTap && now.t - lastTap.t <= TAP_MS && dist(lastTap, now) <= TAP_PX) {
      e.preventDefault()
      lastTap = null
      // zoomed in: back to the fitted page; fitted: its own size (a page that fits: twice as large)
      var to = zoom > fit + 0.005 ? fit : fit < 1 ? 1 : DOUBLE
      mode = near(to, fit) ? 'fit' : near(to, 1) ? 'actual' : 'custom'
      set(to, now)
    } else lastTap = now
  }
  doc.addEventListener('touchend', end, { passive: false })
  doc.addEventListener('touchcancel', end, { passive: false })
  // Safari's own pinch, which would zoom the app around the frame
  var hold = function (e: Event) { e.preventDefault() }
  doc.addEventListener('gesturestart', hold, { passive: false })
  doc.addEventListener('gesturechange', hold, { passive: false })
  root.style.touchAction = 'pan-x pan-y'

  win.addEventListener('resize', refit)
  win.addEventListener('load', refit)
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', refit)
  else refit()
  if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(refit, function () {})
  return { show: show, refit: refit }
}

/** The script that fits a page in the script frame: installPageFit as its source, telling the host by message and
 * taking 'fit' / 'actual' from it (only from the parent). */
export const PAGE_FIT_SCRIPT = `<script>(function(){
  var fit = (${installPageFit.toString()})(window, function (s) { try { parent.postMessage({ source: "mycel-frame", type: "fit", wide: s.wide, zoom: s.zoom }, "*"); } catch (e) {} });
  window.addEventListener("message", function (e) {
    var d = e.data;
    if (e.source === parent && d && d.source === "mycel-host" && d.type === "zoom" && (d.to === "fit" || d.to === "actual")) fit.show(d.to);
  });
})();</script>`

/** A frame's message to its host about its page, or null when it is something else. */
export function pageFitState(data: unknown): PageFitState | null {
  const d = data as { type?: unknown; wide?: unknown; zoom?: unknown } | null
  if (!d || d.type !== 'fit' || typeof d.wide !== 'boolean' || (d.zoom !== 'fit' && d.zoom !== 'actual' && d.zoom !== 'custom')) return null
  return { wide: d.wide, zoom: d.zoom }
}
