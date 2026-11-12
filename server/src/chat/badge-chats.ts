// The AI chats' part of the app icon's number (notifications/badge.ts, the phone push's `badge`): the chats of my chat
// list that show "?" or a dot in the web app (web/src/lib/sessionMarkers.ts markerOf, needsMe). Read the way the list
// route reads them (routes/chats.ts listChats) and marked the way chatView marks them (chat/shared.ts), so the server's
// number is the web app's as closely as the server can know it. What only a window knows (the chat on screen there, a
// card for one desktop window) is not counted here.
import type { ChatRow } from './store'
import { CHAT_COLS } from './store'
import { notInternalChat } from './internal-chats'
import { Audiences, isSharedRow, severalAuthors } from './shared'
import type { ChatRuntime } from './runtime'

/** The web app loads my chat list 50 at a time (web/src/store/chats.ts PAGE), my pinned chats first: only those can
 * have a marker there. An unseen answer moves its chat to the top, so a chat further down has none to count. */
export const BADGE_CHATS_PAGE = 50

/** Does this chat want me, as the web app's marker says (needsMe): its AI waits on me (a card every window shows), or an
 * answer I have not seen while nothing runs or waits in the queue there. */
export function chatNeedsMe(c: { waiting: boolean; runState: 'idle' | 'running' | 'queued'; unseen: boolean }): boolean {
  if (c.waiting) return true
  return c.runState === 'idle' && c.unseen
}

/** How many chats of `userId`'s chat list want them now. */
export function chatsNeedingMe(rt: ChatRuntime, userId: string): number {
  const db = rt.db
  // my chat list (listChats without a project, a search or the trash): my chats and the shared chats I wrote in, never a
  // room's AI session or one of the server's own drafts
  const where = `room_id IS NULL AND deleted_at IS NULL AND ${notInternalChat(db)}
    AND (user_id = ? OR (shared_at IS NOT NULL AND id IN (SELECT chat_id FROM messages WHERE role = 'user' AND author_id = ?)))`
  const pinned = db.query(`SELECT ${CHAT_COLS} FROM chats WHERE ${where} AND id IN (SELECT chat_id FROM chat_pins WHERE user_id = ?)`).all(userId, userId, userId) as ChatRow[]
  const first = db.query(`SELECT ${CHAT_COLS} FROM chats WHERE ${where} AND id NOT IN (SELECT chat_id FROM chat_pins WHERE user_id = ?)
    ORDER BY updated_at DESC, id DESC LIMIT ?`).all(userId, userId, userId, BADGE_CHATS_PAGE) as ChatRow[]
  let aud: Audiences | null = null
  let n = 0
  for (const r of [...pinned, ...first]) {
    const runState = rt.runState(r.id)
    if (!isSharedRow(r)) {
      // one person's chat (or one that stopped being shared: its creator's answers decide)
      const unseen = !!rt.store.answerState(r, severalAuthors(db, r.id) ? r.user_id : undefined).unseen
      if (chatNeedsMe({ waiting: rt.waitsForPerson(r.id), runState, unseen })) n++
      continue
    }
    // a shared chat: only while I see its project; the AI's wait is its runner's, the unseen marker its creator's
    const p = rt.store.projectRow(r.project_id!)
    aud ??= new Audiences(db, rt.files)
    if (!p || !aud.sees(userId, p)) continue
    const waiting = rt.activeTurnUser(r.id) === userId && rt.waitsForPerson(r.id)
    const unseen = r.user_id === userId && !!rt.store.answerState(r, userId).unseen
    if (chatNeedsMe({ waiting, runState, unseen })) n++
  }
  return n
}
