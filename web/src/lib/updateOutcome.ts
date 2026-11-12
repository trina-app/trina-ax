// What an update job really did (QA TC-336). The job is "done" once the server has switched app/current and asked for
// its restart; then the bootstrap starts that version, or sends app/current back (a Go back to a version that cannot
// read the database exits 75 and bounces back within seconds). So "finished" is said only once /api/health answers
// with the version the job named. When the server comes back on the version it started from, the job is read again:
// the server marks such a job failed with what happened (server/src/system/update-job.ts settleUpdateJob).
import type { Health, Job, UpdateStatus } from '@mycel/shared/api'

/** Admin › System offers Go back only to a kept version that can open the database as it is now: one that cannot only
 * exits 75 and the server comes back (QA TC-336). The hosted cloud has no Go back. */
export const goBackOffered = (u: Pick<UpdateStatus, 'previous' | 'managed' | 'previousNeedsRestore'>): boolean => !!u.previous && !u.managed && !u.previousNeedsRestore

export type UpdateOutcome =
  | { kind: 'ok' }
  /** the version did not stay; message: the server's words (null: none, say it in the client's) */
  | { kind: 'not_kept'; version: string; current: string; message: string | null }
  /** no answer either way within the wait */
  | { kind: 'restarting' }

export const UPDATE_SETTLE_MS = 4 * 60_000

export async function updateOutcome(job: Job, o: {
  health: () => Promise<Health>
  fetchJob: (id: string) => Promise<Job>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  waitMs?: number
  pollMs?: number
}): Promise<UpdateOutcome> {
  const r = job.result as { fromVersion?: unknown; toVersion?: unknown } | null
  if (!r || typeof r.toVersion !== 'string' || typeof r.fromVersion !== 'string') return { kind: 'ok' }
  const to = r.toVersion, from = r.fromVersion
  const now = o.now ?? Date.now
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)))
  const doneAt = now()
  const until = doneAt + (o.waitMs ?? UPDATE_SETTLE_MS)
  let wentAway = false
  while (now() < until) {
    let h: Health | null = null
    try { h = await o.health() } catch { wentAway = true }
    if (h?.version === to) return { kind: 'ok' }
    // back on the version it started from after a restart: its uptime is shorter than the time since the job was done
    // (signed in, /api/health gives it; a missed answer before the restart is then no restart), else it did not answer
    // for a while in between
    const restarted = h?.version === from && (h.uptimeSec !== undefined ? h.uptimeSec * 1000 < now() - doneAt : wentAway)
    if (restarted) {
      let message: string | null = null
      try {
        const j = await o.fetchJob(job.id)
        if (j.status === 'failed') message = j.error?.message ?? null
      } catch { /* the client's words */ }
      return { kind: 'not_kept', version: to, current: from, message }
    }
    await sleep(o.pollMs ?? 2000)
  }
  return { kind: 'restarting' }
}
