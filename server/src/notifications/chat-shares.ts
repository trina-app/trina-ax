// A phone push when someone shares a chat with me by name (QA TC-1414, docs/DECISIONS.md "Chats shared with me: a push
// that names the sharer"). The notice itself is the Inbox's (chat_share_notices, migration 298: at most one a day per
// chat and person); only a notice of a share BY NAME (named=1) is pushed (a group's people get the Inbox row alone),
// only while it still holds: unread, the person still sees the chat, outside their quiet hours now, and their "Chats
// shared with me" is on. The push carries ids and the event code only (the gateway picks a generic line); an iPhone
// app with the notification extension asks its own team for the words (push-service.ts label): the sharer's name and
// a fixed line in the person's language, never the chat's title.
import type { Database } from 'bun:sqlite'
import { inQuietHours, plainLabel, type Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { teamTimeZone } from '../admin/settings'
import { chatOpenFor } from './chat-answers'
import { getPreferences } from './preferences'
import { CHAT_SHARED_BY } from './text'

type Notice = { user_id: string; chat_id: string; by_user: string | null; named: number; read_at: string | null; suppressed: number }
const noticeOf = (db: Database, id: string) => db.query('SELECT user_id, chat_id, by_user, named, read_at, suppressed FROM chat_share_notices WHERE id = ?').get(id) as Notice | null
/** the sharer, while their account is there and switched on */
const sharerName = (db: Database, id: string | null) => id ? (db.query("SELECT name FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL").get(id) as { name: string } | null)?.name ?? null : null

/** Asked before and after each send (push-service.ts SOURCES wanted). */
export function chatShareWanted(ctx: AppContext, notificationId: string, now = Date.now()): boolean {
  const n = noticeOf(ctx.db, notificationId)
  if (!n || !n.named || n.read_at || n.suppressed) return false
  const prefs = getPreferences(ctx.db, n.user_id)
  if (!prefs.chatShares) return false
  // made or retried inside the quiet hours: dropped, as a room notice's push is (nothing that waited is pushed later)
  if (inQuietHours(prefs.quietHours, teamTimeZone(ctx.db), now)) return false
  return chatOpenFor(ctx, n.user_id, n.chat_id)
}

/** A tap opens the chat (the web's /c/<id>) while the person still sees it; else the app's start page. */
export function chatSharePath(ctx: AppContext, notificationId: string): string | null {
  const n = noticeOf(ctx.db, notificationId)
  return n && chatOpenFor(ctx, n.user_id, n.chat_id) ? `/c/${n.chat_id}` : null
}

/** The words an iPhone's notification extension shows for this push (push-service.ts label): the sharer's name as the
 * title and a fixed line, never the chat's title. null when the sharer's account is gone (the generic line stays). */
export function chatShareLabel(ctx: AppContext, notificationId: string, locale: Locale): { title: string; body: string } | null {
  const n = noticeOf(ctx.db, notificationId)
  const name = n ? sharerName(ctx.db, n.by_user) : null
  const title = name ? plainLabel(name, 120) : ''
  return title ? { title, body: CHAT_SHARED_BY[locale] } : null
}
