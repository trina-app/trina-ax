// Opt-in error reports of the team server (docs/decisions/20261119-hosted-error-reports.md). Off unless the operator
// sets MYCEL_ERROR_REPORT_URL to a Sentry key (DSN) of their own project; nothing in this repository names one, so a
// self-installed server (an office Mac, Docker, Linux) sends nothing. The hosting service sets it on the team servers
// it runs, from its private setup.
//
// What can leave is an allow-list, not a filter: shared/src/sentry-report.ts buildEvent names every field of an event
// (error type, scrubbed message, code frames, release, environment, tags), and the tags below are built here from fixed
// codes only (turnReport). Message text, prompts, AI answers, file names and contents, emails and names are never read
// into a report. tests/unit/hosted-error-reports.test.ts plants them and checks no body holds them.
import type { Database } from 'bun:sqlite'
import { CHAT_ERROR_MESSAGES } from '@mycel/shared/api'
import { parseDsn, reportCrashes, reporterFromDsn, type ErrorInput, type ErrorReporter, type ReporterOptions } from '@mycel/shared/sentry-report'

export const ERROR_REPORT_ENV = 'MYCEL_ERROR_REPORT_URL'

export interface ErrorReports {
  reporter: ErrorReporter
  /** the receiver's host name (what Admin › System says), never the key or the path */
  host: string
}

export interface ErrorReportSetup {
  reports: ErrorReports | null
  /** the setting is there but is not a Sentry key: the caller logs this once, and nothing is sent */
  invalid: boolean
}

/** The reports from the environment. `environment` is the way the server runs (hosted, selfhost, office, dev);
 *  `team` the install id the hosting service gives (MYCEL_INSTALL_ID: the control plane's tenant id). */
export function errorReportsFrom(env: Record<string, string | undefined>, o: { version: string; environment: string } & Pick<ReporterOptions, 'fetch' | 'now'>): ErrorReportSetup {
  const dsn = env[ERROR_REPORT_ENV]
  const team = env.MYCEL_INSTALL_ID?.trim()
  const { reporter, invalid } = reporterFromDsn(dsn, {
    release: `mycel-server@${o.version}`,
    environment: /^[a-z0-9._-]{1,32}$/.test(o.environment) ? o.environment : 'production',
    logger: 'server',
    tags: team && ID_RE.test(team) ? { team_id: team } : {},
    ...(o.fetch ? { fetch: o.fetch } : {}),
    ...(o.now ? { now: o.now } : {}),
  })
  if (!reporter) return { reports: null, invalid }
  return { reports: { reporter, host: new URL(parseDsn(dsn)!.base).hostname }, invalid: false }
}

let active: ErrorReports | null = null
/** turns that ended in the last hour, for the rate on each report (turns_1h, failed_1h) */
let ended: { at: number; failed: boolean }[] = []

/** Set once at the start (main.ts); null turns reports off (tests). */
export function setErrorReports(r: ErrorReports | null): void {
  active = r
  ended = []
}
export function errorReports(): ErrorReports | null { return active }

/** Crash handlers, only while reports are on: the process still exits with 1 (shared reportCrashes). */
export function reportServerCrashes(r: ErrorReports, logLine: (what: string, err: Error) => void): void {
  reportCrashes(r.reporter, logLine)
}

/** An error line of the server log as a report: the line's message (a fixed text written in code) and, when the line
 *  carries one, its error (type, message, frames). Every other field of the line stays in the local log. */
export function logLineInput(msg: string, fields: Record<string, unknown> | undefined): ErrorInput {
  const err = fields?.err
  if (err instanceof Error) return { type: err.name, message: `${msg}: ${err.message}`, ...(err.stack ? { stack: err.stack } : {}) }
  return { type: 'ServerError', message: msg, kind: 'message' }
}

/** The log hook (createLogger onError): never throws, never logs. */
export function reportLogLine(msg: string, fields: Record<string, unknown> | undefined): void {
  try { active?.reporter.capture(logLineInput(msg, fields)) } catch { /* a report never breaks the code that logged */ }
}

/** Reasons the person reads (CHAT_ERROR_MESSAGES) plus the launcher's limit ends (chat/i18n.ts turnLimitError). */
const KNOWN_REASONS = new Set<string>([...Object.keys(CHAT_ERROR_MESSAGES), 'turn_memory_limit', 'turn_disk_limit'])
const ENGINE_RE = /^[a-z][a-z0-9-]{0,31}$/
const MODEL_RE = /^[A-Za-z0-9._:-]{1,64}$/
/** an internal id (a UUID, a ULID, an install id): letters, digits, dot, dash, underscore; never an @ (an email) */
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/
const HOUR_MS = 3_600_000

export type TurnOutcome = 'ok' | 'failed' | 'timed_out' | 'stopped' | 'interrupted'

interface TurnRow { user_id: string; engine: string; model: string | null; status: string; started_at: string; dispatched_at: string | null; ended_at: string | null }

/** How a turn ended, from its saved rows: the turn's status and the answer's error code (params.reason, params.status). */
export function turnOutcome(status: string, reason: string | null): TurnOutcome {
  if (status === 'done') return 'ok'
  if (status === 'stopped') return 'stopped'
  if (status === 'interrupted') return 'interrupted'
  return reason === 'stalled' ? 'timed_out' : 'failed'
}

/** The report of one ended turn, or null when there is nothing to report (it ended well, the person stopped it, an
 *  update or restart cut it). Built from codes only: the answer's text, the question, the files and the error's
 *  words are never read. */
export function turnReport(row: TurnRow, error: unknown, rate: { turns: number; failed: number }): ErrorInput | null {
  const e = (error && typeof error === 'object' ? error : {}) as { code?: unknown; params?: { reason?: unknown; status?: unknown } }
  const rawReason = typeof e.params?.reason === 'string' ? e.params.reason : null
  const outcome = turnOutcome(row.status, rawReason)
  if (outcome !== 'failed' && outcome !== 'timed_out') return null
  const reason = rawReason === null ? 'none' : KNOWN_REASONS.has(rawReason) ? rawReason : 'other'
  const provider = typeof e.params?.status === 'number' && Number.isInteger(e.params.status) && e.params.status >= 100 && e.params.status <= 599 ? String(e.params.status) : null
  const start = Date.parse(row.dispatched_at ?? row.started_at)
  const end = Date.parse(row.ended_at ?? '')
  const secs = Number.isFinite(start) && Number.isFinite(end) && end >= start ? String(Math.round((end - start) / 1000)) : null
  // at most 10 tags an event (shared MAX_TAGS), team_id included; the error's own code is left out (the reason says more)
  const tags: Record<string, string> = { outcome, reason }
  if (provider) tags.provider_status = provider
  if (secs) tags.duration_s = secs
  if (ENGINE_RE.test(row.engine)) tags.engine = row.engine
  if (row.model && MODEL_RE.test(row.model)) tags.model = row.model
  if (ID_RE.test(row.user_id)) tags.user_id = row.user_id
  tags.turns_1h = String(rate.turns)
  tags.failed_1h = String(rate.failed)
  return {
    type: 'TurnEnded',
    kind: 'message',
    level: outcome === 'timed_out' ? 'warning' : 'error',
    message: `turn ${outcome}: ${reason}`,
    fingerprint: ['turn', outcome, reason],
    tags,
  }
}

/** After a turn ended (ChatRuntime.runExec): one report when it failed or timed out. Never throws, never waits. */
export function reportTurnEnd(db: Database, turnId: string, now = Date.now()): void {
  const r = active
  if (!r) return
  try {
    const row = db.query('SELECT user_id, engine, model, status, started_at, dispatched_at, ended_at, message_id FROM turns WHERE id = ?').get(turnId) as (TurnRow & { message_id: string | null }) | null
    if (!row || row.status === 'queued' || row.status === 'running') return
    let error: unknown = null
    if (row.status === 'error' && row.message_id) {
      const m = db.query('SELECT error FROM messages WHERE id = ?').get(row.message_id) as { error: string | null } | null
      try { error = m?.error ? JSON.parse(m.error) : null } catch { error = null }
    }
    const outcome = turnOutcome(row.status, (error as { params?: { reason?: unknown } } | null)?.params?.reason as string | null ?? null)
    ended = ended.filter((x) => x.at <= now && now - x.at < HOUR_MS)
    ended.push({ at: now, failed: outcome === 'failed' || outcome === 'timed_out' })
    const input = turnReport(row, error, { turns: ended.length, failed: ended.filter((x) => x.failed).length })
    if (input) r.reporter.capture(input)
  } catch { /* a report never breaks a turn's end */ }
}
