// Guests (docs/DECISIONS.md "Guests: only what they were invited to", "Guests: one group chat and one project"; owner
// decisions 2026-11-14, 2026-11-15). An outside person in at most one group chat (rooms.kind 'group') AND at most one
// team project (projects/<name>). Everything else is closed to them by default: the endpoint allow-list (http/route.ts
// enforceAuth, GUEST_ENDPOINTS), the folder policy (policy/access.ts: only person rules inside their one project), and
// the people a guest can see or reach (sharesPlace: the people of their places). DMs never count as a place: a guest
// may DM only the people of their places.
//
// Places (migration 126): guests.room_id / guests.project_id, one per kind, set by claimGuestRoom / claimGuestProject
// in the write that puts them in.
//
// Storage (migration 122_a_guests.sql): users.role keeps its CHECK (owner/admin/member), so a guest is stored as role
// 'member' with users.guest = 1 and every read of the role goes through roleSql() / USER_COLS / loadPrincipal, which
// answer 'guest'. Raw SQL that filters people by role must add `guest = 0` (or use roleSql()).
import type { Database } from 'bun:sqlite'
import type { GuestAi, GuestAiChoice, GuestPlace, Locale } from '@mycel/shared/api'
import { fail } from '../http/errors'
import { AUTH_MESSAGES } from './messages'
import { currentPlan, planManageUrl } from '../system/limits'
import { budgetBlock, periodEnd, periodStart, spend } from '../admin/budgets'
import { teamTimeZone } from '../admin/settings'
import { RuleSet, atLeast, isZoneTop, type Principal } from '../policy/access'

/** The role as the API knows it, from a users row (`alias` = the table alias with its dot, e.g. 'u.'). */
export const roleSql = (alias = ''): string => `CASE WHEN ${alias}guest = 1 THEN 'guest' ELSE ${alias}role END`

export const isGuestRole = (p: { role: string } | null | undefined): boolean => p?.role === 'guest'
export function isGuest(db: Database, userId: string): boolean {
  return !!db.query('SELECT 1 FROM users WHERE id = ? AND guest = 1').get(userId)
}

export interface GuestRow {
  user_id: string; ai: GuestAi; invited_by: string | null; created_at: string
  /** the guest's group chat and project (migration 126): where they are, or were last; NULL = none of that kind */
  room_id: string | null; project_id: string | null
  /** the place the invite opened (set once at accept; decides nothing, only the "joined as a guest" notice reads it) */
  place_kind: 'room' | 'project'; place_id: string
}
export function guestRow(db: Database, userId: string): GuestRow | null {
  return db.query('SELECT user_id, place_kind, place_id, room_id, project_id, ai, invited_by, created_at FROM guests WHERE user_id = ?').get(userId) as GuestRow | null
}
/** The guest's places as stored (migration 126: at most one group chat and one project), the group chat first. A slot
 * says where they are or were last; whether they are in it now is read from the place itself (placePeopleOf). */
export function guestSlots(db: Database, userId: string): GuestPlace[] {
  const r = guestRow(db, userId)
  if (!r) return []
  // neither slot set: a row an older build wrote (it knows only the invite's place), read as that one place. Slots are
  // never cleared, so this is the only way both are empty (policy/access.ts guestProjects reads it the same way)
  if (!r.room_id && !r.project_id) return [{ kind: r.place_kind, id: r.place_id }]
  return [...(r.room_id ? [{ kind: 'room' as const, id: r.room_id }] : []), ...(r.project_id ? [{ kind: 'project' as const, id: r.project_id }] : [])]
}
/** The places the guest is in now (their group chat and/or project; a place they left or that closed is not listed),
 * the group chat first. What the guest's AI is told and may read (chat/guest-tools.ts, room-tools.ts, tools.ts). */
export function guestPlace(db: Database, userId: string): GuestPlace[] {
  const slots = guestSlots(db, userId)
  const rules = slots.some((p) => p.kind === 'project') ? RuleSet.fromDb(db) : undefined
  return slots.filter((p) => inSlotEvenIfOff(db, userId, p, rules))
}
/** The place the guest's invite opened (the "X joined as a guest" notice), or null. */
export function invitedPlace(db: Database, userId: string): GuestPlace | null {
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
const liveGroupRoom = (db: Database, roomId: string): boolean => !!db.query("SELECT 1 FROM rooms WHERE id = ? AND kind = 'group' AND archived_at IS NULL").get(roomId)

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
 * The people who share ONE place of the guest's now (the guest included while they are still in it): the group chat's
 * members, or everyone who can read the project's folder. Empty when the place is gone or the guest is not in it.
 */
export function placePeopleOf(db: Database, guestId: string, place: GuestPlace, rules?: RuleSet): Set<string> {
  if (place.kind === 'room') {
    if (!liveGroupRoom(db, place.id)) return new Set()
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

/**
 * The people who share a place with the guest now: the union of their group chat's people and their project's people
 * (each only while the guest is in it). Empty when they are in neither. Everything a guest may see or reach is built
 * on this (sharesPlace, reachFilter, seenBy, DMs, presence).
 */
export function placePeople(db: Database, guestId: string, rules?: RuleSet): Set<string> {
  const slots = guestSlots(db, guestId)
  if (!slots.length) return new Set()
  const rs = slots.some((p) => p.kind === 'project') ? rules ?? RuleSet.fromDb(db) : undefined
  const out = new Set<string>()
  for (const p of slots) for (const id of placePeopleOf(db, guestId, p, rs)) out.add(id)
  return out
}

/** One place of a guest who may be switched off (placePeopleOf counts active accounts only): is the guest still a
 * member of the group chat, or a person of the project's folder? */
function inSlotEvenIfOff(db: Database, guestId: string, place: GuestPlace, rules?: RuleSet): boolean {
  if (place.kind === 'room') {
    return !!db.query("SELECT 1 FROM rooms r JOIN room_members m ON m.room_id = r.id AND m.user_id = ? WHERE r.id = ? AND r.kind = 'group' AND r.archived_at IS NULL").get(guestId, place.id)
  }
  const folder = projectFolder(db, place.id)
  if (!folder) return false
  const me = db.query(`SELECT id, name, ${roleSql()} AS role FROM users WHERE id = ? AND deleted_at IS NULL`).get(guestId) as { id: string; name: string; role: Principal['role'] } | null
  return !!me && atLeast((rules ?? RuleSet.fromDb(db)).access({ ...me, groups: [] }, folder.split('/')), 'read')
}

/** inPlace for a guest who may be switched off: could a removed guest come back, still being in one of their places?
 * Asked when an admin switches them on (admin/users.ts), for Admin's row (placeOut) and when their project is restored
 * (admin/guests.ts). */
export function inPlaceEvenIfOff(db: Database, guestId: string, rules?: RuleSet): boolean {
  return guestSlots(db, guestId).some((p) => inSlotEvenIfOff(db, guestId, p, rules))
}

/** The guest is in at least one of their places now (a group chat member, or reads the project's folder). */
export const inPlace = (db: Database, guestId: string, rules?: RuleSet): boolean => placePeople(db, guestId, rules).has(guestId)

/** Why a guest is not in one place of theirs now, or null while they are: 'trashed' = the project is in the trash
 * (restoring it brings them back: admin/guests.ts returnGuestsWithPlace), 'gone' = the group chat was closed or the
 * project deleted for good, 'left' = the place is there but they are out of it (taken out, left). */
export function placeOutOf(db: Database, userId: string, place: GuestPlace, rules?: RuleSet): 'left' | 'trashed' | 'gone' | null {
  if (place.kind === 'room') {
    if (!liveGroupRoom(db, place.id)) return 'gone'
  } else if (!projectFolder(db, place.id)) {
    return db.query('SELECT 1 FROM projects WHERE id = ? AND trashed_with IS NOT NULL').get(place.id) ? 'trashed' : 'gone'
  }
  return inSlotEvenIfOff(db, userId, place, rules) ? null : 'left'
}

/** Why a guest is in none of their places now, or null while they are in one (User.guest.placeOut, and the answer to
 * switching a removed guest on): 'trashed' when their project is in the trash (restoring it brings them back), else
 * 'left' when a place of theirs is still there, else 'gone'. */
export function placeOut(db: Database, userId: string, rules?: RuleSet): 'left' | 'trashed' | 'gone' | null {
  const outs = guestSlots(db, userId).map((p) => placeOutOf(db, userId, p, rules))
  if (!outs.length) return 'gone'
  if (outs.includes(null)) return null
  return outs.includes('trashed') ? 'trashed' : outs.includes('left') ? 'left' : 'gone'
}

/**
 * May `viewerId` see or reach `otherId` (people list, avatars, presence, DMs, adding to a group chat, the AI's people
 * search)? Between two non-guests: yes. When either is a guest: only when the other is in one of that guest's places
 * with them (placePeople: their group chat or their project).
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
 * Between two non-guests: yes. A guest and the people outside their places: no, in both directions.
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
/** Guests on a plan file without maxGuests (a kit the control plane does not send it to yet): a low default, below
 *  every hosted plan's own number (the smallest, Starter and the trial, is 10). */
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
 * write that adds the guest. `joining`: the person accepting a guest link, who can neither remove guests nor change the
 * plan, is told to let the inviter know (no plan page, no "change the plan" for a store app to reword). */
export function assertGuestFree(db: Database, locale: Locale, adding = 1, joining = false): void {
  const max = guestLimit()
  if (max === null || guestsUsed(db) + adding <= max) return
  if (joining) fail('plan_limit', AUTH_MESSAGES.guestLimitJoin[locale] ?? AUTH_MESSAGES.guestLimitJoin.en, { params: { reason: 'guest_limit', limit: max } })
  const url = planManageUrl()
  fail('plan_limit', (GUEST_LIMIT_MSG[locale] ?? GUEST_LIMIT_MSG.en)(max), { params: { reason: 'guest_limit', limit: max, changePlan: true, ...(url ? { manageUrl: url } : {}) } })
}

// ---------------- one group chat and one project ----------------
/** guest_one_place, from the language table (auth/messages.ts guestOnePlace). */
export const GUEST_ONE_PLACE_MSG: Record<Locale, string> = AUTH_MESSAGES.guestOnePlace
/** guest_role: an admin sets a guest's role (auth/messages.ts guestRole); only "convert to member" changes it */
export const GUEST_ROLE_MSG: Record<Locale, string> = AUTH_MESSAGES.guestRole
/** 409 conflict, reason guest_one_place: a guest is never put into a second group chat or a second project. */
export function failOnePlace(locale: Locale): never {
  return fail('conflict', GUEST_ONE_PLACE_MSG[locale] ?? GUEST_ONE_PLACE_MSG.en, { params: { reason: 'guest_one_place' } })
}
/** A row an older build wrote (both slots empty, read as its invite place): that place goes into its own kind's slot
 * first, so claiming the other kind never drops it (security review must-fix). */
function fillOlderSlots(db: Database, userId: string): void {
  db.query("UPDATE guests SET room_id = CASE WHEN place_kind = 'room' THEN place_id END, project_id = CASE WHEN place_kind = 'project' THEN place_id END WHERE user_id = ? AND room_id IS NULL AND project_id IS NULL").run(userId)
}
/**
 * Put guest `userId` into the group chat `roomId` (call inside the write that adds their member row): refused (409
 * guest_one_place) while they are a member of any other live group chat, read from the member rows themselves so a
 * slot can never let two through; else guests.room_id becomes this chat. A guest flag without a guests row: refused
 * (fail closed). A no-op for anyone who is not a guest.
 */
export function claimGuestRoom(db: Database, userId: string, roomId: string, locale: Locale): void {
  if (!isGuest(db, userId)) return
  if (!guestRow(db, userId)) failOnePlace(locale)
  fillOlderSlots(db, userId)
  const other = db.query("SELECT 1 FROM room_members m JOIN rooms r ON r.id = m.room_id WHERE m.user_id = ? AND r.id <> ? AND r.kind = 'group' AND r.archived_at IS NULL LIMIT 1").get(userId, roomId)
  if (other) failOnePlace(locale)
  db.query('UPDATE guests SET room_id = ? WHERE user_id = ?').run(roomId, userId)
}
/**
 * The project a guest holds now, which a second project may not take from them: a live one whose folder they read, or
 * one in the trash that keeps a rule for them (restoring it brings them back, so it stays theirs meanwhile). null when
 * their project was deleted for good (purged from the trash: its rules go), or they are out of it (taken out, left,
 * also before it went to the trash): then another project may be theirs.
 */
export function heldProject(db: Database, userId: string, rules?: RuleSet): string | null {
  const id = guestSlots(db, userId).find((p) => p.kind === 'project')?.id
  if (!id) return null
  const r = db.query('SELECT folder_path, trashed_with FROM projects WHERE id = ?').get(id) as { folder_path: string; trashed_with: string | null } | null
  if (!r) return null
  if (r.trashed_with) {
    // its folder's rules are parked under the trash item's storage path (team-files trash): theirs still there?
    const kept = db.query(`SELECT 1 FROM trash_items t JOIN folders f ON f.path = t.storage_path || substr(?, length(t.original_path) + 1)
      JOIN folder_rules x ON x.folder_id = f.id AND x.subject_type = 'user' AND x.subject_id = ? AND x.access <> 'none'
      WHERE t.id = ? AND t.restored_at IS NULL AND (? = t.original_path OR substr(?, 1, length(t.original_path) + 1) = t.original_path || '/')`).get(r.folder_path, userId, r.trashed_with, r.folder_path, r.folder_path)
    return kept ? id : null
  }
  return inSlotEvenIfOff(db, userId, { kind: 'project', id }, rules) ? id : null
}
/**
 * May a NEW person rule give guest `userId` access at `folderPath`? (admin/folders.ts writeFolderAccess, inside its
 * write.) Their project held (heldProject): only at or below its folder. None held: only on a live team project's own
 * folder (projects/<name>), which becomes theirs (guests.project_id) in this write. Anything else: 409
 * guest_one_place. The policy holds the same line whatever writes a rule (policy/access.ts guestProjects: a guest reads
 * inside projects/ only in guests.project_id's folder).
 */
export function claimGuestProject(db: Database, userId: string, folderPath: string, locale: Locale): void {
  if (!guestRow(db, userId)) failOnePlace(locale)
  fillOlderSlots(db, userId)
  const held = heldProject(db, userId)
  if (held) {
    const own = projectFolder(db, held)
    if (!own || !(folderPath === own || folderPath.startsWith(own + '/'))) failOnePlace(locale)
    return
  }
  const p = isZoneTop(folderPath) ? db.query('SELECT id FROM projects WHERE folder_path = ? AND trashed_with IS NULL').get(folderPath) as { id: string } | null : null
  if (!p) failOnePlace(locale)
  db.query('UPDATE guests SET project_id = ? WHERE user_id = ?').run(p!.id, userId)
}
/** The guests among `ids` (people about to be added somewhere). */
export function guestsAmong(db: Database, ids: readonly string[]): string[] {
  if (!ids.length) return []
  return (db.query(`SELECT id FROM users WHERE guest = 1 AND id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { id: string }[]).map((r) => r.id)
}

/** The guest's own Team AI limit: their 'block' budget for the month, a token one first (a guest given Team AI before
 * 2026-11-15 has a US dollar one: read as it is until an admin changes it). null without one. */
function guestBudget(db: Database, userId: string): { limitTokens: number | null; limitUsd: number } | null {
  const b = db.query(`SELECT limit_usd, limit_tokens FROM budgets WHERE subject_type = 'user' AND subject_id = ? AND action = 'block'
    AND (limit_tokens > 0 OR limit_usd > 0) ORDER BY limit_tokens IS NULL, limit_tokens, limit_usd LIMIT 1`).get(userId) as { limit_usd: number; limit_tokens: number | null } | null
  return b ? { limitTokens: b.limit_tokens !== null && b.limit_tokens > 0 ? b.limit_tokens : null, limitUsd: b.limit_usd } : null
}

/** The guest's AI as screens show it: 'team' with its connection and monthly limit (the user 'block' budget: tokens, or
 * an older guest's US dollars), only while both are there (else what resolution does: none). */
export function guestAiChoice(db: Database, userId: string): GuestAiChoice {
  const r = guestRow(db, userId)
  if (!r || r.ai === 'none') return { mode: 'none' }
  if (r.ai === 'own') return { mode: 'own' }
  const cred = (db.query('SELECT team_credential_id AS c FROM guests WHERE user_id = ?').get(userId) as { c: string | null } | null)?.c ?? null
  const b = guestBudget(db, userId)
  if (!cred || !b) return { mode: 'none' }
  return b.limitTokens !== null ? { mode: 'team', credentialId: cred, limitTokens: b.limitTokens } : { mode: 'team', credentialId: cred, limitUsd: b.limitUsd }
}

/** Team AI: this month's use of the guest's limit (as checkBudgets counts it) and when it starts over. */
function guestAiUse(db: Database, userId: string, now = new Date()): { usedTokens: number; usedUsd: number; resetsAt: string } {
  const tz = teamTimeZone(db)
  const used = spend(db, 'user', userId, periodStart('month', now, tz))
  return { usedTokens: used.tokens, usedUsd: used.usd, resetsAt: periodEnd('month', now, tz).toISOString() }
}

/** The name of a place as the team calls it (a group chat's name, '' when it has none; a project's name). */
export function placeName(db: Database, place: GuestPlace): string {
  if (place.kind === 'room') return (db.query('SELECT name FROM rooms WHERE id = ?').get(place.id) as { name: string | null } | null)?.name ?? ''
  return (db.query('SELECT name FROM projects WHERE id = ?').get(place.id) as { name: string } | null)?.name ?? ''
}

type PlaceOut = 'left' | 'trashed' | 'gone'
/** Me.guest / User.guest: the guest's places with their names (an active guest: the ones they are in now; a removed
 * one: each place they were last in, with why they are out of it), and their AI; undefined for anyone else. */
export function guestDetail(db: Database, userId: string): { places: (GuestPlace & { name: string; out?: PlaceOut })[]; ai: GuestAiChoice; placeOut?: PlaceOut; leftThemselves?: true; teamAiGone?: true; aiUsedUp?: true; aiUse?: { usedTokens: number; usedUsd: number; resetsAt: string } } | undefined {
  const r = guestRow(db, userId)
  if (!r) return undefined
  const ai = guestAiChoice(db, userId)
  const off = !!db.query("SELECT 1 FROM users WHERE id = ? AND status <> 'active'").get(userId)
  const slots = guestSlots(db, userId)
  const rules = slots.some((p) => p.kind === 'project') ? RuleSet.fromDb(db) : undefined
  const outs = slots.map((p) => placeOutOf(db, userId, p, rules))
  const places = slots.map((p, i) => ({ ...p, name: placeName(db, p), ...(off && outs[i] ? { out: outs[i]! } : {}) })).filter((_, i) => off || outs[i] === null)
  // only for a removed guest (an active guest is in a place: the server switches off one who is in none)
  const out = off ? placeOut(db, userId, rules) : null
  // Team AI picked, but its team AI account was deleted since (guests.team_credential_id is set NULL with it): No AI in
  // effect, and the screens say AI can't answer now (the guest) and that the account is gone (Admin)
  const gone = r.ai === 'team' && ai.mode === 'none' && !teamCredentialLive(db, userId)
  // Team AI whose monthly limit is used up now: Admin's row says so (QA TC-2206)
  const usedUp = ai.mode === 'team' && !!budgetBlock(db, userId, 'en')
  // left it on their own (guests.left_at, admin/guests.ts): Admin lists them as "Left", not "Removed"
  const self = out === 'left' && !!(db.query('SELECT left_at FROM guests WHERE user_id = ?').get(userId) as { left_at: string | null } | null)?.left_at
  return { places, ai, ...(out ? { placeOut: out } : {}), ...(self ? { leftThemselves: true as const } : {}), ...(gone ? { teamAiGone: true as const } : {}), ...(usedUp ? { aiUsedUp: true as const } : {}),
    ...(ai.mode === 'team' ? { aiUse: guestAiUse(db, userId) } : {}) }
}

/**
 * Person.guestPlaces for one viewer: the places the guest is in now; one the viewer is in too comes with its id and
 * name, any other as its kind only (an add list needs only "already in another project"; never the other place's
 * name or id). `rules`: one rule set for a whole list.
 */
export function guestPlacesFor(db: Database, guestId: string, viewerId: string | undefined, rules?: RuleSet): { kind: GuestPlace['kind']; id?: string; name?: string }[] {
  const out: { kind: GuestPlace['kind']; id?: string; name?: string }[] = []
  for (const p of guestSlots(db, guestId)) {
    const people = placePeopleOf(db, guestId, p, rules)
    if (!people.has(guestId)) continue
    out.push(viewerId && people.has(viewerId) ? { ...p, name: placeName(db, p) } : { kind: p.kind })
  }
  return out
}
/** The guest's team AI account is still there and still a team one. */
function teamCredentialLive(db: Database, userId: string): boolean {
  return !!db.query('SELECT 1 FROM guests g JOIN engine_credentials c ON c.id = g.team_credential_id AND c.owner_user_id IS NULL WHERE g.user_id = ?').get(userId)
}
