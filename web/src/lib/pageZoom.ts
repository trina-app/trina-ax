// No zoom of the whole page where the web app is an app (QA TC-246): a pinch or a double tap on a page in the phone app
// scaled the whole app (the bar and ✕ went off the screen). Inside the phone app's WebView (react-native-webview's
// window.ReactNativeWebView, and the bridge lib/mobile.ts reads once the app installs it) and in the installed web app
// (display-mode: standalone, an iPhone's Home Screen), the page holds its zoom at 1:
// - the viewport meta gets maximum-scale=1, user-scalable=no (iOS WKWebView and Android's WebView honour it; it also
//   stops iOS zooming into a field, which are 16px on touch screens anyway: index.css);
// - <html data-page-zoom="off">, which index.css gives touch-action: pan-x pan-y (Safari and Chromium: no pinch and no
//   double-tap zoom; scrolling as before);
// - Safari's gesture events on the document are cancelled (a Home Screen app may ignore user-scalable=no).
// A plain browser tab keeps the browser's own zoom: people zoom pages there (accessibility). In the app, the text size
// setting (Settings > Profile > 글자 크기, lib/textSize.ts) is the way to larger text.
//
// A viewer that zooms on its own puts data-own-zoom on its zoomable surface: index.css gives it touch-action: none, so
// the whole gesture reaches its handlers and the browser does nothing there (components/ImageViewer.tsx's stage). A
// viewer that leaves one-finger scrolling to the browser sets touch-action: pan-x pan-y on its element instead
// (lib/usePinch.ts, a PDF's pages). touch-action only narrows down the tree, so the root's rule never takes a viewer's
// own pinch away: its touch events still come.
import { insidePhoneApp, standaloneOf } from './pwa'

/** What a page is shown in: the phone app's WebView (`app`), the installed web app (`standalone`), or neither (a plain
 * browser tab). */
export interface ShownIn { app: boolean; standalone: boolean }
/** Where the page holds its zoom: the phone app's WebView or the installed web app; not a plain browser tab. */
export const pageZoomOff = (where: ShownIn) => where.app || where.standalone

/** The window-like part read here (a fake one in unit tests). */
export type ZoomWindow = Pick<Window, 'top' | 'self' | 'document' | 'navigator' | 'addEventListener'> & { matchMedia?: Window['matchMedia'] }
/** What `win` is shown in. The app: react-native-webview's window.ReactNativeWebView, there before the page's own
 * scripts (lib/pwa.ts insidePhoneApp); the app's bridge (window.mycelMobile, lib/mobile.ts mobileApp) comes after the
 * page loaded and always beside it. Installed: display-mode standalone, or an iPhone's Home Screen. */
export const shownIn = (win: ZoomWindow): ShownIn => ({
  app: insidePhoneApp(win),
  standalone: standaloneOf(!!win.matchMedia?.('(display-mode: standalone)').matches, (win.navigator as { standalone?: unknown }).standalone),
})

const HELD = ['maximum-scale', 'minimum-scale', 'user-scalable']
/** The viewport meta's content: `base` as it is, or with the zoom held at 1 (its own width, initial scale,
 * viewport-fit and interactive-widget kept). */
export function viewportContent(base: string, off: boolean): string {
  if (!off) return base
  const kept = base.split(',').map((p) => p.trim()).filter((p) => p && !HELD.includes(p.split('=')[0]!.trim().toLowerCase()))
  return [...kept, 'maximum-scale=1', 'user-scalable=no'].join(', ')
}

const holdGesture = (e: Event) => e.preventDefault()

/** Holds the page's zoom where the web app is an app, now and when that changes: the phone app's bridge arriving after
 * the page loaded, a display-mode change. Once, from main.tsx; the top page only. */
export function holdPageZoom(win: ZoomWindow = window): void {
  if (win.top !== win.self) return
  const doc = win.document
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="viewport"]')
  const base = meta?.getAttribute('content') ?? ''
  let held = false
  const apply = () => {
    const off = pageZoomOff(shownIn(win))
    if (off === held) return
    held = off
    meta?.setAttribute('content', viewportContent(base, off))
    if (off) doc.documentElement.dataset.pageZoom = 'off'
    else delete doc.documentElement.dataset.pageZoom
    for (const g of ['gesturestart', 'gesturechange']) {
      if (off) doc.addEventListener(g, holdGesture, { passive: false })
      else doc.removeEventListener(g, holdGesture)
    }
  }
  apply()
  // the app's bridge installed (a WebView that defined ReactNativeWebView late is the app from here)
  win.addEventListener('mycel:mobile-ready', apply)
  win.matchMedia?.('(display-mode: standalone)').addEventListener?.('change', apply)
}
