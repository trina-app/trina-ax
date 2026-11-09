// The room side chat (✦ Trina, docs/DECISIONS.md "트리나 사이드 채팅"): a person's own chat opened from a room's side
// panel (chats.side_room_id, migration 276). The turn tells the AI the room (chat/prompt.ts sideRoomSection) while the
// person is still in it and it is not archived; after that the chat is an ordinary chat of theirs.
import type { Database } from 'bun:sqlite'
import { groupName } from '../rooms/store'
import type { SideRoomPrompt } from './prompt'

/** The room this chat was opened from, while its person is still in that room and the room is not archived; else null.
 * Its name as the app shows it: its own, else its group's (a team room); null for a DM or a group chat without one. */
export function sideRoomOf(db: Database, chatId: string, userId: string): SideRoomPrompt | null {
  const r = db.query(`SELECT r.id, r.kind, r.name, r.group_id FROM chats c JOIN rooms r ON r.id = c.side_room_id AND r.archived_at IS NULL
    JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = c.user_id WHERE c.id = ? AND c.user_id = ?`).get(chatId, userId) as (SideRoomPrompt & { group_id: string | null }) | null
  if (!r) return null
  return { id: r.id, kind: r.kind, name: r.kind === 'dm' ? null : r.name || groupName(db, r) }
}
