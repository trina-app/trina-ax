// A phone push when someone shares a file, or several in one press, with me by name (QA TC-3510,
// docs/decisions/20261116-file-share-everyone.md; migration 356). The notice is the Inbox's (file_share_notices, one per
// person and press); only a notice of a share BY NAME (named=1) is pushed (a group's or the whole team's people get the
// Inbox row alone, as with chats), only while it holds: unread, outside the person's quiet hours, and a file of it still
// opens for them. The push carries ids and the event code only (the gateway picks a generic line); never a file name.
import type { Database } from 'bun:sqlite'
import { fileBatchUrl, fileLinkUrl, inQuietHours } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { teamTimeZone } from '../admin/settings'
import { getPreferences } from '../notifications/preferences'
import { fileSharesOf } from './shares'

type Notice = { user_id: string; event_type: string; source_id: string; named: number; read_at: string | null; suppressed: number }
const noticeOf = (db: Database, id: string) => db.query('SELECT user_id, event_type, source_id, named, read_at, suppressed FROM file_share_notices WHERE id = ?').get(id) as Notice | null

/** Where the notice opens now: one file's link page, or the press's list (null: nothing of it opens for the person). */
function target(ctx: AppContext, n: Notice): string | null {
  if (n.event_type !== 'file.shared') return null
  const shares = fileSharesOf(ctx)
  if (n.source_id.startsWith('b:')) {
    const id = n.source_id.slice(2)
    try { return shares.batchFiles(n.user_id, id).files.length ? fileBatchUrl(id) : null } catch { return null }
  }
  return shares.open(n.user_id, n.source_id).kind === 'open' ? fileLinkUrl(n.source_id) : null
}

/** Asked before and after each send (push-service.ts SOURCES wanted). */
export function fileSharePushWanted(ctx: AppContext, notificationId: string, now = Date.now()): boolean {
  const n = noticeOf(ctx.db, notificationId)
  if (!n || !n.named || n.read_at || n.suppressed) return false
  // made or retried inside the quiet hours: dropped, as a chat share's push is
  if (inQuietHours(getPreferences(ctx.db, n.user_id).quietHours, teamTimeZone(ctx.db), now)) return false
  return target(ctx, n) !== null
}

/** A tap opens the file's link page or the press's list while something of it still opens; else the app's start page. */
export function fileSharePushPath(ctx: AppContext, notificationId: string): string | null {
  const n = noticeOf(ctx.db, notificationId)
  return n ? target(ctx, n) : null
}
