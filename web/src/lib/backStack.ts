// The phone's back stack for pages that live under a list: Admin's pages under Admin's list, Settings' sections under
// the 나 list (docs/DECISIONS.md "Admin and Settings on phones: a list you tap into"). Below 768 px:
//
// - The list is always under such a page. A page entered from outside its list's area (a notice in the Inbox, a link
//   in a chat, a push opening the phone app, a pasted address) gets its entry replaced by the list and is pushed again
//   on top of it, keeping its ?query and #hash, so Back goes page → list → where you were (Android's "synthetic back
//   stack"). Never on Back/Forward (except the document's first entry, which the router reports as POP too), never for
//   a page change inside the area, never on a resize, never on a computer, and only once the page is final (after its
//   redirects and permission checks).
// - "Where the entry came from" is noted once per history entry, when the app first shows it (`noteEntry`, called from
//   App.tsx while it renders, before any page does): a push came from the entry shown before it, a replace from what
//   was under the entry it replaced. It is used only at that moment (the insertion) and for the ‹ button's label; Back
//   itself always walks the router's real history (lib/back.ts), as DECISIONS "Phone navigation: four tabs" decided.
// - ‹'s label names where Back goes ("‹ Admin", "‹ Settings", "‹ Members & invites"); ‹ shows alone when Back goes
//   somewhere else or to the same page (a page that adds history inside itself).
// - A pushed page starts at the top; Back to a list or a page puts its scroll back (useKeptScroll).
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { parsePath, useLocation, useNavigate, type Location, type NavigationType as Action } from 'react-router-dom'
import { useRealNavigationType, useRealPath } from './realPath'
import { stackNow } from './screenHistory'
import { useScreenName } from './screens'

/** How an entry was reached: 'PUSH', 'REPLACE' or 'POP' (Back, Forward, a reload, the first entry). */
export type NavigationType = `${Action}`

/** The history-state field of an entry this module made: the path of the entry under it. */
export const BELOW = 'mycelBelow'

export const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`)

export interface Trail {
  lastKey: string | null
  lastPath: string | null
  /** the entry the last note saw for the first time (null: the last one shown had been seen before) */
  newKey: string | null
  /** entry key → the pathname of the entry under it (null: nothing of ours, or not known) */
  below: Map<string, string | null>
}

export function createTrail(saved: [string, string | null][] = []): Trail {
  return { lastKey: null, lastPath: null, newKey: null, below: new Map(saved) }
}

const belowInState = (state: unknown): string | null | undefined => {
  if (!state || typeof state !== 'object' || !(BELOW in state)) return undefined
  const v = (state as Record<string, unknown>)[BELOW]
  return typeof v === 'string' ? v : null
}

/**
 * Note an entry when the app shows it: what is under it. A push: the entry shown before. A replace: what was under the
 * entry it replaced. Back or Forward, or the first entry: what was noted when it was new (unknown when never seen). An
 * entry this module made says it in its state, which wins. Seeing the same entry again changes nothing.
 */
export function noteEntry(trail: Trail, key: string, path: string, nav: NavigationType, state: unknown): void {
  if (key === trail.lastKey) return
  trail.newKey = trail.below.has(key) ? null : key
  const own = belowInState(state)
  if (own !== undefined) trail.below.set(key, own)
  else if (!trail.below.has(key)) {
    if (nav === 'PUSH') trail.below.set(key, trail.lastPath)
    else if (nav === 'REPLACE') trail.below.set(key, trail.lastKey ? (trail.below.get(trail.lastKey) ?? null) : null)
    else trail.below.set(key, null)
  }
  trail.lastKey = key
  trail.lastPath = path
}

/** Should this page get its list put under it? `below`: the noted entry under it; `idx`: its place in the document's
 * history (React Router's history.state.idx; 0 is the first entry); `inside`: other pages that count as the list's
 * area (Back from the page goes to them, as from the list's own pages). */
export function needsList(o: { nav: NavigationType; idx: number | null; below: string | null | undefined; listPath: string; own: boolean; fresh?: boolean; inside?: readonly string[] }): boolean {
  if (o.own) return false
  // Back or Forward never rebuilds; the first entry of the document (a pasted address, the phone app opened on a
  // push) is reported as a POP too, and is the one case that does, when it shows for the first time (`fresh`: Back to
  // a first entry that was seen without its list, on a computer, would drop the entries after it)
  if (o.nav === 'POP') return o.idx === 0 && o.fresh !== false
  return !(o.below != null && [o.listPath, ...(o.inside ?? [])].some((p) => under(o.below!, p)))
}

/** The ‹ button's label: the name of where Back goes, or null for ‹ alone (somewhere without a name here, or the same
 * page). With nothing of ours under the entry, ‹ goes to `fallback` (lib/back.ts) and is named after it there. */
export function backLabel(o: { below: string | null | undefined; path: string; idx: number | null; fallback: string; name: (path: string) => string | null }): string | null {
  const to = o.below ?? (o.idx === 0 || o.idx === null ? o.fallback : null)
  if (!to || to === o.path) return null
  return o.name(to)
}

/** The queries a page scrolls to itself (Members' ?member=, Plugins' ?focus=, Folder permissions' ?folder=). */
const SELF_SCROLL = ['member', 'focus', 'folder']

/** What a page's scroll does when its entry shows: back to where it was (Back/Forward), to the top (a push), or left
 * alone (a replace: a filter or a view inside the page; a push with a #hash or a ?query the page scrolls to itself). */
export function scrollOnShow(nav: NavigationType, hash: string, search: string): 'restore' | 'top' | 'keep' {
  if (nav === 'POP') return 'restore'
  if (nav === 'REPLACE' || hash) return 'keep'
  const q = new URLSearchParams(search)
  return SELF_SCROLL.some((k) => q.has(k)) ? 'keep' : 'top'
}

// --- the app's one trail, kept for the tab's life (sessionStorage), so a reload keeps the labels ---

const STORE = 'mycel.backStack'
const KEEP = 200

function load(): [string, string | null][] {
  try {
    const v = JSON.parse(sessionStorage.getItem(STORE) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => Array.isArray(x) && typeof x[0] === 'string') : []
  } catch {
    return []
  }
}

let trail: Trail | null = null
const theTrail = () => (trail ??= createTrail(load()))

function save(t: Trail) {
  try {
    // 'default' is the first entry of a document (no state yet): every document has one, so it is never kept
    const all = [...t.below].filter(([k]) => k !== 'default').slice(-KEEP)
    sessionStorage.setItem(STORE, JSON.stringify(all))
  } catch { /* private mode: this page's life only */ }
}

/** App.tsx: called while it renders the real location, before any page reads the trail. */
export function noteLocation(loc: Location, nav: NavigationType) {
  const t = theTrail()
  if (loc.key === t.lastKey) return
  noteEntry(t, loc.key, loc.pathname, nav, loc.state)
  save(t)
}

export const entryBelow = (key: string) => theTrail().below.get(key)
/** Was this entry new when the app last showed it (not a return to one seen before)? */
const entryFresh = (key: string) => theTrail().newKey === key

/** Tests only: start again. */
export function resetTrail(saved: [string, string | null][] = []) {
  trail = createTrail(saved)
}

const historyIdx = (): number | null => {
  const idx = (window.history?.state as { idx?: unknown } | null | undefined)?.idx
  return typeof idx === 'number' ? idx : null
}

/**
 * Put `listPath` under this page when it was entered from outside the list's area (see the top of this file). `phone`:
 * only below 768 px, as it was when the entry first showed (a resize never inserts). `final`: the page is the one that
 * stays (not a redirect, not refused, not still loading what decides it). Returns nothing; the page stays on screen.
 * Several lists, outermost first (Admin's list, then Team settings' under a group of it): the area is the first one's,
 * and all of them go under the page in that order, so Back walks page → Team settings → Admin → where you were.
 * `inside`: other pages that count as the area (Settings: the Activity page, whose gear opens 알림).
 */
export function useListUnderPage(listPath: string | readonly string[], phone: boolean, final: boolean, inside: readonly string[] = []) {
  const navigate = useNavigate()
  const location = useLocation()
  const nav = useRealNavigationType()
  const realPath = useRealPath()
  const firstPhone = useRef<{ key: string; phone: boolean } | null>(null)
  if (firstPhone.current?.key !== location.key) firstPhone.current = { key: location.key, phone }
  const done = useRef<string | null>(null)
  // a passive effect: the router starts listening to the history in its own layout effect, after a page's on the first
  // render of the app, so a layout effect here could change the history before the router hears it. The page stays on
  // screen either way (the same page is pushed again).
  useEffect(() => {
    if (done.current === location.key || !final) return
    done.current = location.key
    // under the Settings dialog this is the page behind it, not the address in the bar; a first entry opened from
    // outside gets its parents put under it by the phone's history once the app shows it (lib/screenHistory.ts)
    if (!firstPhone.current?.phone || realPath !== location.pathname || stackNow()?.open) return
    const below = entryBelow(location.key)
    const lists = typeof listPath === 'string' ? [listPath] : listPath
    if (!lists.length || !needsList({ nav, idx: historyIdx(), below, listPath: lists[0]!, own: belowInState(location.state) !== undefined, fresh: entryFresh(location.key), inside })) return
    // the address as it was opened, ?query and #hash included, even when the page has used its query up meanwhile
    // (Connectors' ?drive=1 opens Google Drive and leaves the address): the page is drawn again over the list and
    // reads it again (its queries open or point at something; reading one twice does the same thing)
    navigate(lists[0]!, { replace: true, state: { [BELOW]: below ?? null } })
    for (let i = 1; i < lists.length; i++) navigate(lists[i]!, { state: { [BELOW]: lists[i - 1] } })
    const state = location.state && typeof location.state === 'object' ? location.state : {}
    navigate(`${location.pathname}${location.search}${location.hash}`, { state: { ...state, [BELOW]: lists.at(-1) } })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key, final])
}

/** The ‹ label of this entry (see backLabel). On a phone the stack says what is under the entry (lib/screenHistory.ts),
 * also below a list put under a page; `name` names it, else the screen's own name (lib/screens.ts: a folder, a chat, a
 * tab's list), so ‹ names where it goes wherever that has a name. */
export function useBackLabel(fallback: string, name: (path: string) => string | null): string | null {
  const location = useLocation()
  const generic = useScreenName()
  const named = (p: string) => name(parsePath(p).pathname || p) ?? generic(p)
  const stack = stackNow()
  if (stack) {
    const to = stack.below?.p ?? fallback
    // the same page (one that adds history inside itself): ‹ alone
    return (parsePath(to).pathname || to) === location.pathname ? null : named(to)
  }
  return backLabel({ below: entryBelow(location.key) ?? belowInState(location.state), path: location.pathname, idx: historyIdx(), fallback, name: named })
}

const scrollKey = (id: string, key: string) => `mycel.scroll.${id}.${key}`

/**
 * Keep a scroll box's place per history entry: a push to a plain address starts at the top, Back or Forward puts the
 * place back (once `ready`, after the content it scrolls has drawn), a replace or a #hash / ?query leaves it alone.
 * `active`: this box is the one on screen for this entry (Settings' list or its section).
 */
export function useKeptScroll(ref: RefObject<HTMLElement | null>, id: string, active: boolean, ready = true) {
  const location = useLocation()
  const nav = useRealNavigationType()
  const keyRef = useRef(location.key)
  keyRef.current = location.key
  // while a place is being put back the box scrolls by itself: that is not saved over the place
  const restoring = useRef(false)
  // remember the place as it changes (a box that is hidden keeps its last place); never for 'default', the first entry
  // of every document (a new page load would get the old one's place)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !active) return
    let frame = 0
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (restoring.current || keyRef.current === 'default') return
        try { sessionStorage.setItem(scrollKey(id, keyRef.current), String(el.scrollTop)) } catch { /* ignore */ }
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      el.removeEventListener('scroll', onScroll)
    }
  }, [ref, id, active])
  const shown = useRef<string | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !active || !ready || shown.current === location.key) return
    shown.current = location.key
    const what = scrollOnShow(nav, location.hash, location.search)
    if (what === 'top') el.scrollTop = 0
    if (what !== 'restore') return
    let saved = 0
    try { saved = location.key === 'default' ? 0 : Number(sessionStorage.getItem(scrollKey(id, location.key)) ?? 0) || 0 } catch { /* ignore */ }
    if (!saved) return
    // the content may still be growing (a page that reads its data again): try until it is tall enough, the person
    // scrolls or touches it, or 2 s have passed
    restoring.current = true
    const until = Date.now() + 2000
    let frame = 0
    const stop = () => {
      restoring.current = false
      cancelAnimationFrame(frame)
      for (const e of ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const) el.removeEventListener(e, stop)
    }
    for (const e of ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const) el.addEventListener(e, stop, { passive: true })
    const put = () => {
      el.scrollTop = saved
      if (Math.abs(el.scrollTop - saved) > 1 && Date.now() < until) frame = requestAnimationFrame(put)
      else stop()
    }
    put()
    return stop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key, active, ready])
}
