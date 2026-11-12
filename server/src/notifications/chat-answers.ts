// A push when an answer in my own AI chat needs me (QA TC-442, docs/DECISIONS.md "AI 답변 알림"): the answer finished,
// failed, or the AI waits for me (a question or a yes/no card). For the person who asked it only (a shared project
// chat: the asker of that turn), never a scheduled run (schedule.* has its own), a question from Slack (answered
// there), a room's AI (rooms have their own) or a turn the server started by itself (no clientKind: skill drafts,
// merges, file ranking). One notice per answer (chat_answer_notices, migration 347), pushed after
// a short wait and only while it still holds: the answer is unseen (no visible window had the chat on screen: POST
// /api/chats/:id/seen), the card is still open. Never listed in the Inbox; the push carries ids and the event code only.
import type { Database } from 'bun:sqlite'
import type { AppContext } from '../context'
import { getChatRuntime } from '../chat/runtime'
import { Audiences, isSharedRow } from '../chat/shared'
import { isInternalChat } from '../chat/internal-chats'
import { notificationsOf } from './service'

export type ChatAnswerKind = 'done' | 'failed' | 'waiting'
/** how long a finished answer waits before it is pushed: a window that has the chat on screen marks it seen meanwhile */
export const CHAT_ANSWER_PUSH_DELAY_MS = 10_000
/** a card waits longer: nothing tells the server that it is on screen, and someone at the app answers it in this time */
export const CHAT_CARD_PUSH_DELAY_MS = 30_000
/** a second finished answer of the same chat within this time, while the first one's push was not seen, adds none: a
 * burst of answers is one push */
export const CHAT_ANSWER_COALESCE_MS = 10 * 60_000

type ChatRow = { id: string; user_id: string; project_id: string | null; shared_at: string | null; deleted_at: string | null; room_id: string | null; seen_at: string | null }
const chatRow = (db: Database, id: string) => db.query('SELECT id, user_id, project_id, shared_at, deleted_at, room_id, seen_at FROM chats WHERE id = ?').get(id) as ChatRow | null

/** Is this chat still the person's to open: their own, or a shared project chat while they see its project. Not a
 * deleted chat, a room's chat or one of the server's own. */
export function chatOpenFor(ctx: AppContext, userId: string, chatId: string): boolean {
  const c = chatRow(ctx.db, chatId)
  if (!c || c.deleted_at || c.room_id || isInternalChat(ctx.db, c.id)) return false
  if (c.user_id === userId && !isSharedRow(c)) return true
  if (!isSharedRow(c)) return false
  // the project as the chat list reads it (push-badge.ts: rt.store.projectRow); no runtime: no chats to open
  let rt: ReturnType<typeof getChatRuntime>
  try { rt = getChatRuntime(ctx) } catch { return false }
  const p = rt.store.projectRow(c.project_id!)
  return !!p && new Audiences(ctx.db, ctx.files).sees(userId, p)
}

/** Asked before and after each send (push-service.ts SOURCES wanted). */
export function chatAnswerWanted(ctx: AppContext, notificationId: string): boolean {
  const n = ctx.db.query('SELECT user_id, chat_id, source_id, kind, created_at FROM chat_answer_notices WHERE id = ?').get(notificationId) as { user_id: string; chat_id: string; source_id: string; kind: ChatAnswerKind; created_at: string } | null
  if (!n || !chatOpenFor(ctx, n.user_id, n.chat_id)) return false
  if (n.kind === 'waiting') {
    // the card is still open, in every window (a card one desktop window shows alone is that window's)
    let rt: ReturnType<typeof getChatRuntime>
    try { rt = getChatRuntime(ctx) } catch { return false }
    const exec = rt.execFor(n.source_id.replace(/\.ask$/, ''))
    return !!exec && exec.spec.userId === n.user_id && exec.openRequests().some((r) => !r.window)
  }
  // the chat's seen mark is its creator's (a shared chat keeps one): for another asker it cannot tell, and it is sent
  const c = chatRow(ctx.db, n.chat_id)!
  return c.user_id !== n.user_id || !c.seen_at || c.seen_at < n.created_at
}

/** A tap opens the chat (the web's /c/<id>), while the person may still open it; else the app's start page. */
export function chatAnswerPath(ctx: AppContext, notificationId: string): string | null {
  const n = ctx.db.query('SELECT user_id, chat_id FROM chat_answer_notices WHERE id = ?').get(notificationId) as { user_id: string; chat_id: string } | null
  return n && chatOpenFor(ctx, n.user_id, n.chat_id) ? `/c/${n.chat_id}` : null
}

/** The turn's end or a card it opened (chat/turn.ts). Never throws: the answer is there whether or not it is told. */
export function noteChatAnswer(ctx: AppContext, o: { userId: string; chatId: string; turnId: string; kind: ChatAnswerKind }) {
  try { notificationsOf(ctx).chatAnswer(o.userId, o) }
  catch { ctx.log.warn('chat answer notice deferred') }
}
