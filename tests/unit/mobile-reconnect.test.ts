// The phone app's failure screen tries again by itself (mobile/src/reconnect.ts, QA TC-2265): a push tapped with Wi-Fi
// off opened "Could not reach your team" and stayed there after Wi-Fi came back until Try again was tapped.
import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { Reconnect, RECONNECT_DELAYS, type Timers } from '../../mobile/src/reconnect'

/** Fake timers: `elapse(ms)` runs what is due, in order. */
function clock() {
  let now = 0, next = 1
  const due = new Map<number, { at: number; fn: () => void }>()
  const timers: Timers = {
    set: (fn, ms) => { const id = next++; due.set(id, { at: now + ms, fn }); return id },
    clear: id => { due.delete(id as number) },
  }
  async function elapse(ms: number) {
    const end = now + ms
    for (;;) {
      const first = [...due.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (!first || first[1].at > end) break
      due.delete(first[0]); now = first[1].at; first[1].fn()
      await flush()
    }
    now = end
  }
  return { timers, elapse, pending: () => due.size, at: () => now }
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

/** A network that is off until `online = true`; every probe is logged with its time. */
function network(c: ReturnType<typeof clock>) {
  const n = { online: false, probes: [] as number[], probe: async () => { n.probes.push(c.at()); return n.online } }
  return n
}

test('offline: probes back off 2 s, 4 s, 8 s, then every 15 s, one at a time', async () => {
  const c = clock(), net = network(c)
  let back = 0
  const r = new Reconnect(net.probe, () => { back++ }, c.timers)
  r.start()
  r.start() // a second failure while the screen is up schedules nothing more
  expect(c.pending()).toBe(1)
  await c.elapse(2_000 + 4_000 + 8_000 + 15_000 + 15_000)
  expect(net.probes).toEqual([2_000, 6_000, 14_000, 29_000, 44_000])
  expect(back).toBe(0)
  expect(c.pending()).toBe(1)
  expect(RECONNECT_DELAYS.at(-1)).toBe(15_000)
})

test('the network comes back: the next probe answers and the page loads again, with no tap', async () => {
  const c = clock(), net = network(c)
  let back = 0
  const r = new Reconnect(net.probe, () => { back++ }, c.timers)
  r.start()
  await c.elapse(60_000)
  net.online = true
  await c.elapse(15_000)
  expect(back).toBe(1)
  // stopped: no more probes after it answered
  const probes = net.probes.length
  await c.elapse(120_000)
  expect(net.probes.length).toBe(probes)
  expect(c.pending()).toBe(0)
})

test('back in the foreground: asks at once, and the backoff starts from 2 s again', async () => {
  const c = clock(), net = network(c)
  let back = 0
  const r = new Reconnect(net.probe, () => { back++ }, c.timers)
  r.start()
  await c.elapse(29_000) // 4 probes, the next one 15 s away
  r.pause()
  expect(c.pending()).toBe(0)
  // nothing while in the background
  await c.elapse(300_000)
  expect(net.probes.length).toBe(4)
  r.wake()
  await flush()
  expect(net.probes.length).toBe(5)
  expect(net.probes.at(-1)).toBe(c.at())
  const woke = c.at()
  await c.elapse(2_000)
  expect(net.probes.at(-1)).toBe(woke + 2_000)
  // online while in the background, then foreground: opened at once
  r.pause(); net.online = true
  r.wake(); await flush()
  expect(back).toBe(1)
})

test('wake without the failure screen does nothing; stop drops a probe that was on its way', async () => {
  const c = clock()
  let answer: (v: boolean) => void = () => {}, probes = 0, back = 0
  const r = new Reconnect(() => { probes++; return new Promise<boolean>(resolve => { answer = resolve }) }, () => { back++ }, c.timers)
  r.wake(); await flush()
  expect(probes).toBe(0)
  r.start()
  await c.elapse(2_000)
  expect(probes).toBe(1)
  // Try again tapped (or a push opened) while the probe waits: the late answer reloads nothing
  r.stop()
  answer(true); await flush()
  expect(back).toBe(0)
  expect(c.pending()).toBe(0)
})

test('a probe that throws counts as no answer', async () => {
  const c = clock()
  let probes = 0
  const r = new Reconnect(async () => { probes++; throw new Error('offline') }, () => {}, c.timers)
  r.start()
  await c.elapse(6_000)
  expect(probes).toBe(2)
  expect(c.pending()).toBe(1)
})

test('a team that answers health but fails the page is not reloaded every 2 s: the backoff only resets after a page loaded', async () => {
  const c = clock()
  let reloads = 0
  const r = new Reconnect(async () => true, () => { reloads++ }, c.timers)
  const times: number[] = []
  // each reload fails again at once (a 500): the screen comes back
  for (let i = 0; i < 5; i++) { r.start(); await c.elapse(15_000); times.push(c.at()) }
  expect(reloads).toBe(5)
  // the waits grew: 2, 4, 8, 15, 15 s (each elapse ran the one due timer, then idled to 15 s)
  r.start()
  expect(c.pending()).toBe(1)
  await c.elapse(14_999)
  expect(reloads).toBe(5)
  await c.elapse(1)
  expect(reloads).toBe(6)
  // a page loaded: the next failure waits 2 s again
  r.reset(); r.start()
  await c.elapse(2_000)
  expect(reloads).toBe(7)
})

test('App.tsx: the failure screen starts and stops it, the foreground wakes it, a loaded page resets it', () => {
  const app = fs.readFileSync(path.join(import.meta.dir, '../../mobile/App.tsx'), 'utf8')
  expect(app).toContain('const answer = probeAnswer(c)')
  expect(app).toContain("return answer === 'load'")
  expect(app).toContain('if (!failed) { again.stop(); setStarting(null); return }\n    again.start()')
  expect(app).toContain("if (state === 'active') again.wake(); else again.pause()")
  expect(app).toContain('reconnect.current?.reset()')
  // Try again stays
  expect(app).toContain('onPress={() => setFailed(null)} testID="retry"')
})

test('now(): a probe at once, the backoff after it; not in the background; after a probe that was being stopped', async () => {
  const c = clock(), net = network(c)
  const r = new Reconnect(net.probe, () => {}, c.timers)
  r.now()
  expect(net.probes).toEqual([])
  r.start(); r.now()
  await flush()
  expect(net.probes).toEqual([0])
  // the backoff goes on after it (its first step was taken by start)
  await c.elapse(4_000)
  expect(net.probes).toEqual([0, 4_000])
  r.pause(); r.now()
  await flush()
  expect(net.probes.length).toBe(2)
  r.stop()
  // a probe on its way when the screen goes and comes back (Try again, the page 503s again): the next one right after it
  let answer: (v: boolean) => void = () => {}
  const seen: AbortSignal[] = []
  let probes = 0
  const slow = new Reconnect(signal => { probes++; seen.push(signal); return new Promise<boolean>(resolve => { answer = resolve }) }, () => {}, c.timers)
  slow.start(); slow.now()
  await flush()
  expect(probes).toBe(1)
  slow.stop()
  expect(seen[0]!.aborted).toBe(true)
  slow.start(); slow.now()
  answer(true)
  await flush()
  expect(probes).toBe(2)
  expect(seen[1]!.aborted).toBe(false)
})

test('stop() and pause() abort the probe on its way (a wake waits up to 3 minutes); its answer then loads nothing', async () => {
  const c = clock()
  let back = 0, answer: (v: boolean) => void = () => {}
  const seen: AbortSignal[] = []
  const r = new Reconnect(signal => { seen.push(signal); return new Promise<boolean>(resolve => { answer = resolve }) }, () => { back++ }, c.timers)
  r.start(); r.now()
  await flush()
  r.pause()
  expect(seen[0]!.aborted).toBe(true)
  answer(true)
  await flush()
  expect(back).toBe(0)
  expect(r.waiting).toBe(false)
  // back in the foreground: asks again
  r.wake()
  await flush()
  expect(seen.length).toBe(2)
  answer(true)
  await flush()
  expect(back).toBe(1)
})

test('App.tsx: a 503 asks the team at once and shows the waking note; other 5xx as before', () => {
  const app = fs.readFileSync(path.join(import.meta.dir, '../../mobile/App.tsx'), 'utf8')
  expect(app).toContain('const step = httpFailure(event.nativeEvent.statusCode)')
  expect(app).toContain("if (step === 'check') { checkNow.current = true; setStarting('check') }")
  expect(app).toContain('if (checkNow.current) { checkNow.current = false; again.now() }')
  expect(app).toContain("checkTeam(address.origin, service.teamDomain, () => { if (!signal.aborted) setStarting('waking') }, signal)")
  expect(app).toMatch(/if \(failed && starting\) return <Center>\n\s*\{starting === 'waking' \? <WakingNote \/>/)
  expect(app).not.toContain('statusCode >= 500) fail(')
})
