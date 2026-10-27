// Connecting a ChatGPT plan from the browser (docs/DECISIONS.md "AI 연결" D8). The owner (or a member, for their own
// connection) presses "start"; the server asks the launcher to run the official `codex login --device-auth` as the
// engine account in a one-off folder, through the model proxy with a one-time token that only the login process may
// use and only towards auth.openai.com:443. The device address and code go to the person who started it, over the
// WebSocket (credential.login) and GET .../credential-logins/:id. When the login ends, the launcher hands the
// resulting auth.json to the server and deletes the folder; the server checks it, encrypts it and stores the
// connection. The tokens never pass the browser or the relay and nothing stays on the engine account.
// One sign-in at a time per team; 16 minutes (the code lasts 15); a server restart forgets running sign-ins.
import crypto from 'node:crypto'
import type { CredentialAssignment, CredentialLogin, Locale } from '@mycel/shared/api'
import { audit } from '../admin/audit'
import type { AppContext } from '../context'
import { codexProxyUrl } from '../engine/codex'
import { fail } from '../http/errors'
import { codexSignIn, type SocketLauncher } from '../native'
import { CODEX_LOGIN_BOUND, CODEX_LOGIN_PENDING } from '../proxy/connect'
import { issueProxyToken, revokeProxyTokens } from '../proxy/model-proxy'
import { parseDeviceLogin } from '../system/codex-login'
import { ct } from './i18n'
import { memberOwnAllowed, sharedSubscriptionsAllowed } from './policy'
import { accessExpiry, accountRef, idClaims, maskEmail } from './openai-oauth'
import { duplicateOf, insertRow } from './service'
import { fingerprintOf, getRow, metaOf, toCredential, writeSecret, type CredCtx, type Secrets } from './store'

export const LOGIN_TIMEOUT_MS = 16 * 60_000
/** forget finished sign-ins after this (GET of an old one = 404) */
const KEEP_FINISHED_MS = 30 * 60_000

interface Login {
  loginId: string; userId: string; locale: Locale; personal: boolean
  label: string; assignments: CredentialAssignment[]; priority: number; reconnectId: string | null
  state: CredentialLogin['state']; url: string | null; code: string | null; expiresAt: string
  credentialId: string | null; reason: string | null; endedAt: number | null
  cancel(): void
}

export interface LoginDeps {
  /** the launcher socket and the Codex binary; null = cannot sign in here */
  launcher(): Promise<{ sock: string; codexBin: string; proxyPort: number } | null>
}

/** Where the launcher, the Codex binary and the proxy are, for a running server. */
export function serverLoginDeps(ctx: AppContext, codexBin: () => string | null): LoginDeps {
  return {
    async launcher() {
      const bin = codexBin()
      if (!bin) return null
      const core = await ctx.core().catch(() => null)
      const l = core?.launcher as SocketLauncher | null | undefined
      if (!core || !l?.path || !core.proxy?.ready) return null
      return { sock: l.path, codexBin: bin, proxyPort: core.proxy.port }
    },
  }
}

class Logins {
  readonly all = new Map<string, Login>()
  constructor(private cc: CredCtx, private deps: LoginDeps) {}

  private api(l: Login): CredentialLogin {
    const row = l.credentialId ? getRow(this.cc.db, l.credentialId) : null
    return { loginId: l.loginId, state: l.state, url: l.url, code: l.code, expiresAt: l.expiresAt, credential: row ? toCredential(this.cc, row, l.locale) : null, reason: l.reason }
  }
  private send(l: Login) { this.cc.publish(l.userId, { type: 'credential.login', data: this.api(l) }) }
  private prune() {
    for (const [id, l] of this.all) if (l.endedAt !== null && this.cc.now() - l.endedAt > KEEP_FINISHED_MS) this.all.delete(id)
  }
  private end(l: Login, state: CredentialLogin['state'], reason: string | null) {
    if (l.endedAt !== null) return
    l.state = state; l.reason = reason; l.endedAt = this.cc.now()
    audit(this.cc.db, { actor: l.userId, action: 'credential.login', target: l.loginId, detail: { state, ...(reason ? { reason } : {}) } })
    this.send(l)
  }

  async start(i: { userId: string; locale: Locale; personal: boolean; label: string; assignments: CredentialAssignment[]; priority: number; reconnectId?: string }): Promise<CredentialLogin> {
    const { cc } = this
    this.prune()
    if (!cc.allowedKinds.has('chatgpt')) fail('validation', ct('kindNotAllowed', i.locale), { fields: { 'body.kind': 'not allowed on this server' } })
    if (i.personal ? !memberOwnAllowed(cc.db) : !sharedSubscriptionsAllowed(cc.db)) fail('forbidden', ct(i.personal ? 'memberOwnOff' : 'sharedSubscriptionsOff', i.locale))
    if (i.reconnectId) {
      const r = getRow(cc.db, i.reconnectId)
      if (!r || r.kind !== 'chatgpt' || (i.personal && r.owner_user_id !== i.userId) || (!i.personal && r.owner_user_id !== null)) fail('not_found')
    }
    if ([...this.all.values()].some((l) => l.endedAt === null)) fail('busy', ct('loginBusy', i.locale))
    const where = await this.deps.launcher()
    if (!where) return fail('engine_unavailable', ct('loginUnavailable', i.locale))
    const loginId = crypto.randomBytes(18).toString('base64url')
    const l: Login = {
      loginId, userId: i.userId, locale: i.locale, personal: i.personal, label: i.label, assignments: i.personal ? [] : i.assignments, priority: i.priority,
      reconnectId: i.reconnectId ?? null, state: 'starting', url: null, code: null, expiresAt: new Date(cc.now() + LOGIN_TIMEOUT_MS).toISOString(),
      credentialId: null, reason: null, endedAt: null, cancel: () => {},
    }
    this.all.set(loginId, l)
    audit(cc.db, { actor: i.userId, action: 'credential.login', target: loginId, detail: { state: 'starting', ...(i.reconnectId ? { reconnect: i.reconnectId } : {}) } })
    // the one-time proxy token: valid only once bound to the login process (connect.ts), only to auth.openai.com:443
    const pending = CODEX_LOGIN_PENDING + loginId
    let bound: string | null = null
    const token = issueProxyToken(cc.db, pending, i.userId, { ttlMs: LOGIN_TIMEOUT_MS + 60_000 })
    let out = ''
    let authJson: string | null = null
    const run = codexSignIn(where.sock, { cmd: where.codexBin, proxy: codexProxyUrl(where.proxyPort, token), loginId, timeoutMs: LOGIN_TIMEOUT_MS }, {
      started: (pid) => { bound = CODEX_LOGIN_BOUND + pid; cc.db.query('UPDATE proxy_tokens SET turn_id = ? WHERE turn_id = ?').run(bound, pending) },
      output: (text) => {
        if (l.state !== 'starting') return
        out += text
        if (out.length > 64 * 1024) out = out.slice(-32 * 1024)
        const d = parseDeviceLogin(out)
        if (d.url && d.code) {
          // only the provider's own sign-in page is shown to the person (a changed CLI printing another address is not)
          if (!d.url.startsWith('https://auth.openai.com/')) { l.cancel(); this.end(l, 'failed', 'unexpected_url'); return }
          l.url = d.url; l.code = d.code.slice(0, 20); l.state = 'code'
          this.send(l)
        }
      },
      auth: (json) => { authJson = json },
    })
    l.cancel = run.cancel
    void run.done.then((r) => {
      try {
        if (l.endedAt !== null) return
        if (authJson && r.code === 0) {
          const result = this.store(l, authJson)
          if (result.ok) { l.credentialId = result.id; this.end(l, 'done', null) } else this.end(l, 'failed', result.reason)
        } else if (r.message === 'timeout') this.end(l, 'expired', 'timeout')
        else if (r.message === 'stopped' || r.message === 'cancelled') this.end(l, 'cancelled', null)
        else this.end(l, 'failed', r.code === null ? 'launcher' : `exit_${r.code}`)
      } catch (e) {
        cc.log.error('storing a ChatGPT sign-in failed', { err: e })
        this.end(l, 'failed', 'store')
      } finally {
        revokeProxyTokens(cc.db, pending)
        if (bound) revokeProxyTokens(cc.db, bound)
        authJson = null
      }
    })
    return this.api(l)
  }

  /** check the login file and store (or reconnect) the connection */
  private store(l: Login, json: string): { ok: true; id: string } | { ok: false; reason: string } {
    const { cc } = this
    if (!cc.allowedKinds.has('chatgpt') || (l.personal ? !memberOwnAllowed(cc.db) : !sharedSubscriptionsAllowed(cc.db))) return { ok: false, reason: 'policy_changed' }
    let a: { tokens?: { id_token?: unknown; access_token?: unknown; refresh_token?: unknown; account_id?: unknown }; last_refresh?: unknown }
    try { a = JSON.parse(json) } catch { return { ok: false, reason: 'unreadable' } }
    const t = a.tokens
    if (!t || typeof t.id_token !== 'string' || typeof t.access_token !== 'string' || typeof t.refresh_token !== 'string' || typeof t.account_id !== 'string' || !t.account_id) return { ok: false, reason: 'incomplete' }
    const claims = idClaims(t.id_token)
    if (!claims || claims.accountId !== t.account_id) return { ok: false, reason: 'account_mismatch' }
    const now = new Date(cc.now()).toISOString()
    const secret: Secrets['chatgpt'] = { idToken: t.id_token, accessToken: t.access_token, refreshToken: t.refresh_token, accountId: t.account_id, lastRefresh: typeof a.last_refresh === 'string' ? a.last_refresh : now }
    const exp = accessExpiry(secret.accessToken)
    const meta = { planType: claims.planType, accountRef: accountRef(t.account_id), emailMasked: maskEmail(claims.email), fedramp: claims.fedramp, lastRefreshAt: secret.lastRefresh, accessExpiresAt: exp ? new Date(exp).toISOString() : null }
    const fp = fingerprintOf('chatgpt-account:' + t.account_id)
    if (l.reconnectId) {
      const r = getRow(cc.db, l.reconnectId)
      if (!r) return { ok: false, reason: 'gone' }
      if (metaOf(r).accountRef !== meta.accountRef) return { ok: false, reason: 'other_account' }
      cc.db.transaction(() => writeSecret(cc, r.id, 'chatgpt', secret, { meta: JSON.stringify({ ...metaOf(r), ...meta }), status: 'ok', status_code: null, limited_until: null, checked_at: now, fingerprint: fp }))()
      audit(cc.db, { actor: l.userId, action: 'credential.secret_replaced', target: r.id, detail: { kind: 'chatgpt', planType: meta.planType, verified: true } })
      return { ok: true, id: r.id }
    }
    if (duplicateOf(cc, 'chatgpt', fp)) return { ok: false, reason: 'same_account' }
    const id = insertRow(cc, { kind: 'chatgpt', label: l.label, secret, ownerUserId: l.personal ? l.userId : null, priority: l.priority, assignments: l.assignments, createdBy: l.userId, meta, checkedAt: now })
    audit(cc.db, { actor: l.userId, action: 'credential.create', target: id, detail: { kind: 'chatgpt', label: l.label, scope: l.personal ? 'personal' : 'team', assignments: l.assignments, priority: l.priority, planType: meta.planType, verified: true } })
    return { ok: true, id }
  }

  get(loginId: string, userId: string): CredentialLogin {
    this.prune()
    const l = this.all.get(loginId)
    if (!l || l.userId !== userId) return fail('not_found')
    return this.api(l)
  }

  cancel(loginId: string, userId: string): void {
    const l = this.all.get(loginId)
    if (!l || l.userId !== userId) return fail('not_found')
    if (l.endedAt === null) { l.cancel(); this.end(l, 'cancelled', null) }
  }
}

/** the sign-ins of one server */
export function credentialLogins(cc: CredCtx, deps: LoginDeps): Logins {
  let m = cc.extra.logins as Logins | undefined
  if (!m) { m = new Logins(cc, deps); cc.extra.logins = m }
  return m
}
export type { Logins }
