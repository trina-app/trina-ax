// How an answer that a dev environment job was a step of ended, for the person who asked (devenv/jobs.ts
// tellHeldJobs, notifications/service.ts devEnvRunOut). Its own module: the notifications read it, and jobs.ts imports
// the notifications.
import type { Database } from 'bun:sqlite'

/** The source of the Activity row of a request (dev_env_notices, event 'dev_env.job'): this + the answer's turn id. A
 * job's own row has the job's id (dev_env_runs ids are uuid7s, never this prefix). */
export const REQUEST_SOURCE = 'turn-'

/** Why a request stopped, as the person reads it: a limit of the answer (steps or time), an error, someone stopped it,
 * the server restarted, or Trina waits for an answer from the person (a question card). */
export type RequestStop = 'limit' | 'error' | 'stopped' | 'restart' | 'question'
export type RequestOutcome = { outcome: 'done' } | { outcome: 'stopped'; reason: RequestStop }

/** How an ended answer ended for the person who asked. */
export function requestOutcome(db: Database, turnId: string): RequestOutcome | null {
  const t = db.query('SELECT user_id, status, stop_reason FROM turns WHERE id = ?').get(turnId) as { user_id: string; status: string; stop_reason: string | null } | null
  if (!t || t.status === 'queued' || t.status === 'running') return null
  if (t.status === 'error') return { outcome: 'stopped', reason: 'error' }
  if (t.status === 'stopped') return { outcome: 'stopped', reason: 'stopped' }
  if (t.status === 'interrupted') return { outcome: 'stopped', reason: 'restart' }
  if (t.stop_reason) return { outcome: 'stopped', reason: 'limit' }
  // ended on a question to the person (chat/open-questions.ts): the request waits for them
  if (db.query('SELECT 1 FROM open_questions WHERE turn_id = ? AND user_id = ? AND answer IS NULL LIMIT 1').get(turnId, t.user_id)) return { outcome: 'stopped', reason: 'question' }
  return { outcome: 'done' }
}
