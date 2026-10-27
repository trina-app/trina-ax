// ChatGPT token refresh, done by the server only (docs/DECISIONS.md "AI 연결" D10). Refresh tokens rotate and a
// reused one can sign the whole account out, so: one refresh per connection at a time (single-flight), the rotated
// refresh token is written to the database (encrypted, same transaction as the rest) BEFORE the new access token is
// used, and a refusal (invalid_grant, refresh_token_expired / _reused / _invalidated, 401) marks the connection
// "needs reconnect" and stops sending its requests. A temporary failure (5xx, network) changes nothing: that request
// gets a 502 and the engine tries again. Codex itself never refreshes: its auth.json holds placeholders and its
// refresh address points at the proxy, which refuses (proxy/codex-path.ts).
import { audit } from '../admin/audit'
import { memberOwnAllowed, sharedSubscriptionsAllowed } from './policy'
import { accessExpiry, CODEX_CLIENT_ID, idClaims, REFRESH_BEFORE_EXP_MS, REFRESH_EVERY_MS, REFRESH_PATH } from './openai-oauth'
import { getRow, localDay, markNeedsReconnect, metaOf, secretOf, writeSecret, type CredCtx, type CredRow, type Secrets } from './store'

const REFRESH_TIMEOUT_MS = 15_000
const PERMANENT_CODES = new Set(['invalid_grant', 'refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated'])

export type Fresh =
  | { ok: true; accessToken: string; accountId: string; fedramp: boolean; refreshed: boolean }
  | { ok: false; permanent: boolean; reason: string }

interface State { inflight: Map<string, Promise<Fresh>>; auditedDay: Map<string, string>; tempAudited: Map<string, number> }
function state(cc: CredCtx): State {
  return (cc.extra.chatgpt ??= { inflight: new Map(), auditedDay: new Map(), tempAudited: new Map() }) as State
}

/** Does this login need a refresh before its next request? (Codex's own rule: access token ends within 5 minutes, or
 * the last refresh is older than 8 days.) */
export function needsRefresh(s: Secrets['chatgpt'], now: number): boolean {
  const exp = accessExpiry(s.accessToken)
  if (exp !== null && exp - now <= REFRESH_BEFORE_EXP_MS) return true
  const last = s.lastRefresh ? Date.parse(s.lastRefresh) : NaN
  return Number.isFinite(last) && now - last > REFRESH_EVERY_MS
}

/**
 * The access token to use now, refreshing first when needed. `force`: refresh regardless (after an upstream 401);
 * `sentAccess`: the token that got the 401; when the stored one differs, another request refreshed already and
 * that one is returned without a new refresh.
 */
export async function ensureFresh(cc: CredCtx, id: string, o: { force?: boolean; sentAccess?: string } = {}): Promise<Fresh> {
  const st = state(cc)
  const running = st.inflight.get(id)
  if (running) return running
  const row = getRow(cc.db, id)
  if (!row || row.kind !== 'chatgpt') return { ok: false, permanent: true, reason: 'gone' }
  if (row.status === 'needs_reconnect') return { ok: false, permanent: true, reason: row.status_code ?? 'needs_reconnect' }
  const s = secretOf(cc, row as CredRow & { kind: 'chatgpt' })
  if (!s) return { ok: false, permanent: true, reason: 'decrypt_failed' }
  const fedramp = metaOf(row).fedramp === true
  if (o.sentAccess !== undefined && s.accessToken !== o.sentAccess) return { ok: true, accessToken: s.accessToken, accountId: s.accountId, fedramp, refreshed: false }
  if (!o.force && !needsRefresh(s, cc.now())) return { ok: true, accessToken: s.accessToken, accountId: s.accountId, fedramp, refreshed: false }
  const p = refresh(cc, row, s, fedramp).finally(() => st.inflight.delete(id))
  st.inflight.set(id, p)
  return p
}

async function refresh(cc: CredCtx, row: CredRow, s: Secrets['chatgpt'], fedramp: boolean): Promise<Fresh> {
  const st = state(cc)
  let r: Response
  try {
    r = await cc.fetch(`${cc.upstreams.openaiAuth}${REFRESH_PATH}`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', client_id: CODEX_CLIENT_ID, refresh_token: s.refreshToken }),
    })
  } catch {
    return temporary(cc, row.id, 'network')
  }
  let j: Record<string, unknown> = {}
  try { j = await r.json() as Record<string, unknown> } catch {}
  if (r.status >= 200 && r.status < 300 && typeof j.access_token === 'string' && j.access_token) {
    const now = new Date(cc.now())
    const rotated = typeof j.refresh_token === 'string' && j.refresh_token !== '' && j.refresh_token !== s.refreshToken
    const next: Secrets['chatgpt'] = {
      idToken: typeof j.id_token === 'string' && j.id_token ? j.id_token : s.idToken,
      accessToken: j.access_token,
      refreshToken: rotated ? (j.refresh_token as string) : s.refreshToken,
      accountId: s.accountId,
      lastRefresh: now.toISOString(),
    }
    const claims = idClaims(next.idToken)
    const meta = metaOf(row)
    const exp = accessExpiry(next.accessToken)
    const newMeta = { ...meta, planType: claims?.planType ?? meta.planType ?? null, lastRefreshAt: now.toISOString(), accessExpiresAt: exp ? new Date(exp).toISOString() : null }
    // the new refresh token is in the database before anything uses the new access token
    cc.db.transaction(() => writeSecret(cc, row.id, 'chatgpt', next, { meta: JSON.stringify(newMeta), ...(row.status === 'invalid' ? {} : { status: 'ok', status_code: null }) }))()
    const day = localDay(now)
    if (st.auditedDay.get(row.id) !== day) {
      st.auditedDay.set(row.id, day)
      audit(cc.db, { actor: null, action: 'credential.refreshed', target: row.id, detail: { rotated } })
    }
    return { ok: true, accessToken: next.accessToken, accountId: next.accountId, fedramp, refreshed: true }
  }
  const err = typeof j.error === 'object' && j.error ? (j.error as Record<string, unknown>) : null
  const code = String((err?.code ?? j.code ?? (typeof j.error === 'string' ? j.error : '')) || '')
  if (r.status === 401 || (r.status === 400 && (PERMANENT_CODES.has(code) || code === ''))) {
    const reason = PERMANENT_CODES.has(code) ? code : r.status === 401 ? 'http_401' : 'invalid_grant'
    markNeedsReconnect(cc, row.id, reason)
    audit(cc.db, { actor: null, action: 'credential.refresh_failed', target: row.id, detail: { reason } })
    cc.log.warn('the ChatGPT sign-in of an AI connection was refused at refresh', { credential: row.id, reason })
    return { ok: false, permanent: true, reason }
  }
  return temporary(cc, row.id, `http_${r.status}`)
}

function temporary(cc: CredCtx, id: string, reason: string): Fresh {
  const st = state(cc)
  if (cc.now() - (st.tempAudited.get(id) ?? 0) > 3600_000) {
    st.tempAudited.set(id, cc.now())
    audit(cc.db, { actor: null, action: 'credential.refresh_failed', target: id, detail: { reason } })
  }
  cc.log.warn('ChatGPT token refresh failed for now', { credential: id, reason })
  return { ok: false, permanent: false, reason }
}

/** Once a day: ChatGPT connections nobody used for 8 days are refreshed (a refresh token that is never used dies). */
export async function refreshIdle(cc: CredCtx): Promise<number> {
  let n = 0
  const rows = cc.db.query("SELECT id FROM engine_credentials WHERE kind = 'chatgpt' AND status = 'ok' AND disabled = 0").all() as { id: string }[]
  for (const { id } of rows) {
    const row = getRow(cc.db, id)
    if (!row || !cc.allowedKinds.has(row.kind) || !(row.owner_user_id ? memberOwnAllowed(cc.db) : sharedSubscriptionsAllowed(cc.db))) continue
    const s = secretOf(cc, row as CredRow & { kind: 'chatgpt' })
    if (!s) continue
    const last = s.lastRefresh ? Date.parse(s.lastRefresh) : 0
    if (cc.now() - last <= REFRESH_EVERY_MS) continue
    const r = await ensureFresh(cc, id, { force: true })
    if (r.ok) n++
  }
  return n
}

