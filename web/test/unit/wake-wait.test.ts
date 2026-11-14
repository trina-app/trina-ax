// A team that does not start (QA wake gap 2; lib/wakeWait.ts), on a fake clock: while the relay keeps answering
// team_waking, "Starting your team…" shows for 3 minutes, then "Your team didn't start. Try again in a minute, or
// contact support." with [Try again], which waits 3 more minutes. Any other answer ends the wait.
import { describe, expect, test } from 'bun:test'
import { WAKE_GIVE_UP_MS, WakeWait, type WakeClock } from '../../src/lib/wakeWait'
import { LOCALES, translate } from '../../src/i18n'

function fakeClock() {
  let now = 0
  let next = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  const clock: WakeClock = {
    setTimeout: (fn, ms) => { const id = next++; timers.set(id, { at: now + ms, fn }); return id },
    clearTimeout: (id) => { timers.delete(id as number) },
  }
  return {
    clock,
    advance(ms: number) {
      const end = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].fn()
      }
      now = end
    },
  }
}

describe('waiting for a team that is starting', () => {
  test('3 minutes of "starting", then it gave up; the answers in between do not start the wait over', () => {
    const c = fakeClock()
    let changes = 0
    const w = new WakeWait(() => changes++, c.clock)
    w.update(true)
    for (let i = 0; i < 35; i++) { c.advance(5_000); w.update(true) } // the page asks every 5 s
    expect(w.gaveUp).toBe(false)
    c.advance(WAKE_GIVE_UP_MS - 35 * 5_000 - 1)
    expect(w.gaveUp).toBe(false)
    c.advance(1)
    expect(w.gaveUp).toBe(true)
    expect(changes).toBe(1)
    // still "starting": it stays given up (no new timer)
    w.update(true)
    c.advance(WAKE_GIVE_UP_MS * 2)
    expect(w.gaveUp).toBe(true)
    expect(changes).toBe(1)
  })
  test('[Try again] waits 3 more minutes', () => {
    const c = fakeClock()
    const w = new WakeWait(() => {}, c.clock)
    w.update(true)
    c.advance(WAKE_GIVE_UP_MS)
    expect(w.gaveUp).toBe(true)
    w.restart()
    expect(w.gaveUp).toBe(false)
    c.advance(WAKE_GIVE_UP_MS - 1)
    w.update(true)
    expect(w.gaveUp).toBe(false)
    c.advance(1)
    expect(w.gaveUp).toBe(true)
  })
  test('another answer (the team answered, another error) ends the wait; the next "starting" counts from zero', () => {
    const c = fakeClock()
    const w = new WakeWait(() => {}, c.clock)
    w.update(true)
    c.advance(WAKE_GIVE_UP_MS - 10_000)
    w.update(false)
    c.advance(20_000)
    expect(w.gaveUp).toBe(false)
    w.update(true)
    c.advance(WAKE_GIVE_UP_MS - 1)
    expect(w.gaveUp).toBe(false)
    c.advance(1)
    expect(w.gaveUp).toBe(true)
    w.update(false)
    expect(w.gaveUp).toBe(false)
  })
  test('the words, in all six languages', () => {
    expect(translate('en', 'conn.wakeFailed')).toBe("Your team didn't start. Try again in a minute, or contact support.")
    for (const { id: l } of LOCALES) expect(translate(l, 'conn.wakeFailed').length).toBeGreaterThan(10)
    expect(translate('ko', 'conn.wakeFailed')).not.toBe(translate('en', 'conn.wakeFailed'))
  })
})
