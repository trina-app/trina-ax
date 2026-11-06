// lib/stickToBottom.ts: a message list at its bottom stays there when its content grows and when the list itself gets
// shorter (a phone's keyboard with interactive-widget=resizes-content: the list shrinks from below, its scroll position
// stays and no scroll event comes). A reader who scrolled up is left where they are.
import { expect, test } from 'bun:test'
import { stickToBottom } from '../../src/lib/stickToBottom'

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
