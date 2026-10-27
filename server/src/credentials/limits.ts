// A connection's monthly limit (docs/DECISIONS.md "AI 연결" D17): USD and/or tokens per month of the server's time
// zone, from the per-request counts (credential_usage_daily). "block": the resolver skips the connection once it is
// used up (store.ts unusable 'over_limit') and the proxy refuses its next request, so the turn moves to another
// connection. Both actions tell the owner and admins at 80% and 100%, once each per month (credential_notices).
import { ctAll } from './i18n'
import { admins, getRow, localDay, monthStart, monthUsage, type CredCtx } from './store'

export function afterCredentialUsage(cc: CredCtx, credentialId: string) {
  const r = getRow(cc.db, credentialId)
  if (!r || (r.spend_limit_usd === null && r.spend_limit_tokens === null)) return
  const now = new Date(cc.now())
  const m = monthUsage(cc.db, r.id, now)
  const ratio = Math.max(r.spend_limit_usd ? m.usd / r.spend_limit_usd : r.spend_limit_usd === 0 ? 1 : 0, r.spend_limit_tokens ? m.tokens / r.spend_limit_tokens : r.spend_limit_tokens === 0 ? 1 : 0)
  const period = localDay(monthStart(now))
  for (const [level, at] of [['near', 0.8], ['reached', 1]] as const) {
    if (ratio < at) continue
    const added = cc.db.query('INSERT OR IGNORE INTO credential_notices (credential_id, period_start, level) VALUES (?, ?, ?)').run(r.id, period, level).changes
    if (added) cc.notify({ level: 'warn', code: 'credential_limit', message: ctAll(level === 'near' ? 'nLimitNear' : 'nLimitReached', { label: r.label }), link: '/admin/credentials' }, admins(cc.db))
  }
}
