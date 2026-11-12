// What the office server's /api/health on 127.0.0.1 says, for the updater (update.ts) and `office.js install` /
// `teamax status` (cli.ts). Besides "answers with version X" and "no answer" there is a third answer since QA TC-278: a
// new version that must update a large database first (a copy, then the migrations: minutes on several GB) listens with
// a stand-in meanwhile and answers 503 {status: "migrating", version, migrating: {pending, copiedBytes, dbBytes}}
// (server/src/system/migrate-start.ts). The waits keep going while it says so with the version they wait for, bounded by
// MIGRATE_WAIT_MS: the same limit as a Linux server's bootstrap (native/cmd/mycel-bootstrap --migrate-timeout default).
import { MIGRATING_STATUS } from '../system/migrate-start'

/** the server is updating its database before it starts: its version and its own progress report (for the log) */
export interface Migrating { migrating: string; progress: string }
/** a version that answers, a version that is updating its database, or null (no answer) */
export type HealthAnswer = string | Migrating | null

/** how long after the switch a version that reports "migrating" may take (native/cmd/mycel-bootstrap --migrate-timeout) */
export const MIGRATE_WAIT_MS = 60 * 60_000

export const isMigrating = (h: HealthAnswer | undefined): h is Migrating => typeof h === 'object' && h !== null && typeof h.migrating === 'string'

/** read one /api/health answer (status + JSON body) */
export function healthAnswer(status: number, body: unknown): HealthAnswer {
  const j = (body && typeof body === 'object' ? body : {}) as { ok?: unknown; version?: unknown; status?: unknown; migrating?: { pending?: unknown; copiedBytes?: unknown; dbBytes?: unknown } }
  if (typeof j.version !== 'string') return null
  if (status === 200) return j.version
  if (status === 503 && j.status === MIGRATING_STATUS) {
    const m = j.migrating
    const mb = (n: unknown) => (typeof n === 'number' ? Math.floor(n / 2 ** 20) : 0)
    // copiedBytes is the copy in progress; the server removes its staging folder when the copy is done, so 0 is "not
    // started or done" and the MB figure is shown only while it grows
    const copied = m && typeof m.copiedBytes === 'number' && m.copiedBytes > 0 ? `, copy before migrating ${mb(m.copiedBytes)} of ${mb(m.dbBytes)} MB` : ''
    const progress = m && typeof m.pending === 'number' ? `${m.pending} migrations pending${copied}` : ''
    return { migrating: j.version, progress }
  }
  return null
}

/** GET http://127.0.0.1:<port>/api/health */
export async function probeHealth(port: number, timeoutMs = 2000): Promise<HealthAnswer> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) })
    return healthAnswer(r.status, await r.json().catch(() => null))
  } catch { return null }
}
