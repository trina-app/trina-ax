// The app icon's number for a native push (docs/DECISIONS.md "The installed web app's icon badge"; the phone app sets the
// exact one itself while it is open): the one count n of the web app (web/src/store/sessionMarkers.ts currentCount), as
// the server knows it when the push goes out. The rooms that want the person (web/src/lib/rooms.ts roomWantsMe, from the
// same unread, mention, followed-thread and level data the rooms list sends) plus the AI chats that want them (their
// chat list's "?" and dots, chat/badge-chats.ts through the hook the chat routes set). A hidden room, a room at 끄기 and
// an archived room never count; neither does a muted one (its level is 끄기). Ids and counts only: the number is all
// that leaves the server.
import type { Database } from 'bun:sqlite'
import { PUSH_GATEWAY_MAX_BADGE } from '@mycel/shared/cloud-protocol'
import { roomLevel, type RoomNotifyLevel } from '@mycel/shared/api'
import { roomAiWaits, threadsUnread, unreadCount, type MemberRow, type RoomRow } from '../rooms/store'
import { ownLevel } from '../rooms/alerts'
import { getPreferences } from './preferences'

/** The room part of the web app's rule (roomWantsMe), on what the rooms list tells the app about the room. */
export interface RoomWants {
  hidden: boolean; aiWaits: boolean; level: RoomNotifyLevel
  unread: number; threadsUnread: number; mentioned: boolean
  /** my "replies in threads I follow" switch */
  threadReplies: boolean
}
/** Does this room want me (web/src/lib/rooms.ts roomWantsMe; a test keeps the two equal): never a room I hid; its AI
 * waiting on me; else something unread there is for me by my level: an @mention, a reply in a thread I follow (with the
 * switch on), or any message of a room at 모든 메시지. Nothing from a room at 끄기. */
export function roomWants(r: RoomWants): boolean {
  if (r.hidden) return false
  if (r.aiWaits) return true
  if (r.level === 'off' || r.unread + r.threadsUnread <= 0) return false
  return r.mentioned || (r.threadReplies && r.threadsUnread > 0) || (r.level === 'all' && r.unread > 0)
}

/** How many of `userId`'s rooms want them now (the rooms list's rooms: every room they are in that is not archived). */
export function roomsWantingMe(db: Database, userId: string): number {
  const prefs = getPreferences(db, userId)
  const rows = db.query(`SELECT r.*, m.user_id, m.joined_at, m.last_read_seq, m.visible_from_seq, m.history_from_seq, m.muted, m.notify_level, m.hidden_at,
    EXISTS (SELECT 1 FROM room_hidden_answers h WHERE h.room_id = m.room_id AND h.user_id = m.user_id) has_hidden FROM rooms r JOIN room_members m ON m.room_id = r.id
    WHERE m.user_id = ? AND r.archived_at IS NULL`).all(userId) as (RoomRow & MemberRow)[]
  let n = 0
  for (const r of rows) {
    // a hidden room counts for nothing; one whose AI waits on me counts without reading its messages
    if (r.hidden_at) continue
    const aiWaits = roomAiWaits(db, r.id, userId)
    const level = roomLevel(r.kind, ownLevel(r), prefs.roomLevel)
    if (!aiWaits && level === 'off') continue
    const viewer: MemberRow = { ...r, room_id: r.id }
    const unread = aiWaits ? { n: 0, mentioned: false } : unreadCount(db, r.id, viewer)
    const threads = aiWaits ? { n: 0, mentioned: false } : threadsUnread(db, r.id, viewer)
    if (roomWants({ hidden: false, aiWaits, level, unread: unread.n, threadsUnread: threads.n, mentioned: unread.mentioned || threads.mentioned, threadReplies: prefs.roomThreadReplies })) n++
  }
  return n
}

/** The chats' part, set by the chat routes (chat/badge-chats.ts): none before (a test without chats, a server starting). */
const chatsPart = new WeakMap<Database, (userId: string) => number>()
export function setBadgeChats(db: Database, count: (userId: string) => number) { chatsPart.set(db, count) }

/** The app icon's number for `userId` now: the rooms and the AI chats that want them, each once, at most
 * PUSH_GATEWAY_MAX_BADGE. A part that fails to read counts as 0 (the push still goes; the app sets the exact number when
 * it opens). */
export function badgeCount(db: Database, userId: string): number {
  let n = 0
  try { n += roomsWantingMe(db, userId) } catch { /* the rooms part could not be read */ }
  try { n += Math.max(0, Math.floor(chatsPart.get(db)?.(userId) ?? 0)) } catch { /* the chats part could not be read */ }
  return Math.min(PUSH_GATEWAY_MAX_BADGE, n)
}
