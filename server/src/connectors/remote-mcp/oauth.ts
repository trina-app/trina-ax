import type { Database } from 'bun:sqlite'
import { browserPausedUntil } from './browser-pause'
import { PRODUCT } from '@mycel/shared'
import { REMOTE_CONSENT_EXPIRED } from '@mycel/shared/api'
import type { AppConfig } from '../../app-config'
import type { AppContext } from '../../context'
import type { AuthInfo } from '../../services'
import { audit } from '../../admin/audit'
import { ACCESS_MS, ADMIN_SCOPE, CODE_MS, ROOMS_SCOPE, ROOMS_WRITE_SCOPE, GRANT_MS, MCP_PATH, OAuthError, OPTIONAL_SCOPES, REFRESH_REUSE_MS, REQUEST_MS, SCOPES, challenge, hash, redirectAllowed, redirectMatches, resourceMatches, scopes, secret, validOrigin, BROWSER_SCOPE } from './policy'
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
 * - widePerMinute: in a busy minute an IPv6 /32 (wideNetworkKey(), one ISP's or cloud's allocation, which holds 65,536
 *   /48s) also gets at most this many in total, so ever new /48s of one block give no fresh share (owner 2026-11-12,
 *   review of #482: about 1,000 /48s filled the old 30,000 cap). 120 is 4 /48 shares, about 24 new connections a
 *   minute from one /32 while the server is busy. Each /48 adds at most its own 30 to its /32's count (also before
 *   the minute is busy), so shutting out a /32 takes at least 4 of its /48s, not one host. The trade-off: someone with
 *   4 /48s in a large provider's /32 can shut that /32 out during a busy minute. IPv4 has no such level (a /24 is
 *   already small).
 * - anonymousPerMinute: the last-resort cap for everyone, so the work and the rows written stay bounded. Only requests
 *   let in count. 6,000 (was 30,000): one accepted request costs about 2-4 ms of main-thread SQLite work on a loaded
 *   2-core host, so 6,000 is about 20 s of work a minute, 30,000 was about 100 s. Filling it in a busy minute takes
 *   (6,000 - 2,400) / 30 = 120 IPv4 /24s, or (6,000 - 2,400) / 120 = 30 IPv6 /32s; one /32 with all its /48s sends at
 *   most 2,400 + 120 (or only 120, if others made the minute busy). Filling the busy level takes 14 addresses
 *   (2,400 / 180). Its bound on rows: at most 6,000 requests a minute write rows (about 3-4 each: the address's
 *   buckets, the network, an IPv6 request's /32, plus one hour-long row for register).
 */
export const OAUTH_LIMITS: {
  perAddress: Record<string, [number, number][]>; anonymousPerMinute: number; busyPerMinute: number; networkPerMinute: number; widePerMinute: number
  mcpPerGrantPerMinute: number; clients: number; idleClientMs: number; pending: number; pendingPerClient: number
} = {
  perAddress: { register: [[60_000, 12], [3600_000, 240]], authorize: [[60_000, 180], [600_000, 200]], default: [[60_000, 180]] },
  anonymousPerMinute: 6000, busyPerMinute: 2400, networkPerMinute: 30, widePerMinute: 120, mcpPerGrantPerMinute: 300,
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

/** The coarser network of an IPv6 address for the busy-minute share (OAUTH_LIMITS.widePerMinute): its /32, so a block
 * of many /48s is one network too. null for IPv4 (and IPv4-mapped) and an unknown address: they have one level. */
export function wideNetworkKey(ip: string | null): string | null {
  const k = ipKey(ip)
  return k.endsWith('::/64') ? k.split(':').slice(0, 2).join(':') + '::/32' : null
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
/** The name an outside app registered (`client_name`, at most 80 characters), for the activity log: an admin reads
 * which app it was, not the grant's id (QA TC-204). null when the grant or its app is gone. */
/** told when a connection is revoked (Disconnect, too many, a reused refresh token) */
const grantEnded = new Set<(grantId: string) => void>()
export function onGrantEnded(l: (grantId: string) => void): () => void { grantEnded.add(l); return () => { grantEnded.delete(l) } }

export function grantApp(db: Database, grantId: string): string | null {
  const r = db.query('SELECT c.name FROM remote_mcp_grants g JOIN remote_mcp_clients c ON c.id=g.client_id WHERE g.id=?').get(grantId) as { name: string } | null
  return r?.name ?? null
}

export function dropAdminScope(db: Database, userId: string, reason: 'role' | 'status', actor: string | null = null): number {
  let n = 0
  for (const g of db.query('SELECT id,scopes FROM remote_mcp_grants WHERE user_id=?').all(userId) as { id: string; scopes: string }[]) {
    const scopes = JSON.parse(g.scopes) as string[]
    if (!scopes.includes(ADMIN_SCOPE)) continue
    db.query('UPDATE remote_mcp_grants SET scopes=? WHERE id=?').run(JSON.stringify(scopes.filter(s => s !== ADMIN_SCOPE)), g.id)
    audit(db, { actor, action: 'remote_mcp.scope_dropped', target: g.id, detail: { scope: ADMIN_SCOPE, user: userId, reason, app: grantApp(db, g.id) } })
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
  /** This minute's count, read only. */
  private peek(area: string, identity: string): number {
    const r = this.db.query('SELECT bucket,count FROM remote_mcp_limits WHERE key=?').get(hash(area + '\0' + identity)) as { bucket: number; count: number } | null
    return r && r.bucket === Math.floor(this.now() / 60_000) + 1 ? r.count : 0
  }
  /** Count one more in this window and return the count (no limit). */
  private count(area: string, identity: string, window = 60_000): number {
    const bucket = (Math.floor(this.now() / window) + 1) * (window / 60_000), key = hash(area + '\0' + identity)
    return (this.db.query(`INSERT INTO remote_mcp_limits(key,bucket,count) VALUES(?,?,1)
      ON CONFLICT(key) DO UPDATE SET bucket=excluded.bucket,count=CASE WHEN bucket=excluded.bucket THEN count+1 ELSE 1 END RETURNING count`).get(key, bucket) as { count: number }).count
  }
  /**
   * A request no credential vouches for yet. Order, first the read-only refusals that write nothing (so a flood from
   * ever new addresses adds no rows then): a shared bucket at its last-resort cap; in a busy minute (past
   * busyPerMinute), a network that already sent networkPerMinute, or an IPv6 /32 that already sent widePerMinute.
   * Then the address's own buckets (an address over its limit does not spend the shared one); then the network's (and
   * an IPv6 /32's) count and the shared bucket. `shared: false`: only the address's buckets (token, which with a live code or refresh token, see
   * liveCredential(); an upload link that is live).
   * An /mcp call with a live access token goes through granted() instead.
   */
  ingress(area: string, ip: string | null, o: { shared?: boolean } = {}) {
    this.enabled()
    const shared = o.shared !== false, wide = wideNetworkKey(ip)
    if (shared) {
      const used = this.peek('global', 'all')
      if (used >= OAUTH_LIMITS.anonymousPerMinute) throw new OAuthError('slow_down', 429)
      // a busy minute: a network over its share is refused before anything is written, so ever new addresses of one
      // network add no rows (and spend nothing). All callers without an address share one network ('unknown').
      // An IPv6 address also by its /32, so ever new /48s of one large block do not get a fresh share each.
      if (used >= OAUTH_LIMITS.busyPerMinute) {
        if (this.peek('network', networkKey(ip)) >= OAUTH_LIMITS.networkPerMinute) throw new OAuthError('slow_down', 429)
        if (wide && this.peek('wide-network', wide) >= OAUTH_LIMITS.widePerMinute) throw new OAuthError('slow_down', 429)
      }
    }
    const who = ipKey(ip)
    for (const [window, limit] of OAUTH_LIMITS.perAddress[area] ?? OAUTH_LIMITS.perAddress.default!) this.rate(window === 60_000 ? area : `${area}@${window}`, who, limit, window)
    if (shared) {
      // counted in every minute (not only busy ones), so a network that sent much before the minute got busy is known
      // a /48 adds at most its own share to its /32, so one host (a /64 may send 180 under its own limit) cannot use
      // up the /32's share before the minute is busy and so shut out everyone else in it: that takes 4 /48s
      const net = this.count('network', networkKey(ip))
      if (wide && net <= OAUTH_LIMITS.networkPerMinute) this.count('wide-network', wide)
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
    // a refresh token spent within REFRESH_REUSE_MS counts too, so a genuine retry is not slowed down (token() decides)
    const unspent = table === 'remote_mcp_tokens' ? `(t.used_at IS NULL OR t.used_at>${this.now() - REFRESH_REUSE_MS})` : 't.used_at IS NULL'
    return !!this.db.query(`SELECT 1 FROM ${table} t JOIN remote_mcp_grants g ON g.id=t.grant_id WHERE t.hash=? AND ${unspent} AND t.expires_at>?
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
    this.db.query('DELETE FROM remote_mcp_download_links WHERE expires_at <= ?').run(this.now())
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
  /** The person's signed-in browser session, for the consent page and the code. Never a guest (docs/DECISIONS.md "Guests:
   * only what they were invited to"): the remote connector reaches the team's files, rooms and skills. grant() refuses a
   * guest's grant on every request and upload too. */
  private browser(auth: AuthInfo): number {
    const row = this.db.query(`SELECT s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.id=? AND s.user_id=? AND u.status='active' AND u.deleted_at IS NULL AND u.must_change_password=0 AND u.guest=0`).get(auth.session.id, auth.user.id) as { expires_at: string } | null
    const end = row ? Date.parse(row.expires_at) : 0
    if (!end || end <= this.now() || auth.session.tempLogin) throw new OAuthError('access_denied', 403)
    return end
  }
  private pending(id: string, auth: AuthInfo): Pending {
    this.browser(auth)
    if (!this.origin) throw new OAuthError('invalid_request', 404)
    const r = this.db.query('SELECT * FROM remote_mcp_requests WHERE id=?').get(id) as Pending | null
    // gone (decided or cleared), expired, or opened by another login session: its own code, so the page can say so
    // plainly instead of "not found or no access" (QA TC-2970)
    if (!r || r.expires_at <= this.now() || (r.user_id !== null && (r.user_id !== auth.user.id || r.session_id !== auth.session.id))) throw new OAuthError(REMOTE_CONSENT_EXPIRED, 404)
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
    return { id, clientName: c.name, redirectOrigin: new URL(r.redirect_uri).origin, scopes: this.offered(JSON.parse(r.scopes), auth.user.id), optional: [...OPTIONAL_SCOPES] as string[], admin: isTeamAdmin(this.db, auth.user.id), resource: r.resource, expiresAt: iso(r.expires_at), browserProfiles: (this.db.query('SELECT COUNT(*) AS n FROM chrome_links WHERE user_id=?').get(auth.user.id) as { n: number }).n }
  }
  /**
   * The grant: mcp:read, plus mcp:write when `write` (left out: when the app asked for it), plus mcp:rooms when
   * `rooms` and mcp:rooms.write when `rooms` and `roomsWrite` (left out: no, whatever the app asked: a page that shows
   * no rooms box grants no rooms), plus mcp:admin when the person is an active owner or admin at this moment (no box,
   * and nothing the page sends changes it), plus offline_access always (asked for or not: the connection stays until the
   * person disconnects it, docs/decisions/20261121-mcp-refresh-without-offline-access.md). It may hold a scope the app
   * did not ask for; the token answer's `scope` names exactly what was granted (RFC 6749 3.3), and a refresh can only
   * narrow it.
   */
  decide(id: string, auth: AuthInfo, allow: boolean, o: { write?: boolean; rooms?: boolean; roomsWrite?: boolean; browser?: boolean } = {}) {
    return this.db.transaction(() => {
      const r = this.pending(id, auth), url = new URL(r.redirect_uri)
      this.db.query('DELETE FROM remote_mcp_requests WHERE id=?').run(id)
      if (r.state !== null) url.searchParams.set('state', r.state)
      url.searchParams.set('iss', this.enabled())
      if (!allow) { url.searchParams.set('error', 'access_denied'); return { redirectUrl: url.href } }
      this.rate('consent-user', auth.user.id, 20)
      // at most 50 live connections a person: the oldest ones make room (an app that signs in again often leaves its
      // old connections behind now that they no longer end with a browser sign-in), as Google drops the oldest token
      const old = this.db.query('SELECT id FROM remote_mcp_grants WHERE user_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT -1 OFFSET 49').all(auth.user.id, this.now()) as { id: string }[]
      for (const g of old) {
        audit(this.db, { actor: auth.user.id, action: 'remote_mcp.disconnected', target: g.id, detail: { app: grantApp(this.db, g.id), reason: 'too_many' } })
        this.revokeGrant(g.id)
      }
      // The connection's own session row (migration 130, connector = 1), not the browser sign-in that allowed it: signing
      // out there, or that sign-in expiring, does not end it. Ending every session of the person (password change,
      // sign out everywhere, disabled, removed) does (ON DELETE CASCADE). No token exists for the row.
      const grant = secret('tax_grant_'), code = secret('tax_code_'), end = this.now() + GRANT_MS, anchor = 'connector-' + grant
      this.db.query("INSERT INTO sessions (id, user_id, token_hash, client, user_agent, created_at, last_seen_at, expires_at, temp_login, connector) VALUES (?, ?, ?, 'web', 'MCP connector', ?, ?, ?, 0, 1)")
        .run(anchor, auth.user.id, 'connector:' + grant, iso(this.now()), iso(this.now()), iso(end))
      const asked = JSON.parse(r.scopes) as string[], chosen = new Set<string>(['mcp:read'])
      if (o.write ?? asked.includes('mcp:write')) chosen.add('mcp:write')
      if (o.rooms === true) chosen.add(ROOMS_SCOPE)
      if (o.rooms === true && o.roomsWrite === true) chosen.add(ROOMS_WRITE_SCOPE)
      // the person's browser profiles: only when ticked (an app's request never ticks it), never a guest (none signs in here)
      if (o.browser === true) chosen.add(BROWSER_SCOPE)
      if (isTeamAdmin(this.db, auth.user.id)) chosen.add(ADMIN_SCOPE)
      chosen.add('offline_access')
      const selected = SCOPES.filter(s => chosen.has(s))
      this.db.query('INSERT INTO remote_mcp_grants(id,client_id,user_id,session_id,resource,scopes,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').run(grant, r.client_id, auth.user.id, anchor, r.resource, JSON.stringify(selected), this.now(), end)
      this.db.query('INSERT INTO remote_mcp_codes VALUES(?,?,?,?,?,NULL)').run(hash(code), grant, r.redirect_uri, r.challenge, this.now() + CODE_MS)
      audit(this.db, { actor: auth.user.id, action: 'remote_mcp.connected', target: grant, detail: { scopes: selected, asked, app: grantApp(this.db, grant) } })
      url.searchParams.set('code', code)
      return { redirectUrl: url.href }
    }).immediate()
  }
  grant(id: string): Grant {
    const g = this.db.query(`SELECT g.* FROM remote_mcp_grants g JOIN users u ON u.id=g.user_id
      JOIN sessions s ON s.id=g.session_id AND s.user_id=g.user_id WHERE g.id=? AND u.status='active'
      AND u.deleted_at IS NULL AND u.must_change_password=0 AND u.guest=0 AND s.expires_at>?`).get(id, iso(this.now())) as Grant | null
    if (!g || g.revoked_at !== null || g.expires_at <= this.now() || g.resource !== this.resource()) throw invalid()
    return g
  }
  revokeGrant(id: string) {
    this.db.query('UPDATE remote_mcp_grants SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').run(this.now(), id)
    // what lives in memory for it (the browser's asks, once-answers, sessions: remote-mcp/browser.ts) goes now
    for (const l of grantEnded) try { l(id) } catch { /* a listener that throws changes nothing */ }
    // its own session row ends now: the session sweep removes it, and the grant, its codes and tokens cascade away
    // with it (until then a replay finds the grant revoked; after, finds nothing: invalid_grant either way)
    this.db.query('UPDATE sessions SET expires_at=? WHERE id=(SELECT session_id FROM remote_mcp_grants WHERE id=?) AND connector=1').run(iso(this.now()), id)
  }
  /** A refresh moves the end of a connection in use to now + GRANT_MS (grant, its own session row, the new refresh
   * token). A grant still on a browser sign-in (made before migration 130 and not moved) keeps its end. */
  private slide(g: Grant): Grant {
    const end = this.now() + GRANT_MS
    if (!this.db.query('UPDATE sessions SET expires_at=? WHERE id=? AND user_id=? AND connector=1').run(iso(end), g.session_id, g.user_id).changes) return g
    this.db.query('UPDATE remote_mcp_grants SET expires_at=? WHERE id=?').run(end, g.id)
    return { ...g, expires_at: end }
  }
  /** `parent`: the sha256 of the refresh token these come from (remote_mcp_token_links), none for a code exchange.
   * A refresh token too whenever the grant holds offline_access, which every grant decide() makes does, whether the app asked for it or not (ChatGPT and apps that ask for the 401
   * header's scope do not): the person's connection stays until they disconnect it or lose access, with the rotation,
   * retry window and replay revocation of token() (docs/decisions/20261121-mcp-refresh-without-offline-access.md). */
  private issue(g: Grant, selected: string[], parent: string | null = null) {
    const access = secret('tax_mcp_a_'), end = Math.min(g.expires_at, this.now() + ACCESS_MS)
    this.db.query('INSERT INTO remote_mcp_tokens VALUES(?,\'access\',?,?,NULL)').run(hash(access), g.id, end)
    // every grant decide() makes holds offline_access; a grant stored by an older build without it stays access-only
    let refresh: string | undefined
    if (selected.includes('offline_access')) {
      refresh = secret('tax_mcp_r_')
      this.db.query('INSERT INTO remote_mcp_tokens VALUES(?,\'refresh\',?,?,NULL)').run(hash(refresh), g.id, g.expires_at)
    }
    if (parent) for (const t of [access, refresh]) if (t) this.db.query('INSERT INTO remote_mcp_token_links (hash, parent) VALUES (?, ?)').run(hash(t), parent)
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
        const h = hash(token)
        if (row.used_at !== null) {
          // A spent refresh token. One retry case only: the answer to its refresh never arrived (lost on the network,
          // or a second process of the app refreshed with the same stored token at the same moment). That is so while
          // it is within REFRESH_REUSE_MS of being spent and nothing issued from it has been used yet: then what it
          // issued is replaced (superseded) and a fresh pair comes from it, so there is still one live chain. Anything
          // else is a replay of a stolen token and ends the whole connection, also inside the window. A token that a
          // retry replaced before it was used gets nothing and ends nothing: the app that holds it lost the race and
          // reads its stored token again (Claude Code keeps one store for all its processes) or signs in again.
          const link = this.db.query('SELECT superseded FROM remote_mcp_token_links WHERE hash=?').get(h) as { superseded: number } | null
          if (link?.superseded) throw invalid()
          const childUsed = this.db.query(`SELECT 1 FROM remote_mcp_token_links l JOIN remote_mcp_tokens t ON t.hash=l.hash
            WHERE l.parent=? AND l.superseded=0 AND (l.seen_at IS NOT NULL OR (t.kind='refresh' AND t.used_at IS NOT NULL))`).get(h)
          if (childUsed || this.now() - row.used_at > REFRESH_REUSE_MS) { this.revokeGrant(g.id); return invalid() }
          this.db.query('UPDATE remote_mcp_tokens SET used_at=? WHERE used_at IS NULL AND hash IN (SELECT hash FROM remote_mcp_token_links WHERE parent=?)').run(this.now(), h)
          this.db.query('UPDATE remote_mcp_token_links SET superseded=1 WHERE parent=?').run(h)
        }
        if (row.expires_at <= this.now()) throw invalid()
        const original = JSON.parse(g.scopes) as string[], asked = body.scope === undefined ? original : scopes(body.scope)
        if (asked.some(s => !original.includes(s))) throw new OAuthError('invalid_scope')
        // writing in conversations goes only with reading them (decide): narrowed away with it. Narrowing is about what
        // the app may reach, not how long it stays: offline_access is kept (a refresh token comes either way, issue())
        const selected = SCOPES.filter(s => (asked.includes(s) || (s === 'offline_access' && original.includes(s))) && (s !== ROOMS_WRITE_SCOPE || asked.includes(ROOMS_SCOPE)))
        // Spent refresh tokens are kept while the connection lasts (a replay of any of them, however late, ends it).
        // Access tokens that expired or were replaced, and refresh tokens that expired unused, go. The cap counts the
        // live tokens only (one chain: about two).
        this.db.query("DELETE FROM remote_mcp_tokens WHERE grant_id=? AND ((kind='access' AND (expires_at<=? OR used_at IS NOT NULL)) OR (kind='refresh' AND used_at IS NULL AND expires_at<=?))").run(g.id, this.now(), this.now())
        const count = this.db.query('SELECT count(*) AS n FROM remote_mcp_tokens WHERE grant_id=? AND used_at IS NULL').get(g.id) as { n: number }
        if (count.n >= 4096) { this.revokeGrant(g.id); return invalid() }
        // Narrowing persists for this grant and all future refreshes, never quietly expands again.
        this.db.query('UPDATE remote_mcp_grants SET scopes=? WHERE id=?').run(JSON.stringify(selected), g.id)
        // this refresh token is spent (a retry keeps its first time). Access tokens already given out end on their own
        // (ACCESS_MS) or with the connection.
        this.db.query('UPDATE remote_mcp_tokens SET used_at=? WHERE hash=? AND used_at IS NULL').run(this.now(), h)
        return this.issue(this.slide(g), selected, h)
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
    let g: Grant
    try { g = this.grant(row.grant_id) } catch { throw new OAuthError('invalid_token', 401) }
    // first use of an access token a refresh issued: from now on its refresh token cannot be retried (token())
    this.db.query('UPDATE remote_mcp_token_links SET seen_at=? WHERE hash=? AND seen_at IS NULL').run(this.now(), row.hash)
    return g
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
    return { configured: !!this.origin, resource: this.origin ? this.resource() : null, items: rows.map(g => ({ id: g.id, clientName: g.name, scopes: JSON.parse(g.scopes) as string[], createdAt: iso(g.created_at), expiresAt: iso(g.expires_at), browserPausedUntil: browserPausedUntil(this.db, g.id, this.now()) })) }
  }
  /** The person lets one of their connections use the browser again after a Stop (remote-mcp/browser.ts). */
  resumeBrowser(id: string, auth: AuthInfo) {
    this.browser(auth)
    const g = this.db.query('SELECT user_id FROM remote_mcp_grants WHERE id=? AND revoked_at IS NULL').get(id) as { user_id: string } | null
    if (!g || g.user_id !== auth.user.id) throw new OAuthError('invalid_request', 404)
    this.db.query('DELETE FROM remote_mcp_browser_pauses WHERE grant_id=?').run(id)
    audit(this.db, { actor: auth.user.id, action: 'remote_mcp.browser_resumed', target: id, detail: { app: grantApp(this.db, id) } })
  }
  disconnect(id: string, auth: AuthInfo) {
    this.browser(auth)
    const g = this.db.query('SELECT user_id FROM remote_mcp_grants WHERE id=?').get(id) as { user_id: string } | null
    if (!g || g.user_id !== auth.user.id) throw new OAuthError('invalid_request', 404)
    // its name first: the grant may be gone once revoked
    const app = grantApp(this.db, id)
    this.revokeGrant(id)
    audit(this.db, { actor: auth.user.id, action: 'remote_mcp.disconnected', target: id, detail: { app } })
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
