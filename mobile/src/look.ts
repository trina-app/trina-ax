// The app's look around the page: native screens and the page's surroundings in the web app's colours, light or dark.
// No native imports here: tests load this file directly.

/** The web app's tokens (web/src/theme.edition.css): canvas, surface, ink, muted, field edge (>= 3:1), danger. */
export const LIGHT = { canvas: '#fcfbf8', surface: '#ffffff', ink: '#14110f', muted: '#514b45', field: '#8c8378', danger: '#b42318' } as const
export const DARK = { canvas: '#0e0c0b', surface: '#171412', ink: '#f6f2ea', muted: '#b3aaa0', field: '#776e64', danger: '#ff8b7e' } as const
export type Palette = { readonly [K in keyof typeof LIGHT]: string }

/** The page's own look once it said (appearance-v1), otherwise the phone's. */
export function isDark(page: boolean | null, system: string | null | undefined): boolean {
  return page ?? system === 'dark'
}

export interface Insets { top: number; right: number; bottom: number; left: number }
/** Sets --app-inset-* (CSS px; React Native's points and dp are CSS px in the WebView) on the page's root element, also
 * when it runs before the document has one (WebView's "before content loaded"). The page pads itself with the larger of
 * these and env(safe-area-inset-*) (web/src/index.css), so a WebView that reports no insets (Android) still works. */
export function insetScript(i: Insets): string {
  const v = { top: px(i.top), right: px(i.right), bottom: px(i.bottom), left: px(i.left) }
  return `(function(){var v=${JSON.stringify(v)};function a(){var r=document.documentElement;if(!r)return false;for(var k in v)r.style.setProperty('--app-inset-'+k,v[k]+'px');return true}`
    + `if(!a()){var o=new MutationObserver(function(){if(a())o.disconnect()});o.observe(document,{childList:true,subtree:true})}})();true;`
}
const px = (n: number) => Number.isFinite(n) && n > 0 ? Math.min(Math.round(n * 10) / 10, 200) : 0

/** The app's own padding around the page. A page that pads itself (it said so: appearance-v1) gets the whole screen. Any
 * other page, from a team server that has not updated yet, keeps the padding it had before: below the status bar, and on
 * Android above the navigation bar (its WebView reports no insets) except on the sign-in pages, whose footer keeps clear
 * of it. On Android the keyboard lifts the page in either case (edge to edge the window does not shrink for it). */
export function frame(o: { selfPadded: boolean; android: boolean; footer: boolean; keyboard: number; insets: Insets }): { top: number; bottom: number } {
  const top = o.selfPadded ? 0 : o.insets.top
  if (o.android && o.keyboard > 0) return { top, bottom: o.keyboard + o.insets.bottom }
  return { top, bottom: o.selfPadded || o.footer || !o.android ? 0 : o.insets.bottom }
}

/** Whether the page on screen pads itself. The app predicts it from the team's last page (a new full load of the same
 * team pads itself if the last one did) and the page confirms it (appearance-v1). A load start changes nothing (on
 * iOS it fires while the old page is still on screen); a fully loaded page that did not confirm within a few seconds
 * gets the app's padding back (a team server that went back to an older web app). */
export type Padding = { selfPadded: boolean; confirmed: boolean }
export function padding(s: Padding, e: 'load-start' | 'appearance' | 'unconfirmed'): Padding {
  if (e === 'appearance') return { selfPadded: true, confirmed: true }
  if (e === 'load-start') return s.confirmed ? { ...s, confirmed: false } : s
  return s.confirmed || !s.selfPadded ? s : { selfPadded: false, confirmed: false }
}
export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 }
/** The inset variables a page gets: the real ones while it pads itself, zero while the app pads it (so a page that
 * reads them never pads twice). */
export const pageInsets = (selfPadded: boolean, insets: Insets): Insets => selfPadded ? insets : NO_INSETS
