// Reading again by itself after the connection failed (components/LoadError.tsx; docs/DECISIONS.md "How we show
// errors"):
// - Backoff: 2, 4, 8 and 15 s, then every 30 s, while the page is visible. Nothing while it is hidden; at once when it
//   shows again or the browser is back online.
// - While the app's connection banner shows (the live connection 'reconnecting' or 'offline', lib/realtime.ts): no
//   timer, the banner's own reconnecting is the one that runs; the live connection back is the moment to read again.
// - "Try again" reads at once and starts the backoff over.
// - A place that clears its error while it reads again draws its notice again after each failed attempt: with a `key`
//   its level is kept for a minute after its last attempt, so the backoff goes on instead of starting at 2 s again.
import { useEffect, useRef } from 'react'
import { useUi } from '../store/ui'

export const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 15_000, 30_000] as const
/** how long a key's level is kept after its last attempt */
export const RETRY_MEMORY_MS = 60_000

export interface RetryClock {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
  now(): number
  hidden(): boolean
}

const browserClock: RetryClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
  hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
}

const levels = new Map<string, { level: number; at: number }>()
/** Tests: every key starts at the first delay again. */
export const forgetRetryLevels = () => levels.clear()

export class AutoRetry {
  private timer: unknown = null
  /** attempts made so far (with a key: also those of the notice drawn before this one) */
  private level = 0
  private inFlight = false
  private paused = false
  private stopped = true

  constructor(private readonly retry: () => unknown, private readonly key: string | null = null, private readonly clock: RetryClock = browserClock) {
    const kept = key ? levels.get(key) : undefined
    if (kept && clock.now() - kept.at < RETRY_MEMORY_MS) this.level = kept.level
  }

  /** the wait before the next attempt */
  get delay(): number {
    return RETRY_DELAYS_MS[Math.min(this.level, RETRY_DELAYS_MS.length - 1)]!
  }

  /** whether an attempt is waiting for its time */
  get waiting(): boolean {
    return this.timer !== null
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

  /** the app's connection banner shows: no timer until it goes */
  pause(paused: boolean) {
    this.paused = paused
    if (paused) this.clear()
    else this.schedule()
  }

  /** Read again now. `fresh` ("Try again"): the backoff starts over after it. */
  now(fresh = false) {
    if (this.stopped) return
    if (fresh) this.level = 0
    this.clear()
    void this.attempt()
  }

  /** The page was hidden or shows again (visibilitychange), or the browser is back online: hidden, the timer waits;
   * shown, at once (unless the banner shows: its connection coming back comes first). */
  seen() {
    if (this.clock.hidden()) return this.clear()
    if (!this.paused) this.now()
  }

  private clear() {
    if (this.timer === null) return
    this.clock.clearTimeout(this.timer)
    this.timer = null
  }

  private schedule() {
    if (this.stopped || this.paused || this.inFlight || this.timer !== null || this.clock.hidden()) return
    this.timer = this.clock.setTimeout(() => {
      this.timer = null
      // hidden meanwhile: it waits for the page to show again
      if (!this.clock.hidden()) void this.attempt()
    }, this.delay)
  }

  private async attempt() {
    if (this.stopped || this.inFlight) return
    this.inFlight = true
    this.level++
    if (this.key) levels.set(this.key, { level: this.level, at: this.clock.now() })
    try {
      await this.retry()
    } catch {
      /* the place shows what came of it */
    }
    this.inFlight = false
    // still running: it failed again (a read that worked takes the notice away, which stops this)
    this.schedule()
  }
}

/** While `active` (a connection failure on screen), reads again by itself as above. `tryNow`: "Try again". */
export function useAutoRetry(active: boolean, retry: () => unknown, key?: string) {
  const banner = useUi((s) => s.conn === 'reconnecting' || s.conn === 'offline')
  const retryRef = useRef(retry)
  retryRef.current = retry
  const bannerRef = useRef(banner)
  const runner = useRef<AutoRetry | null>(null)
  useEffect(() => {
    if (!active) return
    const r = new AutoRetry(() => retryRef.current(), key ?? null)
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
  }, [active, key])
  useEffect(() => {
    const was = bannerRef.current
    bannerRef.current = banner
    const r = runner.current
    if (!r || was === banner) return
    r.pause(banner)
    // the live connection is back: read now, the backoff from the start
    if (!banner) r.now(true)
  }, [banner])
  return { tryNow: () => runner.current?.now(true) }
}
