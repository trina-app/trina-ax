// Sessions (tab 4 "인증"): random token, only its SHA-256 in the DB, 30 days. Web and desktop use the __Host-sid
// cookie (HttpOnly, Secure, SameSite=Lax, Path=/, no Domain; plain-http dev servers use DEV_SESSION_COOKIE), apps
// and scripts use `Authorization: Bearer`, mobile WebSocket shells the `mycel.bearer.<token>` subprotocol.
// This file implements SessionService for the whole app (installed by routes/auth.ts init()).
import type { Context } from 'hono'
import {
  DEV_SESSION_COOKIE, SESSION_COOKIE, WS_BEARER_PREFIX,
  type ClientKind, type LoginResponse, type Me,
} from '@mycel/shared/api'
import type { AppContext } from '../context'
import { newId } from '../db'
import type { AppEnv } from '../http/env'
import { fail } from '../http/errors'
import type { AuthInfo, RealtimeHub, RequestInfo, SessionService } from '../services'
import { getTeamSettings } from '../admin/settings'
import { audit } from '../admin/audit'
import { hashToken, newToken, verifyPassword } from './passwords'
import { RateLimiter, reauthKey } from './rate-limit'
import { USER_COLS, getUser, localeChoice, parsePrefs, userRef, type UserRow } from './users'

export const SESSION_TTL_MS = 30 * 24 * 3600_000
/** last_seen_at is written at most this often per session */
const TOUCH_MS = 60_000

interface SessionRow { id: string; user_id: string; client: ClientKind; user_agent: string | null; created_at: string; last_seen_at: string; expires_at: string }

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
export function readToken(req: Request): { token: string; via: 'cookie' | 'bearer' } | null {
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
  const c = cookies.get(cookieFor(req.url).name)
  if (c && /^[A-Za-z0-9_-]{20,200}$/.test(c)) return { token: c, via: 'cookie' }
  return null
}

/** __Host-sid on https; the dev cookie name on plain http (browsers refuse __Host- without Secure). */
export function cookieFor(reqUrl: string): { name: string; secure: boolean } {
  const https = new URL(reqUrl).protocol === 'https:'
  return https ? { name: SESSION_COOKIE, secure: true } : { name: DEV_SESSION_COOKIE, secure: false }
}

export function sessionCookie(reqUrl: string, token: string, maxAgeSec: number): string {
  const { name, secure } = cookieFor(reqUrl)
  return `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`
}

export class AuthService implements SessionService {
  readonly limiter: RateLimiter
  /** clock (tests move it) */
  now: () => number = () => Date.now()

  constructor(readonly ctx: AppContext) {
    this.limiter = new RateLimiter(ctx.db, undefined, () => this.now())
  }

  private get db() { return this.ctx.db }
  private iso(ms = this.now()) { return new Date(ms).toISOString() }

  // ---------------- SessionService ----------------
  async resolve(req: Request, _info: RequestInfo): Promise<AuthInfo | null> {
    const t = readToken(req)
    if (!t) return null
    const row = this.db.query(`SELECT s.id AS sid, s.client, s.expires_at, s.last_seen_at AS s_seen, u.${USER_COLS.split(', ').join(', u.')}
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(hashToken(t.token)) as (UserRow & { sid: string; client: ClientKind; expires_at: string; s_seen: string }) | null
    if (!row) return null
    const now = this.now()
    if (Date.parse(row.expires_at) <= now || row.status !== 'active' || row.deleted_at) {
      if (Date.parse(row.expires_at) <= now) {
        this.db.query('DELETE FROM sessions WHERE id = ?').run(row.sid)
        // a window still open on this session must not keep receiving team events
        this.ctx.services.realtime.disconnectSession?.(row.sid, 'expired')
      }
      return null
    }
    if (now - Date.parse(row.s_seen) > TOUCH_MS) {
      const at = this.iso(now)
      this.db.query('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(at, row.sid)
      this.db.query('UPDATE users SET last_seen_at = ? WHERE id = ?').run(at, row.id)
    }
    return {
      user: { id: row.id, username: row.username, name: row.name, role: row.role, locale: row.locale, mustChangePassword: !!row.must_change_password },
      session: { id: row.sid, client: row.client, expiresAt: row.expires_at },
      via: t.via,
    }
  }

  /** owner-reauth and "current password" checks; rate-limited per person. */
  async verifyPassword(userId: string, password: string, _info: RequestInfo): Promise<boolean> {
    const key = reauthKey(userId)
    const hold = this.limiter.hold([key])
    if (hold.wait > 0) fail('rate_limited', undefined, { retryAfter: hold.wait })
    const u = getUser(this.db, userId)
    let ok = false
    try { ok = !!u && u.status === 'active' && (await verifyPassword(password, u.password_hash)) } catch (e) { hold.release(); throw e }
    if (ok) hold.release()
    else audit(this.db, { actor: userId, action: 'auth.reauth_failed', target: userId })
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
  createSession(userId: string, client: ClientKind, userAgent: string | null): { id: string; token: string; expiresAt: string } {
    const token = newToken()
    const id = newId()
    const now = this.now()
    const expiresAt = this.iso(now + SESSION_TTL_MS)
    this.db.query('INSERT INTO sessions (id, user_id, token_hash, client, user_agent, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, userId, hashToken(token), client, userAgent ? userAgent.slice(0, 300) : null, this.iso(now), this.iso(now), expiresAt)
    this.db.query('UPDATE users SET last_seen_at = ? WHERE id = ?').run(this.iso(now), userId)
    return { id, token, expiresAt }
  }

  /** Delete one session and close its sockets (logout, "sign out this device"). */
  revokeSession(sessionId: string, reason: EndReason = 'logout'): void {
    this.db.query('DELETE FROM sessions WHERE id = ?').run(sessionId)
    this.ctx.services.realtime.disconnectSession?.(sessionId, reason)
  }

  /**
   * End every session of a person (except `keep`): password changed / reset, account disabled or deleted.
   * Sockets of the ended sessions close; with `keep` only the other sessions' sockets are closed.
   */
  endUserSessions(userId: string, reason: EndReason, keep?: string): number {
    const ids = (this.db.query('SELECT id FROM sessions WHERE user_id = ? AND id IS NOT ?').all(userId, keep ?? null) as { id: string }[]).map((r) => r.id)
    this.db.query('DELETE FROM sessions WHERE user_id = ? AND id IS NOT ?').run(userId, keep ?? null)
    const rt = this.ctx.services.realtime
    if (keep) { for (const id of ids) rt.disconnectSession?.(id, reason) }
    else rt.disconnectUser(userId, reason)
    return ids.length
  }

  listSessions(userId: string): SessionRow[] {
    return this.db.query('SELECT id, user_id, client, user_agent, created_at, last_seen_at, expires_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC')
      .all(userId, this.iso()) as SessionRow[]
  }

  /** Delete expired sessions and close the windows still open on them (they were authenticated only at connect). */
  sweepSessions(): number {
    const at = this.iso()
    const ids = (this.db.query('SELECT id FROM sessions WHERE expires_at <= ?').all(at) as { id: string }[]).map((r) => r.id)
    const n = this.db.query('DELETE FROM sessions WHERE expires_at <= ?').run(at).changes
    for (const id of ids) this.ctx.services.realtime.disconnectSession?.(id, 'expired')
    return n
  }

  // ---------------- sign-in ----------------
  /** Create a session, set the cookie (cookie mode) and return the LoginResponse. */
  signIn(c: Context<AppEnv>, userId: string, client: ClientKind, tokenMode: 'cookie' | 'bearer'): LoginResponse {
    const s = this.createSession(userId, client, c.req.header('user-agent') ?? null)
    if (tokenMode === 'cookie') c.header('Set-Cookie', sessionCookie(c.req.url, s.token, Math.floor(SESSION_TTL_MS / 1000)), { append: true })
    const me = this.me(userId, s.id)
    return tokenMode === 'bearer' ? { me, token: s.token } : { me }
  }

  clearCookie(c: Context<AppEnv>): void {
    c.header('Set-Cookie', sessionCookie(c.req.url, '', 0), { append: true })
  }

  me(userId: string, sessionId: string): Me {
    const u = getUser(this.db, userId)
    if (!u) return fail('unauthorized')
    const s = this.db.query('SELECT id, client, expires_at FROM sessions WHERE id = ?').get(sessionId) as { id: string; client: ClientKind; expires_at: string } | null
    if (!s) return fail('unauthorized')
    const groups = this.db.query('SELECT g.id, g.name FROM group_members m JOIN groups g ON g.id = m.group_id WHERE m.user_id = ? ORDER BY g.name').all(userId) as { id: string; name: string }[]
    const settings = getTeamSettings(this.db)
    return {
      user: {
        id: u.id, username: u.username, name: u.name, email: u.email, role: u.role, locale: u.locale, localeChoice: localeChoice(u),
        mustChangePassword: !!u.must_change_password, prefs: parsePrefs(u.prefs),
      },
      groups,
      team: { name: settings.teamName, defaultLocale: settings.defaultLocale },
      session: { id: s.id, client: s.client, expiresAt: s.expires_at },
      // office mode runs dev's engine setup on purpose (docs/OFFICE.md): the clinic's desks get no DEV banner
      server: { version: this.ctx.version, dev: this.ctx.config.mode === 'dev' && !this.ctx.config.office },
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
