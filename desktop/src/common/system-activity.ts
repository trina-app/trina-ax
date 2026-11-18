// The computer's own use, for the team page's "in use" (web/src/lib/presence.ts) and so for holding phone pushes while
// the person is at the computer (docs/DECISIONS.md "Phone notifications when I'm away", docs/decisions/20261116-away-os-idle.md). A page sees only its own input:
// someone working in Excel with Trina behind it, or in the in-app browser pane, would look away from Trina. The desktop
// app asks the system every SYSTEM_ACTIVITY_EVERY_MS (Electron powerMonitor) and tells the page how long the computer
// has had no input and whether its screen is locked, and tells the open team's server the same (ComputerReporter): the
// page of a window in the back is throttled and may say nothing for minutes. A locked screen is away
// (docs/decisions/20261116-away-os-idle.md). Pure: unit-tested in tests/unit/e-system-activity.test.ts.

export const SYSTEM_ACTIVITY_EVERY_MS = 30_000
/** the idle threshold asked of the system (seconds): the page's own 10 minutes (web/src/lib/presence.ts IDLE_AFTER_MS) */
export const SYSTEM_IDLE_THRESHOLD_S = 600

export interface SystemActivity {
  /** the screen is locked */
  locked: boolean
  /** how long the computer has had no input (ms) */
  idleMs: number
}

export interface PowerMonitorLike {
  getSystemIdleState(idleThreshold: number): 'active' | 'idle' | 'locked' | 'unknown'
  getSystemIdleTime(): number
}

/** What the system says now; null when it cannot tell (some Linux desktops answer 'unknown'): the page then counts
 * only its own input, as a browser tab does. */
export function readSystemActivity(pm: PowerMonitorLike): SystemActivity | null {
  let state: ReturnType<PowerMonitorLike['getSystemIdleState']>
  let idle: number
  try {
    state = pm.getSystemIdleState(SYSTEM_IDLE_THRESHOLD_S)
    idle = pm.getSystemIdleTime()
  } catch { return null }
  if (state === 'unknown' || !Number.isFinite(idle) || idle < 0) return null
  return { locked: state === 'locked', idleMs: Math.round(idle * 1000) }
}

/** where the app reports the computer to the open team (shared/src/api/people.ts reportMyComputer) */
export const COMPUTER_REPORT_PATH = '/api/me/computer'
/** a server that had no call (404/405) or refused it (403) is asked again after this long: a team server updates itself
 * (at night, by itself) under an app that stays open for days, and the page reload after that update opens no team, so
 * "not until a team is opened" left the phone ringing until the app was restarted (QA TC-4834) */
export const UNSUPPORTED_RETRY_MS = 5 * 60_000

export interface ComputerReporterOptions {
  /** the open team's address and whether this app is signed in to it now; null: no team open */
  team(): { origin: string; signedIn: boolean } | null
  /** POST the body to the origin with the team page's own session; the answer's status (throws when unreachable). It
   * must pick the session synchronously (farewell posts while the team view is closing). */
  post(origin: string, body: SystemActivity): Promise<number>
  /** the server said this app is not signed in (401): the app checks its session again */
  signedOut?(): void
  /** the clock (ms; tests) */
  now?(): number
}

/** what "not in use" is told as when the app leaves a team (another team opened, the window closed): idle at the threshold */
const LEAVING: SystemActivity = { locked: false, idleMs: SYSTEM_IDLE_THRESHOLD_S * 1000 }

/**
 * The computer's own use told to the open team's server by the app's main process (docs/decisions/20261116-away-os-idle.md).
 * The team page tells it too (web/src/lib/presence.ts), but a Trina window in the back is throttled by the browser
 * engine and may say nothing for minutes, so the server would take the person as away and ring their phone while they
 * work in another app. The main process is not throttled. Sent only to the open team, only while signed in to it.
 * An older server without the call (404/405) or one that refuses it (403) is not asked again until a team is opened or
 * UNSUPPORTED_RETRY_MS has passed (the server may have updated itself meanwhile); a 401 makes the app check its
 * session. One request at a time: a word that comes meanwhile (a lock during a tick) is kept, the newest only, and sent
 * right after. A failed request is not retried (the next tick comes in 30 s).
 */
export class ComputerReporter {
  /** origin -> when (clock ms) to ask a server that had no call, or refused it, again */
  private unsupported = new Map<string, number>()
  private busy = false
  private pending: SystemActivity | null = null

  constructor(private o: ComputerReporterOptions) {}

  private now() { return this.o.now?.() ?? Date.now() }

  /** no asking this origin now: it had no call, or refused it, less than UNSUPPORTED_RETRY_MS ago */
  private skip(origin: string) {
    const until = this.unsupported.get(origin)
    if (until === undefined) return false
    if (this.now() < until) return true
    this.unsupported.delete(origin)
    return false
  }

  /** a team was opened (again): ask an origin that had no call again (the server may have been updated) */
  reset(): void { this.unsupported.clear() }

  async report(a: SystemActivity | null): Promise<void> {
    if (!a) return
    if (this.busy) { this.pending = a; return }
    this.busy = true
    try {
      for (let next: SystemActivity | null = a; next; next = this.pending, this.pending = null) await this.send(next)
    } finally { this.busy = false }
  }

  /** The app leaves the team (another team, the window closing): tell it at once that this computer is no longer at
   * it, instead of the last "in use" counting for up to a minute. Fire and forget. */
  farewell(): void {
    this.pending = null
    const team = this.o.team()
    if (!team || !team.signedIn || !team.origin || this.skip(team.origin)) return
    try { void this.o.post(team.origin, LEAVING).catch(() => {}) } catch { /* closing anyway */ }
  }

  private async send(a: SystemActivity) {
    const team = this.o.team()
    if (!team || !team.signedIn || !team.origin || this.skip(team.origin)) return
    try {
      const status = await this.o.post(team.origin, { locked: a.locked, idleMs: Math.max(0, Math.round(a.idleMs)) })
      if (status === 404 || status === 405 || status === 403) this.unsupported.set(team.origin, this.now() + UNSUPPORTED_RETRY_MS)
      else if (status === 401) this.o.signedOut?.()
    } catch { /* offline or the server restarting: the next tick */ }
  }
}
