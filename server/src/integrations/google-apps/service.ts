// Gmail, Google Calendar, Google Docs and Google Sheets (docs/GOOGLE-APPS.md): a person's own connection to each app,
// with one Google sign-in per app, and the admin's setup per card.
//
// A connection is a personal row of `integrations` with `google_app` set (migration 341): the sealed OAuth tokens, the
// refresh (tokens.ts), the write card and Always allow (connections/tools.ts gate), the per-tool switches, scheduled-run
// rules and the audit all work as for any member's own MCP connection. Its MCP calls go to the Google Workspace MCP
// server this server runs on 127.0.0.1 (library.ts, transport.ts) with the person's access token, never anywhere else.
//
// Sign-in: like Google Drive's (google-drive/oauth.ts): bound to the person and the session that started it, PKCE S256
// and a hashed state, Google's answer needs the same signed-in person in the browser, then the person confirms the
// account shown. Directly with the card's Google app (config.ts), or through the hosting service's (the Drive broker
// with the `app` field) on a hosted server. Scopes: the app's fixed set (shared/src/cloud-protocol/drive-broker.ts
// GOOGLE_APP_BROKER_SCOPES), identity scopes included (the library checks each token with Google's userinfo).
//
// Disconnect removes the app's tokens at once; Google is asked to revoke only when it was the person's last Google
// sign-in here (these four and their Google Drive): a revoked grant can end the others made with the same Google app.
//
// Nothing here returns, logs or audits a token, a client secret or the person's Google address.
import crypto from 'node:crypto'
import fs from 'node:fs'
import type { GoogleAppAdminStatus, GoogleAppFlow, GoogleAppId, GoogleAppView } from '@mycel/shared/api'
import { GOOGLE_APP_BROKER_SCOPES } from '@mycel/shared/cloud-protocol'
import type { AppContext } from '../../context'
import { newId } from '../../db'
import { audit } from '../../admin/audit'
import { setSetting } from '../../admin/settings'
import { isHosted } from '../../system/deployment'
import { GOOGLE_AUTH, GOOGLE_REVOKE, GOOGLE_TOKEN, GOOGLE_USERINFO, type DriveFetch } from '../google-drive/client'
import { googleDriveOf, ownsLiveDriveShare } from '../google-drive/oauth'
import { DriveError } from '../google-drive/store'
import { integrationsOf } from '../connections/service'
import { connectionAad, getRow, savedTools, selectRows, type Row } from '../connections/store'
import { APIS, APP_IDS, APP_NAMES, APP_SLUGS, catalog, membersOn, membersSettingKey, placeholderUrl } from './catalog'
import { clientFromBody, clientSettingKey, driveAppAvailable, redirectUriOf, safeAppsDir, appsSecretsDir, readAppClient, setupOf, writeClientFile, type AppSetup } from './config'
import { googleTransport, isGoogleAppSecret, setGoogleFetch, tokensOf, type GoogleAppSecret } from './tokens'
import { workspaceLibraryOf } from './library'

export class GoogleAppError extends Error {
  name = 'GoogleAppError'
  constructor(readonly reason: string, readonly status = 400) { super(`google_app_${reason}`) }
}

interface FlowRow {
  id: string; app: GoogleAppId; user_id: string; session_id: string; state_hash: string; config_key: string
  state: GoogleAppFlow['state'] | 'expired'; secret_enc: string | null; key_version: number; account: string | null; reason: string | null
  expires_at: string; created_at: string
}
interface Account { subject: string; name: string | null; email: string | null }
interface FlowSecret { verifier: string; tokens?: { accessToken: string; refreshToken: string; expiresAt: number | null }; account?: Account; scope?: string }

const TTL = 10 * 60_000
const FLOWS_PER_HOUR = 20
/** how long a card says "not available yet" after the hosting service refused the app (then it is tried again) */
const LIMITED_MS = 10 * 60_000
const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
const challengeOf = (verifier: string) => crypto.createHash('sha256').update(verifier).digest('base64url')
const clean = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : null)
const flowAad = (f: Pick<FlowRow, 'id' | 'user_id'>) => `google-app-flow:${f.user_id}:${f.id}`
/** the scopes Google must have granted: the app's own and the email address (the library checks the token with it) */
const required = (app: GoogleAppId) => GOOGLE_APP_BROKER_SCOPES[app].filter((s) => s !== 'openid')
const G = 'https://www.googleapis.com/auth/'
/** A broader scope Google may grant in place of a narrower one we ask for (it can fold them together): the narrower
 * counts as granted. Kept to this small explicit list; trina-cloud's broker has the same one. */
const BROADER: Record<string, string[]> = {
  [`${G}calendar.readonly`]: [`${G}calendar`], [`${G}calendar.events`]: [`${G}calendar`],
  [`${G}documents.readonly`]: [`${G}documents`], [`${G}spreadsheets.readonly`]: [`${G}spreadsheets`],
  [`${G}gmail.readonly`]: [`${G}gmail.modify`],
  [`${G}drive.readonly`]: [`${G}drive`], [`${G}drive.file`]: [`${G}drive`],
}
/** Google's short names for the identity scopes */
const SHORT: Record<string, string> = { email: `${G}userinfo.email`, profile: `${G}userinfo.profile` }
/** Every scope of `wanted` was granted, itself or through a broader one (BROADER, SHORT). */
export function scopesCover(granted: readonly string[], wanted: readonly string[]): boolean {
  const have = new Set(granted.map((s) => SHORT[s] ?? s))
  return wanted.every((w) => have.has(SHORT[w] ?? w) || (BROADER[w] ?? []).some((b) => have.has(b)))
}

export interface GoogleAppsDeps { fetch?: DriveFetch; now?: () => number }

export class GoogleApps {
  readonly now: () => number
  private limited = new Map<GoogleAppId, number>()
  /** connections whose tool list is being read now (one check at a time each) */
  private checking = new Set<string>()
  private wanted: string | null | undefined = undefined
  constructor(readonly ctx: AppContext, deps: GoogleAppsDeps = {}) {
    this.now = deps.now ?? Date.now
    if (deps.fetch) setGoogleFetch(ctx, deps.fetch)
    const sweep = () => {
      try { this.sweep() } catch { ctx.log.warn('Google apps sweep deferred') }
      try { this.syncLibrary() } catch { ctx.log.warn('Google apps library check deferred') }
    }
    sweep()
    const timer = setInterval(sweep, 60_000); timer.unref?.()
    ctx.onClose(() => clearInterval(timer))
  }
  private get db() { return this.ctx.db }
  private get box() { return integrationsOf(this.ctx).box }
  private library() { return workspaceLibraryOf(this.ctx) }

  // ---------------- the library ----------------
  /** The library runs while at least one app is set up (with one configured client's ID; the hosting service's sign-in
   * has none here). Told again only when that changes. */
  syncLibrary() {
    const setups = APP_IDS.map((a) => setupOf(this.ctx, a)).filter((s) => s.mode !== 'off')
    const id = setups.length ? setups.find((s) => s.client)?.client?.clientId ?? 'hosting-service' : null
    if (id === this.wanted) return
    this.wanted = id
    this.library().want(id)
  }

  /** Expired flows end; connections whose tools were never read (the library was down when they connected) are checked
   * once the library is up. */
  sweep() {
    const now = new Date(this.now()).toISOString()
    this.db.query("UPDATE google_app_flows SET state='expired', secret_enc=NULL WHERE expires_at<=? AND state IN ('pending','exchanging','ready')").run(now)
    this.db.query('DELETE FROM google_app_flows WHERE expires_at<?').run(new Date(this.now() - 86_400_000).toISOString())
    if (this.library().state() !== 'ready') return
    const rows = this.db.query(`${selectRows(this.db)} WHERE google_app IS NOT NULL AND secret_enc IS NOT NULL AND status != 'needs_auth'`).all() as Row[]
    for (const r of rows) if (!savedTools(this.db, r).length) this.readTools(r)
  }
  /** read a connection's tool list from the library, not waited for, one check at a time per connection */
  private readTools(row: Row) {
    if (this.checking.has(row.id)) return
    this.checking.add(row.id)
    void integrationsOf(this.ctx).check(row).catch(() => {}).finally(() => this.checking.delete(row.id))
  }

  // ---------------- a person's view ----------------
  private row(user: string, app: GoogleAppId): Row | null {
    return this.db.query(`${selectRows(this.db)} WHERE scope = 'personal' AND owner_user_id = ? AND google_app = ?`).get(user, app) as Row | null
  }
  private secretOf(row: Row): GoogleAppSecret | null {
    if (!row.secret_enc) return null
    try { const s = this.box.open<unknown>(connectionAad(row), row.secret_enc, row.key_version); return isGoogleAppSecret(s) ? s : null } catch { return null }
  }
  private isLimited(app: GoogleAppId) { const at = this.limited.get(app); return at !== undefined && this.now() - at < LIMITED_MS }

  /** Why nobody but an admin's setup can make the app connectable now (null: members can connect it). The same for
   * every member (integrations/service-requests.ts reads it too). */
  reasonOf(app: GoogleAppId): GoogleAppView['reason'] {
    const setup = setupOf(this.ctx, app), lib = this.library().state()
    return lib === 'unsupported' ? 'unsupported' : setup.mode === 'off' ? 'not_set_up' : !membersOn(this.db, app) ? 'members_off'
      : setup.mode === 'broker' && this.isLimited(app) ? 'service_limited' : null
  }

  view(user: string, app: GoogleAppId): GoogleAppView {
    const setup = setupOf(this.ctx, app), lib = this.library().state()
    const reason = this.reasonOf(app)
    const row = this.row(user, app)
    const secret = row ? this.secretOf(row) : null
    const status: GoogleAppView['status'] = !row ? 'disconnected' : secret && row.status !== 'needs_auth' && secret.google.key === setup.key ? 'connected' : 'needs_reconnect'
    let account: GoogleAppView['account'] = null
    try { if (row?.account) { const a = JSON.parse(row.account) as Account; account = { name: a.name ?? null, email: a.email ?? null } } } catch {}
    // a connection whose tools were never read: read them now that someone looks (not waited for)
    if (status === 'connected' && lib === 'ready' && row && !savedTools(this.db, row).length) this.readTools(row)
    return {
      id: app, available: reason === null, reason, status, account,
      writePolicy: row?.write_policy === 'allow' ? 'allow' : 'ask',
      serviceDown: status === 'connected' && lib !== 'ready' && lib !== 'unsupported',
      tools: catalog(app),
    }
  }
  list(user: string): { apps: GoogleAppView[] } { return { apps: APP_IDS.map((a) => this.view(user, a)) } }

  // ---------------- signing in ----------------
  private active(user: string) {
    if (!this.db.query("SELECT 1 FROM users WHERE id=? AND status='active' AND deleted_at IS NULL AND must_change_password=0").get(user)) throw new GoogleAppError('access_denied', 403)
  }
  private session(user: string, session: string) {
    this.active(user)
    if (!this.db.query('SELECT 1 FROM sessions WHERE id=? AND user_id=? AND expires_at>?').get(session, user, new Date(this.now()).toISOString())) throw new GoogleAppError('session_ended', 401)
  }
  /** the app can be connected now (else why not) */
  private usable(app: GoogleAppId): AppSetup {
    if (this.library().state() === 'unsupported') throw new GoogleAppError('unsupported', 409)
    const setup = setupOf(this.ctx, app)
    if (setup.mode === 'off') throw new GoogleAppError('not_set_up', 409)
    if (!membersOn(this.db, app)) throw new GoogleAppError('members_off', 403)
    return setup
  }

  async authorize(user: string, session: string, app: GoogleAppId): Promise<{ flowId: string; authorizationUrl: string; connectUrl?: string; expiresAt: string }> {
    this.session(user, session)
    const setup = this.usable(app)
    this.sweep()
    const now = this.now()
    const n = (this.db.query('SELECT count(*) n FROM google_app_flows WHERE user_id=? AND created_at>?').get(user, new Date(now - 3600_000).toISOString()) as { n: number }).n
    if (n >= FLOWS_PER_HOUR) throw new GoogleAppError('rate_limited', 429)
    const id = newId(), state = crypto.randomBytes(32).toString('base64url'), verifier = crypto.randomBytes(48).toString('base64url')
    let sealed
    try { sealed = this.box.seal(flowAad({ id, user_id: user }), { verifier } satisfies FlowSecret) } catch { throw new GoogleAppError('key_unsafe', 503) }
    const expiresAt = new Date(now + TTL).toISOString()
    this.db.transaction(() => {
      this.db.query("UPDATE google_app_flows SET state='failed', reason='superseded', secret_enc=NULL, account=NULL WHERE user_id=? AND app=? AND state IN ('pending','exchanging','ready')").run(user, app)
      this.db.query(`INSERT INTO google_app_flows (id, app, user_id, session_id, state_hash, config_key, state, secret_enc, key_version, expires_at, created_at)
        VALUES (?,?,?,?,?,?,'pending',?,?,?,?)`).run(id, app, user, session, hash(state), setup.key, sealed.enc, sealed.keyVersion, expiresAt, new Date(now).toISOString())
    })()
    if (setup.mode === 'broker') {
      try {
        const urls = await googleDriveOf(this.ctx).broker!.start('personal', state, challengeOf(verifier), app)
        this.limited.delete(app)
        return { flowId: id, ...urls, expiresAt }
      } catch (e) {
        const reason = e instanceof DriveError ? e.reason : 'broker_unavailable'
        if (reason === 'service_limited') this.limited.set(app, this.now())
        this.db.query("UPDATE google_app_flows SET state='failed', reason=?, secret_enc=NULL WHERE id=? AND state='pending'").run(reason, id)
        throw new GoogleAppError(reason, reason === 'service_limited' ? 409 : 503)
      }
    }
    const c = setup.client!
    const url = new URL(GOOGLE_AUTH)
    for (const [k, v] of Object.entries({
      client_id: c.clientId, redirect_uri: c.redirectUri, response_type: 'code', scope: GOOGLE_APP_BROKER_SCOPES[app].join(' '),
      access_type: 'offline', prompt: 'consent', state, code_challenge: challengeOf(verifier), code_challenge_method: 'S256',
    })) url.searchParams.set(k, v)
    return { flowId: id, authorizationUrl: url.href, expiresAt }
  }

  private ownFlow(user: string, session: string, app: GoogleAppId, id: string): FlowRow {
    this.session(user, session)
    this.sweep()
    const f = this.db.query('SELECT * FROM google_app_flows WHERE id=?').get(id) as FlowRow | null
    if (!f || f.user_id !== user || f.session_id !== session || f.app !== app) throw new GoogleAppError('not_found', 404)
    return f
  }
  flow(user: string, session: string, app: GoogleAppId, id: string): GoogleAppFlow {
    const f = this.ownFlow(user, session, app, id)
    let account: GoogleAppFlow['account'] = null
    try { if (f.account) { const a = JSON.parse(f.account) as Account; account = { name: a.name ?? null, email: a.email ?? null } } } catch {}
    return { flowId: f.id, state: f.state, account, expiresAt: f.expires_at, reason: f.reason }
  }
  cancel(user: string, session: string, app: GoogleAppId, id: string) {
    this.ownFlow(user, session, app, id)
    this.db.query("UPDATE google_app_flows SET state='failed', reason='cancelled', secret_enc=NULL, account=NULL WHERE id=? AND state!='completed'").run(id)
  }

  /** Google's (direct) or the hosting service's (`handoff` instead of `code`) return to this server. The browser must be
   * signed in as the person who started it: a leaked sign-in address cannot attach someone else's Google consent. */
  async callback(input: { state?: string; code?: string; error?: string; handoff?: string }, browser?: { userId: string; sessionId: string }): Promise<boolean> {
    this.sweep()
    if (!input.state || !/^[A-Za-z0-9_-]{43}$/.test(input.state)) return false
    const f = this.db.query('SELECT * FROM google_app_flows WHERE state_hash=?').get(hash(input.state)) as FlowRow | null
    if (!f || f.state !== 'pending') return false
    if (!browser || browser.userId !== f.user_id) return false
    try { this.session(browser.userId, browser.sessionId); this.session(f.user_id, f.session_id) } catch { return false }
    const setup = setupOf(this.ctx, f.app)
    if (setup.key !== f.config_key || setup.mode === 'off') return false
    if (!this.db.query("UPDATE google_app_flows SET state='exchanging' WHERE id=? AND state='pending'").run(f.id).changes) return false
    const failed = (reason: string) => { this.db.query("UPDATE google_app_flows SET state='failed', reason=?, secret_enc=NULL, account=NULL WHERE id=? AND state='exchanging'").run(reason, f.id); return false }
    try {
      if (input.error) return failed(input.error === 'provider_error' ? 'provider_unavailable' : setup.mode === 'broker' ? 'consent_denied_service' : 'consent_denied')
      const broker = setup.mode === 'broker'
      if (broker ? !input.handoff || !/^[A-Za-z0-9_-]{43}$/.test(input.handoff) : !input.code || input.code.length > 4096) return failed('invalid_flow')
      const s = this.box.open<FlowSecret>(flowAad(f), f.secret_enc, f.key_version)
      const t = googleTransport(this.ctx)
      const json = broker
        ? await googleDriveOf(this.ctx).broker!.redeem(input.handoff!, s.verifier)
        : await t.json(GOOGLE_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: input.code!, redirect_uri: setup.client!.redirectUri, code_verifier: s.verifier, client_id: setup.client!.clientId, client_secret: setup.client!.clientSecret }) }, 32_768)
      const granted = typeof json.scope === 'string' ? json.scope.split(/\s+/) : []
      // every scope the app needs: a person who unticks one on Google's page would get tools that fail
      if (!scopesCover(granted, required(f.app))) return failed('scope_denied')
      let tokens
      try { tokens = tokensOf(json, this.now()) } catch { return failed('exchange') }
      const me = await t.json(GOOGLE_USERINFO, { headers: { Authorization: `Bearer ${tokens.accessToken}` } }, 32_768)
      if (typeof me.sub !== 'string' || !me.sub || me.sub.length > 256) return failed('invalid_provider_response')
      const account: Account = { subject: me.sub, name: clean(me.name, 200), email: clean(me.email, 320) }
      const cur = this.db.query('SELECT state, expires_at FROM google_app_flows WHERE id=?').get(f.id) as { state: string; expires_at: string } | null
      if (!cur || cur.state !== 'exchanging' || cur.expires_at <= new Date(this.now()).toISOString()) return failed('invalid_flow')
      const sealed = this.box.seal(flowAad(f), { verifier: '', tokens: { ...tokens, refreshToken: tokens.refreshToken! }, account, scope: granted.join(' ') } satisfies FlowSecret)
      this.db.query("UPDATE google_app_flows SET state='ready', secret_enc=?, key_version=?, account=? WHERE id=? AND state='exchanging'").run(sealed.enc, sealed.keyVersion, JSON.stringify(account), f.id)
      return true
    } catch (e) {
      return failed(e instanceof DriveError && e.reason === 'needs_reconnect' ? 'exchange' : e instanceof DriveError ? e.reason : 'provider_unavailable')
    }
  }

  /** The person confirms the Google account shown: the app is connected (their earlier sign-in for it, if any, is
   * replaced; its Always allow and tool switches stay). */
  async complete(user: string, session: string, app: GoogleAppId, id: string): Promise<GoogleAppView> {
    const f = this.ownFlow(user, session, app, id)
    const setup = this.usable(app)
    if (f.state !== 'ready' || f.config_key !== setup.key) throw new GoogleAppError('flow_not_ready', 409)
    let s: FlowSecret
    try { s = this.box.open<FlowSecret>(flowAad(f), f.secret_enc, f.key_version) } catch { throw new GoogleAppError('invalid_flow') }
    if (!s.tokens || !s.account) throw new GoogleAppError('invalid_flow')
    const now = new Date(this.now()).toISOString()
    const existing = this.row(user, app)
    const rowId = existing?.id ?? newId()
    const secret: GoogleAppSecret = {
      type: 'oauth',
      // no revocation address: only disconnect (below) asks Google, and only for the last sign-in
      server: { issuer: null, authorizationEndpoint: GOOGLE_AUTH, tokenEndpoint: GOOGLE_TOKEN, registrationEndpoint: null, revocationEndpoint: null },
      // the client's secret stays in its file (tokens.ts uses the card's client as set up now)
      client: { clientId: setup.client?.clientId ?? 'hosting-service', clientSecret: null, authMethod: 'none', redirectUri: setup.client?.redirectUri ?? redirectUriOf(this.ctx) ?? '' },
      resource: null, scope: s.scope ?? null, tokens: s.tokens,
      google: { app, key: setup.key, mode: setup.mode === 'broker' ? 'broker' : 'direct' },
    }
    let sealed
    try { sealed = this.box.seal(connectionAad({ id: rowId, scope: 'personal', owner_user_id: user }), secret) } catch { throw new GoogleAppError('key_unsafe', 503) }
    const account = JSON.stringify({ name: s.account.name, email: s.account.email })
    this.db.transaction(() => {
      const flow = this.db.query("UPDATE google_app_flows SET state='completed', secret_enc=NULL WHERE id=? AND state='ready'").run(id).changes
      if (!flow) throw new GoogleAppError('flow_not_ready', 409)
      if (existing) {
        this.db.query("UPDATE integrations SET secret_enc=?, key_version=?, account=?, status='connected', last_error=NULL, version=version+1, updated_at=? WHERE id=?")
          .run(sealed.enc, sealed.keyVersion, account, now, existing.id)
      } else {
        this.db.query(`INSERT INTO integrations (id, scope, owner_user_id, created_by, kind, name, slug, url, auth, auth_header, secret_enc, key_version, account, notes,
          write_policy, status, last_error, tools_json, tools_updated_at, last_used_at, version, created_at, updated_at, google_app)
          VALUES (?, 'personal', ?, ?, 'mcp', ?, ?, ?, 'oauth', NULL, ?, ?, ?, NULL, 'ask', 'connected', NULL, '[]', NULL, NULL, 1, ?, ?, ?)`)
          .run(rowId, user, user, APP_NAMES[app], this.freeSlug(user, app), placeholderUrl(app), sealed.enc, sealed.keyVersion, account, now, now, app)
      }
    })()
    integrationsOf(this.ctx).forget(rowId)
    // like a member's own connection: which app, never the account
    audit(this.db, { actor: user, action: 'google_app.connected', target: rowId, detail: { app, reconnected: !!existing } })
    // its tools are read from the library now when it runs (else by the sweep, once it does)
    if (this.library().state() === 'ready') {
      const row = getRow(this.db, rowId)
      if (row) await Promise.race([integrationsOf(this.ctx).check(row).catch(() => row), Bun.sleep(15_000)])
    }
    return this.view(user, app)
  }
  private freeSlug(user: string, app: GoogleAppId): string {
    const taken = (s: string) => !!this.db.query("SELECT 1 FROM integrations WHERE scope='personal' AND owner_user_id=? AND slug=?").get(user, s)
    const base = APP_SLUGS[app]
    if (!taken(base)) return base
    for (let i = 2; i < 1000; i++) { const s = base.slice(0, 12 - String(i).length) + i; if (!taken(s)) return s }
    return `${base.slice(0, 4)}${crypto.randomBytes(4).toString('hex')}`
  }

  /** Ask before each change, or Always allow, for the person's own connection (decision 3). */
  setWritePolicy(user: string, app: GoogleAppId, writePolicy: 'ask' | 'allow'): GoogleAppView {
    this.active(user)
    const row = this.row(user, app)
    if (!row) throw new GoogleAppError('not_connected', 404)
    if (row.write_policy !== writePolicy) {
      this.db.query('UPDATE integrations SET write_policy=?, version=version+1, updated_at=? WHERE id=?').run(writePolicy, new Date(this.now()).toISOString(), row.id)
      audit(this.db, { actor: user, action: 'google_app.write_policy', target: row.id, detail: { app, writePolicy } })
    }
    return this.view(user, app)
  }

  /** Remove this app's sign-in at once; revoke at Google only when no other Google sign-in of the person is left here. */
  async disconnect(user: string, app: GoogleAppId): Promise<{ disconnected: true; revocation: 'revoked' | 'unavailable' | 'not_needed' }> {
    this.active(user)
    const row = this.row(user, app)
    const secret = row ? this.secretOf(row) : null
    this.db.transaction(() => {
      if (row) this.db.query('DELETE FROM integrations WHERE id=?').run(row.id)
      this.db.query("UPDATE google_app_flows SET state='failed', reason='cancelled', secret_enc=NULL, account=NULL WHERE user_id=? AND app=? AND state!='completed'").run(user, app)
    })()
    if (row) {
      integrationsOf(this.ctx).forget(row.id)
      audit(this.db, { actor: user, action: 'google_app.disconnected', target: row.id, detail: { app } })
    }
    const token = secret?.tokens.refreshToken ?? null
    if (!token) return { disconnected: true, revocation: 'not_needed' }
    const others = !!this.db.query('SELECT 1 FROM integrations WHERE owner_user_id=? AND google_app IS NOT NULL AND secret_enc IS NOT NULL LIMIT 1').get(user)
      || !!this.db.query('SELECT 1 FROM drive_connections WHERE user_id=? LIMIT 1').get(user)
      || ownsLiveDriveShare(this.db, user)
    if (others) return { disconnected: true, revocation: 'not_needed' }
    return { disconnected: true, revocation: await this.revoke(secret!, token) }
  }
  private async revoke(secret: GoogleAppSecret, token: string): Promise<'revoked' | 'unavailable'> {
    // a token the hosting service sealed is revoked there: this server cannot open it
    if (secret.google.mode === 'broker' || token.startsWith('ev1.')) {
      const b = googleDriveOf(this.ctx).broker
      return b ? b.revoke(token) : 'unavailable'
    }
    try {
      const r = await googleTransport(this.ctx).request(GOOGLE_REVOKE, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) }, 16_384)
      return r.status === 200 ? 'revoked' : 'unavailable'
    } catch { return 'unavailable' }
  }

  // ---------------- Admin › Connectors ----------------
  adminStatus(app: GoogleAppId): GoogleAppAdminStatus {
    const setup = setupOf(this.ctx, app)
    const redirectUri = redirectUriOf(this.ctx)
    const hosted = isHosted(this.ctx.config)
    const blocked: GoogleAppAdminStatus['blocked'] = hosted ? 'hosted' : setup.byOperator ? 'server' : !redirectUri ? 'public_host' : this.library().state() === 'unsupported' ? 'unsupported' : null
    const connectedMembers = (this.db.query(`SELECT count(*) n FROM integrations i JOIN users u ON u.id = i.owner_user_id
      WHERE i.google_app = ? AND i.secret_enc IS NOT NULL AND i.status != 'needs_auth' AND u.status = 'active' AND u.deleted_at IS NULL`).get(app) as { n: number }).n
    return {
      id: app, configured: setup.mode !== 'off', source: setup.source, canSetUp: blocked === null, blocked,
      redirectUri: hosted ? null : redirectUri, driveAppAvailable: driveAppAvailable(this.ctx), apis: APIS[app],
      membersCanConnect: membersOn(this.db, app), connectedMembers,
    }
  }
  adminList() { return { apps: APP_IDS.map((a) => this.adminStatus(a)) } }

  /** Set up one card: the same Google app as Drive, or its own client (written as a private file, read back with the
   * same checks). The client secret is in no answer, log or audit entry. */
  setClient(actor: string, app: GoogleAppId, body: { sameAsDrive: true } | { file?: string; clientId?: string; clientSecret?: string }): GoogleAppAdminStatus {
    const before = this.adminStatus(app)
    if (!before.canSetUp || !before.redirectUri) throw new GoogleAppError(`setup_${before.blocked ?? 'public_host'}`, 409)
    const setup = setupOf(this.ctx, app)
    const dir = appsSecretsDir(this.ctx)
    if ('sameAsDrive' in body) {
      if (!driveAppAvailable(this.ctx)) throw new GoogleAppError('drive_not_set_up', 409)
      // this page's own client for the card goes (a file the operator wrote never gets here: blocked 'server')
      if (setup.source === 'app') { try { fs.rmSync(setup.file, { force: true }) } catch { throw new GoogleAppError('setup_write', 500) } }
      setSetting(this.db, clientSettingKey(app), { by: 'drive' })
    } else {
      const c = clientFromBody(body, before.redirectUri)
      if (c === 'invalid') throw new GoogleAppError('client_invalid')
      if (c === 'redirect') throw new GoogleAppError('client_redirect')
      if (!safeAppsDir(dir, true)) throw new GoogleAppError('key_unsafe', 503)
      const previous = (() => { try { return fs.readFileSync(setup.file) } catch { return null } })()
      try { writeClientFile(setup.file, Buffer.from(JSON.stringify(c, null, 2) + '\n')) } catch { throw new GoogleAppError('setup_write', 500) }
      if (!readAppClient(setup.file, this.ctx.config.teamRoot)) {
        try { if (previous) writeClientFile(setup.file, previous); else fs.rmSync(setup.file, { force: true }) } catch {}
        throw new GoogleAppError('setup_write', 500)
      }
      setSetting(this.db, clientSettingKey(app), { by: 'app', key: setupOf(this.ctx, app).key })
    }
    audit(this.db, { actor, action: 'google_app.client_set', detail: { app, sameAsDrive: 'sameAsDrive' in body, replaced: before.configured } })
    this.syncLibrary()
    return this.adminStatus(app)
  }

  setMembers(actor: string, app: GoogleAppId, on: boolean): GoogleAppAdminStatus {
    if (membersOn(this.db, app) !== on) {
      setSetting(this.db, membersSettingKey(app), on)
      audit(this.db, { actor, action: 'google_app.members_switch', detail: { app, on } })
    }
    return this.adminStatus(app)
  }
}

const instances = new WeakMap<AppContext, GoogleApps>()
/** Dependencies come only from offline tests, never from HTTP or model input. */
export function googleAppsOf(ctx: AppContext, deps?: GoogleAppsDeps): GoogleApps {
  let svc = instances.get(ctx)
  if (!svc || deps) { svc = new GoogleApps(ctx, deps); instances.set(ctx, svc) }
  return svc
}
