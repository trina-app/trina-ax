// What the model proxy asks about AI connections (docs/DECISIONS.md "AI 연결" D3/D14). A request carries the turn's
// proxy token; the token row names the one connection chosen for that attempt (proxy_tokens.credential_id). The
// proxy never picks a connection from anything the engine sends (headers, account ids): token -> row -> connection.
// Every request reads the connection again, so switching it off or removing it stops the next request (T15), and its
// 401 / long 429 state belongs to that connection only (one subscription at its limit does not stop the others).
// The hosting service's trial credit (credentials/hosted-chat.ts) is bound the same way under HOSTED_CHAT_ID: checked
// before every request (cap, end, switch), its key put on as an Anthropic API key, its spend counted against the cap.
import type { CredentialKind } from '@mycel/shared/api'
import { audit } from '../admin/audit'
import { anthropicGateway, type AnthropicGatewayConf, type ModelUpstreams } from '../app-config'
import type { ProxyTurnEvent } from '../proxy/model-proxy'
import { ensureFresh } from './chatgpt-tokens'
import { ctAll, fmtTime } from './i18n'
import { costOf, setUnknownPriceHook, type ClaudeUsage, type OpenAiUsage } from './prices'
import { chargeHostedChat, HOSTED_CHAT_ID, hostedChatState, markHostedChatRefused, readHostedChatKey } from './hosted-chat'
import { candidates, familyOfKind, teamCredentialSummary, type Family } from './resolve'
import { memberOwnAllowed } from './policy'
import {
  admins, getRow, localDay, markInvalid, notifyOnce, ownerAndAdminsPlusOwnerOf, secretOf, unusable,
  type CredCtx, type CredRow, type Secrets,
} from './store'

export type Injection =
  | { type: 'anthropic-bearer'; token: string }
  | { type: 'anthropic-x-api-key'; key: string }
  | { type: 'openai-bearer'; key: string }
  | { type: 'chatgpt'; accessToken: string; accountId: string; fedramp: boolean }

export interface TokenBinding { credentialId: string | null; family: Family | null; turnId: string; userId: string }
export type ForRequest =
  | { ok: true; credentialId: string; kind: CredentialKind; inject: Injection; upstream: string }
  | { ok: false; status: 401 | 403 | 502; type: string; message: string; event: ProxyTurnEvent | null; retryAfter?: number }

export interface CredentialBroker {
  readonly upstreams: ModelUpstreams
  /** engine.anthropicGateway: the anthropic family goes there (upstreams.anthropic), on its models only (the proxy's
   * allow-list); absent or null = Anthropic */
  readonly gateway?: AnthropicGatewayConf | null
  /** the connection bound to this token, if it can be used now, and what to put on the request */
  forRequest(t: TokenBinding, want: Family): Promise<ForRequest>
  /** the upstream answered 401. API keys and Claude tokens: marked refused ('refused'). ChatGPT: refreshed once (or
   * already refreshed by another request): 'retry' = send again with the new token; 'refused' = the sign-in is gone
   * (marked needs_reconnect); 'temporary' = the refresh failed for now (nothing changed). */
  onUnauthorized(credentialId: string, sentAccess: string): Promise<'retry' | 'refused' | 'temporary'>
  /** refused for good (after a retry still 401, or a plan without Codex) */
  markInvalid(credentialId: string, code: string, upstreamStatus: number | null): void
  /** a long limit (subscription 5-hour / weekly, out of credit): no request goes out on it until then */
  onLongLimit(credentialId: string, until: Date, code?: string): void
  /** usage of one request: the turn's totals, the connection's day, last used; cost from the price table */
  record(credentialId: string, turnId: string, model: string, usage: ClaudeUsage | OpenAiUsage): void
  /** the proxy saw an answer that worked: the connection is verified now */
  succeeded(credentialId: string): void
}

/** callbacks after usage was recorded (budget notices, monthly limits): (userId, credentialId) */
export function onUsage(cc: CredCtx, fn: (userId: string, credentialId: string) => void) {
  ((cc.extra.afterUsage ??= []) as ((u: string, c: string) => void)[]).push(fn)
}

const LIMIT_AUDIT_MS = 10 * 60_000

export function createBroker(cc: CredCtx): CredentialBroker {
  const gateway = anthropicGateway(cc.config)
  setUnknownPriceHook((model) => {
    audit(cc.db, { actor: null, action: 'credential.unknown_price', target: null, detail: { model: model.slice(0, 100) } })
    cc.log.warn('a model has no price: its cost is counted at the most expensive price of its family', { model: model.slice(0, 100), ...(gateway ? { hint: 'engine.anthropicGateway.prices' } : {}) })
  })
  const limitAudited = new Map<string, number>()
  const add = cc.db.query("UPDATE turns SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cost_usd = COALESCE(cost_usd, 0) + ?, usage_source = 'proxy' WHERE id = ?")
  const day = cc.db.query(`INSERT INTO credential_usage_daily (credential_id, day, requests, input_tokens, output_tokens, cost_usd) VALUES (?, ?, 1, ?, ?, ?)
    ON CONFLICT(credential_id, day) DO UPDATE SET requests = requests + 1, input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens, cost_usd = cost_usd + excluded.cost_usd`)
  const used = cc.db.query('UPDATE engine_credentials SET last_used_at = ?, checked_at = COALESCE(checked_at, ?) WHERE id = ?')
  const fail = (status: 401 | 403 | 502, type: string, message: string, event: ProxyTurnEvent | null, retryAfter?: number): ForRequest => ({ ok: false, status, type, message, event, ...(retryAfter ? { retryAfter } : {}) })

  return {
    upstreams: cc.upstreams,
    gateway,

    async forRequest(t, want) {
      if (!t.credentialId || t.family !== want) return fail(403, 'permission_error', 'this token is not bound to an AI connection of this kind', { type: 'auth' })
      if (t.credentialId === HOSTED_CHAT_ID) {
        // the trial credit: refused before anything is sent once its cap is used, it ended or was switched off (or a
        // gateway took over Claude requests: a direct Anthropic key never goes there)
        const state = want === 'anthropic' ? hostedChatState(cc.db, new Date(cc.now()), cc.allowedKinds) : null
        if (state !== 'active') return fail(403, 'permission_error', state === 'used' ? 'trial_credit_used' : 'trial_ended', { type: 'trial', reason: state === 'used' ? 'used' : 'ended' })
        const key = readHostedChatKey(cc)
        if (!key) return fail(403, 'permission_error', 'trial_ended', { type: 'trial', reason: 'ended' })
        return { ok: true, credentialId: HOSTED_CHAT_ID, kind: 'anthropic-api-key', inject: { type: 'anthropic-x-api-key', key }, upstream: cc.upstreams.anthropic }
      }
      const row = getRow(cc.db, t.credentialId)
      if (!row || familyOfKind(row.kind) !== want) return fail(403, 'permission_error', 'credential_gone', { type: 'credential', credentialId: t.credentialId, reason: 'gone' })
      // A token binds an identity, not a permanent grant. Recheck personal/assignment policy on every request.
      if (!candidates(cc.db, t.userId, want === 'anthropic' ? 'claude-code' : 'codex').some((c) => c.row.id === row.id)) {
        return fail(403, 'permission_error', 'credential_not_authorized', { type: 'credential', credentialId: row.id, reason: 'gone' })
      }
      const now = new Date(cc.now())
      const u = unusable(cc.db, row, now, cc.allowedKinds)
      if (u) {
        if (u.why === 'limited') {
          const secs = Math.max(1, Math.ceil((Date.parse(u.retryAt!) - now.getTime()) / 1000))
          return fail(403, 'permission_error', 'subscription_limited', { type: 'rate_limit', retryAt: u.retryAt, credentialId: row.id }, secs)
        }
        const reason = u.why === 'invalid' || u.why === 'expired' ? 'invalid' : u.why === 'needs_reconnect' ? 'needs_reconnect' : u.why === 'over_limit' ? 'over_limit' : 'gone'
        return fail(403, 'permission_error', `credential_${reason}`, { type: 'credential', credentialId: row.id, reason })
      }
      if (row.kind === 'chatgpt') {
        const f = await ensureFresh(cc, row.id)
        if (!f.ok) return f.permanent
          ? fail(403, 'permission_error', 'credential_needs_reconnect', { type: 'credential', credentialId: row.id, reason: 'needs_reconnect' })
          : fail(502, 'api_error', 'the sign-in could not be refreshed right now', null)
        // Refresh awaits provider I/O. An owner may revoke sharing or an assignment while it is pending.
        const current = getRow(cc.db, row.id)
        if (!current || unusable(cc.db, current, new Date(cc.now()), cc.allowedKinds)
          || !candidates(cc.db, t.userId, 'codex').some((c) => c.row.id === row.id)) {
          return fail(403, 'permission_error', 'credential_not_authorized', { type: 'credential', credentialId: row.id, reason: 'gone' })
        }
        return { ok: true, credentialId: row.id, kind: row.kind, inject: { type: 'chatgpt', accessToken: f.accessToken, accountId: f.accountId, fedramp: f.fedramp }, upstream: cc.upstreams.chatgpt }
      }
      const s = secretOf(cc, row as CredRow & { kind: Exclude<CredentialKind, 'chatgpt'> })
      if (!s) return fail(403, 'permission_error', 'credential_needs_reconnect', { type: 'credential', credentialId: row.id, reason: 'needs_reconnect' })
      if (row.kind === 'anthropic-oauth') return { ok: true, credentialId: row.id, kind: row.kind, inject: { type: 'anthropic-bearer', token: (s as Secrets['anthropic-oauth']).token }, upstream: cc.upstreams.anthropic }
      if (row.kind === 'anthropic-api-key') return { ok: true, credentialId: row.id, kind: row.kind, inject: { type: 'anthropic-x-api-key', key: (s as Secrets['anthropic-api-key']).key }, upstream: cc.upstreams.anthropic }
      return { ok: true, credentialId: row.id, kind: row.kind, inject: { type: 'openai-bearer', key: (s as Secrets['openai-api-key']).key }, upstream: cc.upstreams.openai }
    },

    async onUnauthorized(credentialId, sentAccess) {
      if (credentialId === HOSTED_CHAT_ID) {
        // Anthropic refused the hosting service's key: no request goes out with it until a new one comes
        if (markHostedChatRefused(cc.db, new Date(cc.now()))) {
          audit(cc.db, { actor: null, action: 'credential.rejected', target: HOSTED_CHAT_ID, detail: { kind: 'anthropic-api-key', upstreamStatus: 401, newStatus: 'invalid' } })
          cc.log.warn('the hosting service\'s trial AI key was refused by its provider', { credential: HOSTED_CHAT_ID })
        }
        return 'refused'
      }
      const row = getRow(cc.db, credentialId)
      if (!row) return 'refused'
      if (row.kind !== 'chatgpt') { markInvalid(cc, credentialId, 'upstream_401', 401); return 'refused' }
      // A late 401 must not start new maintenance after the owner withdrew permission.
      // An already-running refresh still persists rotated tokens; forRequest checks permission before use.
      if (unusable(cc.db, row, new Date(cc.now()), cc.allowedKinds)
        || row.owner_user_id !== null && !memberOwnAllowed(cc.db)) return 'refused'
      const f = await ensureFresh(cc, credentialId, { force: true, sentAccess })
      return f.ok ? 'retry' : f.permanent ? 'refused' : 'temporary'
    },

    markInvalid(credentialId, code, upstreamStatus) { markInvalid(cc, credentialId, code, upstreamStatus) },

    onLongLimit(credentialId, until, code) {
      const row = getRow(cc.db, credentialId)
      if (!row) return
      const iso = until.toISOString()
      if (!row.limited_until || row.limited_until < iso) {
        cc.db.query('UPDATE engine_credentials SET limited_until = ?, status_code = ? WHERE id = ?').run(iso, code ?? 'rate_limited', credentialId)
      }
      if (cc.now() - (limitAudited.get(credentialId) ?? 0) > LIMIT_AUDIT_MS) {
        limitAudited.set(credentialId, cc.now())
        audit(cc.db, { actor: null, action: 'credential.limited', target: credentialId, detail: { until: iso, ...(code ? { code } : {}) } })
      }
      // the owner and admins hear about it when it leaves the family without a usable team connection
      if (teamCredentialSummary(cc.db, familyOfKind(row.kind), cc.allowedKinds, new Date(cc.now())).usable === 0 || row.owner_user_id) {
        notifyOnce(cc, credentialId, { level: 'warn', code: 'credential_limited', message: { ko: ctAll('nLimited', { label: row.label, time: fmtTime(iso, 'ko') }).ko, en: ctAll('nLimited', { label: row.label, time: fmtTime(iso, 'en') }).en, id: ctAll('nLimited', { label: row.label, time: fmtTime(iso, 'id') }).id, ja: ctAll('nLimited', { label: row.label, time: fmtTime(iso, 'ja') }).ja, es: ctAll('nLimited', { label: row.label, time: fmtTime(iso, 'es') }).es }, link: '/admin/credentials' }, row.owner_user_id ? ownerAndAdminsPlusOwnerOf(cc, row) : admins(cc.db))
      }
    },

    record(credentialId, turnId, model, usage) {
      // the trial credit has no row: an Anthropic key at list price (never with a gateway), counted against its cap
      const trial = credentialId === HOSTED_CHAT_ID
      const row = trial ? null : getRow(cc.db, credentialId)
      if (!row && !trial) return
      const kind: CredentialKind = row?.kind ?? 'anthropic-api-key'
      const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0)
      const cost = costOf(kind, model, usage, trial ? null : gateway)
      let input: number, output: number
      if (familyOfKind(kind) === 'anthropic') {
        const u = usage as ClaudeUsage
        input = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens)
        output = n(u.output_tokens)
      } else {
        const u = usage as OpenAiUsage
        input = n(u.input_tokens); output = n(u.output_tokens)
      }
      const now = new Date(cc.now())
      add.run(input, output, cost, turnId)
      if (trial) chargeHostedChat(cc.db, cost)
      else {
        day.run(credentialId, localDay(now), input, output, cost)
        used.run(now.toISOString(), now.toISOString(), credentialId)
      }
      const userId = (cc.db.query('SELECT user_id FROM turns WHERE id = ?').get(turnId) as { user_id: string } | null)?.user_id
      if (userId) for (const fn of (cc.extra.afterUsage ?? []) as ((u: string, c: string) => void)[]) { try { fn(userId, credentialId) } catch (e) { cc.log.warn('usage hook failed', { err: e }) } }
    },

    succeeded(credentialId) {
      cc.db.query('UPDATE engine_credentials SET checked_at = ? WHERE id = ? AND checked_at IS NULL').run(new Date(cc.now()).toISOString(), credentialId)
    },
  }
}
