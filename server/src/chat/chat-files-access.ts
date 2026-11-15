// Who sees the files kept with a chat (chat/chat-files.ts), apart from the store so the chat store and the read scope
// can ask without loading the upload code.
import type { Database } from 'bun:sqlite'
import { inPeopleAudience, isPeopleRow } from './chat-audience'

type ChatGate = { id: string; user_id: string; people_shared_at: string | null; project_id: string | null; deleted_at: string | null; room_id: string | null }

/** Does `userId` see the files of this chat now: a chat shared with people they are in (not in the trash, unless it is
 * theirs), or their own chat (one made private again keeps its files for its creator, whatever audience it got later;
 * the trash too)? An inactive account: no. */
export function seesChatFiles(db: Database, userId: string, chatId: string): boolean {
  const c = db.query('SELECT id, user_id, people_shared_at, project_id, deleted_at, room_id FROM chats WHERE id = ?').get(chatId) as ChatGate | null
  if (!c || c.room_id) return false
  if (isPeopleRow(c)) return inPeopleAudience(db, c, userId) && (!c.deleted_at || c.user_id === userId)
  return c.user_id === userId && !!db.query("SELECT 1 FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL").get(userId)
}
