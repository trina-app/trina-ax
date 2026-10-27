// Budget notices (docs/DECISIONS.md "AI 연결" D17): until now a "warn" budget told nobody. A warn budget tells at 100%,
// a block budget at 80% ("soon blocked") and at 100%, each once per period (budget_notices): the owner and admins,
// plus the person when the budget is theirs. Checked after the model proxy counted a request and after a turn ends,
// at most every 30 seconds per person.
import type { Database } from 'bun:sqlite'
import type { Locale } from '@mycel/shared/api'
import { audit } from './audit'
import { checkBudgets, PERIOD, periodStart } from './budgets'
import { ct } from '../credentials/i18n'
import { admins, type Notice } from '../credentials/store'

const EVERY_MS = 30_000
const lastRun = new WeakMap<Database, Map<string, number>>()

export function afterUsage(db: Database, userId: string, notify: (n: Notice, to?: string[]) => void, now = new Date(), force = false) {
  let m = lastRun.get(db)
  if (!m) { m = new Map(); lastRun.set(db, m) }
  if (!force && now.getTime() - (m.get(userId) ?? 0) < EVERY_MS) return
  m.set(userId, now.getTime())
  for (const { budget: b } of checkBudgets(db, userId, now)) {
    const usd = b.limitUsd > 0 ? b.usedUsd / b.limitUsd : 0
    const tok = b.limitTokens !== null && b.limitTokens > 0 ? b.usedTokens / b.limitTokens : 0
    const ratio = Math.max(usd, tok)
    const levels: ('near' | 'reached')[] = b.action === 'block' ? ['near', 'reached'] : ['reached']
    const period = periodStart(b.period, now).toISOString()
    for (const level of levels) {
      if (ratio < (level === 'near' ? 0.8 : 1)) continue
      if (!db.query('INSERT OR IGNORE INTO budget_notices (budget_id, period_start, level) VALUES (?, ?, ?)').run(b.id, period, level).changes) continue
      audit(db, { actor: null, action: 'budget.warned', target: b.id, detail: { level, usedUsd: b.usedUsd, usedTokens: b.usedTokens } })
      const subject = (l: Locale) => b.subjectType === 'team' ? ct('subjectTeam', l)
        : b.subjectType === 'group' ? (db.query('SELECT name FROM groups WHERE id = ?').get(b.subjectId) as { name: string } | null)?.name ?? b.subjectId ?? ''
        : (db.query('SELECT name FROM users WHERE id = ?').get(b.subjectId) as { name: string } | null)?.name ?? b.subjectId ?? ''
      const msg = (l: Locale) => ct(level === 'near' ? 'nBudgetNear' : 'nBudgetReached', l, { subject: subject(l), period: PERIOD[b.period][l] })
      const to = admins(db)
      if (b.subjectType === 'user' && b.subjectId && !to.includes(b.subjectId)) to.push(b.subjectId)
      notify({ level: 'warn', code: 'budget_warn', message: { ko: msg('ko'), en: msg('en'), id: msg('id') }, link: '/admin/engines' }, to)
    }
  }
}
