// A phone push when someone shares a file, or several in one press, with me by name (QA TC-3510,
// docs/decisions/20261116-file-share-everyone.md; migration 356), or asks to open a file I answer for
// (docs/decisions/20261116-file-share-push-gaps.md). The notice is the Inbox's (file_share_notices, one per person and
// press, or per person, file and asker); only a notice of a share BY NAME (named=1) or of a request is pushed (a group's
// or the whole team's people get the Inbox row alone, as with chats), only while it holds: unread, outside the person's
// quiet hours, "File sharing" on (migration 358), and a file of it still opens for them, or the request still waits and
// they may still answer it. The push carries ids and the event code only (the gateway picks a generic line); never a
// file name, the asker or the note.
import type { Database } from 'bun:sqlite'
import { fileBatchUrl, fileLinkUrl, inQuietHours } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { teamTimeZone } from '../admin/settings'
import { getPreferences, pushEventEnabled } from '../notifications/preferences'
import { fileSharesOf } from './shares'

/** At most this many people's requests to open my files reach my phone a day (each request is one push, however many
 * devices); past it they land in Activity alone. The request limits are per asker, so many askers could otherwise ring
 * one owner without end (security review of #1118). */
export const FILE_REQUEST_PUSHES_PER_DAY = 10
/** Requests made before this server knew the push (migration 358 applied) are never pushed: on the update every unread
 * waiting request of the last day would ring at once. Read once per database. */
const since = new WeakMap<Database, string>()
const featureSince = (db: Database) => {
  let at = since.get(db)
  if (at === undefined) {
    at = (db.query('SELECT applied_at FROM schema_migrations WHERE version = 358').get() as { applied_at: string } | null)?.applied_at ?? ''
    since.set(db, at)
  }
  return at
}
/** Request pushes this person already got in the last day, other than this notice's (a notice re-armed by a new request
 * of the same asker counts once; the request limits bound those). */
const requestPushesToday = (db: Database, n: Notice, now: number) => (db.query(`SELECT COUNT(DISTINCT d.notification_id) c FROM file_share_push_deliveries d
  JOIN file_share_notices o ON o.id = d.notification_id WHERE o.user_id = ? AND o.event_type = 'file.access_requested' AND o.id <> ? AND d.attempts > 0 AND o.created_at > ?`)
  .get(n.user_id, n.id, new Date(now - 86400_000).toISOString()) as { c: number }).c

type Notice = { id: string; created_at: string; user_id: string; event_type: string; source_id: string; named: number; read_at: string | null; suppressed: number }
const noticeOf = (db: Database, id: string) => db.query('SELECT id, created_at, user_id, event_type, source_id, named, read_at, suppressed FROM file_share_notices WHERE id = ?').get(id) as Notice | null

/** Where the notice opens now: one file's link page, the press's list, or the request in Activity (/activity/<notice id>,
 * ids only: the page reads the notice signed in) while it still waits on the person (null: nothing of it holds). */
function target(ctx: AppContext, n: Notice): string | null {
  const shares = fileSharesOf(ctx)
  if (n.event_type === 'file.access_requested') return shares.requestWaitsOn(n.user_id, n.source_id) ? `/activity/${n.id}` : null
  if (n.event_type !== 'file.shared') return null
  if (n.source_id.startsWith('b:')) {
    const id = n.source_id.slice(2)
    try { return shares.batchFiles(n.user_id, id).files.length ? fileBatchUrl(id) : null } catch { return null }
  }
  return shares.open(n.user_id, n.source_id).kind === 'open' ? fileLinkUrl(n.source_id) : null
}

/** Asked before and after each send (push-service.ts SOURCES wanted). */
export function fileSharePushWanted(ctx: AppContext, notificationId: string, now = Date.now()): boolean {
  const n = noticeOf(ctx.db, notificationId)
  if (!n || n.read_at || n.suppressed) return false
  // a share by name, or a request; nothing else of this table pushes
  if (n.event_type === 'file.shared' ? !n.named : n.event_type !== 'file.access_requested') return false
  const prefs = getPreferences(ctx.db, n.user_id)
  if (!pushEventEnabled(prefs, n.event_type as 'file.shared' | 'file.access_requested')) return false
  // made or retried inside the quiet hours: dropped, as a chat share's push is
  if (inQuietHours(prefs.quietHours, teamTimeZone(ctx.db), now)) return false
  if (n.event_type === 'file.access_requested') {
    const from = featureSince(ctx.db)
    if (!from || n.created_at < from) return false
    if (requestPushesToday(ctx.db, n, now) >= FILE_REQUEST_PUSHES_PER_DAY) return false
  }
  return target(ctx, n) !== null
}

/** A tap opens the file's link page, the press's list or the request while something of it still holds; else the
 * app's start page. */
export function fileSharePushPath(ctx: AppContext, notificationId: string): string | null {
  const n = noticeOf(ctx.db, notificationId)
  return n ? target(ctx, n) : null
}
