// A private channel linked to a team project (docs/decisions/20261119-channel-project-link.md, migration 427): one
// folder, the project's. The channel's header Files button opens the project folder (Room.project), Save to project copies
// a document there in one click (rooms/save-to-team.ts oneClick), and the channel's side chat saves new documents there
// (chat/side-room.ts savePlaceFor, chat/turn.ts linkedProjectPlain). The project's page shows its channel
// (Project.channel). Members of the two are never synced, either way.
//
// A link row counts only while it is ACTIVE: the room a private channel (a named group room) that is not archived, the
// project not in the trash and on a folder exactly projects/<name> (the members-only zone). Every read here checks it;
// an inactive row behaves as no link and is replaced by the next link of either side (linkInTx).
//
// Who sees what: Room.project only for a viewer who can open the project now (read on its folder); Project.channel only
// for someone who reads the project, never a guest who is not in the channel. The event lines name the project only to
// a viewer who can open it. Audit rows name the project only, never the room (store.ts roomAuditRef: a group room by
// its kind).
import type { Database } from 'bun:sqlite'
import type { Locale, Room } from '@mycel/shared/api'
import { atLeast, inProjectZone, loadPrincipal, RuleSet, type Principal } from '../policy/access'
import { fail } from '../http/errors'
import { audit } from '../admin/audit'
import { tr } from '../chat/i18n'
import { roomAuditRef, type RoomRow } from './store'

/** A projects row as the link reads it. */
export interface LinkedProjectRow { id: string; name: string; folder_path: string; trashed_with: string | null; created_by: string | null }

/** A project's folder is exactly projects/<name> (the members-only zone's floor): the only kind that links. */
export const linkableFolder = (folder: string): boolean => { const s = folder.split('/'); return s.length === 2 && !!s[1] && inProjectZone(s) }
/** A private channel: a group room with a name of its own, not archived. */
export const isPrivateChannelRow = (r: Pick<RoomRow, 'kind' | 'name' | 'archived_at'>): boolean => r.kind === 'group' && !!r.name?.trim() && !r.archived_at
/** The project side of an active link: not in the trash, on projects/<name>. */
export const projectLinkable = (p: Pick<LinkedProjectRow, 'folder_path' | 'trashed_with'>): boolean => p.trashed_with === null && linkableFolder(p.folder_path)

const PROJECT_COLS = 'p.id, p.name, p.folder_path, p.trashed_with, p.created_by'

/** The project a room is linked to, while the link is active; else null. */
export function activeProjectOf(db: Database, roomId: string): LinkedProjectRow | null {
  const r = db.query(`SELECT ${PROJECT_COLS}, r.kind, r.name AS room_name, r.archived_at FROM room_project_links l JOIN rooms r ON r.id = l.room_id JOIN projects p ON p.id = l.project_id WHERE l.room_id = ?`)
    .get(roomId) as (LinkedProjectRow & { kind: RoomRow['kind']; room_name: string | null; archived_at: string | null }) | null
  if (!r || !isPrivateChannelRow({ kind: r.kind, name: r.room_name, archived_at: r.archived_at }) || !projectLinkable(r)) return null
  return { id: r.id, name: r.name, folder_path: r.folder_path, trashed_with: r.trashed_with, created_by: r.created_by }
}

/** The channel a project is linked to, while the link is active; else null. */
export function activeRoomOf(db: Database, projectId: string): RoomRow | null {
  const r = db.query(`SELECT r.*, p.folder_path, p.trashed_with FROM room_project_links l JOIN rooms r ON r.id = l.room_id JOIN projects p ON p.id = l.project_id WHERE l.project_id = ?`)
    .get(projectId) as (RoomRow & { folder_path: string; trashed_with: string | null }) | null
  if (!r || !isPrivateChannelRow(r) || !projectLinkable(r)) return null
  const { folder_path: _f, trashed_with: _t, ...room } = r
  return room
}

/** The linked rooms of these projects (any row, active or not): who to tell when a project changes. */
export function linkedRoomsOf(db: Database, projectIds: readonly string[]): string[] {
  if (!projectIds.length) return []
  return (db.query(`SELECT room_id FROM room_project_links WHERE project_id IN (${projectIds.map(() => '?').join(',')})`).all(...projectIds) as { room_id: string }[]).map((r) => r.room_id)
}

/** What the viewer may do with a project folder: open it (read, and the folder listable), save into it (write, not a
 * guest). */
function sight(rules: RuleSet, who: Principal, folder: string): { opens: boolean; writes: boolean } {
  const segs = folder.split('/')
  const access = rules.access(who, segs)
  const opens = atLeast(access, 'read') && rules.canList(who, segs)
  return { opens, writes: opens && !rules.isGuest(who) && atLeast(access, 'write') }
}

/** Room.project for one viewer (store.ts roomOut): the active link's project when they can open it now. `rules`: the
 * caller's set when it judges many rooms at once (rulesOnce). */
export function projectForViewer(db: Database, room: Pick<RoomRow, 'id' | 'kind' | 'name' | 'archived_at'>, userId: string, rules?: () => RuleSet): Room['project'] | undefined {
  if (!isPrivateChannelRow(room)) return undefined
  const p = activeProjectOf(db, room.id)
  if (!p) return undefined
  const who = loadPrincipal(db, userId)
  if (!who) return undefined
  const s = sight(rules ? rules() : RuleSet.load(db), who, p.folder_path)
  return s.opens ? { id: p.id, name: p.name, folderPath: p.folder_path, canSave: s.writes } : undefined
}

/** Room.canLinkProject: a non-guest member (the caller is a member), a private channel, no active link. */
export function mayLinkProject(db: Database, room: Pick<RoomRow, 'id' | 'kind' | 'name' | 'archived_at'>, userId: string, rules?: () => RuleSet): boolean {
  if (!isPrivateChannelRow(room)) return false
  const who = loadPrincipal(db, userId)
  if (!who || (rules ? rules() : RuleSet.load(db)).isGuest(who)) return false
  return !activeProjectOf(db, room.id)
}

/** Project.channel and Project.canLinkChannel for one viewer who reads the project (the caller checked canSeeProject and
 * that it is not `member: false`). */
export function channelForViewer(db: Database, p: LinkedProjectRow, userId: string, rules: RuleSet = RuleSet.load(db)): { channel?: { roomId: string; name: string; memberCount: number; inIt: boolean; canUnlink?: true }; canLinkChannel?: true } {
  if (!projectLinkable(p)) return {}
  const who = loadPrincipal(db, userId)
  if (!who) return {}
  const s = sight(rules, who, p.folder_path)
  if (!s.opens) return {}
  const room = activeRoomOf(db, p.id)
  if (room) {
    const inIt = !!db.query('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(room.id, userId)
    // a guest who is not in the channel never learns of it (withheld here, not only on screen)
    if (!inIt && rules.isGuest(who)) return {}
    const memberCount = (db.query('SELECT COUNT(*) n FROM room_members WHERE room_id = ?').get(room.id) as { n: number }).n
    return { channel: { roomId: room.id, name: room.name ?? '', memberCount, inIt, ...(inIt && s.writes ? { canUnlink: true as const } : {}) } }
  }
  return s.writes ? { canLinkChannel: true } : {}
}

/** The project's name as an event line shows it to one viewer: only when they can open it now. One RuleSet for a page. */
export function eventProjectsFor(db: Database, projectIds: readonly string[], userId: string): Map<string, { id: string; name: string }> {
  const out = new Map<string, { id: string; name: string }>()
  const ids = [...new Set(projectIds)]
  if (!ids.length || !userId) return out
  const who = loadPrincipal(db, userId)
  if (!who) return out
  const rules = RuleSet.load(db)
  for (const r of db.query(`SELECT id, name, folder_path, trashed_with FROM projects WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as LinkedProjectRow[]) {
    if (r.trashed_with !== null) continue
    const segs = r.folder_path.split('/')
    if (atLeast(rules.access(who, segs), 'read')) out.set(r.id, { id: r.id, name: r.name })
  }
  return out
}

// ---------------- the checks (docs/decisions/20261119-channel-project-link.md "Error order") ----------------
/** Steps 4-6 of the error order for a project: missing, unreadable or in the trash 404 (the missing project's body);
 * personal or older (outside projects/<name>) 409 project_not_linkable; no write 403 project_write_needed. */
export function checkProject(db: Database, rules: RuleSet, who: Principal, projectId: string, locale: Locale): LinkedProjectRow {
  const p = db.query('SELECT id, name, folder_path, trashed_with, created_by FROM projects WHERE id = ?').get(projectId) as LinkedProjectRow | null
  if (!p || p.trashed_with !== null || !atLeast(rules.access(who, p.folder_path.split('/')), 'read')) return fail('not_found')
  if (!linkableFolder(p.folder_path)) fail('conflict', tr('projectNotLinkable', locale), { params: { reason: 'project_not_linkable' } })
  if (rules.isGuest(who) || !atLeast(rules.access(who, p.folder_path.split('/')), 'write')) fail('forbidden', tr('projectWriteNeeded', locale), { params: { reason: 'project_write_needed' } })
  return p
}

/** Step 3: the room is a private channel (the caller checked it is theirs). */
export function checkPrivateChannel(room: RoomRow, locale: Locale): void {
  if (!isPrivateChannelRow(room)) fail('conflict', tr('roomNotPrivateChannel', locale), { params: { reason: 'not_private_channel' } })
}

/** One answer for a project that has a channel, for everyone: the channel is never named. */
export const projectHasChannel = (locale: Locale): never => fail('conflict', tr('projectHasChannel', locale), { params: { reason: 'project_has_channel' } })

/**
 * Inside the caller's immediate transaction: steps 3-8 again with a fresh RuleSet, the inactive rows of either side go,
 * the row is written and the audit row too. Returns 'same' when the room is linked to this project already (nothing
 * written), 'linked' (with `replaced`) otherwise. The caller writes the event line and tells the members after commit.
 * The unique index settles a race: the second write fails as project_has_channel.
 */
export function linkInTx(db: Database, o: { userId: string; room: RoomRow; projectId: string; via: 'channel' | 'project' | 'create'; locale: Locale }): { state: 'same' } | { state: 'linked'; replaced: boolean } {
  const room = db.query('SELECT * FROM rooms WHERE id = ?').get(o.room.id) as RoomRow | null
  if (!room || room.archived_at || !db.query('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(room.id, o.userId)) return fail('not_found')
  checkPrivateChannel(room, o.locale)
  const who = loadPrincipal(db, o.userId)
  if (!who) return fail('forbidden')
  const rules = RuleSet.load(db)
  if (rules.isGuest(who)) return fail('forbidden')
  const p = checkProject(db, rules, who, o.projectId, o.locale)
  const current = activeProjectOf(db, room.id)
  if (current?.id === p.id) return { state: 'same' }
  if (current) fail('conflict', tr('channelLinked', o.locale), { params: { reason: 'channel_linked' } })
  if (activeRoomOf(db, p.id)) projectHasChannel(o.locale)
  // an inactive row on either side never blocks a new link: it goes in the same write
  const replaced = db.query('DELETE FROM room_project_links WHERE room_id = ? OR project_id = ?').run(room.id, p.id).changes > 0
  try {
    db.query('INSERT INTO room_project_links (room_id, project_id, linked_by, linked_at) VALUES (?, ?, ?, ?)').run(room.id, p.id, o.userId, new Date().toISOString())
  } catch (e) {
    if (/UNIQUE constraint failed/.test(String((e as Error)?.message ?? e))) projectHasChannel(o.locale)
    throw e
  }
  audit(db, { actor: o.userId, action: 'project.channel_link', target: p.id, detail: { room: roomAuditRef(room), via: o.via, replaced } })
  return { state: 'linked', replaced }
}

/** Inside the caller's transaction: a person's unlink, after the checks (steps 1-2 by the caller, no active link: 204,
 * then 4 and 6). Returns the project unlinked, or null when there was no active link (nothing done). */
export function unlinkInTx(db: Database, o: { userId: string; room: RoomRow; via: 'channel' | 'project'; locale: Locale }): LinkedProjectRow | null {
  const p = activeProjectOf(db, o.room.id)
  if (!p) return null
  const who = loadPrincipal(db, o.userId)
  if (!who) return fail('forbidden')
  const rules = RuleSet.load(db)
  if (rules.isGuest(who)) return fail('forbidden')
  checkProject(db, rules, who, p.id, o.locale)
  db.query('DELETE FROM room_project_links WHERE room_id = ?').run(o.room.id)
  audit(db, { actor: o.userId, action: 'project.channel_unlink', target: p.id, detail: { room: roomAuditRef(o.room), via: o.via, replaced: false } })
  return p
}

/** Inside the caller's transaction: the link of a room that is archived (its last person left), or of a project deleted
 * for good, goes, audited by the system. Returns the rooms whose link went (for room.updated). */
export function dropLinksInTx(db: Database, by: { roomId: string } | { projectId: string }): string[] {
  const rows = db.query(`SELECT l.room_id, l.project_id, r.kind FROM room_project_links l JOIN rooms r ON r.id = l.room_id WHERE ${'roomId' in by ? 'l.room_id' : 'l.project_id'} = ?`)
    .all('roomId' in by ? by.roomId : by.projectId) as { room_id: string; project_id: string; kind: RoomRow['kind'] }[]
  for (const r of rows) {
    db.query('DELETE FROM room_project_links WHERE room_id = ?').run(r.room_id)
    audit(db, { actor: null, action: 'project.channel_unlink', target: r.project_id, detail: { room: roomAuditRef({ id: r.room_id, kind: r.kind }), via: 'roomId' in by ? 'room_archived' : 'project_deleted', replaced: false } })
  }
  return rows.map((r) => r.room_id)
}

// ---------------- live (docs/decisions/20261119-channel-project-link.md D4 "Live") ----------------
/** The linked private channels these people sit in now, as `<roomId> <userId>` (read before an access change). One query
 * per 500 people. Never throws. */
export function linkedRoomSeats(db: Database, userIds: readonly string[]): Set<string> {
  const out = new Set<string>()
  try {
    for (let i = 0; i < userIds.length; i += 500) {
      const part = userIds.slice(i, i + 500)
      const rows = db.query(`SELECT m.room_id, m.user_id FROM room_members m JOIN room_project_links l ON l.room_id = m.room_id JOIN rooms r ON r.id = m.room_id
        WHERE r.kind = 'group' AND r.archived_at IS NULL AND m.user_id IN (${part.map(() => '?').join(',')})`).all(...part) as { room_id: string; user_id: string }[]
      for (const r of rows) out.add(`${r.room_id} ${r.user_id}`)
    }
  } catch { /* nobody is told */ }
  return out
}

/** For the live pass: who in `seats` whose answer for the linked project's folder (open it: Room.project; save into it:
 * canSave) differs before and after an access change, by room. Only rooms whose project folder is at, under or above a
 * changed folder. */
export function linkedSightFlips(db: Database, before: { principals: readonly Principal[]; rules: RuleSet }, after: { principals: readonly Principal[]; rules: RuleSet }, changed: readonly string[], seats: ReadonlySet<string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  if (!changed.length || !seats.size) return out
  const near = (f: string, p: string) => p === '' || f === p || f.startsWith(p + '/') || p.startsWith(f + '/')
  const byRoom = new Map<string, string[]>()
  for (const seat of seats) {
    const [roomId, userId] = seat.split(' ') as [string, string]
    ;(byRoom.get(roomId) ?? byRoom.set(roomId, []).get(roomId)!).push(userId)
  }
  const stillIn = db.query('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?')
  const was = new Map(before.principals.map((p) => [p.id, p])), now = new Map(after.principals.map((p) => [p.id, p]))
  for (const [roomId, users] of byRoom) {
    const p = activeProjectOf(db, roomId)
    if (!p || !changed.some((c) => near(p.folder_path, c))) continue
    const flipped = new Set<string>()
    for (const u of users) {
      const pb = was.get(u), pa = now.get(u)
      if (!pb || !pa || !stillIn.get(roomId, u)) continue
      const a = sight(before.rules, pb, p.folder_path), b = sight(after.rules, pa, p.folder_path)
      if (a.opens !== b.opens || a.writes !== b.writes) flipped.add(u)
    }
    if (flipped.size) out.set(roomId, flipped)
  }
  return out
}
