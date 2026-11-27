// User rows <-> API shapes, user ids, personal folders.
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { UserPrefs, type Locale, type Role, type User, type UserRef } from '@mycel/shared/api'
import { TEMP_PASSWORD_MAX_FAILURES } from '@mycel/shared'
import { teamDefaultLocale } from '../admin/settings'
import { guestDetail } from './guests'

export interface UserRow {
  id: string
  username: string
  name: string
  email: string | null
  password_hash: string | null
  role: Role
  status: 'active' | 'disabled'
  must_change_password: number
  locale: Locale
  /** 1 = no own choice: locale mirrors the team default (migration 102) */
  locale_follows_team: number
  prefs: string
  created_at: string
  last_seen_at: string | null
  deleted_at: string | null
  password_reset_by: string | null
  password_reset_at: string | null
  /** set while the password is a temporary one: sign-in with it is refused from then on (migration 103) */
  temp_password_expires_at: string | null
  temp_password_failures: number
}

/** The users columns of a UserRow. `role` is the role as the API knows it: a guest is stored as role 'member' with
 * users.guest = 1 (migration 122_a_guests.sql) and reads 'guest'. Never splice a table alias into it: use USER_COLS_U. */
export const USER_COLS = "id, username, name, email, password_hash, CASE WHEN guest = 1 THEN 'guest' ELSE role END AS role, status, must_change_password, locale, locale_follows_team, prefs, created_at, last_seen_at, deleted_at, password_reset_by, password_reset_at, temp_password_expires_at, temp_password_failures"
/** USER_COLS of the users table aliased `u` (a join). */
export const USER_COLS_U = "u.id, u.username, u.name, u.email, u.password_hash, CASE WHEN u.guest = 1 THEN 'guest' ELSE u.role END AS role, u.status, u.must_change_password, u.locale, u.locale_follows_team, u.prefs, u.created_at, u.last_seen_at, u.deleted_at, u.password_reset_by, u.password_reset_at, u.temp_password_expires_at, u.temp_password_failures"

/** Live (not deleted) user by id. */
export function getUser(db: Database, id: string): UserRow | null {
  return db.query(`SELECT ${USER_COLS} FROM users WHERE id = ? AND deleted_at IS NULL`).get(id) as UserRow | null
}
/** Live user by username, case-insensitive. */
export function getUserByUsername(db: Database, username: string): UserRow | null {
  return db.query(`SELECT ${USER_COLS} FROM users WHERE lower(username) = lower(?) AND deleted_at IS NULL`).get(username) as UserRow | null
}
/** how many accounts one sign-in name may stand for (accounts.ts login checks the password against each) */
export const SIGN_IN_CANDIDATES_MAX = 3
/** Who a sign-in may name: the live user with that username (case-insensitive) and, for a name with an @, the active
 * users whose e-mail is exactly that address (case-insensitive; switched-off accounts are not counted), at most
 * SIGN_IN_CANDIDATES_MAX, the username's first. A username never stands in for another person's e-mail: when both
 * match, the password decides which account it is (accounts.ts login). */
export function signInCandidates(db: Database, name: string): UserRow[] {
  const byName = getUserByUsername(db, name)
  const out: UserRow[] = byName ? [byName] : []
  if (!name.includes('@')) return out
  const rows = db.query(`SELECT ${USER_COLS} FROM users WHERE email IS NOT NULL AND lower(email) = lower(?) AND deleted_at IS NULL AND status = 'active' ORDER BY created_at, id LIMIT ?`)
    .all(name.trim(), SIGN_IN_CANDIDATES_MAX + 1) as UserRow[]
  for (const r of rows) if (out.length < SIGN_IN_CANDIDATES_MAX && !out.some((x) => x.id === r.id)) out.push(r)
  return out
}
/** A username is taken when an account has it, or has it as its e-mail (case-insensitive): a username that is someone
 * else's e-mail would take over that person's sign-in by e-mail. */
export function usernameTaken(db: Database, username: string): boolean {
  return !!db.query('SELECT 1 FROM users WHERE lower(username) = lower(?) OR (email IS NOT NULL AND deleted_at IS NULL AND lower(email) = lower(?))').get(username, username)
}

/** A free username from an e-mail address's part before @ (the first owner made with Google, auth/google-signup.ts):
 * a "+tag" dropped, only the characters of the Username rule (letters, digits, ".", "_", "-"; never "@"), lower case,
 * 2–60 characters, then made unique with -2, -3, …; `fallback` when nothing is left. The person can change it later. */
export function usernameFromEmail(db: Database, email: string | null | undefined, fallback = 'owner'): string {
  const local = (email ?? '').split('@')[0]!.split('+')[0]!
  let base = local.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '').replace(/^[._-]+|[._-]+$/g, '').toLowerCase().slice(0, 60)
  if (base.length < 2) base = fallback
  if (!usernameTaken(db, base)) return base
  for (let i = 2; i < 10_000; i++) if (!usernameTaken(db, `${base}-${i}`)) return `${base}-${i}`
  throw new Error('no free username')
}

export function userGroupIds(db: Database, id: string): string[] {
  return (db.query('SELECT group_id FROM group_members WHERE user_id = ? ORDER BY group_id').all(id) as { group_id: string }[]).map((r) => r.group_id)
}

export function parsePrefs(s: string | null | undefined) {
  try { const r = UserPrefs.safeParse(JSON.parse(s ?? '{}')); return r.success ? r.data : {} } catch { return {} }
}

export function toUser(db: Database, r: UserRow): User {
  return {
    id: r.id,
    username: r.username,
    name: r.name,
    email: r.email,
    role: r.role,
    status: r.status,
    mustChangePassword: !!r.must_change_password,
    tempPassword: r.must_change_password && r.temp_password_expires_at ? { expiresAt: r.temp_password_expires_at, voided: r.temp_password_failures >= TEMP_PASSWORD_MAX_FAILURES } : null,
    locale: r.locale,
    localeChoice: localeChoice(r),
    groupIds: userGroupIds(db, r.id),
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    // a guest: their one place and AI (the admin users list; docs/DECISIONS.md "Guests: only what they were invited to")
    ...(r.role === 'guest' ? withGuest(db, r.id) : {}),
  }
}
const withGuest = (db: Database, id: string) => { const g = guestDetail(db, id); return g ? { guest: g } : {} }

/** The person's own language, or null when they follow the team default. */
export const localeChoice = (r: Pick<UserRow, 'locale' | 'locale_follows_team'>): Locale | null => (r.locale_follows_team ? null : r.locale)

/** Set a person's language: a language of their own, or null = follow the team default from now on. */
export function setUserLocale(db: Database, id: string, choice: Locale | null): void {
  db.query('UPDATE users SET locale = ?, locale_follows_team = ? WHERE id = ?').run(choice ?? teamDefaultLocale(db), choice ? 0 : 1, id)
}

export function userRef(db: Database, id: string | null): UserRef | null {
  if (!id) return null
  const r = db.query('SELECT id, name FROM users WHERE id = ?').get(id) as { id: string; name: string } | null
  return r ? { id: r.id, name: r.name } : { id, name: id }
}

/** users.id from a username: lower-case slug [a-z0-9_-], at most 32, unique among users and existing folders. */
export function deriveUserId(db: Database, username: string, teamRoot: string, wanted?: string): string {
  let base = (wanted ?? username).toLowerCase().normalize('NFKD').replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 28)
  if (!base) base = 'user'
  const free = (id: string) => !db.query('SELECT 1 FROM users WHERE id = ?').get(id) && !fs.existsSync(path.join(teamRoot, 'users', id))
  if (free(base)) return base
  for (let i = 2; i < 10_000; i++) if (free(`${base}-${i}`)) return `${base}-${i}`
  throw new Error('no free user id')
}

/** users/<id>/ on disk (the person's personal folder, always theirs). */
export function ensurePersonalFolder(teamRoot: string, id: string): void {
  fs.mkdirSync(path.join(teamRoot, 'users', id), { recursive: true, mode: 0o700 })
}

export interface NewUser {
  id: string
  username: string
  name: string
  email?: string | null
  /** null: an account made with Google (auth/google-signup.ts), which signs in only with it until the person sets a
   * password; a password sign-in answers it like a wrong password (passwords.ts verifyPassword) */
  passwordHash: string | null
  role: Role
  /** own language, or null = follow the team default */
  locale: Locale | null
  mustChangePassword: boolean
  /** with mustChangePassword: when the temporary password stops working */
  tempPasswordExpiresAt?: string | null
  groupIds?: string[]
}

/** Insert a user (+ group memberships). Call inside a transaction when combined with other writes. */
export function insertUser(db: Database, u: NewUser, now = new Date().toISOString()): void {
  db.query(`INSERT INTO users (id, username, name, email, password_hash, role, status, must_change_password, temp_password_expires_at, locale, locale_follows_team, prefs, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, '{}', ?)`).run(u.id, u.username, u.name, u.email ?? null, u.passwordHash, u.role, u.mustChangePassword ? 1 : 0, u.mustChangePassword ? (u.tempPasswordExpiresAt ?? null) : null, u.locale ?? teamDefaultLocale(db), u.locale ? 0 : 1, now)
  const add = db.query('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)')
  for (const g of u.groupIds ?? []) add.run(g, u.id)
}

/** Ids from `ids` that are existing groups (in order). */
export function existingGroups(db: Database, ids: readonly string[]): string[] {
  if (!ids.length) return []
  const found = new Set((db.query(`SELECT id FROM groups WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { id: string }[]).map((r) => r.id))
  return [...new Set(ids)].filter((id) => found.has(id))
}
