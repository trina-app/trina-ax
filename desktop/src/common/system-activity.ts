// The computer's own use, for the team page's "in use" (web/src/lib/presence.ts) and so for holding phone pushes while
// the person is at the computer (docs/DECISIONS.md "Phone notifications when I'm away"). A page sees only its own input:
// someone working in Excel with Trina behind it, or in the in-app browser pane, would look away from Trina. The desktop
// app asks the system every SYSTEM_ACTIVITY_EVERY_MS (Electron powerMonitor) and tells the page how long the computer
// has had no input and whether its screen is locked. Pure: unit-tested in tests/unit/e-system-activity.test.ts.

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
