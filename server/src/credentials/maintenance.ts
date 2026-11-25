// Background work of the AI connections in a running managed-mode server (docs/DECISIONS.md "AI 연결"):
//   at start      the older credentials become connections (migrate.ts; the Codex login through the launcher in prod)
//   token file    again when it changes (a watch on the secrets folder: root/set-claude-token puts a new token there
//                 and says "within a few seconds"), and every 5 minutes in case the watch missed it
//   once a day    ChatGPT sign-ins nobody used for 8 days are refreshed; Claude tokens ending within 14 days are
//                 announced to the owner and admins
//   ~ every 6 h   refused Claude subscriptions whose refusal can pass are checked again for free (confirm.ts)
// plus the broker of this server and its usage hooks (budget notices, monthly connection limits).
import fs from 'node:fs'
import type { AppContext } from '../context'
import { afterUsage } from '../admin/budget-watch'
import { resolveLayout } from '../system/layout'
import { createBroker, onUsage, type CredentialBroker } from './broker'
import { refreshIdle } from './chatgpt-tokens'
import { RECHECK_EVERY_MS, RECHECK_JITTER_MS, recheckRefused } from './confirm'
import { ctAll, fmtDate } from './i18n'
import { afterCredentialUsage } from './limits'
import { importTokenFile, migrateCredentials } from './migrate'
import { CLAUDE_OAUTH_TOKEN_FILE } from '../proxy/subscription'
import { connectionsChanged, credentialsOf, EXPIRING_MS, listRows, notifyAboutConnection, type CredCtx } from './store'

const FILE_EVERY_MS = 5 * 60_000
const DAILY_MS = 24 * 3600_000
/** a pause between two accounts of one re-check round */
const RECHECK_GAP_MS = 2_000
/** the wait before the next re-check round: about 6 hours, ± up to 30 minutes */
export const recheckDelay = (rnd = Math.random()) => RECHECK_EVERY_MS + (rnd * 2 - 1) * RECHECK_JITTER_MS

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
    notifyAboutConnection(cc, r, { level: 'warn', code: 'credential_expiring', message: { ko: ctAll('nExpiring', { label: r.label, date: fmtDate(r.expires_at, 'ko') }).ko, en: ctAll('nExpiring', { label: r.label, date: fmtDate(r.expires_at, 'en') }).en, id: ctAll('nExpiring', { label: r.label, date: fmtDate(r.expires_at, 'id') }).id, ja: ctAll('nExpiring', { label: r.label, date: fmtDate(r.expires_at, 'ja') }).ja, es: ctAll('nExpiring', { label: r.label, date: fmtDate(r.expires_at, 'es') }).es, zh: ctAll('nExpiring', { label: r.label, date: fmtDate(r.expires_at, 'zh') }).zh }, link: '/admin/credentials' }, undefined, DAILY_MS)
  }
}

/** The token file once: imported or its new token taken; then every copy of the connections' state is dropped and open
 * screens ask again, so the next message uses it (no restart; QA 2026-11-16 needed one) */
export function tokenFileTick(cc: CredCtx, secretsDir: string): ReturnType<typeof importTokenFile> {
  const r = importTokenFile(cc, secretsDir)
  if (r === 'imported' || r === 'updated') {
    cc.log.info('AI connections: the Claude token file was taken', { result: r })
    connectionsChanged(cc)
  }
  return r
}

/** Call onChange shortly after the token file in secretsDir is written, replaced or removed (root/set-claude-token
 * renames a new file into place). Returns the stop function; a folder that cannot be watched returns a no-op (the
 * 5-minute check still runs). */
export function watchTokenFile(secretsDir: string, onChange: () => void, delayMs = 250): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let w: fs.FSWatcher
  try {
    w = fs.watch(secretsDir, { persistent: false }, (_ev, name) => {
      if (name && String(name) !== CLAUDE_OAUTH_TOKEN_FILE) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; onChange() }, delayMs)
    })
    w.on('error', () => { try { w.close() } catch {} })
  } catch { return () => {} }
  return () => { if (timer) clearTimeout(timer); try { w.close() } catch {} }
}

export function startCredentialMaintenance(ctx: AppContext) {
  const cc = credentialsOf(ctx)
  const secretsDir = resolveLayout(ctx.config).secretsDir
  const launcherSock = ctx.config.mode === 'prod' ? ctx.config.engine.launcherSock ?? null : null
  const run = (what: string, fn: () => unknown) => { try { const r = fn(); if (r instanceof Promise) r.catch((e) => ctx.log.warn(`AI connections: ${what} failed`, { err: e })) } catch (e) { ctx.log.warn(`AI connections: ${what} failed`, { err: e }) } }
  run('migration', () => migrateCredentials(cc, { secretsDir, dataDir: ctx.config.dataDir, launcherSock }))
  const timers = [
    setInterval(() => run('token file', () => tokenFileTick(cc, secretsDir)), FILE_EVERY_MS),
    setInterval(() => { run('idle refresh', () => refreshIdle(cc)); run('expiry notices', () => expiringNotices(cc)) }, DAILY_MS),
  ]
  for (const t of timers) (t as { unref?: () => void }).unref?.()
  // the first daily round shortly after start (not during it)
  const first = setTimeout(() => { run('idle refresh', () => refreshIdle(cc)); run('expiry notices', () => expiringNotices(cc)) }, 60_000)
  ;(first as { unref?: () => void }).unref?.()
  const unwatch = watchTokenFile(secretsDir, () => run('token file', () => tokenFileTick(cc, secretsDir)))
  // refused Claude subscriptions whose refusal can pass: checked again for free about every 6 hours (confirm.ts), the
  // first round 10–20 minutes after start, each next one moved by up to ±30 minutes so servers do not ask together
  let recheck: ReturnType<typeof setTimeout> | null = null
  let closed = false
  const nextRecheck = (ms: number) => {
    if (closed) return
    recheck = setTimeout(() => {
      run('re-check of refused accounts', () => recheckRefused(cc, { gapMs: RECHECK_GAP_MS }).finally(() => nextRecheck(recheckDelay())))
    }, ms)
    ;(recheck as { unref?: () => void }).unref?.()
  }
  nextRecheck(10 * 60_000 + Math.random() * 10 * 60_000)
  ctx.onClose(() => { closed = true; for (const t of timers) clearInterval(t); clearTimeout(first); if (recheck) clearTimeout(recheck); unwatch() })
}
