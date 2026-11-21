// The project link of a room (migration 427, docs/decisions/20261119-channel-project-link.md, retired by
// docs/decisions/20261120-project-is-room.md): what is left of 0.5.21's "private channel linked to a project" are the
// read helpers a project's own chat room uses (rooms/project-room.ts). A row counts here only as an ACTIVE project room:
// mode 'room' (a 'linked' row is settled at start, rooms/project-room.ts settleLinkedInTx), the room a named group room
// that is not archived, the project not in the trash and on a folder exactly projects/<name> (the members-only zone).
// Link, unlink, Create a channel and Undo of Save to project are gone (their endpoints answer 410).
//
// Who sees what: Room.project only for a viewer who can open the project now (read on its folder). The event lines
// name the project only to a viewer who can open it. Audit rows name the project only, never the room (store.ts
// roomAuditRef: a group room by its kind).
import type { Database } from 'bun:sqlite'
import { Uuid7, type Room } from '@mycel/shared/api'
import { CHAT_FILES_FOLDER } from '@mycel/shared'
import { atLeast, inPlace, inProjectZone, loadPrincipal, RuleSet, type Principal } from '../policy/access'
import { isPersonalFolder } from '../chat/projects'
import { audit } from '../admin/audit'
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

/** The project whose chat room this is, while it is active; else null. */
export function activeProjectOf(db: Database, roomId: string): LinkedProjectRow | null {
  const r = db.query(`SELECT ${PROJECT_COLS}, r.kind, r.name AS room_name, r.archived_at FROM room_project_links l JOIN rooms r ON r.id = l.room_id JOIN projects p ON p.id = l.project_id WHERE l.room_id = ? AND l.mode = 'room'`)
    .get(roomId) as (LinkedProjectRow & { kind: RoomRow['kind']; room_name: string | null; archived_at: string | null }) | null
  if (!r || !isPrivateChannelRow({ kind: r.kind, name: r.room_name, archived_at: r.archived_at }) || !projectLinkable(r)) return null
  return { id: r.id, name: r.name, folder_path: r.folder_path, trashed_with: r.trashed_with, created_by: r.created_by }
}

/** The project's chat room, while it is active; else null. */
export function activeRoomOf(db: Database, projectId: string): RoomRow | null {
  const r = db.query(`SELECT r.*, p.folder_path, p.trashed_with FROM room_project_links l JOIN rooms r ON r.id = l.room_id JOIN projects p ON p.id = l.project_id WHERE l.project_id = ? AND l.mode = 'room'`)
    .get(projectId) as (RoomRow & { folder_path: string; trashed_with: string | null }) | null
  if (!r || !isPrivateChannelRow(r) || !projectLinkable(r)) return null
  const { folder_path: _f, trashed_with: _t, ...room } = r
  return room
}

/** The rooms linked to these projects (any row, active or not, either mode): who to tell when a project changes. */
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

/** Room.project for one viewer (store.ts roomOut): the project of an active project room when they can open it now. `rules`: the
 * caller's set when it judges many rooms at once (rulesOnce). */
export function projectForViewer(db: Database, room: Pick<RoomRow, 'id' | 'kind' | 'name' | 'archived_at'>, userId: string, rules?: () => RuleSet, memberCount?: number): Room['project'] | undefined {
  if (!isPrivateChannelRow(room)) return undefined
  const p = activeProjectOf(db, room.id)
  if (!p) return undefined
  const who = loadPrincipal(db, userId)
  if (!who) return undefined
  const set = rules ? rules() : RuleSet.load(db)
  const s = sight(set, who, p.folder_path)
  if (!s.opens) return undefined
  // its members are the project's people (the sync keeps them so): the last one cannot leave (chat/project-leave.ts)
  const n = memberCount ?? (db.query('SELECT COUNT(*) n FROM room_members WHERE room_id = ?').get(room.id) as { n: number }).n
  const same = sameAsGroupFor(db, room.id, userId, rules)
  return { id: p.id, name: p.name, folderPath: p.folder_path, canSave: s.writes, room: true, attach: attachFor(set, who, p.folder_path), leave: n > 1 ? 'yes' : 'last', ...(same ? { sameAsGroup: same } : {}) }
}

type SameAsGroup = NonNullable<NonNullable<Room['project']>['sameAsGroup']>
/** sameAsGroupOf per pass: a list of rooms or a room.updated fan-out hands every roomOut the same `rules` closure
 * (store.ts rulesOnce), so the match is worked out once per room in it, not again for each member. */
const samePass = new WeakMap<object, Map<string, SameAsGroup | null>>()

/** Room.project.sameAsGroup for one viewer: the department whose live team room has exactly this project room's active
 * members, told only to a viewer who is in that team room (they all are, by definition). */
export function sameAsGroupFor(db: Database, roomId: string, userId: string, pass?: object): SameAsGroup | undefined {
  let cache = pass ? samePass.get(pass) : undefined
  if (pass && !cache) { cache = new Map(); samePass.set(pass, cache) }
  let same = cache?.get(roomId)
  if (same === undefined) { same = sameAsGroupOf(db, roomId); cache?.set(roomId, same) }
  if (!same) return undefined
  return db.query('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(same.roomId, userId) ? same : undefined
}

const ACTIVE_MEMBERS = (a: string) => `SELECT ${a}.user_id FROM room_members ${a} JOIN users u ON u.id = ${a}.user_id AND u.status = 'active' AND u.deleted_at IS NULL WHERE ${a}.room_id = ?`

/** The department (a group with a live team room) whose room's active members are exactly this room's, or null. Only
 * team rooms with the same number of active members are compared (one query for the candidates, one per candidate);
 * several: the first by name. */
export function sameAsGroupOf(db: Database, roomId: string): SameAsGroup | null {
  const n = (db.query(`SELECT COUNT(*) n FROM (${ACTIVE_MEMBERS('m')})`).get(roomId) as { n: number }).n
  if (!n) return null
  const candidates = db.query(`SELECT r.id room_id, g.id group_id, g.name FROM rooms r JOIN groups g ON g.id = r.group_id
    WHERE r.kind = 'team' AND r.archived_at IS NULL AND (SELECT COUNT(*) FROM room_members t JOIN users u ON u.id = t.user_id AND u.status = 'active' AND u.deleted_at IS NULL WHERE t.room_id = r.id) = ?
    ORDER BY g.name, g.id`).all(n) as { room_id: string; group_id: string; name: string }[]
  const shared = db.query(`SELECT COUNT(*) n FROM (${ACTIVE_MEMBERS('a')}) x WHERE x.user_id IN (${ACTIVE_MEMBERS('b')})`)
  for (const c of candidates) {
    // (ids the API cannot carry, a hand-made or test row: never a 500 for the whole room)
    if (!Uuid7.safeParse(c.group_id).success || !Uuid7.safeParse(c.room_id).success) continue
    if ((shared.get(roomId, c.room_id) as { n: number }).n === n) return { groupId: c.group_id, name: c.name, roomId: c.room_id }
  }
  return null
}

/** Room.project.attach: write on the project folder and on its Chat attachments folder by any language's name (the
 * upload reuses the one there: uploads/shared-chat.ts sharedUploadPlace, which checks again), guests included. */
function attachFor(rules: RuleSet, who: Principal, folder: string): 'ok' | 'read_only' | 'folder' {
  const segs = folder.split('/')
  if (!atLeast(rules.access(who, segs), 'write')) return 'read_only'
  return Object.values(CHAT_FILES_FOLDER).every((name) => atLeast(rules.access(who, [...segs, name]), 'write')) ? 'ok' : 'folder'
}

/** How an event line names a project to one viewer (eventProjectsFor). */
export type EventProjectView =
  /** they can open it now: its name now and a link (and its folder's name when it is not the name) */
  | { state: 'open'; id: string; name: string; folder?: string }
  /** in the trash, for one of its people (read on its folder by its own rules, as if it were back): its name now, plain text, no link */
  | { state: 'trash'; name: string }
  /** deleted for good: "a deleted project", told to everyone in the room */
  | { state: 'deleted' }
  /** they cannot open it (never could, or no longer can): "a project", never its name, never a later rename */
  | { state: 'hidden' }

/** The one resolver of the project an event line names (rooms/store.ts eventOut, every project line kind), read at
 * render time for one viewer: the project's name as it is now, and only to someone who may see it. An outsider cannot
 * tell a project in the trash from one they cannot open. One RuleSet for a page. */
export function eventProjectsFor(db: Database, projectIds: readonly string[], userId: string): Map<string, EventProjectView> {
  const out = new Map<string, EventProjectView>()
  const ids = [...new Set(projectIds)]
  if (!ids.length || !userId) return out
  const who = loadPrincipal(db, userId)
  // an inactive account sees nothing (the room refuses them first; this is the fallback)
  if (!who) { for (const id of ids) out.set(id, { state: 'hidden' }); return out }
  const rules = RuleSet.load(db)
  const rows = new Map((db.query(`SELECT id, name, folder_path, trashed_with FROM projects WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as LinkedProjectRow[]).map((r) => [r.id, r]))
  for (const id of ids) {
    const r = rows.get(id)
    if (!r) { out.set(id, { state: 'deleted' }); continue }
    const segs = r.folder_path.split('/')
    const folder = segs[segs.length - 1]
    if (r.trashed_with === null) { out.set(id, atLeast(rules.access(who, segs), 'read') ? { state: 'open', id: r.id, name: r.name, ...(folder && folder !== r.name ? { folder } : {}) } : { state: 'hidden' }); continue }
    // in the trash: its name only for one of its people, by its folder's own rules as if it were back, while the folder
    // is still in the files trash (chat/shared.ts memberWhileTrashed: "A team project in the trash: its members keep its
    // card"); a purged folder or a personal project: nobody
    out.set(id, trashedReader(db, r, who, segs) ? { state: 'trash', name: r.name } : { state: 'hidden' })
  }
  return out
}

/** One of a trashed project's people (chat/shared.ts memberWhileTrashed, without the chat runtime): read on its folder
 * by the rules parked with it in the files trash, put back at its old path. */
function trashedReader(db: Database, r: LinkedProjectRow, who: Principal, segs: string[]): boolean {
  if (isPersonalFolder(r.folder_path)) return false
  const t = db.query('SELECT original_path, storage_path FROM trash_items WHERE id = ? AND restored_at IS NULL').get(r.trashed_with) as { original_path: string; storage_path: string } | null
  if (!t) return false
  return atLeast(RuleSet.fromDb(db, { mapPath: inPlace(t.storage_path, t.original_path) }).access(who, segs), 'read')
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

// ---------------- live: Room.project follows an access change ----------------
/** The project rooms these people sit in now, as `<roomId> <userId>` (read before an access change). One query
 * per 500 people. Never throws. */
export function linkedRoomSeats(db: Database, userIds: readonly string[]): Set<string> {
  const out = new Set<string>()
  try {
    for (let i = 0; i < userIds.length; i += 500) {
      const part = userIds.slice(i, i + 500)
      const rows = db.query(`SELECT m.room_id, m.user_id FROM room_members m JOIN room_project_links l ON l.room_id = m.room_id JOIN rooms r ON r.id = m.room_id
        WHERE r.kind = 'group' AND r.archived_at IS NULL AND l.mode = 'room' AND m.user_id IN (${part.map(() => '?').join(',')})`).all(...part) as { room_id: string; user_id: string }[]
      for (const r of rows) out.add(`${r.room_id} ${r.user_id}`)
    }
  } catch { /* nobody is told */ }
  return out
}

/** For the live pass: who in `seats` whose answer for the room's project folder (open it: Room.project; save into it:
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
