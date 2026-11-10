// lib/stickToBottom.ts: a message list at its bottom stays there when its content grows and when the list itself gets
// shorter or taller (a phone's keyboard); a reader who scrolled up keeps the message in sight where it was. A scroll
// event in the same frame as the list's own size change is the browser's, not the reader's (the iPhone app's WebView
// moves the list 22 px up as the keyboard opens). followsAfterScroll: the scroll event of the list's own jump to the
// bottom, coming after a card was added, does not read as the reader scrolling up.
import { expect, test } from 'bun:test'
import { followsAfterScroll, jumpToBottom, onListScroll, placeAfterResize, scrolledByReader, watchListSize, type ListSize } from '../../src/lib/stickToBottom'

/** a ResizeObserver whose callbacks the test runs, as the browser would after a layout */
class FakeRO {
  static last: FakeRO | null = null
  observed: unknown[] = []
  disconnected = false
  constructor(readonly cb: () => void) { FakeRO.last = this }
  observe(el: unknown) { this.observed.push(el) }
  disconnect() { this.disconnected = true }
  fire() { if (!this.disconnected) this.cb() }
}
/** a visual viewport whose events the test sends */
class FakeVV {
  handlers = new Map<string, Set<() => void>>()
  addEventListener(type: string, h: () => void) { (this.handlers.get(type) ?? this.handlers.set(type, new Set()).get(type)!).add(h) }
  removeEventListener(type: string, h: () => void) { this.handlers.get(type)?.delete(h) }
  send(type: string) { for (const h of this.handlers.get(type) ?? []) h() }
  count() { return [...this.handlers.values()].reduce((n, s) => n + s.size, 0) }
}

/** a scrolling box whose scrollTop the browser keeps between 0 and its end, as a real one */
class Box {
  private top = 0
  constructor(public scrollHeight: number, public clientHeight: number, public clientWidth: number, top: number) { this.scrollTop = top }
  get scrollTop() { return this.top }
  set scrollTop(v: number) { this.top = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight)) }
}
/** px between what is in sight and the end of the list */
const gap = (el: Box) => el.scrollHeight - el.scrollTop - el.clientHeight

/** A list as the hook drives it: the size watcher, and the list's scroll handler (useStickToBottom's onScroll). */
function setup(el: Box, stick = true) {
  const st = { stick: { current: stick }, lastTop: { current: el.scrollTop }, seen: { current: null as ListSize | null } }
  const vv = new FakeVV()
  const stop = watchListSize(el as never, {} as never, { follows: () => st.stick.current, lastTop: st.lastTop, seen: st.seen }, FakeRO as never, vv as never)
  const ro = FakeRO.last!
  // observe() reports the first size at once
  ro.fire()
  // the hook's own scroll handler
  const onScroll = () => onListScroll(el, st)
  return { st, ro, vv, stop, onScroll }
}

test('the keyboard opens at the bottom (the list shrinks to 306 px): the newest message stays in sight', () => {
  const el = new Box(3000, 700, 390, 2300)
  const { ro, stop } = setup(el)
  expect(ro.observed.length).toBe(2)
  // 844 → 450 high: the list loses 394 px from below, scrollTop stays and no scroll event comes (Android)
  el.clientHeight = 306
  expect(gap(el)).toBe(394)
  ro.fire()
  expect(gap(el)).toBe(0)
  // a picture loads and the content grows: still at the bottom
  el.scrollHeight = 3400
  ro.fire()
  expect(gap(el)).toBe(0)
  stop()
  expect(ro.disconnected).toBe(true)
})

test("the iPhone app's frame: the list shrinks and the engine nudges it 22 px up before the size watcher; it still follows", () => {
  // measured in the iOS 26.5 simulator, a WKWebView like the phone app's: 8580 / 629 / 9209 before, 8558 / 248 after
  const el = new Box(9209, 629, 393, 8580)
  const { st, ro, onScroll } = setup(el)
  el.clientHeight = 248
  el.scrollTop = 8558
  expect(gap(el)).toBe(403)
  // the scroll event comes first: the browser's, not the reader's
  expect(onScroll()).toBe(false)
  expect(st.stick.current).toBe(true)
  ro.fire()
  expect(gap(el)).toBe(0)
  // the list's own jump comes back as a scroll event next frame: still following
  expect(onScroll()).toBe(true)
  expect(st.stick.current).toBe(true)
})

test('before this fix, that nudge read as the reader leaving the bottom', () => {
  const el = { scrollHeight: 9209, clientHeight: 248, scrollTop: 8558 }
  expect(followsAfterScroll(el, true, 8580)).toBe(false)
})

/** messages of 120 px each from the content's top; the first one in sight and how far below the list's top it starts */
const firstInSight = (el: { scrollTop: number }) => {
  const i = Math.floor(el.scrollTop / 120)
  return { i, offset: i * 120 - el.scrollTop }
}

test('scrolled up to read: the keyboard opens and closes, and the message in sight keeps its place', () => {
  const el = new Box(6000, 629, 393, 5371)
  const { st, ro, vv, onScroll } = setup(el, true)
  // the reader scrolls up to message 20
  el.scrollTop = 2430
  expect(onScroll()).toBe(true)
  expect(st.stick.current).toBe(false)
  const before = firstInSight(el)
  // the keyboard: the list shrinks, the engine nudges it, a visual viewport event and the size watcher
  el.clientHeight = 248
  el.scrollTop = 2408
  vv.send('resize')
  expect(onScroll()).toBe(false)
  ro.fire()
  expect(firstInSight(el)).toEqual(before)
  expect(st.stick.current).toBe(false)
  // the keyboard closes: the list grows back, the message stays
  el.clientHeight = 629
  vv.send('resize')
  ro.fire()
  expect(firstInSight(el)).toEqual(before)
  expect(el.scrollTop).toBe(2430)
})

test('scrolled up, the message box grows a line (no keyboard): the browser keeps its place, a scroll in that frame is not undone', () => {
  const el = new Box(6000, 629, 393, 5371)
  const { st, ro, onScroll } = setup(el, true)
  el.scrollTop = 2430
  expect(onScroll()).toBe(true)
  expect(st.stick.current).toBe(false)
  // the box grows by 24 px while the reader flicks on up, in the same frame
  el.clientHeight = 605
  el.scrollTop = 2380
  expect(onScroll()).toBe(false)
  ro.fire()
  expect(el.scrollTop).toBe(2380)
  // the next scroll event is the reader's again
  el.scrollTop = 2300
  expect(onScroll()).toBe(true)
  expect(st.stick.current).toBe(false)
})

test('canStick false (a room opened around an older message): a scroll near the bottom does not follow', () => {
  const el = new Box(3000, 700, 390, 2300)
  const st = { stick: { current: false }, lastTop: { current: 2300 }, seen: { current: { height: 700, width: 390 } as ListSize | null } }
  expect(onListScroll(el, st, () => false)).toBe(true)
  expect(st.stick.current).toBe(false)
  expect(onListScroll(el, st)).toBe(true)
  expect(st.stick.current).toBe(true)
})

test('at the bottom, the keyboard closes (the list grows, the browser clamps): still at the bottom, no jump up', () => {
  const el = new Box(3000, 306, 390, 2694)
  const { st, ro, onScroll } = setup(el)
  el.clientHeight = 700
  el.scrollTop = 2300
  expect(onScroll()).toBe(false)
  ro.fire()
  expect(gap(el)).toBe(0)
  expect(st.stick.current).toBe(true)
})

test('a visual viewport event (iOS) settles the list early but leaves the size to the observer', () => {
  const el = new Box(3000, 700, 390, 2300)
  const { st, ro, vv, stop } = setup(el)
  el.clientHeight = 306
  vv.send('resize')
  expect(gap(el)).toBe(0)
  expect(st.seen.current).toEqual({ height: 700, width: 390 })
  ro.fire()
  expect(st.seen.current).toEqual({ height: 306, width: 390 })
  stop()
  expect(vv.count()).toBe(0)
})

test("a computer's window: a narrower list keeps the browser's place, content growing above a reader is the browser's", () => {
  const el = { scrollTop: 1000, scrollHeight: 5000, clientHeight: 700, clientWidth: 780 }
  const seen = { height: 700, width: 780 }
  // narrower and shorter at once: rewrapped messages, the browser's own scroll anchoring keeps the place
  expect(placeAfterResize({ ...el, clientWidth: 600, clientHeight: 650 }, false, 1200, seen)).toBeNull()
  // the content alone grew (a picture above): nothing done here
  expect(placeAfterResize({ ...el, scrollHeight: 5400 }, false, 1200, seen)).toBeNull()
  // shorter without a keyboard (the message box grew): the browser's place
  expect(placeAfterResize({ ...el, clientHeight: 650 }, false, 1200, seen, false)).toBeNull()
  // shorter with the keyboard: back to where the reader left it
  expect(placeAfterResize({ ...el, clientHeight: 300 }, false, 1200, seen, true)).toBe(1200)
  // following: the bottom, whatever changed
  expect(placeAfterResize(el, true, 1200, seen)).toBe(5000)
  // nothing seen yet: nothing to go back to
  expect(placeAfterResize({ ...el, clientHeight: 300 }, false, 1200, null)).toBeNull()
})

test('a scroll event is the reader\'s unless the list\'s own size changed since the observer saw it', () => {
  expect(scrolledByReader({ clientHeight: 700, clientWidth: 390 }, { height: 700, width: 390 })).toBe(true)
  expect(scrolledByReader({ clientHeight: 306, clientWidth: 390 }, { height: 700, width: 390 })).toBe(false)
  expect(scrolledByReader({ clientHeight: 700, clientWidth: 600 }, { height: 700, width: 390 })).toBe(false)
  // no ResizeObserver: every scroll event is the reader's, as before
  expect(scrolledByReader({ clientHeight: 306, clientWidth: 390 }, null)).toBe(true)
})

test('no ResizeObserver: nothing is watched, and the cleanup is harmless', () => {
  const el = new Box(3000, 700, 390, 2300)
  const vv = new FakeVV()
  expect(() => watchListSize(el as never, {} as never, { follows: () => true, lastTop: { current: 0 }, seen: { current: null } }, undefined, vv as never)()).not.toThrow()
  expect(vv.count()).toBe(0)
})

test('a scroll event: near the bottom the list follows; further up it stops only when the reader moved up', () => {
  const el = { scrollHeight: 3000, clientHeight: 700, scrollTop: 2300 }
  // at the bottom, and 60 px above it
  expect(followsAfterScroll(el, false, 0)).toBe(true)
  expect(followsAfterScroll({ ...el, scrollTop: 2240 }, false, 2300)).toBe(true)
  // the reader scrolls up to read: it stops following
  expect(followsAfterScroll({ ...el, scrollTop: 1500 }, true, 2300)).toBe(false)
  // ...and back down, not yet at the bottom: still not following; at the bottom again: following
  expect(followsAfterScroll({ ...el, scrollTop: 2000 }, false, 1500)).toBe(false)
  expect(followsAfterScroll({ ...el, scrollTop: 2300 }, false, 2000)).toBe(true)
})

test("the room's own jump to the bottom, its scroll event after a 330 px card came: still following, and the size watcher shows the whole card", () => {
  // the step line came: the room jumped to the bottom (scrollTop 2300 of 3000)
  const el = new Box(3000, 700, 780, 2300)
  const { st, ro, onScroll } = setup(el)
  // the card came in the same frame, before the jump's scroll event: 330 px more below
  el.scrollHeight = 3330
  // the scroll event: 330 px from the bottom, but nobody moved up (before: "scrolled up", and the card stayed below the
  // message box with only its "확인해 주세요" line in sight)
  expect(onScroll()).toBe(true)
  expect(st.stick.current).toBe(true)
  ro.fire()
  expect(gap(el)).toBe(0)
  // its preview loads and the card grows: still all in sight
  el.scrollHeight = 3480
  ro.fire()
  expect(gap(el)).toBe(0)
})

test("a link's message scrolled into view in the same frame as the list's jump to the bottom: one scroll event, and it stops following", () => {
  // the thread opens at the bottom (the page's layout effect), then the reply a notice points at is put in the middle,
  // before any scroll event: the one event that comes shows only the middle
  const el = { scrollHeight: 3000, clientHeight: 700, scrollTop: 0 }
  const lastTop = { current: 0 }
  jumpToBottom(el, lastTop)
  expect(el.scrollTop).toBe(3000)
  expect(lastTop.current).toBe(3000)
  el.scrollTop = 1200
  expect(followsAfterScroll(el, true, lastTop.current)).toBe(false)
})

test('the size watcher remembers where it left the list; not following, a content change leaves it alone', () => {
  const el = new Box(3000, 700, 390, 2300)
  const { st, ro } = setup(el)
  el.scrollHeight = 3330
  ro.fire()
  expect(st.lastTop.current).toBe(2630)
  st.stick.current = false
  el.scrollTop = 1000
  el.scrollHeight = 3600
  ro.fire()
  expect(el.scrollTop).toBe(1000)
  expect(st.lastTop.current).toBe(1000)
})
