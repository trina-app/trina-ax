// Members (admin screens "멤버·그룹", tab 5): create with a temporary password, change role / groups / status,
// delete (tombstone + personal folder handling), password reset (temporary password or one-time link), owner
// transfer. Admins never see other people's chats or memories, and there is no "sign in as" (tab 1, tab 7).
import fs from 'node:fs'
import { projectJoinsOfNewAccount } from '../chat/project-joins'
import path from 'node:path'
import type { Context } from 'hono'
import type { z } from 'zod'
import { tempPasswordCharsOk } from '@mycel/shared'
import type { CreateUserBody, EndedConnection, HandoverConnectionRef, Locale, ResetPasswordBody, Role, UpdateUserBody, User } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { AppEnv } from '../http/env'
import { fail } from '../http/errors'
import { linkBase, revokeResetLinksFor, tempPasswordExpiry } from '../auth/accounts'
import { msg, weakPasswordMessage } from '../auth/messages'
import { hashPassword, passwordProblem, temporaryPassword } from '../auth/passwords'
import { authOf } from '../auth/service'
import { assertSeatFree } from '../system/limits'
import { USER_COLS, deriveUserId, ensurePersonalFolder, existingGroups, getUser, insertUser, setUserLocale, toUser, usernameTaken, type UserRow } from '../auth/users'
import { audit } from './audit'
import { cancelLoginsOf } from '../credentials/login'
import { existingCredentialsOf } from '../credentials/store'
import { afterAccessChange, captureState, foldersWithRuleOf, keepProjectFloors, resetEngineSessions } from './folders'
import { stopTurnsOf } from '../chat/runtime'
import { getTeamSettings, LOCALE_CHANGED } from './settings'
import { revokeTeamLinksBy } from '../auth/team-links'
import { dropAdminScope } from '../connectors/remote-mcp/oauth'
import { integrationsOf } from '../integrations/connections/service'
import { syncRoomsNow } from '../rooms/service'
import { closeDeletionRequest } from '../auth/deletion-requests'
import { notificationsOf, notifyTemplateOffers, settleDeletionRequestNotices } from '../notifications/service'
import { recordJoin } from '../onboarding/member-welcome'
import { newId } from '../db'
import { endConnections, handoverText, recordEnded, setRecoveryLockIn, tellTransfer, toEndOf } from './handover'
import { componentC } from '../team-files/component'
import { afterPrune, pruneAssignments, type Pruned } from '../credentials/assignees'
import { liveStatusOf, statusGoneWithAccount } from '../auth/status-messages'
import { accountDeactivated } from '../tools/web-allow-all'

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
function guard(c: Context<AppEnv>, target: UserRow, o: { self?: boolean; newRole?: Role; actor?: { id: string; role: Role } } = {}): void {
  // `actor`: who acts, read again from the database (the session's copy may be older)
  const auth = o.actor ? { user: o.actor } : c.get('auth')!
  const locale = c.get('locale')
  if (target.role === 'owner') fail('forbidden', msg('notOnOwner', locale))
  if (!o.self && target.id === auth.user.id) fail('forbidden', msg('notOnSelf', locale))
  if ((target.role === 'admin' || o.newRole === 'admin') && auth.user.role !== 'owner') fail('forbidden', msg('ownerOnlyAdmins', locale))
}

/** Who acts, read again inside a write: an owner or admin who changed role (a transfer that just committed), was
 * disabled or deleted since the request started is what decides now, not the session's copy (security review of
 * 팀장 넘기기: a reset landing on someone who became the owner meanwhile). */
function actorNow(ctx: AppContext, id: string): { id: string; role: Role } {
  const row = ctx.db.query('SELECT id, role, status, deleted_at FROM users WHERE id = ?').get(id) as { id: string; role: Role; status: string; deleted_at: string | null } | null
  if (!row || row.deleted_at || row.status !== 'active' || (row.role !== 'owner' && row.role !== 'admin')) return fail('forbidden')
  return { id: row.id, role: row.role }
}

/** The temporary password an admin typed (or the form pre-filled), checked like any new password; none = make one. */
function temporaryFor(c: Context<AppEnv>, given: string | undefined, username: string): string {
  if (given === undefined) return temporaryPassword()
  if (!tempPasswordCharsOk(given)) fail('validation', msg('tempPasswordChars', c.get('locale')), { fields: { 'body.temporaryPassword': 'letters, digits and symbols only' } })
  const p = passwordProblem(given, { username })
  if (p) fail('validation', weakPasswordMessage(p, c.get('locale')), { fields: { 'body.temporaryPassword': p } })
  return given
}

function checkGroups(ctx: AppContext, ids: readonly string[], locale: Locale): string[] {
  const g = existingGroups(ctx.db, ids)
  if (g.length !== new Set(ids).size) fail('validation', msg('unknownGroups', locale), { fields: { 'body.groupIds': 'unknown group' } })
  return g
}

export async function createUser(c: Context<AppEnv>, ctx: AppContext, b: In<typeof CreateUserBody>): Promise<{ user: User; temporaryPassword: string; expiresAt?: string; signInUrl: string }> {
  const auth = c.get('auth')!
  const locale = c.get('locale')
  if (b.role === 'admin' && auth.user.role !== 'owner') fail('forbidden', msg('ownerOnlyAdmins', locale))
  if (usernameTaken(ctx.db, b.username)) fail('conflict', msg('usernameTaken', locale), { fields: { 'body.username': 'taken' } })
  if (b.id && (ctx.db.query('SELECT 1 FROM users WHERE id = ?').get(b.id) || fs.existsSync(path.join(ctx.files.fx.root, 'users', b.id))))
    fail('conflict', undefined, { fields: { 'body.id': 'taken' } })
  const groups = checkGroups(ctx, b.groupIds, locale)
  const temp = temporaryFor(c, b.temporaryPassword, b.username)
  const passwordHash = await hashPassword(temp)
  let id = ''
  try {
    // the id is derived inside the write transaction: a concurrent request (another create, an invite accepted
    // meanwhile) cannot take it between the check and the insert
    ctx.db.transaction(() => {
      if (usernameTaken(ctx.db, b.username)) throw new UniqueTaken('body.username')
      assertSeatFree(ctx.db, locale) // the plan's seats (system/limits.ts), inside the write
      id = b.id ?? deriveUserId(ctx.db, b.username, ctx.files.fx.root)
      insertUser(ctx.db, { id, username: b.username, name: b.name, email: b.email ?? null, passwordHash, role: b.role, locale: b.locale ?? null, mustChangePassword: true, tempPasswordExpiresAt: tempPasswordExpiry(authOf(ctx).now()), groupIds: groups })
      audit(ctx.db, { actor: auth.user.id, action: 'user.create', target: id, detail: { role: b.role, groupIds: groups } })
    }).immediate()
  } catch (e) {
    if (e instanceof UniqueTaken) fail('conflict', e.field === 'body.username' ? msg('usernameTaken', locale) : undefined, { fields: { [e.field]: 'taken' } })
    if (isUniqueViolation(e)) fail('conflict', undefined, { fields: { [b.id ? 'body.id' : 'body.username']: 'taken' } })
    throw e
  }
  ensurePersonalFolder(ctx.files.fx.root, id)
  // their welcome card, with no inviter; connection template notices wait until they open Connected apps. The everyone
  // room's joined line and the owners' notice wait for their first sign-in: until then they have not joined
  // (onboarding/member-welcome.ts firstSignIn; docs/DECISIONS.md "A welcome for invited people")
  recordJoin(ctx, { userId: id, via: 'admin', invitedBy: null, addedBy: auth.user.id })
  // team projects this new person sees through their groups: audited, their members told (chat/project-joins.ts)
  if (groups.length) projectJoinsOfNewAccount(ctx, id, auth.user.id, captureState(ctx.db))
  // connection templates this new person is in (security review 2, #1: on the event, not only the 30-second pass)
  notifyTemplateOffers(ctx, { userId: id })
  const user = toUser(ctx.db, getUser(ctx.db, id)!)
  return { user, temporaryPassword: temp, expiresAt: user.tempPassword?.expiresAt, signInUrl: linkBase(c, ctx) }
}

export function updateUser(c: Context<AppEnv>, ctx: AppContext, id: string, b: In<typeof UpdateUserBody>): User {
  const auth = c.get('auth')!
  const locale = c.get('locale')
  const target = liveUser(ctx, id)
  const changesAccount = b.role !== undefined || b.status !== undefined
  guard(c, target, { self: !changesAccount, newRole: b.role })
  const groups = b.groupIds ? checkGroups(ctx, b.groupIds, locale) : undefined
  // a disabled account that stays off joins no new group (admin/groups.ts checkMembers: its access is not counted while
  // it is off); one enabled in the same change may
  if (groups && target.status !== 'active' && b.status !== 'active') {
    const had = new Set((ctx.db.query('SELECT group_id FROM group_members WHERE user_id = ?').all(id) as { group_id: string }[]).map((g) => g.group_id))
    if (groups.some((g) => !had.has(g))) fail('validation', msg('switchedOffNoGroups', locale), { fields: { 'body.groupIds': 'disabled account' }, params: { reason: 'account_disabled' } })
  }
  const before = captureState(ctx.db)
  const changed: Record<string, unknown> = {}
  ctx.db.transaction(() => {
    // the caller and the target as they are now (an owner who handed the team over a moment ago is an admin; a member
    // made owner meanwhile is out of reach)
    guard(c, liveUser(ctx, id), { self: !changesAccount, newRole: b.role, actor: actorNow(ctx, auth.user.id) })
    // enabling a disabled account takes a seat again (system/limits.ts; disabled accounts do not count)
    if (b.status === 'active' && target.status !== 'active') assertSeatFree(ctx.db, locale)
    const sets: string[] = []
    const args: (string | null)[] = []
    const set = (col: string, v: string | null, key: string) => { sets.push(`${col} = ?`); args.push(v); changed[key] = v }
    if (b.name !== undefined) set('name', b.name, 'name')
    if (b.email !== undefined) set('email', b.email, 'email')
    if (b.role !== undefined && b.role !== target.role) set('role', b.role, 'role')
    if (b.status !== undefined && b.status !== target.status) set('status', b.status, 'status')
    if (sets.length) ctx.db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args, id)
    // their own open reset links end with the account (and stay ended if it is enabled again), and with a new role: a
    // link the owner or the server Mac made for a member would otherwise sign its holder in as the new admin
    if (changed.status === 'disabled' || changed.role !== undefined) revokeResetLinksFor(ctx.db, id, authOf(ctx).now())
    // null = follow the team default again
    if (b.locale !== undefined) { setUserLocale(ctx.db, id, b.locale); changed.locale = b.locale }
    if (groups) {
      ctx.db.query('DELETE FROM group_members WHERE user_id = ?').run(id)
      const add = ctx.db.query('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)')
      for (const g of groups) add.run(g, id)
      changed.groupIds = groups
    }
    if (Object.keys(changed).length) audit(ctx.db, { actor: auth.user.id, action: 'user.update', target: id, detail: changed })
  }).immediate()
  // asked-for deletions they no longer handle (demoted), or that are now only the owner's (a member made an admin)
  if (changed.role === 'member') try { notificationsOf(ctx).forgetDeletionNotices({ userId: id }) } catch { /* the inbox row ages out */ }
  if (changed.role === 'admin') try { notificationsOf(ctx).forgetDeletionNotices({ requesterId: id }) } catch { /* the inbox row ages out */ }
  // the person's open windows ask for their language again (GET /api/me) and switch without a reload
  if (changed.locale !== undefined) ctx.services.realtime.publish(id, LOCALE_CHANGED)
  // disabled or enabled again: nothing buffered under the earlier state is replayed (group / rule changes made while
  // the account was disabled never reached afterAccessChange for them)
  if (changed.status !== undefined) ctx.services.realtime.forgetReplay(id)
  // their status message (docs/DECISIONS.md "상태 메시지") is the team's only while the account is on: open windows read
  // the directory again when it goes or comes back with the account
  if (changed.status !== undefined) statusGoneWithAccount(ctx, !!liveStatusOf(ctx.db, id, new Date(), true))
  if (changed.status === 'disabled') {
    // their "Allow all websites" for the AI's web reads goes off for good (audited when it was on)
    accountDeactivated(ctx.db, id, auth.user.id)
    authOf(ctx).endUserSessions(id, 'disabled')
    stopTurnsOf(ctx, id)
    resetEngineSessions(ctx, id)
  }
  // their running AI sign-ins: disabled, all of them; made a member, the team's (their own personal ones are theirs to keep)
  if (changed.status === 'disabled' || changed.role === 'member') { const cc = existingCredentialsOf(ctx); if (cc) cancelLoginsOf(cc, id, { teamOnly: changed.status !== 'disabled' }) }
  if (changed.status === 'disabled' || changed.role === 'member') { revokeInvitesBy(ctx, id); revokeResetLinksBy(ctx, id); revokeTeamLinksBy(ctx, id) }
  // their AI apps' group management (connector scope mcp:admin) ends for good, like their invites
  if (changed.status === 'disabled' || changed.role === 'member') dropAdminScope(ctx.db, id, changed.role === 'member' ? 'role' : 'status', auth.user.id)
  // enabled again: whatever it reads now counts from here (captureState holds active accounts only), so the team projects
  // it gets back are recorded and their members told like any other join (chat/project-joins.ts; docs/DECISIONS.md
  // "Project contents only for members")
  if (changed.role !== undefined || changed.groupIds !== undefined || changed.status === 'active') afterAccessChange(ctx, before, { actor: auth.user.id, target: id, ...(changed.status === 'active' ? { via: 'account' } : {}) })
  // disabled: out of the team rooms and the everyone room now; enabled again: back in, seeing messages from now on
  // (afterAccessChange syncs the rooms too, so only a status change on its own needs this)
  else if (changed.status !== undefined) syncRoomsNow(ctx)
  // enabled again, or new groups: templates that now reach them are offered at once
  if (changed.status === 'active' || changed.groupIds !== undefined) notifyTemplateOffers(ctx, { userId: id })
  return toUser(ctx.db, getUser(ctx.db, id)!)
}

class UniqueTaken extends Error { constructor(public field: string) { super(field) } }
/** SQLite unique / primary key violation (a concurrent insert won). */
export const isUniqueViolation = (e: unknown) => e instanceof Error && /UNIQUE constraint failed|PRIMARY KEY/i.test(e.message)

/**
 * Open invites made by someone who can no longer invite (deleted, disabled, no longer admin) stop working; with
 * `role`, only the invites of that role (an owner who became admin keeps their member invites, not admin ones).
 */
export function revokeInvitesBy(ctx: AppContext, userId: string, role?: 'admin' | 'member'): number {
  const now = new Date().toISOString()
  const open = 'UPDATE invites SET revoked_at = ? WHERE created_by = ? AND used_at IS NULL AND revoked_at IS NULL'
  return (role ? ctx.db.query(`${open} AND role = ?`).run(now, userId, role) : ctx.db.query(open).run(now, userId)).changes
}

/**
 * Open password reset links made by someone who can no longer make them (deleted, disabled, no longer admin) stop
 * working, like their invites: such a link signs its holder in as the member, so an ex-admin who kept one could
 * otherwise take the account over. Links made by nobody (server-Mac recovery, created_by NULL) are not touched.
 * Marked used rather than deleted, so re-enabling the maker does not bring them back.
 */
export function revokeResetLinksBy(ctx: AppContext, userId: string): number {
  return ctx.db.query('UPDATE password_resets SET used_at = ? WHERE created_by = ? AND used_at IS NULL').run(new Date().toISOString(), userId).changes
}

export const ARCHIVE_DIR: Record<Locale, string> = { ko: '보관된 계정', en: 'Archived accounts', id: 'Akun diarsipkan', ja: "アーカイブ済みアカウント", es: "Cuentas archivadas" }

/**
 * Personal folder of a deleted member: 'transfer' moves users/<id>/ into the owner's personal folder (only the
 * owner sees it), without .attachments/ (chat attachments go with the chats), the way a move on the Files screen does
 * (version history, projects and the text cache follow it: team-files/service.ts archiveFolder); 'delete' removes it.
 */
function handlePersonalFolder(ctx: AppContext, id: string, how: 'transfer' | 'delete', actorId: string): string | null {
  const root = ctx.files.fx.root
  const src = path.join(root, 'users', id)
  let st: fs.Stats
  try { st = fs.lstatSync(src) } catch { return null }
  if (!st.isDirectory() || st.isSymbolicLink()) return null
  if (how === 'delete') { fs.rmSync(src, { recursive: true, force: true }); return null }
  const owner = ctx.db.query("SELECT id FROM users WHERE role = 'owner' AND deleted_at IS NULL LIMIT 1").get() as { id: string } | null
  if (!owner) { fs.rmSync(path.join(src, '.attachments'), { recursive: true, force: true }); return null }
  const label = ARCHIVE_DIR[getTeamSettings(ctx.db).defaultLocale]
  const ownerDir = path.join(root, 'users', owner.id)
  const dir = path.join(ownerDir, label)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  // the archive must be a real folder inside the owner's personal folder, not a link leading elsewhere
  for (const p of [ownerDir, dir]) if (!fs.lstatSync(p).isDirectory()) throw new Error(`archive folder is not a plain folder: ${p}`)
  // a name free on disk and in the database (a folders row or a project an earlier archive left at or under that path:
  // the move refuses to land on either)
  const rel = (n: string) => ['users', owner.id, label, n].join('/')
  const under = (col: string) => `${col} = ? OR substr(${col}, 1, length(?) + 1) = ? || '/'`
  const taken = (n: string) => fs.existsSync(path.join(dir, n))
    || !!ctx.db.query(`SELECT 1 FROM folders WHERE ${under('path')}`).get(rel(n), rel(n), rel(n))
    || !!ctx.db.query(`SELECT 1 FROM projects WHERE trashed_with IS NULL AND (${under('folder_path')})`).get(rel(n), rel(n), rel(n))
  let name = id
  for (let i = 2; taken(name); i++) name = `${id}-${i}`
  componentC(ctx).files.archiveFolder(actorId, `users/${id}`, rel(name))
  return rel(name)
}

export async function deleteUser(c: Context<AppEnv>, ctx: AppContext, id: string, personalFolder: 'transfer' | 'delete', password?: string): Promise<void> {
  const auth = c.get('auth')!
  const locale = c.get('locale')
  // the owner deletes anyone but themselves; an admin deletes a plain member only (never the owner, another admin or
  // themselves: guard), and types their password again first. The contract says so too: this is the second check
  if (auth.user.role !== 'owner' && auth.user.role !== 'admin') fail('forbidden')
  const first = liveUser(ctx, id)
  guard(c, first)
  let passwordChecked = false
  if (auth.user.role === 'admin') {
    if (typeof password !== 'string' || !(await ctx.services.sessions.verifyPassword(auth.user.id, password, c.get('info')))) {
      fail('forbidden', msg('wrongPassword', locale), { fields: { 'body.password': 'wrong password' } })
    }
    passwordChecked = true
  }
  // the password check above waited: read the person again, and once more inside the transaction below, so what
  // decides is what they are at the moment of the delete (a member promoted to admin meanwhile is refused)
  const target = liveUser(ctx, id)
  guard(c, target)
  const before = captureState(ctx.db)
  const now = new Date(authOf(ctx).now()).toISOString()
  // their sign-ins at services through connections made from templates: read now, the services told after the delete
  let revokeSignIns = () => {}
  try { revokeSignIns = integrationsOf(ctx).signInsToRevoke(id) } catch (e) { c.get('log').warn('sign-ins of a deleted member could not be read for revoking', { err: e, userId: id }) }
  let requested = false
  let pruned: Pruned[] = []
  let ownAi: string[] = []
  let hadStatus = false
  ctx.db.transaction(() => {
    // who acts is read again too: an admin demoted (or disabled, or deleted) while the password was checked is nobody
    const row = ctx.db.query('SELECT id, role, status, deleted_at FROM users WHERE id = ?').get(auth.user.id) as { id: string; role: Role; status: string; deleted_at: string | null } | null
    if (!row) return fail('forbidden')
    if (row.deleted_at || row.status !== 'active' || (row.role !== 'owner' && row.role !== 'admin')) fail('forbidden')
    // an admin by now who was not asked for the password (they were the owner at the start) is refused too
    if (row.role === 'admin' && !passwordChecked) fail('forbidden', msg('wrongPassword', locale), { fields: { 'body.password': 'wrong password' } })
    guard(c, liveUser(ctx, id), { actor: { id: row.id, role: row.role } })
    // their "Allow all websites" for the AI's web reads goes off (audited when it was on)
    accountDeactivated(ctx.db, id, auth.user.id)
    // tombstone: the username is freed for reuse, the id (personal folder name, usage, audit) is never reused
    ctx.db.query("UPDATE users SET status = 'disabled', deleted_at = ?, username = ?, password_hash = NULL, email = NULL WHERE id = ?")
      .run(now, `${target.username}#deleted-${Date.parse(now).toString(36)}`, id)
    ctx.db.query('DELETE FROM group_members WHERE user_id = ?').run(id)
    // their rules go; a project folder in projects/ keeps "everyone: none" when they were its last rule (the creator of a
    // project nobody else was added to: it fails closed to the owner and admins)
    const ruled = foldersWithRuleOf(ctx.db, 'user', id)
    ctx.db.query("DELETE FROM folder_rules WHERE subject_type = 'user' AND subject_id = ?").run(id)
    keepProjectFloors(ctx.db, ruled, auth.user.id)
    ctx.db.query('DELETE FROM password_resets WHERE user_id = ?').run(id)
    ctx.db.query("DELETE FROM budgets WHERE subject_type = 'user' AND subject_id = ?").run(id)
    // external-service connections: their own go with them (keys included), and they leave team connections' rules
    ctx.db.query("DELETE FROM integrations WHERE scope = 'personal' AND owner_user_id = ?").run(id)
    ctx.db.query("DELETE FROM integration_access WHERE subject_type = 'user' AND subject_id = ?").run(id)
    // and templates' rules (an id nobody can see any more would block every later change of that rule)
    ctx.db.query("DELETE FROM integration_template_access WHERE subject_type = 'user' AND subject_id = ?").run(id)
    ctx.db.query("DELETE FROM drive_team_share_access WHERE subject_type = 'user' AND subject_id = ?").run(id)
    // their own AI connections (tokens and keys included) go with them, like their own service connections; team
    // connections assigned to them lose that row, and one left with no group or person is switched off, not team-wide
    ownAi = (ctx.db.query('SELECT id FROM engine_credentials WHERE owner_user_id = ?').all(id) as { id: string }[]).map((r) => r.id)
    ctx.db.query('DELETE FROM engine_credentials WHERE owner_user_id = ?').run(id)
    pruned = pruneAssignments(ctx.db, auth.user.id, now)
    // their photo, title and status: the users row stays as a tombstone, so the profile's cascade never runs
    ctx.db.query('DELETE FROM user_profiles WHERE user_id = ?').run(id)
    // their status message (auth/status-messages.ts), for the same reason; the team is told below when it saw one
    hadStatus = !!liveStatusOf(ctx.db, id, new Date(), true)
    ctx.db.query('DELETE FROM user_status_messages WHERE user_id = ?').run(id)
    // their pinned chats (chat/pins.ts) and conversations (rooms/service.ts pin; a DM keeps their member row), for the
    // same reason
    ctx.db.query('DELETE FROM chat_pins WHERE user_id = ?').run(id)
    ctx.db.query('DELETE FROM room_pins WHERE user_id = ?').run(id)
    // the person had asked for this (Settings › Profile › 계정 삭제 요청): the request is handled
    requested = closeDeletionRequest(ctx, id, auth.user.id, now)
  })()
  revokeSignIns()
  statusGoneWithAccount(ctx, hadStatus)
  { const cc = existingCredentialsOf(ctx); if (cc) for (const k of ownAi) cc.cache.delete(k) }
  afterPrune(ctx, auth.user.id, pruned)
  if (requested) settleDeletionRequestNotices(ctx, id)
  authOf(ctx).endUserSessions(id, 'revoked')
  stopTurnsOf(ctx, id)
  resetEngineSessions(ctx, id)
  revokeInvitesBy(ctx, id)
  revokeResetLinksBy(ctx, id)
  revokeTeamLinksBy(ctx, id)
  // an AI sign-in they were in the middle of (theirs, team or personal) ends with the account
  { const cc = existingCredentialsOf(ctx); if (cc) cancelLoginsOf(cc, id, { teamOnly: false }) }
  // the account is gone either way; a folder that could not be handled stays where it is (only nobody sees it now)
  let movedTo: string | null = null
  let folderError: string | null = null
  try { movedTo = handlePersonalFolder(ctx, id, personalFolder, auth.user.id) } catch (e) {
    folderError = (e as Error).message
    c.get('log').error('personal folder of a deleted member was not handled', { err: e, userId: id })
  }
  const off = pruned.filter((p) => p.switchedOff).map((p) => ({ id: p.id, label: p.label }))
  audit(ctx.db, { actor: auth.user.id, action: 'user.delete', target: id, detail: {
    personalFolder, movedTo, ...(folderError ? { folderError } : {}), ...(requested ? { requested: true } : {}), ...(off.length ? { aiConnectionsOff: off } : {}), ...(ownAi.length ? { ownAiConnections: ownAi.length } : {}),
  } })
  afterAccessChange(ctx, before, { actor: auth.user.id, target: id })
}

export async function resetPassword(c: Context<AppEnv>, ctx: AppContext, id: string, b: In<typeof ResetPasswordBody> = {}): Promise<{ temporaryPassword: string; expiresAt: string; signInUrl: string }> {
  const auth = c.get('auth')!
  const target = liveUser(ctx, id)
  guard(c, target)
  const temp = temporaryFor(c, b.temporaryPassword, target.username)
  const hash = await hashPassword(temp)
  const nowMs = authOf(ctx).now()
  const now = new Date(nowMs).toISOString()
  const expiresAt = tempPasswordExpiry(nowMs)
  ctx.db.transaction(() => {
    // read again after the (slow) hash: a target who became the owner or an admin meanwhile (a transfer committing now),
    // or a caller who is no longer allowed, is refused, so a temporary password never lands on the new owner
    guard(c, liveUser(ctx, id), { actor: actorNow(ctx, auth.user.id) })
    ctx.db.query('UPDATE users SET password_hash = ?, must_change_password = 1, temp_password_expires_at = ?, temp_password_failures = 0, password_reset_by = ?, password_reset_at = ? WHERE id = ?').run(hash, expiresAt, auth.user.id, now, id)
    // a reset link sent earlier (maybe to the wrong place) stops working: the admin chose a temporary password instead
    revokeResetLinksFor(ctx.db, id, nowMs)
    audit(ctx.db, { actor: auth.user.id, action: 'user.reset_password', target: id })
  }).immediate()
  authOf(ctx).endUserSessions(id, 'password_changed')
  authOf(ctx).limiter.clearAccount(target.username)
  return { temporaryPassword: temp, expiresAt, signInUrl: linkBase(c, ctx) }
}

/** Guard for reset links (the link itself is made in auth/accounts.ts). */
export function guardResetLink(c: Context<AppEnv>, ctx: AppContext, id: string): UserRow {
  const target = liveUser(ctx, id)
  guard(c, target)
  if (target.status !== 'active') fail('conflict', msg('accountDisabled', c.get('locale')))
  return target
}

/**
 * 팀장 넘기기 (docs/DECISIONS.md "W6"; admin/handover.ts). The password was checked by the route (owner-reauth: 5 wrong
 * tries per 15 minutes) before this runs. Everything that decides is read again inside one `.immediate()` write, so two
 * transfers at once can never leave two owners (security review S1: the role check ran before two awaits, and the
 * swap never looked at what it changed):
 *   - the caller is still the active owner, the target an active non-owner who changed their temporary password and
 *     signed in at least once (an expiring temporary password would strand the team: nobody can reset an owner);
 *   - the demote and the promote must each change exactly one row; anything else rolls back with 409 owner_changed.
 * In the same write: the ex-owner's admin invites stop (an admin may not make them), every lead flag is cleared (used
 * or not: no card is left urging a handover to someone the old owner picked), the transfer is recorded with where it
 * came from (`via`: lead_card when the target joined with this owner's lead link, decided here, never by the client),
 * and on a hosted team with handoverSafe the recovery lock is set (system/cli.ts reset-link). After the commit: the
 * access change is applied, the connections the caller asked to end are ended (each on its own; a failure never undoes
 * the transfer), and both people, the other admins and their open windows are told.
 * Sessions are not ended: the role is read on every request (auth/service.ts resolve).
 */
export async function transferOwnership(c: Context<AppEnv>, ctx: AppContext, b: { userId: string; end?: readonly HandoverConnectionRef[] }): Promise<{ ok: true; ended: EndedConnection[] }> {
  const auth = c.get('auth')!
  const locale = c.get('locale')
  const me = auth.user.id
  if (b.userId === me) fail('forbidden', msg('notOnSelf', locale))
  const changedMeanwhile = () => fail('conflict', handoverText('ownerChanged', locale), { params: { reason: 'owner_changed' } })
  const ready = (t: UserRow) => {
    if (t.status !== 'active') fail('conflict', msg('accountDisabled', locale))
    if (t.role === 'owner') changedMeanwhile()
    if (t.must_change_password || !t.last_seen_at) fail('conflict', handoverText('targetNotReady', locale), { params: { reason: 'target_not_ready' } })
  }
  ready(liveUser(ctx, b.userId))
  const before = captureState(ctx.db)
  const at = new Date(authOf(ctx).now()).toISOString()
  const transferId = newId()
  let via: 'lead_card' | 'members_menu' = 'members_menu'
  let toEnd: { kind: HandoverConnectionRef['kind']; id: string; label: string }[] = []
  ctx.db.transaction(() => {
    const caller = ctx.db.query('SELECT role, status, deleted_at FROM users WHERE id = ?').get(me) as { role: Role; status: string; deleted_at: string | null } | null
    if (!caller || caller.deleted_at || caller.status !== 'active' || caller.role !== 'owner') changedMeanwhile()
    ready(liveUser(ctx, b.userId))
    const lead = ctx.db.query('SELECT id FROM invites WHERE lead_hint = 1 AND lead_hint_by = ? AND used_by = ? AND used_at IS NOT NULL LIMIT 1').get(me, b.userId) as { id: string } | null
    if (lead) via = 'lead_card'
    // Each update targets one id, so it changes one row or none. `changes` is not compared with 1: the users table has
    // AFTER UPDATE triggers (safe_ops_policy), and Bun 1.3 counts their rows too (2 here), Bun 1.4 does not. So none
    // means someone changed it meanwhile, and the end state is checked directly: exactly one owner, the target.
    if (ctx.db.query("UPDATE users SET role = 'admin' WHERE id = ? AND role = 'owner' AND status = 'active' AND deleted_at IS NULL").run(me).changes < 1) changedMeanwhile()
    if (ctx.db.query("UPDATE users SET role = 'owner' WHERE id = ? AND role != 'owner' AND status = 'active' AND deleted_at IS NULL AND must_change_password = 0").run(b.userId).changes < 1) changedMeanwhile()
    const owners = ctx.db.query("SELECT id FROM users WHERE role = 'owner' AND deleted_at IS NULL").all() as { id: string }[]
    if (owners.length !== 1 || owners[0]!.id !== b.userId) changedMeanwhile()
    // the ex-owner is now an admin, who may not make admin invites: the ones made while owner die with that power
    // (their member invites stay: an admin may still make those). Reset links need nothing here: resetUsable
    // already limits an admin's links to members, so those made for admins or the new owner stop working.
    const revoked = revokeInvitesBy(ctx, me, 'admin')
    // the lead link is over with the handover: an open one stops (its message promised a handover by someone who is no
    // longer the owner), and every flag goes, used or not (no card left urging a handover to someone the old owner picked)
    const leadsStopped = ctx.db.query('UPDATE invites SET revoked_at = ? WHERE lead_hint = 1 AND used_at IS NULL AND revoked_at IS NULL').run(at).changes
    const unflagged = ctx.db.query('UPDATE invites SET lead_hint = 0 WHERE lead_hint = 1').run().changes
    // reset links made by nobody (the server's CLI, the hosted control plane) for either person stop: one minted before
    // the handover must not sign its holder in as the new owner, or as the old owner now an admin, afterwards
    const cliLinks = ctx.db.query('UPDATE password_resets SET used_at = ? WHERE created_by IS NULL AND used_at IS NULL AND user_id IN (?, ?)').run(at, me, b.userId).changes
    // what to end of the caller's own connections is kept with the transfer, in this write: a stop right after the
    // commit cannot leave the old owner's tokens serving the team unnoticed (retried at the server's start; the new
    // owner sees what is left and can end it from the Inbox)
    toEnd = b.end?.length ? toEndOf(ctx, me, b.end) : []
    ctx.db.query('INSERT INTO owner_transfers (id, from_user, to_user, via, invite_id, at, to_end) VALUES (?, ?, ?, ?, ?, ?, ?)').run(transferId, me, b.userId, via, lead?.id ?? null, at, JSON.stringify(toEnd))
    const locked = setRecoveryLockIn(ctx, transferId, at)
    audit(ctx.db, { actor: me, action: 'owner.transfer', target: b.userId, detail: { from: me, to: b.userId, via, ...(revoked ? { adminInvitesRevoked: revoked } : {}), ...(unflagged ? { leadHintsCleared: unflagged } : {}), ...(leadsStopped ? { leadInvitesRevoked: leadsStopped } : {}), ...(cliLinks ? { recoveryLinksStopped: cliLinks } : {}), ...(locked ? { recoveryLocked: true } : {}) } })
  }).immediate()
  // what an owner or admin handles in the account-deletion inbox follows the roles (the reconcile pass gives each
  // their entries again: an admin only the members')
  try { notificationsOf(ctx).forgetDeletionNotices({ userId: me }) } catch { /* the inbox row ages out */ }
  try { notificationsOf(ctx).forgetDeletionNotices({ requesterId: b.userId }) } catch { /* the inbox row ages out */ }
  // committed: nothing below may turn it into an error. Access first, then both people and the admins are told (their
  // windows refresh their role), then the slow part: the connections asked to be ended (Google is called for a share)
  try { afterAccessChange(ctx, before, { actor: me, target: b.userId }) } catch (err) { c.get('log').error('access change after a handover failed', { err }) }
  const t = { id: transferId, from: me, to: b.userId }
  tellTransfer(ctx, t)
  let ended: EndedConnection[] = []
  try { ended = toEnd.length ? await endConnections(ctx, me, toEnd) : [] } catch (err) { c.get('log').error('ending connections after a handover failed', { err }) }
  recordEnded(ctx, t, ended)
  return { ok: true, ended }
}
