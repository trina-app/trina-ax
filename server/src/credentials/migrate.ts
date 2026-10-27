// Moving the older credentials into the AI connection pool (docs/DECISIONS.md "AI 연결" 3.16). Managed mode only,
// idempotent, run at start (and the token file again every 5 minutes):
//   <secrets>/claude-oauth-token (root/set-claude-token, office --claude-token-file) -> an anthropic-oauth connection;
//     a new token in the file later replaces that connection's secret (the file stays: the previous release reads it)
//   engine_accounts + <data>/secrets/<id>.key (company keys, never used) -> API key connections with the same id
//   <agent root>/codex-auth/auth.json (the engine account's own Codex login) -> a chatgpt connection, through the
//     launcher's one-time codex-export; the old login is removed only after the connection is stored
// The result is kept in settings credentials.migratedV1 (and credentials.fileToken for the token file).
import fs from 'node:fs'
import path from 'node:path'
import type { Locale } from '@mycel/shared/api'
import { audit } from '../admin/audit'
import { getSetting, getTeamSettings, setSetting } from '../admin/settings'
import { codexExport, codexLogout } from '../native'
import { REJECTED_KEY, TokenReader, tokenFile } from '../proxy/subscription'
import { accessExpiry, accountRef, idClaims, maskEmail } from './openai-oauth'
import { duplicateOf, insertRow } from './service'
import { CLAUDE_TOKEN_LIFETIME_MS, fingerprintOf, getRow, writeSecret, type CredCtx, type Secrets } from './store'
import { ANTHROPIC_KEY_RE, CLAUDE_TOKEN_RE } from './validate'

export const MIGRATED_KEY = 'credentials.migratedV1'
export const FILE_TOKEN_KEY = 'credentials.fileToken'
export interface Migrated { at: string; claudeFile?: string; accounts?: string[]; codexAuth?: 'done' | 'failed' | 'none' | 'pending' }

const LABELS: Record<string, Record<Locale, string>> = {
  claude: { ko: 'Claude 구독', en: 'Claude subscription', id: 'Langganan Claude' },
  key: { ko: '회사 키', en: 'Company key', id: 'Kunci perusahaan' },
  chatgpt: { ko: 'ChatGPT (기존)', en: 'ChatGPT (existing)', id: 'ChatGPT (lama)' },
}
const label = (cc: CredCtx, k: keyof typeof LABELS) => { const l = getTeamSettings(cc.db).defaultLocale; return LABELS[k]![l] ?? LABELS[k]!.en }

/** The token file -> a connection (new, or the imported one's secret replaced when the file holds a new token). */
export function importTokenFile(cc: CredCtx, secretsDir: string): 'imported' | 'updated' | 'same' | 'none' {
  const file = tokenFile(secretsDir)
  const token = new TokenReader(file).read()
  if (!token || !CLAUDE_TOKEN_RE.test(token)) return 'none'
  const fp = fingerprintOf(token)
  const prev = getSetting<{ id: string; fp: string }>(cc.db, FILE_TOKEN_KEY)
  if (prev?.fp === fp) return 'same' // already imported (even if the owner removed that connection since)
  if (duplicateOf(cc, 'anthropic-oauth', fp)) { setSetting(cc.db, FILE_TOKEN_KEY, { id: prev?.id ?? null, fp }); return 'same' }
  let issued = Date.now()
  try { issued = fs.lstatSync(file).mtimeMs } catch {}
  const rejected = (() => { try { return (getSetting<{ fp?: string }>(cc.db, REJECTED_KEY)?.fp ?? null) === fp } catch { return false } })()
  const secret: Secrets['anthropic-oauth'] = { token }
  const expires = new Date(issued + CLAUDE_TOKEN_LIFETIME_MS).toISOString()
  const status = rejected ? 'invalid' as const : 'ok' as const
  const old = prev?.id ? getRow(cc.db, prev.id) : null
  if (old && old.kind === 'anthropic-oauth') {
    cc.db.transaction(() => writeSecret(cc, old.id, 'anthropic-oauth', secret, { fingerprint: fp, status, status_code: rejected ? 'upstream_401' : null, limited_until: null, expires_at: expires, checked_at: null, meta: JSON.stringify({ issuedAt: new Date(issued).toISOString(), from: 'claude-oauth-token' }) }))()
    setSetting(cc.db, FILE_TOKEN_KEY, { id: old.id, fp })
    audit(cc.db, { actor: null, action: 'credential.secret_replaced', target: old.id, detail: { kind: 'anthropic-oauth', from: 'claude-oauth-token', verified: false } })
    return 'updated'
  }
  const id = insertRow(cc, { kind: 'anthropic-oauth', label: label(cc, 'claude'), secret, ownerUserId: null, priority: 100, assignments: [], createdBy: null,
    meta: { issuedAt: new Date(issued).toISOString(), from: 'claude-oauth-token' }, expiresAt: expires, status, statusCode: rejected ? 'upstream_401' : null })
  setSetting(cc.db, FILE_TOKEN_KEY, { id, fp })
  audit(cc.db, { actor: null, action: 'credential.migrated', target: id, detail: { from: 'claude-oauth-token' } })
  return 'imported'
}

/** engine_accounts (company keys of the older proxy mode) -> API key connections with the same ids */
export function importEngineAccounts(cc: CredCtx, dataDir: string): string[] {
  const out: string[] = []
  const rows = cc.db.query('SELECT id, engine, secret_ref, label, status, hint FROM engine_accounts').all() as { id: string; engine: string; secret_ref: string; label: string | null; status: string; hint: string | null }[]
  for (const r of rows) {
    if (r.engine !== 'anthropic' && r.engine !== 'openai') continue
    if (getRow(cc.db, r.id)) continue
    if (!/^[A-Za-z0-9_.-]+$/.test(r.secret_ref)) continue
    let key: string | null = null
    try {
      const f = path.join(dataDir, 'secrets', r.secret_ref)
      const st = fs.lstatSync(f)
      if (!st.isFile()) continue
      const fd = fs.openSync(f, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      try { key = fs.readFileSync(fd, 'utf8').trim() } finally { fs.closeSync(fd) }
    } catch { continue }
    if (!key || key.length > 500) continue
    const kind = r.engine === 'anthropic' ? 'anthropic-api-key' as const : 'openai-api-key' as const
    if (kind === 'anthropic-api-key' && !ANTHROPIC_KEY_RE.test(key) && key.startsWith('sk-ant-oat')) continue
    if (duplicateOf(cc, kind, fingerprintOf(key))) continue
    insertRow(cc, { id: r.id, kind, label: r.label || label(cc, 'key'), secret: { key }, ownerUserId: null, priority: 200, assignments: [], createdBy: null,
      meta: { from: 'engine_accounts' }, status: r.status === 'invalid' ? 'invalid' : 'ok', statusCode: r.status === 'invalid' ? 'upstream_401' : null })
    audit(cc.db, { actor: null, action: 'credential.migrated', target: r.id, detail: { from: 'engine_accounts' } })
    out.push(r.id)
  }
  return out
}

/** the engine account's Codex login (launcher codex-export) -> a chatgpt connection; then the old login is removed */
export async function importCodexAuth(cc: CredCtx, launcherSock: string): Promise<'done' | 'none' | 'pending' | 'failed'> {
  const json = await codexExport(launcherSock).catch(() => undefined)
  if (json === undefined) return 'pending' // an older launcher, or it did not answer: next start
  if (json === null) return 'none'
  let a: { tokens?: Record<string, unknown>; last_refresh?: unknown }
  try { a = JSON.parse(json) } catch { return 'failed' }
  const t = a.tokens
  if (!t || typeof t.id_token !== 'string' || typeof t.access_token !== 'string' || typeof t.refresh_token !== 'string' || typeof t.account_id !== 'string') return 'failed'
  const claims = idClaims(t.id_token)
  const fp = fingerprintOf('chatgpt-account:' + t.account_id)
  if (!duplicateOf(cc, 'chatgpt', fp)) {
    const now = new Date(cc.now()).toISOString()
    const secret: Secrets['chatgpt'] = { idToken: t.id_token, accessToken: t.access_token, refreshToken: t.refresh_token, accountId: t.account_id, lastRefresh: typeof a.last_refresh === 'string' ? a.last_refresh : now }
    const exp = accessExpiry(secret.accessToken)
    const id = insertRow(cc, { kind: 'chatgpt', label: label(cc, 'chatgpt'), secret, ownerUserId: null, priority: 100, assignments: [], createdBy: null,
      meta: { planType: claims?.planType ?? null, accountRef: accountRef(t.account_id), emailMasked: maskEmail(claims?.email ?? null), fedramp: claims?.fedramp ?? false, lastRefreshAt: secret.lastRefresh, accessExpiresAt: exp ? new Date(exp).toISOString() : null, from: 'codex-auth' } })
    audit(cc.db, { actor: null, action: 'credential.migrated', target: id, detail: { from: 'codex-auth' } })
  }
  // stored (or already there): the engine account's copy goes, so no refresh token stays where an engine could read it
  const r = await codexLogout(launcherSock).catch(() => ({ ok: false }))
  return r.ok ? 'done' : 'failed'
}

/** Everything at start (synchronous parts); the Codex login when a launcher socket is given (prod). */
export async function migrateCredentials(cc: CredCtx, o: { secretsDir: string; dataDir: string; launcherSock?: string | null }): Promise<Migrated> {
  const prev = getSetting<Migrated>(cc.db, MIGRATED_KEY)
  const file = importTokenFile(cc, o.secretsDir)
  const accounts = importEngineAccounts(cc, o.dataDir)
  let codexAuth = prev?.codexAuth
  if (o.launcherSock && codexAuth !== 'done' && codexAuth !== 'none') codexAuth = await importCodexAuth(cc, o.launcherSock)
  const fileTok = getSetting<{ fp: string }>(cc.db, FILE_TOKEN_KEY)
  const next: Migrated = {
    at: prev?.at ?? new Date(cc.now()).toISOString(),
    ...(fileTok?.fp ? { claudeFile: fileTok.fp } : {}),
    accounts: [...new Set([...(prev?.accounts ?? []), ...accounts])],
    ...(codexAuth ? { codexAuth } : {}),
  }
  if (file !== 'same' || accounts.length || JSON.stringify(prev) !== JSON.stringify(next)) setSetting(cc.db, MIGRATED_KEY, next)
  return next
}
