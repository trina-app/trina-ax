// Back closes a full-screen panel on a phone (lib/backCloses.ts; QA TC-080): one history entry while it is open, Back
// that leaves it closes the panel, closing it otherwise goes back off it, and an entry pushed on top with our state
// copied (the image viewer's) keeps it open when Back lands on ours again. A page opened while it is open leaves our
// entry under it: Back and Forward skip it, so each press is one step (QA TC-141).
import { afterEach, expect, test } from 'bun:test'
import { holdBackEntry } from '../../src/lib/backCloses'
import { FakeEvent, installDom, removeDom } from './dom-host'

type State = Record<string, unknown> | null
let stack: State[] = []
let at = 0
let backs = 0
const pop = () => globalThis.dispatchEvent(new FakeEvent('popstate') as unknown as Event)
const start = () => {
  installDom()
  stack = [{ idx: 3, key: 'k1', usr: null }]
  at = 0
  backs = 0
  Object.defineProperty(globalThis, 'history', {
    configurable: true, writable: true,
    value: {
      get state() { return stack[at] ?? null },
      pushState(s: State) { stack = [...stack.slice(0, at + 1), s]; at = stack.length - 1 },
      back() { backs++; at = Math.max(0, at - 1); pop() },
      forward() { at = Math.min(stack.length - 1, at + 1); pop() },
    },
  })
}
afterEach(() => removeDom())

test("opening adds one entry that keeps the router's state; Back closes the panel once", () => {
  start()
  let closed = 0
  holdBackEntry(() => closed++)
  expect(stack).toHaveLength(2)
  expect(stack[1]).toMatchObject({ idx: 3, key: 'k1' })
  globalThis.history.back()
  expect(closed).toBe(1)
  globalThis.history.back()
  expect(closed).toBe(1)
})

test('closing it with its own button goes back off the entry, and does not call onBack', () => {
  start()
  let closed = 0
  const release = holdBackEntry(() => closed++)
  release(true)
  expect(backs).toBe(1)
  expect(at).toBe(0)
  expect(closed).toBe(0)
})

test('the page left (another entry on top): no back, the entry stays where it is', () => {
  start()
  const release = holdBackEntry(() => {})
  globalThis.history.pushState({ idx: 4, key: 'k2', usr: null }, '')
  release(true)
  expect(backs).toBe(0)
  expect(at).toBe(2)
})

test("an image viewer on top with our state copied: Back from it lands on ours and the panel stays open", () => {
  start()
  let closed = 0
  holdBackEntry(() => closed++)
  // the viewer copies the state it finds (lib/imageViewer.ts pushEntry)
  globalThis.history.pushState({ ...(globalThis.history.state as object), __imageViewer: 1 }, '')
  globalThis.history.back()
  expect(closed).toBe(0)
  globalThis.history.back()
  expect(closed).toBe(1)
})

test('a page opened while it is open (a drawer link): Back from that page reaches the page under the panel in one press', () => {
  start()
  let closed = 0
  const release = holdBackEntry(() => closed++)
  // the router pushes the new page on top of our entry, then the drawer closes because the page changed
  globalThis.history.pushState({ idx: 4, key: 'k2', usr: null }, '')
  release(true)
  expect(stack).toHaveLength(3)
  globalThis.history.back()
  // our entry was skipped: the first page, not a second copy of it
  expect(at).toBe(0)
  expect(globalThis.history.state).toMatchObject({ key: 'k1' })
  expect(backs).toBe(2)
  expect(closed).toBe(0)
  // and Forward goes over it the same way, to the new page
  globalThis.history.forward()
  expect(at).toBe(2)
  expect(globalThis.history.state).toMatchObject({ key: 'k2' })
  // Back again: one press, the first page again (no loop on the left-behind entry)
  globalThis.history.back()
  expect(at).toBe(0)
})

test('a panel kept open across a page change holds a new entry on the new page: Back closes it and stays there', () => {
  start()
  let closed = 0
  const first = holdBackEntry(() => closed++)
  globalThis.history.pushState({ idx: 4, key: 'k2', usr: null }, '')
  // useBackCloses with a new `at`: the old hold lets go, a new one is pushed on the new page
  first(true)
  holdBackEntry(() => closed++)
  globalThis.history.back()
  expect(closed).toBe(1)
  expect(globalThis.history.state).toMatchObject({ key: 'k2' })
})
