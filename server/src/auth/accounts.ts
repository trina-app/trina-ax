// Account flows: first-owner setup, sign-in, password change, invites, one-time reset links.
import fs from 'node:fs'
import path from 'node:path'
import type { Context } from 'hono'
import type { Database } from 'bun:sqlite'
import {
  type AcceptInviteBody, type ChangePasswordBody, type CompletePasswordResetBody, type CreateInviteBody, type Invite,
  type InviteInfo, type Locale, type LoginBody, type LoginResponse, type PasswordResetInfo, type Role, type SetupBody,
} from '@mycel/shared/api'
import type { z } from 'zod'
import type { AppContext } from '../context'
import { newId } from '../db'
import type { AppEnv } from '../http/env'
import { fail } from '../http/errors'
import { originAllowed } from '../http/middleware'
import { audit } from '../admin/audit'
import { createDefaultFolders } from '../admin/folders'
import { getTeamSettings, updateTeamSettings } from '../admin/settings'
import { msg, weakPasswordMessage } from './messages'
import { hashPassword, hashToken, newToken, passwordProblem, safeEqual, verifyPassword } from './passwords'
import { accountKey, ipKeys, tokenIpKeys } from './rate-limit'
import { authOf } from './service'
import { deriveUserId, ensurePersonalFolder, existingGroups, getUser, getUserByUsername, insertUser, usernameTaken, userRef, type UserRow } from './users'

export const RESET_TTL_MS = 24 * 3600_000

type In<T extends z.ZodType> = z.output<T>

/** Base URL for links the admin copies (invite / reset): the caller's own origin when it is one of ours. */
export function linkBase(c: Context<AppEnv>, ctx: AppContext): string {
  const origin = c.req.header('origin')
  if (origin && origin !== 'null' && originAllowed(origin, c.req.url, ctx.config.publicOrigins)) return origin
  return ctx.config.publicOrigins[0] ?? new URL(c.req.url).origin
}

function checkNewPassword(pw: string, username: string | null, locale: Locale, field: string): void {
  const p = passwordProblem(pw, { username })
  if (p) fail('validation', weakPasswordMessage(p, locale), { fields: { [field]: p } })
}

/** Count an unknown/invalid token against the caller's IP and refuse while over the limit. */
function tokenGuard(ctx: AppContext, ip: string | null): { fail(): void } {
  const a = authOf(ctx)
  const keys = tokenIpKeys(ip)
  const wait = a.limiter.retryAfter(keys)
  if (wait > 0) fail('rate_limited', undefined, { retryAfter: wait })
  return { fail: () => a.limiter.fail(keys) }
}

// ---------------- first-run setup ----------------
export const userCount = (db: Database) => (db.query('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n

export function setupStatus(ctx: AppContext): { needed: boolean; teamName: string | null; defaultLocale: Locale } {
  const needed = userCount(ctx.db) === 0
  const s = getTeamSettings(ctx.db)
  return { needed, teamName: needed ? null : s.teamName, defaultLocale: s.defaultLocale }
}

export interface OwnerInput { username: string; name: string; password: string; email?: string | null; teamName: string; locale: Locale }

/**
 * Create the team and its owner. Only while no user exists (checked inside an immediate transaction, so two
 * concurrent setups cannot both win). Used by POST /api/setup and the server CLI.
 */
export async function bootstrapOwner(ctx: AppContext, o: OwnerInput): Promise<string> {
  const passwordHash = await hashPassword(o.password)
  const id = deriveUserId(ctx.db, o.username, ctx.files.fx.root)
  const created = ctx.db.transaction(() => {
    if (userCount(ctx.db) > 0) return false
    // the owner follows the team language they just picked (null), like everyone who has not chosen their own
    updateTeamSettings(ctx.db, { teamName: o.teamName, defaultLocale: o.locale })
    insertUser(ctx.db, { id, username: o.username, name: o.name, email: o.email ?? null, passwordHash, role: 'owner', locale: null, mustChangePassword: false })
    createDefaultFolders(ctx)
    audit(ctx.db, { actor: id, action: 'setup', target: id, detail: { teamName: o.teamName } })
    return true
  }).immediate()
  if (!created) fail('conflict', msg('setupDone', o.locale))
  ensurePersonalFolder(ctx.files.fx.root, id)
  // the one-time token is spent
  ctx.config.setupToken = null
  fs.rmSync(path.join(ctx.config.dataDir, 'setup-token'), { force: true })
  return id
}

export async function setup(c: Context<AppEnv>, ctx: AppContext, b: In<typeof SetupBody>): Promise<LoginResponse> {
  const locale = c.get('locale')
  if (userCount(ctx.db) > 0) fail('conflict', msg('setupDone', locale))
  const guard = tokenGuard(ctx, c.get('info').ip)
  const expected = ctx.config.setupToken
  if (!expected || !safeEqual(b.setupToken, expected)) { guard.fail(); fail('forbidden', msg('setupTokenWrong', locale)) }
  checkNewPassword(b.owner.password, b.owner.username, locale, 'body.owner.password')
  const id = await bootstrapOwner(ctx, { username: b.owner.username, name: b.owner.name, password: b.owner.password, email: b.owner.email ?? null, teamName: b.teamName, locale: b.locale })
  return authOf(ctx).signIn(c, id, 'web', 'cookie')
}

// ---------------- sign-in ----------------
export async function login(c: Context<AppEnv>, ctx: AppContext, b: In<typeof LoginBody>): Promise<LoginResponse> {
  const a = authOf(ctx)
  const locale = c.get('locale')
  const ip = c.get('info').ip
  const keys = [accountKey(b.username), ...ipKeys(ip)]
  // counted before the (slow) password check, so parallel guesses cannot slip past the limit
  const hold = a.limiter.hold(keys)
  if (hold.wait > 0) {
    // one audit row per client IP (or account, when the IP is unknown) and minute: a flood of refused attempts,
    // even with made-up usernames, cannot fill the disk
    if (a.firstInMinute(ip ? `rl-ip:${ip}` : `rl-user:${b.username.toLowerCase()}`)) {
      audit(ctx.db, { actor: null, action: 'auth.rate_limited', target: getUserByUsername(ctx.db, b.username)?.id ?? null, detail: { ip, via: c.get('info').via } })
    }
    fail('rate_limited', msg('tooManyAttempts', locale), { retryAfter: hold.wait })
  }
  const u = getUserByUsername(ctx.db, b.username)
  let ok = false
  try { ok = await verifyPassword(b.password, u?.password_hash) } catch (e) { hold.release(); throw e }
  // a disabled account fails exactly like a wrong password (same 401, same words, still counted toward the limit):
  // a different answer would tell anyone that the account exists, is disabled and that this password is right
  if (!u || !ok || u.status !== 'active') {
    audit(ctx.db, { actor: null, action: 'auth.login_failed', target: u?.id ?? null, detail: { ip, via: c.get('info').via, ...(u && ok ? { disabled: true } : {}) } })
    fail('unauthorized', msg('badLogin', locale))
  }
  hold.release()
  a.limiter.clear(accountKey(b.username))
  audit(ctx.db, { actor: u!.id, action: 'auth.login', target: u!.id, detail: { ip, via: c.get('info').via, client: b.client } })
  return a.signIn(c, u!.id, b.client, b.tokenMode)
}

export async function changePassword(c: Context<AppEnv>, ctx: AppContext, b: In<typeof ChangePasswordBody>): Promise<void> {
  const a = authOf(ctx)
  const auth = c.get('auth')!
  const locale = c.get('locale')
  if (!(await a.verifyPassword(auth.user.id, b.currentPassword, c.get('info')))) fail('forbidden', msg('wrongCurrentPassword', locale), { fields: { 'body.currentPassword': 'wrong password' } })
  if (b.newPassword === b.currentPassword) fail('validation', msg('samePassword', locale), { fields: { 'body.newPassword': 'same as current' } })
  checkNewPassword(b.newPassword, auth.user.username, locale, 'body.newPassword')
  const hash = await hashPassword(b.newPassword)
  ctx.db.query('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, auth.user.id)
  const ended = a.endUserSessions(auth.user.id, 'password_changed', auth.session.id)
  audit(ctx.db, { actor: auth.user.id, action: 'auth.password_changed', target: auth.user.id, detail: { otherSessionsEnded: ended, ip: c.get('info').ip } })
}

// ---------------- invites ----------------
interface InviteRow { id: string; role: Exclude<Role, 'owner'>; group_ids: string; created_by: string | null; created_at: string | null; expires_at: string; used_at: string | null; used_by: string | null; revoked_at: string | null }
const INVITE_COLS = 'id, role, group_ids, created_by, created_at, expires_at, used_at, used_by, revoked_at'

function parseIds(s: string): string[] { try { const v = JSON.parse(s); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [] } catch { return [] } }

export function toInvite(db: Database, r: InviteRow): Invite {
  return {
    id: r.id, role: r.role, groupIds: parseIds(r.group_ids), createdBy: userRef(db, r.created_by), createdAt: r.created_at ?? r.expires_at,
    expiresAt: r.expires_at, usedAt: r.used_at, usedBy: userRef(db, r.used_by),
  }
}

export function listInvites(ctx: AppContext): Invite[] {
  return (ctx.db.query(`SELECT ${INVITE_COLS} FROM invites WHERE revoked_at IS NULL ORDER BY created_at DESC`).all() as InviteRow[]).map((r) => toInvite(ctx.db, r))
}

export function createInvite(c: Context<AppEnv>, ctx: AppContext, b: In<typeof CreateInviteBody>) {
  const auth = c.get('auth')!
  const locale = c.get('locale')
  if (b.role === 'admin' && auth.user.role !== 'owner') fail('forbidden', msg('ownerOnlyAdmins', locale))
  const groups = existingGroups(ctx.db, b.groupIds)
  if (groups.length !== new Set(b.groupIds).size) fail('validation', msg('unknownGroups', locale), { fields: { 'body.groupIds': 'unknown group' } })
  const token = newToken()
  const now = authOf(ctx).now()
  const row: InviteRow = { id: newId(), role: b.role, group_ids: JSON.stringify(groups), created_by: auth.user.id, created_at: new Date(now).toISOString(), expires_at: new Date(now + b.expiresInHours * 3600_000).toISOString(), used_at: null, used_by: null, revoked_at: null }
  ctx.db.query('INSERT INTO invites (id, role, group_ids, token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(row.id, row.role, row.group_ids, hashToken(token), row.created_by, row.created_at, row.expires_at)
  audit(ctx.db, { actor: auth.user.id, action: 'invite.create', target: row.id, detail: { role: row.role, groupIds: groups, expiresAt: row.expires_at } })
  return { invite: toInvite(ctx.db, row), token, url: `${linkBase(c, ctx)}/invite/${token}` }
}

export function revokeInvite(c: Context<AppEnv>, ctx: AppContext, id: string): void {
  const r = ctx.db.query(`SELECT ${INVITE_COLS} FROM invites WHERE id = ? AND revoked_at IS NULL`).get(id) as InviteRow | null
  if (!r) fail('not_found')
  if (r!.used_at) fail('conflict', msg('inviteUsed', c.get('locale')))
  ctx.db.query('UPDATE invites SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), id)
  audit(ctx.db, { actor: c.get('auth')!.user.id, action: 'invite.revoke', target: id })
}

function inviteByToken(db: Database, token: string): InviteRow | null {
  return db.query(`SELECT ${INVITE_COLS} FROM invites WHERE token_hash = ?`).get(hashToken(token)) as InviteRow | null
}
/**
 * An invite works only while its maker could still make it now: the maker is a
 * live, active owner (any invite) or admin (member invites only; admin invites are owner-only). Without this, an invite kept past its maker's
 * demotion still opened an account with the old authority: an owner who handed ownership away (now a mere admin)
 * still onboarded a new ADMIN through an admin invite made earlier. Revoking on demotion (users.ts) is the first
 * line; this check closes every path, including a missed revocation. An invite with no maker on record is refused:
 * nothing makes one (there is no server-Mac invite), so it can only come from a damaged or edited database.
 */
function inviteValid(db: Database, r: InviteRow, now: number): boolean {
  if (r.used_at || r.revoked_at || Date.parse(r.expires_at) <= now) return false
  if (r.created_by === null) return false
  const by = getUser(db, r.created_by)
  if (!by || by.status !== 'active') return false
  if (by.role === 'owner') return true
  if (by.role === 'admin') return r.role === 'member'
  return false
}

export function inviteInfo(c: Context<AppEnv>, ctx: AppContext, token: string): InviteInfo {
  const guard = tokenGuard(ctx, c.get('info').ip)
  const r = inviteByToken(ctx.db, token)
  if (!r) { guard.fail(); fail('not_found') }
  return { teamName: getTeamSettings(ctx.db).teamName, role: r!.role, expiresAt: r!.expires_at, valid: inviteValid(ctx.db, r!, authOf(ctx).now()) }
}

export async function acceptInvite(c: Context<AppEnv>, ctx: AppContext, token: string, b: In<typeof AcceptInviteBody>): Promise<LoginResponse> {
  const a = authOf(ctx)
  const locale = c.get('locale')
  const guard = tokenGuard(ctx, c.get('info').ip)
  const r = inviteByToken(ctx.db, token)
  if (!r) { guard.fail(); fail('not_found') }
  if (!inviteValid(ctx.db, r!, a.now())) fail('gone', msg('linkInvalid', locale))
  if (usernameTaken(ctx.db, b.username)) fail('conflict', msg('usernameTaken', locale), { fields: { 'body.username': 'taken' } })
  checkNewPassword(b.password, b.username, locale, 'body.password')
  const passwordHash = await hashPassword(b.password)
  const groups = existingGroups(ctx.db, parseIds(r!.group_ids))
  let id = ''
  const tx = ctx.db.transaction(() => {
    const now = new Date(a.now()).toISOString()
    if (usernameTaken(ctx.db, b.username)) throw new UsernameTaken()
    // derived inside the transaction so a concurrent sign-up cannot take the same id
    id = deriveUserId(ctx.db, b.username, ctx.files.fx.root)
    // checked again inside the write: the maker may have been demoted, disabled or deleted during the (slow) hash
    const fresh = ctx.db.query(`SELECT ${INVITE_COLS} FROM invites WHERE id = ?`).get(r!.id) as InviteRow | null
    if (!fresh || !inviteValid(ctx.db, fresh, a.now())) return 'gone'
    // one use only, even with concurrent accepts
    const res = ctx.db.query('UPDATE invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?').run(now, id, r!.id, now)
    if (res.changes !== 1) return 'gone'
    insertUser(ctx.db, { id, username: b.username, name: b.name, passwordHash, role: r!.role, locale: b.locale ?? null, mustChangePassword: false, groupIds: groups })
    audit(ctx.db, { actor: id, action: 'invite.accept', target: r!.id, detail: { userId: id, role: r!.role, groupIds: groups } })
    return 'ok'
  })
  let ok: string
  try { ok = tx.immediate() } catch (e) {
    if (e instanceof UsernameTaken) fail('conflict', msg('usernameTaken', locale), { fields: { 'body.username': 'taken' } })
    throw e
  }
  if (ok! === 'gone') fail('gone', msg('linkInvalid', locale))
  ensurePersonalFolder(ctx.files.fx.root, id)
  return a.signIn(c, id, b.client, b.tokenMode)
}
class UsernameTaken extends Error {}

// ---------------- password reset links ----------------
export function createResetLink(ctx: AppContext, userId: string, createdBy: string | null, base: string): { token: string; url: string; expiresAt: string } {
  const token = newToken()
  const now = authOf(ctx).now()
  const expiresAt = new Date(now + RESET_TTL_MS).toISOString()
  ctx.db.transaction(() => {
    // only the newest link works
    ctx.db.query('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(new Date(now).toISOString(), userId)
    ctx.db.query('INSERT INTO password_resets (id, user_id, token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(newId(), userId, hashToken(token), createdBy, new Date(now).toISOString(), expiresAt)
    audit(ctx.db, { actor: createdBy, action: 'user.reset_link', target: userId, detail: { expiresAt, recovery: createdBy === null } })
  })()
  return { token, url: `${base}/reset-password/${token}`, expiresAt }
}

interface ResetRow { id: string; user_id: string; created_by: string | null; expires_at: string; used_at: string | null }
function resetByToken(db: Database, token: string): ResetRow | null {
  return db.query('SELECT id, user_id, created_by, expires_at, used_at FROM password_resets WHERE token_hash = ?').get(hashToken(token)) as ResetRow | null
}

/**
 * A reset link works only while its maker could still make it now: the maker is a live, active owner or admin,
 * and the person it is for is still within their reach (an admin acts on members only; nobody acts on the owner
 * through these links, tab 5). A link made by nobody (server-Mac recovery CLI) only needs a live, active target.
 * Without this, a link kept by an admin who was later disabled, demoted or deleted, or minted for a member who
 * was later made admin or owner, still signed its holder in as that person.
 */
function resetUsable(db: Database, r: ResetRow, u: UserRow | null, now: number): u is UserRow {
  if (!u || u.status !== 'active' || r.used_at || Date.parse(r.expires_at) <= now) return false
  if (r.created_by === null) return true
  const by = getUser(db, r.created_by)
  if (!by || by.status !== 'active' || by.id === u.id) return false
  if (by.role === 'owner') return u.role !== 'owner'
  if (by.role === 'admin') return u.role === 'member'
  return false
}

export function resetInfo(c: Context<AppEnv>, ctx: AppContext, token: string): PasswordResetInfo {
  const guard = tokenGuard(ctx, c.get('info').ip)
  const r = resetByToken(ctx.db, token)
  if (!r) { guard.fail(); fail('not_found') }
  const u = getUser(ctx.db, r!.user_id)
  const valid = resetUsable(ctx.db, r!, u, authOf(ctx).now())
  return valid ? { valid, username: u!.username, name: u!.name, expiresAt: r!.expires_at } : { valid: false, username: null, name: null, expiresAt: null }
}

export async function completeReset(c: Context<AppEnv>, ctx: AppContext, token: string, b: In<typeof CompletePasswordResetBody>): Promise<LoginResponse> {
  const a = authOf(ctx)
  const locale = c.get('locale')
  const guard = tokenGuard(ctx, c.get('info').ip)
  const r = resetByToken(ctx.db, token)
  if (!r) { guard.fail(); fail('not_found') }
  const u = getUser(ctx.db, r!.user_id)
  if (!resetUsable(ctx.db, r!, u, a.now())) fail('gone', msg('linkInvalid', locale))
  checkNewPassword(b.newPassword, u!.username, locale, 'body.newPassword')
  const hash = await hashPassword(b.newPassword)
  const used = ctx.db.transaction(() => {
    const now = new Date(a.now()).toISOString()
    // checked again inside the write: the maker or the person may have changed during the (slow) password hash
    const fresh = ctx.db.query('SELECT id, user_id, created_by, expires_at, used_at FROM password_resets WHERE id = ?').get(r!.id) as ResetRow | null
    if (!fresh || !resetUsable(ctx.db, fresh, getUser(ctx.db, u!.id), a.now())) return false
    if (ctx.db.query('UPDATE password_resets SET used_at = ? WHERE id = ? AND used_at IS NULL').run(now, r!.id).changes !== 1) return false
    ctx.db.query('UPDATE users SET password_hash = ?, must_change_password = 0, password_reset_by = ?, password_reset_at = ? WHERE id = ?').run(hash, r!.created_by, now, u!.id)
    audit(ctx.db, { actor: u!.id, action: 'auth.password_reset', target: u!.id, detail: { by: r!.created_by, ip: c.get('info').ip } })
    return true
  })()
  if (!used) fail('gone', msg('linkInvalid', locale))
  a.endUserSessions(u!.id, 'password_changed')
  a.limiter.clear(accountKey(u!.username))
  return a.signIn(c, u!.id, b.client, b.tokenMode)
}
