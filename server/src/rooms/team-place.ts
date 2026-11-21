// Does a room keep its files in a team folder (docs/AGENTS/plan/20261121-0619-structure-polish.md A and B)? A file
// sent there from the computer goes to that folder's Chat attachments (a room_file_refs row), and a file that stays in
// room storage there is the exception: "Only in this conversation" (RoomFile.roomOnly), listed in the room's Files list
// (Room.roomFiles), which otherwise has no list of its own. The one place this is decided:
//   - a project's chat room (rooms/project-room.ts): yes;
//   - a department's team room: while its group has a folder that is not in the trash (groupFolderOf);
//   - every other room: no, its files are the room's own.
// Open moves (rooms/file-moves.ts): a file still moving to the project's folder is neither "only in this conversation"
// nor in the room's Files list; it is on its way.
//
// Where a file sent from the computer in such a room goes (teamPlaceFor, rooms/files.ts createInTeamFolder): a
// project's chat room puts it in the project's Chat attachments folder (docs/decisions/20261120-project-is-room.md D3),
// a department's team room (kind 'team', group_id) in `<group folder>/Chat attachments/`. A team room never refuses a
// file for its folder: its upload stays in room storage (teamPlaceFor answers null) when
//   - the group has no folder, its folder is not there (deleted, in the trash: its row is parked under .system/), or
//     safe operations are on;
//   - the group folder was moved inside projects/<name>/: that project's guests may read it, and nothing here counts
//     guests;
//   - the uploader may not write the Chat attachments folder (or make it): a read-only person rule;
//   - the folder is read by someone outside the room (wider): an `everyone` rule or a role rule (members) at read or
//     above, another group with an active member outside the room, a person outside the room. Only the rules on the
//     walk from Chat attachments up to the nearest limited folder (the root, `groups/`, the group folder) are read,
//     never every account; the owner and admins read every folder outside users/ and are not counted (accepted by the
//     owner on 2026-11-21: they can open a department room's new uploads in Files). The same spirit as the file mover's
//     'wider' (rooms/file-moves.ts: Chat attachments read by nobody beyond the project's people);
//   - Chat attachments was narrowed: a room member cannot read it;
//   - the bytes are on the download-only list (the caller: they never become a team file).
// A copy fromTeamFile makes (answer-share, a phone's team pick) is room storage by its caller (o.roomStorage).
import type { Database } from 'bun:sqlite'
import { PRODUCT } from '@mycel/shared'
import type { AppContext } from '../context'
import { personLocale } from '../files/media-text'
import { atLeast, inProjectZone, type Principal, type RuleSet } from '../policy/access'
import { FileError, httpError } from '../team-files/errors'
import { chatAttachmentsPlace, sharedUploadPlace, type SharedUploadPlace, type UploadFiles } from '../uploads/shared-chat'
import { isProjectRoom, projectRoomLink } from './project-room'
import type { RoomRow } from './store'

/** Does this room keep its files in a team folder (so a room-stored file there is the exception)? */
export function roomHasTeamPlace(db: Database, room: Pick<RoomRow, 'id' | 'kind'> & { group_id?: string | null }): boolean {
  if (room.kind === 'group') return isProjectRoom(db, room.id)
  if (room.kind !== 'team') return false
  const groupId = room.group_id !== undefined ? room.group_id : (db.query('SELECT group_id FROM rooms WHERE id = ?').get(room.id) as { group_id: string | null } | null)?.group_id ?? null
  return groupFolderOf(db, { kind: 'team', group_id: groupId }) !== null
}

/** SQL on room_files `f`: no open move of the file (rooms/file-moves.ts OPEN_STATES). */
export const NOT_MOVING_SQL = "NOT EXISTS (SELECT 1 FROM room_file_moves mv WHERE mv.room_file_id = f.id AND mv.state IN ('pending', 'placing', 'cleanup'))"
/** SQL on room_files `f`: kept in room storage (no room_file_refs row). */
export const ROOM_STORED_SQL = 'NOT EXISTS (SELECT 1 FROM room_file_refs rr WHERE rr.room_file_id = f.id)'

/** Room.roomFiles: a room with a team place that still holds sent files of its own (room storage, on a message that is
 * not deleted and is for the whole room, and not on its way to the team folder). */
export function hasRoomStoredFiles(db: Database, room: Pick<RoomRow, 'id' | 'kind'>): boolean {
  if (!roomHasTeamPlace(db, room)) return false
  return !!db.query(`SELECT 1 FROM room_files f INDEXED BY room_files_by_room JOIN room_messages m ON m.id = f.message_id AND m.room_id = f.room_id
    WHERE f.room_id = ? AND f.message_id IS NOT NULL AND m.deleted_at IS NULL AND m.event IS NULL AND m.visibility = 'room' AND ${ROOM_STORED_SQL} AND ${NOT_MOVING_SQL} LIMIT 1`).get(room.id)
}

/** Room.filesMoving: the room has files still moving to its project's Chat attachments. */
export function filesMovingIn(db: Database, roomId: string): boolean {
  return !!db.query("SELECT 1 FROM room_file_moves WHERE room_id = ? AND state IN ('pending', 'placing', 'cleanup') LIMIT 1").get(roomId)
}

/** The room-stored files among `ids` that are "Only in this conversation" in their room (RoomFile.roomOnly): not on
 * their way. `roomOf`: each id's room. */
export function roomOnlyAmong(db: Database, rows: readonly { id: string; room_id: string }[], kindOf: (roomId: string) => RoomRow['kind'] | null): Set<string> {
  const out = new Set<string>()
  const placed = new Map<string, boolean>()
  const want: string[] = []
  for (const r of rows) {
    let yes = placed.get(r.room_id)
    if (yes === undefined) { const k = kindOf(r.room_id); yes = !!k && roomHasTeamPlace(db, { id: r.room_id, kind: k }); placed.set(r.room_id, yes) }
    if (yes) want.push(r.id)
  }
  if (!want.length) return out
  for (let i = 0; i < want.length; i += 500) {
    const part = want.slice(i, i + 500)
    const moving = new Set((db.query(`SELECT room_file_id FROM room_file_moves WHERE state IN ('pending', 'placing', 'cleanup') AND room_file_id IN (${part.map(() => '?').join(',')})`).all(...part) as { room_file_id: string }[]).map((x) => x.room_file_id))
    for (const id of part) if (!moving.has(id)) out.add(id)
  }
  return out
}

/** Where an upload in this room goes: the Chat attachments folder (team-relative) and whether it is there yet. */
export interface TeamPlace extends SharedUploadPlace { via: 'project' | 'group' }

const filesOf = (ctx: AppContext): UploadFiles => ({ fx: ctx.files.fx, rules: () => ctx.files.rules(), principal: (id) => ctx.files.principal(id) })

/** A team room's group folder path while the group has one that is not in the trash (a trashed folder's row is parked
 * under .system/); else null. The database only: teamPlaceFor checks the disk. */
export function groupFolderOf(db: Database, room: Pick<RoomRow, 'kind' | 'group_id'>): string | null {
  if (room.kind !== 'team' || !room.group_id) return null
  const p = (db.query('SELECT f.path FROM groups g JOIN folders f ON f.id = g.folder_id WHERE g.id = ?').get(room.group_id) as { path: string } | null)?.path
  if (!p || p.split('/')[0] === PRODUCT.systemDir) return null
  return p
}

/**
 * Where `userId`'s computer upload in this room goes (rooms/files.ts create), or null for room storage.
 * A project's chat room: the project's place, with its refusals (403 shared_upload_read_only, 409 safe_ops, 404).
 * A team room: the group's place when it fits (the list at the top of this file), else null; never a refusal.
 */
export function teamPlaceFor(ctx: AppContext, roomId: string, userId: string): TeamPlace | null {
  const db = ctx.db
  const link = projectRoomLink(db, roomId)
  if (link) {
    try { return { ...sharedUploadPlace(db, filesOf(ctx), userId, { project_id: link.project_id }), via: 'project' } } catch (e) {
      if (e instanceof FileError && e.params?.reason === 'shared_upload_read_only') throw httpError('forbidden', 'sharedUploadReadOnly', personLocale(db, userId), undefined, { reason: 'shared_upload_read_only' })
      throw e
    }
  }
  const room = db.query('SELECT kind, group_id, archived_at FROM rooms WHERE id = ?').get(roomId) as Pick<RoomRow, 'kind' | 'group_id' | 'archived_at'> | null
  if (!room || room.archived_at) return null
  const folder = groupFolderOf(db, room)
  if (!folder) return null
  // a group folder an admin moved inside projects/<name>/: guests of that project may read it (their policy reaches the
  // projects zone, and the checks below count no guests), so its room's uploads stay in room storage
  if (inProjectZone(folder.split('/'))) return null
  let place: SharedUploadPlace
  // not there, not a folder, safe operations, the uploader may not write there: room storage
  try { place = chatAttachmentsPlace(db, filesOf(ctx), folder, userId) } catch { return null }
  const rules = ctx.files.rules()
  if (widerThanRoom(db, rules, roomId, room.group_id!, place.folder)) return null
  if (!membersRead(db, rules, roomId, room.group_id!, place.folder)) return null
  return { ...place, via: 'group' }
}

/** The rules that reach `folder` (team-relative): those on it and on the folders above it, up to and including the
 * nearest limited one, that give at least read. */
function reachingRules(rules: RuleSet, folder: string): { subjectType: string; subjectId: string | null }[] {
  const segs = folder.split('/')
  const out: { subjectType: string; subjectId: string | null }[] = []
  for (let len = segs.length; len >= 0; len--) {
    const key = segs.slice(0, len).join('/')
    for (const r of rules.storedAt(key)) if (r.access !== 'none') out.push({ subjectType: r.subjectType, subjectId: r.subjectId })
    if (rules.limitedAt(key)) break
  }
  return out
}

/** Someone who is not the owner or an admin, is active, is not a guest and is not in the room (the SQL's tail). */
const OUTSIDER = `u.status = 'active' AND u.deleted_at IS NULL AND u.guest = 0 AND u.role NOT IN ('owner', 'admin')
  AND NOT EXISTS (SELECT 1 FROM room_members m WHERE m.room_id = ? AND m.user_id = u.id)`

/** Is `folder` read by someone outside the room (the rule subjects only: one query per rule at most, each indexed). */
export function widerThanRoom(db: Database, rules: RuleSet, roomId: string, groupId: string, folder: string): boolean {
  const anyone = db.query(`SELECT 1 FROM users u WHERE ${OUTSIDER} LIMIT 1`)
  const member = db.query(`SELECT 1 FROM users u WHERE u.role = 'member' AND ${OUTSIDER} LIMIT 1`)
  const inGroup = db.query(`SELECT 1 FROM group_members g JOIN users u ON u.id = g.user_id WHERE g.group_id = ? AND ${OUTSIDER} LIMIT 1`)
  // (a person rule counts a guest too: defence in depth, though a guest's policy never reads outside projects/)
  const person = db.query(`SELECT 1 FROM users u WHERE u.id = ? AND u.status = 'active' AND u.deleted_at IS NULL AND u.role NOT IN ('owner', 'admin')
    AND NOT EXISTS (SELECT 1 FROM room_members m WHERE m.room_id = ? AND m.user_id = u.id)`)
  for (const r of reachingRules(rules, folder)) {
    switch (r.subjectType) {
      case 'everyone': if (anyone.get(roomId)) return true; break
      // a rule for admins or the owner adds no one (they read it anyway); a guest's role rule never applies outside
      // projects/ (policy/access.ts)
      case 'role': if (r.subjectId === 'member' && member.get(roomId)) return true; break
      // the group itself: its active people are the room's (rooms/service.ts sync)
      case 'group': if (r.subjectId && r.subjectId !== groupId && inGroup.get(r.subjectId, roomId)) return true; break
      case 'user': if (r.subjectId && person.get(r.subjectId, roomId)) return true; break
    }
  }
  return false
}

/** Does every member of the room read `folder` now. The group's own rule reaching it answers for all of them (they are
 * its people); else each member is judged, their principals read in two queries. */
export function membersRead(db: Database, rules: RuleSet, roomId: string, groupId: string, folder: string): boolean {
  if (reachingRules(rules, folder).some((r) => r.subjectType === 'group' && r.subjectId === groupId)) return true
  const people = db.query(`SELECT u.id, u.name, CASE WHEN u.guest = 1 THEN 'guest' ELSE u.role END AS role, u.status FROM room_members m JOIN users u ON u.id = m.user_id WHERE m.room_id = ?`)
    .all(roomId) as { id: string; name: string; role: Principal['role']; status: string }[]
  const groups = new Map<string, string[]>()
  for (const g of db.query('SELECT g.user_id, g.group_id FROM group_members g JOIN room_members m ON m.user_id = g.user_id AND m.room_id = ?').all(roomId) as { user_id: string; group_id: string }[]) {
    (groups.get(g.user_id) ?? groups.set(g.user_id, []).get(g.user_id)!).push(g.group_id)
  }
  const segs = folder.split('/')
  for (const p of people) {
    if (p.status !== 'active') continue
    if (!atLeast(rules.access({ id: p.id, name: p.name, role: p.role, groups: groups.get(p.id) ?? [] }, segs), 'read')) return false
  }
  return true
}
