// A person's own usage (Settings > Usage, GET /api/me/usage): their answers, tokens and estimated cost this day / week /
// month in the team's time zone, per engine and model, and the usage limits (Admin budgets) that apply to them. Only the
// caller's own turns are ever read here; a group's or the team's limit shows how full it is, not who used it.
import type { Database } from 'bun:sqlite'
import type { MyUsage, MyUsageLimit } from '@mycel/shared/api'
import { checkBudgets, periodEnd, periodStart } from './budgets'
import { teamTimeZone } from './settings'
import { zonedParts, zonedToUtc } from '../system/time-zone'

type Period = MyUsage['period']

/** Start of this day / week (from Monday) / month in the team's time zone. */
export function myPeriodStart(period: Period, now: Date, tz: string): Date {
  if (period !== 'week') return periodStart(period, now, tz)
  const p = zonedParts(now, tz)
  const back = (p.wd + 6) % 7
  // Date.UTC normalises a day before the 1st into the previous month
  const monday = new Date(Date.UTC(p.y, p.m - 1, p.d - back))
  return zonedToUtc(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate(), 0, 0, tz)
}

const AGG = "COUNT(*) AS turns, COALESCE(SUM(t.input_tokens), 0) AS inputTokens, COALESCE(SUM(t.output_tokens), 0) AS outputTokens, COALESCE(SUM(t.cost_usd), 0) AS costUsd, COALESCE(SUM(CASE WHEN t.usage_source = 'engine_unpriced' THEN 1 ELSE 0 END), 0) AS unpricedTurns"
const priced = <T extends { unpricedTurns?: number }>(r: T): T => { if (!r.unpricedTurns) delete r.unpricedTurns; return r }
const pct = (used: number, limit: number) => Math.round((used / limit) * 1000) / 10

export function myUsage(db: Database, userId: string, period: Period, now = new Date()): MyUsage {
  const tz = teamTimeZone(db)
  const from = myPeriodStart(period, now, tz)
  const since = from.toISOString()
  const totals = priced(db.query(`SELECT ${AGG} FROM turns t WHERE t.user_id = ? AND t.started_at >= ?`).get(userId, since) as MyUsage['totals'])
  const rows = db.query(`SELECT t.engine AS engine, t.model AS model, ${AGG} FROM turns t WHERE t.user_id = ? AND t.started_at >= ?
    GROUP BY t.engine, COALESCE(t.model, '') ORDER BY turns DESC, costUsd DESC`).all(userId, since) as Omit<MyUsage['byModel'][number], 'key'>[]
  const byModel = rows.map((r) => priced({ ...r, key: `${r.engine}:${r.model ?? ''}` }))
  const groupName = (id: string | null) => (id ? ((db.query('SELECT name FROM groups WHERE id = ?').get(id) as { name: string } | null)?.name ?? null) : null)
  const limits: MyUsageLimit[] = []
  for (const { budget: b, exceeded } of checkBudgets(db, userId, now)) {
    // a USD limit of 0 means "no money limit"; with no token limit either, nothing limits anyone
    const parts = [b.limitUsd > 0 ? pct(b.usedUsd, b.limitUsd) : null, b.limitTokens !== null ? (b.limitTokens > 0 ? pct(b.usedTokens, b.limitTokens) : 100) : null].filter((x): x is number => x !== null)
    if (!parts.length) continue
    limits.push({
      scope: b.subjectType === 'user' ? 'you' : b.subjectType,
      name: b.subjectType === 'group' ? groupName(b.subjectId) : null,
      period: b.period,
      usedPct: Math.max(0, ...parts),
      action: b.action,
      exceeded,
      resetsAt: periodEnd(b.period, now, tz).toISOString(),
    })
  }
  // the one that stops answers first, then the fullest
  limits.sort((a, b) => Number(b.exceeded && b.action === 'block') - Number(a.exceeded && a.action === 'block') || b.usedPct - a.usedPct)
  return { period, from: since, to: now.toISOString(), totals, byModel, limits }
}
