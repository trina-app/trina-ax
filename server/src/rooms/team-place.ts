// Does a room keep its files in a team folder (docs/AGENTS/plan/20261121-0619-structure-polish.md A and B)? A file
// sent there from the computer goes to that folder's Chat attachments (a room_file_refs row), and a file that stays in
// room storage there is the exception: "Only in this conversation" (RoomFile.roomOnly), listed in the room's Files list
// (Room.roomFiles), which otherwise has no list of its own. The one place this is decided:
//   - a project's chat room (rooms/project-room.ts): yes;
//   - a department's team room: not yet (PR 2 of the plan extends this, with teamPlaceFor / chatAttachmentsPlace);
//   - every other room: no, its files are the room's own.
// Open moves (rooms/file-moves.ts): a file still moving to the project's folder is neither "only in this conversation"
// nor in the room's Files list; it is on its way.
import type { Database } from 'bun:sqlite'
import { isProjectRoom } from './project-room'
import type { RoomRow } from './store'

/** Does this room keep its files in a team folder (so a room-stored file there is the exception)? */
export function roomHasTeamPlace(db: Database, room: Pick<RoomRow, 'id' | 'kind'>): boolean {
  return room.kind === 'group' && isProjectRoom(db, room.id)
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
