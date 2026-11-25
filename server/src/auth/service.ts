// Sessions (tab 4 "인증"): random token, only its SHA-256 in the DB, 30 days. Web and desktop use the __Host-sid
// cookie (HttpOnly, Secure, SameSite=Lax, Path=/, no Domain; plain-http dev servers use DEV_SESSION_COOKIE), apps
// and scripts use `Authorization: Bearer`, mobile WebSocket shells the `mycel.bearer.<token>` subprotocol.
// This file implements SessionService for the whole app (installed by routes/auth.ts init()).
import type { Context } from 'hono'
import { isFreeRoam } from '../app-config'
import {
  DEV_SESSION_COOKIE, SESSION_COOKIE, WS_BEARER_PREFIX,
  type ClientKind, type LoginResponse, type Me,
} from '@mycel/shared/api'
import { roomFilesOf } from '../rooms/files'
import type { AppContext } from '../context'
import { newId } from '../db'
import type { AppEnv } from '../http/env'
import { fail } from '../http/errors'
import type { AuthInfo, RealtimeHub, RequestInfo, SessionService } from '../services'
import { getTeamSettings } from '../admin/settings'
import { voiceInputOn, voiceInputOutside } from '../credentials/speech-key'
import { wantsWavRecordings } from '../jobs/transcribe'
import { audit } from '../admin/audit'
import { profileOf } from './profiles'
import { myStatusOf } from './status-messages'
import { hashToken, newToken, verifyPassword } from './passwords'
import { limitIp, RateLimiter, reauthKey } from './rate-limit'
import { isLoopback } from '../http/tunnel'
import { guestDetail } from './guests'
import { USER_COLS_U, getUser, localeChoice, parsePrefs, userRef, type UserRow } from './users'
import { canChooseEngine } from '../admin/engine-choice'
import { teamIconOfMe } from '../admin/team-icon'
import { deploymentOf, featuresOf } from '../system/deployment'
import { windowsAppSourceOf } from '../system/windows-app'
import { reachedAt, teamAddressOf, type ReachedAt } from '../system/connection'
import { safeOpsEnabled } from '../safe-ops/runner'
import { devEnvUi } from '../devenv/setting'
import { firstSignIn } from '../onboarding/member-welcome'
import { htmlPdfUnavailable } from '../files/html-pdf'
import { pluginsOf } from '../plugins/manager'
import { cancelPushSession } from '../notifications/push-events'
import { webAllowAll } from '../tools/web-allow-all'
import { autoModeAvailable, autoModeOn, autoModeTeam } from '../chat/auto-mode'
import { mediaKeyOf } from './media-key'
import { voidAppSignInCodes } from './app-signin'
import { spendReauthFlow } from './reauth'

export const SESSION_TTL_MS = 30 * 24 * 3600_000
/** A session made by signing in with a temporary password lives this long unless the password is changed in it (it
 * then becomes a normal SESSION_TTL_MS session): "just signed in with it" is what lets it skip the current password. */
export const TEMP_SESSION_TTL_MS = 3600_000
/** last_seen_at is written at most this often per session */
const TOUCH_MS = 60_000

interface SessionRow { id: string; user_id: string; client: ClientKind; user_agent: string | null; created_at: string; last_seen_at: string; expires_at: string }

/** sessions.temp_login counts only while the account must still change its temporary password */
const tempLoginOf = (row: { temp_login: number }, user: { must_change_password: number }) => !!row.temp_login && !!user.must_change_password

export type EndReason = Parameters<RealtimeHub['disconnectUser']>[1]

function parseCookies(h: string | null): Map<string, string> {
  const out = new Map<string, string>()
  if (!h) return out
  for (const part of h.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    if (!out.has(k)) out.set(k, part.slice(i + 1).trim())
  }
  return out
}

/** Session token from the request and how it came. */
export function readToken(req: Request, freeRoam = false): { token: string; via: 'cookie' | 'bearer' } | null {
  const authz = req.headers.get('authorization')
  if (authz) {
    const m = /^Bearer\s+([A-Za-z0-9_-]{20,200})\s*$/.exec(authz)
    if (m) return { token: m[1]!, via: 'bearer' }
  }
  const proto = req.headers.get('sec-websocket-protocol')
  if (proto) {
    for (const p of proto.split(',').map((s) => s.trim())) {
      if (p.startsWith(WS_BEARER_PREFIX)) { const t = p.slice(WS_BEARER_PREFIX.length); if (/^[A-Za-z0-9_-]{20,200}$/.test(t)) return { token: t, via: 'bearer' } }
    }
  }
  // Only the cookie name of this scheme: on https only __Host-sid, which another *.treesoop.com site cannot set.
  // Accepting the dev name there would let a sibling team address plant a session cookie (session fixation, tab 7).
  const cookies = parseCookies(req.headers.get('cookie'))
  const c = cookies.get(cookieFor(req.url, freeRoam).name)
  if (c && /^[A-Za-z0-9_-]{20,200}$/.test(c)) return { token: c, via: 'cookie' }
  return null
}

/** A free-roam demo's session cookie, on the instance's plain http too: the visitor is on https behind demo-gate
 * (demo-gate/src/public.ts secureCookie: host-only, Secure), so the browser keeps the https name, never the plain-http
 * "mycel-dev-sid" (the product's code name and "dev", QA TC-5578) nor a bare "sid" another *.trina.app site could plant
 * (review finding 2 on #105). The browser takes a __Host- cookie only with Secure, Path=/ and no Domain: the instance
 * says Secure itself, so the cookie is valid whether or not the gate adds it, and reads the same name back on its
 * loopback http. Every other plain-http server keeps DEV_SESSION_COOKIE (the desktop app and older clients look for it). */
export const FREE_ROAM_SESSION_COOKIE = SESSION_COOKIE

/** __Host-sid on https; the dev cookie name on plain http (browsers refuse __Host- without Secure), except a free-roam
 * demo's, which is __Host-sid with Secure there too (its visitors are on https in front of the gate). */
export function cookieFor(reqUrl: string, freeRoam = false): { name: string; secure: boolean } {
  const https = new URL(reqUrl).protocol === 'https:'
  return https || freeRoam ? { name: SESSION_COOKIE, secure: true } : { name: DEV_SESSION_COOKIE, secure: false }
}

export function sessionCookie(reqUrl: string, token: string, maxAgeSec: number, freeRoam = false): string {
  const { name, secure } = cookieFor(reqUrl, freeRoam)
  return `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`
}

export class AuthService implements SessionService {
  readonly limiter: RateLimiter
  /** Told when a wrong password or Google check locks a person's re-check (owner-reauth, admin-reauth, the current password): the
   * owner's Inbox note and push (admin/handover.ts noteReauthLocked). Never lets an error through. */
  onReauthLocked: ((userId: string) => void) | null = null
  /** clock (tests move it) */
  now: () => number = () => Date.now()

  constructor(readonly ctx: AppContext) {
    this.limiter = new RateLimiter(ctx.db, undefined, () => this.now())
  }

  private get db() { return this.ctx.db }
  private iso(ms = this.now()) { return new Date(ms).toISOString() }

  // ---------------- SessionService ----------------
  async resolve(req: Request, _info: RequestInfo): Promise<AuthInfo | null> {
    const t = readToken(req, isFreeRoam(this.ctx.config))
    if (!t) return null
    const row = this.db.query(`SELECT s.id AS sid, s.client, s.expires_at AS s_expires, s.last_seen_at AS s_seen, s.temp_login, ${USER_COLS_U}
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(hashToken(t.token)) as (UserRow & { sid: string; client: ClientKind; s_expires: string; s_seen: string; temp_login: number }) | null
    if (!row) return null
    const now = this.now()
    if (Date.parse(row.s_expires) <= now || row.status !== 'active' || row.deleted_at) {
      if (Date.parse(row.s_expires) <= now) {
        this.db.query('DELETE FROM sessions WHERE id = ?').run(row.sid)
        // a window still open on this session must not keep receiving team events
        this.ctx.services.realtime.disconnectSession?.(row.sid, 'expired')
      }
      cancelPushSession(this.ctx, row.sid)
      return null
    }
    if (now - Date.parse(row.s_seen) > TOUCH_MS) {
      const at = this.iso(now)
      this.db.query('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(at, row.sid)
      this.db.query('UPDATE users SET last_seen_at = ? WHERE id = ?').run(at, row.id)
    }
    return {
      user: { id: row.id, username: row.username, name: row.name, role: row.role, locale: row.locale, mustChangePassword: !!row.must_change_password },
      session: { id: row.sid, client: row.client, expiresAt: row.s_expires, ...(tempLoginOf(row, row) ? { tempLogin: true } : {}) },
      via: t.via,
    }
  }

  /** owner-reauth and "current password" checks; rate-limited per person. An account without a password (made with
   * Google) never matches: it re-checks with Google (verifyReauth). */
  async verifyPassword(userId: string, password: string, _info: RequestInfo): Promise<boolean> {
    return this.recheck(userId, null, async (u) => verifyPassword(password, u?.password_hash))
  }

  /** Every re-check (auth/reauth.ts): the password, or, for an account without one, a Google check this session finished
   * (spent once, within its 5 minutes). One limit for both: a wrong try of either kind counts and locks like a wrong
   * password, and a locked limit refuses both. The password goes through verifyPassword (tests slow it down there). */
  async verifyReauth(userId: string, sessionId: string, proof: { password: string } | { reauthFlow: string }, info: RequestInfo): Promise<boolean> {
    if ('password' in proof && typeof proof.password === 'string') return this.verifyPassword(userId, proof.password, info)
    const flow = (proof as { reauthFlow: string }).reauthFlow
    return this.recheck(userId, 'google', async () => spendReauthFlow(this.db, flow, userId, sessionId, this.now()))
  }

  /** One re-check on the person's limit: held before the check, so parallel guesses cannot slip past it. */
  private async recheck(userId: string, method: 'google' | null, check: (u: UserRow | null) => Promise<boolean>): Promise<boolean> {
    const key = reauthKey(userId)
    const hold = this.limiter.hold([key])
    if (hold.wait > 0) fail('rate_limited', undefined, { retryAfter: hold.wait })
    const u = getUser(this.db, userId)
    let ok = false
    try { ok = (await check(u)) && !!u && u.status === 'active' } catch (e) { hold.release(); throw e }
    if (ok) hold.release()
    else {
      // which way it was, never what was sent
      audit(this.db, { actor: userId, action: 'auth.reauth_failed', target: userId, ...(method ? { detail: { method } } : {}) })
      // this wrong try used up the window: whoever holds the session may be guessing
      if (this.onReauthLocked && this.limiter.retryAfter([key]) > 0) try { this.onReauthLocked(userId) } catch { /* the listener's own problem */ }
    }
    return ok
  }

  private recent = new Map<string, number>()
  /** true at most once a minute per key (throttles audit rows for refused attempts); memory stays bounded */
  firstInMinute(key: string): boolean {
    const now = this.now()
    const last = this.recent.get(key)
    if (last !== undefined && now - last < 60_000) return false
    if (this.recent.size >= 10_000) this.recent.clear()
    this.recent.set(key, now)
    return true
  }

  // ---------------- sessions ----------------
  /** tempLogin: signed in with a temporary password (one hour; may set the new password without the current one) */
  createSession(userId: string, client: ClientKind, userAgent: string | null, o: { tempLogin?: boolean } = {}): { id: string; token: string; expiresAt: string } {
    const token = newToken()
    const id = newId()
    const now = this.now()
    const expiresAt = this.iso(now + (o.tempLogin ? TEMP_SESSION_TTL_MS : SESSION_TTL_MS))
    this.db.query('INSERT INTO sessions (id, user_id, token_hash, client, user_agent, created_at, last_seen_at, expires_at, temp_login) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, userId, hashToken(token), client, userAgent ? userAgent.slice(0, 300) : null, this.iso(now), this.iso(now), expiresAt, o.tempLogin ? 1 : 0)
    this.db.query('UPDATE users SET last_seen_at = ? WHERE id = ?').run(this.iso(now), userId)
    return { id, token, expiresAt }
  }

  /** The temporary password was changed in this session: it becomes a normal session (30 days from now). */
  finishTempLogin(sessionId: string): void {
    this.db.query('UPDATE sessions SET temp_login = 0, expires_at = ? WHERE id = ? AND temp_login = 1').run(this.iso(this.now() + SESSION_TTL_MS), sessionId)
  }

  /** Delete one session and close its sockets (logout, "sign out this device"). */
  revokeSession(sessionId: string, reason: EndReason = 'logout'): void {
    this.db.query('DELETE FROM sessions WHERE id = ?').run(sessionId)
    cancelPushSession(this.ctx, sessionId)
    this.ctx.services.realtime.disconnectSession?.(sessionId, reason)
  }

  /**
   * End every session of a person (except `keep`): password changed / reset, account disabled or deleted.
   * Sockets of the ended sessions close; with `keep` only the other sessions' sockets are closed. The person's MCP
   * connector connections end too (their own session rows); the count is of sign-ins only. The person's unspent
   * desktop sign-in codes go too (auth/app-signin.ts): a code made before must not sign anyone in after this.
   */
  endUserSessions(userId: string, reason: EndReason, keep?: string): number {
    voidAppSignInCodes(this.db, userId)
    // connector rows too (an MCP connector's own row, migration 130): their grants end with them (ON DELETE CASCADE)
    const rows = this.db.query('SELECT id, connector FROM sessions WHERE user_id = ? AND id IS NOT ?').all(userId, keep ?? null) as { id: string; connector: number }[]
    const ids = rows.filter((r) => !r.connector).map((r) => r.id)
    this.db.query('DELETE FROM sessions WHERE user_id = ? AND id IS NOT ?').run(userId, keep ?? null)
    for (const id of ids) cancelPushSession(this.ctx, id)
    const rt = this.ctx.services.realtime
    if (keep) { for (const id of ids) rt.disconnectSession?.(id, reason) }
    else rt.disconnectUser(userId, reason)
    return ids.length
  }

  listSessions(userId: string): SessionRow[] {
    return this.db.query('SELECT id, user_id, client, user_agent, created_at, last_seen_at, expires_at FROM sessions WHERE user_id = ? AND connector = 0 AND expires_at > ? ORDER BY last_seen_at DESC')
      .all(userId, this.iso()) as SessionRow[]
  }

  /** Delete expired sessions and close the windows still open on them (they were authenticated only at connect). */
  sweepSessions(): number {
    const at = this.iso()
    const ids = (this.db.query('SELECT id FROM sessions WHERE expires_at <= ?').all(at) as { id: string }[]).map((r) => r.id)
    const n = this.db.query('DELETE FROM sessions WHERE expires_at <= ?').run(at).changes
    for (const id of ids) { cancelPushSession(this.ctx, id); this.ctx.services.realtime.disconnectSession?.(id, 'expired') }
    return n
  }

  // ---------------- sign-in ----------------
  /** Create a session, set the cookie (cookie mode) and return the LoginResponse. */
  signIn(c: Context<AppEnv>, userId: string, client: ClientKind, tokenMode: 'cookie' | 'bearer', o: { tempLogin?: boolean } = {}): LoginResponse {
    // every caller proved a secret (password, invite or reset link): this network is now one the person uses, so
    // failed sign-ins from elsewhere cannot lock them out here (accounts.ts login, rate-limit.ts AccountScope)
    const info = c.get('info')
    if (info.ip && !(!info.tunnel && isLoopback(info.ip))) this.limiter.rememberNet(userId, limitIp(info.ip))
    if (tokenMode === 'cookie') this.endReplacedSession(c.req.raw, userId)
    const s = this.createSession(userId, client, c.req.header('user-agent') ?? null, o)
    // someone an admin added directly joins with their first sign-in: the everyone room's line and the owners' notice
    firstSignIn(this.ctx, userId)
    // the cookie keeps the normal lifetime either way: the server decides when a temporary sign-in ends, and a changed
    // password turns it into a normal session without a new cookie
    if (tokenMode === 'cookie') c.header('Set-Cookie', sessionCookie(c.req.url, s.token, Math.floor(SESSION_TTL_MS / 1000), isFreeRoam(this.ctx.config)), { append: true })
    const me = this.me(userId, s.id, reachedAt(c))
    return tokenMode === 'bearer' ? { me, token: s.token } : { me }
  }

  /** A sign-in in a browser that still sends another person's session cookie: that sign-out never reached the server
   * (web/src/lib/logout.ts shows the sign-in page anyway, and only the server's answer clears the HttpOnly cookie).
   * The new cookie replaces it, so this browser can never use that session again: it ends like a sign-out, and its
   * phone push row goes with it, so a shared phone stops getting the first person's notices and the next person can
   * register it (QA TC-835; another person's live session elsewhere still keeps its token, TC-201). The same person's
   * earlier session is left as it is (the desktop app copies one cookie to its second team address). */
  private endReplacedSession(req: Request, userId: string): void {
    const t = parseCookies(req.headers.get('cookie')).get(cookieFor(req.url, isFreeRoam(this.ctx.config)).name)
    if (!t || !/^[A-Za-z0-9_-]{20,200}$/.test(t)) return
    const old = this.db.query('SELECT id, user_id FROM sessions WHERE token_hash = ?').get(hashToken(t)) as { id: string; user_id: string } | null
    if (old && old.user_id !== userId) this.revokeSession(old.id, 'logout')
  }

  clearCookie(c: Context<AppEnv>): void {
    c.header('Set-Cookie', sessionCookie(c.req.url, '', 0, isFreeRoam(this.ctx.config)), { append: true })
  }

  /** The HWP Preview plugin is on and usable here (plugins/manager.ts); a plugin store that cannot be read is off. */
  private hwpPreviewOn(): boolean {
    try { return pluginsOf(this.ctx).hwpPreviewOn() } catch { return false }
  }

  /** `at`: where this request reached the server (reachedAt(c)), for the team address of a server without a relay */
  me(userId: string, sessionId: string, at?: ReachedAt | null): Me {
    const u = getUser(this.db, userId)
    if (!u) return fail('unauthorized')
    const s = this.db.query('SELECT id, client, expires_at, temp_login FROM sessions WHERE id = ?').get(sessionId) as { id: string; client: ClientKind; expires_at: string; temp_login: number } | null
    if (!s) return fail('unauthorized')
    const mediaKey = mediaKeyOf(this.db, s.id)
    const groups = this.db.query('SELECT g.id, g.name FROM group_members m JOIN groups g ON g.id = m.group_id WHERE m.user_id = ? ORDER BY g.name').all(userId) as { id: string; name: string }[]
    const settings = getTeamSettings(this.db)
    // an own default engine / model counts only while the person may pick (Admin > AI engines)
    const choose = canChooseEngine(this.ctx, { id: u.id, role: u.role })
    const prefs = parsePrefs(u.prefs)
    if (!choose) { delete prefs.engine; delete prefs.model }
    const windowsApp = windowsAppSourceOf(this.ctx.config)
    // the team's own address for its members (Settings › 앱): the relay's or the public one; without a relay the one
    // this request reached the server at
    const address = teamAddressOf(this.ctx, at)
    // my status message, also one that starts later (docs/DECISIONS.md "상태 메시지")
    const status = myStatusOf(this.db, u.id)
    const guest = u.role === 'guest' ? guestDetail(this.db, u.id) : undefined
    return {
      ...(guest ? { guest } : {}),
      user: {
        id: u.id, username: u.username, name: u.name, email: u.email, role: u.role, locale: u.locale, localeChoice: localeChoice(u),
        mustChangePassword: !!u.must_change_password, prefs,
        // an account made with Google has none: its re-checks confirm with Google (auth/reauth.ts)
        hasPassword: !!u.password_hash,
        canChooseEngine: choose,
        ...profileOf(this.db, u.id),
        ...(status ? { statusMessage: status } : {}),
        ...(webAllowAll(this.db, u.id) ? { webAllowAll: true as const } : {}),
        ...(autoModeOn(this.db, u.id) ? { autoMode: true as const } : {}),
      },
      groups,
      team: { name: settings.teamName, defaultLocale: settings.defaultLocale, browserAllowAll: settings.browserAllowAll, ...(settings.browserAllowAll && settings.webAllowAll ? { webAllowAll: true as const } : {}), ...teamIconOfMe(this.ctx.config.dataDir), voiceInput: voiceInputOn(this.db, this.ctx.files.speech), ...(voiceInputOutside(this.db) ? { voiceInputOutside: true as const } : {}), ...(wantsWavRecordings(this.ctx.files.speech) ? { voiceInputWav: true as const } : {}), chatTrashRetentionDays: settings.chatTrashRetentionDays, trashRetentionDays: settings.trashRetentionDays, projectCreators: settings.projectCreators, ...(settings.roomAlwaysAllow === false ? { alwaysAllowOff: true as const } : {}), ...(autoModeAvailable(this.db, u.id) ? { autoMode: autoModeTeam(this.db) as 'allowed' | 'default' } : {}), ...(address ? { address } : {}) , ...(u.role === 'guest' ? { uploadMaxBytes: roomFilesOf(this.ctx).maxFor(u.id) } : {}) },
      session: { id: s.id, client: s.client, expiresAt: s.expires_at, tempLogin: tempLoginOf(s, u), ...(mediaKey ? { mediaKey } : {}) },
      // office mode runs dev's engine setup on purpose (docs/OFFICE.md): the office's desks get no DEV banner
      // ...nor a free-roam demo's visitor (docs/decisions/20261119-demo-free-roam-a.md)
      server: { version: this.ctx.version, dev: this.ctx.config.mode === 'dev' && !this.ctx.config.office && !isFreeRoam(this.ctx.config),
        deployment: deploymentOf(this.ctx.config), features: featuresOf(this.ctx.config), timeZone: settings.timeZone,
        ...(safeOpsEnabled() ? { allChatsConfidential: true as const } : {}),
        ...(devEnvUi() ? { devEnv: true as const } : {}),
        ...(htmlPdfUnavailable() === null ? { htmlPdf: true as const } : {}),
        ...(this.hwpPreviewOn() ? { hwpPreview: true as const } : {}),
        ...(windowsApp ? { windowsApp } : {}),
        // always on (owner 2026-11-17); still sent for web, desktop and phone builds from before, which show folder
        // sharing only when it is true
        folderShares: true as const },
      passwordReset: u.password_reset_at ? { by: userRef(this.db, u.password_reset_by), at: u.password_reset_at } : null,
    }
  }

}

/** The AuthService of an app context (installed by the auth route module's init()). */
const registry = new WeakMap<AppContext, AuthService>()
export function installAuth(ctx: AppContext): AuthService {
  const a = new AuthService(ctx)
  registry.set(ctx, a)
  ctx.services.sessions = a
  return a
}
export function authOf(ctx: AppContext): AuthService {
  const a = registry.get(ctx)
  if (!a) throw new Error('auth service not installed (routes/auth.ts init() must run first)')
  return a
}
