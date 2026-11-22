// How an answer that a dev environment job was a step of ended, for the person who asked (devenv/jobs.ts
// tellHeldJobs, notifications/service.ts devEnvRunOut). Its own module: the notifications read it, and jobs.ts imports
// the notifications.
import type { Database } from 'bun:sqlite'
import { turnQuestionOpen } from '../chat/open-questions'

/** The source of the Activity row of a request (dev_env_notices, event 'dev_env.job'): this + the answer's turn id + ':'
 * + how it ended ('done' or a RequestStop), kept as it was at the answer's end (a question answered later, or a turn
 * put back in the queue, does not change what was told). A job's own row has the job's id (dev_env_runs ids are
 * uuid7s, never this prefix). */
export const REQUEST_SOURCE = 'turn-'
export const requestSourcePrefix = (turnId: string) => `${REQUEST_SOURCE}${turnId}:`
export const requestSource = (turnId: string, o: RequestOutcome) => requestSourcePrefix(turnId) + (o.outcome === 'done' ? 'done' : o.reason)
const STOPS: readonly RequestStop[] = ['limit', 'error', 'stopped', 'restart', 'question']
export function parseRequestSource(source: string): { turnId: string; outcome: RequestOutcome } | null {
  if (!source.startsWith(REQUEST_SOURCE)) return null
  const i = source.lastIndexOf(':')
  if (i <= REQUEST_SOURCE.length) return null
  const turnId = source.slice(REQUEST_SOURCE.length, i), o = source.slice(i + 1)
  if (o === 'done') return { turnId, outcome: { outcome: 'done' } }
  return (STOPS as readonly string[]).includes(o) ? { turnId, outcome: { outcome: 'stopped', reason: o as RequestStop } } : null
}

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
  if (turnQuestionOpen(db, turnId, t.user_id)) return { outcome: 'stopped', reason: 'question' }
  return { outcome: 'done' }
}
