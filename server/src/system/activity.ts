// When this server was last in use, for the hosted service's sleep policy (F2: an idle hosted team's server is stopped,
// a free team's VM suspended to disk or a trial team's EC2 instance stopped, and started on the next request). One
// clock per server process; it starts at the process start.
//   in use: a signed-in API request (session middleware; every chunk of an upload is one), an open realtime connection,
//   a running or queued answer, a queued or running background job (transcribe, backup, export, update, restore), a
//   dev environment job that waits or runs, or a backup in progress (the nightly one has no jobs row)
//   (Ops.statusFile, every 30 s). Requests that no one signed in to make (health checks, probes) do not count.
//   due work: the next enabled schedule and the next push retry (every push delivery queue); the control plane wakes
//   the server before it.
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

/** Every push delivery queue with a retry time (next_at) and an end (expires_at): inbox notices, room messages, owner
 *  handover and finished AI answers. A due retry keeps the team awake; a missing table is a failed read (due now). */
export const PUSH_RETRY_TABLES = ['push_deliveries', 'room_push_deliveries', 'handover_push_deliveries', 'chat_answer_push_deliveries'] as const

/** The earliest due time of an enabled schedule (a pending occurrence or its retry first) or of a push retry that has
 *  not expired, or null. A failed read is "due now" (never sleep on facts we could not read). */
export function nextScheduleDue(db: Database, now: number = Date.now()): number | null {
  try {
    const r = db.query(`SELECT MIN(COALESCE(retry_at, pending_due_at, next_run_at)) AS due FROM schedules
                        WHERE enabled = 1 AND COALESCE(retry_at, pending_due_at, next_run_at) IS NOT NULL`).get() as { due: string | null } | null
    const iso = new Date(now).toISOString()
    const pushes = PUSH_RETRY_TABLES.map((t) => (db.query(`SELECT MIN(next_at) AS due FROM ${t} WHERE state IN ('pending','sending') AND expires_at > ?`).get(iso) as { due: string | null } | null)?.due)
    const ts = [r?.due, ...pushes].map((d) => (d ? Date.parse(d) : NaN)).filter((t) => Number.isFinite(t))
    return ts.length ? Math.min(...ts) : null
  } catch { return now }
}

/** Background jobs that are queued or running, and dev environment jobs (box_shell with job: true) that wait or run.
 *  A dev environment server (a preview) does not count: one left running would keep the team awake for ever. A
 *  failed read counts as one. */
export function busyJobs(db: Database): number {
  try {
    const jobs = (db.query(`SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')`).get() as { n: number }).n
    const dev = (db.query(`SELECT COUNT(*) AS n FROM dev_env_runs WHERE kind = 'job' AND state IN ('waiting','running')`).get() as { n: number }).n
    return jobs + dev
  } catch { return 1 }
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
