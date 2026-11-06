import crypto from 'node:crypto'
import path from 'node:path'
import type { AppContext } from '../../context'
import { newId } from '../../db'
import { audit } from '../../admin/audit'
import { resolveLayout } from '../../system/layout'
import { DRIVE_SCOPE, configKey, hash, readDriveConfig, type DriveConfig } from './config'
import { GoogleTransport, GOOGLE_AUTH, GOOGLE_TOKEN, GOOGLE_REVOKE, DRIVE_API, checkAbort, responseError, waitFor, backoff, type DriveFetch } from './client'
import { DriveStore, DriveError, type Account, type Tokens, type FlowSecret, type ConnectionRow } from './store'
import type { DriveConnection, DriveFlow } from '@mycel/shared/api'
import { notifyConnectionReconnect, notifyDriveShareReconnect } from '../../notifications/service'
import { membersCanConnect, onShareOwnerCheck, ownerOk, SHARE_CONTEXT, shareByName, shareRow, shareRows, shareWorks, teamSharesFor, type ShareRow } from './shares'
import { brokerKey, driveBrokerFor, DriveBroker, type BrokerOptions } from './broker'

/** `broker`: sign in through the hosting service (broker.ts); left out, driveBrokerFor decides (hosted, no own client). */
export interface DriveDeps { config?: DriveConfig | null; fetch?: DriveFetch; now?: () => number; broker?: BrokerOptions | null }
/** One Drive connection's way to call Google: a person's own, or a team share's (read.ts). */
export interface DriveConn {
  api(resource: string, query: Record<string, string>, maxBytes: number, signal?: AbortSignal): Promise<{ bytes: Uint8Array; assertCurrent: () => void }>
}
/** Whose tokens a request uses, and how they are kept: a person's connection row or a team share row. `fence` throws
 * once the row is not the one the request started with (disconnected, signed in again, folders changed, its admin
 * gone), so nothing from an old connection is delivered. */
interface Holder { id: string; op: string; fence(): void; load(): Tokens; save(t: Tokens): void; invalidate(): void }
const TTL = 10 * 60_000
/** how often a hosted server asks the hosting service whether its Google sign-in serves this team (broker.ts) */
const BROKER_CHECK_MS = 10 * 60_000, BROKER_RETRY_MS = 60_000
const challengeOf = (verifier: string) => crypto.createHash('sha256').update(verifier).digest('base64url')
const clean = (s: unknown, max: number) => typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : null
export class GoogleDrive {
  private cfg: DriveConfig | null
  private cfgKey: string
  /** the Google client in use (null: none of its own; Drive is off unless the hosting service signs in, `broker`); an
   * admin's in-app setup replaces it (admin-setup.ts reload()) */
  get config() { return this.cfg }
  /** sign-in through the hosting service (a hosted server without a client of its own), else null */
  readonly broker: DriveBroker | null
  private brokerOk = false
  private brokerCheckedAt = 0
  private brokerSeq = 0
  /** Drive can be used: a Google client of its own, or the hosting service's sign-in answered that it serves this team */
  get enabled() { return !!this.cfg || (!!this.broker && this.brokerOk) }
  /** 'direct': this server's own Google client; 'broker': the hosting service's; 'off' */
  get mode(): 'direct' | 'broker' | 'off' { return this.cfg ? 'direct' : this.broker && this.brokerOk ? 'broker' : 'off' }
  private get viaBroker() { return !this.cfg && !!this.broker }
  /** which client a connection or flow was made with: a new client makes old ones reconnect */
  get key() { return this.cfgKey }
  /** where the client is read from: MYCEL_GOOGLE_DRIVE_CLIENT_FILE, or <secrets>/integrations/google-drive/client.json */
  readonly clientFile: string
  /** the operator points to a client file of their own: the app never writes it (admin-setup.ts) */
  readonly clientFromEnv: boolean
  readonly store: DriveStore
  readonly transport: GoogleTransport
  readonly now: () => number
  private refreshes = new Map<string, Promise<Tokens>>()
  private operations = new Map<string, Set<AbortController>>()
  private revoking = new Set<string>()
  constructor(readonly ctx: AppContext, deps: DriveDeps = {}) {
    this.now = deps.now ?? Date.now
    const dir = path.join(resolveLayout(ctx.config).secretsDir, 'integrations', 'google-drive')
    this.clientFromEnv = !!process.env.MYCEL_GOOGLE_DRIVE_CLIENT_FILE
    this.clientFile = process.env.MYCEL_GOOGLE_DRIVE_CLIENT_FILE || path.join(dir, 'client.json')
    this.cfg = deps.config !== undefined ? deps.config : readDriveConfig(this.clientFile, ctx.config.teamRoot)
    const brokerOpts = deps.broker !== undefined ? deps.broker : driveBrokerFor(ctx, !!this.cfg, this.clientFromEnv)
    this.broker = brokerOpts ? new DriveBroker(brokerOpts, deps.fetch ?? fetch, this.now) : null
    this.cfgKey = this.cfg ? configKey(this.cfg) : this.broker ? brokerKey(this.broker.o.origin) : ''
    this.store = new DriveStore(ctx.db, dir, this.now)
    this.transport = new GoogleTransport(deps.fetch)
    const sweep = () => {
      try { this.store.sweep() } catch { ctx.log.warn('Drive flow cleanup deferred') }
      try { this.checkShareOwners() } catch { ctx.log.warn('Drive share check deferred') }
      if (this.broker && !this.cfg && this.now() - this.brokerCheckedAt >= (this.brokerOk ? BROKER_CHECK_MS : BROKER_RETRY_MS)) void this.checkBroker()
    }
    onShareOwnerCheck(ctx, () => this.checkShareOwners())
    sweep()
    const timer = setInterval(sweep, 60_000); timer.unref?.()
    ctx.onClose(() => { clearInterval(timer); for (const set of this.operations.values()) for (const c of set) c.abort() })
  }
  /** Read the client file again (after an admin's in-app setup). Connections and flows made with another client then
   * fail their config_key checks and ask the person to reconnect, as after an operator's change and restart. */
  reload() {
    this.cfg = readDriveConfig(this.clientFile, this.ctx.config.teamRoot)
    this.cfgKey = this.cfg ? configKey(this.cfg) : this.broker ? brokerKey(this.broker.o.origin) : ''
    return this.cfg
  }
  /** Ask the hosting service whether its Google sign-in serves this team (signed with the team key). Until it says
   * yes, Drive stays off here: no Connect button and no tools that would fail. */
  async checkBroker(): Promise<boolean> {
    if (!this.broker) return false
    this.brokerCheckedAt = this.now()
    const seq = ++this.brokerSeq
    const ok = await this.broker.ready()
    if (seq !== this.brokerSeq) return ok // a newer check's answer counts
    if (ok !== this.brokerOk) this.ctx.log.info(ok ? 'Google Drive sign-in through the hosting service is available' : 'Google Drive sign-in through the hosting service is not available')
    this.brokerOk = ok
    return ok
  }
  status(user: string): DriveConnection {
    const status = this.store.publicConnection(this.enabled, user, this.key)
    if (status.status === 'needs_reconnect') {
      const row = this.store.connection(user)
      if (row) this.invalidate(row)
    }
    return { ...status, personalAllowed: membersCanConnect(this.ctx.db), teamShares: this.enabled ? teamSharesFor(this.ctx.db, user, this.key) : [] }
  }
  /** Keep cancellation registered throughout a tool's download and conversion. */
  run<T>(user: string, signal: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<T>) { return this.operation(user, signal, fn) }
  private configured() { if (!this.enabled) throw new DriveError('not_configured', 503) }
  private busy(user: string) { if (this.revoking.has(user)) throw new DriveError('disconnecting', 409) }
  private async operation<T>(user: string, outer: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const c = new AbortController(), set = this.operations.get(user) ?? new Set<AbortController>()
    set.add(c); this.operations.set(user, set)
    const signal = AbortSignal.any([c.signal, ...(outer ? [outer] : [])])
    try { checkAbort(signal); return await fn(signal) }
    finally { set.delete(c); if (!set.size) this.operations.delete(user) }
  }
  /** Start a Google sign-in: the person's own Drive (only while the team allows it), or, for an admin, a Drive to share
   * with the team (`share`; with a share id, a new sign-in for that share). */
  authorize(user: string, session: string, share?: { shareId?: string }) {
    if (this.viaBroker) throw new DriveError('use_begin', 500) // the hosting service's sign-in is asynchronous: begin()
    const p = this.prepare(user, session, share), cfg = this.config!
    const url = new URL(GOOGLE_AUTH)
    for (const [k, v] of Object.entries({ client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: 'code', scope: DRIVE_SCOPE, access_type: 'offline', prompt: 'consent', state: p.state, code_challenge: challengeOf(p.verifier), code_challenge_method: 'S256' })) url.searchParams.set(k, v)
    return { flowId: p.id, authorizationUrl: url.href, expiresAt: p.expiresAt }
  }
  /** Start a Google sign-in either way: this server's own client (authorize), or the hosting service's (broker.ts),
   * which makes the Google address for this flow. The routes use this. */
  async begin(user: string, session: string, share?: { shareId?: string }) {
    if (!this.viaBroker) return this.authorize(user, session, share)
    const p = this.prepare(user, session, share)
    try {
      const authorizationUrl = await this.broker!.start(share ? 'share' : 'personal', p.state, challengeOf(p.verifier))
      return { flowId: p.id, authorizationUrl, expiresAt: p.expiresAt }
    } catch (e) {
      const reason = e instanceof DriveError ? e.reason : 'broker_unavailable'
      this.ctx.db.query("UPDATE drive_oauth_flows SET state='failed',reason=?,secret_enc=NULL WHERE id=? AND state='pending'").run(reason, p.id)
      throw e instanceof DriveError ? e : new DriveError('broker_unavailable', 503)
    }
  }
  /** The flow row both ways share: who, which session, the state's hash and the sealed PKCE verifier. */
  private prepare(user: string, session: string, share?: { shareId?: string }) {
    this.configured(); this.busy(user); this.store.session(user, session); this.store.sweep()
    const purpose = share ? 'share' : 'personal'
    if (share) {
      this.store.admin(user)
      if (share.shareId && !shareRow(this.ctx.db, share.shareId)) throw new DriveError('not_found', 404)
    } else if (!membersCanConnect(this.ctx.db)) throw new DriveError('members_off', 403)
    const now = this.now(), id = newId(), state = crypto.randomBytes(32).toString('base64url'), verifier = crypto.randomBytes(48).toString('base64url')
    // Bound creation rate without retaining a plaintext verifier or authorization URL.
    const n = (this.ctx.db.query('SELECT count(*) n FROM drive_oauth_flows WHERE user_id=? AND created_at>?').get(user, new Date(now - 3600_000).toISOString()) as { n: number }).n
    if (n >= 20) throw new DriveError('rate_limited', 429)
    const sealed = this.store.seal(user, id, { verifier })
    const expiresAt = new Date(now + TTL).toISOString()
    this.ctx.db.transaction(() => {
      this.ctx.db.query("UPDATE drive_oauth_flows SET state='failed',reason='superseded',secret_enc=NULL,account=NULL WHERE user_id=? AND purpose=? AND state IN ('pending','exchanging','ready')").run(user, purpose)
      this.ctx.db.query(`INSERT INTO drive_oauth_flows(id,user_id,session_id,state_hash,config_key,state,secret_enc,key_version,expires_at,created_at,purpose,share_id) VALUES(?,?,?,?,?,'pending',?,?,?,?,?,?)`)
        .run(id, user, session, hash(state), this.key, sealed.enc, sealed.keyVersion, expiresAt, new Date(now).toISOString(), purpose, share?.shareId ?? null)
    })()
    return { id, state, verifier, expiresAt }
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
  /** Google's (direct) or the hosting service's (broker: `handoff` instead of `code`) return to this server. */
  async callback(input: { state?: string; code?: string; error?: string; handoff?: string }, browser?: { userId: string; sessionId: string }): Promise<boolean> {
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
      if (input.error) throw new DriveError(input.error === 'provider_error' ? 'provider_unavailable' : 'consent_denied')
      const viaBroker = this.viaBroker
      if (viaBroker ? !input.handoff || !/^[A-Za-z0-9_-]{43}$/.test(input.handoff) : !input.code || input.code.length > 4096) throw new DriveError('invalid_flow')
      const s = this.store.open<FlowSecret>(r), cfg = this.config
      const result = await this.operation(r.user_id, undefined, async signal => {
        // broker: the hosting service exchanges Google's code only now, for this team and this flow's verifier
        const json = viaBroker
          ? await this.broker!.redeem(input.handoff!, s.verifier, signal)
          : await this.exchange({ grant_type: 'authorization_code', code: input.code!, redirect_uri: cfg!.redirectUri, code_verifier: s.verifier }, signal)
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
    if (r.purpose !== 'personal') throw new DriveError('not_found', 404)
    if (!membersCanConnect(this.ctx.db)) throw new DriveError('members_off', 403)
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
  /** An admin confirms the Google account of a share sign-in: a new share (no folders, nobody in its rule yet: the
   * admin chooses them next), or the new sign-in of one (its folders and rule stay; the admin is its owner now). */
  completeShare(user: string, session: string, id: string, name?: string): ShareRow {
    this.configured(); this.busy(user)
    const r = this.store.ownFlow(user, session, id)
    if (r.purpose !== 'share') throw new DriveError('not_found', 404)
    this.store.admin(user)
    if (r.config_key !== this.key || r.state !== 'ready') throw new DriveError('flow_not_ready', 409)
    const s = this.store.open<FlowSecret>(r)
    if (!s.tokens || !s.account || !s.scopes?.includes(DRIVE_SCOPE)) throw new DriveError('invalid_flow')
    const db = this.ctx.db, now = new Date(this.now()).toISOString(), expires = new Date(s.tokens.expiresAt).toISOString()
    const existing = r.share_id ? shareRow(db, r.share_id) : null
    if (r.share_id && !existing) throw new DriveError('not_found', 404)
    const shareId = existing?.id ?? newId()
    const wanted = (name ?? '').trim().slice(0, 60) || 'Company Drive'
    if (!existing && shareByName(db, wanted)) throw new DriveError('name_taken', 409)
    const sealed = this.store.seal(SHARE_CONTEXT, shareId, s.tokens)
    db.transaction(() => {
      if (existing) {
        db.query(`UPDATE drive_team_shares SET owner_user_id=?,config_key=?,account=?,scopes=?,secret_enc=?,key_version=?,status='connected',reason=NULL,version=version+1,expires_at=?,updated_at=? WHERE id=?`)
          .run(user, this.key, JSON.stringify(s.account), JSON.stringify(s.scopes), sealed.enc, sealed.keyVersion, expires, now, shareId)
      } else {
        db.query(`INSERT INTO drive_team_shares(id,name,owner_user_id,config_key,account,scopes,secret_enc,key_version,folders,whole_drive,status,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'[]',0,'connected',?,?,?)`)
          .run(shareId, wanted, user, this.key, JSON.stringify(s.account), JSON.stringify(s.scopes), sealed.enc, sealed.keyVersion, expires, now, now)
      }
      db.query("UPDATE drive_oauth_flows SET state='completed',secret_enc=NULL WHERE id=?").run(id)
    })()
    this.abort(`share:${shareId}`)
    // the account's email is not in the log: who did it and which share
    audit(db, { actor: user, action: existing ? 'drive.share_reconnected' : 'drive.share_created', target: shareId, detail: existing ? null : { name: wanted } })
    return shareRow(db, shareId)!
  }
  /** The way a member's tool call reaches Google through a team share. The caller checks the rule and the folders. */
  shareConn(row: ShareRow): DriveConn {
    this.configured()
    if (!shareWorks(this.ctx.db, row, this.key)) throw new DriveError('needs_reconnect', 409)
    return { api: (resource, query, maxBytes, signal) => this.request(this.shareHolder(row), resource, query, maxBytes, signal) }
  }
  /** A person's own connection as a DriveConn (tools, read.ts). */
  userConn(user: string): DriveConn {
    return { api: (resource, query, maxBytes, signal) => this.api(user, resource, query, maxBytes, signal) }
  }
  /** Abort the requests under way for one person or share ("share:<id>"). */
  abort(key: string) { for (const c of this.operations.get(key) ?? []) c.abort() }
  /** Revoke a refresh token at Google (best effort). */
  async revoke(token: string | null): Promise<'revoked' | 'unavailable' | 'not_needed'> {
    if (!token) return 'not_needed'
    // a token sealed by the hosting service (broker.ts) is revoked there: this server cannot open it
    if (token.startsWith('ev1.')) return this.broker ? this.broker.revoke(token) : 'unavailable'
    try {
      const r = await this.transport.request(GOOGLE_REVOKE, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) }, 16_384)
      return r.status === 200 ? 'revoked' : 'unavailable'
    } catch { return 'unavailable' }
  }
  /** A share's refresh token, if its tokens can still be opened. */
  shareToken(row: ShareRow): string | null {
    if (!row.secret_enc) return null
    try { return this.store.open<Tokens>({ id: row.id, user_id: SHARE_CONTEXT, secret_enc: row.secret_enc, key_version: row.key_version }).refreshToken } catch { return null }
  }
  /** Shares whose admin left, was disabled or is no longer an admin stop: tokens deleted (and revoked at Google), and
   * every admin is told to sign in again. Runs with the sweep, after any change of people (admin/folders.ts
   * afterAccessChange) and whenever a share is used. */
  checkShareOwners(): number {
    const db = this.ctx.db
    const gone = shareRows(db).filter((r) => r.secret_enc && !ownerOk(db, r))
    for (const r of gone) {
      const token = this.shareToken(r)
      const changed = db.query("UPDATE drive_team_shares SET secret_enc=NULL,status='needs_reconnect',reason='owner_gone',version=version+1,updated_at=? WHERE id=? AND version=?")
        .run(new Date(this.now()).toISOString(), r.id, r.version).changes
      if (!changed) continue
      this.abort(`share:${r.id}`)
      audit(db, { actor: null, action: 'drive.share_owner_gone', target: r.id })
      notifyDriveShareReconnect(this.ctx, r.id, `${r.id}.v${r.version + 1}`)
      void this.revoke(token)
    }
    return gone.length
  }
  private shareHolder(row: ShareRow): Holder {
    const db = this.ctx.db
    const current = () => {
      const c = shareRow(db, row.id)
      if (!c || c.version !== row.version || !shareWorks(db, c, this.key)) {
        if (c && c.secret_enc && !ownerOk(db, c)) this.checkShareOwners()
        throw new DriveError('needs_reconnect', 409)
      }
      return c
    }
    return {
      id: `share:${row.id}`, op: `share:${row.id}`,
      fence: () => { current() },
      load: () => { const c = current(); return this.store.open<Tokens>({ id: c.id, user_id: SHARE_CONTEXT, secret_enc: c.secret_enc, key_version: c.key_version }) },
      save: (tokens) => {
        const sealed = this.store.seal(SHARE_CONTEXT, row.id, tokens)
        db.query('UPDATE drive_team_shares SET secret_enc=?,key_version=?,expires_at=?,updated_at=? WHERE id=? AND version=?').run(sealed.enc, sealed.keyVersion, new Date(tokens.expiresAt).toISOString(), new Date(this.now()).toISOString(), row.id, row.version)
      },
      invalidate: () => {
        const at = new Date(this.now()).toISOString()
        if (db.query("UPDATE drive_team_shares SET status='needs_reconnect',reason='signed_out',updated_at=? WHERE id=? AND version=? AND status='connected'").run(at, row.id, row.version).changes)
          notifyDriveShareReconnect(this.ctx, row.id, `${row.id}.v${row.version}`)
      },
    }
  }
  private userHolder(row: ConnectionRow): Holder {
    return {
      id: row.id, op: row.user_id,
      fence: () => this.store.assertCurrent(row),
      // The request's row is a fence, not a token snapshot: a prior refresh may have rotated the secret.
      load: () => this.store.open<Tokens>(this.store.connection(row.user_id)!),
      save: (tokens) => {
        const sealed = this.store.seal(row.user_id, row.id, tokens)
        this.ctx.db.query('UPDATE drive_connections SET secret_enc=?,key_version=?,expires_at=?,updated_at=? WHERE id=? AND version=?').run(sealed.enc, sealed.keyVersion, new Date(tokens.expiresAt).toISOString(), new Date(this.now()).toISOString(), row.id, row.version)
      },
      invalidate: () => this.invalidate(row),
    }
  }
  private exchange(fields: Record<string, string>, signal?: AbortSignal) {
    const c = this.config
    if (!c) throw new DriveError('not_configured', 503)
    return this.transport.json(GOOGLE_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...fields, client_id: c.clientId, client_secret: c.clientSecret }), signal }, 32_768)
  }
  private tokens(j: Record<string, any>, previous?: Tokens): Tokens {
    const access = j.access_token, refresh = j.refresh_token ?? previous?.refreshToken, expiry = j.expires_in
    if (typeof access !== 'string' || !access || access.length > 16_384 || typeof refresh !== 'string' || !refresh || refresh.length > 16_384 || typeof expiry !== 'number' || !Number.isFinite(expiry) || expiry <= 0 || expiry > 31_536_000) throw new DriveError('needs_reconnect', 409)
    return { accessToken: access, refreshToken: refresh, expiresAt: this.now() + expiry * 1000 }
  }
  private row(user: string) {
    this.configured(); this.busy(user); this.store.active(user)
    if (!membersCanConnect(this.ctx.db)) throw new DriveError('members_off', 403)
    const r = this.store.connection(user)
    if (!r || r.config_key !== this.key || r.status !== 'connected') { if (r) this.invalidate(r); throw new DriveError('needs_reconnect', 409) }
    return r
  }
  private async access(h: Holder, rejectedAccess?: string): Promise<Tokens> {
    h.fence()
    let prev: Tokens
    try { prev = h.load() } catch { h.invalidate(); throw new DriveError('needs_reconnect', 409) }
    if (prev.expiresAt > this.now() + 60_000 && (!rejectedAccess || prev.accessToken !== rejectedAccess)) return prev
    const pending = this.refreshes.get(h.id)
    if (pending) return pending
    const task = this.operation(h.op, undefined, async signal => {
      try {
        h.fence()
        const j = this.viaBroker
          ? await this.broker!.refresh(prev.refreshToken, signal)
          : await this.exchange({ grant_type: 'refresh_token', refresh_token: prev.refreshToken }, signal)
        if (typeof j.scope === 'string' && !j.scope.split(/\s+/).includes(DRIVE_SCOPE)) throw new DriveError('needs_reconnect', 409)
        const tokens = this.tokens(j, prev)
        checkAbort(signal); h.fence()
        h.save(tokens)
        return tokens
      } catch (e) { if (e instanceof DriveError && (e.reason === 'needs_reconnect' || e.reason === 'unauthorized_provider')) h.invalidate(); throw e }
    })
    this.refreshes.set(h.id, task)
    try { return await task } finally { if (this.refreshes.get(h.id) === task) this.refreshes.delete(h.id) }
  }
  private invalidate(row: ConnectionRow) {
    this.ctx.db.query("UPDATE drive_connections SET status='needs_reconnect',updated_at=? WHERE id=? AND version=? AND status='connected'").run(new Date(this.now()).toISOString(), row.id, row.version)
    const current = this.store.connection(row.user_id)
    if (current?.id === row.id && current.status === 'needs_reconnect') notifyConnectionReconnect(this.ctx, row.user_id, row.id, current.updated_at)
  }
  async api(user: string, resource: string, query: Record<string, string>, maxBytes: number, signal?: AbortSignal) {
    return this.request(this.userHolder(this.row(user)), resource, query, maxBytes, signal)
  }
  private async request(h: Holder, resource: string, query: Record<string, string>, maxBytes: number, signal?: AbortSignal) {
    if (!/^(about|drives(?:\/[A-Za-z0-9_-]{1,256})?|files(?:\/[A-Za-z0-9_-]{1,256}(?:\/export)?)?)$/.test(resource)) throw new DriveError('invalid_endpoint')
    h.fence()
    return this.operation(h.op, signal, async inner => {
      let token = await waitFor(this.access(h), inner), refreshed = false, retries = 0
      for (;;) {
        checkAbort(inner); h.fence()
        const u = new URL(resource, DRIVE_API); u.search = new URLSearchParams(query).toString()
        const r = await this.transport.request(u.href, { headers: { Authorization: `Bearer ${token.accessToken}` }, signal: inner }, maxBytes)
        checkAbort(inner); h.fence()
        if (r.status === 401 && !refreshed) { refreshed = true; token = await waitFor(this.access(h, token.accessToken), inner); continue }
        if ((r.status === 429 || r.status >= 500) && retries < 2) { await backoff(++retries * 150, inner); continue }
        if (r.status < 200 || r.status >= 300) { if (r.status === 401) h.invalidate(); throw responseError(r.status) }
        return { bytes: r.bytes, assertCurrent: () => { checkAbort(inner); h.fence() } }
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
    let revocation: 'revoked' | 'unavailable' | 'not_needed'
    try { revocation = await this.revoke(token) } finally { this.revoking.delete(user) }
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
