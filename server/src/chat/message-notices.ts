// A new message in a chat shared with people tells the others (docs/decisions/20261122-shared-chat-new-message-notices.md,
// scenario QA TC-7406): the chat is a conversation, so a teammate's message there is told as a group chat's message in a
// room is (rooms/service.ts notify, docs/decisions/20261120-push-every-message.md): every person who sees the chat now
// (Audiences.ofChat: its creator, the people and groups it names; someone added later too) but its sender gets a notice
// of their own per message (chat_message_notices, migration 436): the unread number on the chat's row (Chat.unreadCount,
// chat/shared.ts chatView), the one count n, a push (push-service.ts SOURCES, the away rule and quiet hours as every
// push) and, in the desktop app, a notification and the room sound (chat.updated `notice`). Trina's answer to someone
// else is a notice too, for the unread number only: never pushed or rung (the asker has the finished notice,
// notifications/chat-answers.ts). "Mute this chat" (chat_mutes): no notices for that person there. Reading the chat
// (POST /api/chats/:id/seen) or writing in it reads them. Ids only: never a message's text or the chat's title in a row.
//
// A team project's shared chat is a conversation as well (owner 2026-11-22, docs/decisions/
// 20261122-project-chat-notices-threads-mention-only.md): the same notices for the people who see it now
// (Audiences.ofChat: the project's readers, no guest but the chat's own creator, nobody while its folder is in the
// trash). A chat started "Only me" in a project is not shared and tells nobody. Projects can be large: the fan-out reads
// who is active, who muted the chat and everyone's preferences in one query each, writes in one transaction, and asks
// nothing per person but the insert.
import type { Database } from 'bun:sqlite'
import { inQuietHours, plainLabel, type Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { newId } from '../db'
import { teamTimeZone } from '../admin/settings'
import { getPreferences, getPreferencesOf, pushEventEnabled, type Preferences } from '../notifications/preferences'
import { chatOpenFor } from '../notifications/chat-answers'
import { isSharedRow } from './chat-audience'
import { Audiences } from './shared'
import { answerHiddenFrom } from './shared-answers'
import type { ChatRow } from './store'
import { ROOM_WORDS } from '../notifications/text'
import { activeName, chatPlace, previewFiles, pushPreview } from '../notifications/push-preview'
import { plainMarkdown } from '../rooms/inbox'

type Kind = 'message' | 'answer'
/** A chat whose people's messages tell the others: one shared with people (#339) or a team project's shared chat (both
 * are isSharedRow; a project chat started "Only me" is neither). */
export const isConversationRow = (r: Pick<ChatRow, 'shared_at' | 'project_id' | 'people_shared_at'>): boolean => isSharedRow(r)
/** My unread notices and mute in one chat (chatView, the push badge). */
export type Unread = { n: number; muted: boolean }
/** a notice that may ring now, per person: the message (the chat.updated `notice`) */
export type Ring = { messageId: string }
type ChatIds = Pick<ChatRow, 'id' | 'user_id' | 'shared_at' | 'project_id' | 'people_shared_at' | 'deleted_at' | 'room_id'>
type Notice = { id: string; user_id: string; chat_id: string; source_id: string; by_user: string | null; kind: Kind; read_at: string | null; suppressed: number; quiet: number }
const noticeOf = (db: Database, id: string) => db.query('SELECT id, user_id, chat_id, source_id, by_user, kind, read_at, suppressed, quiet FROM chat_message_notices WHERE id = ?').get(id) as Notice | null

/** Does a person's push for a message in a chat shared with people go now: the room default (Settings › Notifications:
 * "nothing" turns it off, as for a group chat), outside quiet hours. */
const mayRing = (p: Preferences, tz: string, now: number) => pushEventEnabled(p, 'chat.message') && !inQuietHours(p.quietHours, tz, now)

export function isMuted(db: Database, userId: string, chatId: string): boolean {
  return !!db.query('SELECT 1 FROM chat_mutes WHERE chat_id = ? AND user_id = ?').get(chatId, userId)
}
/** "Mute this chat" / "Unmute": mine only. A mute reads what was unread there (nothing more is told). */
export function setMuted(ctx: AppContext, userId: string, chatId: string, muted: boolean) {
  if (muted) {
    ctx.db.query('INSERT INTO chat_mutes (chat_id, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(chatId, userId, new Date().toISOString())
    readChatNotices(ctx, userId, chatId)
  } else ctx.db.query('DELETE FROM chat_mutes WHERE chat_id = ? AND user_id = ?').run(chatId, userId)
}

/** Someone no longer sees the chat (people-share.ts putChatAudience): their notices there and their mute go. */
export function forgetChatNotices(db: Database, userId: string, chatId: string) {
  db.query('DELETE FROM chat_message_notices WHERE user_id = ? AND chat_id = ?').run(userId, chatId)
  db.query('DELETE FROM chat_mutes WHERE user_id = ? AND chat_id = ?').run(userId, chatId)
}

/** My unread notices in this chat (the row's number) and my mute, in one read (chat/shared.ts chatView runs it for each
 * chat shared with people in a list). The main box mentions nobody (docs/decisions/20261122-ai-session-no-main-mention.md):
 * an older row's `mention` column is not read. */
export function unreadOf(db: Database, userId: string, chatId: string): Unread {
  const r = db.query(`SELECT COUNT(*) n, EXISTS(SELECT 1 FROM chat_mutes WHERE chat_id = ?2 AND user_id = ?1) muted
    FROM chat_message_notices WHERE user_id = ?1 AND chat_id = ?2 AND read_at IS NULL AND suppressed = 0`).get(userId, chatId) as { n: number; muted: number }
  return { n: r.n, muted: r.muted === 1 }
}

/** Everyone's unread numbers and mutes in one chat, in two grouped reads (runtime.ts publishChat tells every
 * viewer of a busy project chat at once: no read per person). The unread rows only, through their partial index
 * (migration 438), never every notice the chat ever had. Someone without a row: nothing unread, not muted. */
export function unreadByUser(db: Database, chatId: string): Map<string, Unread> {
  const out = new Map<string, Unread>()
  const rows = db.query(`SELECT user_id, COUNT(*) n FROM chat_message_notices INDEXED BY chat_message_notices_unread_by_chat WHERE chat_id = ? AND read_at IS NULL AND suppressed = 0 GROUP BY user_id`).all(chatId) as { user_id: string; n: number }[]
  for (const r of rows) out.set(r.user_id, { n: r.n, muted: false })
  for (const r of db.query('SELECT user_id FROM chat_mutes WHERE chat_id = ?').all(chatId) as { user_id: string }[]) out.set(r.user_id, { ...(out.get(r.user_id) ?? { n: 0 }), muted: true })
  return out
}

/** I had the chat on screen, or wrote in it: its notices are read and their pushes that still wait go. True when
 * something was unread (the caller tells my windows). */
export function readChatNotices(ctx: AppContext, userId: string, chatId: string): boolean {
  const db = ctx.db
  const read = db.query('UPDATE chat_message_notices SET read_at = ? WHERE user_id = ? AND chat_id = ? AND read_at IS NULL RETURNING id').all(new Date().toISOString(), userId, chatId) as { id: string }[]
  if (!read.length) return false
  db.query(`UPDATE chat_message_push_deliveries SET state = 'cancelled', lease_until = NULL WHERE state IN ('pending','sending')
    AND notification_id IN (SELECT id FROM chat_message_notices WHERE user_id = ? AND chat_id = ?)`).run(userId, chatId)
  return true
}

/** The notices of one new message or answer, for everyone who sees the chat now but `by` (and, for an answer, its asker
 * and anyone it is hidden from). Returns the people whose notice may ring now (the desktop app tells those: the
 * chat.updated `notice`); a muted person gets nothing. No notice is a mention: the main box of an AI chat mentions
 * nobody, a person is mentioned in a thread under an AI answer (chat/threads.ts; docs/decisions/
 * 20261122-ai-session-no-main-mention.md). Never throws: the message is saved whether or not it is told. */
function note(ctx: AppContext, chat: ChatIds, messageId: string, by: string, how: Kind | 'scheduled'): Map<string, Ring> {
  // a scheduled run's answer (AB4): told as a main message is (its row kind 'message': the number, a push, the ring), with
  // the hidden-answer check of an answer, and no person as its writer (it is Trina's; the push says "a new message")
  const kind: Kind = how === 'answer' ? 'answer' : 'message'
  const answer = how !== 'message'
  const rings = new Map<string, Ring>()
  if (!isConversationRow(chat) || chat.deleted_at || chat.room_id) return rings
  try {
    const db = ctx.db
    const ids = new Audiences(db, ctx.files).ofChat(chat).filter((id) => id !== by)
    if (!ids.length) return rings
    // one read each for everyone (a project may have hundreds of people): who is active, who muted it, their settings
    const list = JSON.stringify(ids)
    const active = new Set((db.query("SELECT id FROM users WHERE id IN (SELECT value FROM json_each(?)) AND status = 'active' AND deleted_at IS NULL").all(list) as { id: string }[]).map((r) => r.id))
    const muted = new Set((db.query('SELECT user_id FROM chat_mutes WHERE chat_id = ?').all(chat.id) as { user_id: string }[]).map((r) => r.user_id))
    const prefs = kind === 'message' ? getPreferencesOf(db, ids.filter((id) => active.has(id))) : null
    // an answer: who this one answer is hidden from, worked out before the write transaction from its own branch only
    // (shared-answers.ts answerHiddenFrom: never the whole chat per person; an answer from the cutover on reads nothing
    // more), never held inside the write
    const hiddenFrom = answer ? answerHiddenFrom(db, ctx.files, chat.id, messageId, ids.filter((uid) => active.has(uid) && !muted.has(uid))) : new Set<string>()
    const tz = teamTimeZone(db), now = Date.now(), at = new Date(now).toISOString()
    const insert = db.query(`INSERT INTO chat_message_notices (id, user_id, event_type, source_id, chat_id, by_user, kind, created_at, suppressed, quiet, mention)
      VALUES (?, ?, 'chat.message', ?, ?, ?, ?, ?, 0, ?, 0) ON CONFLICT DO NOTHING`)
    const told: string[] = []
    db.transaction(() => {
      for (const uid of ids) {
        if (!active.has(uid)) continue
        if (muted.has(uid)) continue
        if (hiddenFrom.has(uid)) continue
        const ring = kind === 'message' && mayRing(prefs!.get(uid)!, tz, now)
        const r = insert.run(newId(), uid, messageId, chat.id, how === 'message' ? by : null, kind, at, ring ? 0 : 1)
        if (r.changes && how === 'message') told.push(uid)
        if (r.changes && ring) rings.set(uid, { messageId })
      }
      // a person's message brings a chat I hid from my list back (as a room's message brings a hidden room back), so
      // its number is never out of sight; an answer of Trina's does not (one statement for everyone told)
      if (told.length) db.query('DELETE FROM chat_list_hidden WHERE chat_id = ? AND user_id IN (SELECT value FROM json_each(?))').run(chat.id, JSON.stringify(told))
    })()
    // their Inbox count does not change (these rows are never listed): the chat.updated that follows carries the number
    return rings
  } catch (e) {
    ctx.log.warn('chat message notices deferred', { err: e })
    return rings
  }
}

/** A person's message in a chat shared with people or a project's shared chat (runtime.ts createTurn, before its
 * chat.updated). The sender has read the chat now. */
export function noteSharedMessage(ctx: AppContext, chat: ChatIds, messageId: string, by: string): Map<string, Ring> {
  if (!isConversationRow(chat)) return new Map()
  try { readChatNotices(ctx, by, chat.id) } catch { /* the number goes with the next read */ }
  return note(ctx, chat, messageId, by, 'message')
}

/** Trina's finished answer to `asker` (turn.ts announceEnd, before its chat.updated): the unread number for the others.
 * A scheduled run's answer (`scheduled`; nobody asked it live: AB4, the owner's Slack rule for main messages, docs/
 * decisions/20261123-ab4-asks-left.md) tells them as a main message does: the number, a push and the desktop ring (the
 * people whose notice may ring now are returned), never anyone it is hidden from or who muted the chat. */
export function noteSharedAnswer(ctx: AppContext, chat: ChatIds, answerId: string, asker: string, o: { scheduled?: boolean } = {}): Map<string, Ring> {
  return note(ctx, chat, answerId, asker, o.scheduled ? 'scheduled' : 'answer')
}

/** Asked before and after each send (push-service.ts SOURCES wanted): a person's message, unread, made outside quiet
 * hours and still outside them, the room default not "nothing", the chat not muted, the message still there, and the
 * chat still the person's to see. */
export function chatMessageWanted(ctx: AppContext, notificationId: string, now = Date.now()): boolean {
  const n = noticeOf(ctx.db, notificationId)
  if (!n || n.kind !== 'message' || n.read_at || n.suppressed || n.quiet) return false
  if (!mayRing(getPreferences(ctx.db, n.user_id), teamTimeZone(ctx.db), now)) return false
  if (isMuted(ctx.db, n.user_id, n.chat_id)) return false
  if (!ctx.db.query('SELECT 1 FROM messages WHERE id = ? AND chat_id = ?').get(n.source_id, n.chat_id)) return false
  return chatOpenFor(ctx, n.user_id, n.chat_id)
}

/** A tap opens the chat at that message (/c/<chat>/m/<message>, ids only) while the person still sees it. */
export function chatMessagePath(ctx: AppContext, notificationId: string): string | null {
  const n = noticeOf(ctx.db, notificationId)
  return n && chatOpenFor(ctx, n.user_id, n.chat_id) ? `/c/${n.chat_id}/m/${n.source_id}` : null
}

/** What a push opens (the service worker's signed-in fetch of the notice): the chat and the message while the person
 * still sees the chat; else nothing. */
export function chatMessageLink(ctx: AppContext, notificationId: string): { chatId: string; messageId: string } | null {
  const n = noticeOf(ctx.db, notificationId)
  return n && chatOpenFor(ctx, n.user_id, n.chat_id) ? { chatId: n.chat_id, messageId: n.source_id } : null
}

/** The words a phone shows for this push (push-service.ts label; docs/decisions/20261124-push-preview-slack-rule.md):
 * who wrote (Trina for a scheduled run's answer) and where (the chat's title, a stored connection secret of its creator
 * hidden; else its project's name) as the title, and the message (notifications/push-preview.ts) as the line while the
 * reader's preview is on. Only while the push would still go (chatMessageWanted). null: the generic words stay. */
export function chatMessageLabel(ctx: AppContext, notificationId: string, locale: Locale, preview: boolean): { title: string; body: string | null; roomId: string } | null {
  const n = noticeOf(ctx.db, notificationId)
  if (!n || !chatMessageWanted(ctx, notificationId)) return null
  const m = ctx.db.query('SELECT role, content, attachments FROM messages WHERE id = ? AND chat_id = ?').get(n.source_id, n.chat_id) as { role: 'user' | 'assistant'; content: string; attachments: string } | null
  if (!m) return null
  const who = n.by_user ? activeName(ctx.db, n.by_user) : m.role === 'assistant' ? ROOM_WORDS[locale].ai : null
  const place = chatPlace(ctx, n.chat_id)
  const title = plainLabel(who && place ? `${who} · ${place}` : who || place, 120)
  if (!title) return null
  const text = m.role === 'assistant' ? plainMarkdown(m.content) : m.content
  const body = pushPreview(ctx, { preview, text, files: previewFiles(m.attachments), writer: n.by_user, reader: n.user_id, locale })
  return { title, body, roomId: n.chat_id }
}
