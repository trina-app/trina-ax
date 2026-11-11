// Reading again by itself after the connection failed (lib/autoRetry.ts; docs/DECISIONS.md "How we show errors"), on a
// fake clock:
// - the backoff: 2, 4, 8, 15 s, then every 30 s; a read that works (the notice goes: stop) ends it;
// - nothing while the page is hidden, at once when it shows again;
// - while the app's connection banner shows: only every 30 s; read again at once when it goes (the place's own "now");
// - "Try again" reads at once and starts the backoff over; never two reads at the same time; nothing after stop, also
//   when a read was in flight.
import { describe, expect, test } from 'bun:test'
import { AutoRetry, RETRY_DELAYS_MS, RETRY_PAUSED_MS, type RetryClock } from '../../src/lib/autoRetry'
import { isConnectionError } from '../../src/lib/api'
import { ApiError } from '@mycel/shared/api'

/** A clock whose time moves only when asked; timers run in order as it passes them. */
function fakeClock() {
  let now = 1_000_000
  let hidden = false
  let next = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  const clock: RetryClock = {
    setTimeout: (fn, ms) => { const id = next++; timers.set(id, { at: now + ms, fn }); return id },
    clearTimeout: (id) => { timers.delete(id as number) },
    hidden: () => hidden,
  }
  return {
    clock,
    /** the waits still set, from now */
    pending: () => [...timers.values()].map((t) => t.at - now).sort((a, b) => a - b),
    async advance(ms: number) {
      const end = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].fn()
        // the attempt awaits the read: let it settle before the next timer
        await flush()
      }
      now = end
      await flush()
    },
    hide(v: boolean) { hidden = v },
    now: () => now,
  }
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

describe('the backoff', () => {
  test('2, 4, 8, 15 s, then every 30 s while it keeps failing; a read that works stops it', async () => {
    const c = fakeClock()
    const at: number[] = []
    const start = c.now()
    const r = new AutoRetry(async () => { at.push(c.now() - start); throw new TypeError('Failed to fetch') }, c.clock)
    r.start()
    expect(c.pending()).toEqual([2_000])
    await c.advance(2_000 + 4_000 + 8_000 + 15_000 + 30_000 + 30_000)
    expect(at).toEqual([2_000, 6_000, 14_000, 29_000, 59_000, 89_000])
    expect([...RETRY_DELAYS_MS]).toEqual([2_000, 4_000, 8_000, 15_000, 30_000])
    // the read worked: the notice went, which stops it
    r.stop()
    expect(c.pending()).toEqual([])
    await c.advance(120_000)
    expect(at.length).toBe(6)
  })

  test('a read that settles without throwing (the place keeps its error) still counts: the next wait is longer', async () => {
    const c = fakeClock()
    let reads = 0
    const r = new AutoRetry(() => { reads++ }, c.clock)
    r.start()
    await c.advance(2_000)
    expect(reads).toBe(1)
    expect(c.pending()).toEqual([4_000])
  })

  test('never two reads at once: a slow read holds the next one back', async () => {
    const c = fakeClock()
    let open = 0, most = 0
    let release: () => void = () => {}
    const r = new AutoRetry(() => new Promise<void>((resolve) => { open++; most = Math.max(most, open); release = () => { open--; resolve() } }), c.clock)
    r.start()
    await c.advance(2_000)
    expect(open).toBe(1)
    // "Try again" while it reads: nothing more
    r.now(true)
    await flush()
    expect(most).toBe(1)
    expect(c.pending()).toEqual([])
    release()
    await flush()
    expect(c.pending().length).toBe(1)
  })
})

describe('a hidden page', () => {
  test('no read while hidden; at once when it shows again', async () => {
    const c = fakeClock()
    let reads = 0
    const r = new AutoRetry(() => { reads++ }, c.clock)
    r.start()
    c.hide(true)
    r.seen()
    expect(c.pending()).toEqual([])
    await c.advance(10 * 60_000)
    expect(reads).toBe(0)
    c.hide(false)
    r.seen()
    await flush()
    expect(reads).toBe(1)
    expect(c.pending()).toEqual([4_000])
  })

  test('a timer that comes due while the page is hidden does not read', async () => {
    const c = fakeClock()
    let reads = 0
    const r = new AutoRetry(() => { reads++ }, c.clock)
    r.start()
    // hidden without the event (a browser that throttles the tab): the timer finds it hidden
    c.hide(true)
    await c.advance(2_000)
    expect(reads).toBe(0)
    expect(c.pending()).toEqual([])
    c.hide(false)
    r.seen()
    await flush()
    expect(reads).toBe(1)
  })
})

describe('the app\'s connection banner', () => {
  test('while it shows: only every 30 s, and showing the page again waits for it; when it goes, the place reads at once', async () => {
    const c = fakeClock()
    let reads = 0
    const r = new AutoRetry(() => { reads++ }, c.clock)
    r.pause(true)
    r.start()
    expect(c.pending()).toEqual([RETRY_PAUSED_MS])
    expect(RETRY_PAUSED_MS).toBe(30_000)
    // (a proxy that lets reads through but not the live connection: the place still comes back)
    await c.advance(29_000)
    r.seen()
    await flush()
    expect(reads).toBe(0)
    await c.advance(1_000)
    expect(reads).toBe(1)
    expect(c.pending()).toEqual([30_000])
    // the live connection is back (useAutoRetry: pause(false), then now(true))
    r.pause(false)
    r.now(true)
    await flush()
    expect(reads).toBe(2)
    expect(c.pending()).toEqual([4_000])
  })
})

describe('Try again', () => {
  test('reads at once and the backoff starts over', async () => {
    const c = fakeClock()
    let reads = 0
    const r = new AutoRetry(() => { reads++ }, c.clock)
    r.start()
    await c.advance(2_000 + 4_000 + 8_000 + 15_000)
    expect(reads).toBe(4)
    expect(c.pending()).toEqual([30_000])
    r.now(true)
    await flush()
    expect(reads).toBe(5)
    expect(c.pending()).toEqual([4_000])
  })

  test('nothing after stop, also when a read was in flight', async () => {
    const c = fakeClock()
    let reads = 0
    let release: () => void = () => {}
    const r = new AutoRetry(() => new Promise<void>((resolve) => { reads++; release = resolve }), c.clock)
    r.start()
    await c.advance(2_000)
    expect(reads).toBe(1)
    // the read worked: the notice goes (stop) before the read's promise settles
    r.stop()
    release()
    await flush()
    expect(c.pending()).toEqual([])
    await c.advance(120_000)
    expect(reads).toBe(1)
  })

  test('"Try again" while a read is in flight gives that read (one read, the same promise)', async () => {
    const c = fakeClock()
    let reads = 0
    let release: () => void = () => {}
    const r = new AutoRetry(() => new Promise<void>((resolve) => { reads++; release = resolve }), c.clock)
    r.start()
    const first = r.now(true)
    const second = r.now(true)
    expect(reads).toBe(1)
    expect(second).toBe(first)
    release()
    await first
    expect(c.pending()).toEqual([4_000])
  })

  test('nothing once stopped', async () => {
    const c = fakeClock()
    let reads = 0
    const r = new AutoRetry(() => { reads++ }, c.clock)
    r.start()
    r.stop()
    r.now(true)
    r.seen()
    await c.advance(60_000)
    expect(reads).toBe(0)
  })
})

describe('isConnectionError', () => {
  const api = (status: number, code: string, params?: Record<string, string | number>) => new ApiError(status, { code: code as never, message: 'x', ...(params ? { params } : {}) })
  test('no answer at all, the relay or a proxy: yes', () => {
    expect(isConnectionError(new TypeError('Failed to fetch'))).toBe(true)
    expect(isConnectionError(api(502, 'unavailable', { httpStatus: 502 }))).toBe(true)
    expect(isConnectionError(api(503, 'unavailable'))).toBe(true)
    expect(isConnectionError(api(504, 'unavailable', { httpStatus: 504 }))).toBe(true)
  })
  test('the server\'s own answer: no', () => {
    expect(isConnectionError(api(500, 'internal'))).toBe(false)
    expect(isConnectionError(api(403, 'forbidden'))).toBe(false)
    expect(isConnectionError(api(404, 'not_found'))).toBe(false)
    // a reason of the server's own (a quarantined file, the queue draining) is not the connection
    expect(isConnectionError(api(503, 'unavailable', { reason: 'quarantined' }))).toBe(false)
    expect(isConnectionError(new DOMException('aborted', 'AbortError'))).toBe(false)
    expect(isConnectionError(null)).toBe(false)
  })
})
