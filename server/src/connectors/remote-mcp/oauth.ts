import type { Database } from 'bun:sqlite'
import { PRODUCT } from '@mycel/shared'
import type { AppContext } from '../../context'
import type { AuthInfo } from '../../services'
import { audit } from '../../admin/audit'
import { ACCESS_MS, CODE_MS, GRANT_MS, MCP_PATH, OAuthError, REQUEST_MS, SCOPES, challenge, hash, redirectAllowed, redirectMatches, resourceMatches, scopes, secret, validOrigin } from './policy'

type Client = { id: string; name: string; redirects: string }
type Pending = { id: string; client_id: string; redirect_uri: string; challenge: string; state: string | null; scopes: string; resource: string; user_id: string | null; session_id: string | null; expires_at: number }
export type Grant = { id: string; client_id: string; user_id: string; session_id: string; resource: string; scopes: string; sources: string; created_at: number; expires_at: number; revoked_at: number | null }
type TokenRow = { hash: string; kind: string; grant_id: string; expires_at: number; used_at: number | null }
type CodeRow = { grant_id: string; redirect_uri: string; challenge: string; expires_at: number; used_at: number | null }
const invalid = () => new OAuthError('invalid_grant')
const string = (v: unknown, max = 2048): string => { if (typeof v !== 'string' || !v || v.length > max) throw new OAuthError('invalid_request'); return v }
const iso = (v: number) => new Date(v).toISOString()

/** Separate public-client credential namespace. No app session token is ever accepted here. */
export class RemoteOAuth {
  readonly origin: string | null
  now: () => number
  constructor(readonly db: Database, opts: { origin?: string | null; now?: () => number } = {}) {
    this.origin = validOrigin(opts.origin === undefined ? process.env.MYCEL_REMOTE_MCP_ORIGIN : opts.origin)
    this.now = opts.now ?? Date.now
  }
  enabled(): string { if (!this.origin) throw new OAuthError('temporarily_unavailable', 503); return this.origin }
  resource() { return this.enabled() + MCP_PATH }
  metadata() {
    const issuer = this.enabled()
    return { issuer, authorization_endpoint: issuer + '/oauth/authorize', token_endpoint: issuer + '/oauth/token', registration_endpoint: issuer + '/oauth/register', revocation_endpoint: issuer + '/oauth/revoke', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], scopes_supported: [...SCOPES] }
  }
  protectedMetadata() { return { resource: this.resource(), authorization_servers: [this.enabled()], scopes_supported: [...SCOPES], bearer_methods_supported: ['header'], resource_name: `${PRODUCT.displayName} files` } }
  /** Durable hashed identities, bounded by both a global bucket and per-transport/client buckets. */
  rate(area: string, identity: string, limit: number, window = 60_000) {
    const bucket = Math.floor(this.now() / window), key = hash(area + '\0' + identity)
    const count = this.db.query(`INSERT INTO remote_mcp_limits(key,bucket,count) VALUES(?,?,1)
      ON CONFLICT(key) DO UPDATE SET bucket=excluded.bucket,count=CASE WHEN bucket=excluded.bucket THEN count+1 ELSE 1 END RETURNING count`).get(key, bucket) as { count: number }
    if (count.count > limit) throw new OAuthError('slow_down', 429)
  }
  ingress(area: string, ip: string | null) {
    this.enabled()
    this.rate('global', 'all', 2400)
    this.rate(area, ip ?? 'unknown', area === 'register' ? 12 : 180)
    // Fixed-size lifetime for attacker-controlled keys: this table never contains raw IPs or tokens.
    this.db.query('DELETE FROM remote_mcp_limits WHERE bucket < ?').run(Math.floor(this.now() / 60_000) - 2)
    this.db.query('DELETE FROM remote_mcp_requests WHERE expires_at <= ?').run(this.now())
    this.db.query('DELETE FROM remote_mcp_grants WHERE expires_at <= ?').run(this.now())
    this.db.query('DELETE FROM remote_mcp_clients WHERE last_used_at < ? AND id NOT IN (SELECT client_id FROM remote_mcp_grants) AND id NOT IN (SELECT client_id FROM remote_mcp_requests)').run(this.now() - GRANT_MS)
  }
  register(body: Record<string, unknown>) {
    this.enabled()
    const redirects = body.redirect_uris
    if (!Array.isArray(redirects) || redirects.length < 1 || redirects.length > 10 || redirects.some(r => typeof r !== 'string' || r.length > 2048 || !redirectAllowed(r))) throw new OAuthError('invalid_redirect_uri')
    if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== 'none') throw new OAuthError('invalid_client_metadata')
    if (body.grant_types !== undefined && (!Array.isArray(body.grant_types) || body.grant_types.some(v => !['authorization_code', 'refresh_token'].includes(v)))) throw new OAuthError('invalid_client_metadata')
    if (body.response_types !== undefined && (!Array.isArray(body.response_types) || body.response_types.some(v => v !== 'code'))) throw new OAuthError('invalid_client_metadata')
    if ((this.db.query('SELECT count(*) AS n FROM remote_mcp_clients').get() as { n: number }).n >= 2000) throw new OAuthError('temporarily_unavailable', 503)
    const name = body.client_name === undefined ? 'Claude connector' : string(body.client_name, 80)
    if (/[\x00-\x1f\x7f<>]/.test(name)) throw new OAuthError('invalid_client_metadata')
    const id = secret('tax_client_'), unique = [...new Set(redirects as string[])]
    this.db.query('INSERT INTO remote_mcp_clients VALUES(?,?,?,?,?)').run(id, name, JSON.stringify(unique), this.now(), this.now())
    return { client_id: id, client_name: name, redirect_uris: unique, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], client_id_issued_at: Math.floor(this.now() / 1000) }
  }
  client(id: unknown): Client {
    const row = this.db.query('SELECT * FROM remote_mcp_clients WHERE id=?').get(string(id, 128)) as Client | null
    if (!row) throw new OAuthError('invalid_client', 401)
    return row
  }
  authorize(body: Record<string, unknown>): string {
    const origin = this.enabled(), c = this.client(body.client_id)
    const redirect = string(body.redirect_uri)
    if (!redirectMatches(JSON.parse(c.redirects), redirect)) throw new OAuthError('invalid_redirect_uri')
    if (body.response_type !== 'code' || body.code_challenge_method !== 'S256' || typeof body.code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.code_challenge)) throw new OAuthError('invalid_request')
    if (!resourceMatches(origin, body.resource)) throw new OAuthError('invalid_target')
    if (body.state !== undefined && (typeof body.state !== 'string' || body.state.length > 1024)) throw new OAuthError('invalid_request')
    this.rate('authorize-client', c.id, 60)
    if ((this.db.query('SELECT count(*) AS n FROM remote_mcp_requests').get() as { n: number }).n >= 2000) throw new OAuthError('temporarily_unavailable', 503)
    const id = secret()
    this.db.query('INSERT INTO remote_mcp_requests VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, c.id, redirect, body.code_challenge, body.state as string ?? null, JSON.stringify(scopes(body.scope)), this.resource(), null, null, this.now() + REQUEST_MS)
    return origin + '/connectors/authorize?id=' + id
  }
  private browser(auth: AuthInfo): number {
    const row = this.db.query(`SELECT s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.id=? AND s.user_id=? AND u.status='active' AND u.deleted_at IS NULL AND u.must_change_password=0`).get(auth.session.id, auth.user.id) as { expires_at: string } | null
    const end = row ? Date.parse(row.expires_at) : 0
    if (!end || end <= this.now() || auth.session.tempLogin) throw new OAuthError('access_denied', 403)
    return end
  }
  private pending(id: string, auth: AuthInfo): Pending {
    this.browser(auth)
    if (!this.origin) throw new OAuthError('invalid_request', 404)
    const r = this.db.query('SELECT * FROM remote_mcp_requests WHERE id=?').get(id) as Pending | null
    if (!r || r.expires_at <= this.now() || (r.user_id !== null && (r.user_id !== auth.user.id || r.session_id !== auth.session.id))) throw new OAuthError('invalid_request', 404)
    this.db.query('UPDATE remote_mcp_requests SET user_id=?,session_id=? WHERE id=? AND user_id IS NULL').run(auth.user.id, auth.session.id, id)
    return r
  }
  consent(id: string, auth: AuthInfo) {
    const r = this.pending(id, auth), c = this.client(r.client_id)
    return { id, clientName: c.name, redirectOrigin: new URL(r.redirect_uri).origin, scopes: JSON.parse(r.scopes) as string[], resource: r.resource, expiresAt: iso(r.expires_at) }
  }
  decide(id: string, auth: AuthInfo, allow: boolean) {
    return this.db.transaction(() => {
      const r = this.pending(id, auth), url = new URL(r.redirect_uri)
      this.db.query('DELETE FROM remote_mcp_requests WHERE id=?').run(id)
      if (r.state !== null) url.searchParams.set('state', r.state)
      url.searchParams.set('iss', this.enabled())
      if (!allow) { url.searchParams.set('error', 'access_denied'); return { redirectUrl: url.href } }
      this.rate('consent-user', auth.user.id, 20)
      const active = this.db.query('SELECT count(*) AS n FROM remote_mcp_grants WHERE user_id=? AND revoked_at IS NULL AND expires_at>?').get(auth.user.id, this.now()) as { n: number }
      if (active.n >= 50) throw new OAuthError('temporarily_unavailable', 503)
      const grant = secret('tax_grant_'), code = secret('tax_code_'), end = Math.min(this.now() + GRANT_MS, this.browser(auth))
      this.db.query('INSERT INTO remote_mcp_grants(id,client_id,user_id,session_id,resource,scopes,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').run(grant, r.client_id, auth.user.id, auth.session.id, r.resource, r.scopes, this.now(), end)
      this.db.query('INSERT INTO remote_mcp_codes VALUES(?,?,?,?,?,NULL)').run(hash(code), grant, r.redirect_uri, r.challenge, this.now() + CODE_MS)
      audit(this.db, { actor: auth.user.id, action: 'remote_mcp.connected', target: grant, detail: { scopes: JSON.parse(r.scopes) } })
      url.searchParams.set('code', code)
      return { redirectUrl: url.href }
    }).immediate()
  }
  grant(id: string): Grant {
    const g = this.db.query(`SELECT g.* FROM remote_mcp_grants g JOIN users u ON u.id=g.user_id
      JOIN sessions s ON s.id=g.session_id AND s.user_id=g.user_id WHERE g.id=? AND u.status='active'
      AND u.deleted_at IS NULL AND u.must_change_password=0 AND s.expires_at>?`).get(id, iso(this.now())) as Grant | null
    if (!g || g.revoked_at !== null || g.expires_at <= this.now() || g.resource !== this.resource()) throw invalid()
    return g
  }
  revokeGrant(id: string) {
    this.db.query('UPDATE remote_mcp_grants SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').run(this.now(), id)
  }
  private issue(g: Grant, selected: string[]) {
    const access = secret('tax_mcp_a_'), end = Math.min(g.expires_at, this.now() + ACCESS_MS)
    this.db.query('INSERT INTO remote_mcp_tokens VALUES(?,\'access\',?,?,NULL)').run(hash(access), g.id, end)
    let refresh: string | undefined
    if (selected.includes('offline_access')) {
      refresh = secret('tax_mcp_r_')
      this.db.query('INSERT INTO remote_mcp_tokens VALUES(?,\'refresh\',?,?,NULL)').run(hash(refresh), g.id, g.expires_at)
    }
    this.db.query('UPDATE remote_mcp_clients SET last_used_at=? WHERE id=?').run(this.now(), g.client_id)
    return { access_token: access, token_type: 'Bearer', expires_in: Math.floor((end - this.now()) / 1000), scope: selected.join(' '), ...(refresh ? { refresh_token: refresh } : {}) }
  }
  token(body: Record<string, unknown>) {
    const origin = this.enabled(), c = this.client(body.client_id)
    this.rate('token-client', c.id, 180)
    if (!resourceMatches(origin, body.resource)) throw new OAuthError('invalid_target')
    // Return an error value from the transaction: replay revocation must COMMIT even though exchange fails.
    const result = this.db.transaction(() => {
      if (body.grant_type === 'authorization_code') {
        const code = string(body.code, 128), verifier = string(body.code_verifier, 128)
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw invalid()
        const row = this.db.query('SELECT * FROM remote_mcp_codes WHERE hash=?').get(hash(code)) as CodeRow | null
        if (!row) throw invalid()
        const g = this.grant(row.grant_id)
        if (g.client_id !== c.id || row.redirect_uri !== body.redirect_uri || row.challenge !== challenge(verifier)) throw invalid()
        if (row.used_at !== null) { this.revokeGrant(g.id); return invalid() }
        if (row.expires_at <= this.now()) throw invalid()
        this.db.query('UPDATE remote_mcp_codes SET used_at=? WHERE hash=?').run(this.now(), hash(code))
        return this.issue(g, JSON.parse(g.scopes))
      }
      if (body.grant_type === 'refresh_token') {
        const token = string(body.refresh_token, 128)
        const row = this.db.query("SELECT * FROM remote_mcp_tokens WHERE hash=? AND kind='refresh'").get(hash(token)) as TokenRow | null
        if (!row) throw invalid()
        const g = this.grant(row.grant_id)
        if (g.client_id !== c.id) throw invalid()
        if (row.used_at !== null) { this.revokeGrant(g.id); return invalid() }
        if (row.expires_at <= this.now()) throw invalid()
        const original = JSON.parse(g.scopes) as string[], selected = body.scope === undefined ? original : scopes(body.scope)
        if (selected.some(s => !original.includes(s))) throw new OAuthError('invalid_scope')
        const count = this.db.query('SELECT count(*) AS n FROM remote_mcp_tokens WHERE grant_id=?').get(g.id) as { n: number }
        if (count.n >= 4096) { this.revokeGrant(g.id); return invalid() }
        // Narrowing persists for this grant and all future refreshes, never quietly expands again.
        this.db.query('UPDATE remote_mcp_grants SET scopes=? WHERE id=?').run(JSON.stringify(selected), g.id)
        this.db.query('UPDATE remote_mcp_tokens SET used_at=? WHERE grant_id=? AND used_at IS NULL').run(this.now(), g.id)
        return this.issue(g, selected)
      }
      throw new OAuthError('unsupported_grant_type')
    }).immediate()
    if (result instanceof OAuthError) throw result
    return result
  }
  authenticate(token: string): Grant {
    if (!/^tax_mcp_a_[A-Za-z0-9_-]{43}$/.test(token)) throw new OAuthError('invalid_token', 401)
    const row = this.db.query("SELECT * FROM remote_mcp_tokens WHERE hash=? AND kind='access'").get(hash(token)) as TokenRow | null
    if (!row || row.used_at !== null || row.expires_at <= this.now()) throw new OAuthError('invalid_token', 401)
    try { return this.grant(row.grant_id) } catch { throw new OAuthError('invalid_token', 401) }
  }
  revoke(body: Record<string, unknown>) {
    const c = this.client(body.client_id), token = string(body.token, 128)
    const row = this.db.query('SELECT g.id,g.client_id FROM remote_mcp_tokens t JOIN remote_mcp_grants g ON g.id=t.grant_id WHERE t.hash=?').get(hash(token)) as { id: string; client_id: string } | null
    if (row?.client_id === c.id) this.revokeGrant(row.id)
  }
  connections(auth: AuthInfo) {
    this.browser(auth)
    const rows = this.db.query(`SELECT g.*,c.name FROM remote_mcp_grants g JOIN remote_mcp_clients c ON c.id=g.client_id
      JOIN sessions s ON s.id=g.session_id WHERE g.user_id=? AND g.revoked_at IS NULL AND g.expires_at>? AND s.expires_at>? ORDER BY g.created_at DESC LIMIT 100`).all(auth.user.id, this.now(), iso(this.now())) as (Grant & { name: string })[]
    return { configured: !!this.origin, resource: this.origin ? this.resource() : null, items: rows.map(g => ({ id: g.id, clientName: g.name, scopes: JSON.parse(g.scopes) as string[], createdAt: iso(g.created_at), expiresAt: iso(g.expires_at), currentSession: g.session_id === auth.session.id })) }
  }
  disconnect(id: string, auth: AuthInfo) {
    this.browser(auth)
    const g = this.db.query('SELECT user_id FROM remote_mcp_grants WHERE id=?').get(id) as { user_id: string } | null
    if (!g || g.user_id !== auth.user.id) throw new OAuthError('invalid_request', 404)
    this.revokeGrant(id)
    audit(this.db, { actor: auth.user.id, action: 'remote_mcp.disconnected', target: id })
  }
}

const instances = new WeakMap<AppContext, RemoteOAuth>()
export function remoteOAuthOf(ctx: AppContext, opts?: { origin?: string | null; now?: () => number }) {
  if (opts || !instances.has(ctx)) instances.set(ctx, new RemoteOAuth(ctx.db, opts))
  return instances.get(ctx)!
}
