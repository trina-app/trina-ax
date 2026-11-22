// Small lifecycle bridge: auth/notification policy can cancel work without importing network/secret modules.
import { NOT_HELD_SQL } from '../rooms/project-room'
import type { AppContext } from '../context'
import { ROOM_PUSH_EVENTS, type NotificationPreferences } from '@mycel/shared/api'
import { eventEnabled, pushEventEnabled } from './preferences'
import { noticeWanted } from '../rooms/alerts'
import { chatAnswerPath } from './chat-answers'
import { chatSharePath } from './chat-shares'
import { roomAppPushPath } from '../rooms/apps/notice'
import { fileSharePushPath } from '../files/share-push'
import { chatThreadPath } from '../chat/threads'
import { accessRequestPushPath } from '../chat/access-requests'
import { chatMessagePath } from '../chat/message-notices'
type Stop = (scope: { userId?: string; sessionId?: string }) => void
const listeners = new WeakMap<AppContext, Stop>()
export function onPushCancellation(ctx: AppContext, stop: Stop) { listeners.set(ctx, stop); return () => { if (listeners.get(ctx) === stop) listeners.delete(ctx) } }
export function cancelPushUser(ctx: AppContext, userId: string) { try { listeners.get(ctx)?.({ userId }) } catch { ctx.log.warn('push cancellation deferred') } }
export function cancelPushSession(ctx: AppContext, sessionId: string) { try { listeners.get(ctx)?.({ sessionId }) } catch { ctx.log.warn('push cancellation deferred') } }

/** Called inside the preference transaction: an acknowledged opt-out cannot leave a retry revivable later. */
export function cancelDisabledPushDeliveries(ctx: AppContext, userId: string, preferences: NotificationPreferences) {
  const disabled = (['schedule.success', 'schedule.failure', 'connection.reconnect'] as const).filter(event => !eventEnabled(preferences, event))
  if (disabled.length) ctx.db.query(`UPDATE push_deliveries SET state='cancelled',lease_until=NULL WHERE state IN ('pending','sending') AND notification_id IN
    (SELECT id FROM notification_inbox WHERE user_id=? AND event_type IN (${disabled.map(() => '?').join(',')}))`).run(userId, ...disabled)
  // an AI chat's answers have their own deliveries (migration 347): "AI answers" off stops what waits for a push
  if (!eventEnabled(preferences, 'chat.answer_done')) ctx.db.query(`UPDATE chat_answer_push_deliveries SET state='cancelled',lease_until=NULL WHERE state IN ('pending','sending') AND notification_id IN
    (SELECT id FROM chat_answer_notices WHERE user_id=?)`).run(userId)
  // a chat shared with me by name (migration 351): "Chats shared with me" off stops what waits for a push (the Inbox row stays)
  if (!pushEventEnabled(preferences, 'chat.shared')) ctx.db.query(`UPDATE chat_share_push_deliveries SET state='cancelled',lease_until=NULL WHERE state IN ('pending','sending') AND notification_id IN
    (SELECT id FROM chat_share_notices WHERE user_id=?)`).run(userId)
  // a file shared with me by name or a request to open a file I answer for (migrations 356, 358): "File sharing" off
  // stops what waits for a push (the Activity rows stay)
  if (!pushEventEnabled(preferences, 'file.shared')) ctx.db.query(`UPDATE file_share_push_deliveries SET state='cancelled',lease_until=NULL WHERE state IN ('pending','sending') AND notification_id IN
    (SELECT id FROM file_share_notices WHERE user_id=?)`).run(userId)
  // a request to open my chat or project (migration 411): the same switch
  if (!pushEventEnabled(preferences, 'access.requested')) ctx.db.query(`UPDATE access_request_push_deliveries SET state='cancelled',lease_until=NULL WHERE state IN ('pending','sending') AND notification_id IN
    (SELECT id FROM access_request_notices WHERE user_id=?)`).run(userId)
  // a reply in a chat thread I follow (migration 408): "Replies in threads I'm part of" off stops what waits for a push
  // (the Inbox row stays)
  if (!pushEventEnabled(preferences, 'chat.thread_reply')) ctx.db.query(`UPDATE chat_thread_push_deliveries SET state='cancelled',lease_until=NULL WHERE state IN ('pending','sending') AND notification_id IN
    (SELECT id FROM chat_thread_notices WHERE user_id=?)`).run(userId)
  // a person's message in a chat shared with people (migration 436): a room default of "nothing" stops what waits
  if (!pushEventEnabled(preferences, 'chat.message')) ctx.db.query(`UPDATE chat_message_push_deliveries SET state='cancelled',lease_until=NULL WHERE state IN ('pending','sending') AND notification_id IN
    (SELECT id FROM chat_message_notices WHERE user_id=?)`).run(userId)
  // room notices have their own deliveries (migration 241); each room's level decides (rooms/alerts.ts noticeWanted), so
  // a default of 받지 않음 or a narrower level stops what waits for a push
  const waiting = ctx.db.query(`SELECT DISTINCT d.notification_id id FROM room_push_deliveries d JOIN room_notices n ON n.id=d.notification_id
    WHERE n.user_id=? AND d.state IN ('pending','sending')`).all(userId) as { id: string }[]
  const cancel = ctx.db.query(`UPDATE room_push_deliveries SET state='cancelled',lease_until=NULL WHERE notification_id=? AND state IN ('pending','sending')`)
  for (const w of waiting) if (!noticeWanted(ctx.db, w.id)) cancel.run(w.id)
}

/** Where a tapped phone notification opens on the team (the app refuses anything but an id path, and so does the
 * gateway). An event code may register its own resolver, e.g. a room message: `/rooms/<roomId>`. None: the app's
 * start page. Resolvers read ids only; they never put names or text into the path. */
type PushPath = (ctx: AppContext, notificationId: string) => string | null | undefined
const PATH = /^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/
// the existing events open the inbox, as a Web Push click does (web/pwa/sw.js)
const pushPaths = new Map<string, PushPath>(['schedule.success', 'schedule.failure', 'connection.reconnect'].map(code => [code, () => '/settings/notifications']))
// a connection that needs a sign-in again opens its own page, where "Sign in again" is (the Inbox row's link,
// Notifications.tsx; QA TC-3053): a person's own connection while it is still theirs (connections/service.ts
// tellSignInAgain, source "<id>_<ms>"): a Google app's page or the connection's; Google Drive's (source = its
// drive_connections id) while that connection is theirs: Drive's page. A removed one: the Inbox, as before
export const reconnectPushPath: PushPath = (ctx, id) => {
  const n = ctx.db.query("SELECT user_id, source_id FROM notification_inbox WHERE id=? AND event_type='connection.reconnect'").get(id) as { user_id: string; source_id: string } | null
  if (!n) return null
  const own = /^(.+)_\d+$/.exec(n.source_id)?.[1]
  const c = own ? ctx.db.query("SELECT id, google_app FROM integrations WHERE id=? AND scope='personal' AND owner_user_id=?").get(own, n.user_id) as { id: string; google_app: string | null } | null : null
  if (c) return c.google_app ? `/settings/connectors/${c.google_app}` : `/settings/connectors/mcp/${c.id}`
  const drive = ctx.db.query('SELECT 1 FROM drive_connections WHERE id=? AND user_id=?').get(n.source_id, n.user_id)
  return drive ? '/settings/connectors/google-drive' : '/settings/notifications'
}
pushPaths.set('connection.reconnect', reconnectPushPath)
// a room notice opens its room (the same page a Web Push click opens, web/pwa/sw.js), only while the person is still in
// that room and it is not archived; a reply in a thread opens that thread (/rooms/<room>/t/<root>, ids only). The
// message itself is the last part (/m/<message>: a phone's path names no query; the web app reads it as ?m=, goes to it
// and picks it out, the thread's root in the room beside it: web/src/App.tsx). The room page checks membership, the
// thread's root and what the person may see of the message again
const roomPath: PushPath = (ctx, id) => {
  const r = ctx.db.query(`SELECT n.room_id, s.id AS message_id, s.thread_root_id FROM room_notices n JOIN room_members m ON m.room_id=n.room_id AND m.user_id=n.user_id
    JOIN rooms r ON r.id=n.room_id AND r.archived_at IS NULL AND ${NOT_HELD_SQL('r')} LEFT JOIN room_messages s ON s.id=n.source_id WHERE n.id=?`).get(id) as { room_id: string; message_id: string | null; thread_root_id: string | null } | null
  if (!r) return null
  const at = r.message_id ? `/m/${r.message_id}` : ''
  return r.thread_root_id ? `/rooms/${r.room_id}/t/${r.thread_root_id}${at}` : `/rooms/${r.room_id}${at}`
}
for (const code of ROOM_PUSH_EVENTS) pushPaths.set(code, roomPath)
// a lead join opens Home, where the owner's handover card is (the card checks again that it still holds)
pushPaths.set('owner.lead_joined', () => '/')
// an AI chat's answer opens that chat (/c/<chatId>) while the person may still open it (notifications/chat-answers.ts)
pushPaths.set('chat.answer_done', chatAnswerPath)
// a chat shared with me by name opens that chat while I still see it (notifications/chat-shares.ts)
pushPaths.set('chat.shared', chatSharePath)
// a reply in a chat thread I follow opens that thread (/c/<chatId>/t/<answerId>) while I still see it (chat/threads.ts)
pushPaths.set('chat.thread_reply', chatThreadPath)
// a person's message in a chat shared with people opens the chat at it (/c/<chatId>/m/<messageId>) while I still see
// it (chat/message-notices.ts)
pushPaths.set('chat.message', chatMessagePath)
// an app's paused notice opens the app's room (/rooms/<roomId>) while the person is still in it (rooms/apps/notice.ts)
pushPaths.set('room_app.paused', roomAppPushPath)
// a file shared with me by name opens its link page, several in one press their list; a request to open a file I answer
// for opens that request in Activity (/activity/<notice id>) while it waits on me (files/share-push.ts)
pushPaths.set('file.shared', fileSharePushPath)
pushPaths.set('file.access_requested', fileSharePushPath)
// a request to open my chat or project opens it in Activity while it waits on me (chat/access-requests.ts)
pushPaths.set('access.requested', accessRequestPushPath)
// the owner's locked password check opens the Inbox (the notice there says what to do), as the older events do
pushPaths.set('owner.reauth_locked', () => '/settings/notifications')
export function registerPushPath(code: string, path: PushPath) { pushPaths.set(code, path) }
export function pushPathOf(ctx: AppContext, code: string, notificationId: string): string | undefined {
  try {
    const p = pushPaths.get(code)?.(ctx, notificationId)
    return typeof p === 'string' && p.length <= 200 && PATH.test(p) ? p : undefined
  } catch { return undefined }
}
