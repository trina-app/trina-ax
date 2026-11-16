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

export interface ComputerReporterOptions {
  /** the open team's address and whether this app is signed in to it now; null: no team open */
  team(): { origin: string; signedIn: boolean } | null
  /** POST the body to the origin with the team page's own session; the answer's status (throws when unreachable) */
  post(origin: string, body: SystemActivity): Promise<number>
  /** the server said this app is not signed in (401/403): the app checks its session again */
  signedOut?(): void
}

/**
 * The computer's own use told to the open team's server by the app's main process (docs/decisions/20261116-away-os-idle.md).
 * The team page tells it too (web/src/lib/presence.ts), but a Trina window in the back is throttled by the browser
 * engine and may say nothing for minutes, so the server would take the person as away and ring their phone while they
 * work in another app. The main process is not throttled. Sent only to the open team, only while signed in to it;
 * an older server without the call (404/405) is not asked again until a team is opened. One request at a time; a
 * failed one is not retried (the next tick comes in 30 s).
 */
export class ComputerReporter {
  private unsupported = new Set<string>()
  private busy = false

  constructor(private o: ComputerReporterOptions) {}

  /** a team was opened (again): ask an origin that had no call again (the server may have been updated) */
  reset(): void { this.unsupported.clear() }

  async report(a: SystemActivity | null): Promise<void> {
    if (!a || this.busy) return
    const team = this.o.team()
    if (!team || !team.signedIn || !team.origin || this.unsupported.has(team.origin)) return
    this.busy = true
    try {
      const status = await this.o.post(team.origin, { locked: a.locked, idleMs: Math.max(0, Math.round(a.idleMs)) })
      if (status === 404 || status === 405) this.unsupported.add(team.origin)
      else if (status === 401 || status === 403) this.o.signedOut?.()
    } catch { /* offline or the server restarting: the next tick */ } finally { this.busy = false }
  }
}
