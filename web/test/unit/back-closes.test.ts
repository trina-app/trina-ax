// Back closes the open layer first (lib/backCloses.ts; QA TC-080, TC-141, TC-245): one history entry per open overlay,
// marked so the phone's navigation leaves it alone; Back closes the top one only; closed another way its entry is
// backed off (all at once), unless an overlay opened in that moment takes it over; a page opened from inside an overlay
// takes its entry; a replace while one is open reaches the page's entry under it; entries of closed overlays are skipped.
import { afterEach, expect, test } from 'bun:test'
import { HISTORY_STEPS_EVENT, holdOverlayEntry, isOverlayEntry, OVERLAY_DEPTH, resetOverlaysForTest, whenOverlaysSettled } from '../../src/lib/backCloses'
import { FakeEvent, installDom, removeDom } from './dom-host'

type State = Record<string, unknown> | null
type Entry = { state: State; url: string }
let entries: Entry[] = []
let at = 0
/** history.go calls, with their step */
let gos: number[] = []
/** a browser's back lands a moment later (a task); with `holdBack` the test lets it land */
let holdBack = false
let late: (() => void)[] = []
const pop = () => globalThis.dispatchEvent(new FakeEvent('popstate') as unknown as Event)
const resolve = (url: string | URL | null | undefined) => (url == null ? entries[at]!.url : String(url))
const travel = (n: number) => {
  const to = Math.max(0, Math.min(entries.length - 1, at + n))
  if (to === at) return
  const land = () => {
    at = to
    pop()
  }
  if (holdBack) late.push(land)
  else land()
}
const start = (url = '/rooms') => {
  installDom()
  entries = [{ state: { idx: 3, key: 'k1', usr: null }, url }]
  at = 0
  gos = []
  holdBack = false
  late = []
  Object.defineProperty(globalThis, 'history', {
    configurable: true, writable: true,
    value: {
      get state() { return entries[at]?.state ?? null },
      pushState(s: State, _t: string, url?: string | null) { entries = [...entries.slice(0, at + 1), { state: s, url: resolve(url) }]; at = entries.length - 1 },
      replaceState(s: State, _t: string, url?: string | null) { entries[at] = { state: s, url: resolve(url) } },
      back() { gos.push(-1); travel(-1) },
      forward() { gos.push(1); travel(1) },
      go(n: number) { gos.push(n); travel(n) },
    },
  })
  Object.defineProperty(globalThis, 'location', { configurable: true, writable: true, value: { get href() { return entries[at]!.url } } })
  resetOverlaysForTest()
}
afterEach(() => {
  resetOverlaysForTest()
  removeDom()
  delete (globalThis as { location?: unknown }).location
})
const tick = () => new Promise((r) => setTimeout(r, 1))
/** the router's own push and replace (React Router calls window.history's) */
const routerPush = (key: string, idx: number, url: string) => globalThis.history.pushState({ idx, key, usr: null }, '', url)
const routerReplace = (key: string, url: string) => globalThis.history.replaceState({ idx: (globalThis.history.state as { idx: number }).idx, key, usr: null }, '', url)
/** the person's Back (Android's, the iOS swipe) */
const back = () => travel(-1)
const forward = () => travel(1)

test("opening adds one entry that keeps the router's state and says it is an overlay's; Back closes it once", () => {
  start()
  let closed = 0
  holdOverlayEntry(() => closed++)
  expect(entries).toHaveLength(2)
  expect(entries[1]!.state).toMatchObject({ idx: 3, key: 'k1', [OVERLAY_DEPTH]: 1 })
  expect(isOverlayEntry(entries[1]!.state)).toBe(true)
  expect(isOverlayEntry(entries[0]!.state)).toBe(false)
  back()
  expect(closed).toBe(1)
  expect(at).toBe(0)
})

test('closed by its own ✕: its entry is backed off once the moment is over, and onBack is not called', async () => {
  start()
  let closed = 0
  const release = holdOverlayEntry(() => closed++)
  release()
  // not at once: an overlay opening in the same moment may take the entry over
  expect(at).toBe(1)
  await tick()
  expect(gos).toEqual([-1])
  expect(at).toBe(0)
  expect(closed).toBe(0)
})

test('nested overlays (a sheet over the side chat, a confirm over a dialog): Back closes one per press, the top one first', () => {
  start()
  const closed: string[] = []
  holdOverlayEntry(() => closed.push('side chat'))
  holdOverlayEntry(() => closed.push('sheet'))
  expect(entries).toHaveLength(3)
  expect(entries[2]!.state).toMatchObject({ [OVERLAY_DEPTH]: 2 })
  back()
  expect(closed).toEqual(['sheet'])
  back()
  expect(closed).toEqual(['sheet', 'side chat'])
  expect(at).toBe(0)
})

test('a menu item that opens a dialog: the dialog takes over the menu\'s entry (no back, no second entry); Back closes the dialog', async () => {
  start()
  const closed: string[] = []
  const menu = holdOverlayEntry(() => closed.push('menu'))
  // the same moment: the menu lets go, the dialog opens
  menu()
  holdOverlayEntry(() => closed.push('dialog'))
  await tick()
  expect(gos).toEqual([])
  expect(entries).toHaveLength(2)
  back()
  expect(closed).toEqual(['dialog'])
  expect(at).toBe(0)
})

test('two closed at once (a viewer with its sheet): one history.go(-2), then what waits runs', async () => {
  start()
  const lower = holdOverlayEntry(() => {})
  const upper = holdOverlayEntry(() => {})
  holdBack = true
  upper()
  lower()
  const ran: number[] = []
  whenOverlaysSettled(() => ran.push(at))
  await tick()
  expect(gos).toEqual([-2])
  expect(ran).toEqual([])
  late.shift()!()
  expect(at).toBe(0)
  expect(ran).toEqual([0])
  // nothing pending: at once
  whenOverlaysSettled(() => ran.push(-1))
  expect(ran).toEqual([0, -1])
})

test('a page opened from inside an overlay (a menu item, a search result) takes its entry: Back goes to the page it was over', async () => {
  start()
  let closed = 0
  const menu = holdOverlayEntry(() => closed++)
  // the item's click: the menu closes and the router pushes the new page in the same moment
  menu()
  routerPush('k2', 4, '/files')
  await tick()
  expect(gos).toEqual([])
  expect(entries.map((e) => e.url)).toEqual(['/rooms', '/files'])
  expect(isOverlayEntry(entries[1]!.state)).toBe(false)
  back()
  expect(at).toBe(0)
  expect(closed).toBe(0)
})

test('a page opened from the top of two overlays: the lower one\'s entry is left under it and skipped both ways', async () => {
  start()
  let closed = 0
  const side = holdOverlayEntry(() => closed++)
  const sheet = holdOverlayEntry(() => closed++)
  sheet()
  routerPush('k2', 4, '/c/1')
  // the room (and its side chat) goes with the page
  side()
  await tick()
  expect(entries).toHaveLength(3)
  expect(gos).toEqual([])
  // Back from the new page lands on the side chat's entry, which goes on back to the room
  back()
  expect(at).toBe(0)
  expect(gos).toEqual([-1])
  // Forward from the room goes over it to the page
  forward()
  expect(at).toBe(2)
  expect(closed).toBe(0)
})

test('a filter written to the address while its sheet is open: Back closes the sheet and the page keeps the filter', () => {
  start('/admin/activity')
  holdOverlayEntry(() => {})
  routerReplace('k2', '/admin/activity?kind=files')
  expect(entries).toHaveLength(2)
  expect(entries[1]).toMatchObject({ url: '/admin/activity?kind=files', state: { key: 'k2', [OVERLAY_DEPTH]: 1 } })
  back()
  // the page's entry has the filter before the router reads it
  expect(at).toBe(0)
  expect(entries[0]).toMatchObject({ url: '/admin/activity?kind=files', state: { key: 'k2', idx: 3 } })
  expect(isOverlayEntry(entries[0]!.state)).toBe(false)
})

test('closed with ✕ right after a change of address (the new-chat picker dropping ?new=1): the page keeps the new address, no stale one is left', async () => {
  start('/rooms?new=1')
  const release = holdOverlayEntry(() => {})
  routerReplace('k2', '/rooms')
  release()
  await tick()
  expect(at).toBe(0)
  expect(entries[0]).toMatchObject({ url: '/rooms', state: { key: 'k2' } })
})

test("the first entry (the router's state there has no key): a replace while an overlay is open still reaches it", async () => {
  start('/rooms/r1')
  entries[0] = { state: { idx: 0 }, url: '/rooms/r1' }
  const release = holdOverlayEntry(() => {})
  // the side chat's 보기: the room at the message, in place
  globalThis.history.replaceState({ idx: 0, key: 'k2', usr: null }, '', '/rooms/r1?m=5')
  release()
  await tick()
  expect(at).toBe(0)
  expect(entries[0]).toMatchObject({ url: '/rooms/r1?m=5', state: { key: 'k2', idx: 0 } })
})

test('a replace, then a page opened from the overlay: Back from that page lands on the page with the replaced address', () => {
  start('/rooms?new=1')
  holdOverlayEntry(() => {})
  routerReplace('k2', '/rooms')
  routerPush('k3', 4, '/rooms/r1')
  expect(entries.map((e) => e.url)).toEqual(['/rooms?new=1', '/rooms/r1'])
  back()
  expect(entries[0]!.url).toBe('/rooms')
})

test('a Forward onto the entry of an overlay closed a moment ago goes back where it was; Back from the page does not stall', async () => {
  start()
  const release = holdOverlayEntry(() => {})
  release()
  await tick()
  expect(at).toBe(0)
  gos = []
  forward()
  expect(at).toBe(0)
  expect(gos).toEqual([-1])
})

test('opened while our back is on its way: its entry is pushed once the back has landed', async () => {
  start()
  holdBack = true
  const first = holdOverlayEntry(() => {})
  first()
  await tick()
  expect(gos).toEqual([-1])
  let closed = 0
  holdOverlayEntry(() => closed++)
  // nothing pushed meanwhile (a browser would drop it)
  expect(entries).toHaveLength(2)
  late.shift()!()
  expect(at).toBe(1)
  expect(entries).toHaveLength(2)
  expect(isOverlayEntry(entries[1]!.state)).toBe(true)
  holdBack = false
  back()
  expect(closed).toBe(1)
})

test('a page pushed while our back is on its way is pushed again once it has landed', async () => {
  start()
  holdBack = true
  const r = holdOverlayEntry(() => {})
  r()
  await tick()
  routerPush('k2', 4, '/files')
  // a browser lands the back where it was going (the push is lost there); the push is made again
  entries = entries.slice(0, 2)
  at = 1
  late.shift()!()
  expect(entries[at]!.url).toBe('/files')
  expect(entries.map((e) => e.url)).toEqual(['/rooms', '/files'])
})

test('a side panel kept open across a page change holds a new entry on the new page', async () => {
  start()
  let closed = 0
  const first = holdOverlayEntry(() => closed++)
  routerPush('k2', 4, '/files')
  // useOverlayEntry with a new `at`: the old hold lets go, a new one is pushed on the new page
  first()
  holdOverlayEntry(() => closed++)
  await tick()
  expect(entries.map((e) => e.url)).toEqual(['/rooms', '/files', '/files'])
  back()
  expect(closed).toBe(1)
  expect(globalThis.history.state).toMatchObject({ key: 'k2' })
})

test('a page under a history the page may not change: the overlay still opens, Back leaves the page as before', () => {
  start()
  Object.defineProperty(globalThis, 'history', { configurable: true, writable: true, value: { state: null, pushState() { throw new Error('no') }, replaceState() {}, back() {} } })
  const release = holdOverlayEntry(() => {})
  expect(() => release()).not.toThrow()
})

// ---- one traversal at a time (Chromium applies two backs started together and lands one entry too far) ----

test('a sheet\'s item that opens a screen already in the stack: the screen history steps back past the sheet\'s entry; no back of ours on top of it', async () => {
  start('/scheduled')
  entries = [{ state: { idx: 0, key: 'k0', usr: null }, url: '/' }, { state: { idx: 1, key: 'k1', usr: null }, url: '/scheduled' }]
  at = 1
  resetOverlaysForTest()
  const sheet = holdOverlayEntry(() => {})
  holdBack = true
  // the screen history's step (lib/historySteps.ts tells it with this event)
  const steps = (on: boolean) => globalThis.dispatchEvent(Object.assign(new FakeEvent(HISTORY_STEPS_EVENT), { detail: { stepping: on } }) as unknown as Event)
  // the item: the sheet closes and the screen history goes back to Trina in the same tap (lib/screenHistory.ts),
  // counting the sheet's entry itself
  steps(true)
  globalThis.history.go(-2)
  sheet()
  await tick()
  // only the step: ours waits
  expect(gos).toEqual([-2])
  late.shift()!()
  steps(false)
  await tick()
  expect(gos).toEqual([-2])
  expect(entries[at]!.url).toBe('/')
})

test('someone else\'s back on its way (a ‹): a closed overlay\'s back-off waits for it, and is not needed once it landed past', async () => {
  start()
  const r = holdOverlayEntry(() => {})
  holdBack = true
  // the app's step back from inside the overlay goes past its entry too
  globalThis.history.go(-1)
  expect(gos).toEqual([-2])
  r()
  await tick()
  expect(gos).toEqual([-2])
  late.shift()!()
  await tick()
  expect(gos).toEqual([-2])
})

test('a page\'s ‹ while the @ list is open (React Router\'s navigate(-1)): one step leaves the page, the list closes', () => {
  start('/rooms/r1')
  entries = [{ state: { idx: 0, key: 'k0', usr: null }, url: '/rooms' }, { state: { idx: 1, key: 'k1', usr: null }, url: '/rooms/r1' }]
  at = 1
  resetOverlaysForTest()
  let closed = 0
  holdOverlayEntry(() => closed++)
  globalThis.history.go(-1)
  expect(entries[at]!.url).toBe('/rooms')
  expect(closed).toBe(1)
})

test('an overlay opened while someone else\'s back is on its way pushes its entry once it has landed', () => {
  start()
  routerPush('k2', 4, '/files')
  holdBack = true
  globalThis.history.go(-1)
  holdOverlayEntry(() => {})
  expect(entries).toHaveLength(2)
  late.shift()!()
  expect(at).toBe(1)
  expect(isOverlayEntry(entries[1]!.state)).toBe(true)
  expect(entries[1]!.url).toBe('/rooms')
})

test('a page pushed while our back is on its way is not pushed twice when the browser kept it', async () => {
  start()
  holdBack = true
  const r = holdOverlayEntry(() => {})
  r()
  await tick()
  routerPush('k2', 4, '/files')
  // this browser kept the push and landed on it
  late.shift()
  at = entries.length - 1
  globalThis.dispatchEvent(new FakeEvent('popstate') as unknown as Event)
  expect(entries.filter((e) => e.url === '/files')).toHaveLength(1)
})

