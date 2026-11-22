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
import type { Database } from 'bun:sqlite'
import { inQuietHours } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { newId } from '../db'
import { teamTimeZone } from '../admin/settings'
import { getPreferences, pushEventEnabled, type Preferences } from '../notifications/preferences'
import { chatOpenFor } from '../notifications/chat-answers'
import { isPeopleRow } from './chat-audience'
import { Audiences } from './shared'
import { AnswerSight } from './shared-answers'
import type { ChatRow } from './store'

type Kind = 'message' | 'answer'
/** a notice that may ring now, per person: the message, and whether it mentions them (the chat.updated `notice`) */
export type Ring = { messageId: string; mention?: true }
type ChatIds = Pick<ChatRow, 'id' | 'user_id' | 'shared_at' | 'project_id' | 'people_shared_at' | 'deleted_at' | 'room_id'>
type Notice = { id: string; user_id: string; chat_id: string; source_id: string; by_user: string | null; kind: Kind; read_at: string | null; suppressed: number; quiet: number; mention: number }
const noticeOf = (db: Database, id: string) => db.query('SELECT id, user_id, chat_id, source_id, by_user, kind, read_at, suppressed, quiet, mention FROM chat_message_notices WHERE id = ?').get(id) as Notice | null

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

/** My unread notices in this chat (the row's number), whether one of them mentions me (the row's "@") and my mute, in
 * one read (chat/shared.ts chatView runs it for each chat shared with people in a list). */
export function unreadOf(db: Database, userId: string, chatId: string): { n: number; mention: boolean; muted: boolean } {
  const r = db.query(`SELECT COUNT(*) n, MAX(mention) m, EXISTS(SELECT 1 FROM chat_mutes WHERE chat_id = ?2 AND user_id = ?1) muted
    FROM chat_message_notices WHERE user_id = ?1 AND chat_id = ?2 AND read_at IS NULL AND suppressed = 0`).get(userId, chatId) as { n: number; m: number | null; muted: number }
  return { n: r.n, mention: r.m === 1, muted: r.muted === 1 }
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
 * chat.updated `notice`); a muted person gets nothing but a message that mentions them (`mentions`: the people picked
 * with "@", kept only among those who see the chat). Never throws: the message is saved whether or not it is told. */
function note(ctx: AppContext, chat: ChatIds, messageId: string, by: string, kind: Kind, mentions: readonly string[] = []): Map<string, Ring> {
  const rings = new Map<string, Ring>()
  if (!isPeopleRow(chat) || chat.deleted_at || chat.room_id) return rings
  try {
    const db = ctx.db
    const ids = new Audiences(db, ctx.files).ofChat(chat).filter((id) => id !== by)
    if (!ids.length) return rings
    const sight = kind === 'answer' ? new AnswerSight(db, ctx.files) : null
    const tz = teamTimeZone(db), now = Date.now(), at = new Date(now).toISOString()
    const insert = db.query(`INSERT INTO chat_message_notices (id, user_id, event_type, source_id, chat_id, by_user, kind, created_at, suppressed, quiet, mention)
      VALUES (?, ?, 'chat.message', ?, ?, ?, ?, ?, 0, ?, ?) ON CONFLICT DO NOTHING`)
    db.transaction(() => {
      for (const uid of ids) {
        if (!db.query("SELECT 1 FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL").get(uid)) continue
        const mention = kind === 'message' && mentions.includes(uid)
        if (!mention && isMuted(db, uid, chat.id)) continue
        if (sight?.withheld(chat.id, uid).has(messageId)) continue
        const ring = kind === 'message' && mayRing(getPreferences(db, uid), tz, now)
        const r = insert.run(newId(), uid, messageId, chat.id, kind === 'message' ? by : null, kind, at, ring ? 0 : 1, mention ? 1 : 0)
        // a person's message brings a chat I hid from my list back (as a room's message brings a hidden room back), so
        // its number is never out of sight; an answer of Trina's does not
        if (r.changes && kind === 'message') db.query('DELETE FROM chat_list_hidden WHERE user_id = ? AND chat_id = ?').run(uid, chat.id)
        if (r.changes && ring) rings.set(uid, { messageId, ...(mention ? { mention: true as const } : {}) })
      }
    })()
    // their Inbox count does not change (these rows are never listed): the chat.updated that follows carries the number
    return rings
  } catch (e) {
    ctx.log.warn('chat message notices deferred', { err: e })
    return rings
  }
}

/** A person's message in a chat shared with people (runtime.ts createTurn, before its chat.updated). The sender has
 * read the chat now. */
export function noteSharedMessage(ctx: AppContext, chat: ChatIds, messageId: string, by: string, mentions: readonly string[] = []): Map<string, Ring> {
  if (!isPeopleRow(chat)) return new Map()
  try { readChatNotices(ctx, by, chat.id) } catch { /* the number goes with the next read */ }
  return note(ctx, chat, messageId, by, 'message', mentions)
}

/** Trina's finished answer to `asker` (turn.ts announceEnd, before its chat.updated): the unread number for the others. */
export function noteSharedAnswer(ctx: AppContext, chat: ChatIds, answerId: string, asker: string) {
  note(ctx, chat, answerId, asker, 'answer')
}

/** Asked before and after each send (push-service.ts SOURCES wanted): a person's message, unread, made outside quiet
 * hours and still outside them, the room default not "nothing", the chat not muted (a mention: muted too), the message still there, and the
 * chat still the person's to see. */
export function chatMessageWanted(ctx: AppContext, notificationId: string, now = Date.now()): boolean {
  const n = noticeOf(ctx.db, notificationId)
  if (!n || n.kind !== 'message' || n.read_at || n.suppressed || n.quiet) return false
  if (!mayRing(getPreferences(ctx.db, n.user_id), teamTimeZone(ctx.db), now)) return false
  if (!n.mention && isMuted(ctx.db, n.user_id, n.chat_id)) return false
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
