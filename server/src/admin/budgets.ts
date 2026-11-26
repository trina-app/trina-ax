// Budgets (tab 1 "모델 프록시 예산" / "구독 모드 예산") and usage. Budgets are stored and shown with the current spend.
// A "block" budget that is used up stops new turns in every mode (chat routes call budgetBlock()). Tokens count for
// every AI connection; USD only fills up with API-key connections (subscriptions have no price per request; the model
// proxy prices API-key requests from credentials/prices.ts). Budget notices: admin/budget-watch.ts.
import type { Database } from 'bun:sqlite'
import type { z } from 'zod'
import { DEMO_LIMIT_REASON, type Budget, type BudgetBody, type Locale, type UsageQuery, type UsageResponse } from '@mycel/shared/api'
import { ANSWER_AVERAGE_DAYS, DEFAULT_TOKENS_PER_ANSWER, MIN_ANSWERS_FOR_AVERAGE, limitResetText, modelVersionName } from '@mycel/shared'
import { newId } from '../db'
import { fail } from '../http/errors'
import { msg } from '../auth/messages'
import { teamTimeZone } from './settings'
import { TURN_MODEL_ROWS, USAGE_AGG, turnAmount, withCounts, type TurnAmountRow } from './usage-amount'
import { zonedDay, zonedParts, zonedToUtc } from '../system/time-zone'

type In<T extends z.ZodType> = z.output<T>
type UsageRes = z.output<typeof UsageResponse>
interface BudgetRow { id: string; subject_type: Budget['subjectType']; subject_id: string | null; period: Budget['period']; limit_usd: number; limit_tokens: number | null; action: Budget['action'] }

/** Start of the current period in the team's time zone (`tz`: admin/settings.ts teamTimeZone). Never the process's: a
 * Linux server runs in UTC, and a Korean team's day starts at 00:00 KST, not 09:00. */
export function periodStart(period: Budget['period'], now: Date, tz: string): Date {
  const p = zonedParts(now, tz)
  return zonedToUtc(p.y, p.m, period === 'month' ? 1 : p.d, 0, 0, tz)
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
  const used = spend(db, r.subject_type, r.subject_id, periodStart(r.period, now, teamTimeZone(db)))
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

/**
 * One limit per subject and period: a second one for the same person, group or team and period is refused (409
 * budget_duplicate). Admin › Members edits a person's limit for the period picked (web pages/admin/BudgetForm.tsx), so a
 * second one would never be seen there. Duplicates already in a database are kept and keep counting (no unique index,
 * nothing deleted); only a new one, or an edit that moves a limit onto a taken subject and period, is refused.
 */
function checkNoDuplicate(db: Database, t: Budget['subjectType'], subjectId: string | null, period: Budget['period'], exceptId: string | null, locale: Locale): void {
  const taken = db.query('SELECT 1 FROM budgets WHERE subject_type = ? AND subject_id IS ? AND period = ? AND id IS NOT ? LIMIT 1').get(t, t === 'team' ? null : subjectId, period, exceptId)
  if (taken) fail('conflict', msg('budgetDuplicate', locale), { params: { reason: 'budget_duplicate' } })
}

export function createBudget(db: Database, b: In<typeof BudgetBody>, locale: Locale): Budget {
  checkSubject(db, b.subjectType, b.subjectId, locale)
  const id = newId()
  // the check and the insert in one transaction, so two saves at once can't both pass the check
  db.transaction(() => {
    checkNoDuplicate(db, b.subjectType, b.subjectId, b.period, null, locale)
    db.query(`INSERT INTO budgets (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, b.subjectType, b.subjectId, b.period, b.limitUsd, b.limitTokens ?? null, b.action)
  }).immediate()
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
  // an existing duplicate can still be edited in place; moving a limit onto a subject and period that has one is refused
  const moved = next.subject_type !== cur.subject_type || next.subject_id !== cur.subject_id || next.period !== cur.period
  db.transaction(() => {
    if (moved) checkNoDuplicate(db, next.subject_type, next.subject_id, next.period, id, locale)
    db.query('UPDATE budgets SET subject_type = ?, subject_id = ?, period = ?, limit_usd = ?, limit_tokens = ?, action = ? WHERE id = ?')
      .run(next.subject_type, next.subject_id, next.period, next.limit_usd, next.limit_tokens, next.action, id)
  }).immediate()
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
export const PERIOD: Record<Budget['period'], T3> = { day: { ko: '오늘', en: "today's", id: 'hari ini', ja: "今日", es: "de hoy", zh: "今天的" }, month: { ko: '이번 달', en: "this month's", id: 'bulan ini', ja: "今月", es: "de este mes", zh: "本月的" } }

/** When the period of a budget starts again (midnight / the 1st in the team's time zone). */
export function periodEnd(period: Budget['period'], now: Date, tz: string): Date {
  const p = zonedParts(now, tz)
  // Date.UTC normalises day 32 / month 13; the wall-clock date is then placed in the zone (DST-safe)
  const next = period === 'day' ? new Date(Date.UTC(p.y, p.m - 1, p.d + 1)) : new Date(Date.UTC(p.y, p.m, 1))
  return zonedToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, tz)
}

/** What a refused send carries (HttpError params): a budget's reset time (and `own` for the person's own), or a
 * free-roam demo's limit (reason DEMO_LIMIT_REASON, with the weighted tokens used and the limit) */
export type BudgetBlockParams = { resetsAt: string; own?: true } | { reason: typeof DEMO_LIMIT_REASON; used: number; cap: number }

// ---------------- the free-roam demo's limit (docs/decisions/20261119-demo-free-roam-a.md) ----------------
// One visitor's instance (demo/free-roam.ts) has one limit for everything the AI does there: the weighted tokens of every
// answer the model proxy counted (credentials/broker.ts record weighs a cache read DEMO_CACHE_READ_WEIGHT), for every
// person, with no period: the instance lives a day at most. It is a block, checked where every block budget is
// (budgetBlock: the send, the scheduled run, the proxy's overBudget), so a running answer ends through the budget path.
const demoLimits = new WeakMap<Database, number>()
/** freeRoam start (demo/free-roam.ts): the demo limit of this database's server; null takes it away (tests) */
export function setDemoLimit(db: Database, cap: number | null): void {
  if (cap === null) demoLimits.delete(db)
  else demoLimits.set(db, cap)
}
/** weighted tokens the model proxy counted on this instance (only usage_source 'proxy': a snapshot has none) */
export function demoUsed(db: Database): number {
  const r = db.query("SELECT COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS n FROM turns WHERE usage_source = 'proxy'").get() as { n: number }
  return Math.max(0, r.n)
}
/** the free-roam demo's limit and use, or null on any other server */
export function demoLimitState(db: Database): { used: number; cap: number } | null {
  const cap = demoLimits.get(db)
  return cap === undefined ? null : { used: demoUsed(db), cap }
}
const DEMO_LIMIT_TEXT: Record<Locale, string> = {
  ko: '이 데모의 AI를 다 썼어요. 무료로 시작하면 우리 팀에서 계속 쓸 수 있어요.',
  en: "You've used this demo's AI. Start free to keep going with your own team.",
  id: 'AI demo ini sudah habis Anda pakai. Mulai gratis untuk lanjut dengan tim Anda sendiri.',
  ja: 'このデモのAIを使い切りました。無料で始めると、ご自分のチームで続けられます。',
  es: 'Ha usado la IA de esta demostración. Empiece gratis para seguir con su propio equipo.',
  zh: '你已用完此演示的AI。免费开始，即可在自己的团队中继续使用。',
}
function demoLimitBlock(db: Database, locale: Locale): { budget: Budget; message: string; resetsAt: null; params: BudgetBlockParams } | null {
  const s = demoLimitState(db)
  if (!s || s.used < s.cap) return null
  const budget: Budget = { id: 'demo', subjectType: 'team', subjectId: null, period: 'month', limitUsd: 0, limitTokens: s.cap, action: 'block', usedUsd: 0, usedTokens: s.used }
  return { budget, message: DEMO_LIMIT_TEXT[locale] ?? DEMO_LIMIT_TEXT.en, resetsAt: null, params: { reason: DEMO_LIMIT_REASON, used: s.used, cap: s.cap } }
}

/**
 * A used-up "block" budget that applies to this person, as an error to answer the send with (tab 5 "사용 한도 도달":
 * the person's own limit is checked before sending, not by queueing). null when they may start a turn.
 */
export function budgetBlock(db: Database, userId: string, locale: Locale, now = new Date()): { budget: Budget; message: string; resetsAt: string | null; params: BudgetBlockParams } | null {
  const demo = demoLimitBlock(db, locale)
  if (demo) return demo
  const hit = checkBudgets(db, userId, now).find((b) => b.exceeded && b.budget.action === 'block')
  if (!hit) return null
  const tz = teamTimeZone(db)
  const end = periodEnd(hit.budget.period, now, tz)
  // 24-hour time: the limit ends at midnight, which "오전 12:00" / "12:00 AM" can read as noon (QA TC-215)
  const at = limitResetText(end, locale, tz)
  const p = PERIOD[hit.budget.period][locale] ?? PERIOD[hit.budget.period].en
  // a guest does not know the team's admins: the person who invited them (docs/DECISIONS.md "Guests: only what they
  // were invited to"); the same date
  const guest = !!(db.query('SELECT guest FROM users WHERE id = ?').get(userId) as { guest: number } | null)?.guest
  // a guest's own token limit says its amount, as the web's in-chat notice does ("this month's AI limit (5M tokens)"):
  // the composer, a room's AI side chat and every other place show this text as it is (QA TC-3310)
  const own = guest && hit.budget.subjectType === 'user' && hit.budget.limitTokens !== null && hit.budget.limitTokens > 0 && !(hit.budget.limitUsd > 0)
  const n = own ? new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(hit.budget.limitTokens!) : ''
  const message = own ? {
    ko: `${p} AI 한도(${n} 토큰)를 다 썼어요. ${at}부터 다시 쓸 수 있어요. 더 필요하면 초대한 분께 물어봐 주세요.`,
    en: `You have used up ${p} AI limit (${n} tokens). You can use it again from ${at}. Ask the person who invited you if you need more.`,
    id: `Batas AI ${p} (${n} token) sudah habis. Anda bisa memakainya lagi mulai ${at}. Tanyakan ke orang yang mengundang Anda jika perlu lebih.`, ja: `${p}のAIの上限（${n}トークン）を使い切りました。${at}から再び使用できます。追加が必要な場合は、招待してくれた人に聞いてください。`, es: `Agotó el límite de IA ${p} (${n} tokens). Podrá volver a usarla a partir de ${at}. Si necesita más, pregunte a quien le invitó.`,
    zh: `${p}AI额度（${n} token）已用完。从${at}起可以再次使用。如果需要更多，请询问邀请你的人。`,
  }[locale] : guest ? {
    ko: `${p} AI 사용 한도를 다 썼어요. ${at}부터 다시 쓸 수 있어요. 더 필요하면 초대한 분께 물어봐 주세요.`,
    en: `You have used up ${p} AI usage limit. You can use it again from ${at}. Ask the person who invited you if you need more.`,
    id: `Batas penggunaan AI ${p} sudah habis. Anda bisa memakainya lagi mulai ${at}. Tanyakan ke orang yang mengundang Anda jika perlu lebih.`, ja: `${p}のAI使用量上限を使い切りました。${at}から再び使用できます。追加が必要な場合は、招待してくれた人に聞いてください。`, es: `Agotó el límite de uso de IA ${p}. Podrá volver a usarla a partir de ${at}. Si necesita más, pregunte a quien le invitó.`,
    zh: `${p}AI用量上限已用完。从${at}起可以再次使用。如果需要更多，请询问邀请你的人。`,
  }[locale] : {
    ko: `${p} AI 사용 한도를 다 썼어요. ${at}부터 다시 쓸 수 있어요. 더 필요하면 관리자에게 말해 주세요.`,
    en: `You have used up ${p} AI usage limit. You can use it again from ${at}. Ask an admin if you need more.`,
    id: `Batas penggunaan AI ${p} sudah habis. Anda bisa memakainya lagi mulai ${at}. Minta admin jika perlu lebih.`, ja: `${p}のAI使用量上限を使い切りました。${at}から再び使用できます。追加が必要な場合は管理者にご相談ください。`, es: `Agotó el límite de uso de IA ${p}. Podrá volver a usarla a partir de ${at}. Consulte a un administrador si necesita más.`,
    zh: `${p}AI用量上限已用完。从${at}起可以再次使用。如果需要更多，请联系管理员。`,
  }[locale]
  // resetsAt: when the limit starts again (the start of the next period in the team's time zone), for screens that
  // word it themselves (a guest's "It resets on Dec 1": web components/chat/Messages.tsx)
  // params: what a refused send carries; `own` when it is the person's own limit (a guest's notice then names its amount,
  // never a team or group limit's)
  return { budget: hit.budget, message, resetsAt: end.toISOString(), params: { resetsAt: end.toISOString(), ...(hit.budget.subjectType === 'user' ? { own: true as const } : {}) } }
}

/**
 * Tokens one answer takes on average in this team (input + output, as a budget counts them): the turns of the last
 * ANSWER_AVERAGE_DAYS days that used any. With fewer than MIN_ANSWERS_FOR_AVERAGE of them, DEFAULT_TOKENS_PER_ANSWER
 * (shared/src/guest-tokens.ts). The mean, not the median: tokens of the limit / the mean = how many answers fit.
 * Finished answers only: a running or failed one has not used all its tokens and would make answers look smaller.
 */
export function answerTokens(db: Database, now = new Date()): { tokens: number; from: 'team' | 'default' } {
  const since = new Date(now.getTime() - ANSWER_AVERAGE_DAYS * 86_400_000).toISOString()
  const r = db.query("SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS tokens FROM turns WHERE started_at >= ? AND status = 'done' AND COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) > 0").get(since) as { n: number; tokens: number }
  if (r.n < MIN_ANSWERS_FOR_AVERAGE) return { tokens: DEFAULT_TOKENS_PER_ANSWER, from: 'default' }
  return { tokens: Math.max(1, Math.round(r.tokens / r.n)), from: 'team' }
}
const answerTokensCache = new WeakMap<Database, { at: number; v: { tokens: number; from: 'team' | 'default' } }>()
/** answerTokens, read again at most every 10 minutes: the invite and Change AI dialogs ask on every open, and the 90
 * days of turns have no index by time. */
export function answerTokensCached(db: Database, now = new Date()): { tokens: number; from: 'team' | 'default' } {
  const hit = answerTokensCache.get(db)
  if (hit && Math.abs(now.getTime() - hit.at) < 600_000) return hit.v
  const v = answerTokens(db, now)
  answerTokensCache.set(db, { at: now.getTime(), v })
  return v
}

/** A guest's Team AI limit: their own 'block' budget for the month, in tokens (no money limit: limit_usd 0). */
export function insertGuestBudget(db: Database, userId: string, limitTokens: number): void {
  db.query("INSERT INTO budgets (id, subject_type, subject_id, period, limit_usd, limit_tokens, action) VALUES (?, 'user', ?, 'month', 0, ?, 'block')").run(newId(), userId, limitTokens)
}

// ---------------- usage ----------------
/**
 * Usage per calendar day of the team's time zone (like every date the team sees), not per UTC day: in Seoul a UTC
 * day ends at 09:00. Folded here rather than in SQL, so the day follows the same time zone as the rest of the server.
 */
function usageByLocalDay(db: Database, where: string, params: string[], from = 'turns'): UsageRes['rows'] {
  const tz = teamTimeZone(db)
  const localDay = (d: Date) => zonedDay(d, tz)
  const days = new Map<string, UsageRes['rows'][number]>()
  const rows = db.query(`SELECT t.started_at, t.input_tokens, t.output_tokens, t.cost_usd, t.est_cost_usd, t.usage_source FROM ${from} t WHERE ${where}`).all(...params) as ({ started_at: string } & TurnAmountRow)[]
  for (const r of rows) {
    const key = localDay(new Date(r.started_at))
    const d = days.get(key) ?? { key, label: key, turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
    d.turns++
    d.inputTokens += r.input_tokens ?? 0
    d.outputTokens += r.output_tokens ?? 0
    const a = turnAmount(r)
    d.costUsd += a.usd
    if (a.unpriced) d.unpricedTurns = (d.unpricedTurns ?? 0) + 1
    if (a.estimated) d.estimatedTurns = (d.estimatedTurns ?? 0) + 1
    days.set(key, d)
  }
  return [...days.values()].sort((a, b) => a.key.localeCompare(b.key))
}

/** The chart: tokens per day (team time zone) split by the groupBy key. Skill and group keys can overlap, like their rows;
 * groupBy=day has one key, 'all'. */
function usageSeries(db: Database, groupBy: In<typeof UsageQuery>['groupBy'], where: string, params: string[], from = 'turns'): NonNullable<UsageRes['series']> {
  const tz = teamTimeZone(db)
  const pick: Record<In<typeof UsageQuery>['groupBy'], { key: string; join?: string; and?: string }> = {
    user: { key: 't.user_id' },
    engine: { key: 't.engine' },
    model: { key: "COALESCE(t.model, '')" },
    day: { key: "'all'" },
    group: { key: 'm.group_id', join: 'JOIN group_members m ON m.user_id = t.user_id' },
    credential: { key: 't.credential_id', and: ' AND t.credential_id IS NOT NULL' },
    skill: { key: 's.skill_path', join: 'JOIN turn_skill_usage s ON s.turn_id = t.id' },
  }
  const p = pick[groupBy ?? 'user']
  const rows = db.query(`SELECT t.started_at AS at, ${p.key} AS key, t.input_tokens AS i, t.output_tokens AS o FROM ${from} t ${p.join ?? ''} WHERE ${where}${p.and ?? ''}`).all(...params) as { at: string; key: string; i: number | null; o: number | null }[]
  const out = new Map<string, NonNullable<UsageRes['series']>[number]>()
  for (const r of rows) {
    const day = zonedDay(new Date(r.at), tz)
    const id = `${day}\u0000${r.key}`
    const d = out.get(id) ?? { day, key: r.key, turns: 0, inputTokens: 0, outputTokens: 0 }
    d.turns++
    d.inputTokens += r.i ?? 0
    d.outputTokens += r.o ?? 0
    out.set(id, d)
  }
  return [...out.values()].sort((a, b) => a.day.localeCompare(b.day) || a.key.localeCompare(b.key))
}

/** Admin › Usage by model and its filter: each real id (the key, as the CSV keeps it) named with its version ("Claude
 * Opus 4.5"); two ids that still read the same (an alias and a dated id of one version) get the id after the name, so
 * no two rows look alike. A row without a model keeps its label. */
function modelLabels<T extends { key: string; label: string }>(rows: T[]): T[] {
  const named = rows.map((r) => ({ ...r, label: r.key ? modelVersionName(r.key) : r.label }))
  const seen = new Map<string, number>()
  for (const r of named) seen.set(r.label, (seen.get(r.label) ?? 0) + 1)
  return named.map((r) => (r.key && (seen.get(r.label) ?? 0) > 1 ? { ...r, label: `${r.label} (${r.key})` } : r))
}

/** The filter choices: everything with usage in the range, whatever the filters are (so a choice never disappears). */
function usageFacets(db: Database, range: string[]): NonNullable<UsageRes['facets']> {
  const w = 't.started_at >= ? AND t.started_at < ?'
  type F = { key: string; label: string }
  return {
    users: db.query(`SELECT DISTINCT t.user_id AS key, COALESCE(u.name, t.user_id) AS label FROM turns t LEFT JOIN users u ON u.id = t.user_id WHERE ${w} ORDER BY label`).all(...range) as F[],
    engines: db.query(`SELECT DISTINCT t.engine AS key, t.engine AS label FROM turns t WHERE ${w} ORDER BY key`).all(...range) as F[],
    models: modelLabels((db.query(`SELECT DISTINCT COALESCE(t.model, '') AS key FROM ${TURN_MODEL_ROWS} t WHERE ${w} ORDER BY key`).all(...range) as { key: string }[]).map((r) => ({ key: r.key, label: '(default)' }))),
    credentials: db.query(`SELECT DISTINCT t.credential_id AS key, COALESCE(c.label, '') AS label FROM turns t LEFT JOIN engine_credentials c ON c.id = t.credential_id WHERE ${w} AND t.credential_id IS NOT NULL ORDER BY label`).all(...range) as F[],
    groups: db.query('SELECT id AS key, name AS label FROM groups ORDER BY name').all() as F[],
  }
}

export function usage(db: Database, q: In<typeof UsageQuery>, now = new Date()): UsageRes {
  const to = q.to ? new Date(q.to) : now
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86_400_000)
  if (!(from < to)) fail('validation', undefined, { fields: { 'query.from': 'must be before "to"' } })
  const range = [from.toISOString(), to.toISOString()]
  // the range, then the optional filters; every row query, the totals and the chart use the same WHERE
  const conds = ['t.started_at >= ? AND t.started_at < ?']
  const params: string[] = [...range]
  if (q.user) { conds.push('t.user_id = ?'); params.push(q.user) }
  if (q.engine) { conds.push('t.engine = ?'); params.push(q.engine) }
  if (q.model !== undefined) { conds.push("COALESCE(t.model, '') = ?"); params.push(q.model) }
  if (q.credential) { conds.push('t.credential_id = ?'); params.push(q.credential) }
  if (q.group) { conds.push('t.user_id IN (SELECT user_id FROM group_members WHERE group_id = ?)'); params.push(q.group) }
  const where = conds.join(' AND ')
  const agg = USAGE_AGG
  // by model, and any view filtered to one model: the models that really answered (a row per turn and model); the
  // other views count whole turns
  const src = q.groupBy === 'model' || q.model !== undefined ? TURN_MODEL_ROWS : 'turns'
  let sql = ''
  switch (q.groupBy) {
    case 'user': sql = `SELECT t.user_id AS key, COALESCE(u.name, t.user_id) AS label, ${agg} FROM turns t LEFT JOIN users u ON u.id = t.user_id WHERE ${where} GROUP BY t.user_id ORDER BY costUsd DESC, turns DESC`; break
    case 'engine': sql = `SELECT t.engine AS key, t.engine AS label, ${agg} FROM turns t WHERE ${where} GROUP BY t.engine ORDER BY turns DESC`; break
    case 'model': sql = `SELECT COALESCE(t.model, '') AS key, COALESCE(t.model, '(default)') AS label, ${agg} FROM ${src} t WHERE ${where} GROUP BY COALESCE(t.model, '') ORDER BY turns DESC`; break
    // Skill rows attribute the whole turn. A turn using several skills appears in each row; totals below remain
    // the unique turn totals. Latest recorded name in this range labels a path even after its file is renamed.
    case 'skill': sql = `SELECT s.skill_path AS key,
      (SELECT s2.skill_name FROM turn_skill_usage s2 JOIN turns t2 ON t2.id = s2.turn_id
        WHERE s2.skill_path = s.skill_path AND t2.started_at >= ? AND t2.started_at < ?
        ORDER BY t2.started_at DESC, s2.turn_id DESC LIMIT 1) AS label,
      ${agg} FROM turns t JOIN turn_skill_usage s ON s.turn_id = t.id
      WHERE ${where} GROUP BY s.skill_path ORDER BY turns DESC, costUsd DESC, s.skill_path`; break
    case 'day': break
    case 'group': sql = `SELECT g.id AS key, g.name AS label, ${agg} FROM turns t JOIN group_members m ON m.user_id = t.user_id JOIN groups g ON g.id = m.group_id WHERE ${where} GROUP BY g.id ORDER BY turns DESC`; break
    // per AI connection (the connection of each turn's latest attempt); a removed connection keeps its turns under
    // its id, labelled empty here (the screen says "removed connection"); turns without one (local login) are left out
    case 'credential': sql = `SELECT t.credential_id AS key, COALESCE(c.label, '') AS label, ${agg} FROM turns t LEFT JOIN engine_credentials c ON c.id = t.credential_id WHERE ${where} AND t.credential_id IS NOT NULL GROUP BY t.credential_id ORDER BY costUsd DESC, turns DESC`; break
  }
  const raw = q.groupBy === 'day' ? usageByLocalDay(db, where, params, src) : (db.query(sql.replace(/FROM turns t\b/g, `FROM ${src} t`)).all(...(q.groupBy === 'skill' ? [...range, ...params] : params)) as UsageRes['rows'])
  // a model's name as people read it, with its version ("Claude Opus 4.5"): one row per real id, so two ids never show
  // the same name; the key (and the CSV) keeps the real id
  const rows = q.groupBy === 'model' ? modelLabels(raw) : raw
  // the totals count whole turns, unless the view is filtered to one model
  const tot = db.query(`SELECT ${agg} FROM ${q.model !== undefined ? TURN_MODEL_ROWS : 'turns'} t WHERE ${where}`).get(...params) as UsageRes['totals']
  // unpricedTurns / estimatedTurns (admin/usage-amount.ts): only when any
  const priced = withCounts
  const res: UsageRes = { from: from.toISOString(), to: to.toISOString(), rows: rows.map(priced), totals: priced(tot) }
  if (q.series) res.series = usageSeries(db, q.groupBy, where, params, src)
  if (q.facets) res.facets = usageFacets(db, range)
  return res
}
