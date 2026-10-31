// When this server was last in use, for the hosted service's sleep policy (F2: an idle free team's VM is suspended to
// disk and woken on the next request). One clock per server process; it starts at the process start.
//   in use: a signed-in API request (session middleware; every chunk of an upload is one), an open realtime connection,
//   a running or queued answer, or a queued or running background job (transcribe, backup, export, update, restore)
//   (Ops.statusFile, every 30 s). Requests that no one signed in to make (health checks, probes) do not count.
//   due work: the next enabled schedule and the next push retry; the control plane wakes the VM before it.
// status/status.json carries the result as `activity` (durations, not times: the guest clock can be behind after a
// resume); admin.js cloud-idle reads it for mycel-ctl idle-wait --activity.
import type { Database } from 'bun:sqlite'
import { SLEEP_SCHEDULE_GUARD_SEC } from '@mycel/shared/cloud-protocol'

let lastActiveAt = Date.now()

/** Record use now. */
export function touchActivity(now: number = Date.now()): void {
  if (now > lastActiveAt) lastActiveAt = now
}

/** Tests: set the clock. */
export function setLastActivity(at: number): void { lastActiveAt = at }

export function lastActivity(): number { return lastActiveAt }

export interface ActivityFacts {
  /** open realtime connections (web, desktop and mobile apps) */
  connections: number
  /** seconds since the last use */
  idleForSec: number
  /** seconds until the next enabled schedule is due (0 = due now), null = none */
  nextScheduleInSec: number | null
}

/** The earliest due time of an enabled schedule (a pending occurrence or its retry first) or of a push retry that has
 *  not expired, or null. A failed read is "due now" (never sleep on facts we could not read). */
export function nextScheduleDue(db: Database, now: number = Date.now()): number | null {
  try {
    const r = db.query(`SELECT MIN(COALESCE(retry_at, pending_due_at, next_run_at)) AS due FROM schedules
                        WHERE enabled = 1 AND COALESCE(retry_at, pending_due_at, next_run_at) IS NOT NULL`).get() as { due: string | null } | null
    const p = db.query(`SELECT MIN(next_at) AS due FROM push_deliveries WHERE state IN ('pending','sending') AND expires_at > ?`).get(new Date(now).toISOString()) as { due: string | null } | null
    const ts = [r?.due, p?.due].map((d) => (d ? Date.parse(d) : NaN)).filter((t) => Number.isFinite(t))
    return ts.length ? Math.min(...ts) : null
  } catch { return now }
}

/** Background jobs that are queued or running (a failed read counts as one). */
export function busyJobs(db: Database): number {
  try { return (db.query(`SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')`).get() as { n: number }).n } catch { return 1 }
}

/** The facts for status.json. Connections, running or queued answers and background jobs count as use now. */
export function activityFacts(o: { db: Database; connections: number; busy: boolean; now?: number }): ActivityFacts {
  const now = o.now ?? Date.now()
  if (o.connections > 0 || o.busy || busyJobs(o.db) > 0) touchActivity(now)
  const due = nextScheduleDue(o.db, now)
  return {
    connections: o.connections,
    idleForSec: Math.max(0, Math.floor((now - lastActiveAt) / 1000)),
    nextScheduleInSec: due === null ? null : Math.max(0, Math.floor((due - now) / 1000)),
  }
}

/** Is the team sleepable by these facts (no answer, no connection, no schedule due within the guard)? */
export function sleepableBy(f: ActivityFacts, running: number, queued: number): boolean {
  return running === 0 && queued === 0 && f.connections === 0 && (f.nextScheduleInSec === null || f.nextScheduleInSec > SLEEP_SCHEDULE_GUARD_SEC)
}
