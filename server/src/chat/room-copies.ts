// A room post is a copy made when it was sent (QA TC-r2u-21, S-111): 박준호 changed a quote to 14 days, the copy in the
// room stayed at 30, and the AI told him the room's file "may show the change". The room keeps the copy, as Slack does;
// what was wrong is the AI's claim. After a tool call changes a team file that a room message I can see carries as a
// copy ("대화방에 보내기" / post_to_room attaching it, a phone's team pick), the AI is told so in the tool result: the room
// still shows the copy from when it was sent, and it offers to post the new version. A project room's file kept in the
// team folder (room_file_refs) is the file itself, not a copy: it is not named here.
import type { Database } from 'bun:sqlite'
import type { Locale } from '@mycel/shared/api'
import { memberRow, roomRow, SEE_MEMBER_SQL } from '../rooms/store'
import { roomTitleFor } from './post-to-room'

/** At most this many changed files are looked up per tool call, and this many rooms named per file. */
const PATHS_MAX = 5
const ROOMS_MAX = 3

export interface RoomCopy { path: string; rooms: { id: string; title: string; at: string }[] }

/** The rooms (I am in) where a message I can see carries a copy of one of `paths`, made before now. */
export function roomCopiesOf(db: Database, userId: string, paths: readonly string[], locale: Locale): RoomCopy[] {
  const out: RoomCopy[] = []
  for (const rel of [...new Set(paths)].slice(0, PATHS_MAX)) {
    // (only messages I see now, by the room's own rule: SEE_MEMBER_SQL on my membership row `mm`)
    const rows = db.query(`SELECT m.room_id, MAX(m.created_at) AS at FROM room_messages m JOIN room_members mm ON mm.room_id = m.room_id AND mm.user_id = ?
      JOIN rooms r ON r.id = m.room_id AND r.archived_at IS NULL
      WHERE m.deleted_at IS NULL AND ${SEE_MEMBER_SQL} AND (
        (m.source_scope IS NOT NULL AND json_valid(m.source_scope) AND EXISTS (SELECT 1 FROM json_each(m.source_scope, '$.attached') a WHERE json_extract(a.value, '$.path') = ?))
        OR EXISTS (SELECT 1 FROM room_files f WHERE f.message_id = m.id AND f.team_path = ? AND NOT EXISTS (SELECT 1 FROM room_file_refs rr WHERE rr.room_file_id = f.id)))
      GROUP BY m.room_id ORDER BY at DESC LIMIT ?`).all(userId, rel, rel, ROOMS_MAX) as { room_id: string; at: string }[]
    const rooms = rows.flatMap((r) => {
      const room = roomRow(db, r.room_id), me = memberRow(db, r.room_id, userId)
      return room && me ? [{ id: room.id, title: roomTitleFor(db, room, me, locale), at: r.at }] : []
    })
    if (rooms.length) out.push({ path: rel, rooms })
  }
  return out
}

/** The tool result's line for the copies of files this call changed, or ''. `shared`: a shared chat, where everyone
 * reads the answer: the rooms are not named (a group chat's title is its members' names). */
export function roomCopyNote(copies: readonly RoomCopy[], shared: boolean): string {
  if (!copies.length) return ''
  const parts = copies.map((c) => `${c.path} (${shared ? `${c.rooms.length} room${c.rooms.length === 1 ? '' : 's'}` : c.rooms.map((r) => `${r.title}, sent ${r.at.slice(0, 16).replace('T', ' ')} UTC`).join('; ')})`)
  return `Posted earlier as a copy: ${parts.join('; ')}. A room post carries a copy made when it was sent: the room still shows that old version, and this change does not reach it. Tell the user so in one plain sentence (never say the room's copy updates or may show the change), and ask whether to post the new version there; if they say yes, call post_to_room with a link to the file, which goes as a new copy.`
}
