// The welcome for invited people (docs/DECISIONS.md "A welcome for invited people"; contract
// shared/src/api/member-welcome.ts).
//
// recordJoin runs once for every way someone joins a team that exists: the team link (auth/team-links.ts), a
// single-use invite (auth/accounts.ts) and an admin's "Add directly" (admin/users.ts). It only keeps who invited them
// and when (member_welcome, migration 342). The "{name} joined the team" line in the everyone room and the owners'
// team.joined notice are dev's (rooms/service.ts memberJoined, notifications/service.ts notifyTeamJoined; docs/DECISIONS.md
// "A new member is told to the team"): an invite and the team link send them at the join. For "Add directly" they wait
// for the person's first successful sign-in (firstSignIn, from auth/service.ts signIn), once: an account made by an
// admin has not joined until its person is here, and one deleted or disabled before that is never announced. The
// team's creator never gets a row: their start is the welcome steps.
//
// welcomeOf is the card on Home, for the caller only: who invited them, how many people are here, their rooms and four
// rows (the rooms: done; hi: any message of theirs in a room; photo: optional; asked: the "what can I do here" chat).
// It shows for MEMBER_WELCOME_DAYS after joining, until hidden or done; once every counted row is done it says "You're
// all set" for ALL_SET_MS, then it is gone for good.
//
// While the card's days last, the person's connection template notices wait (notifications/service.ts offerTemplates)
// until they open Connected apps (templatesSeen: the templates are listed there, so the offers are recorded without a
// notice) or the days are over (the 30-second pass sends them then).
import type { Database } from 'bun:sqlite'
import { MEMBER_WELCOME_DAYS, type MemberWelcome, type WelcomeRoom } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { getTeamSettings } from '../admin/settings'
import { profileOf } from '../auth/profiles'
import { notifyTeamJoined } from '../notifications/service'
import { roomsOf } from '../rooms/service'

export type JoinVia = 'team_link' | 'invite' | 'admin'
const DAY_MS = 86_400_000
/** how long "You're all set" shows after the last row was done */
export const ALL_SET_MS = 10 * 60_000

interface Row { user_id: string; invited_by: string | null; via: JoinVia; joined_at: string; hidden_at: string | null; asked_at: string | null; done_at: string | null; apps_seen_at: string | null; added_by: string | null; announced_at: string | null }

const rowOf = (db: Database, userId: string) => db.query('SELECT * FROM member_welcome WHERE user_id = ?').get(userId) as Row | null
/** the earliest join time whose card (and template hold) still lasts */
export const welcomeSince = (now: number) => new Date(now - MEMBER_WELCOME_DAYS * DAY_MS).toISOString()

/**
 * Someone joined: keep who invited them (`invitedBy`: the team link's or invite's maker; null for "Add directly") for
 * their welcome card, and hold their connection template notices. `addedBy`: the admin of an "Add directly", left out
 * of the notice at the first sign-in. Never throws: the join itself is done.
 */
export function recordJoin(ctx: AppContext, o: { userId: string; via: JoinVia; invitedBy: string | null; addedBy?: string | null }) {
  try {
    ctx.db.query('INSERT OR IGNORE INTO member_welcome (user_id, invited_by, via, joined_at, added_by) VALUES (?, ?, ?, ?, ?)')
      .run(o.userId, o.invitedBy, o.via, new Date().toISOString(), o.addedBy ?? null)
  } catch (e) { ctx.log.warn('welcome row not written', { err: e }) }
}

/**
 * Any successful sign-in (auth/service.ts signIn). For someone an admin added directly, the first one is when they
 * joined: dev's "{name} joined the team" line in the everyone room and team.joined to the active owners, except the
 * one who added them. Once (announced_at is set in the same statement that claims it). Never throws: the sign-in goes on.
 */
export function firstSignIn(ctx: AppContext, userId: string) {
  try {
    const claimed = ctx.db.query(`UPDATE member_welcome SET announced_at = ? WHERE user_id = ? AND via = 'admin' AND announced_at IS NULL
      AND EXISTS (SELECT 1 FROM users u WHERE u.id = member_welcome.user_id AND u.status = 'active' AND u.deleted_at IS NULL) RETURNING added_by`)
      .get(new Date().toISOString(), userId) as { added_by: string | null } | null
    if (!claimed) return
    const owners = (ctx.db.query("SELECT id FROM users WHERE role = 'owner' AND status = 'active' AND deleted_at IS NULL").all() as { id: string }[]).map((u) => u.id)
    notifyTeamJoined(ctx, owners.filter((o) => o !== claimed.added_by && o !== userId), userId)
    roomsOf(ctx).memberJoined(userId)
  } catch (e) { ctx.log.warn('the first sign-in was not announced', { err: e }) }
}

/** The rooms the card names: the everyone room first, then the team rooms by name (rooms put right first). */
function roomsFor(ctx: AppContext, userId: string): WelcomeRoom[] {
  try { roomsOf(ctx).syncFor(userId) } catch { /* the rooms as they are */ }
  const rows = ctx.db.query(`SELECT r.id, r.kind, COALESCE(r.name, g.name) name FROM room_members m JOIN rooms r ON r.id = m.room_id LEFT JOIN groups g ON g.id = r.group_id
    WHERE m.user_id = ? AND r.kind IN ('all', 'team') AND r.archived_at IS NULL AND m.hidden_at IS NULL`).all(userId) as { id: string; kind: 'all' | 'team'; name: string | null }[]
  return rows.sort((a, b) => (a.kind === b.kind ? (a.name ?? '').localeCompare(b.name ?? '') : a.kind === 'all' ? -1 : 1))
}

/** They wrote a message in a room they are in (since they joined it): "Say hi" is done. */
function saidHi(db: Database, userId: string): boolean {
  return !!db.query(`SELECT 1 FROM room_members m WHERE m.user_id = ? AND EXISTS (SELECT 1 FROM room_messages x WHERE x.room_id = m.room_id
    AND x.seq > m.visible_from_seq AND x.author_id = m.user_id AND x.author_kind = 'user' AND x.event IS NULL) LIMIT 1`).get(userId)
}

/** The caller's card, or null when it does not show (not invited, hidden, done a while ago, the days are over). */
export function welcomeOf(ctx: AppContext, userId: string, now = Date.now()): MemberWelcome | null {
  const db = ctx.db
  const r = rowOf(db, userId)
  if (!r || r.hidden_at || r.joined_at < welcomeSince(now)) return null
  if (r.done_at && Date.parse(r.done_at) + ALL_SET_MS < now) return null
  const steps = { rooms: true as const, hi: saidHi(db, userId), photo: !!profileOf(db, userId).avatarVersion, asked: !!r.asked_at }
  const allSet = steps.hi && steps.asked
  if (allSet && !r.done_at) db.query('UPDATE member_welcome SET done_at = ? WHERE user_id = ? AND done_at IS NULL').run(new Date(now).toISOString(), userId)
  const ref = (id: string | null) => id ? db.query('SELECT id, name FROM users WHERE id = ? AND deleted_at IS NULL').get(id) as { id: string; name: string } | null : null
  const owner = db.query("SELECT id, name FROM users WHERE role = 'owner' AND status = 'active' AND deleted_at IS NULL ORDER BY created_at LIMIT 1").get() as { id: string; name: string } | null
  return {
    team: getTeamSettings(db).teamName,
    inviter: ref(r.invited_by),
    people: (db.query("SELECT COUNT(*) n FROM users WHERE status = 'active' AND deleted_at IS NULL").get() as { n: number }).n,
    rooms: roomsFor(ctx, userId),
    owner,
    steps,
    allSet,
  }
}

/** Hide (for good) or "asked": the caller's own row only; a person without one has nothing to change. */
export function updateWelcome(ctx: AppContext, userId: string, b: { hide?: true; asked?: true }): MemberWelcome | null {
  const at = new Date().toISOString()
  if (b.hide) ctx.db.query('UPDATE member_welcome SET hidden_at = COALESCE(hidden_at, ?) WHERE user_id = ?').run(at, userId)
  if (b.asked) ctx.db.query('UPDATE member_welcome SET asked_at = COALESCE(asked_at, ?) WHERE user_id = ?').run(at, userId)
  return welcomeOf(ctx, userId)
}

/**
 * The person opened Connected apps (GET /api/integration-templates), where the templates for them are listed: the ones
 * they have not connected count as offered, without a notice (they are looking at them). Only once, and only while
 * their notices were held (a welcome row within its days); anyone else is left to offerTemplates as before.
 */
export function templatesSeen(ctx: AppContext, userId: string, templateIds: readonly string[]) {
  try {
    const db = ctx.db
    const at = new Date().toISOString()
    const held = db.query('UPDATE member_welcome SET apps_seen_at = ? WHERE user_id = ? AND apps_seen_at IS NULL AND joined_at >= ?').run(at, userId, welcomeSince(Date.now())).changes
    if (!held) return
    const mark = db.query('INSERT OR IGNORE INTO integration_template_offers(template_id, user_id, created_at) VALUES(?, ?, ?)')
    for (const id of templateIds) mark.run(id, userId, at)
  } catch (e) { ctx.log.warn('template offers not recorded', { err: e }) }
}
