// Guests (docs/DECISIONS.md "Guests: only what they were invited to"; owner decisions 2026-11-14). An outside person
// in exactly ONE place: one group chat (rooms.kind 'group') or one team project (projects/<name>). Everything else is
// closed to them by default: the endpoint allow-list (http/route.ts enforceAuth, GUEST_ENDPOINTS), the folder policy
// (policy/access.ts: only person rules inside their project), and the people a guest can see or reach (sharesPlace).
// DMs never count as a place: a guest may DM only the people of their place.
//
// Storage (migration 122_a_guests.sql): users.role keeps its CHECK (owner/admin/member), so a guest is stored as role
// 'member' with users.guest = 1 and every read of the role goes through roleSql() / USER_COLS / loadPrincipal, which
// answer 'guest'. Raw SQL that filters people by role must add `guest = 0` (or use roleSql()).
import type { Database } from 'bun:sqlite'
import type { GuestAi, GuestAiChoice, GuestPlace, Locale } from '@mycel/shared/api'
import { fail } from '../http/errors'
import { AUTH_MESSAGES } from './messages'
import { currentPlan, planManageUrl } from '../system/limits'
import { RuleSet, atLeast, type Principal } from '../policy/access'

/** The role as the API knows it, from a users row (`alias` = the table alias with its dot, e.g. 'u.'). */
export const roleSql = (alias = ''): string => `CASE WHEN ${alias}guest = 1 THEN 'guest' ELSE ${alias}role END`

export const isGuestRole = (p: { role: string } | null | undefined): boolean => p?.role === 'guest'
export function isGuest(db: Database, userId: string): boolean {
  return !!db.query('SELECT 1 FROM users WHERE id = ? AND guest = 1').get(userId)
}

export interface GuestRow { user_id: string; place_kind: 'room' | 'project'; place_id: string; ai: GuestAi; invited_by: string | null; created_at: string }
export function guestRow(db: Database, userId: string): GuestRow | null {
  return db.query('SELECT user_id, place_kind, place_id, ai, invited_by, created_at FROM guests WHERE user_id = ?').get(userId) as GuestRow | null
}
export const guestPlace = (db: Database, userId: string): GuestPlace | null => {
  const r = guestRow(db, userId)
  return r ? { kind: r.place_kind, id: r.place_id } : null
}
/** The guest's AI choice ('none' for anyone who is not a guest row: fail closed). */
export const guestAi = (db: Database, userId: string): GuestAi => guestRow(db, userId)?.ai ?? 'none'

/** projects.folder_path of a live (not trashed) project, or null. */
export function projectFolder(db: Database, projectId: string): string | null {
  const r = db.query('SELECT folder_path, trashed_with FROM projects WHERE id = ?').get(projectId) as { folder_path: string; trashed_with: string | null } | null
  return r && !r.trashed_with ? r.folder_path : null
}

const activePrincipals = (db: Database): Principal[] => {
  const groups = new Map<string, string[]>()
  for (const g of db.query('SELECT user_id, group_id FROM group_members').all() as { user_id: string; group_id: string }[]) {
    const l = groups.get(g.user_id) ?? []
    l.push(g.group_id)
    groups.set(g.user_id, l)
  }
  return (db.query(`SELECT id, name, ${roleSql()} AS role FROM users WHERE status = 'active' AND deleted_at IS NULL`).all() as { id: string; name: string; role: Principal['role'] }[])
    .map((u) => ({ id: u.id, name: u.name, role: u.role, groups: groups.get(u.id) ?? [] }))
}

/**
 * The people who share the guest's one place now (the guest included while they are still in it): the group chat's
 * members, or everyone who can read the project's folder. Empty when the place is gone or the guest is not in it.
 */
export function placePeople(db: Database, guestId: string, rules?: RuleSet): Set<string> {
  const place = guestPlace(db, guestId)
  if (!place) return new Set()
  if (place.kind === 'room') {
    const room = db.query("SELECT 1 FROM rooms WHERE id = ? AND kind = 'group' AND archived_at IS NULL").get(place.id)
    if (!room) return new Set()
    const ids = (db.query('SELECT user_id FROM room_members WHERE room_id = ?').all(place.id) as { user_id: string }[]).map((r) => r.user_id)
    return ids.includes(guestId) ? new Set(ids) : new Set()
  }
  const folder = projectFolder(db, place.id)
  if (!folder) return new Set()
  const rs = rules ?? RuleSet.fromDb(db)
  const segs = folder.split('/')
  const out = new Set<string>()
  for (const p of activePrincipals(db)) if (atLeast(rs.access(p, segs), 'read')) out.add(p.id)
  return out.has(guestId) ? out : new Set()
}

/** The guest is still in their one place (a group chat member, or reads the project's folder). */
export const inPlace = (db: Database, guestId: string, rules?: RuleSet): boolean => placePeople(db, guestId, rules).has(guestId)

/**
 * May `viewerId` see or reach `otherId` (people list, avatars, presence, DMs, adding to a group chat, the AI's people
 * search)? Between two non-guests: yes. When either is a guest: only when both are in that guest's one place.
 */
export function sharesPlace(db: Database, viewerId: string, otherId: string): boolean {
  if (viewerId === otherId) return true
  const vg = isGuest(db, viewerId), og = isGuest(db, otherId)
  if (!vg && !og) return true
  if (vg && !placePeople(db, viewerId).has(otherId)) return false
  if (og && !placePeople(db, otherId).has(viewerId)) return false
  return true
}

/**
 * A filter for many people at once, for one viewer: null when the viewer is not a guest and no guest is in `ids`
 * (nothing to filter), else a predicate.
 */
export function reachFilter(db: Database, viewerId: string): (otherId: string) => boolean {
  const guests = new Set((db.query('SELECT id FROM users WHERE guest = 1').all() as { id: string }[]).map((r) => r.id))
  if (!guests.size) return () => true
  if (guests.has(viewerId)) {
    const mine = placePeople(db, viewerId)
    return (id) => id === viewerId || (mine.has(id) && (!guests.has(id) || placePeople(db, id).has(viewerId)))
  }
  const memo = new Map<string, boolean>()
  return (id) => {
    if (!guests.has(id) || id === viewerId) return true
    let v = memo.get(id)
    if (v === undefined) { v = placePeople(db, id).has(viewerId); memo.set(id, v) }
    return v
  }
}

/**
 * Who may see `userId` (sharesPlace for each viewer), read now and kept: for a notice sent after a change that ends or
 * brings back the account (switched off, deleted, switched on), when sharesPlace afterwards may answer differently.
 * Between two non-guests: yes. A guest and the people outside their one place: no, in both directions.
 */
export function seenBy(db: Database, userId: string): (to: string) => boolean {
  const guests = (db.query("SELECT id FROM users WHERE guest = 1 AND status = 'active' AND deleted_at IS NULL").all() as { id: string }[]).map((r) => r.id)
  const target = isGuest(db, userId)
  if (!guests.length && !target) return () => true
  // one rule set for every project place read here (placePeople reads it again otherwise)
  const rules = RuleSet.fromDb(db)
  const own = target ? placePeople(db, userId, rules) : null
  const guestSees = new Map<string, boolean>()
  for (const g of guests) if (g !== userId) guestSees.set(g, (!own || own.has(g)) && placePeople(db, g, rules).has(userId))
  return (to) => to === userId || (guestSees.get(to) ?? (own ? own.has(to) : true))
}

// ---------------- the plan's guest cap ----------------
/** Guests on a plan file without maxGuests (the control plane writes it later): the smallest plan's number. */
export const DEFAULT_PLAN_GUESTS = 3
/** The plan's guest cap, or null (a self-hosted server without a plan: no cap). */
export function guestLimit(): number | null {
  const plan = currentPlan()
  if (!plan) return null
  return plan.maxGuests ?? DEFAULT_PLAN_GUESTS
}
/** Active guests (disabled and deleted ones do not count). */
export function guestsUsed(db: Database): number {
  return (db.query("SELECT COUNT(*) AS n FROM users WHERE guest = 1 AND status = 'active' AND deleted_at IS NULL").get() as { n: number }).n
}
/** The plan's guest limit message ({n}: the limit), from the language table (auth/messages.ts guestLimit). */
export const GUEST_LIMIT_MSG = Object.fromEntries((Object.keys(AUTH_MESSAGES.guestLimit) as Locale[]).map((l) => [l, (n: number) => AUTH_MESSAGES.guestLimit[l].replace('{n}', String(n))])) as Record<Locale, (n: number) => string>
/** Refuse (409 plan_limit, reason guest_limit) when one more active guest would go over the plan. Call it inside the
 * write that adds the guest. */
export function assertGuestFree(db: Database, locale: Locale, adding = 1): void {
  const max = guestLimit()
  if (max === null || guestsUsed(db) + adding <= max) return
  const url = planManageUrl()
  fail('plan_limit', (GUEST_LIMIT_MSG[locale] ?? GUEST_LIMIT_MSG.en)(max), { params: { reason: 'guest_limit', limit: max, changePlan: true, ...(url ? { manageUrl: url } : {}) } })
}

// ---------------- one place ----------------
/** guest_one_place, from the language table (auth/messages.ts guestOnePlace). */
export const GUEST_ONE_PLACE_MSG: Record<Locale, string> = AUTH_MESSAGES.guestOnePlace
/** guest_role: an admin sets a guest's role (auth/messages.ts guestRole); only "convert to member" changes it */
export const GUEST_ROLE_MSG: Record<Locale, string> = AUTH_MESSAGES.guestRole
/** 409 conflict, reason guest_one_place: a guest is never put into a second room or project. */
export function failOnePlace(locale: Locale): never {
  return fail('conflict', GUEST_ONE_PLACE_MSG[locale] ?? GUEST_ONE_PLACE_MSG.en, { params: { reason: 'guest_one_place' } })
}
/** Refuse putting `userId` into `place` when they are a guest whose one place is another one. */
export function assertGuestMayJoin(db: Database, userId: string, place: GuestPlace, locale: Locale): void {
  const r = guestRow(db, userId)
  if (!r) { if (isGuest(db, userId)) failOnePlace(locale); return }
  if (r.place_kind !== place.kind || r.place_id !== place.id) failOnePlace(locale)
}
/** The guests among `ids` (people about to be added somewhere). */
export function guestsAmong(db: Database, ids: readonly string[]): string[] {
  if (!ids.length) return []
  return (db.query(`SELECT id FROM users WHERE guest = 1 AND id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { id: string }[]).map((r) => r.id)
}

/** The guest's AI as screens show it: 'team' with its connection and monthly limit (the user 'block' budget), only
 * while both are there (else what resolution does: none). */
export function guestAiChoice(db: Database, userId: string): GuestAiChoice {
  const r = guestRow(db, userId)
  if (!r || r.ai === 'none') return { mode: 'none' }
  if (r.ai === 'own') return { mode: 'own' }
  const cred = (db.query('SELECT team_credential_id AS c FROM guests WHERE user_id = ?').get(userId) as { c: string | null } | null)?.c ?? null
  const b = db.query("SELECT limit_usd FROM budgets WHERE subject_type = 'user' AND subject_id = ? AND action = 'block' ORDER BY limit_usd LIMIT 1").get(userId) as { limit_usd: number } | null
  return cred && b && b.limit_usd > 0 ? { mode: 'team', credentialId: cred, limitUsd: b.limit_usd } : { mode: 'none' }
}

/** The name of a place as the team calls it (a group chat's name, '' when it has none; a project's name). */
export function placeName(db: Database, place: GuestPlace): string {
  if (place.kind === 'room') return (db.query('SELECT name FROM rooms WHERE id = ?').get(place.id) as { name: string | null } | null)?.name ?? ''
  return (db.query('SELECT name FROM projects WHERE id = ?').get(place.id) as { name: string } | null)?.name ?? ''
}

/** Me.guest / User.guest: the guest's one place with its name, and their AI; undefined for anyone else. */
export function guestDetail(db: Database, userId: string): { place: GuestPlace & { name: string }; ai: GuestAiChoice } | undefined {
  const place = guestPlace(db, userId)
  if (!place) return undefined
  return { place: { ...place, name: placeName(db, place) }, ai: guestAiChoice(db, userId) }
}
