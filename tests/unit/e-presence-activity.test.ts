// This window's own "in use" (web/src/lib/presence.ts ActivityTracker), for the team's dots and the phone rule
// (docs/decisions/20261116-away-os-idle.md). Mainly: a desktop window in the back sends its state again on every word
// from the desktop app, even unchanged, because the browser engine throttles it (its ping may stop for minutes) and
// the server leaves a window silent for 60 s out. A browser tab cannot see the computer: hidden is idle at once.
import { expect, test } from 'bun:test'
import type { WindowActivity } from '@mycel/shared/api'
import { ActivityTracker, IDLE_AFTER_MS } from '../../web/src/lib/presence'

function tracker(o: { visible?: boolean; desktop?: boolean; phone?: boolean } = {}) {
  let t = 1_000_000
  let visible = o.visible ?? true
  const sent: WindowActivity[] = []
  const timers: { at: number; fn: () => void }[] = []
  const tr = new ActivityTracker((s) => sent.push(s), {
    now: () => t,
    setTimeout: (fn, ms) => { const x = { at: t + ms, fn }; timers.push(x); return x },
    clearTimeout: (x) => { const i = timers.indexOf(x as never); if (i >= 0) timers.splice(i, 1) },
    visible: () => visible,
    phone: o.phone ?? false,
    desktop: o.desktop ?? false,
  })
  const advance = (ms: number) => {
    t += ms
    for (const x of timers.splice(0).filter((x) => x.at <= t)) x.fn()
  }
  return { tr, sent, advance, hide: () => { visible = false; tr.visibility() } }
}

test('desktop window in the back: every word from the desktop app sends the state again, even unchanged', () => {
  const m = tracker({ desktop: true })
  m.tr.connected()
  expect(m.sent).toEqual(['active'])
  m.hide()
  m.tr.system({ locked: false, idleMs: 2000 })
  m.tr.system({ locked: false, idleMs: 30_000 })
  expect(m.sent).toEqual(['active', 'active', 'active'])
})

test('desktop: idle past 10 minutes says idle, a locked screen says idle at once', () => {
  const m = tracker({ desktop: true })
  m.hide()
  m.advance(IDLE_AFTER_MS + 1000)
  m.tr.system({ locked: false, idleMs: IDLE_AFTER_MS + 1000 })
  expect(m.tr.current).toBe('idle')
  m.tr.system({ locked: false, idleMs: 1000 })
  expect(m.tr.current).toBe('active')
  m.tr.system({ locked: true, idleMs: 0 })
  expect(m.tr.current).toBe('idle')
})

test('a browser tab hidden: idle at once (current behaviour: a tab cannot see the computer, it must not keep the phone quiet)', () => {
  const m = tracker()
  expect(m.tr.current).toBe('active')
  m.hide()
  expect(m.tr.current).toBe('idle')
  expect(m.sent).toEqual(['idle'])
})

test('a phone: the desktop word is ignored; hidden is idle', () => {
  const m = tracker({ phone: true })
  m.tr.system({ locked: false, idleMs: 0 })
  expect(m.sent).toEqual([])
  m.hide()
  expect(m.tr.current).toBe('idle')
})
