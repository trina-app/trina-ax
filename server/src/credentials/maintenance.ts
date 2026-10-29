// Background work of the AI connections in a running managed-mode server (docs/DECISIONS.md "AI 연결"):
//   at start      the older credentials become connections (migrate.ts; the Codex login through the launcher in prod)
//   every 5 min   the token file again (root/set-claude-token may have put a new token there)
//   once a day    ChatGPT sign-ins nobody used for 8 days are refreshed; Claude tokens ending within 14 days are
//                 announced to the owner and admins
// plus the broker of this server and its usage hooks (budget notices, monthly connection limits).
import type { AppContext } from '../context'
import { afterUsage } from '../admin/budget-watch'
import { resolveLayout } from '../system/layout'
import { createBroker, onUsage, type CredentialBroker } from './broker'
import { refreshIdle } from './chatgpt-tokens'
import { ctAll, fmtDate } from './i18n'
import { afterCredentialUsage } from './limits'
import { importTokenFile, migrateCredentials } from './migrate'
import { credentialsOf, EXPIRING_MS, listRows, notifyOnce, ownerAndAdminsPlusOwnerOf, type CredCtx } from './store'

const FILE_EVERY_MS = 5 * 60_000
const DAILY_MS = 24 * 3600_000

/** the model proxy's view of this server's AI connections (one per server) */
export function brokerOf(ctx: AppContext): CredentialBroker {
  const cc = credentialsOf(ctx)
  let b = cc.extra.broker as CredentialBroker | undefined
  if (!b) {
    b = createBroker(cc)
    cc.extra.broker = b
    onUsage(cc, (userId) => afterUsage(cc.db, userId, cc.notify))
    onUsage(cc, (_userId, credentialId) => afterCredentialUsage(cc, credentialId))
  }
  return b
}

/** Claude tokens that end within 14 days: the owner and admins hear once a day per connection */
export function expiringNotices(cc: CredCtx) {
  const now = cc.now()
  for (const r of listRows(cc.db)) {
    if (r.kind !== 'anthropic-oauth' || r.disabled || !r.expires_at) continue
    const left = Date.parse(r.expires_at) - now
    if (left <= 0 || left > EXPIRING_MS) continue
    notifyOnce(cc, r.id, { level: 'warn', code: 'credential_expiring', message: { ko: ctAll('nExpiring', { label: r.label, date: fmtDate(r.expires_at, 'ko') }).ko, en: ctAll('nExpiring', { label: r.label, date: fmtDate(r.expires_at, 'en') }).en, id: ctAll('nExpiring', { label: r.label, date: fmtDate(r.expires_at, 'id') }).id, ja: ctAll('nExpiring', { label: r.label, date: fmtDate(r.expires_at, 'ja') }).ja, es: ctAll('nExpiring', { label: r.label, date: fmtDate(r.expires_at, 'es') }).es }, link: '/admin/credentials' }, ownerAndAdminsPlusOwnerOf(cc, r), DAILY_MS)
  }
}

export function startCredentialMaintenance(ctx: AppContext) {
  const cc = credentialsOf(ctx)
  const secretsDir = resolveLayout(ctx.config).secretsDir
  const launcherSock = ctx.config.mode === 'prod' ? ctx.config.engine.launcherSock ?? null : null
  const run = (what: string, fn: () => unknown) => { try { const r = fn(); if (r instanceof Promise) r.catch((e) => ctx.log.warn(`AI connections: ${what} failed`, { err: e })) } catch (e) { ctx.log.warn(`AI connections: ${what} failed`, { err: e }) } }
  run('migration', () => migrateCredentials(cc, { secretsDir, dataDir: ctx.config.dataDir, launcherSock }))
  const timers = [
    setInterval(() => run('token file', () => importTokenFile(cc, secretsDir)), FILE_EVERY_MS),
    setInterval(() => { run('idle refresh', () => refreshIdle(cc)); run('expiry notices', () => expiringNotices(cc)) }, DAILY_MS),
  ]
  for (const t of timers) (t as { unref?: () => void }).unref?.()
  // the first daily round shortly after start (not during it)
  const first = setTimeout(() => { run('idle refresh', () => refreshIdle(cc)); run('expiry notices', () => expiringNotices(cc)) }, 60_000)
  ;(first as { unref?: () => void }).unref?.()
  ctx.onClose(() => { for (const t of timers) clearInterval(t); clearTimeout(first) })
}
