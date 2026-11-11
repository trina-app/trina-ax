// Reading again by itself after the connection failed (components/LoadError.tsx; docs/DECISIONS.md "How we show
// errors"):
// - Backoff: 2, 4, 8 and 15 s, then every 30 s, while the page is visible. Nothing while it is hidden; at once when it
//   shows again or the browser is back online.
// - While the app's connection banner shows (the live connection 'reconnecting' or 'offline', lib/realtime.ts): only
//   every 30 s (the banner's own reconnecting runs meanwhile; a place whose reads would work while the live connection
//   cannot, behind a proxy that blocks it, still comes back); the live connection back is the moment to read again.
// - "Try again" reads at once and starts the backoff over; never two reads at a time.
// - The place keeps its error until a read works, so the notice (and this) stays while it reads: a place that cleared
//   its error at the start of a read would draw the notice again and start the backoff over each time.
import { useEffect, useRef, useState } from 'react'
import { useUi } from '../store/ui'

export const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 15_000, 30_000] as const
/** the wait while the connection banner shows */
export const RETRY_PAUSED_MS = RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]

export interface RetryClock {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
  hidden(): boolean
}

const browserClock: RetryClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
}

export class AutoRetry {
  private timer: unknown = null
  /** attempts made so far */
  private level = 0
  /** the read in flight */
  private current: Promise<void> | null = null
  private paused = false
  private stopped = true

  constructor(private readonly retry: () => unknown, private readonly clock: RetryClock = browserClock) {}

  /** the wait before the next attempt */
  get delay(): number {
    return this.paused ? RETRY_PAUSED_MS : RETRY_DELAYS_MS[Math.min(this.level, RETRY_DELAYS_MS.length - 1)]!
  }

  start() {
    this.stopped = false
    this.schedule()
  }

  /** the read worked (the notice went) or the place went: nothing more */
  stop() {
    this.stopped = true
    this.clear()
  }

  /** the app's connection banner shows: the slow wait until it goes */
  pause(paused: boolean) {
    if (this.paused === paused) return
    this.paused = paused
    this.clear()
    this.schedule()
  }

  /** Read again now; the read in flight when there is one. `fresh` ("Try again"): the backoff starts over after it. */
  now(fresh = false): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.current) return this.current
    if (fresh) this.level = 0
    this.clear()
    return this.attempt()
  }

  /** The page was hidden or shows again (visibilitychange), or the browser is back online: hidden, the timer waits;
   * shown, at once (unless the banner shows: its connection coming back comes first). */
  seen() {
    if (this.clock.hidden()) return this.clear()
    if (!this.paused) void this.now()
    else this.schedule()
  }

  private clear() {
    if (this.timer === null) return
    this.clock.clearTimeout(this.timer)
    this.timer = null
  }

  private schedule() {
    if (this.stopped || this.current || this.timer !== null || this.clock.hidden()) return
    this.timer = this.clock.setTimeout(() => {
      this.timer = null
      // hidden meanwhile: it waits for the page to show again
      if (!this.clock.hidden()) void this.attempt()
    }, this.delay)
  }

  private attempt(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.current) return this.current
    this.level++
    const run = (async () => {
      try {
        await this.retry()
      } catch {
        /* the place shows what came of it */
      }
      this.current = null
      // still running: it failed again (a read that worked takes the notice away, which stops this)
      this.schedule()
    })()
    this.current = run
    return run
  }
}

/** While `active` (a connection failure on screen), reads again by itself as above. `tryNow`: "Try again"; `busy`: a
 * read it started is in flight. */
export function useAutoRetry(active: boolean, retry: () => unknown) {
  const banner = useUi((s) => s.conn === 'reconnecting' || s.conn === 'offline')
  const retryRef = useRef(retry)
  retryRef.current = retry
  const bannerRef = useRef(banner)
  const runner = useRef<AutoRetry | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!active) return
    const r = new AutoRetry(() => retryRef.current())
    runner.current = r
    r.pause(bannerRef.current)
    r.start()
    const seen = () => r.seen()
    document.addEventListener('visibilitychange', seen)
    window.addEventListener('online', seen)
    return () => {
      r.stop()
      runner.current = null
      document.removeEventListener('visibilitychange', seen)
      window.removeEventListener('online', seen)
    }
  }, [active])
  useEffect(() => {
    const was = bannerRef.current
    bannerRef.current = banner
    const r = runner.current
    if (!r || was === banner) return
    r.pause(banner)
    // the live connection is back: read now, the backoff from the start
    if (!banner) void r.now(true)
  }, [banner])
  const tryNow = () => {
    const r = runner.current
    if (!r) return
    setBusy(true)
    void r.now(true).finally(() => { if (runner.current === r) setBusy(false) })
  }
  return { tryNow, busy }
}
