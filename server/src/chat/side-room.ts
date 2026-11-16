// The room side chat (✦ Trina, docs/DECISIONS.md "Trina side chat"): a person's own chat opened from a room's side
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
  return { id: r.id, kind: r.kind, name: r.kind === 'dm' ? null : r.name || groupName(db, r), saveIn: saveInFor(db, r, userId) }
}

/** Where the AI saves what comes from the room when the person names no place (docs/decisions/
 * 20261116-room-link-save-one-prompt.md, QA TC-3833): a team room's group folder (its people are the room's), the
 * Everyone room's team-wide folder (shared/), and for a 1:1 or group chat the person's own folder (no team folder holds
 * just those people; the answer's "Send" button sends the file with it). */
function saveInFor(db: Database, r: { kind: SideRoomPrompt['kind']; group_id: string | null }, userId: string): string {
  if (r.kind === 'team' && r.group_id) {
    const f = db.query('SELECT f.path FROM groups g JOIN folders f ON f.id = g.folder_id WHERE g.id = ?').get(r.group_id) as { path: string } | null
    if (f?.path) return f.path
  }
  if (r.kind === 'all') return 'shared'
  return `users/${userId}`
}
