// The phone app's failure screen ("You are offline" / "Could not reach your team") tries again by itself (QA TC-2265):
// it asks the team (GET /api/health) after 2 s, 4 s, 8 s and then every 15 s, at once when the app comes back to the
// foreground, and not while the app is in the background. When the team answers, the page that failed loads again (the
// chat a tapped push was opening). Try again stays for the impatient. The app has no network-change listener (no netinfo
// or expo-network in its dependencies), so the 15 s cap is the longest wait after the network is back.
// The backoff is kept across failures and only starts over after a page loaded: a team that answers its health check but
// fails the page (a 500, a crashed web process) is not reloaded every 2 s. No native imports: tests load this file.
// A sleeping hosted team (QA TC-1952): the team page answers 503 (the relay's "Resuming your team…" page). The app then
// checks at once (now), and the check wakes the team and waits for it (src/team-check.ts); the screen shows the
// waking note meanwhile, not "Could not reach your team".
import type { TeamCheck } from './team-check'

export const RECONNECT_DELAYS = [2_000, 4_000, 8_000, 15_000] as const

export type Timers = {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}
/**
 * What the team page's HTTP error means (WebView onHttpError gives the status only, not the relay's x-relay-error).
 * 'check': a 503 may be a sleeping team (team_waking, team_offline_cloud), Trina updating or a team offline: ask the
 * team at once (its check tells them apart and wakes a sleeping team). 'unreachable': any other 5xx (a 502 from a dead
 * server). null: not a failure (4xx pages are the team's or the relay's own answer).
 */
export function httpFailure(status: number): 'check' | 'unreachable' | null {
  if (status === 503) return 'check'
  return status >= 500 ? 'unreachable' : null
}

/**
 * What a check of the team means for the failure screen. 'load': load the page again (the team answered, or the
 * relay's own page explains: unknown, suspended, not a team, a wake that took too long). 'updating': Trina is
 * updating (the screen says so and keeps trying). 'wait': keep trying (unreachable, or the check was cancelled).
 */
export function probeAnswer(c: TeamCheck): 'load' | 'updating' | 'wait' {
  if (c.ok) return 'load'
  if (c.reason === 'cancelled') return 'wait'
  if (c.reason === 'unreachable') return c.updating ? 'updating' : 'wait'
  return 'load'
}

const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) }

export class Reconnect {
  private attempts = 0
  private timer: unknown = null
  private running = false
  private paused = false
  private probing = false
  /** Bumped by stop(): a probe that was on its way when the screen went away answers no one. */
  private round = 0
  /** The probe on its way: stop() and pause() abort it (a wake of a sleeping team waits up to 3 minutes). */
  private abort: AbortController | null = null
  /** now() came while a probe was on its way (one that was being stopped): the next probe starts right after it. */
  private soon = false

  /** `probe`: true when the team answered (the page can load again), with a signal that says when to give up; `back`:
   * load it. */
  constructor(private readonly probe: (signal: AbortSignal) => Promise<boolean>, private readonly back: () => void, private readonly timers: Timers = realTimers) {}

  /** The failure screen is up: the next probe after the backoff's next step. */
  start() {
    if (this.running) return
    this.running = true
    this.schedule()
  }

  /** The screen went away (the page loads again: Try again, a tapped push, the team answered). */
  stop() {
    this.running = false
    this.soon = false
    this.round++
    this.cancel()
    this.abort?.abort()
  }

  /** A page of the team loaded: the next failure starts the backoff from its first step again. */
  reset() { this.attempts = 0 }

  /** The app went to the background: no probes there (iOS suspends it anyway; Android would keep the radio busy). */
  pause() {
    this.paused = true
    this.cancel()
    this.abort?.abort()
  }

  /** Ask at once (the team page answered 503: it may be a sleeping team, so the check that wakes it starts now). The
   * backoff goes on after it. Not in the background. */
  now() {
    if (!this.running || this.paused) return
    if (this.probing) { this.soon = true; return }
    this.cancel()
    void this.run()
  }

  /** The app came back to the foreground: ask at once, then the backoff from its first step. */
  wake() {
    this.paused = false
    if (!this.running) return
    this.cancel()
    this.attempts = 0
    void this.run()
  }

  /** Whether a probe is waiting (tests). */
  get waiting() { return this.timer !== null }

  private cancel() {
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = null
  }

  private schedule() {
    if (!this.running || this.paused || this.timer !== null || this.probing) return
    const delay = RECONNECT_DELAYS[Math.min(this.attempts, RECONNECT_DELAYS.length - 1)]
    this.attempts++
    this.timer = this.timers.set(() => { this.timer = null; void this.run() }, delay)
  }

  private async run() {
    if (!this.running || this.paused || this.probing) return
    this.probing = true
    const round = this.round, abort = new AbortController()
    this.abort = abort
    let answered = false
    try { answered = await this.probe(abort.signal) } catch { answered = false }
    this.probing = false
    if (this.abort === abort) this.abort = null
    if (round !== this.round || !this.running || abort.signal.aborted) { this.next(); return }
    if (answered) { this.stop(); this.back(); return }
    this.next()
  }

  /** After a probe: at once when now() asked meanwhile, else the backoff's next step. (A probe of a screen that went
   * away and came back meanwhile also gets here: the new screen's probes go on.) */
  private next() {
    if (this.soon && this.running && !this.paused) { this.soon = false; this.cancel(); void this.run(); return }
    this.schedule()
  }
}
