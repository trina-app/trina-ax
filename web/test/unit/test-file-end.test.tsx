// What a test file leaves behind when it ends does not break the next one (test/unit/preload.ts, dom-host.ts):
// - A component can set its state after it is gone: a timer it never cleared, a fetch that answers after it unmounted.
//   In a browser that does nothing. Here its file's fake document is gone by then, and React DOM reads `window.event`
//   for the update's priority: that was a ReferenceError in whichever file ran next (CI: "0 fail, 1 error", "Unhandled
//   error between tests"). Now it does nothing here either, and tests without a document still see no `window`.
// - A file that sets TZ and puts it back leaves the next file in the zone the run started in (Bun 1.3: a deleted TZ
//   kept the last zone for the rest of the run).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { act, useState } from 'react'
import { domInstalled, installDom, mount, removeDom } from './dom-host'

let setLater: ((n: number) => void) | null = null
function Counter() {
  const [n, setN] = useState(0)
  setLater = setN
  return <span data-testid="n">{n}</span>
}

/** an update from a timer, as a component leaves one: what it threw, if it threw */
const fromTimer = (n: number) =>
  new Promise<unknown>((done) => setTimeout(() => {
    try { setLater!(n); done(undefined) } catch (e) { done(e) }
  }, 5))

beforeAll(() => { installDom() })

test('a component that is gone sets its state after its document went: nothing happens, and still no window', async () => {
  const page = await mount(<Counter />)
  expect(page.get('n').textContent).toBe('0')
  await page.unmount()
  removeDom()
  expect(typeof window).toBe('undefined')
  expect(() => setLater!(1)).not.toThrow()
  expect(await fromTimer(2)).toBeUndefined()
})

test('one a test left mounted is unmounted with the document; its later update does nothing either', async () => {
  installDom()
  await mount(<Counter />)
  removeDom()
  expect(typeof window).toBe('undefined')
  expect(await fromTimer(3)).toBeUndefined()
})

test('with a document again, state updates render as before', async () => {
  installDom()
  const page = await mount(<Counter />)
  try {
    await act(async () => setLater!(4))
    expect(page.get('n').textContent).toBe('4')
  } finally { await page.unmount() }
})

test('a file that set TZ and put back what it found leaves the run\'s zone for the next file', () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  // the preload set TZ, so a file puts back a value and never deletes it (Bun 1.3 would then keep the last zone)
  const previous = process.env.TZ
  expect(previous).toBeTruthy()
  const other = zone === 'America/New_York' ? 'Asia/Seoul' : 'America/New_York'
  try {
    process.env.TZ = other
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(other)
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous }
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone)
  // one that did not put it back: the next file starts in the run's zone again
  process.env.TZ = other
  ;(globalThis as Record<symbol, () => void>)[Symbol.for('mycel.web-test.file-start')]!()
  expect(process.env.TZ).toBe(previous!)
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone)
})

// after the last test, as CI met it: a component's state set once its file has ended and the document is gone (an
// error there would be the run's "Unhandled error between tests")
afterAll(async () => {
  if (!domInstalled()) installDom()
  await mount(<Counter />)
  removeDom()
  setTimeout(() => setLater!(5), 0)
})
