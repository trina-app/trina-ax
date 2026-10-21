// Budgets (tab 1 "모델 프록시 예산" / "구독 모드 예산") and usage. Budgets are stored and shown with the current spend.
// A "block" budget that is used up stops new turns in every mode (chat routes call budgetBlock()): in subscription mode
// the tokens are what the team shares, and the admin screen offers the limit there too. USD limits only fill up in
// company-key mode, where turns carry a cost.
import type { Database } from 'bun:sqlite'
import type { z } from 'zod'
import type { Budget, BudgetBody, Locale, UsageQuery, UsageResponse } from '@mycel/shared/api'
import { newId } from '../db'
import { fail } from '../http/errors'
import { msg } from '../auth/messages'

type In<T extends z.ZodType> = z.output<T>
type UsageRes = z.output<typeof UsageResponse>
interface BudgetRow { id: string; subject_type: Budget['subjectType']; subject_id: string | null; period: Budget['period']; limit_usd: number; limit_tokens: number | null; action: Budget['action'] }

/** Start of the current period in server-local time (the Mac's time zone). */
export function periodStart(period: Budget['period'], now = new Date()): Date {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  if (period === 'month') d.setDate(1)
  return d
}

/** Spend of a subject since `from`: turns of the person / of the group's current members / of everyone. */
export function spend(db: Database, subjectType: Budget['subjectType'], subjectId: string | null, from: Date): { usd: number; tokens: number } {
  let where = '1=1'
  const args: string[] = [from.toISOString()]
  if (subjectType === 'user') { where = 't.user_id = ?'; args.push(subjectId ?? '') }
  else if (subjectType === 'group') { where = 't.user_id IN (SELECT user_id FROM group_members WHERE group_id = ?)'; args.push(subjectId ?? '') }
  const r = db.query(`SELECT COALESCE(SUM(t.cost_usd), 0) AS usd, COALESCE(SUM(t.input_tokens + t.output_tokens), 0) AS tokens FROM turns t WHERE t.started_at >= ? AND ${where}`).get(...args) as { usd: number; tokens: number }
  return { usd: Math.max(0, r.usd), tokens: Math.max(0, r.tokens) }
}

function toBudget(db: Database, r: BudgetRow, now = new Date()): Budget {
  const used = spend(db, r.subject_type, r.subject_id, periodStart(r.period, now))
  return { id: r.id, subjectType: r.subject_type, subjectId: r.subject_id, period: r.period, limitUsd: r.limit_usd, limitTokens: r.limit_tokens, action: r.action, usedUsd: used.usd, usedTokens: used.tokens }
}

const COLS = 'id, subject_type, subject_id, period, limit_usd, limit_tokens, action'

export function listBudgets(db: Database): Budget[] {
  return (db.query(`SELECT ${COLS} FROM budgets ORDER BY subject_type, subject_id, period`).all() as BudgetRow[]).map((r) => toBudget(db, r))
}

function checkSubject(db: Database, t: Budget['subjectType'], id: string | null, locale: Locale): void {
  const bad = () => fail('validation', msg('budgetSubject', locale), { fields: { 'body.subjectId': 'invalid subject' } })
  if (t === 'team') { if (id !== null) bad(); return }
  if (!id) bad()
  if (t === 'group' && !db.query('SELECT 1 FROM groups WHERE id = ?').get(id)) bad()
  if (t === 'user' && !db.query('SELECT 1 FROM users WHERE id = ? AND deleted_at IS NULL').get(id)) bad()
}

export function createBudget(db: Database, b: In<typeof BudgetBody>, locale: Locale): Budget {
  checkSubject(db, b.subjectType, b.subjectId, locale)
  const id = newId()
  db.query(`INSERT INTO budgets (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, b.subjectType, b.subjectId, b.period, b.limitUsd, b.limitTokens ?? null, b.action)
  return toBudget(db, db.query(`SELECT ${COLS} FROM budgets WHERE id = ?`).get(id) as BudgetRow)
}

export function updateBudget(db: Database, id: string, b: Partial<In<typeof BudgetBody>>, locale: Locale): Budget {
  const cur = db.query(`SELECT ${COLS} FROM budgets WHERE id = ?`).get(id) as BudgetRow | null
  if (!cur) return fail('not_found')
  const next = {
    subject_type: b.subjectType ?? cur.subject_type,
    subject_id: b.subjectId !== undefined ? b.subjectId : b.subjectType === 'team' ? null : cur.subject_id,
    period: b.period ?? cur.period,
    limit_usd: b.limitUsd ?? cur.limit_usd,
    limit_tokens: b.limitTokens !== undefined ? b.limitTokens : cur.limit_tokens,
    action: b.action ?? cur.action,
  }
  checkSubject(db, next.subject_type, next.subject_id, locale)
  db.query('UPDATE budgets SET subject_type = ?, subject_id = ?, period = ?, limit_usd = ?, limit_tokens = ?, action = ? WHERE id = ?')
    .run(next.subject_type, next.subject_id, next.period, next.limit_usd, next.limit_tokens, next.action, id)
  return toBudget(db, { id, ...next })
}

export function deleteBudget(db: Database, id: string): void {
  if (db.query('DELETE FROM budgets WHERE id = ?').run(id).changes !== 1) fail('not_found')
}

/**
 * Budgets that apply to this person (team, their groups, them) and are used up. Proxy mode only: the caller decides
 * (block -> refuse the turn / proxy request with budget_exceeded; warn -> let it through and notify).
 */
export function checkBudgets(db: Database, userId: string, now = new Date()): { budget: Budget; exceeded: boolean }[] {
  const rows = db.query(`SELECT ${COLS} FROM budgets WHERE subject_type = 'team'
    OR (subject_type = 'user' AND subject_id = ?)
    OR (subject_type = 'group' AND subject_id IN (SELECT group_id FROM group_members WHERE user_id = ?))`).all(userId, userId) as BudgetRow[]
  return rows.map((r) => {
    const budget = toBudget(db, r, now)
    // a USD limit of 0 means "no money limit" (the form says so); tokens count in every mode
    const exceeded = (budget.limitUsd > 0 && budget.usedUsd >= budget.limitUsd) || (budget.limitTokens !== null && budget.usedTokens >= budget.limitTokens)
    return { budget, exceeded }
  })
}

type T3 = Record<Locale, string>
export const PERIOD: Record<Budget['period'], T3> = { day: { ko: '오늘', en: "today's", id: 'hari ini' }, month: { ko: '이번 달', en: "this month's", id: 'bulan ini' } }

/** When the period of a budget starts again (server-local midnight / the 1st). */
export function periodEnd(period: Budget['period'], now = new Date()): Date {
  const d = periodStart(period, now)
  if (period === 'day') d.setDate(d.getDate() + 1)
  else d.setMonth(d.getMonth() + 1)
  return d
}

/**
 * A used-up "block" budget that applies to this person, as an error to answer the send with (tab 5 "사용 한도 도달":
 * the person's own limit is checked before sending, not by queueing). null when they may start a turn.
 */
export function budgetBlock(db: Database, userId: string, locale: Locale, now = new Date()): { budget: Budget; message: string } | null {
  const hit = checkBudgets(db, userId, now).find((b) => b.exceeded && b.budget.action === 'block')
  if (!hit) return null
  const at = new Intl.DateTimeFormat(locale === 'ko' ? 'ko-KR' : locale === 'id' ? 'id-ID' : 'en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(periodEnd(hit.budget.period, now))
  const p = PERIOD[hit.budget.period][locale] ?? PERIOD[hit.budget.period].en
  const message = {
    ko: `${p} AI 사용 한도를 다 썼어요. ${at}부터 다시 쓸 수 있어요. 더 필요하면 관리자에게 말해 주세요.`,
    en: `You have used up ${p} AI usage limit. You can use it again from ${at}. Ask an admin if you need more.`,
    id: `Batas penggunaan AI ${p} sudah habis. Kamu bisa memakainya lagi mulai ${at}. Minta admin jika perlu lebih.`,
  }[locale]
  return { budget: hit.budget, message }
}

// ---------------- usage ----------------
const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/**
 * Usage per calendar day of the server Mac's time zone (like every date the team sees), not per UTC day: in Seoul
 * a UTC day ends at 09:00. Folded here rather than in SQL, so the day follows the same time zone as the rest of
 * the server (SQLite's 'localtime' reads the C library's zone, which can differ from the JavaScript one).
 */
function usageByLocalDay(db: Database, range: string[]): UsageRes['rows'] {
  const days = new Map<string, UsageRes['rows'][number]>()
  const rows = db.query('SELECT started_at, input_tokens, output_tokens, cost_usd FROM turns WHERE started_at >= ? AND started_at < ?').all(...range) as { started_at: string; input_tokens: number | null; output_tokens: number | null; cost_usd: number | null }[]
  for (const r of rows) {
    const key = localDay(new Date(r.started_at))
    const d = days.get(key) ?? { key, label: key, turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
    d.turns++
    d.inputTokens += r.input_tokens ?? 0
    d.outputTokens += r.output_tokens ?? 0
    d.costUsd += r.cost_usd ?? 0
    days.set(key, d)
  }
  return [...days.values()].sort((a, b) => a.key.localeCompare(b.key))
}

export function usage(db: Database, q: In<typeof UsageQuery>, now = new Date()): UsageRes {
  const to = q.to ? new Date(q.to) : now
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86_400_000)
  if (!(from < to)) fail('validation', undefined, { fields: { 'query.from': 'must be before "to"' } })
  const range = [from.toISOString(), to.toISOString()]
  const agg = 'COUNT(*) AS turns, COALESCE(SUM(t.input_tokens), 0) AS inputTokens, COALESCE(SUM(t.output_tokens), 0) AS outputTokens, COALESCE(SUM(t.cost_usd), 0) AS costUsd'
  let sql = ''
  switch (q.groupBy) {
    case 'user': sql = `SELECT t.user_id AS key, COALESCE(u.name, t.user_id) AS label, ${agg} FROM turns t LEFT JOIN users u ON u.id = t.user_id WHERE t.started_at >= ? AND t.started_at < ? GROUP BY t.user_id ORDER BY costUsd DESC, turns DESC`; break
    case 'engine': sql = `SELECT t.engine AS key, t.engine AS label, ${agg} FROM turns t WHERE t.started_at >= ? AND t.started_at < ? GROUP BY t.engine ORDER BY turns DESC`; break
    case 'model': sql = `SELECT COALESCE(t.model, '') AS key, COALESCE(t.model, '(default)') AS label, ${agg} FROM turns t WHERE t.started_at >= ? AND t.started_at < ? GROUP BY COALESCE(t.model, '') ORDER BY turns DESC`; break
    case 'day': break
    case 'group': sql = `SELECT g.id AS key, g.name AS label, ${agg} FROM turns t JOIN group_members m ON m.user_id = t.user_id JOIN groups g ON g.id = m.group_id WHERE t.started_at >= ? AND t.started_at < ? GROUP BY g.id ORDER BY turns DESC`; break
  }
  const rows = q.groupBy === 'day' ? usageByLocalDay(db, range) : (db.query(sql).all(...range) as UsageRes['rows'])
  const tot = db.query(`SELECT ${agg} FROM turns t WHERE t.started_at >= ? AND t.started_at < ?`).get(...range) as UsageRes['totals']
  return { from: from.toISOString(), to: to.toISOString(), rows, totals: tot }
}
