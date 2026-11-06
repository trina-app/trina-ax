// Connecting a subscription from the browser (docs/DECISIONS.md "AI 연결" D8 and "Claude 구독 연결: 브라우저에서"). The
// owner (or a member, for their own connection) presses "start"; the server asks the launcher to run the official CLI
// as the engine account in a one-off folder, through the model proxy with a one-time token that only the sign-in
// process may use and only towards its provider's sign-in host:
//   - ChatGPT: `codex login --device-auth` (auth.openai.com:443). The device address and code go to the person who
//     started it; when the login ends, the launcher hands the resulting auth.json to the server.
//   - Claude: `claude setup-token` on a terminal the launcher opened (platform.claude.com:443). The authorize address
//     goes to the person who started it; they approve in their own browser and paste the code Claude shows back here
//     (sealed in the browser, like a token); the launcher types it into the program and hands back the token it prints.
//     The server checks the token like a pasted one (count_tokens) and stores it through the same code.
// Progress goes over the WebSocket (credential.login) and GET .../credential-logins/:id, to the starter only. The
// tokens never pass the browser or the relay and nothing stays on the engine account (the folder goes in every case).
// One sign-in at a time per team (either kind); 16 minutes; a server restart forgets running sign-ins.
import crypto from 'node:crypto'
import type { CredentialAssignment, CredentialLogin, CredentialLoginKind, Locale } from '@mycel/shared/api'
import { audit } from '../admin/audit'
import type { AppContext } from '../context'
import { turnProxyUrl } from '../engine/claude'
import { codexProxyUrl } from '../engine/codex'
import { fail, HttpError } from '../http/errors'
import { claudeSignIn, codexSignIn, type SocketLauncher } from '../native'
import { CLAUDE_LOGIN_BOUND, CLAUDE_LOGIN_PENDING, CODEX_LOGIN_BOUND, CODEX_LOGIN_PENDING } from '../proxy/connect'
import { issueProxyToken, revokeProxyTokens } from '../proxy/model-proxy'
import { parseDeviceLogin } from '../system/codex-login'
import { ct } from './i18n'
import { memberOwnAllowed, sharedSubscriptionsAllowed } from './policy'
import { accessExpiry, accountRef, idClaims, maskEmail } from './openai-oauth'
import { createCredential, duplicateOf, insertRow, replaceSecret } from './service'
import { fingerprintOf, getRow, metaOf, noticeOwners, toCredential, writeSecret, type CredCtx, type Secrets } from './store'

export const LOGIN_TIMEOUT_MS = 16 * 60_000
/** forget finished sign-ins after this (GET of an old one = 404) */
const KEEP_FINISHED_MS = 30 * 60_000
/** the code the Claude page shows after approval: <authorization code>#<state> (the launcher checks the same) */
export const CLAUDE_LOGIN_CODE_RE = /^[A-Za-z0-9._~-]{1,512}#[A-Za-z0-9._~-]{1,512}$/
/** what never reaches a log (the launcher masks the same): sk-ant-…, and long runs of token characters with a digit, "_"
 * or "-" in them (a piece of a token on its own row); plain words stay readable */
export const maskTokenLike = (s: string) => s
  .replace(/sk-ant-[A-Za-z0-9_-]+/gi, (m) => `sk-ant-[masked ${m.length}]`)
  .replace(/[A-Za-z0-9_-]{16,}/g, (m) => (/[0-9_-]/.test(m) ? `[masked ${m.length}]` : m))
/** never anything token-shaped is typed into the program (the launcher refuses it too) */
export const claudeLoginCodeOk = (c: string) => CLAUDE_LOGIN_CODE_RE.test(c) && !/sk-ant-/i.test(c)

/** Anthropic's own authorize page with the manual redirect (the page that shows the code to paste), nothing else */
export function isClaudeAuthorizeUrl(s: string): boolean {
  try {
    const u = new URL(s)
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && ['claude.com', 'claude.ai', 'platform.claude.com'].includes(u.hostname)
      && u.pathname.endsWith('/oauth/authorize') && u.searchParams.get('redirect_uri') === 'https://platform.claude.com/oauth/code/callback'
  } catch {
    return false
  }
}

interface Login {
  loginId: string; kind: CredentialLoginKind; userId: string; locale: Locale; personal: boolean
  label: string; assignments: CredentialAssignment[]; priority: number; reconnectId: string | null
  state: CredentialLogin['state']; url: string | null; code: string | null; expiresAt: string
  credentialId: string | null; reason: string | null; endedAt: number | null
  /** the token is being checked and stored: a cancel now would not stop it */
  storing: boolean
  cancel(): void
  /** Claude: type the pasted code into the program */
  sendCode(code: string): void
}

export interface LoginDeps {
  /** the launcher socket, the CLI of this kind (codex / claude) and the proxy; null = cannot sign in here */
  launcher(kind: CredentialLoginKind): Promise<{ sock: string; bin: string; proxyPort: number } | null>
  /** how long a sign-in may take (default LOGIN_TIMEOUT_MS; tests) */
  timeoutMs?: number
  /** Claude: how long after the code the token may take (default: the launcher's 90 s; tests) */
  exchangeTimeoutMs?: number
}

/** Where the launcher, the CLI and the proxy are, for a running server. */
export function serverLoginDeps(ctx: AppContext, bin: (kind: CredentialLoginKind) => string | null): LoginDeps {
  return {
    async launcher(kind) {
      const b = bin(kind)
      if (!b) return null
      const core = await ctx.core().catch(() => null)
      const l = core?.launcher as SocketLauncher | null | undefined
      if (!core || !l?.path || !core.proxy?.ready) return null
      return { sock: l.path, bin: b, proxyPort: core.proxy.port }
    },
  }
}

class Logins {
  readonly all = new Map<string, Login>()
  constructor(private cc: CredCtx, private deps: LoginDeps) {}

  private timeout() { return this.deps.timeoutMs ?? LOGIN_TIMEOUT_MS }
  private api(l: Login): CredentialLogin {
    const row = l.credentialId ? getRow(this.cc.db, l.credentialId) : null
    return { loginId: l.loginId, kind: l.kind, state: l.state, url: l.url, code: l.code, expiresAt: l.expiresAt, credential: row ? toCredential(this.cc, row, l.locale) : null, reason: l.reason }
  }
  private send(l: Login) { this.cc.publish(l.userId, { type: 'credential.login', data: this.api(l) }) }
  /** a team sign-in stores a connection only if its starter is still an active owner or admin (demoted or disabled while it ran) */
  private mayConnectForTeam(userId: string): boolean {
    const u = this.cc.db.query('SELECT role, status, deleted_at FROM users WHERE id = ?').get(userId) as { role: string; status: string; deleted_at: string | null } | null
    return !!u && !u.deleted_at && u.status === 'active' && (u.role === 'owner' || u.role === 'admin')
  }
  /** Ends the running sign-ins of a person who lost the right to run them (demoted: their team ones; disabled: all).
   * One that is storing its token right now finishes by itself (the store step re-checks the role). */
  cancelFor(userId: string, o: { teamOnly: boolean }) {
    for (const l of this.all.values()) {
      if (l.userId !== userId || l.endedAt !== null || l.storing || (o.teamOnly && l.personal)) continue
      l.cancel(); this.end(l, 'cancelled', 'starter_lost_rights')
    }
  }
  private prune() {
    for (const [id, l] of this.all) if (l.endedAt !== null && this.cc.now() - l.endedAt > KEEP_FINISHED_MS) this.all.delete(id)
  }
  private end(l: Login, state: CredentialLogin['state'], reason: string | null) {
    if (l.endedAt !== null) return
    l.state = state; l.reason = reason; l.endedAt = this.cc.now()
    audit(this.cc.db, { actor: l.userId, action: 'credential.login', target: l.loginId, detail: { kind: l.kind, state, ...(reason ? { reason } : {}) } })
    this.send(l)
  }

  async start(i: { userId: string; locale: Locale; personal: boolean; label: string; assignments: CredentialAssignment[]; priority: number; reconnectId?: string; kind?: CredentialLoginKind }): Promise<CredentialLogin> {
    const { cc } = this
    const kind = i.kind ?? 'chatgpt'
    this.prune()
    if (!cc.allowedKinds.has(kind)) fail('validation', ct('kindNotAllowed', i.locale), { fields: { 'body.kind': 'not allowed on this server' } })
    if (i.personal ? !memberOwnAllowed(cc.db) : !sharedSubscriptionsAllowed(cc.db)) fail('forbidden', ct(i.personal ? 'memberOwnOff' : 'sharedSubscriptionsOff', i.locale))
    if (i.reconnectId) {
      const r = getRow(cc.db, i.reconnectId)
      if (!r || r.kind !== kind || (i.personal && r.owner_user_id !== i.userId) || (!i.personal && r.owner_user_id !== null)) fail('not_found')
    }
    if ([...this.all.values()].some((l) => l.endedAt === null)) fail('busy', ct('loginBusy', i.locale))
    const where = await this.deps.launcher(kind)
    if (!where) return fail('engine_unavailable', ct(kind === 'chatgpt' ? 'loginUnavailable' : 'claudeLoginUnavailable', i.locale))
    const loginId = crypto.randomBytes(18).toString('base64url')
    const l: Login = {
      loginId, kind, userId: i.userId, locale: i.locale, personal: i.personal, label: i.label, assignments: i.personal ? [] : i.assignments, priority: i.priority,
      reconnectId: i.reconnectId ?? null, state: 'starting', url: null, code: null, expiresAt: new Date(cc.now() + this.timeout()).toISOString(),
      credentialId: null, reason: null, endedAt: null, storing: false, cancel: () => {}, sendCode: () => {},
    }
    this.all.set(loginId, l)
    audit(cc.db, { actor: i.userId, action: 'credential.login', target: loginId, detail: { kind, state: 'starting', ...(i.reconnectId ? { reconnect: i.reconnectId } : {}) } })
    if (kind === 'chatgpt') this.runChatgpt(l, where)
    else this.runClaude(l, where)
    return this.api(l)
  }

  private runChatgpt(l: Login, where: { sock: string; bin: string; proxyPort: number }) {
    const { cc } = this
    // the one-time proxy token: valid only once bound to the login process (connect.ts), only to auth.openai.com:443
    const pending = CODEX_LOGIN_PENDING + l.loginId
    let bound: string | null = null
    const token = issueProxyToken(cc.db, pending, l.userId, { ttlMs: this.timeout() + 60_000 })
    let out = ''
    let authJson: string | null = null
    const run = codexSignIn(where.sock, { cmd: where.bin, proxy: codexProxyUrl(where.proxyPort, token), loginId: l.loginId, timeoutMs: this.timeout() }, {
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
          const result = this.storeChatgpt(l, authJson)
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
  }

  private runClaude(l: Login, where: { sock: string; bin: string; proxyPort: number }) {
    const { cc } = this
    // the one-time proxy token: valid only once bound to the sign-in process (connect.ts), only to
    // platform.claude.com:443 (the token exchange)
    const pending = CLAUDE_LOGIN_PENDING + l.loginId
    let bound: string | null = null
    const proxyToken = issueProxyToken(cc.db, pending, l.userId, { ttlMs: this.timeout() + 60_000 })
    let token: string | null = null
    let failed: string | null = null
    const run = claudeSignIn(where.sock, { cmd: where.bin, proxy: turnProxyUrl(where.proxyPort, proxyToken), loginId: l.loginId, timeoutMs: this.timeout(), exchangeTimeoutMs: this.deps.exchangeTimeoutMs }, {
      started: (pid) => { bound = CLAUDE_LOGIN_BOUND + pid; cc.db.query('UPDATE proxy_tokens SET turn_id = ? WHERE turn_id = ?').run(bound, pending) },
      url: (u) => {
        if (l.endedAt !== null || l.state !== 'starting') return
        // only Anthropic's own authorize page is shown to the person (a changed CLI printing another address is not)
        if (!isClaudeAuthorizeUrl(u)) { l.cancel(); this.end(l, 'failed', 'unexpected_url'); return }
        l.url = u; l.state = 'code'
        this.send(l)
      },
      // the launcher did not type the code (it was not waiting for one any more): say so instead of "checking" on
      code: (ok) => { if (!ok && l.endedAt === null && !l.storing) { l.cancel(); this.end(l, 'failed', 'code_refused') } },
      failed: (reason, detail) => {
        failed = reason
        // why, for whoever runs the server: it could not start (cli_exit, before the address: nothing secret on its
        // screen), or it ended after the code with no token block this server knows (token_unreadable: a new CLI
        // layout; the launcher masked everything token-like, and it is masked here once more)
        if (detail) cc.log.warn(reason === 'token_unreadable' ? 'Claude sign-in: setup-token ended after the code without a token block this server can read; its last screen rows (masked)' : 'Claude sign-in: setup-token ended before showing the address', { reason, screen: maskTokenLike(detail) })
      },
      token: (t) => { token = t },
    })
    l.cancel = run.cancel
    l.sendCode = run.sendCode
    void run.done.then(async (r) => {
      try {
        if (l.endedAt !== null) return
        if (token) {
          l.storing = true
          const result = await this.storeClaude(l, token)
          if (result.ok) { l.credentialId = result.id; this.end(l, 'done', null) } else this.end(l, 'failed', result.reason)
        } else if (failed) this.end(l, 'failed', failed)
        else if (r.message === 'timeout') this.end(l, 'expired', 'timeout')
        else if (r.message === 'stopped' || r.message === 'cancelled') this.end(l, 'cancelled', null)
        else this.end(l, 'failed', r.code === null ? 'launcher' : `exit_${r.code}`)
      } catch (e) {
        cc.log.error('storing a Claude sign-in failed', { err: e })
        this.end(l, 'failed', 'store')
      } finally {
        l.storing = false
        revokeProxyTokens(cc.db, pending)
        if (bound) revokeProxyTokens(cc.db, bound)
        token = null
      }
    })
  }

  /** check the login file and store (or reconnect) the connection */
  private storeChatgpt(l: Login, json: string): { ok: true; id: string } | { ok: false; reason: string } {
    const { cc } = this
    if (!l.personal && !this.mayConnectForTeam(l.userId)) return { ok: false, reason: 'policy_changed' }
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
      if (!r.owner_user_id) noticeOwners(cc, l.userId, 'replaced', r.label)
      return { ok: true, id: r.id }
    }
    if (duplicateOf(cc, 'chatgpt', fp)) return { ok: false, reason: 'same_account' }
    const id = insertRow(cc, { kind: 'chatgpt', label: l.label, secret, ownerUserId: l.personal ? l.userId : null, priority: l.priority, assignments: l.assignments, createdBy: l.userId, meta, checkedAt: now })
    audit(cc.db, { actor: l.userId, action: 'credential.create', target: id, detail: { kind: 'chatgpt', label: l.label, scope: l.personal ? 'personal' : 'team', assignments: l.assignments, priority: l.priority, planType: meta.planType, verified: true } })
    if (!l.personal) noticeOwners(cc, l.userId, 'added', l.label)
    return { ok: true, id }
  }

  /** The token setup-token printed, stored exactly like a pasted one (service.ts: format, the plan notice the start
   * asked for, the policies again, the count_tokens check, duplicates, the Activity log): a new connection, or the new
   * secret of the connection being reconnected. Its errors become the sign-in's reason, never a message with the token. */
  private async storeClaude(l: Login, token: string): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
    const { cc } = this
    if (!l.personal && !this.mayConnectForTeam(l.userId)) return { ok: false, reason: 'policy_changed' }
    // the policies again, now (as storeChatgpt): a reconnect goes through replaceSecret, which does not check them
    if (!cc.allowedKinds.has('anthropic-oauth') || (l.personal ? !memberOwnAllowed(cc.db) : !sharedSubscriptionsAllowed(cc.db))) return { ok: false, reason: 'policy_changed' }
    try {
      if (l.reconnectId) return { ok: true, id: (await replaceSecret(cc, l.reconnectId, token, l.userId, l.locale)).id }
      const c = await createCredential(cc, {
        kind: 'anthropic-oauth', label: l.label, secret: token, assignments: l.assignments, priority: l.priority,
        ownerUserId: l.personal ? l.userId : null, actor: l.userId, acknowledgedPlanNotice: true,
      }, l.locale)
      return { ok: true, id: c.id }
    } catch (e) {
      if (!(e instanceof HttpError)) throw e
      if (e.code === 'conflict') return { ok: false, reason: 'duplicate' }
      if (e.code === 'forbidden') return { ok: false, reason: 'policy_changed' }
      if (e.code === 'not_found') return { ok: false, reason: 'gone' }
      if (e.code === 'validation' && e.extra.fields?.['body.sealed'] === 'refused by the provider') return { ok: false, reason: 'refused' }
      if (e.code === 'validation' && e.extra.fields?.['body.kind']) return { ok: false, reason: 'policy_changed' }
      return { ok: false, reason: 'unreadable' }
    }
  }

  /** The code Claude showed after approval (already unsealed): typed into the program once, while it waits for it. */
  /** `personal`: which door the caller came through (/api/me or /api/admin); a sign-in is only reachable through its own */
  submitCode(loginId: string, userId: string, code: string, locale: Locale, personal?: boolean): CredentialLogin {
    const l = this.all.get(loginId)
    if (!l || l.userId !== userId || (personal !== undefined && l.personal !== personal)) return fail('not_found')
    if (!l.personal && !this.mayConnectForTeam(userId)) return fail('forbidden')
    if (l.kind !== 'anthropic-oauth' || l.endedAt !== null || l.state !== 'code') return fail('conflict', ct('loginNotWaiting', locale))
    const c = code.trim()
    if (!claudeLoginCodeOk(c)) return fail('validation', ct('badLoginCode', locale), { fields: { 'body.sealed': 'not the code Claude shows' } })
    l.state = 'checking'
    l.sendCode(c)
    this.send(l)
    return this.api(l)
  }

  get(loginId: string, userId: string, personal?: boolean): CredentialLogin {
    this.prune()
    const l = this.all.get(loginId)
    if (!l || l.userId !== userId || (personal !== undefined && l.personal !== personal)) return fail('not_found')
    return this.api(l)
  }

  /** `personal`: the door (see submitCode). `anyTeam`: the owner or an admin (the caller checked) stops any team sign-in,
   * not only their own: only one runs at a time, and a forgotten one would keep the others waiting for up to 16 minutes */
  cancel(loginId: string, userId: string, locale: Locale, personal?: boolean, anyTeam = false): void {
    const l = this.all.get(loginId)
    const others = anyTeam && !!l && !l.personal && personal === false
    if (!l || (l.userId !== userId && !others) || (personal !== undefined && l.personal !== personal)) return fail('not_found')
    if (l.userId !== userId && l.endedAt === null) audit(this.cc.db, { actor: userId, action: 'credential.login_cancel', target: loginId, detail: { by: 'other_admin', kind: l.kind, starter: l.userId } })
    // a token that is being checked and stored right now finishes: 409, the result comes in a moment (the screen keeps
    // the dialog and says so, instead of closing it and the connection appearing later)
    if (l.storing) return fail('conflict', ct('loginStoring', locale))
    if (l.endedAt === null) { l.cancel(); this.end(l, 'cancelled', null) }
  }
}

/** The running sign-ins of a person who lost the right to run them (admin/users.ts): none when this server never had one. */
export function cancelLoginsOf(cc: CredCtx, userId: string, o: { teamOnly: boolean }) {
  const m = cc.extra.logins as Logins | undefined
  if (m) m.cancelFor(userId, o)
}

/** the sign-ins of one server */
export function credentialLogins(cc: CredCtx, deps: LoginDeps): Logins {
  let m = cc.extra.logins as Logins | undefined
  if (!m) { m = new Logins(cc, deps); cc.extra.logins = m }
  return m
}
export type { Logins }
