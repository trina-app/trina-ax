// Back closes a full-screen panel on a phone (lib/backCloses.ts; QA TC-080): one history entry while it is open, Back
// that leaves it closes the panel, closing it otherwise goes back off it, and an entry pushed on top with our state
// copied (the image viewer's) keeps it open when Back lands on ours again.
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
