// The phone app's failure screen ("You are offline" / "Could not reach your team") tries again by itself (QA TC-2265):
// it asks the team (GET /api/health) after 2 s, 4 s, 8 s and then every 15 s, at once when the app comes back to the
// foreground, and not while the app is in the background. When the team answers, the page that failed loads again (the
// chat a tapped push was opening). Try again stays for the impatient. The app has no network-change listener (no netinfo
// or expo-network in its dependencies), so the 15 s cap is the longest wait after the network is back.
// The backoff is kept across failures and only starts over after a page loaded: a team that answers its health check but
// fails the page (a 500, a crashed web process) is not reloaded every 2 s. No native imports: tests load this file.

export const RECONNECT_DELAYS = [2_000, 4_000, 8_000, 15_000] as const

export type Timers = {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
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

  /** `probe`: true when the team answered (the page can load again); `back`: load it. */
  constructor(private readonly probe: () => Promise<boolean>, private readonly back: () => void, private readonly timers: Timers = realTimers) {}

  /** The failure screen is up: the next probe after the backoff's next step. */
  start() {
    if (this.running) return
    this.running = true
    this.schedule()
  }

  /** The screen went away (the page loads again: Try again, a tapped push, the team answered). */
  stop() {
    this.running = false
    this.round++
    this.cancel()
  }

  /** A page of the team loaded: the next failure starts the backoff from its first step again. */
  reset() { this.attempts = 0 }

  /** The app went to the background: no probes there (iOS suspends it anyway; Android would keep the radio busy). */
  pause() {
    this.paused = true
    this.cancel()
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
    const round = this.round
    let answered = false
    try { answered = await this.probe() } catch { answered = false }
    this.probing = false
    if (round !== this.round || !this.running) return
    if (answered) { this.stop(); this.back(); return }
    this.schedule()
  }
}
