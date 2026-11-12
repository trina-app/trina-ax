// The steps through the history the app's own code waits on (lib/historySteps.ts): the flag, the event both sides of
// the overlays' contract read, and what waits for them.
import { expect, test } from 'bun:test'
import { HISTORY_STEPS_EVENT, historyStepping, stepping, whenStepsDone } from '../../src/lib/historySteps'

test('a step of ours: the flag, one event when the first starts and one when the last ends, then what waited', async () => {
  const seen: boolean[] = []
  const target = new EventTarget()
  const before = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: target })
  const on = (e: Event) => seen.push((e as CustomEvent<{ stepping: boolean }>).detail.stepping)
  target.addEventListener(HISTORY_STEPS_EVENT, on)
  try {
    let after = false
    expect(historyStepping()).toBe(false)
    let release!: () => void
    const outer = stepping(() => new Promise<void>((done) => { release = done }))
    expect(historyStepping()).toBe(true)
    const inner = stepping(async () => {})
    await inner
    whenStepsDone(() => { after = true })
    expect(after).toBe(false)
    release()
    await outer
    expect(historyStepping()).toBe(false)
    expect(after).toBe(true)
    expect(seen).toEqual([true, false])
    // none on its way: at once
    let now = false
    whenStepsDone(() => { now = true })
    expect(now).toBe(true)
  } finally {
    target.removeEventListener(HISTORY_STEPS_EVENT, on)
    if (before) Object.defineProperty(globalThis, 'window', before)
    else delete (globalThis as { window?: unknown }).window
  }
})
