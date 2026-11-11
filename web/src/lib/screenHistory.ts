// The router's history. On a computer it is React Router's browser history, unchanged. On a phone (below 768 px, at
// the moment of each navigation) the browser history is the screen hierarchy of the tab on screen, because the phone's
// own Back walks it (the iPhone app's edge swipe, Android's Back through the WebView, a browser's Back): QA TC-244, the
// owner: "뒤로가기가 그냥 쌓이는 듯. 다른 폴더 갔다가 뒤로 가기 하면 이전 폴더로 감".
//
// Each entry made on a phone keeps `scr` in its history state next to React Router's own fields: the stack's tab, the
// stack's id and its trail (the addresses from the stack's first entry up to this one), so a reload or a WebView
// restore keeps it all (docs/DECISIONS.md "Phone navigation: four tabs" rejected a memory of our own for that reason).
// The rules (lib/screens.ts says which addresses are one screen and what is above what):
// - down: a push. To a screen already in the stack (the folder above, the chat a project was opened from, a list): back
//   to that entry instead (`history.go(-n)`), then a replace when its address differs. To the screen on show: a replace.
// - Files' folders are a tree: a folder pushed goes back to the deepest folder of the stack above it and pushes the
//   folders in between, so Back is always the folder above; a folder above where Files was entered replaces it.
// - a tab tap (switchTab) never adds entries: another tab's stack takes this one's place (back to its first entry,
//   replaced by that tab's saved stack, the rest pushed with their keys), the tab on show goes back to its root. A
//   tab's root is its stack's first entry, so Back at a root never walks into another tab; Forward entries left by the
//   stack before are skipped.
// - opened from outside (the document's first entry, shown for the first time): once the signed-in app shows it
//   (settleOpened, components/Layout.tsx), its parents are put under it.
// All of it reaches the router as one change: the steps in between are not shown.
//
// Overlay entries (lib/backCloses.ts, lib/imageViewer.ts) are browser entries pushed while something is open, at the
// same address, with React Router's state (and `scr`) copied plus their mark (`mycelOverlay` and its depth; before
// that a field whose name starts with "__"). This module never makes, rewrites or counts them: a pop onto or off one
// reaches the router as the same screen, and a push or replace made while one is on top is the overlays' to place
// (backCloses wraps pushState and replaceState: a page opened from inside an overlay takes its entry). A step back over
// several entries goes past them (the depth of the one on top, then any left under a page, after backCloses' own skip
// over it), each overlay closing on its own popstate as for a Back. The entries this module writes are new entries
// (a new key, often a new address): they don't carry over a page's overlay token (`mycelPage`).
import { createPath, NavigationType, parsePath, UNSAFE_createBrowserHistory, type HistoryRouterProps, type Location, type To } from 'react-router-dom'
import { chainOf, rootTab, sameScreen, screenOf } from './screens'
import { TAB_ROOT, type Tab } from './tabs'

type History = HistoryRouterProps['history']
type Listener = Parameters<History['listen']>[0]
type Action = History['action']

/** One entry of a stack: its React Router key, its address (path, query and hash) and its state. */
export interface Item { k: string; p: string; u?: unknown }
/** What a phone's entry keeps of its stack. `open`: opened from outside, its parents not put under it yet. */
export interface Scr { tab: Tab | null; sid: string; trail: Item[]; open?: true }
/** What a navigation does to the stack: go back `back` entries, replace the entry then on show, push the rest. */
export interface Plan { back: number; replace?: Item; push: Item[] }

/** the deepest trail kept in an entry, and the deepest stack a tab tap puts back (WebKit allows 100 pushes in 30 s) */
const KEEP = 30
const RESTORE = 12
const PHONE = '(max-width: 767.98px)'

const newKey = () => Math.random().toString(36).slice(2, 10)
export const isPhone = () => typeof window !== 'undefined' && window.matchMedia?.(PHONE).matches === true
/** An overlay's entry (see the top of this file): `mycelOverlay` (lib/backCloses.ts), or a field of its own whose name
 * starts with "__" (the older marks: `__backCloses`, `__imageViewer`, `__viewerSheet`). */
export const isOverlay = (state: unknown) =>
  !!state && typeof state === 'object' && (typeof (state as Record<string, unknown>).mycelOverlay === 'number' || Object.keys(state).some((k) => k.startsWith('__')))
/** How many overlay entries this one is over its page (0: a page's own entry). */
const overlayDepth = (state: unknown) => {
  if (!isOverlay(state)) return 0
  const d = (state as Record<string, unknown>).mycelOverlayDepth
  return typeof d === 'number' && d > 0 ? d : 1
}

/**
 * Where a navigation from the top of `trail` to `target` goes (see the top of this file). Pure: unit tested.
 */
export function planFor(trail: readonly Item[], target: Item, kind: 'push' | 'replace'): Plan {
  const i = trail.length - 1
  if (i < 0) return kind === 'push' ? { back: 0, push: [target] } : { back: 0, replace: target, push: [] }
  const cur = trail[i]!
  if (sameScreen(cur.p, target.p)) return { back: 0, replace: target, push: [] }
  for (let j = i - 1; j >= 0; j--) {
    if (!sameScreen(trail[j]!.p, target.p)) continue
    return { back: i - j, replace: trail[j]!.p === target.p ? undefined : target, push: [] }
  }
  if (kind === 'push' && screenOf(target.p).tree && screenOf(cur.p).tree) {
    let s = i
    while (s > 0 && screenOf(trail[s - 1]!.p).tree) s--
    const above = chainOf(target.p).slice(0, -1)
    for (let j = i; j >= s; j--) {
      const at = above.findIndex((p) => sameScreen(p, trail[j]!.p))
      if (at < 0) continue
      return { back: i - j, push: [...above.slice(at + 1).map((p) => ({ k: newKey(), p })), target] }
    }
    // above where Files was entered (from a chat's link, say): in place of the folders shown since
    return { back: i - s, replace: target, push: [] }
  }
  return kind === 'push' ? { back: 0, push: [target] } : { back: 0, replace: target, push: [] }
}

// --- the stacks a tab tap saves and puts back (this tab's life; never another person's) ---

const STACKS = 'mycel.tabStacks'
type Saved = { user: string; stacks: Partial<Record<Tab, Item[]>> }

function loadSaved(user: string): Saved {
  try {
    const v = JSON.parse(sessionStorage.getItem(STACKS) ?? 'null') as Saved | null
    if (v && v.user === user && v.stacks && typeof v.stacks === 'object') return v
  } catch { /* none */ }
  return { user, stacks: {} }
}

function save(saved: Saved) {
  try {
    sessionStorage.setItem(STACKS, JSON.stringify(saved))
  } catch { /* private mode: this page's life only */ }
}

/** the pages whose address holds a token (an invite, a password reset, the setup and team links): never kept */
const TOKEN_PAGE = /^\/(invite|reset-password|join|setup|login|password)(\/|\?|#|$)/

/** A trail that survives JSON (an entry's state that does not is left out), without the pages that hold a token. */
function plain(items: readonly Item[]): Item[] {
  return items.filter((x) => !TOKEN_PAGE.test(x.p)).map((x) => {
    try {
      return x.u === undefined || x.u === null ? { k: x.k, p: x.p } : { k: x.k, p: x.p, u: JSON.parse(JSON.stringify(x.u)) }
    } catch {
      return { k: x.k, p: x.p }
    }
  })
}

// --- the history ---

export interface ScreenHistory extends History {
  /** a tab bar tap (components/BottomTabs.tsx); `user`: whose saved stacks */
  switchTab(tab: Tab, user: string): void
  /** the signed-in app shows its first entry: put its parents under it when it was opened from outside */
  settleOpened(): void
}

export function createScreenHistory(win: Window = window): ScreenHistory {
  const base = UNSAFE_createBrowserHistory({ window: win, v5Compat: true })
  const h = win.history
  let listener: Listener | null = null
  let action: Action = base.action
  /** while a change of ours runs, the router hears nothing; a popstate wakes the step waiting for it */
  let quiet = false
  let woke: (() => void) | null = null
  let running = false
  const queue: (() => void | Promise<void>)[] = []

  const stateNow = () => (h.state ?? null) as (Record<string, unknown> & { idx?: number; key?: string; usr?: unknown; scr?: Scr }) | null
  const pathNow = () => createPath(base.location)
  const idxNow = () => (typeof stateNow()?.idx === 'number' ? (stateNow()!.idx as number) : 0)
  /** this entry's stack: its own, or one of just itself for an entry made before (on a computer) */
  function scrNow(): Scr {
    const s = stateNow()
    if (s?.scr && Array.isArray(s.scr.trail) && s.scr.trail.length) return s.scr
    return { tab: screenOf(pathNow()).tab, sid: shownSid ?? newKey(), trail: [{ k: base.location.key, p: pathNow(), u: base.location.state }] }
  }
  let shownSid: string | null = null
  let shownIdx = 0

  function write(kind: 'push' | 'replace', item: Item, idx: number, scr: Scr) {
    const { pathname = '/', search = '', hash = '' } = parsePath(item.p)
    const state = { usr: item.u ?? null, key: item.k, idx, scr: { ...scr, trail: scr.trail.slice(-KEEP) } }
    const url = base.createHref({ pathname, search, hash })
    if (kind === 'push') h.pushState(state, '', url)
    else h.replaceState(state, '', url)
  }

  function emit(a: Action, delta: number | null) {
    action = a
    const s = stateNow()
    shownSid = s?.scr?.sid ?? shownSid
    shownIdx = idxNow()
    listener?.({ action: a, location: base.location, delta })
  }

  /** the next popstate (true), or none within `ms` (false); `go`: the step of history.go that should bring it */
  function nextPop(ms: number, go?: number): Promise<boolean> {
    return new Promise((done) => {
      const timer = setTimeout(() => {
        woke = null
        done(false)
      }, ms)
      woke = () => {
        clearTimeout(timer)
        woke = null
        done(true)
      }
      if (go) h.go(go)
    })
  }
  /** one step of history.go, done when its popstate came (or after 700 ms: a step that went nowhere) */
  const step = (n: number) => nextPop(700, n)

  /** Back `n` router entries, and past the overlay entries over the page on show; then on past any overlay entry
   * landed on (one left under a page), after the overlays' own skip over it has had its moment (lib/backCloses.ts
   * skips entries of overlays no longer open by itself). */
  async function backBy(n: number) {
    const target = idxNow() - n
    const over = overlayDepth(stateNow())
    if (n + over > 0) await step(-(n + over))
    for (let tries = 0; tries < 8; tries++) {
      const s = stateNow()
      if (!isOverlay(s) && idxNow() <= target) break
      if (isOverlay(s) && (await nextPop(150))) continue
      await step(-1)
    }
  }

  /** Make the entries of a plan from the entry on show (after its steps back), and tell the router once. A push or
   * replace made while an overlay entry is on top is the overlays' to place (lib/backCloses.ts wraps the history's
   * pushState and replaceState: a page opened from inside an overlay takes its entry). */
  function apply(p: Plan) {
    const sc = scrNow()
    let trail = sc.trail
    let idx = idxNow()
    let tab = sc.tab ?? screenOf((p.replace ?? p.push[0])?.p ?? pathNow()).tab
    if (p.replace) {
      // the first entry of a stack says which stack it is
      if (trail.length === 1) tab = screenOf(p.replace.p).tab ?? tab
      trail = [...trail.slice(0, -1), p.replace]
      write('replace', p.replace, idx, { tab, sid: sc.sid, trail, ...(sc.open && trail.length === 1 ? { open: true as const } : {}) })
    }
    for (const item of p.push) {
      idx += 1
      trail = [...trail, item]
      write('push', item, idx, { tab, sid: sc.sid, trail })
    }
    emit(p.push.length ? NavigationType.Push : p.replace ? NavigationType.Replace : NavigationType.Pop, p.push.length || -p.back)
  }

  /** a plan with steps back: those first (quietly), then its entries */
  function run(p: Plan): void | Promise<void> {
    if (p.back <= 0) return apply(p)
    return quietly(async () => {
      await backBy(p.back)
      apply(p)
    })
  }

  /** run now when nothing else runs, else after what runs (a tap while a tab switch is on its way) */
  function enqueue(task: () => void | Promise<void>) {
    if (running) return void queue.push(task)
    const r = task()
    if (!(r instanceof Promise)) return
    running = true
    void r.catch(() => {}).finally(() => {
      running = false
      quiet = false
      const next = queue.shift()
      if (next) enqueue(next)
      while (!running && queue.length) enqueue(queue.shift()!)
    })
  }

  function quietly(task: () => Promise<void>): Promise<void> {
    quiet = true
    return task().finally(() => { quiet = false })
  }

  function navigate(kind: 'push' | 'replace', to: To, usr: unknown) {
    if (!isPhone()) return kind === 'push' ? base.push(to, usr) : base.replace(to, usr)
    const { pathname, search = '', hash = '' } = typeof to === 'string' ? parsePath(to) : to
    const item: Item = { k: newKey(), p: createPath({ pathname: pathname ?? base.location.pathname, search, hash }), u: usr ?? null }
    return run(planFor(scrNow().trail, item, kind))
  }

  // a phone's first entry: its stack, marked as opened from outside until the app has shown it
  if (isPhone() && !stateNow()?.scr) {
    const sid = newKey()
    h.replaceState({ ...(stateNow() ?? {}), idx: idxNow(), scr: { tab: screenOf(pathNow()).tab, sid, trail: [{ k: base.location.key, p: pathNow(), u: base.location.state }], open: true } }, '')
  }
  shownSid = stateNow()?.scr?.sid ?? null
  shownIdx = idxNow()

  function onBase(u: Parameters<Listener>[0]) {
    if (quiet) {
      if (u.action === 'POP') woke?.()
      return
    }
    if (u.action === 'POP' && isPhone()) {
      const s = stateNow()
      const sid = s?.scr?.sid
      // a Forward onto an entry of the stack a tab tap left: back where it came from, unseen
      if (sid && shownSid && sid !== shownSid) {
        const was = shownIdx
        enqueue(() => quietly(async () => void (await step(was - idxNow()))))
        return
      }
    }
    action = u.action
    shownSid = stateNow()?.scr?.sid ?? shownSid
    shownIdx = idxNow()
    listener?.(u)
  }

  const history: ScreenHistory = {
    get action() {
      return action
    },
    get location(): Location {
      return base.location
    },
    createHref: (to) => base.createHref(to),
    createURL: (to) => base.createURL(to),
    encodeLocation: (to) => base.encodeLocation(to),
    push: (to, state) => enqueue(() => navigate('push', to, state)),
    replace: (to, state) => enqueue(() => navigate('replace', to, state)),
    go: (n) => enqueue(() => base.go(n)),
    listen(fn) {
      listener = fn
      const stop = base.listen(onBase)
      return () => {
        stop()
        listener = null
      }
    },
    switchTab(tab, user) {
      enqueue(() => {
        const root = TAB_ROOT[tab]
        if (!isPhone()) return base.push(root)
        const sc = scrNow()
        const i = sc.trail.length - 1
        if (sc.tab === tab) {
          // the tab on show: back to its root, without a new entry
          const j = sc.trail.findIndex((x) => rootTab(x.p) === tab)
          if (j < 0) return run({ back: i, replace: { k: newKey(), p: root }, push: [] })
          const exact = sc.trail[j]!.p === root
          if (j === i && exact) return
          return run({ back: i - j, replace: exact ? undefined : { k: newKey(), p: root }, push: [] })
        }
        const saved = loadSaved(user)
        if (sc.tab) saved.stacks[sc.tab] = plain(sc.trail).slice(-RESTORE)
        save(saved)
        const stack = saved.stacks[tab]?.length ? saved.stacks[tab]! : [{ k: newKey(), p: root }]
        return quietly(async () => {
          await backBy(i)
          const sid = newKey()
          let idx = idxNow()
          write('replace', stack[0]!, idx, { tab, sid, trail: stack.slice(0, 1) })
          try {
            for (let m = 1; m < stack.length; m++) {
              idx += 1
              write('push', stack[m]!, idx, { tab, sid, trail: stack.slice(0, m + 1) })
            }
          } catch { /* too many pushes for the browser: the stack as far as it got */ }
          emit(NavigationType.Pop, null)
        })
      })
    },
    settleOpened() {
      enqueue(() => {
        const s = stateNow()
        const sc = s?.scr
        if (!isPhone() || !sc?.open || isOverlay(s)) return
        const here: Item = { k: base.location.key, p: pathNow(), u: base.location.state }
        const above = idxNow() === 0 ? chainOf(here.p).slice(0, -1) : []
        if (!above.length) {
          h.replaceState({ ...s, scr: { tab: sc.tab ?? screenOf(here.p).tab, sid: sc.sid, trail: sc.trail } }, '')
          return
        }
        const tab = screenOf(above[0]!).tab ?? sc.tab
        const items = [...above.map((p) => ({ k: newKey(), p })), here]
        write('replace', items[0]!, 0, { tab, sid: sc.sid, trail: items.slice(0, 1) })
        for (let m = 1; m < items.length; m++) write('push', items[m]!, m, { tab, sid: sc.sid, trail: items.slice(0, m + 1) })
        emit(NavigationType.Pop, null)
      })
    },
  }
  return history
}

let made: ScreenHistory | null = null
/** The app's one history (App.tsx). */
export const screenHistory = () => (made ??= createScreenHistory())

/** A tab bar tap: true when the app's history took it (under another router, a test's, the link does its own). */
export function switchTab(tab: Tab, user: string): boolean {
  if (!made) return false
  made.switchTab(tab, user)
  return true
}

/** The signed-in app shows its first entry (components/BottomTabs.tsx): see ScreenHistory.settleOpened. */
export const settleOpened = () => made?.settleOpened()

/** The stack the entry on show belongs to (its tab and the entry under it), on a phone; null on a computer or before
 * the first navigation of ours. */
export function stackNow(): { tab: Tab | null; below: Item | null; open: boolean } | null {
  if (typeof window === 'undefined') return null
  const s = window.history?.state as { scr?: Scr } | null | undefined
  const sc = s?.scr
  if (!sc || !Array.isArray(sc.trail) || !sc.trail.length) return null
  return { tab: sc.tab, below: sc.trail.length > 1 ? sc.trail[sc.trail.length - 2]! : null, open: !!sc.open }
}
