// Retention sweep (docs/DECISIONS.md "클라우드 리눅스 서버"): the tables that grow with every turn or file change are
// pruned once an hour, so a small tenant disk is not filled by logs. Component G (ops.ts runs it).
//
//   tool_events   older than the audit retention (Admin > Settings, default 90 days)
//   file_events   older than max(audit retention, 365 days): the file activity views and history read them
//   turns         finished turns older than 400 days, but the last turn of every chat stays (regenerate / resume)
//   proxy_tokens  7 days after they expired or were revoked
//   jobs          finished jobs older than 90 days
//   relay_events  not here: already kept 30 days (relay-client/registration.ts)
//
// Deletes go in batches of 5000 rows by rowid, each table for at most ~2 s per sweep, so a large backlog never
// holds the write lock for long; what is left is taken next hour.
import type { Database } from 'bun:sqlite'
import { getTeamSettings } from '../admin/settings'

export const BATCH = 5000
export const TABLE_BUDGET_MS = 2000
const DAY = 86_400_000
export const TURNS_KEEP_DAYS = 400
export const FILE_EVENTS_MIN_DAYS = 365
export const PROXY_TOKENS_KEEP_DAYS = 7
export const JOBS_KEEP_DAYS = 90

export interface RetentionResult { tool_events: number; file_events: number; turns: number; proxy_tokens: number; jobs: number }

const iso = (t: number) => new Date(t).toISOString()

function sweep(db: Database, table: string, where: string, args: string[], budgetMs: number): number {
  const stmt = db.query(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ${BATCH})`)
  const until = Date.now() + budgetMs
  let total = 0
  for (;;) {
    const n = stmt.run(...args).changes
    total += n
    if (n < BATCH || Date.now() > until) return total
  }
}

export function pruneOld(db: Database, o: { now?: Date; budgetMs?: number } = {}): RetentionResult {
  const now = (o.now ?? new Date()).getTime()
  const budget = o.budgetMs ?? TABLE_BUDGET_MS
  const audit = getTeamSettings(db).auditRetentionDays
  return {
    tool_events: sweep(db, 'tool_events', 'at < ?', [iso(now - audit * DAY)], budget),
    file_events: sweep(db, 'file_events', 'at < ?', [iso(now - Math.max(audit, FILE_EVENTS_MIN_DAYS) * DAY)], budget),
    turns: sweep(db, 'turns', `status IN ('done','error','stopped','interrupted') AND COALESCE(ended_at, started_at) < ?
      AND id NOT IN (SELECT MAX(id) FROM turns GROUP BY chat_id)`, [iso(now - TURNS_KEEP_DAYS * DAY)], budget),
    proxy_tokens: sweep(db, 'proxy_tokens', 'expires_at < ? OR revoked_at < ?', [iso(now - PROXY_TOKENS_KEEP_DAYS * DAY), iso(now - PROXY_TOKENS_KEEP_DAYS * DAY)], budget),
    jobs: sweep(db, 'jobs', "status IN ('done','failed','canceled') AND finished_at < ?", [iso(now - JOBS_KEEP_DAYS * DAY)], budget),
  }
}
