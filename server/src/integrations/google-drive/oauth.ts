import crypto from 'node:crypto'
import path from 'node:path'
import type { AppContext } from '../../context'
import { newId } from '../../db'
import { audit } from '../../admin/audit'
import { resolveLayout } from '../../system/layout'
import { DRIVE_SCOPE, configKey, hash, readDriveConfig, type DriveConfig } from './config'
import { GoogleTransport, GOOGLE_AUTH, GOOGLE_TOKEN, GOOGLE_REVOKE, DRIVE_API, checkAbort, responseError, waitFor, backoff, type DriveFetch } from './client'
import { DriveStore, DriveError, type Account, type Tokens, type FlowSecret, type ConnectionRow } from './store'
import type { DriveFlow } from '@mycel/shared/api'
import { notifyConnectionReconnect } from '../../notifications/service'

export interface DriveDeps { config?: DriveConfig | null; fetch?: DriveFetch; now?: () => number }
const TTL = 10 * 60_000
const clean = (s: unknown, max: number) => typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : null
export class GoogleDrive {
  readonly config: DriveConfig | null
  readonly key: string
  readonly store: DriveStore
  readonly transport: GoogleTransport
  readonly now: () => number
  private refreshes = new Map<string, Promise<Tokens>>()
  private operations = new Map<string, Set<AbortController>>()
  private revoking = new Set<string>()
  constructor(readonly ctx: AppContext, deps: DriveDeps = {}) {
    this.now = deps.now ?? Date.now
    const dir = path.join(resolveLayout(ctx.config).secretsDir, 'integrations', 'google-drive')
    this.config = deps.config !== undefined ? deps.config : readDriveConfig(process.env.MYCEL_GOOGLE_DRIVE_CLIENT_FILE ?? path.join(dir, 'client.json'), ctx.config.teamRoot)
    this.key = this.config ? configKey(this.config) : ''
    this.store = new DriveStore(ctx.db, dir, this.now)
    this.transport = new GoogleTransport(deps.fetch)
    const sweep = () => { try { this.store.sweep() } catch { ctx.log.warn('Drive flow cleanup deferred') } }
    sweep()
    const timer = setInterval(sweep, 60_000); timer.unref?.()
    ctx.onClose(() => { clearInterval(timer); for (const set of this.operations.values()) for (const c of set) c.abort() })
  }
  status(user: string) {
    const status = this.store.publicConnection(!!this.config, user, this.key)
    if (status.status === 'needs_reconnect') {
      const row = this.store.connection(user)
      if (row) this.invalidate(row)
    }
    return status
  }
  /** Keep cancellation registered throughout a tool's download and conversion. */
  run<T>(user: string, signal: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<T>) { return this.operation(user, signal, fn) }
  private configured() { if (!this.config) throw new DriveError('not_configured', 503); return this.config }
  private busy(user: string) { if (this.revoking.has(user)) throw new DriveError('disconnecting', 409) }
  private async operation<T>(user: string, outer: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const c = new AbortController(), set = this.operations.get(user) ?? new Set<AbortController>()
    set.add(c); this.operations.set(user, set)
    const signal = AbortSignal.any([c.signal, ...(outer ? [outer] : [])])
    try { checkAbort(signal); return await fn(signal) }
    finally { set.delete(c); if (!set.size) this.operations.delete(user) }
  }
  authorize(user: string, session: string) {
    const cfg = this.configured(); this.busy(user); this.store.session(user, session); this.store.sweep()
    const now = this.now(), id = newId(), state = crypto.randomBytes(32).toString('base64url'), verifier = crypto.randomBytes(48).toString('base64url')
    // Bound creation rate without retaining a plaintext verifier or authorization URL.
    const n = (this.ctx.db.query('SELECT count(*) n FROM drive_oauth_flows WHERE user_id=? AND created_at>?').get(user, new Date(now - 3600_000).toISOString()) as { n: number }).n
    if (n >= 20) throw new DriveError('rate_limited', 429)
    const sealed = this.store.seal(user, id, { verifier })
    const expiresAt = new Date(now + TTL).toISOString()
    this.ctx.db.transaction(() => {
      this.ctx.db.query("UPDATE drive_oauth_flows SET state='failed',reason='superseded',secret_enc=NULL,account=NULL WHERE user_id=? AND state IN ('pending','exchanging','ready')").run(user)
      this.ctx.db.query(`INSERT INTO drive_oauth_flows(id,user_id,session_id,state_hash,config_key,state,secret_enc,key_version,expires_at,created_at) VALUES(?,?,?,?,?,'pending',?,?,?,?)`)
        .run(id, user, session, hash(state), this.key, sealed.enc, sealed.keyVersion, expiresAt, new Date(now).toISOString())
    })()
    const url = new URL(GOOGLE_AUTH)
    for (const [k, v] of Object.entries({ client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: 'code', scope: DRIVE_SCOPE, access_type: 'offline', prompt: 'consent', state, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })) url.searchParams.set(k, v)
    return { flowId: id, authorizationUrl: url.href, expiresAt }
  }
  flow(user: string, session: string, id: string): DriveFlow {
    const r = this.store.ownFlow(user, session, id)
    const a = r.account ? JSON.parse(r.account) as Account : null
    return { flowId: r.id, state: r.state, account: a ? { name: a.name, email: a.email } : null, expiresAt: r.expires_at, reason: r.reason }
  }
  cancel(user: string, session: string, id: string) {
    this.store.ownFlow(user, session, id)
    this.ctx.db.query("UPDATE drive_oauth_flows SET state='failed',reason='cancelled',secret_enc=NULL,account=NULL WHERE id=? AND state!='completed'").run(id)
  }
  async callback(input: { state?: string; code?: string; error?: string }, browser?: { userId: string; sessionId: string }): Promise<boolean> {
    this.configured(); this.store.sweep()
    if (!input.state || !/^[A-Za-z0-9_-]{43}$/.test(input.state)) throw new DriveError('invalid_flow')
    const r = this.ctx.db.query('SELECT * FROM drive_oauth_flows WHERE state_hash=?').get(hash(input.state)) as ReturnType<DriveStore['flow']>
    if (!r || r.state !== 'pending' || r.config_key !== this.key) throw new DriveError('invalid_flow')
    // A leaked authorization URL must not let its creator claim somebody else's Google consent.
    // The system browser must itself be authenticated to the same team person; polling alone proves nothing.
    if (!browser || browser.userId !== r.user_id) throw new DriveError('browser_session_required', 401)
    this.store.session(browser.userId, browser.sessionId)
    this.store.session(r.user_id, r.session_id); this.busy(r.user_id)
    if (!this.ctx.db.query("UPDATE drive_oauth_flows SET state='exchanging' WHERE id=? AND state='pending'").run(r.id).changes) throw new DriveError('invalid_flow')
    try {
      if (input.error) throw new DriveError('consent_denied')
      if (!input.code || input.code.length > 4096) throw new DriveError('invalid_flow')
      const s = this.store.open<FlowSecret>(r), cfg = this.config!
      const result = await this.operation(r.user_id, undefined, async signal => {
        const json = await this.exchange({ grant_type: 'authorization_code', code: input.code!, redirect_uri: cfg.redirectUri, code_verifier: s.verifier }, signal)
        const scopes = typeof json.scope === 'string' ? json.scope.split(/\s+/) : []
        if (!scopes.includes(DRIVE_SCOPE)) throw new DriveError('scope_denied')
        const tokens = this.tokens(json)
        const about = await this.transport.json(DRIVE_API + 'about?fields=user(permissionId,displayName,emailAddress)', { headers: { Authorization: `Bearer ${tokens.accessToken}` }, signal })
        const a = about.user
        if (!a || typeof a.permissionId !== 'string' || !a.permissionId || a.permissionId.length > 256) throw new DriveError('invalid_provider_response', 502)
        const account: Account = { subject: a.permissionId, name: clean(a.displayName, 200), email: clean(a.emailAddress, 320) }
        checkAbort(signal)
        return { verifier: '', tokens, account, scopes }
      })
      this.store.session(r.user_id, r.session_id)
      const current = this.store.flow(r.id)
      if (!current || current.state !== 'exchanging' || current.expires_at <= new Date(this.now()).toISOString()) throw new DriveError('invalid_flow')
      const sealed = this.store.seal(r.user_id, r.id, result)
      this.ctx.db.query("UPDATE drive_oauth_flows SET state='ready',secret_enc=?,key_version=?,account=? WHERE id=? AND state='exchanging'").run(sealed.enc, sealed.keyVersion, JSON.stringify(result.account), r.id)
      return true
    } catch (e) {
      const reason = e instanceof DriveError ? e.reason : 'provider_unavailable'
      this.ctx.db.query("UPDATE drive_oauth_flows SET state='failed',reason=?,secret_enc=NULL,account=NULL WHERE id=? AND state='exchanging'").run(reason, r.id)
      return false
    }
  }
  complete(user: string, session: string, id: string) {
    this.configured(); this.busy(user)
    const r = this.store.ownFlow(user, session, id)
    if (r.config_key !== this.key || r.state !== 'ready') throw new DriveError('flow_not_ready', 409)
    const s = this.store.open<FlowSecret>(r)
    if (!s.tokens || !s.account || !s.scopes?.includes(DRIVE_SCOPE)) throw new DriveError('invalid_flow')
    const connId = newId(), sealed = this.store.seal(user, connId, s.tokens), now = new Date(this.now()).toISOString()
    this.ctx.db.transaction(() => {
      this.ctx.db.query('DELETE FROM drive_connections WHERE user_id=?').run(user)
      this.ctx.db.query(`INSERT INTO drive_connections(id,user_id,config_key,account,scopes,secret_enc,key_version,status,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'connected',?,?,?)`)
        .run(connId, user, this.key, JSON.stringify(s.account), JSON.stringify(s.scopes), sealed.enc, sealed.keyVersion, new Date(s.tokens!.expiresAt).toISOString(), now, now)
      this.ctx.db.query("UPDATE drive_oauth_flows SET state='completed',secret_enc=NULL WHERE id=?").run(id)
    })()
    // In-flight requests from the old connection cannot publish into the new one.
    for (const c of this.operations.get(user) ?? []) c.abort()
    audit(this.ctx.db, { actor: user, action: 'drive.connected', target: connId })
    return this.status(user)
  }
  private exchange(fields: Record<string, string>, signal?: AbortSignal) {
    const c = this.configured()
    return this.transport.json(GOOGLE_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...fields, client_id: c.clientId, client_secret: c.clientSecret }), signal }, 32_768)
  }
  private tokens(j: Record<string, any>, previous?: Tokens): Tokens {
    const access = j.access_token, refresh = j.refresh_token ?? previous?.refreshToken, expiry = j.expires_in
    if (typeof access !== 'string' || !access || access.length > 16_384 || typeof refresh !== 'string' || !refresh || refresh.length > 16_384 || typeof expiry !== 'number' || !Number.isFinite(expiry) || expiry <= 0 || expiry > 31_536_000) throw new DriveError('needs_reconnect', 409)
    return { accessToken: access, refreshToken: refresh, expiresAt: this.now() + expiry * 1000 }
  }
  private row(user: string) {
    this.configured(); this.busy(user); this.store.active(user)
    const r = this.store.connection(user)
    if (!r || r.config_key !== this.key || r.status !== 'connected') { if (r) this.invalidate(r); throw new DriveError('needs_reconnect', 409) }
    return r
  }
  private async access(row: ConnectionRow, rejectedAccess?: string): Promise<Tokens> {
    this.store.assertCurrent(row)
    let prev: Tokens
    // The request's row is a fence, not a token snapshot: a prior refresh may have rotated the secret.
    try { prev = this.store.open<Tokens>(this.store.connection(row.user_id)!) } catch { this.invalidate(row); throw new DriveError('needs_reconnect', 409) }
    if (prev.expiresAt > this.now() + 60_000 && (!rejectedAccess || prev.accessToken !== rejectedAccess)) return prev
    const pending = this.refreshes.get(row.id)
    if (pending) return pending
    const task = this.operation(row.user_id, undefined, async signal => {
      try {
        this.store.assertCurrent(row)
        const j = await this.exchange({ grant_type: 'refresh_token', refresh_token: prev.refreshToken }, signal)
        if (typeof j.scope === 'string' && !j.scope.split(/\s+/).includes(DRIVE_SCOPE)) throw new DriveError('needs_reconnect', 409)
        const tokens = this.tokens(j, prev)
        checkAbort(signal); this.store.assertCurrent(row)
        const sealed = this.store.seal(row.user_id, row.id, tokens)
        this.ctx.db.query('UPDATE drive_connections SET secret_enc=?,key_version=?,expires_at=?,updated_at=? WHERE id=? AND version=?').run(sealed.enc, sealed.keyVersion, new Date(tokens.expiresAt).toISOString(), new Date(this.now()).toISOString(), row.id, row.version)
        return tokens
      } catch (e) { if (e instanceof DriveError && (e.reason === 'needs_reconnect' || e.reason === 'unauthorized_provider')) this.invalidate(row); throw e }
    })
    this.refreshes.set(row.id, task)
    try { return await task } finally { if (this.refreshes.get(row.id) === task) this.refreshes.delete(row.id) }
  }
  private invalidate(row: ConnectionRow) {
    this.ctx.db.query("UPDATE drive_connections SET status='needs_reconnect',updated_at=? WHERE id=? AND version=? AND status='connected'").run(new Date(this.now()).toISOString(), row.id, row.version)
    const current = this.store.connection(row.user_id)
    if (current?.id === row.id && current.status === 'needs_reconnect') notifyConnectionReconnect(this.ctx, row.user_id, row.id, current.updated_at)
  }
  async api(user: string, resource: string, query: Record<string, string>, maxBytes: number, signal?: AbortSignal) {
    if (!/^(about|files(?:\/[A-Za-z0-9_-]{1,256}(?:\/export)?)?)$/.test(resource)) throw new DriveError('invalid_endpoint')
    const row = this.row(user)
    return this.operation(user, signal, async inner => {
      let token = await waitFor(this.access(row), inner), refreshed = false, retries = 0
      for (;;) {
        checkAbort(inner); this.store.assertCurrent(row)
        const u = new URL(resource, DRIVE_API); u.search = new URLSearchParams(query).toString()
        const r = await this.transport.request(u.href, { headers: { Authorization: `Bearer ${token.accessToken}` }, signal: inner }, maxBytes)
        checkAbort(inner); this.store.assertCurrent(row)
        if (r.status === 401 && !refreshed) { refreshed = true; token = await waitFor(this.access(row, token.accessToken), inner); continue }
        if ((r.status === 429 || r.status >= 500) && retries < 2) { await backoff(++retries * 150, inner); continue }
        if (r.status < 200 || r.status >= 300) { if (r.status === 401) this.invalidate(row); throw responseError(r.status) }
        return { bytes: r.bytes, assertCurrent: () => { checkAbort(inner); this.store.assertCurrent(row) } }
      }
    })
  }
  async disconnect(user: string) {
    this.store.active(user); this.busy(user); this.revoking.add(user)
    let token: string | null = null
    const row = this.store.connection(user)
    try { if (row) token = this.store.open<Tokens>(row).refreshToken } catch {}
    this.ctx.db.transaction(() => {
      this.ctx.db.query('DELETE FROM drive_connections WHERE user_id=?').run(user)
      this.ctx.db.query('DELETE FROM drive_oauth_flows WHERE user_id=?').run(user)
    })()
    for (const c of this.operations.get(user) ?? []) c.abort()
    audit(this.ctx.db, { actor: user, action: 'drive.disconnected', target: row?.id })
    let revocation: 'revoked' | 'unavailable' | 'not_needed' = token ? 'unavailable' : 'not_needed'
    try {
      if (token) {
        const r = await this.transport.request(GOOGLE_REVOKE, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) }, 16_384)
        revocation = r.status === 200 ? 'revoked' : 'unavailable'
      }
    } catch {} finally { this.revoking.delete(user) }
    return { disconnected: true as const, revocation }
  }
}
const instances = new WeakMap<AppContext, GoogleDrive>()
/** Dependencies are supplied only by offline tests, never by HTTP or model inputs. */
export function googleDriveOf(ctx: AppContext, deps?: DriveDeps): GoogleDrive {
  let svc = instances.get(ctx)
  if (!svc || deps) { svc = new GoogleDrive(ctx, deps); instances.set(ctx, svc) }
  return svc
}
