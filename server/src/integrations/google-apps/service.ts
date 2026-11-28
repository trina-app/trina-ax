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
// Shared with the team (docs/GOOGLE-APPS.md "Shared with the team"): an owner or admin may also connect one Google
// account per app for the team. It is a team row of `integrations` (scope 'team', owner NULL, google_app set): who may
// use it is its integration_access rule, exactly as for any team connection (store.ts mayUse), so chats, side chats,
// scheduled runs and the read scope follow the same rule. Its sign-in is a google_app_flows row with scope 'team',
// started and completed only by an active owner or admin (checked here as well as by the route). A new one is used by
// nobody until its people are saved; members' own connections are never read or written by it.
//
// Nothing here returns, logs or audits a token, a client secret or the person's Google address.
import crypto from 'node:crypto'
import fs from 'node:fs'
import type { GoogleAppAdminStatus, GoogleAppFlow, GoogleAppId, GoogleAppTeam, GoogleAppView, IntegrationAccess } from '@mycel/shared/api'
import { GOOGLE_APP_BROKER_SCOPES, googleScopesCover } from '@mycel/shared/cloud-protocol'
import type { AppContext } from '../../context'
import { newId } from '../../db'
import { audit } from '../../admin/audit'
import { setSetting } from '../../admin/settings'
import { isHosted } from '../../system/deployment'
import { GOOGLE_AUTH, GOOGLE_REVOKE, GOOGLE_TOKEN, GOOGLE_USERINFO, type DriveFetch } from '../google-drive/client'
import { googleDriveOf, ownsLiveDriveShare } from '../google-drive/oauth'
import { DriveError } from '../google-drive/store'
import { BrokerRequestRefused } from '../google-drive/broker'
import { integrationsOf } from '../connections/service'
import { memberAllows } from '../connections/tools'
import { accessOf, activeUser, connectionAad, getRow, isAdmin, mayUse, savedTools, selectRows, setAccess, signsTeamGoogleApp, googleAccountInUse, googleEmailOf, usersOf, type Row } from '../connections/store'
import { APIS, APP_IDS, APP_NAMES, APP_SLUGS, catalog, placeholderUrl } from './catalog'
import { clientFromBody, clientSettingKey, driveAppAvailable, redirectUriOf, safeAppsDir, appsSecretsDir, readAppClient, setupOf, writeClientFile, type AppSetup } from './config'
import { googleTransport, isGoogleAppSecret, setGoogleFetch, tokensOf, type GoogleAppSecret } from './tokens'
import { workspaceLibraryOf } from './library'
import { googleLoginHint } from '../../auth/login-identities'
import type { AppClient, CallbackOutcome } from '../google-drive/callback-page'
import { CLAIM_MS, appReturnKey, appReturnPort, heldProofOk, newToken, tokenHash, tokenMatches } from '../google-drive/app-return'

/** The key of a Google app connection the demo's snapshot builder makes (routes/demo-builder.ts): no Google app made it. */
export const DEMO_GOOGLE_KEY = 'demo'

export class GoogleAppError extends Error {
  name = 'GoogleAppError'
  constructor(readonly reason: string, readonly status = 400) { super(`google_app_${reason}`) }
}

/** a person's own connection, or the one shared with the team (google_app_flows.scope, migration 349) */
type Scope = 'personal' | 'team'

interface FlowRow {
  id: string; app: GoogleAppId; scope: Scope; user_id: string; session_id: string; state_hash: string; config_key: string
  state: GoogleAppFlow['state'] | 'expired'; secret_enc: string | null; key_version: number; account: string | null; reason: string | null
  expires_at: string; created_at: string
}
interface Account { subject: string; name: string | null; email: string | null }
/** `claim`: a result Google answered in a browser without a session, for a desktop session's flow: kept sealed and still
 * "waiting" until the app on that computer brings this one-time code (google-drive/app-return.ts) */
/** `desktop`: the desktop app's page started it (its session may be recorded as 'web'): a return without a session is
 * held for the app's one-time code, as for a desktop session's */
interface FlowSecret { verifier: string; tokens?: { accessToken: string; refreshToken: string; expiresAt: number | null }; account?: Account; scope?: string; claim?: { hash: string; until: number; key?: string | null }; desktop?: true; appKey?: string }

const TTL = 10 * 60_000
/** how long a return waits for another return of the same sign-in that is still talking to Google (a reload, a second
 * request) before it says how that one ended */
export const SETTLE_MS = 15_000
const FLOWS_PER_HOUR = 20
/** how long a card says "not available yet" after the hosting service refused the app (then it is tried again) */
const LIMITED_MS = 10 * 60_000
const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
const challengeOf = (verifier: string) => crypto.createHash('sha256').update(verifier).digest('base64url')
const clean = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : null)
const flowAad = (f: Pick<FlowRow, 'id' | 'user_id'>) => `google-app-flow:${f.user_id}:${f.id}`
/** the scopes Google must have granted: the app's own and the email address (the library checks the token with it) */
const required = (app: GoogleAppId) => GOOGLE_APP_BROKER_SCOPES[app].filter((s) => s !== 'openid')
export interface GoogleAppsDeps { fetch?: DriveFetch; now?: () => number }

export class GoogleApps {
  readonly now: () => number
  private limited = new Map<GoogleAppId, number>()
  /** connections whose tool list is being read now (one check at a time each) */
  private checking = new Set<string>()
  /** flows a return is waiting on now (answered(): one waiter each) */
  private waiting = new Set<string>()
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
    this.dropTokens(this.db.query("SELECT * FROM google_app_flows WHERE expires_at<=? AND state IN ('exchanging','ready') AND secret_enc IS NOT NULL").all(now) as FlowRow[])
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
  /** the account shared with the team for this app, if any (at most one: migration 349) */
  teamRow(app: GoogleAppId): Row | null {
    return this.db.query(`${selectRows(this.db)} WHERE scope = 'team' AND google_app = ?`).get(app) as Row | null
  }
  /** connected, or needs a new sign-in (its tokens gone, refused by Google, or made with a Google app set up earlier) */
  private stateOf(row: Row, setupKey: string): 'connected' | 'needs_reconnect' {
    const secret = this.secretOf(row)
    return secret && row.status !== 'needs_auth' && this.keyMatches(secret.google.key, setupKey) ? 'connected' : 'needs_reconnect'
  }
  /** Was the connection made with the Google app set up now? On a demo server with fakes, a connection the snapshot
   * builder made (key DEMO_GOOGLE_KEY: there is no Google app, the demo's fake answers it) counts as made with it, so
   * Settings › Connectors shows the demo's Gmail as connected (the free-roam audit, QA TC-5611). */
  private keyMatches(key: string, setupKey: string): boolean {
    return key === setupKey || (key === DEMO_GOOGLE_KEY && !!this.ctx.config.demo?.fakes)
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
    return lib === 'unsupported' ? 'unsupported' : setup.mode === 'off' ? 'not_set_up'
      : setup.mode === 'broker' && this.isLimited(app) ? 'service_limited' : null
  }

  view(user: string, app: GoogleAppId): GoogleAppView {
    const setup = setupOf(this.ctx, app), lib = this.library().state()
    const reason = this.reasonOf(app)
    const row = this.row(user, app)
    const secret = row ? this.secretOf(row) : null
    const status: GoogleAppView['status'] = !row ? 'disconnected' : secret && row.status !== 'needs_auth' && this.keyMatches(secret.google.key, setup.key) ? 'connected' : 'needs_reconnect'
    const account = row ? accountOf(row) : null
    // the team's shared account, only for the people its rule includes now (an admin it does not include sees it on the
    // admin page, not here)
    const team = this.teamRow(app)
    const shared = team && mayUse(this.db, team, user) ? {
      id: team.id, account: accountOf(team) ?? { name: null, email: null }, status: this.stateOf(team, setup.key), alwaysAllowed: memberAllows(this.db, team, user),
    } : null
    // a connection whose tools were never read: read them now that someone looks (not waited for)
    if (status === 'connected' && lib === 'ready' && row && !savedTools(this.db, row).length) this.readTools(row)
    return {
      id: app, available: reason === null, reason, status, account,
      writePolicy: row?.write_policy === 'allow' ? 'allow' : 'ask',
      serviceDown: status === 'connected' && lib !== 'ready' && lib !== 'unsupported',
      tools: catalog(app),
      shared,
      // the hosting service's shared Google app signs in (not a company's own): Google may call it unverified
      hostedApp: setup.mode === 'broker',
    }
  }
  list(user: string): { apps: GoogleAppView[] } { return { apps: APP_IDS.map((a) => this.view(user, a)) } }

  // ---------------- signing in ----------------
  private active(user: string) {
    if (!this.db.query("SELECT 1 FROM users WHERE id=? AND status='active' AND deleted_at IS NULL AND must_change_password=0").get(user)) throw new GoogleAppError('access_denied', 403)
  }
  /** an active owner or admin (the route checked the role of the session; this reads it again from the database) */
  private admin(user: string) {
    const u = activeUser(this.db, user)
    if (!u || !isAdmin(u.role)) throw new GoogleAppError('access_denied', 403)
  }
  private session(user: string, session: string, scope: Scope = 'personal') {
    if (scope === 'team') this.admin(user)
    this.active(user)
    if (!this.db.query('SELECT 1 FROM sessions WHERE id=? AND user_id=? AND expires_at>?').get(session, user, new Date(this.now()).toISOString())) throw new GoogleAppError('session_ended', 401)
  }
  /** the app can be connected now (else why not) */
  private usable(app: GoogleAppId): AppSetup {
    if (this.library().state() === 'unsupported') throw new GoogleAppError('unsupported', 409)
    const setup = setupOf(this.ctx, app)
    if (setup.mode === 'off') throw new GoogleAppError('not_set_up', 409)
    return setup
  }

  /** `scope` 'team': the sign-in of the account shared with the team (owners and admins only). */
  async authorize(user: string, session: string, app: GoogleAppId, scope: Scope = 'personal', from?: 'desktop'): Promise<{ flowId: string; authorizationUrl: string; connectUrl?: string; expiresAt: string }> {
    this.session(user, session, scope)
    const setup = this.usable(app)
    this.sweep()
    const now = this.now()
    const n = (this.db.query('SELECT count(*) n FROM google_app_flows WHERE user_id=? AND created_at>?').get(user, new Date(now - 3600_000).toISOString()) as { n: number }).n
    // its own reason (not the hosting service's or Google's 'rate_limited'): the app says to wait about an hour (QA TC-3034)
    if (n >= FLOWS_PER_HOUR) throw new GoogleAppError('signin_limit', 429)
    const id = newId(), state = crypto.randomBytes(32).toString('base64url'), verifier = crypto.randomBytes(48).toString('base64url')
    let sealed
    // the app's key its session said at this start, sealed now (google-drive/app-return.ts appReturnKey)
    const appKey = appReturnKey(session)
    try { sealed = this.box.seal(flowAad({ id, user_id: user }), { verifier, ...(from === 'desktop' ? { desktop: true } as const : {}), ...(appKey ? { appKey } : {}) } satisfies FlowSecret) } catch { throw new GoogleAppError('key_unsafe', 503) }
    const expiresAt = new Date(now + TTL).toISOString()
    // a waiting result of the flow this one replaces is never used: revoked at Google where that is safe (dropTokens)
    this.dropTokens(this.db.query("SELECT * FROM google_app_flows WHERE user_id=? AND app=? AND scope=? AND state IN ('exchanging','ready') AND secret_enc IS NOT NULL").all(user, app, scope) as FlowRow[])
    this.db.transaction(() => {
      this.db.query("UPDATE google_app_flows SET state='failed', reason='superseded', secret_enc=NULL, account=NULL WHERE user_id=? AND app=? AND scope=? AND state IN ('pending','exchanging','ready')").run(user, app, scope)
      this.db.query(`INSERT INTO google_app_flows (id, app, scope, user_id, session_id, state_hash, config_key, state, secret_enc, key_version, expires_at, created_at)
        VALUES (?,?,?,?,?,?,?,'pending',?,?,?,?)`).run(id, app, scope, user, session, hash(state), setup.key, sealed.enc, sealed.keyVersion, expiresAt, new Date(now).toISOString())
    })()
    if (setup.mode === 'broker') {
      try {
        const urls = await this.brokerStart(scope, state, challengeOf(verifier), app)
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
    // the person's own app with the Google account they sign in with (Sign in with Google): Google skips its account
    // picker. Not the account shared with the team, which is often another one
    const hint = scope === 'personal' ? googleLoginHint(this.db, user) : null
    if (hint) url.searchParams.set('login_hint', hint)
    return { flowId: id, authorizationUrl: url.href, expiresAt }
  }

  /** The hosting service's sign-in for this app: a team connection says so on its start page (purpose "share"). An
   * older control plane takes an app only with "personal" and refuses "share" as a bad request (invalid_request:
   * BrokerRequestRefused): only then start again with "personal", which signs in the same way and only words the page
   * as one person's (QA TC-6065). Any other refusal (the app closed: app_unavailable, rate limits, ...) is final, never
   * downgraded. This holds only while `purpose` is wording only on the broker (the same scopes, the same tokens, the
   * same team binding): if the broker ever treats "share" differently, this fallback must go. */
  private async brokerStart(scope: Scope, state: string, challenge: string, app: GoogleAppId) {
    const broker = googleDriveOf(this.ctx).broker!
    if (scope !== 'team') return broker.start('personal', state, challenge, app)
    try { return await broker.start('share', state, challenge, app) } catch (e) {
      if (!(e instanceof BrokerRequestRefused)) throw e
      return broker.start('personal', state, challenge, app)
    }
  }

  /** A flow of this person and session for this app and scope: a personal sign-in never completes the team's, nor the
   * other way round. */
  private ownFlow(user: string, session: string, app: GoogleAppId, id: string, scope: Scope = 'personal'): FlowRow {
    this.session(user, session, scope)
    this.sweep()
    const f = this.db.query('SELECT * FROM google_app_flows WHERE id=?').get(id) as FlowRow | null
    if (!f || f.user_id !== user || f.session_id !== session || f.app !== app || (f.scope ?? 'personal') !== scope) throw new GoogleAppError('not_found', 404)
    return f
  }
  flow(user: string, session: string, app: GoogleAppId, id: string, scope: Scope = 'personal'): GoogleAppFlow {
    const f = this.ownFlow(user, session, app, id, scope)
    let account: GoogleAppFlow['account'] = null
    try { if (f.account) { const a = JSON.parse(f.account) as Account; account = { name: a.name ?? null, email: a.email ?? null } } } catch {}
    // a result waiting for the desktop app's code: plain "pending" to its owner until then (no account shown)
    return { flowId: f.id, state: this.held(f) ? 'pending' : f.state, account, expiresAt: f.expires_at, reason: f.reason }
  }
  private held(f: FlowRow): boolean {
    if (f.state !== 'exchanging' || !f.secret_enc) return false
    try { return !!this.box.open<FlowSecret>(flowAad(f), f.secret_enc, f.key_version).claim } catch { return false }
  }
  /** The kind of app that started a flow, when it is an app (the return page sends the person back to it): its session's
   * kind, or 'desktop' when the desktop app's page said so at the start (FlowSecret.desktop; a desktop app's session can
   * be recorded as 'web', and its return page said "not signed in" while the app waited forever: QA 2026-11-27) */
  private appOf(f: FlowRow): AppClient | null {
    const c = (this.db.query('SELECT client FROM sessions WHERE id=?').get(f.session_id) as { client: string } | null)?.client
    if (c === 'desktop' || c === 'mobile') return c
    if (!f.secret_enc) return null
    // the page's word counts only with the app's key known for that session (docs/decisions/20261128-held-sign-in-app-key.md)
    try { const s = this.box.open<FlowSecret>(flowAad(f), f.secret_enc, f.key_version); return s.desktop && s.appKey ? 'desktop' : null } catch { return null }
  }
  cancel(user: string, session: string, app: GoogleAppId, id: string, scope: Scope = 'personal') {
    const f = this.ownFlow(user, session, app, id, scope)
    if ((f.state === 'ready' || f.state === 'exchanging') && f.secret_enc) this.dropTokens([f])
    this.db.query("UPDATE google_app_flows SET state='failed', reason='cancelled', secret_enc=NULL, account=NULL WHERE id=? AND state!='completed'").run(id)
  }

  /** Google's (direct) or the hosting service's (`handoff` instead of `code`) return to this server. The browser must be
   * signed in as the person who started it: a leaked sign-in address cannot attach someone else's Google consent. */
  async callback(input: { state?: string; code?: string; error?: string; handoff?: string }, browser?: { userId: string; sessionId: string }): Promise<boolean> {
    return (await this.callbackOutcome(input, browser)).ok
  }
  /** The same, with why it did not work for the return page (routes/google-apps.ts, google-drive/callback-page.ts).
   * A browser without a session, for a flow the desktop app started, finishes it only as far as a one-time code for the
   * app on this computer (as Google Drive's, google-drive/app-return.ts): the system browser the desktop app opens has
   * no session, and the page always said "This browser can't finish it" (owner 2026-11-21). A return to a sign-in that
   * is already answered says how it ended, never "expired or already used" for one that worked (answered()). */
  async callbackOutcome(input: { state?: string; code?: string; error?: string; handoff?: string }, browser?: { userId: string; sessionId: string }): Promise<CallbackOutcome> {
    this.sweep()
    const no = (reason: string, app?: AppClient | null): CallbackOutcome => ({ ok: false, reason, ...(app ? { app } : {}) })
    if (!input.state || !/^[A-Za-z0-9_-]{43}$/.test(input.state)) return no('invalid_flow')
    const f = this.db.query('SELECT * FROM google_app_flows WHERE state_hash=?').get(hash(input.state)) as FlowRow | null
    if (!f) return no('invalid_flow')
    const app = this.appOf(f)
    if (f.state !== 'pending') return this.answered(f, app, browser)
    // A leaked sign-in address must not attach someone else's Google consent: a browser signed in as someone else is
    // refused; one without a session gets only the desktop app's code (claim), which only the starter's session redeems.
    const held = !browser && app === 'desktop'
    if (!held && (!browser || browser.userId !== f.user_id)) return no('browser_session_required', app)
    try { if (browser) this.session(browser.userId, browser.sessionId); this.session(f.user_id, f.session_id, f.scope ?? 'personal') } catch { return no('invalid_flow', app) }
    const setup = setupOf(this.ctx, f.app)
    if (setup.key !== f.config_key || setup.mode === 'off') return no('invalid_flow', app)
    if (!this.db.query("UPDATE google_app_flows SET state='exchanging' WHERE id=? AND state='pending'").run(f.id).changes) {
      // another return of this sign-in took it a moment ago: say how that one ends
      const now = this.db.query('SELECT * FROM google_app_flows WHERE id=?').get(f.id) as FlowRow | null
      return now ? this.answered(now, app, browser) : no('invalid_flow', app)
    }
    const failed = (reason: string) => { this.db.query("UPDATE google_app_flows SET state='failed', reason=?, secret_enc=NULL, account=NULL WHERE id=? AND state='exchanging'").run(reason, f.id); return no(reason, app) }
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
      if (!googleScopesCover(granted, required(f.app))) return failed('scope_denied')
      let tokens
      try { tokens = tokensOf(json, this.now()) } catch { return failed('exchange') }
      const me = await t.json(GOOGLE_USERINFO, { headers: { Authorization: `Bearer ${tokens.accessToken}` } }, 32_768)
      if (typeof me.sub !== 'string' || !me.sub || me.sub.length > 256) return failed('invalid_provider_response')
      const account: Account = { subject: me.sub, name: clean(me.name, 200), email: clean(me.email, 320) }
      const cur = this.db.query('SELECT state, expires_at FROM google_app_flows WHERE id=?').get(f.id) as { state: string; expires_at: string } | null
      if (!cur || cur.state !== 'exchanging' || cur.expires_at <= new Date(this.now()).toISOString()) return failed('invalid_flow')
      const result: FlowSecret = { verifier: '', tokens: { ...tokens, refreshToken: tokens.refreshToken! }, account, scope: granted.join(' '), ...(s.desktop ? { desktop: true } as const : {}), ...(s.appKey ? { appKey: s.appKey } : {}) }
      if (held) return this.hold(f, result, cur.expires_at)
      const sealed = this.box.seal(flowAad(f), result)
      this.db.query("UPDATE google_app_flows SET state='ready', secret_enc=?, key_version=?, account=? WHERE id=? AND state='exchanging'").run(sealed.enc, sealed.keyVersion, JSON.stringify(account), f.id)
      return { ok: true, ...(app ? { app } : {}) }
    } catch (e) {
      return failed(e instanceof DriveError && e.reason === 'needs_reconnect' ? 'exchange' : e instanceof DriveError ? e.reason : 'provider_unavailable')
    }
  }
  /** Keep a result sealed and "waiting" (state exchanging, no account shown) with the one-time code for the desktop app */
  private hold(f: FlowRow, result: FlowSecret, expiresAt: string): CallbackOutcome {
    const code = newToken(), end = Math.min(this.now() + CLAIM_MS, Date.parse(expiresAt))
    const sealed = this.box.seal(flowAad(f), { ...result, claim: { hash: tokenHash(code), until: end, key: result.appKey ?? null } } satisfies FlowSecret)
    if (!this.db.query("UPDATE google_app_flows SET secret_enc=?, key_version=? WHERE id=? AND state='exchanging'").run(sealed.enc, sealed.keyVersion, f.id).changes) return { ok: false, reason: 'invalid_flow', app: 'desktop' }
    const who = this.db.query('SELECT name, username FROM users WHERE id=?').get(f.user_id) as { name: string; username: string } | null
    return { ok: true, app: 'desktop', code, who: who ?? { name: '', username: '' }, google: result.account?.email ?? result.account?.name ?? '', returnPort: appReturnPort(f.session_id) }
  }
  /** A return to a sign-in that is no longer waiting for Google: how it went. Another return still talking to Google is
   * waited for (SETTLE_MS). Answered and waiting for the person's confirm: ok ('ready'); confirmed: Connected
   * ('completed'); held for the desktop app: 'held' (go back to the app; no code, nothing finished); replaced by a later
   * try of the same person and app that is connected now: Connected. Anything else: "expired or already used", as
   * before. Only the outcome of the starter's own flow is told (the starter can poll it anyway). */
  private async answered(f: FlowRow, app: AppClient | null, browser?: { userId: string; sessionId: string }): Promise<CallbackOutcome> {
    const no = (reason: string): CallbackOutcome => ({ ok: false, reason, ...(app ? { app } : {}) })
    // one waiter per flow: any other return gets the state as it is now, at once (a flood of reloads holds no requests)
    const deadline = this.waiting.has(f.id) ? 0 : Date.now() + SETTLE_MS
    let r: FlowRow | null = f
    if (deadline) this.waiting.add(f.id)
    try {
      while (r && r.state === 'exchanging' && !this.held(r) && Date.now() < deadline) {
        await Bun.sleep(100)
        r = this.db.query('SELECT * FROM google_app_flows WHERE id=?').get(f.id) as FlowRow | null
      }
    } finally { if (deadline) this.waiting.delete(f.id) }
    if (!r) return no('invalid_flow')
    if (r.state === 'ready') return { ok: true, done: 'ready', ...(app ? { app } : {}) }
    if (r.state === 'completed') return { ok: true, done: 'completed', ...(app ? { app } : {}) }
    if (r.state === 'exchanging') {
      let s: FlowSecret
      try { s = this.box.open<FlowSecret>(flowAad(r), r.secret_enc, r.key_version) } catch { return no('invalid_flow') }
      // still talking to Google: another return waits on it (this one is not the waiter), or SETTLE_MS ran out
      if (!s.claim) return no(deadline ? 'provider_unavailable' : 'in_progress')
      // Held for the desktop app: never a new code, never finished here. The starter has the state too (it is in the
      // Google address the app was given): a code or a finish for whoever brings the state again would hand a phished
      // victim's consent to the starter (review of this change). The first page's code is the only one.
      return no(this.now() > s.claim.until ? 'expired' : 'held')
    }
    if (r.state === 'failed' && r.reason === 'superseded' && this.connectedSince(r)) return { ok: true, done: 'completed', ...(app ? { app } : {}) }
    // ended otherwise (cancelled in the app, timed out, replaced, refused): "expired or already used", as before
    return no('invalid_flow')
  }
  /** a later sign-in of the same person, app and scope was confirmed, and that connection is still there: what this
   * replaced one was for is done */
  private connectedSince(f: FlowRow): boolean {
    const live = (f.scope ?? 'personal') === 'team' ? this.teamRow(f.app) : this.row(f.user_id, f.app)
    return !!live && live.status === 'connected' && !!this.db.query("SELECT 1 FROM google_app_flows WHERE user_id=? AND app=? AND scope=? AND state='completed' AND created_at>=? AND id!=?").get(f.user_id, f.app, f.scope ?? 'personal', f.created_at, f.id)
  }
  /** The desktop app brings the one-time code of a sign-in Google answered in a browser without a session (the same
   * claim address as Google Drive's: routes/drive.ts tries Drive, then this). Only a flow of THIS session: it turns
   * "ready" and the person confirms the account as always; the code is used up. Another session's, a used, unknown or
   * late code: refused (a late one ends its flow). */
  claim(user: string, session: string, code: string, proof?: string | null): GoogleAppFlow {
    this.sweep()
    const rows = this.db.query("SELECT * FROM google_app_flows WHERE user_id=? AND session_id=? AND state='exchanging' AND secret_enc IS NOT NULL").all(user, session) as FlowRow[]
    for (const f of rows) {
      let s: FlowSecret
      try { s = this.box.open<FlowSecret>(flowAad(f), f.secret_enc, f.key_version) } catch { continue }
      // held with the app's key: the app's own proof too (google-drive/app-return.ts heldProofOk)
      if (!s.claim || !tokenMatches(code, s.claim.hash) || !heldProofOk(s.claim.key, proof)) continue
      // the same checks as a return in a signed-in browser: an active person (an owner or admin for the team's) and
      // session. A refusal ends the held result (its tokens dropped) and says why (routes/drive.ts maps it).
      try { this.session(user, session, f.scope ?? 'personal') } catch (e) {
        this.dropTokens([f])
        this.db.query("UPDATE google_app_flows SET state='failed', reason=?, secret_enc=NULL, account=NULL WHERE id=? AND state='exchanging'").run(e instanceof GoogleAppError ? e.reason : 'access_denied', f.id)
        throw e
      }
      const setup = setupOf(this.ctx, f.app)
      if (this.now() > s.claim.until || setup.key !== f.config_key || setup.mode === 'off') {
        this.dropTokens([f])
        this.db.query("UPDATE google_app_flows SET state='failed', reason='expired', secret_enc=NULL, account=NULL WHERE id=? AND state='exchanging'").run(f.id)
        throw new DriveError('expired', 400)
      }
      const { claim: _used, ...rest } = s
      const sealed = this.box.seal(flowAad(f), rest satisfies FlowSecret)
      if (!this.db.query("UPDATE google_app_flows SET state='ready', secret_enc=?, key_version=?, account=? WHERE id=? AND state='exchanging'").run(sealed.enc, sealed.keyVersion, JSON.stringify(s.account), f.id).changes) break
      return this.flow(user, session, f.app, f.id, f.scope ?? 'personal')
    }
    throw new DriveError('invalid_code', 400)
  }

  /** A flow that Google answered, for the app as set up now: its sealed tokens and account. */
  private ready(f: FlowRow, app: GoogleAppId): { setup: AppSetup; s: FlowSecret & Required<Pick<FlowSecret, 'tokens' | 'account'>> } {
    const setup = this.usable(app)
    if (f.state !== 'ready' || f.config_key !== setup.key) throw new GoogleAppError('flow_not_ready', 409)
    let s: FlowSecret
    try { s = this.box.open<FlowSecret>(flowAad(f), f.secret_enc, f.key_version) } catch { throw new GoogleAppError('invalid_flow') }
    if (!s.tokens || !s.account) throw new GoogleAppError('invalid_flow')
    return { setup, s: s as FlowSecret & Required<Pick<FlowSecret, 'tokens' | 'account'>> }
  }
  private secretFor(app: GoogleAppId, setup: AppSetup, s: FlowSecret & Required<Pick<FlowSecret, 'tokens'>>): GoogleAppSecret {
    return {
      type: 'oauth',
      // no revocation address: only disconnect (below) asks Google, and only for the last sign-in
      server: { issuer: null, authorizationEndpoint: GOOGLE_AUTH, tokenEndpoint: GOOGLE_TOKEN, registrationEndpoint: null, revocationEndpoint: null },
      // the client's secret stays in its file (tokens.ts uses the card's client as set up now)
      client: { clientId: setup.client?.clientId ?? 'hosting-service', clientSecret: null, authMethod: 'none', redirectUri: setup.client?.redirectUri ?? redirectUriOf(this.ctx) ?? '' },
      resource: null, scope: s.scope ?? null, tokens: s.tokens,
      google: { app, key: setup.key, mode: setup.mode === 'broker' ? 'broker' : 'direct' },
    }
  }

  /** The person confirms the Google account shown: the app is connected (their earlier sign-in for it, if any, is
   * replaced; its Always allow and tool switches stay). */
  async complete(user: string, session: string, app: GoogleAppId, id: string): Promise<GoogleAppView> {
    const f = this.ownFlow(user, session, app, id)
    const { setup, s } = this.ready(f, app)
    const now = new Date(this.now()).toISOString()
    const existing = this.row(user, app)
    const rowId = existing?.id ?? newId()
    const secret = this.secretFor(app, setup, s)
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
      // only the person's own sign-ins: one an admin started for the team's account stays
      this.db.query("UPDATE google_app_flows SET state='failed', reason='cancelled', secret_enc=NULL, account=NULL WHERE user_id=? AND app=? AND scope='personal' AND state!='completed'").run(user, app)
    })()
    if (row) {
      integrationsOf(this.ctx).forget(row.id)
      audit(this.db, { actor: user, action: 'google_app.disconnected', target: row.id, detail: { app } })
    }
    const token = secret?.tokens.refreshToken ?? null
    if (!token) return { disconnected: true, revocation: 'not_needed' }
    // another sign-in of this person, or anyone's sign-in here with the same Google account (a shared one too)
    if (this.otherSignIns(user) || googleAccountInUse(this.db, googleEmailOf(row?.account), { integration: row?.id })) return { disconnected: true, revocation: 'not_needed' }
    return { disconnected: true, revocation: await this.revoke(secret!, token) }
  }
  /** Best effort: revoke at Google the tokens of sign-ins that will never be used (a held or answered result that runs
   * out, is replaced, cancelled or refused), by the same rule as a disconnect: only when no other Google sign-in of the
   * person and no sign-in here with the same Google account is left (Google revokes a whole grant). Called before the
   * row loses its secret; a failure changes nothing here. */
  private dropTokens(rows: FlowRow[]) {
    for (const f of rows) {
      let s: FlowSecret
      try { s = this.box.open<FlowSecret>(flowAad(f), f.secret_enc, f.key_version) } catch { continue }
      const token = s.tokens?.refreshToken
      if (!token) continue
      if (this.otherSignIns(f.user_id) || googleAccountInUse(this.db, s.account?.email?.toLowerCase() ?? null)) continue
      void this.revokeToken(setupOf(this.ctx, f.app).mode === 'broker', token).catch(() => 'unavailable')
    }
  }
  /** Another Google sign-in of this person is left here (their own apps, their Drive, a Drive they share with the team, an
   * app's account they connected for the team): Google revokes a whole grant, so it is not asked. */
  private otherSignIns(user: string, exceptTeamRow?: string): boolean {
    return !!this.db.query('SELECT 1 FROM integrations WHERE owner_user_id=? AND google_app IS NOT NULL AND secret_enc IS NOT NULL LIMIT 1').get(user)
      || !!this.db.query('SELECT 1 FROM drive_connections WHERE user_id=? LIMIT 1').get(user)
      || ownsLiveDriveShare(this.db, user)
      || signsTeamGoogleApp(this.db, user, exceptTeamRow)
  }
  private async revoke(secret: GoogleAppSecret, token: string): Promise<'revoked' | 'unavailable'> {
    return this.revokeToken(secret.google.mode === 'broker', token)
  }
  private async revokeToken(viaBroker: boolean, token: string): Promise<'revoked' | 'unavailable'> {
    // a token the hosting service sealed is revoked there: this server cannot open it
    if (viaBroker || token.startsWith('ev1.')) {
      const b = googleDriveOf(this.ctx).broker
      return b ? b.revoke(token) : 'unavailable'
    }
    try {
      const r = await googleTransport(this.ctx).request(GOOGLE_REVOKE, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) }, 16_384)
      return r.status === 200 ? 'revoked' : 'unavailable'
    } catch { return 'unavailable' }
  }

  // ---------------- the account shared with the team (owners and admins) ----------------
  /** What owners and admins see of the app's shared account, or null. */
  teamView(app: GoogleAppId): GoogleAppTeam | null {
    const row = this.teamRow(app)
    if (!row) return null
    const signer = (this.db.query("SELECT u.id, u.name FROM team_sign_ins s JOIN users u ON u.id = s.user_id WHERE s.kind = 'team_connection' AND s.target_id = ?").get(row.id) as { id: string; name: string } | null)
    return {
      id: row.id, status: this.stateOf(row, setupOf(this.ctx, app).key), account: accountOf(row) ?? { name: null, email: null },
      access: accessOf(this.db, row.id), usedBy: usersOf(this.db, row.id).size, connectedBy: signer, connectedAt: row.updated_at,
    }
  }

  /** The admin confirms the Google account shown: it becomes the team's shared account for the app. A new one is used by
   * nobody until its people are saved (setTeamAccess); a reconnect keeps its people and tool switches, and members'
   * Always allow goes when the account is another one (they chose it for the old account). No member's own connection
   * is read or written. */
  async completeTeam(user: string, session: string, app: GoogleAppId, id: string, o: { create?: boolean } = {}): Promise<GoogleAppAdminStatus> {
    const f = this.ownFlow(user, session, app, id, 'team')
    const { setup, s } = this.ready(f, app)
    const now = new Date(this.now()).toISOString()
    const existing = this.teamRow(app)
    // a dialog that makes a new one never replaces the account another admin connected meanwhile
    if (o.create && existing) throw new GoogleAppError('team_exists', 409)
    const rowId = existing?.id ?? newId()
    let sealed
    try { sealed = this.box.seal(connectionAad({ id: rowId, scope: 'team', owner_user_id: null }), this.secretFor(app, setup, s)) } catch { throw new GoogleAppError('key_unsafe', 503) }
    const account = JSON.stringify({ name: s.account.name, email: s.account.email })
    const otherAccount = !!existing && (accountOf(existing)?.email ?? null) !== (s.account.email ?? null)
    this.db.transaction(() => {
      const flow = this.db.query("UPDATE google_app_flows SET state='completed', secret_enc=NULL WHERE id=? AND state='ready'").run(id).changes
      if (!flow) throw new GoogleAppError('flow_not_ready', 409)
      if (o.create && this.teamRow(app)) throw new GoogleAppError('team_exists', 409)
      if (existing) {
        this.db.query("UPDATE integrations SET secret_enc=?, key_version=?, account=?, status='connected', last_error=NULL, version=version+1, updated_at=? WHERE id=?")
          .run(sealed.enc, sealed.keyVersion, account, now, existing.id)
        if (otherAccount) this.db.query('DELETE FROM integration_user_allow WHERE integration_id = ?').run(existing.id)
      } else {
        // the name people see on cards and in the AI's list; the slug makes its tools team_<app>__… (a member's own are
        // my_<app>__…)
        this.db.query(`INSERT INTO integrations (id, scope, owner_user_id, created_by, kind, name, slug, url, auth, auth_header, secret_enc, key_version, account, notes,
          write_policy, status, last_error, tools_json, tools_updated_at, last_used_at, version, created_at, updated_at, google_app)
          VALUES (?, 'team', NULL, ?, 'mcp', ?, ?, ?, 'oauth', NULL, ?, ?, ?, NULL, 'ask', 'connected', NULL, '[]', NULL, NULL, 1, ?, ?, ?)`)
          .run(rowId, user, APP_NAMES[app], this.freeTeamSlug(app), placeholderUrl(app), sealed.enc, sealed.keyVersion, account, now, now, app)
      }
      // who signed it in: 팀장 넘기기 (admin/handover.ts) lists it like other team sign-ins
      this.db.query("INSERT INTO team_sign_ins (kind, target_id, user_id, at) VALUES ('team_connection', ?, ?, ?) ON CONFLICT(kind, target_id) DO UPDATE SET user_id = excluded.user_id, at = excluded.at").run(rowId, user, now)
    })()
    integrationsOf(this.ctx).forget(rowId)
    audit(this.db, { actor: user, action: 'google_app.team_connected', target: rowId, detail: { app, reconnected: !!existing, otherAccount } })
    if (this.library().state() === 'ready') {
      const row = getRow(this.db, rowId)
      if (row) await Promise.race([integrationsOf(this.ctx).check(row).catch(() => row), Bun.sleep(15_000)])
    }
    return this.adminStatus(app)
  }
  private freeTeamSlug(app: GoogleAppId): string {
    const taken = (x: string) => !!this.db.query("SELECT 1 FROM integrations WHERE scope='team' AND slug=?").get(x)
    const base = APP_SLUGS[app]
    if (!taken(base)) return base
    for (let i = 2; i < 1000; i++) { const x = base.slice(0, 12 - String(i).length) + i; if (!taken(x)) return x }
    return `${base.slice(0, 4)}${crypto.randomBytes(4).toString('hex')}`
  }

  /** Who may use the shared account: everyone, groups or people (the same rule as a team connection's). Groups and
   * people must exist. Members' Always allow goes with their place in the rule (store.ts pruneMemberAllows). */
  setTeamAccess(user: string, app: GoogleAppId, access: IntegrationAccess): GoogleAppAdminStatus {
    this.admin(user)
    const row = this.teamRow(app)
    if (!row) throw new GoogleAppError('not_connected', 404)
    const groups = new Set((this.db.query('SELECT id FROM groups').all() as { id: string }[]).map((g) => g.id))
    const users = new Set((this.db.query('SELECT id FROM users WHERE deleted_at IS NULL').all() as { id: string }[]).map((u) => u.id))
    if (access.groups.some((g) => !groups.has(g)) || access.users.some((u) => !users.has(u))) throw new GoogleAppError('access_invalid')
    this.db.transaction(() => {
      setAccess(this.db, row.id, access)
      this.db.query('UPDATE integrations SET version=version+1, updated_at=? WHERE id=?').run(new Date(this.now()).toISOString(), row.id)
    })()
    integrationsOf(this.ctx).forget(row.id)
    audit(this.db, { actor: user, action: 'google_app.team_access', target: row.id, detail: { app, everyone: access.everyone, groups: new Set(access.groups).size, users: new Set(access.users).size } })
    return this.adminStatus(app)
  }

  /** Remove the shared account at once (its rule, members' Always allow and its tools go with it); Google is asked to
   * revoke only when the admin who signed it in has no other Google sign-in here. Members' own connections stay. */
  /** `onlyId`: remove it only when it is this connection (a dialog that made it, and closes before saving its people,
   * never removes one another admin made or replaced meanwhile). */
  async removeTeam(user: string, app: GoogleAppId, onlyId?: string): Promise<{ removed: boolean; revocation: 'revoked' | 'unavailable' | 'not_needed' }> {
    this.admin(user)
    const found = this.teamRow(app)
    // a dialog removing what it made: nothing else, not even another admin's sign-in under way
    if (onlyId !== undefined && found?.id !== onlyId) return { removed: false, revocation: 'not_needed' }
    const row = found
    const signer = row ? (this.db.query("SELECT user_id FROM team_sign_ins WHERE kind = 'team_connection' AND target_id = ?").get(row.id) as { user_id: string } | null)?.user_id ?? null : null
    const secret = row ? this.secretOf(row) : null
    this.db.transaction(() => {
      if (row) {
        this.db.query('DELETE FROM integrations WHERE id=?').run(row.id)
        this.db.query("DELETE FROM team_sign_ins WHERE kind = 'team_connection' AND target_id = ?").run(row.id)
      }
      this.db.query("UPDATE google_app_flows SET state='failed', reason='cancelled', secret_enc=NULL, account=NULL WHERE app=? AND scope='team' AND state NOT IN ('completed','failed','expired')").run(app)
    })()
    if (!row) return { removed: false, revocation: 'not_needed' }
    integrationsOf(this.ctx).forget(row.id)
    audit(this.db, { actor: user, action: 'google_app.team_removed', target: row.id, detail: { app } })
    const token = secret?.tokens.refreshToken ?? null
    // whose grant it is, is known only from who signed it in; unknown: Google is not asked (fail safe for other sign-ins)
    if (!token || !signer || this.otherSignIns(signer, row.id) || googleAccountInUse(this.db, googleEmailOf(row.account), { integration: row.id })) return { removed: true, revocation: 'not_needed' }
    return { removed: true, revocation: await this.revoke(secret!, token) }
  }

  // ---------------- Admin › Connectors ----------------
  adminStatus(app: GoogleAppId): GoogleAppAdminStatus {
    const setup = setupOf(this.ctx, app)
    const redirectUri = redirectUriOf(this.ctx)
    // the hosting service's setup: always on a hosted server; on a self-installed one only while this card signs in
    // through the broker (it serves this server, the card has no client of its own). Not served: the page may set one.
    // and while the company's own Google app is set (google-drive/own-app.ts): it sets all five at once, so no card has a
    // setup of its own then, as on a hosted server (also on a self-installed server the hosting service serves)
    const hosted = isHosted(this.ctx.config) || setup.mode === 'broker' || googleDriveOf(this.ctx).ownAppActive
    const blocked: GoogleAppAdminStatus['blocked'] = hosted ? 'hosted' : setup.byOperator ? 'server' : !redirectUri ? 'public_host' : this.library().state() === 'unsupported' ? 'unsupported' : null
    const connectedMembers = (this.db.query(`SELECT count(*) n FROM integrations i JOIN users u ON u.id = i.owner_user_id
      WHERE i.google_app = ? AND i.secret_enc IS NOT NULL AND i.status != 'needs_auth' AND u.status = 'active' AND u.deleted_at IS NULL`).get(app) as { n: number }).n
    return {
      id: app, configured: setup.mode !== 'off', source: setup.source, canSetUp: blocked === null, blocked,
      redirectUri: hosted ? null : redirectUri, driveAppAvailable: driveAppAvailable(this.ctx), apis: APIS[app],
      membersCanConnect: true, connectedMembers, team: this.teamView(app),
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

  /** The old members' switch (an older app may still send it): changes nothing, members can always connect their own
   * once the app is set up (docs/DECISIONS.md "No members' switch for connectors"). */
  setMembers(_actor: string, app: GoogleAppId, _on: boolean): GoogleAppAdminStatus {
    return this.adminStatus(app)
  }
}

/** The name and address a connection's Google account was confirmed with (never its subject or tokens). */
function accountOf(row: Pick<Row, 'account'>): { name: string | null; email: string | null } | null {
  try { if (row.account) { const a = JSON.parse(row.account) as Account; return { name: a.name ?? null, email: a.email ?? null } } } catch {}
  return null
}

const instances = new WeakMap<AppContext, GoogleApps>()
/** Dependencies come only from offline tests, never from HTTP or model input. */
export function googleAppsOf(ctx: AppContext, deps?: GoogleAppsDeps): GoogleApps {
  let svc = instances.get(ctx)
  if (!svc || deps) { svc = new GoogleApps(ctx, deps); instances.set(ctx, svc) }
  return svc
}
