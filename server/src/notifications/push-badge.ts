// The phone app's icon number for a push (docs/DECISIONS.md "휴대폰 앱 아이콘의 숫자"): the one count n the page shows
// (shared/src/api/attention.ts: the AI chats that need the person and the rooms that want them, each once), counted
// here for the recipient at send time, with the same rules and the same fields the page gets from GET /api/rooms and
// GET /api/chats. A number only: the push carries nothing about what it counts.
import { appBadgeOf, attentionCount, type MarkedChat } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { getChatRuntime } from '../chat/runtime'
import { isSharedRow, severalAuthors } from '../chat/shared'
import { CHAT_COLS, type ChatRow } from '../chat/store'
import { notInternalChat } from '../chat/internal-chats'
import { roomsOf } from '../rooms/service'

/** The page counts the chats of its first page of the list (my pinned ones, then web/src/store/chats.ts PAGE): the same
 * here. */
export const BADGE_CHATS = 50

/** The person's AI chats as their list shows them, newest first, with only what the markers read (chat/shared.ts
 * chatView: a shared chat's wait and unseen marker are its runner's and creator's). No runtime (a server part without
 * AI chats): none. */
function markedChats(ctx: AppContext, userId: string): (MarkedChat & { id: string })[] {
  let rt: ReturnType<typeof getChatRuntime>
  try { rt = getChatRuntime(ctx) } catch { return [] }
  const where = `room_id IS NULL AND ${notInternalChat(ctx.db)} AND deleted_at IS NULL
    AND (user_id = ? OR (shared_at IS NOT NULL AND id IN (SELECT chat_id FROM messages WHERE role = 'user' AND author_id = ?)))`
  // the list's first page: my pinned chats, then the newest others (routes/chats.ts pinsFirst)
  const pinned = `id IN (SELECT chat_id FROM chat_pins WHERE user_id = ?)`
  const rows = [
    ...ctx.db.query(`SELECT ${CHAT_COLS} FROM chats WHERE ${where} AND ${pinned}`).all(userId, userId, userId) as ChatRow[],
    ...ctx.db.query(`SELECT ${CHAT_COLS} FROM chats WHERE ${where} AND NOT ${pinned} ORDER BY updated_at DESC, id DESC LIMIT ?`).all(userId, userId, userId, BADGE_CHATS) as ChatRow[],
  ]
  return rows.map((r) => {
    const runState = rt.runState(r.id)
    if (!isSharedRow(r)) {
      const answers = severalAuthors(ctx.db, r.id) ? rt.store.answerState(r, r.user_id) : rt.store.answerState(r)
      return { id: r.id, runState, ...(rt.waitsForPerson(r.id) ? { waiting: true as const } : {}), ...answers }
    }
    const waiting = rt.activeTurnUser(r.id) === userId && rt.waitsForPerson(r.id)
    return { id: r.id, runState, ...(waiting ? { waiting: true as const } : {}), ...(r.user_id === userId ? rt.store.answerState(r, userId) : {}) }
  })
}

/** n for `userId` now, as a phone icon's number (0 to 9999); null when it could not be read (the push then carries no
 * badge and the icon keeps what it shows). */
export function pushBadge(ctx: AppContext, userId: string): number | null {
  try {
    const rooms = roomsOf(ctx)
    return appBadgeOf(attentionCount(markedChats(ctx, userId), rooms.listed(userId), { threadReplies: rooms.alerts(userId).threadReplies }).n)
  } catch {
    return null
  }
}
