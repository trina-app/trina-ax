// Opt-in error reports of the team server (docs/decisions/20261119-hosted-error-reports.md). Off unless the operator
// sets MYCEL_ERROR_REPORT_URL to a Sentry key (DSN) of their own project; nothing in this repository names one, so a
// self-installed server (an office Mac, Docker, Linux) sends nothing. The hosting service sets it on the team servers
// it runs, from its private setup.
//
// What can leave is an allow-list, not a filter: shared/src/sentry-report.ts buildEvent names every field of an event
// (error type, scrubbed message, code frames, release, environment, tags), and the tags below are built here from fixed
// codes only (turnReport). Message text, prompts, AI answers, file names and contents, emails and names are never read
// into a report. tests/unit/hosted-error-reports.test.ts plants them and checks no body holds them.
import crypto from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { CHAT_ERROR_MESSAGES } from '@mycel/shared/api'
import { CRASH_FLUSH_MS, parseDsn, reporterFromDsn, type ErrorInput, type ErrorReporter, type ReporterOptions } from '@mycel/shared/sentry-report'

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
/** outcome|reason|person -> when it was last sent (reportTurnEnd) */
const lastSent = new Map<string, number>()
const REPEAT_MS = 60_000

/** Set once at the start (main.ts); null turns reports off (tests). */
export function setErrorReports(r: ErrorReports | null): void {
  active = r
  ended = []
  lastSent.clear()
}
export function errorReports(): ErrorReports | null { return active }

/** An error's code (Node's ENOENT, EACCES, ERR_…): a fixed word, never a value */
const ERR_CODE_RE = /^[A-Z][A-Z0-9_]{1,39}$/

/** An error as a report, without its words: an error's message is often built from a name, a file or a person's text
 *  ("Folder Quarterly Plan not found"), and the scrubber cannot tell plain words from a name. So the report holds the
 *  error's type, its code when it has a fixed one, the fixed text written in code (`what`) and the code frames; the
 *  frames are read from the stack after the message, so a message line that looks like a frame is never one. */
export function errorInput(what: string, err: unknown, o: { fatal?: boolean } = {}): ErrorInput {
  if (!(err instanceof Error)) return { type: 'ServerError', message: what, kind: 'message', ...(o.fatal ? { fatal: true } : {}) }
  const code = (err as { code?: unknown }).code
  const stack = typeof err.stack === 'string' ? err.stack : ''
  const at = err.message ? stack.indexOf(err.message) : -1
  const frames = (at >= 0 ? stack.slice(at + err.message.length) : stack).split('\n').filter((l) => /^\s*at /.test(l)).join('\n')
  return {
    type: err.name,
    message: typeof code === 'string' && ERR_CODE_RE.test(code) ? `${what}: ${code}` : what,
    ...(frames ? { stack: `${err.name}\n${frames}` } : {}),
    ...(o.fatal ? { fatal: true } : {}),
  }
}

/** Crash handlers, only while reports are on. Like the shared reportCrashes (the full error still goes to stderr, the
 *  report is flushed for at most 2 s, the process exits with 1), but the report is errorInput's: no error words. */
export function reportServerCrashes(r: ErrorReports, logLine: (what: string, err: Error) => void, proc: Pick<NodeJS.Process, 'on' | 'exit'> = process): void {
  let dying = false
  const die = (what: string) => (e: unknown) => {
    if (dying) return
    dying = true
    try { process.stderr.write(`${e instanceof Error ? (e.stack ?? String(e)) : `${what}: ${String(e)}`}\n`) } catch { /* exit anyway */ }
    try { r.reporter.capture(errorInput(what, e, { fatal: true })) } catch { /* exit anyway */ }
    try { logLine(what, e instanceof Error ? e : new Error(what)) } catch { /* exit anyway */ }
    void r.reporter.flush(CRASH_FLUSH_MS).catch(() => {}).finally(() => proc.exit(1))
  }
  proc.on('uncaughtException', die('uncaught exception'))
  proc.on('unhandledRejection', die('unhandled rejection'))
}

/** An error line of the server log as a report: the line's message (a fixed text written in code) and, when the line
 *  carries one, its error without its words (errorInput). Every other field of the line stays in the local log. */
export function logLineInput(msg: string, fields: Record<string, unknown> | undefined): ErrorInput {
  return errorInput(msg, fields?.err)
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
export function turnReport(row: TurnRow, error: unknown, rate: { turns: number; failed: number }, person?: string): ErrorInput | null {
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
  if (person) tags.user = person
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

export const ERROR_REPORT_SALT_SETTING = 'system.errorReportSalt'

/** The person on a report: a stable stand-in, never the id itself. users.id is made from the username (auth/users.ts
 *  deriveUserId), which is often a name, so the report carries "u_" + an HMAC of it under a random key that stays on
 *  this server (settings `system.errorReportSalt`, made on first use). The operators can tell reports of one person
 *  apart; only someone with this server's database can tell who it is. null when the key cannot be read or made. */
export function personTag(db: Database, userId: string): string | null {
  try {
    let salt = (db.query('SELECT value FROM settings WHERE key = ?').get(ERROR_REPORT_SALT_SETTING) as { value: string } | null)?.value
    if (!salt) {
      db.query('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run(ERROR_REPORT_SALT_SETTING, JSON.stringify(crypto.randomBytes(32).toString('hex')))
      salt = (db.query('SELECT value FROM settings WHERE key = ?').get(ERROR_REPORT_SALT_SETTING) as { value: string } | null)?.value
    }
    if (!salt) return null
    return `u_${crypto.createHmac('sha256', String(JSON.parse(salt))).update(userId).digest('hex').slice(0, 16)}`
  } catch { return null }
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
    if (outcome !== 'failed' && outcome !== 'timed_out') return
    const reason = (error as { params?: { reason?: unknown } } | null)?.params?.reason
    // the same end for the same person once a minute: the duration and rate tags differ on every report, so the
    // shared sender's repeat rule would not hold a run of them back
    const key = `${outcome}|${typeof reason === 'string' ? reason.slice(0, 40) : ''}|${row.user_id}`
    for (const [k, at] of lastSent) if (now - at >= REPEAT_MS || at > now) lastSent.delete(k)
    if (lastSent.has(key)) return
    const input = turnReport(row, error, { turns: ended.length, failed: ended.filter((x) => x.failed).length }, personTag(db, row.user_id) ?? undefined)
    if (input) { lastSent.set(key, now); r.reporter.capture(input) }
  } catch { /* a report never breaks a turn's end */ }
}
