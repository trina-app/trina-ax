// Back closes the open layer first (QA TC-080, TC-141, TC-245). On a phone the iOS edge swipe and Android's Back walk
// the browser's history (the phone app is one WebView of this app), so every layer over a page holds one history entry
// while it is open: a sheet or menu (components/rooms/MenuButton.tsx), a dialog (ui.tsx Modal), search, the drawer, the
// side panel, a room's side chat and its 🕘 list, the @ list, the image viewer and its sheet. Phones only (below 768 px),
// except the image viewer, which held one on computers too and still does.
//
// The contract with the rest of the app (the phone's navigation, lib/screens.ts, leaves these entries alone):
// - An overlay's entry is at the same address as the page under it, with the page's state copied (React Router's idx,
//   key and usr) plus `mycelOverlay` (the overlay's number) and `mycelOverlayDepth` (1 right over the page, 2 over that,
//   …). `isOverlayEntry` tells them apart. It is no page: don't count it, rewrite it or go to it.
// - Back (any popstate that lands under an overlay's entry) closes every overlay above where it landed, the top one
//   first: nested ones unwind one per Back.
// - Closed any other way (✕, the scrim, Esc, a choice), its entry is backed off once the moment's effects have run, all
//   closed ones with one history.go(-n). One that opens in that moment (a menu's item that opens a dialog) takes over
//   the closing entry instead (replaceState): nothing goes back, nothing is pushed, nothing races.
// - history.pushState and replaceState are wrapped once. A push while an overlay's entry is the current one (a page
//   opened from inside it) replaces that entry, so none is left under the new page. A replace then (a filter written to
//   the address while its sheet is open) goes on the overlay's entry, and the page's entry under it gets the same
//   address when the history comes back to it, before the router reads it.
// - Entries of overlays no longer open are skipped: Back over one goes on back; Forward onto one goes back where it was,
//   or on forward over one a page was opened on top of (a lower overlay's, when the top one opened a page).
// - Opened while a back of ours is on its way, an overlay pushes its entry once that back has landed (browsers drop a
//   push made meanwhile); a page pushed meanwhile is pushed again once it has.
import { useEffect, useRef, useSyncExternalStore } from 'react'

/** The history-state field of an overlay's entry: its overlay's number. */
export const OVERLAY = 'mycelOverlay'
/** The history-state field of an overlay's entry: how many overlays deep it is over its page (1: right over it). */
export const OVERLAY_DEPTH = 'mycelOverlayDepth'

type State = Record<string, unknown> | null
type Pos = readonly [idx: number, depth: number]

/** Is this history state an overlay's entry (not a page)? */
export function isOverlayEntry(s: unknown): boolean {
  return !!s && typeof s === 'object' && typeof (s as Record<string, unknown>)[OVERLAY] === 'number'
}

interface Held {
  id: number
  onBack: () => void
  /** its entry: in the history ('on'), to push once our back has landed ('owed'), or none ('gone': a page took it) */
  entry: 'on' | 'owed' | 'gone'
  /** let go: its entry goes at the next flush */
  closing: boolean
  /** where its entry is or was: its page's router idx and how deep over that page */
  idx: number
  depth: number
}

let seq = 0
/** the overlays open now, oldest first */
let held: Held[] = []
/** entries a page was pushed on top of while their overlay was open under the top one: Forward goes on over them */
const leftBehind = new Set<number>()
/** a router key of a page's entry → the address and state a replace gave it while an overlay was open over it */
const fixes = new Map<string, { state: State; url: string }>()
/** where the history is, as last seen: where the next popstate came from */
let here: Pos = [-1, 0]
let flushTimer: ReturnType<typeof setTimeout> | null = null
/** a history.go(-n) of ours is on its way */
let inFlight = false
/** what the router did while it was: done again on the entry it lands on */
let owed: { push: boolean; state: State; url: string } | null = null
let waiting: (() => void)[] = []

const state = (): State => (window.history.state ?? null) as State
const idxOf = (s: State) => (typeof s?.idx === 'number' ? s.idx : -1)
const depthOf = (s: State) => (typeof s?.[OVERLAY_DEPTH] === 'number' ? (s[OVERLAY_DEPTH] as number) : 0)
const posOf = (s: State): Pos => [idxOf(s), depthOf(s)]
const above = (a: Pos, b: Pos) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])
/** the open overlay whose entry this is */
const heldOf = (s: State) => {
  const id = s?.[OVERLAY]
  return typeof id === 'number' ? held.find((h) => h.id === id && h.entry === 'on') : undefined
}
const go = (n: number) => (n === -1 ? window.history.back() : n === 1 ? window.history.forward() : window.history.go(n))

// ---- the history's own pushState and replaceState, and the wrapped ones the router calls ----

type Native = { push: (s: State, url?: string | URL | null) => void; replace: (s: State, url?: string | URL | null) => void }
const natives = new WeakMap<object, Native>()

function native(): Native {
  const h = window.history
  const known = natives.get(h)
  if (known) return known
  const push = h.pushState
  const replace = h.replaceState
  const n: Native = { push: (s, url) => push.call(h, s, '', url), replace: (s, url) => replace.call(h, s, '', url) }
  natives.set(h, n)
  h.pushState = (s: unknown, _title: string, url?: string | URL | null) => routerPush(n, s as State, url)
  h.replaceState = (s: unknown, _title: string, url?: string | URL | null) => routerReplace(n, s as State, url)
  return n
}

/** A page pushed by someone else (the router). */
function routerPush(n: Native, s: State, url?: string | URL | null) {
  if (inFlight) {
    // the back on its way would drop it: again once it has landed
    n.push(s, url)
    owed = { push: true, state: s, url: window.location.href }
    return
  }
  const top = heldOf(state())
  if (!top) {
    n.push(s, url)
    here = posOf(state())
    return
  }
  // a page opened from inside an overlay (a menu's item, a link in a dialog, a search result): it takes the overlay's
  // entry, so Back from it goes to the page the overlay was over, not to a copy of it
  n.replace(s, url)
  for (const h of held) {
    if (h.entry !== 'on') continue
    h.entry = 'gone'
    if (h !== top) leftBehind.add(h.id)
  }
  here = posOf(state())
}

/** A change of address by someone else (the router's replace). */
function routerReplace(n: Native, s: State, url?: string | URL | null) {
  if (inFlight) {
    n.replace(s, url)
    if (!owed?.push) owed = { push: false, state: s, url: window.location.href }
    return
  }
  const cur = state()
  const top = heldOf(cur)
  if (!top || isOverlayEntry(s)) {
    n.replace(s, url)
    here = posOf(state())
    return
  }
  // while an overlay is open (a filter in its sheet, a dialog's own choice): on its entry, and the page's entry under
  // it gets it too once the history is back there (fixUp)
  const old = typeof cur?.key === 'string' ? cur.key : null
  n.replace({ ...(s ?? {}), [OVERLAY]: top.id, [OVERLAY_DEPTH]: top.depth }, url)
  if (old && old !== s?.key) fixes.set(old, { state: s, url: window.location.href })
}

/** The entry landed on is a page (or an overlay's) whose address a replace changed while an overlay was over it: that
 * address, before the router reads it. */
function fixUp() {
  const s = state()
  const start = typeof s?.key === 'string' ? s.key : null
  let k = start
  let f: { state: State; url: string } | undefined
  for (let n = 0; k && fixes.has(k) && n < 50; n++) {
    f = fixes.get(k)!
    k = typeof f.state?.key === 'string' ? f.state.key : null
    if (k === start) break
  }
  if (!f || (window.location.href === f.url && s?.key === f.state?.key)) return
  const keep = isOverlayEntry(s) ? { [OVERLAY]: s![OVERLAY], [OVERLAY_DEPTH]: s![OVERLAY_DEPTH] } : {}
  native().replace({ ...(f.state ?? {}), ...keep }, f.url)
}

// ---- open, close, Back ----

function pushEntry(h: Held) {
  const s = state()
  h.idx = idxOf(s)
  h.depth = depthOf(s) + 1
  try {
    native().push({ ...(s ?? {}), [OVERLAY]: h.id, [OVERLAY_DEPTH]: h.depth })
    h.entry = 'on'
  } catch {
    // a history the page may not change (a sandbox): the overlay still opens, Back just leaves the page as before
    h.entry = 'gone'
  }
  here = posOf(state())
}

/** The overlays above where the history landed close, the top one first. */
function closeAbove(at: Pos) {
  const shut = held.filter((h) => h.entry !== 'owed' && above([h.idx, h.depth], at)).reverse()
  if (!shut.length) return
  held = held.filter((h) => !shut.includes(h))
  for (const h of shut) {
    if (h.closing) continue
    try {
      h.onBack()
    } catch (e) {
      console.error(e)
    }
  }
}

function onPop() {
  if (typeof window === 'undefined') return
  const from = here
  fixUp()
  const s = state()
  const at = posOf(s)
  here = at
  if (inFlight) return landed()
  // a Back or Forward of the person's
  closeAbove(at)
  const id = s?.[OVERLAY]
  if (typeof id !== 'number') return
  const mine = held.find((h) => h.id === id)
  if (mine && !mine.closing) return
  // an entry of an overlay no longer open: closed a moment ago (this move is its back-off), left under a page, or
  // from before a reload
  if (mine) held = held.filter((h) => h !== mine)
  if (leftBehind.has(id) && above(at, from)) go(1)
  else go(-1)
}

/** Our back has landed. */
function landed() {
  inFlight = false
  const o = owed
  owed = null
  if (o?.push) native().push(o.state, o.url)
  else if (o) native().replace(o.state, o.url)
  for (const h of held) if (h.entry === 'owed') pushEntry(h)
  here = posOf(state())
  if (held.some((h) => h.closing && h.entry === 'on')) schedule()
  settle()
}

function schedule() {
  if (flushTimer === null) flushTimer = setTimeout(flush, 0)
}

/** Back off the entries of the overlays closed on top, with one step for all of them. */
function flush() {
  flushTimer = null
  if (inFlight || typeof window === 'undefined') return
  // closed ones without an entry go at once
  held = held.filter((h) => !(h.closing && h.entry !== 'on'))
  const on = held.filter((h) => h.entry === 'on')
  let i = on.length - 1
  while (i >= 0 && on[i]!.closing) i--
  const off = on.slice(i + 1)
  if (off.length) {
    held = held.filter((h) => !off.includes(h))
    if (state()?.[OVERLAY] === off[off.length - 1]!.id) {
      inFlight = true
      go(-off.length)
    } else {
      // the current entry is not theirs (the router moved meanwhile): theirs stay under it, skipped
      for (const h of off) leftBehind.add(h.id)
    }
  }
  settle()
}

function settle() {
  if (flushTimer !== null || inFlight) return
  const w = waiting
  waiting = []
  for (const f of w) f()
}

/** Runs `fn` once the history is where the open overlays say (the entries of those just closed are gone). */
export function whenOverlaysSettled(fn: () => void) {
  if (flushTimer === null && !inFlight) fn()
  else waiting.push(fn)
}

/** the windows listened to, by their addEventListener (a test's window is a new one each time) */
const listening = new WeakSet<object>()
function install() {
  native()
  if (listening.has(window.addEventListener)) return
  listening.add(window.addEventListener)
  // capture, added when this module loads (before the router mounts): it runs before the router's own listener, so a
  // fixed-up address is what the router reads
  window.addEventListener('popstate', onPop, true)
  here = posOf(state())
}

if (typeof window !== 'undefined' && window.history && typeof window.addEventListener === 'function') {
  install()
  // the page loaded again (a reload, the phone app brought back) on an overlay's entry: the overlay is gone, so is its
  // entry; Back from it would land on the same page and seem to do nothing
  if (isOverlayEntry(state())) go(-1)
}

/**
 * Hold one history entry while something is open, whatever the window's width (the image viewer; React code uses
 * useOverlayEntry). `onBack` runs once when a Back leaves the entry. The function returned lets go of it: its entry is
 * backed off, unless a page or another overlay took it meanwhile.
 */
export function holdOverlayEntry(onBack: () => void): () => void {
  if (typeof window === 'undefined' || !window.history) return () => {}
  install()
  const h: Held = { id: ++seq, onBack, entry: 'gone', closing: false, idx: -1, depth: 0 }
  const cur = state()
  const top = heldOf(cur)
  if (top?.closing && !inFlight) {
    // opened as the one on top closes (a menu's item that opens a dialog): it takes over that entry
    held = held.filter((x) => x !== top)
    h.idx = top.idx
    h.depth = top.depth
    native().replace({ ...(cur ?? {}), [OVERLAY]: h.id })
    h.entry = 'on'
  } else if (inFlight) h.entry = 'owed'
  else pushEntry(h)
  held.push(h)
  return () => {
    if (!held.includes(h) || h.closing) return
    if (h.entry !== 'on') {
      held = held.filter((x) => x !== h)
      return
    }
    h.closing = true
    schedule()
  }
}

// ---- React ----

const WIDE = '(min-width: 768px)'
function subscribeWidth(changed: () => void) {
  const m = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(WIDE) : null
  m?.addEventListener?.('change', changed)
  return () => m?.removeEventListener?.('change', changed)
}
const isPhone = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && !window.matchMedia(WIDE).matches

/**
 * While `open` on a phone (below 768 px), Back runs `close` instead of leaving the page. `at` (the router location's
 * key): something that stays open when the page changes (the side panel) holds a new entry on top of the new page.
 */
export function useOverlayEntry(open: boolean, close: () => void, o: { at?: string } = {}) {
  const phone = useSyncExternalStore(subscribeWidth, isPhone, () => false)
  const closeRef = useRef(close)
  closeRef.current = close
  const on = open && phone
  useEffect(() => {
    if (!on) return
    return holdOverlayEntry(() => closeRef.current())
  }, [on, o.at])
}

/** For tests: forget every overlay and entry (the history object itself is the test's). */
export function resetOverlaysForTest() {
  if (flushTimer !== null) clearTimeout(flushTimer)
  flushTimer = null
  held = []
  leftBehind.clear()
  fixes.clear()
  inFlight = false
  owed = null
  waiting = []
  here = typeof window !== 'undefined' && window.history ? posOf(state()) : [-1, 0]
}
