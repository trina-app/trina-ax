// nav-v1 (src/protocol.ts NAV_CAPABILITY): what the iOS edge swipe, Android's Back and a tapped notification do with the
// page on screen. The page says where Back goes (`nav`); until the document on screen has said it (an older server, or a
// page still loading) everything stays as before: the WebView's own history. Pure, no native imports
// (tests/unit/mobile-bridge.test.ts).
import type { PageNav } from './bridge'

/** The iOS edge swipe: on while Back has somewhere to go in the page (a screen under this one, an open sheet), off at a
 * tab's root; on as before for a page that has not said. */
export const backGestures = (nav: PageNav | null): boolean => nav ? nav.canGoBack : true

/** iOS: how the edge swipe is turned off. WebKit takes its picture of a screen (what a swipe back slides over) only while
 * `allowsBackForwardNavigationGestures` is on; a screen left with it off gets a plain white view behind the swipe instead
 * (modules/edge-swipe/ios/EdgeSwipeModule.swift). With the app's EdgeSwipe module (`native`) the property stays on and
 * the module turns the swipe itself on or off (`swipe`); without it the property does, as before. */
export function swipeGate(nav: PageNav | null, native: boolean): { prop: boolean; swipe: boolean } {
  const swipe = backGestures(nav)
  return { prop: native || swipe, swipe }
}

/** The module has never set a swipe (its answer: how many it set) and a page is on screen (it said where Back goes, so
 * its web view is there): a later iOS without the recognizers it looks for, and the property gates the swipe again. Once
 * it has set one, a 0 is a web view out of the window for a moment, and the module stays (switching then could leave
 * WebKit's swipe off with the property on). */
export const nativeGateLost = (set: number, nav: PageNav | null, setBefore: boolean): boolean => set === 0 && nav !== null && !setBefore

/** Android's Back: back in the page; at a tab's root that is not the start tab, the start tab; else out of the app (the
 * system's own Back). Without the page's word: back while the WebView can, as before. */
export function backAction(nav: PageNav | null, webCanGoBack: boolean): 'back' | 'start-tab' | 'exit' {
  if (!nav) return webCanGoBack ? 'back' : 'exit'
  if (nav.canGoBack) return 'back'
  return nav.home ? 'exit' : 'start-tab'
}

/** A path opened in the page on screen (a tapped notification, a link to the team already connected): the page's router
 * takes it (`mycel:open`, cancelled by the page that navigates: no reload, Back returns to where the person was); when
 * nothing cancels it (no listener: a server from before nav-v1, or a path the page leaves to the browser), a normal load
 * of that path, as before. */
export const openScript = (path: string): string =>
  `(function(){var p=${JSON.stringify(path)};if(window.dispatchEvent(new CustomEvent('mycel:open',{detail:{path:p},cancelable:true})))window.location.assign(p);})();true;`

/** Android's Back at the root of a tab that is not the start tab: the page shows the start tab, as a tap on it does. */
export const START_TAB_SCRIPT = "window.dispatchEvent(new CustomEvent('mycel:start-tab'));true;"
