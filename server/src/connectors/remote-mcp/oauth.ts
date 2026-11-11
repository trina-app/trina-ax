import type { Database } from 'bun:sqlite'
import { PRODUCT } from '@mycel/shared'
import type { AppConfig } from '../../app-config'
import type { AppContext } from '../../context'
import type { AuthInfo } from '../../services'
import { audit } from '../../admin/audit'
import { ACCESS_MS, ADMIN_SCOPE, CODE_MS, ROOMS_SCOPE, ROOMS_WRITE_SCOPE, GRANT_MS, MCP_PATH, OAuthError, OPTIONAL_SCOPES, REQUEST_MS, SCOPES, challenge, hash, redirectAllowed, redirectMatches, resourceMatches, scopes, secret, validOrigin } from './policy'
import { pruneScopes } from './scope'

type Client = { id: string; name: string; redirects: string }
type Pending = { id: string; client_id: string; redirect_uri: string; challenge: string; state: string | null; scopes: string; resource: string; user_id: string | null; session_id: string | null; expires_at: number }
export type Grant = { id: string; client_id: string; user_id: string; session_id: string; resource: string; scopes: string; sources: string; created_at: number; expires_at: number; revoked_at: number | null }
type TokenRow = { hash: string; kind: string; grant_id: string; expires_at: number; used_at: number | null }
type CodeRow = { grant_id: string; redirect_uri: string; challenge: string; expires_at: number; used_at: number | null }
const invalid = () => new OAuthError('invalid_grant')
const string = (v: unknown, max = 2048): string => { if (typeof v !== 'string' || !v || v.length > max) throw new OAuthError('invalid_request'); return v }
const iso = (v: number) => new Date(v).toISOString()

/**
 * Limits of the connector's own OAuth server (mutable for tests). perAddress: [window ms, requests] per client
 * address (an IPv6 address counts by its /64) for each anonymous area. Registration comes from the apps' servers
 * (Claude, ChatGPT), so one of their addresses carries many people's (and anyone can make them register): 240 an
 * hour, while a full table makes room anyway (register()). One authorize makes at most one pending request, so 200
 * per 10 minutes is also the pending requests per address; pendingPerClient counts one app's sign-ins per address (an
 * app's id is public, so it is not counted per app alone). Both leave room for an office behind one public address
 * connecting a whole team to one app. A token request with a live credential and a live upload
 * link are not in the shared bucket: a refresh or a one-time upload link must work during a flood.
 *
 * The shared bucket (all anonymous requests of a minute) is not one fixed cap any longer: a fixed 2,400 was filled by
 * 14 addresses each under its own 180 a minute, and then nobody could start a connection (QA TC-168). Now:
 * - busyPerMinute: past this many in a minute the server is busy, and only a network that sent at most
 *   networkPerMinute anonymous requests this minute (any area, an IPv4 /24 or an IPv6 /48: networkKey()) gets through.
 *   A person starting a connection sends about 5 (Claude's server: /mcp, two metadata, register; the browser:
 *   authorize), so they still get in; a flooding network does not. Its refused requests are not counted in the bucket.
 * - anonymousPerMinute: the last-resort cap for everyone, so the work and the rows written stay bounded. Only requests
 *   let in count, so filling it during busy minutes takes (30,000 - 2,400) / 30 = about 900 networks (/24s or /48s) in
 *   one minute; filling the busy level takes 14 addresses (2,400 / 180).
 */
export const OAUTH_LIMITS: {
  perAddress: Record<string, [number, number][]>; anonymousPerMinute: number; busyPerMinute: number; networkPerMinute: number
  mcpPerGrantPerMinute: number; clients: number; idleClientMs: number; pending: number; pendingPerClient: number
} = {
  perAddress: { register: [[60_000, 12], [3600_000, 240]], authorize: [[60_000, 180], [600_000, 200]], default: [[60_000, 180]] },
  anonymousPerMinute: 30_000, busyPerMinute: 2400, networkPerMinute: 30, mcpPerGrantPerMinute: 300,
  clients: 2000, idleClientMs: 7 * 24 * 3600_000, pending: 2000, pendingPerClient: 50,
}
/** A registered app that has no connection and no sign-in in progress: removed a week after its last use (one
 * registration is often shared by a team whose members connect days later; a full table makes room anyway). An app
 * that got a grant keeps its id while the grant lasts. */
const IDLE_CLIENT = 'id NOT IN (SELECT client_id FROM remote_mcp_grants) AND id NOT IN (SELECT client_id FROM remote_mcp_requests)'
/** When the table is full, also an app whose only sign-ins nobody has opened (anyone can start one for any app): its
 * requests go with it (ON DELETE CASCADE). */
const EVICTABLE_CLIENT = 'id NOT IN (SELECT client_id FROM remote_mcp_grants) AND id NOT IN (SELECT client_id FROM remote_mcp_requests WHERE user_id IS NOT NULL)'
const HOUSEKEEP_MS = 10_000
/** The rate key of a client address: IPv4 as is (also when IPv4-mapped), IPv6 by its /64 (one host usually holds a
 * whole /64, so counting single addresses would not limit it). The address comes from the socket, the relay or the
 * office tunnel (http/middleware.ts), never from a header the client sent. */
export function ipKey(ip: string | null): string {
  if (!ip) return 'unknown'
  const v = ip.split('%')[0]!.toLowerCase()
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v)
  if (mapped) return mapped[1]!
  if (!v.includes(':')) return v
  const [head = '', tail] = v.split('::'), h = head ? head.split(':') : [], t = tail ? tail.split(':') : []
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t]
  return groups.slice(0, 4).map(g => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64'
}

/** The network of a client address for the busy-minute share (OAUTH_LIMITS): an IPv4 /24, an IPv6 /48 (what one
 * customer or one cloud machine usually gets), so taking fresh addresses from one's own block gives no fresh share. */
export function networkKey(ip: string | null): string {
  const k = ipKey(ip)
  if (k === 'unknown') return k
  if (k.endsWith('::/64')) return k.split(':').slice(0, 3).join(':') + '::/48'
  const v4 = /^(\d+\.\d+\.\d+)\.\d+$/.exec(k)
  return v4 ? v4[1] + '.0/24' : k
}

/** An active owner or admin right now (the users table, not the role when a grant was made). mcp:admin needs this. */
export function isTeamAdmin(db: Database, userId: string): boolean {
  return !!db.query("SELECT 1 FROM users WHERE id=? AND status='active' AND deleted_at IS NULL AND role IN ('owner','admin')").get(userId)
}

/**
 * Take mcp:admin off every connector grant of a person who is no longer an active owner or admin (demoted, disabled,
 * or found so by a tool call). For good: like their invites and reset links, being made admin again does not bring
 * it back; they connect again (a new grant of an owner or admin gets it). `actor`: the admin who made the change (Admin › Members), or null when the
 * server found it (a tool call). Returns how many grants changed.
 */
export function dropAdminScope(db: Database, userId: string, reason: 'role' | 'status', actor: string | null = null): number {
  let n = 0
  for (const g of db.query('SELECT id,scopes FROM remote_mcp_grants WHERE user_id=?').all(userId) as { id: string; scopes: string }[]) {
    const scopes = JSON.parse(g.scopes) as string[]
    if (!scopes.includes(ADMIN_SCOPE)) continue
    db.query('UPDATE remote_mcp_grants SET scopes=? WHERE id=?').run(JSON.stringify(scopes.filter(s => s !== ADMIN_SCOPE)), g.id)
    audit(db, { actor, action: 'remote_mcp.scope_dropped', target: g.id, detail: { scope: ADMIN_SCOPE, user: userId, reason } })
    n++
  }
  return n
}

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
    return { issuer, authorization_endpoint: issuer + '/oauth/authorize', token_endpoint: issuer + '/oauth/token', registration_endpoint: issuer + '/oauth/register', revocation_endpoint: issuer + '/oauth/revoke', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], scopes_supported: [...SCOPES],
      // decide() puts iss in every authorization response (allowed or denied); saying so lets Codex use its plain
      // loopback /callback and ChatGPT its stable callback (RFC 9207; MCP 2026-07-28 requires it when iss is sent)
      authorization_response_iss_parameter_supported: true }
  }
  protectedMetadata() { return { resource: this.resource(), authorization_servers: [this.enabled()], scopes_supported: [...SCOPES], bearer_methods_supported: ['header'], resource_name: `${PRODUCT.displayName} files` } }
  /** Durable hashed identities. `window`: a whole number of minutes; the row keeps the minute its window ends, so
   * housekeep() can drop finished windows of any length. */
  rate(area: string, identity: string, limit: number, window = 60_000) {
    if (this.count(area, identity, window) > limit) throw new OAuthError('slow_down', 429)
  }
  /** Count one more in this window and return the count (no limit). */
  private count(area: string, identity: string, window = 60_000): number {
    const bucket = (Math.floor(this.now() / window) + 1) * (window / 60_000), key = hash(area + '\0' + identity)
    return (this.db.query(`INSERT INTO remote_mcp_limits(key,bucket,count) VALUES(?,?,1)
      ON CONFLICT(key) DO UPDATE SET bucket=excluded.bucket,count=CASE WHEN bucket=excluded.bucket THEN count+1 ELSE 1 END RETURNING count`).get(key, bucket) as { count: number }).count
  }
  /**
   * A request no credential vouches for yet. Order: a shared bucket at its last-resort cap refuses at once, writing
   * nothing (so a flood from ever new addresses adds no rows then); then the address's own buckets (an address over
   * its limit does not spend the shared one); then, in a busy minute (past busyPerMinute), the network's share: a
   * network that already sent more than networkPerMinute is refused and does not spend the shared bucket either; then
   * the shared bucket. `shared: false`: only the address's buckets (token, which with a live code or refresh token, see
   * liveCredential(); an upload link that is live).
   * An /mcp call with a live access token goes through granted() instead.
   */
  ingress(area: string, ip: string | null, o: { shared?: boolean } = {}) {
    this.enabled()
    const shared = o.shared !== false
    let used = 0
    if (shared) {
      const g = this.db.query('SELECT bucket,count FROM remote_mcp_limits WHERE key=?').get(hash('global\0all')) as { bucket: number; count: number } | null
      used = g && g.bucket === Math.floor(this.now() / 60_000) + 1 ? g.count : 0
      if (used >= OAUTH_LIMITS.anonymousPerMinute) throw new OAuthError('slow_down', 429)
    }
    const who = ipKey(ip)
    for (const [window, limit] of OAUTH_LIMITS.perAddress[area] ?? OAUTH_LIMITS.perAddress.default!) this.rate(window === 60_000 ? area : `${area}@${window}`, who, limit, window)
    if (shared) {
      // counted in every minute (not only busy ones), so a network that flooded before the minute got busy is known
      const sent = this.count('network', networkKey(ip))
      if (used >= OAUTH_LIMITS.busyPerMinute && sent > OAUTH_LIMITS.networkPerMinute) throw new OAuthError('slow_down', 429)
      this.rate('global', 'all', OAUTH_LIMITS.anonymousPerMinute)
    }
    this.housekeep()
  }
  /** A token request that carries an unused, unexpired code or refresh token of a live grant of the app it names (a
   * hash lookup): it is not counted in the shared anonymous bucket nor in the app's token bucket, so a flood cannot
   * stop a connected app's refresh. A request that then fails is charged to the shared bucket (the route). */
  liveCredential(body: Record<string, unknown>): boolean {
    const code = body.grant_type === 'authorization_code' ? body.code : body.grant_type === 'refresh_token' ? body.refresh_token : null
    if (typeof code !== 'string' || !code || code.length > 128 || typeof body.client_id !== 'string') return false
    const table = body.grant_type === 'authorization_code' ? 'remote_mcp_codes' : "remote_mcp_tokens"
    return !!this.db.query(`SELECT 1 FROM ${table} t JOIN remote_mcp_grants g ON g.id=t.grant_id WHERE t.hash=? AND t.used_at IS NULL AND t.expires_at>?
      ${table === 'remote_mcp_tokens' ? "AND t.kind='refresh'" : ''} AND g.client_id=? AND g.revoked_at IS NULL AND g.expires_at>?`).get(hash(code), this.now(), body.client_id, this.now())
  }
  /** Charge a request to the shared anonymous bucket after the fact (an exempt request that failed); never throws. */
  chargeShared() { try { this.rate('global', 'all', OAUTH_LIMITS.anonymousPerMinute) } catch { /* already full */ } }
  /** An /mcp call with a live access token: its grant's own bucket, never the anonymous ones, so unauthenticated
   * traffic cannot stop a connected person's tool calls. */
  granted(g: Grant) {
    this.rate('mcp-grant', g.id, OAUTH_LIMITS.mcpPerGrantPerMinute)
    this.housekeep()
  }
  private swept = -Infinity
  private housekeep() {
    this.db.query('DELETE FROM remote_mcp_requests WHERE expires_at <= ?').run(this.now())
    this.db.query('DELETE FROM remote_mcp_upload_links WHERE expires_at <= ?').run(this.now())
    this.db.query('DELETE FROM remote_mcp_grants WHERE expires_at <= ?').run(this.now())
    pruneScopes(this.db, this.now())
    // At most every HOUSEKEEP_MS: these two are scans (no index on the limits' bucket; the idle-app subqueries).
    if (this.now() - this.swept < HOUSEKEEP_MS && this.now() >= this.swept) return
    this.swept = this.now()
    // Fixed-size lifetime for attacker-controlled keys: this table never contains raw IPs or tokens.
    this.db.query('DELETE FROM remote_mcp_limits WHERE bucket < ?').run(Math.floor(this.now() / 60_000) - 1)
    this.db.query(`DELETE FROM remote_mcp_clients WHERE last_used_at < ? AND ${IDLE_CLIENT}`).run(this.now() - OAUTH_LIMITS.idleClientMs)
  }
  register(body: Record<string, unknown>) {
    this.enabled()
    const redirects = body.redirect_uris
    if (!Array.isArray(redirects) || redirects.length < 1 || redirects.length > 10 || redirects.some(r => typeof r !== 'string' || r.length > 2048 || !redirectAllowed(r))) throw new OAuthError('invalid_redirect_uri')
    if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== 'none') throw new OAuthError('invalid_client_metadata')
    if (body.grant_types !== undefined && (!Array.isArray(body.grant_types) || body.grant_types.some(v => !['authorization_code', 'refresh_token'].includes(v)))) throw new OAuthError('invalid_client_metadata')
    if (body.response_types !== undefined && (!Array.isArray(body.response_types) || body.response_types.some(v => v !== 'code'))) throw new OAuthError('invalid_client_metadata')
    // Full: the longest-idle apps without a grant or a sign-in someone opened make room (oldest first), so
    // registrations from many addresses, kept alive with unopened sign-ins, cannot lock out the next real app.
    const clients = (this.db.query('SELECT count(*) AS n FROM remote_mcp_clients').get() as { n: number }).n
    if (clients >= OAUTH_LIMITS.clients) this.db.query(`DELETE FROM remote_mcp_clients WHERE id IN (SELECT id FROM remote_mcp_clients WHERE ${EVICTABLE_CLIENT} ORDER BY last_used_at, created_at LIMIT ?)`).run(clients - OAUTH_LIMITS.clients + 1)
    if ((this.db.query('SELECT count(*) AS n FROM remote_mcp_clients').get() as { n: number }).n >= OAUTH_LIMITS.clients) throw new OAuthError('temporarily_unavailable', 503)
    const name = body.client_name === undefined ? 'MCP app' : string(body.client_name, 80)
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
  /** `ip`: the browser's address (pending sign-ins of one app are counted per address). */
  authorize(body: Record<string, unknown>, ip: string | null = null): string {
    const origin = this.enabled(), c = this.client(body.client_id)
    const redirect = string(body.redirect_uri)
    if (!redirectMatches(JSON.parse(c.redirects), redirect)) throw new OAuthError('invalid_redirect_uri')
    if (body.response_type !== 'code' || body.code_challenge_method !== 'S256' || typeof body.code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.code_challenge)) throw new OAuthError('invalid_request')
    if (!resourceMatches(origin, body.resource)) throw new OAuthError('invalid_target')
    if (body.state !== undefined && (typeof body.state !== 'string' || body.state.length > 1024)) throw new OAuthError('invalid_request')
    this.rate('authorize-client-address', c.id + '\0' + ipKey(ip), OAUTH_LIMITS.pendingPerClient, REQUEST_MS)
    // Full: the oldest requests nobody has opened yet make room (one a person opened is kept until it expires).
    const pending = (this.db.query('SELECT count(*) AS n FROM remote_mcp_requests').get() as { n: number }).n
    if (pending >= OAUTH_LIMITS.pending) this.db.query('DELETE FROM remote_mcp_requests WHERE id IN (SELECT id FROM remote_mcp_requests WHERE user_id IS NULL ORDER BY expires_at LIMIT ?)').run(pending - OAUTH_LIMITS.pending + 1)
    if ((this.db.query('SELECT count(*) AS n FROM remote_mcp_requests').get() as { n: number }).n >= OAUTH_LIMITS.pending) throw new OAuthError('temporarily_unavailable', 503)
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
  /** The asked scopes this person may be offered: mcp:admin only to an active owner or admin. Dropped, not refused: an
   * app that asks for every advertised scope must still connect a member (RFC 6749 3.3; the token's `scope` says so). */
  private offered(scopes: string[], userId: string): string[] {
    return scopes.filter(s => s !== ADMIN_SCOPE || isTeamAdmin(this.db, userId))
  }
  /**
   * `scopes`: what the app asked for (its mcp:write is the write box's starting state). `optional`: the boxes
   * (OPTIONAL_SCOPES). `admin`: the connection will also manage the team's groups (an active owner or admin now).
   */
  consent(id: string, auth: AuthInfo) {
    const r = this.pending(id, auth), c = this.client(r.client_id)
    return { id, clientName: c.name, redirectOrigin: new URL(r.redirect_uri).origin, scopes: this.offered(JSON.parse(r.scopes), auth.user.id), optional: [...OPTIONAL_SCOPES] as string[], admin: isTeamAdmin(this.db, auth.user.id), resource: r.resource, expiresAt: iso(r.expires_at) }
  }
  /**
   * The grant: mcp:read, plus mcp:write when `write` (left out: when the app asked for it), plus mcp:rooms when
   * `rooms` and mcp:rooms.write when `rooms` and `roomsWrite` (left out: no, whatever the app asked: a page that shows
   * no rooms box grants no rooms), plus mcp:admin when the person is an active owner or admin at this moment (no box,
   * and nothing the page sends changes it), plus offline_access when the app asked for it. It may hold a scope the app
   * did not ask for; the token answer's `scope` names exactly what was granted (RFC 6749 3.3), and a refresh can only
   * narrow it.
   */
  decide(id: string, auth: AuthInfo, allow: boolean, o: { write?: boolean; rooms?: boolean; roomsWrite?: boolean } = {}) {
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
      const asked = JSON.parse(r.scopes) as string[], chosen = new Set<string>(['mcp:read'])
      if (o.write ?? asked.includes('mcp:write')) chosen.add('mcp:write')
      if (o.rooms === true) chosen.add(ROOMS_SCOPE)
      if (o.rooms === true && o.roomsWrite === true) chosen.add(ROOMS_WRITE_SCOPE)
      if (isTeamAdmin(this.db, auth.user.id)) chosen.add(ADMIN_SCOPE)
      if (asked.includes('offline_access')) chosen.add('offline_access')
      const selected = SCOPES.filter(s => chosen.has(s))
      this.db.query('INSERT INTO remote_mcp_grants(id,client_id,user_id,session_id,resource,scopes,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').run(grant, r.client_id, auth.user.id, auth.session.id, r.resource, JSON.stringify(selected), this.now(), end)
      this.db.query('INSERT INTO remote_mcp_codes VALUES(?,?,?,?,?,NULL)').run(hash(code), grant, r.redirect_uri, r.challenge, this.now() + CODE_MS)
      audit(this.db, { actor: auth.user.id, action: 'remote_mcp.connected', target: grant, detail: { scopes: selected, asked } })
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
  /** `live`: liveCredential(body) was true (the app's token bucket is skipped). */
  token(body: Record<string, unknown>, live = false) {
    const origin = this.enabled(), c = this.client(body.client_id)
    if (!live) this.rate('token-client', c.id, 180)
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
        const original = JSON.parse(g.scopes) as string[], asked = body.scope === undefined ? original : scopes(body.scope)
        if (asked.some(s => !original.includes(s))) throw new OAuthError('invalid_scope')
        // writing in conversations goes only with reading them (decide): narrowed away with it
        const selected = asked.filter(s => s !== ROOMS_WRITE_SCOPE || asked.includes(ROOMS_SCOPE))
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

/** The connector origin: MYCEL_REMOTE_MCP_ORIGIN when it is set (an invalid value = off), else https://<tunnel.host>
 * when server.json has appConnectors: true and a tunnel, else null (off). */
export function connectorOrigin(config: Pick<AppConfig, 'appConnectors' | 'tunnel'>, env: Record<string, string | undefined> = process.env): string | null {
  const v = env.MYCEL_REMOTE_MCP_ORIGIN
  if (v !== undefined && v !== '') return validOrigin(v)
  return config.appConnectors && config.tunnel ? validOrigin(`https://${config.tunnel.host}`) : null
}

const instances = new WeakMap<AppContext, RemoteOAuth>()
export function remoteOAuthOf(ctx: AppContext, opts?: { origin?: string | null; now?: () => number }) {
  if (opts || !instances.has(ctx)) instances.set(ctx, new RemoteOAuth(ctx.db, { ...opts, origin: opts?.origin !== undefined ? opts.origin : connectorOrigin(ctx.config) }))
  return instances.get(ctx)!
}
