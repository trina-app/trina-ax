// lib/stickToBottom.ts: a message list at its bottom stays there when its content grows and when the list itself gets
// shorter (a phone's keyboard with interactive-widget=resizes-content: the list shrinks from below, its scroll position
// stays and no scroll event comes). A reader who scrolled up is left where they are. followsAfterScroll: the scroll event
// of the list's own jump to the bottom, coming after a card was added, does not read as the reader scrolling up.
import { expect, test } from 'bun:test'
import { followsAfterScroll, stickToBottom } from '../../src/lib/stickToBottom'

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
/** a scroller 844 px tall at 390 x 844, holding 3,000 px of messages, scrolled to the bottom */
const list = () => {
  const s = { scrollHeight: 3000, clientHeight: 700, scrollTop: 2300 }
  return { scroller: s, content: {}, bottomGap: () => s.scrollHeight - s.scrollTop - s.clientHeight }
}

test('the keyboard opens (the list shrinks to 306 px): the newest message stays in sight', () => {
  const { scroller, content, bottomGap } = list()
  let atBottom = true
  const stop = stickToBottom(scroller as never, content as never, () => atBottom, FakeRO as never)
  const ro = FakeRO.last!
  expect(ro.observed).toEqual([content, scroller])
  // 844 → 450 high: the list loses 394 px from below, scrollTop stays
  scroller.clientHeight = 306
  expect(bottomGap()).toBe(394)
  ro.fire()
  expect(scroller.scrollTop).toBe(scroller.scrollHeight)
  // a picture loads and the content grows: still at the bottom
  scroller.scrollHeight = 3400
  ro.fire()
  expect(scroller.scrollTop).toBe(3400)
  // a reader who scrolled up to an older message is left there
  atBottom = false
  scroller.scrollTop = 500
  scroller.clientHeight = 700
  ro.fire()
  expect(scroller.scrollTop).toBe(500)
  stop()
  expect(ro.disconnected).toBe(true)
})

test('no ResizeObserver: nothing is watched, and the cleanup is harmless', () => {
  const { scroller, content } = list()
  expect(() => stickToBottom(scroller as never, content as never, () => true, undefined)()).not.toThrow()
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
  // the step line came: the room jumped to the bottom (scrollTop 2300 of 3000, the last scroll event left it at 2280)
  const scroller = { scrollHeight: 3000, clientHeight: 700, scrollTop: 2300 }
  let follow = true
  const stop = stickToBottom(scroller as never, {} as never, () => follow, FakeRO as never)
  // the card came in the same frame, before the jump's scroll event: 330 px more below
  scroller.scrollHeight = 3330
  // the scroll event: 330 px from the bottom, but nobody moved up (before this fix: "scrolled up", and the card stayed
  // below the message box with only its "확인해 주세요" line in sight)
  follow = followsAfterScroll(scroller, follow, 2280)
  expect(follow).toBe(true)
  FakeRO.last!.fire()
  expect(scroller.scrollTop).toBe(3330)
  // its preview loads and the card grows: still all in sight
  scroller.scrollHeight = 3480
  FakeRO.last!.fire()
  expect(scroller.scrollTop).toBe(3480)
  stop()
})
