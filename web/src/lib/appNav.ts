// The phone app's Back (nav-v1; mobile/src/nav.ts, mobile/src/protocol.ts NAV_CAPABILITY). The app's iOS edge swipe and
// Android's Back walk this page's history; the page tells the app where Back goes whenever its screen or its top overlay
// changes, so the swipe is off at a tab's root and Android's Back goes to the start tab before it leaves the app (QA
// TC-246, the owner: Back is odd). The app talks back with two window events:
// - `mycel:open` {path}: a tapped notification's screen, opened by the router (no reload; Back returns to where the
//   person was). Cancelled when taken: an event nobody cancels (a server from before nav-v1) is a normal load.
// - `mycel:start-tab`: Android's Back at the root of another tab, the start tab as a tap on it shows it.
// canGoBack: an overlay's entry is on show (Back closes it, lib/backCloses.ts), or the phone's stack has entries under
// this one (lib/screenHistory.ts `scr`: its first entry is the tab's root, where Back stops). On a computer-width page
// (an Android tablet) there is no stack: the router's own entries. home: on the start tab, or in no tab (the sign-in
// pages, a page of its own): Back with nothing under it leaves the app there.
// An app without nav-v1 hears none of it (lib/mobile.ts setAppNav), and its Back walks the history as before.
import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { notificationPath } from '../../../mobile/src/protocol'
import { OVERLAY_ENTRY_EVENT } from './backCloses'
import { HISTORY_STEPS_EVENT, historyStepping } from './historySteps'
import { setAppNav, type AppNav } from './mobile'
import { navigateTo } from './nav'
import { isOverlay, isPhone, switchTab, type Scr } from './screenHistory'
import { START_TAB, TAB_ROOT, tabOf } from './tabs'

/** Where Back goes from the history entry on show (its state, its path, a phone-width page or not). Pure: unit tested. */
export function appNavOf(state: unknown, path: string, phone: boolean): AppNav {
  const s = (state && typeof state === 'object' ? state : {}) as { idx?: unknown; scr?: Partial<Scr> | null }
  const sc = phone && s.scr && Array.isArray(s.scr.trail) && s.scr.trail.length ? s.scr : null
  // the tab marked in the bar (components/BottomTabs.tsx): the stack's
  const tab = !phone ? null : sc ? (sc.tab ?? null) : tabOf(path)
  const home = tab === null || tab === START_TAB
  if (isOverlay(state)) return { canGoBack: true, home }
  const idx = typeof s.idx === 'number' ? s.idx : 0
  // the stack's first entry (an entry that does not say: as far back as its trail goes, as the history reads it)
  const first = sc ? (typeof sc.base === 'number' ? sc.base : idx - (sc.trail!.length - 1)) : 0
  return { canGoBack: idx > first, home }
}

let user = ''
let queued = false
let installed = false

/** Works out where Back goes once the history has settled (after the popstates of the moment: an overlay backing off
 * its entry, the steps of a tab switch, whose end says so) and tells the app. */
export function noteAppNav() {
  if (queued || typeof window === 'undefined') return
  queued = true
  setTimeout(() => {
    queued = false
    if (historyStepping()) return
    setAppNav(appNavOf(window.history?.state ?? null, window.location.pathname, isPhone()))
  }, 0)
}

/** A tapped notification (the app's `mycel:open`): an id path on this team, opened by the router. */
function onOpen(e: Event) {
  const path = notificationPath((e as CustomEvent<{ path?: unknown } | null>).detail?.path)
  if (!path) return
  e.preventDefault()
  navigateTo(path)
}

/** Android's Back at the root of a tab other than the start tab (the app's `mycel:start-tab`). */
function onStartTab() {
  if (!switchTab(START_TAB, user)) navigateTo(TAB_ROOT[START_TAB])
}

function onSteps(e: Event) {
  if ((e as CustomEvent<{ stepping?: unknown } | null>).detail?.stepping !== true) noteAppNav()
}

/** The listeners (once per page): Back and Forward, an overlay opening, the end of the history's steps, a change of width,
 * and the app's two events. */
export function initAppNav() {
  if (installed || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
  installed = true
  window.addEventListener('popstate', noteAppNav)
  window.addEventListener(OVERLAY_ENTRY_EVENT, noteAppNav)
  window.addEventListener(HISTORY_STEPS_EVENT, onSteps)
  window.addEventListener('mycel:open', onOpen)
  window.addEventListener('mycel:start-tab', onStartTab)
  window.matchMedia?.('(max-width: 767.98px)').addEventListener?.('change', noteAppNav)
}

/** The app's Back follows the router (App.tsx Gate): every screen it shows, and whose tab stacks a start-tab switch
 * saves (the signed-in person's; '' signed out). */
export function useAppNav(userId: string) {
  const location = useLocation()
  useEffect(() => initAppNav(), [])
  useEffect(() => {
    user = userId
  }, [userId])
  useEffect(() => noteAppNav(), [location.key, location.pathname, location.search])
}

/** For tests: listen again on the test's window. */
export function resetAppNavForTest() {
  installed = false
  queued = false
  user = ''
}
