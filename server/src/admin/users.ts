// Members (admin screens "멤버·그룹", tab 5): create with a temporary password, change role / groups / status,
// delete (tombstone + personal folder handling), password reset (temporary password or one-time link), owner
// transfer. Admins never see other people's chats or memories, and there is no "sign in as" (tab 1, tab 7).
import fs from 'node:fs'
import path from 'node:path'
import type { Context } from 'hono'
import type { z } from 'zod'
import type { CreateUserBody, Locale, Role, UpdateUserBody, User } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { AppEnv } from '../http/env'
import { fail } from '../http/errors'
import { msg } from '../auth/messages'
import { hashPassword, temporaryPassword } from '../auth/passwords'
import { accountKey } from '../auth/rate-limit'
import { authOf } from '../auth/service'
import { USER_COLS, deriveUserId, ensurePersonalFolder, existingGroups, getUser, insertUser, toUser, usernameTaken, type UserRow } from '../auth/users'
import { audit } from './audit'
import { afterAccessChange, captureState, resetEngineSessions } from './folders'
import { stopTurnsOf } from '../chat/runtime'
import { getTeamSettings } from './settings'

type In<T extends z.ZodType> = z.output<T>

export function listUsers(ctx: AppContext): User[] {
  return (ctx.db.query(`SELECT ${USER_COLS} FROM users WHERE deleted_at IS NULL ORDER BY created_at, id`).all() as UserRow[]).map((r) => toUser(ctx.db, r))
}

function liveUser(ctx: AppContext, id: string): UserRow {
  const u = getUser(ctx.db, id)
  if (!u) return fail('not_found')
  return u
}

/**
 * Who may act on whom: nobody acts on the owner through these endpoints (owner transfer is separate), only the
 * owner acts on admins or makes someone admin, and nobody changes their own role / status / account here.
 */
function guard(c: Context<AppEnv>, target: UserRow, o: { self?: boolean; newRole?: Role } = {}): void {
  const auth = c.get('auth')!
  const locale = c.get('locale')
  if (target.role === 'owner') fail('forbidden', msg('notOnOwner', locale))
  if (!o.self && target.id === auth.user.id) fail('forbidden', msg('notOnSelf', locale))
  if ((target.role === 'admin' || o.newRole === 'admin') && auth.user.role !== 'owner') fail('forbidden', msg('ownerOnlyAdmins', locale))
}

function checkGroups(ctx: AppContext, ids: readonly string[], locale: Locale): string[] {
  const g = existingGroups(ctx.db, ids)
  if (g.length !== new Set(ids).size) fail('validation', msg('unknownGroups', locale), { fields: { 'body.groupIds': 'unknown group' } })
  return g
}

export async function createUser(c: Context<AppEnv>, ctx: AppContext, b: In<typeof CreateUserBody>): Promise<{ user: User; temporaryPassword: string }> {
  const auth = c.get('auth')!
  const locale = c.get('locale')
  if (b.role === 'admin' && auth.user.role !== 'owner') fail('forbidden', msg('ownerOnlyAdmins', locale))
  if (usernameTaken(ctx.db, b.username)) fail('conflict', msg('usernameTaken', locale), { fields: { 'body.username': 'taken' } })
  if (b.id && (ctx.db.query('SELECT 1 FROM users WHERE id = ?').get(b.id) || fs.existsSync(path.join(ctx.files.fx.root, 'users', b.id))))
    fail('conflict', undefined, { fields: { 'body.id': 'taken' } })
  const groups = checkGroups(ctx, b.groupIds, locale)
  const temp = temporaryPassword()
  const passwordHash = await hashPassword(temp)
  let id = ''
  try {
    // the id is derived inside the write transaction: a concurrent request (another create, an invite accepted
    // meanwhile) cannot take it between the check and the insert
    ctx.db.transaction(() => {
      if (usernameTaken(ctx.db, b.username)) throw new UniqueTaken('body.username')
      id = b.id ?? deriveUserId(ctx.db, b.username, ctx.files.fx.root)
      insertUser(ctx.db, { id, username: b.username, name: b.name, email: b.email ?? null, passwordHash, role: b.role, locale: b.locale ?? getTeamSettings(ctx.db).defaultLocale, mustChangePassword: true, groupIds: groups })
      audit(ctx.db, { actor: auth.user.id, action: 'user.create', target: id, detail: { role: b.role, groupIds: groups } })
    }).immediate()
  } catch (e) {
    if (e instanceof UniqueTaken) fail('conflict', e.field === 'body.username' ? msg('usernameTaken', locale) : undefined, { fields: { [e.field]: 'taken' } })
    if (isUniqueViolation(e)) fail('conflict', undefined, { fields: { [b.id ? 'body.id' : 'body.username']: 'taken' } })
    throw e
  }
  ensurePersonalFolder(ctx.files.fx.root, id)
  return { user: toUser(ctx.db, getUser(ctx.db, id)!), temporaryPassword: temp }
}

export function updateUser(c: Context<AppEnv>, ctx: AppContext, id: string, b: In<typeof UpdateUserBody>): User {
  const auth = c.get('auth')!
  const locale = c.get('locale')
  const target = liveUser(ctx, id)
  const changesAccount = b.role !== undefined || b.status !== undefined
  guard(c, target, { self: !changesAccount, newRole: b.role })
  const groups = b.groupIds ? checkGroups(ctx, b.groupIds, locale) : undefined
  const before = captureState(ctx.db)
  const changed: Record<string, unknown> = {}
  ctx.db.transaction(() => {
    const sets: string[] = []
    const args: (string | null)[] = []
    const set = (col: string, v: string | null, key: string) => { sets.push(`${col} = ?`); args.push(v); changed[key] = v }
    if (b.name !== undefined) set('name', b.name, 'name')
    if (b.email !== undefined) set('email', b.email, 'email')
    if (b.locale !== undefined) set('locale', b.locale, 'locale')
    if (b.role !== undefined && b.role !== target.role) set('role', b.role, 'role')
    if (b.status !== undefined && b.status !== target.status) set('status', b.status, 'status')
    if (sets.length) ctx.db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args, id)
    if (groups) {
      ctx.db.query('DELETE FROM group_members WHERE user_id = ?').run(id)
      const add = ctx.db.query('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)')
      for (const g of groups) add.run(g, id)
      changed.groupIds = groups
    }
    if (Object.keys(changed).length) audit(ctx.db, { actor: auth.user.id, action: 'user.update', target: id, detail: changed })
  })()
  if (changed.status === 'disabled') {
    authOf(ctx).endUserSessions(id, 'disabled')
    stopTurnsOf(ctx, id)
    resetEngineSessions(ctx, id)
  }
  if (changed.status === 'disabled' || changed.role === 'member') revokeInvitesBy(ctx, id)
  if (changed.role !== undefined || changed.groupIds !== undefined) afterAccessChange(ctx, before, { actor: auth.user.id, target: id })
  return toUser(ctx.db, getUser(ctx.db, id)!)
}

class UniqueTaken extends Error { constructor(public field: string) { super(field) } }
/** SQLite unique / primary key violation (a concurrent insert won). */
export const isUniqueViolation = (e: unknown) => e instanceof Error && /UNIQUE constraint failed|PRIMARY KEY/i.test(e.message)

/** Open invites made by someone who can no longer invite (deleted, disabled, no longer admin) stop working. */
export function revokeInvitesBy(ctx: AppContext, userId: string): number {
  return ctx.db.query('UPDATE invites SET revoked_at = ? WHERE created_by = ? AND used_at IS NULL AND revoked_at IS NULL').run(new Date().toISOString(), userId).changes
}

const ARCHIVE_DIR: Record<Locale, string> = { ko: '보관된 계정', en: 'Archived accounts', id: 'Akun diarsipkan' }

/**
 * Personal folder of a deleted member: 'transfer' moves users/<id>/ into the owner's personal folder (only the
 * owner sees it), without .attachments/ (chat attachments go with the chats); 'delete' removes it.
 */
function handlePersonalFolder(ctx: AppContext, id: string, how: 'transfer' | 'delete'): string | null {
  const root = ctx.files.fx.root
  const src = path.join(root, 'users', id)
  let st: fs.Stats
  try { st = fs.lstatSync(src) } catch { return null }
  if (!st.isDirectory() || st.isSymbolicLink()) return null
  if (how === 'delete') { fs.rmSync(src, { recursive: true, force: true }); return null }
  fs.rmSync(path.join(src, '.attachments'), { recursive: true, force: true })
  const owner = ctx.db.query("SELECT id FROM users WHERE role = 'owner' AND deleted_at IS NULL LIMIT 1").get() as { id: string } | null
  if (!owner) return null
  const label = ARCHIVE_DIR[getTeamSettings(ctx.db).defaultLocale]
  const ownerDir = path.join(root, 'users', owner.id)
  const dir = path.join(ownerDir, label)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  // the archive must be a real folder inside the owner's personal folder, not a link leading elsewhere
  for (const p of [ownerDir, dir]) if (!fs.lstatSync(p).isDirectory()) throw new Error(`archive folder is not a plain folder: ${p}`)
  let name = id
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${id}-${i}`
  fs.renameSync(src, path.join(dir, name))
  return ['users', owner.id, label, name].join('/')
}

export function deleteUser(c: Context<AppEnv>, ctx: AppContext, id: string, personalFolder: 'transfer' | 'delete'): void {
  const auth = c.get('auth')!
  const target = liveUser(ctx, id)
  guard(c, target)
  const before = captureState(ctx.db)
  const now = new Date(authOf(ctx).now()).toISOString()
  ctx.db.transaction(() => {
    // tombstone: the username is freed for reuse, the id (personal folder name, usage, audit) is never reused
    ctx.db.query("UPDATE users SET status = 'disabled', deleted_at = ?, username = ?, password_hash = NULL, email = NULL WHERE id = ?")
      .run(now, `${target.username}#deleted-${Date.parse(now).toString(36)}`, id)
    ctx.db.query('DELETE FROM group_members WHERE user_id = ?').run(id)
    ctx.db.query("DELETE FROM folder_rules WHERE subject_type = 'user' AND subject_id = ?").run(id)
    ctx.db.query('DELETE FROM password_resets WHERE user_id = ?').run(id)
    ctx.db.query("DELETE FROM budgets WHERE subject_type = 'user' AND subject_id = ?").run(id)
  })()
  authOf(ctx).endUserSessions(id, 'revoked')
  stopTurnsOf(ctx, id)
  resetEngineSessions(ctx, id)
  revokeInvitesBy(ctx, id)
  // the account is gone either way; a folder that could not be handled stays where it is (only nobody sees it now)
  let movedTo: string | null = null
  let folderError: string | null = null
  try { movedTo = handlePersonalFolder(ctx, id, personalFolder) } catch (e) {
    folderError = (e as Error).message
    c.get('log').error('personal folder of a deleted member was not handled', { err: e, userId: id })
  }
  audit(ctx.db, { actor: auth.user.id, action: 'user.delete', target: id, detail: { personalFolder, movedTo, ...(folderError ? { folderError } : {}) } })
  afterAccessChange(ctx, before, { actor: auth.user.id, target: id })
}

export async function resetPassword(c: Context<AppEnv>, ctx: AppContext, id: string): Promise<{ temporaryPassword: string }> {
  const auth = c.get('auth')!
  const target = liveUser(ctx, id)
  guard(c, target)
  const temp = temporaryPassword()
  const hash = await hashPassword(temp)
  const now = new Date(authOf(ctx).now()).toISOString()
  ctx.db.transaction(() => {
    ctx.db.query('UPDATE users SET password_hash = ?, must_change_password = 1, password_reset_by = ?, password_reset_at = ? WHERE id = ?').run(hash, auth.user.id, now, id)
    audit(ctx.db, { actor: auth.user.id, action: 'user.reset_password', target: id })
  })()
  authOf(ctx).endUserSessions(id, 'password_changed')
  authOf(ctx).limiter.clear(accountKey(target.username))
  return { temporaryPassword: temp }
}

/** Guard for reset links (the link itself is made in auth/accounts.ts). */
export function guardResetLink(c: Context<AppEnv>, ctx: AppContext, id: string): UserRow {
  const target = liveUser(ctx, id)
  guard(c, target)
  if (target.status !== 'active') fail('conflict', msg('accountDisabled', c.get('locale')))
  return target
}

export function transferOwnership(c: Context<AppEnv>, ctx: AppContext, userId: string): void {
  const auth = c.get('auth')!
  const locale = c.get('locale')
  if (userId === auth.user.id) fail('forbidden', msg('notOnSelf', locale))
  const target = liveUser(ctx, userId)
  if (target.status !== 'active') fail('conflict', msg('accountDisabled', locale))
  ctx.db.transaction(() => {
    ctx.db.query("UPDATE users SET role = 'admin' WHERE id = ? AND role = 'owner'").run(auth.user.id)
    ctx.db.query("UPDATE users SET role = 'owner' WHERE id = ?").run(userId)
    audit(ctx.db, { actor: auth.user.id, action: 'owner.transfer', target: userId, detail: { from: auth.user.id } })
  })()
}
