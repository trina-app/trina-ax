// User rows <-> API shapes, user ids, personal folders.
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { UserPrefs, type Locale, type Role, type User, type UserRef } from '@mycel/shared/api'
import { TEMP_PASSWORD_MAX_FAILURES } from '@mycel/shared'
import { teamDefaultLocale } from '../admin/settings'

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

export const USER_COLS = 'id, username, name, email, password_hash, role, status, must_change_password, locale, locale_follows_team, prefs, created_at, last_seen_at, deleted_at, password_reset_by, password_reset_at, temp_password_expires_at, temp_password_failures'

/** Live (not deleted) user by id. */
export function getUser(db: Database, id: string): UserRow | null {
  return db.query(`SELECT ${USER_COLS} FROM users WHERE id = ? AND deleted_at IS NULL`).get(id) as UserRow | null
}
/** Live user by username, case-insensitive. */
export function getUserByUsername(db: Database, username: string): UserRow | null {
  return db.query(`SELECT ${USER_COLS} FROM users WHERE lower(username) = lower(?) AND deleted_at IS NULL`).get(username) as UserRow | null
}
export function usernameTaken(db: Database, username: string): boolean {
  return !!db.query('SELECT 1 FROM users WHERE lower(username) = lower(?)').get(username)
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
  }
}

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
  passwordHash: string
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
