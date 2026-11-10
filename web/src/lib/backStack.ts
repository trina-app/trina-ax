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
import { useLocation, useNavigate, type Location, type NavigationType as Action } from 'react-router-dom'
import { useRealNavigationType, useRealPath } from './realPath'

/** How an entry was reached: 'PUSH', 'REPLACE' or 'POP' (Back, Forward, a reload, the first entry). */
export type NavigationType = `${Action}`

/** The history-state field of an entry this module made: the path of the entry under it. */
export const BELOW = 'mycelBelow'

export const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`)

export interface Trail {
  lastKey: string | null
  lastPath: string | null
  /** entry key → the pathname of the entry under it (null: nothing of ours, or not known) */
  below: Map<string, string | null>
}

export function createTrail(saved: [string, string | null][] = []): Trail {
  return { lastKey: null, lastPath: null, below: new Map(saved) }
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
 * history (React Router's history.state.idx; 0 is the first entry). */
export function needsList(o: { nav: NavigationType; idx: number | null; below: string | null | undefined; listPath: string; own: boolean }): boolean {
  if (o.own) return false
  // Back or Forward never rebuilds; the first entry of the document (a pasted address, the phone app opened on a
  // push) is reported as a POP too, and is the one case that does
  if (o.nav === 'POP') return o.idx === 0
  return !(o.below != null && under(o.below, o.listPath))
}

/** The ‹ button's label: the name of where Back goes, or null for ‹ alone (somewhere without a name here, or the same
 * page). With nothing of ours under the entry, ‹ goes to `fallback` (lib/back.ts) and is named after it there. */
export function backLabel(o: { below: string | null | undefined; path: string; idx: number | null; fallback: string; name: (path: string) => string | null }): string | null {
  const to = o.below ?? (o.idx === 0 || o.idx === null ? o.fallback : null)
  if (!to || to === o.path) return null
  return o.name(to)
}

/** What a page's scroll does when its entry shows: back to where it was (Back/Forward), to the top (a push to a plain
 * address), or left alone (a replace: a filter or a view inside the page; a #hash or a ?query the page scrolls to). */
export function scrollOnShow(nav: NavigationType, hash: string, search: string): 'restore' | 'top' | 'keep' {
  if (nav === 'POP') return 'restore'
  if (nav === 'PUSH' && !hash && !search) return 'top'
  return 'keep'
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
 */
export function useListUnderPage(listPath: string, phone: boolean, final: boolean) {
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
    // under the Settings dialog this is the page behind it, not the address in the bar
    if (!firstPhone.current?.phone || realPath !== location.pathname) return
    const below = entryBelow(location.key)
    if (!needsList({ nav, idx: historyIdx(), below, listPath, own: belowInState(location.state) !== undefined })) return
    navigate(listPath, { replace: true, state: { [BELOW]: below ?? null } })
    const state = location.state && typeof location.state === 'object' ? location.state : {}
    navigate(`${location.pathname}${location.search}${location.hash}`, { state: { ...state, [BELOW]: listPath } })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key, final])
}

/** The ‹ label of this entry (see backLabel). */
export function useBackLabel(fallback: string, name: (path: string) => string | null): string | null {
  const location = useLocation()
  return backLabel({ below: entryBelow(location.key) ?? belowInState(location.state), path: location.pathname, idx: historyIdx(), fallback, name })
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
  // remember the place as it changes (a box that is hidden keeps its last place)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !active) return
    let frame = 0
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
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
    try { saved = Number(sessionStorage.getItem(scrollKey(id, location.key)) ?? 0) || 0 } catch { /* ignore */ }
    // the content may still be growing (a page that loads): try for a few frames
    let tries = 0
    const put = () => {
      el.scrollTop = saved
      if (Math.abs(el.scrollTop - saved) > 1 && ++tries < 20) requestAnimationFrame(put)
    }
    put()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key, active, ready])
}
