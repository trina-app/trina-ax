// The welcome for invited people (docs/DECISIONS.md "A welcome for invited people"; contract
// shared/src/api/member-welcome.ts).
//
// recordJoin runs once for every way someone joins a team that exists: the team link (auth/team-links.ts), a
// single-use invite (auth/accounts.ts) and an admin's "Add directly" (admin/users.ts). It only keeps who invited them
// and when (member_welcome, migration 286). The "{name} joined the team" line in the everyone room and the owners'
// team.joined notice are dev's (rooms/service.ts memberJoined, notifications/service.ts notifyTeamJoined; docs/DECISIONS.md
// "A new member is told to the team"): an invite and the team link send them at the join. For "Add directly" they wait
// for the person's first successful sign-in (firstSignIn, from auth/service.ts signIn), once: an account made by an
// admin has not joined until its person is here, and one deleted or disabled before that is never announced. Its welcome days count from that sign-in. The
// team's creator gets a row of their own when the team setup reaches its end screen ("My setup", my-setup.ts,
// docs/decisions/20261120-my-setup-card.md: `setup = 1`, its days from then). Every other new owner and admin gets
// theirs late, on their first read of the card (ensureOwnCard, docs/decisions/20261128-owner-personal-onboarding.md):
// an account at most LATE_CARD_DAYS old that never had a connection of its own.
//
// welcomeOf is the card on Home, for the caller only: who invited them, how many people are here, their rooms and the
// rows (tools: a connection of their own, counted; hi: any message of theirs in a room; photo: optional; asked: the
// "what can I do here" chat; files: optional, a file in their My files › From this computer, which the desktop app's
// row shows). The owner's card ('owner') counts tools and asked (its rows: the team setup's way back while it is open,
// tools, asked, photo, files; no hi), and is all set only once the team setup is over too (`setupOpen`). It shows for
// MEMBER_WELCOME_DAYS after joining (the owner: after the setup's end), until hidden or done; once every counted row is
// done it says "You're all set" for ALL_SET_MS, then it is gone for good. A card hidden while its days last can be
// shown again (Settings › Profile: `hidden` in the answer, PATCH { show }). An admin's "팀 파일 정리하기" (Admin › Home)
// rides along in the answer (`organizeFiles`), card or not.
//
// While the card's days last, the person's connection template notices wait (notifications/service.ts offerTemplates)
// until they open Connected apps (templatesSeen: the templates are listed there, so the offers are recorded without a
// notice) or the days are over (the 30-second pass sends them then).
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { FROM_COMPUTER_DIR } from '@mycel/shared'
import { MEMBER_WELCOME_DAYS, type MemberWelcome, type MemberWelcomeResponse, type WelcomeRoom } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { getTeamSettings } from '../admin/settings'
import { profileOf } from '../auth/profiles'
import { notifyTeamJoined } from '../notifications/service'
import { roomsOf } from '../rooms/service'
import { filesOrganized } from './files-organize'
import { readWelcome, welcomeOpened } from './welcome'
import { freeRoamOf } from '../demo/free-roam'

export type JoinVia = 'team_link' | 'invite' | 'admin'
const DAY_MS = 86_400_000
/** how long "You're all set" shows after the last row was done */
export const ALL_SET_MS = 10 * 60_000
/** a late card (ensureOwnCard) only for an account made at most this many days ago */
export const LATE_CARD_DAYS = 30

interface Row { user_id: string; invited_by: string | null; via: JoinVia; joined_at: string; hidden_at: string | null; asked_at: string | null; done_at: string | null; apps_seen_at: string | null; added_by: string | null; announced_at: string | null; setup: number; tools_at: string | null }

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
    // their 14 days (the card, the held template notices) start now, not when the account was made
    const at = new Date().toISOString()
    const claimed = ctx.db.query(`UPDATE member_welcome SET announced_at = ?, joined_at = ? WHERE user_id = ? AND via = 'admin' AND announced_at IS NULL
      AND EXISTS (SELECT 1 FROM users u WHERE u.id = member_welcome.user_id AND u.status = 'active' AND u.deleted_at IS NULL) RETURNING added_by`)
      .get(at, at, userId) as { added_by: string | null } | null
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

/** How many folders fromComputerHasFile looks into before it says no (a run makes a few levels: root, then folders). */
const FILES_LOOK_DIRS = 200

/**
 * A file is in their My files › From this computer (where "Find work files on this computer" puts what they add): the
 * optional files row is done. Read on disk, so Undo (the files go to the trash) makes it not done again. Symbolic
 * links are never followed (the person's folder and From this computer must be real folders); a folder that cannot be
 * read counts as empty.
 */
function fromComputerHasFile(ctx: AppContext, userId: string): boolean {
  const root = ctx.files?.fx?.root
  if (!root) return false
  // the person's folder and From this computer must be real folders, not links to somewhere else
  const own = path.join(root, 'users', userId)
  const start = path.join(own, FROM_COMPUTER_DIR)
  try { if (![own, start].every((p) => fs.lstatSync(p).isDirectory())) return false } catch { return false }
  const queue = [start]
  for (let seen = 0; queue.length && seen < FILES_LOOK_DIRS; seen++) {
    const dir = queue.shift()!
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      if (e.isFile()) return true
      if (e.isDirectory()) queue.push(path.join(dir, e.name))
    }
  }
  return false
}

/** They have a connection of their own that works: a listed service or a Google app (personal connections), or
 * Google Drive. "Connect your tools" is done. */
function hasOwnTool(db: Database, userId: string): boolean {
  return !!db.query("SELECT 1 FROM integrations WHERE scope = 'personal' AND owner_user_id = ? AND status = 'connected' LIMIT 1").get(userId)
    || !!db.query("SELECT 1 FROM drive_connections WHERE user_id = ? AND status = 'connected' LIMIT 1").get(userId)
}

/** They ever had a connection of their own, in any state: one there now (connected or not), or one made and ended
 * since (the audit keeps it: a disconnect deletes the row). A late card never appears the day after someone ended their
 * only tool. */
function everHadOwnConnection(db: Database, userId: string): boolean {
  return !!db.query("SELECT 1 FROM integrations WHERE scope = 'personal' AND owner_user_id = ? LIMIT 1").get(userId)
    || !!db.query('SELECT 1 FROM drive_connections WHERE user_id = ? LIMIT 1').get(userId)
    || !!db.query(`SELECT 1 FROM audit_log WHERE actor_id = ? AND (action IN ('drive.connected', 'google_app.connected')
      OR (action = 'integration.create' AND json_extract(detail, '$.scope') = 'personal')) LIMIT 1`).get(userId)
}

/** The rows that count toward "done": the owner's card tools and asked, and not while the team setup is open
 * (`setupOpen`: "all set" never shows over an unfinished team); a member's tools, hi and asked. */
export const countedDone = (kind: 'owner' | 'member', s: MemberWelcome['steps'], setupOpen = false) =>
  kind === 'owner' ? !setupOpen && [s.tools, s.asked].every(Boolean) : [s.tools, s.hi, s.asked].every(Boolean)

/** The team setup is open for this owner: its row exists, is neither finished nor hidden (✕). Owner role only: an
 * ex-owner, now an admin, who keeps an owner card is never held by steps they can no longer open. */
function setupOpenFor(ctx: AppContext, role: string): boolean {
  if (role !== 'owner') return false
  const p = readWelcome(ctx)
  return !!p && !p.finishedAt && !p.dismissedAt
}

type Shown = { row: Row; role: string; kind: 'owner' | 'member' } | null
/** The card's row and the person's role while a card can be theirs (within its days, not done a while ago, not a
 * guest; an owner only with the setup's own card), hidden or not; else null. */
function cardRow(db: Database, userId: string, now: number): Shown {
  const r = rowOf(db, userId)
  if (!r || r.joined_at < welcomeSince(now)) return null
  const me = db.query(`SELECT CASE WHEN guest = 1 THEN 'guest' ELSE role END AS role FROM users WHERE id = ?`).get(userId) as { role: string } | null
  // a guest has no welcome card: it shows the team (its head count, its owner, its rooms). An owner has the owner's own
  // card only (made at the setup's end); a lead who joined with a lead invite and was handed the team has none
  if (!me || me.role === 'guest' || (me.role === 'owner' && !r.setup)) return null
  if (r.done_at && Date.parse(r.done_at) + ALL_SET_MS < now) return null
  return { row: r, role: me.role, kind: r.setup ? 'owner' : 'member' }
}

/** The caller's card, or null when it does not show (not invited and no setup card, hidden, done a while ago, the
 * days are over). */
export function welcomeOf(ctx: AppContext, userId: string, now = Date.now()): MemberWelcome | null {
  const db = ctx.db
  const c = cardRow(db, userId, now)
  if (!c || c.row.hidden_at) return null
  const r = c.row
  // a free-roam demo: nothing to connect there (the card leaves the row out), so tools never holds the card back
  const demo = !!freeRoamOf(ctx)
  const steps = { rooms: true as const, hi: saidHi(db, userId), photo: !!profileOf(db, userId).avatarVersion, asked: !!r.asked_at, files: fromComputerHasFile(ctx, userId),
    // a team that lets nobody connect their own (personalIntegrations off), or every tool the row offers connected by
    // the team for everyone (tools_at, the card says so): nothing here to do, not held back by it
    tools: demo || hasOwnTool(db, userId) || getTeamSettings(db).personalIntegrations === false || !!r.tools_at }
  const setupOpen = c.kind === 'owner' && setupOpenFor(ctx, c.role)
  const allSet = countedDone(c.kind, steps, setupOpen)
  if (allSet && !r.done_at) db.query('UPDATE member_welcome SET done_at = ? WHERE user_id = ? AND done_at IS NULL').run(new Date(now).toISOString(), userId)
  const ref = (id: string | null) => id ? db.query('SELECT id, name FROM users WHERE id = ? AND deleted_at IS NULL').get(id) as { id: string; name: string } | null : null
  const owner = db.query("SELECT id, name FROM users WHERE role = 'owner' AND status = 'active' AND deleted_at IS NULL ORDER BY created_at LIMIT 1").get() as { id: string; name: string } | null
  return {
    kind: c.kind,
    team: getTeamSettings(db).teamName,
    inviter: ref(r.invited_by),
    // the team's people: guests are not counted (they take no seat)
    people: (db.query("SELECT COUNT(*) n FROM users WHERE status = 'active' AND deleted_at IS NULL AND guest = 0").get() as { n: number }).n,
    rooms: roomsFor(ctx, userId),
    owner,
    steps,
    allSet,
    ...(setupOpen ? { setupOpen: true as const } : {}),
    ...(demo ? { demo: true as const } : {}),
  }
}

/** The answer of GET/PATCH /api/me/welcome: the card, whether a hidden one can be shown again, and an admin's
 * "팀 파일 정리하기" for Admin › Home (no folder plan applied yet; the step needs the team's steps row). */
export function welcomeAnswer(ctx: AppContext, userId: string, now = Date.now()): MemberWelcomeResponse {
  ensureOwnCard(ctx, userId, now)
  const welcome = welcomeOf(ctx, userId, now)
  const c = welcome ? null : cardRow(ctx.db, userId, now)
  const hidden = !!c?.row.hidden_at && !c.row.done_at
  const role = (ctx.db.query("SELECT CASE WHEN guest = 1 THEN 'guest' ELSE role END AS role FROM users WHERE id = ?").get(userId) as { role: string } | null)?.role
  const organizeFiles = role === 'admin' && !filesOrganized(ctx) && readWelcome(ctx) !== null && welcomeOpened(ctx)
  return { welcome, ...(hidden ? { hidden: true } : {}), ...(organizeFiles ? { organizeFiles: true } : {}) }
}

/**
 * A late card for a new owner or admin (docs/decisions/20261128-owner-personal-onboarding.md): on every read of the
 * card (GET /api/me/welcome: Home, Settings › Profile, Admin › Home) and at a handover (admin/users.ts
 * transferOwnership). An active owner or admin, not a guest, whose account is at most LATE_CARD_DAYS old, who never had
 * a connection of their own (in any state), on a team that lets people connect their own and that is no demo, and who
 * has no row yet, or only the hidden member row of an owner (the handover's hide): an owner gets the owner card
 * (`setup = 1`), an admin a member row (no inviter). Its days count from this write (the first read, on any device: one
 * synchronous INSERT, so two devices make one row). `apps_seen_at` is set with it: a late card holds no connection
 * template notices (only the cards made at a join or at the setup's end do). Any other row stays as it is. Never throws.
 */
export function ensureOwnCard(ctx: AppContext, userId: string, now = Date.now()): void {
  try {
    const db = ctx.db
    // the demo company's people and a free-roam instance: the demo's own screen keeps Home
    if (ctx.config?.demo || freeRoamOf(ctx)) return
    const u = db.query('SELECT role, guest, status, deleted_at, created_at FROM users WHERE id = ?').get(userId) as { role: string; guest: number; status: string; deleted_at: string | null; created_at: string } | null
    if (!u || u.guest || u.status !== 'active' || u.deleted_at || (u.role !== 'owner' && u.role !== 'admin')) return
    if (u.created_at < new Date(now - LATE_CARD_DAYS * DAY_MS).toISOString()) return
    const r = rowOf(db, userId)
    const owner = u.role === 'owner'
    // a row that still counts (shown, hidden, finished, outlived) stays; only an owner's hidden member row is replaced
    if (r && !(owner && !r.setup && r.hidden_at)) return
    if (getTeamSettings(db).personalIntegrations === false || everHadOwnConnection(db, userId)) return
    const at = new Date(now).toISOString()
    if (!r) {
      db.query("INSERT INTO member_welcome (user_id, invited_by, via, joined_at, setup, apps_seen_at) VALUES (?, NULL, 'invite', ?, ?, ?) ON CONFLICT(user_id) DO NOTHING")
        .run(userId, at, owner ? 1 : 0, at)
      return
    }
    db.query(`UPDATE member_welcome SET setup = 1, invited_by = NULL, joined_at = ?, hidden_at = NULL, asked_at = NULL, done_at = NULL, tools_at = NULL, apps_seen_at = ?
      WHERE user_id = ? AND setup = 0 AND hidden_at IS NOT NULL`).run(at, at, userId)
  } catch (e) { ctx.log.warn('the late personal card was not made', { err: e }) }
}

/** Hide, show again (while its days last), "asked", or "tools" (every tool the row offers is the team's: nothing left
 * to connect): the caller's own row only; a person without one has nothing to change. */
export function updateWelcome(ctx: AppContext, userId: string, b: { hide?: true; show?: true; asked?: true; tools?: true }): MemberWelcomeResponse {
  const at = new Date().toISOString()
  if (b.tools) ctx.db.query('UPDATE member_welcome SET tools_at = COALESCE(tools_at, ?) WHERE user_id = ?').run(at, userId)
  if (b.hide) ctx.db.query('UPDATE member_welcome SET hidden_at = COALESCE(hidden_at, ?) WHERE user_id = ?').run(at, userId)
  else if (b.show) ctx.db.query('UPDATE member_welcome SET hidden_at = NULL WHERE user_id = ? AND done_at IS NULL').run(userId)
  if (b.asked) ctx.db.query('UPDATE member_welcome SET asked_at = COALESCE(asked_at, ?) WHERE user_id = ?').run(at, userId)
  return welcomeAnswer(ctx, userId)
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
