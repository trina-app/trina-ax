// "Ask to view" on a team-file link in a room message (QA S-120, docs/decisions/20261122-room-link-ask-and-team-file-names.md).
// A room member who opens a link in a message and cannot read the file (a group folder they are not in, say) gets, in
// the side panel, "You don't have access to this file" and [Ask to view]. The ask is an ordinary file access request
// (files/shares.ts request / answer, table file_access_requests): the file's owner, or with none the team owner and
// admins, answer with Share or Decline in Activity, and Share is the existing view-only grant. No new kind, no change to
// the posted message.
//
// It answers only when every check passes: the caller is an active member who is not a guest, is in the room and sees
// that message (rooms/store.ts canSee: history, thread, hidden answers; never a deleted one or an event line), the path
// is a team-file link in that message's own text (answerFilePaths, the room renderer's rule), the caller cannot read the
// file now, and a request is possible by the file requests' own rules. Someone not in the room gets the room's 404, as
// on every room route; every other case is the one 'no' (GET) or 404 (POST): the route never tells whether a path
// exists, whose it is or where, so it cannot be used to probe paths.
import type { RoomFileAccess, RoomFileRequestResult, Locale } from '@mycel/shared/api'
import { answerFilePaths } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { fail } from '../http/errors'
import { loadPrincipal } from '../policy/access'
import { fileSharesOf } from '../files/shares'
import { cleanLinkedPath, linkedFileAsk, type LinkedAsk } from '../files/linked-file-ask'
import { LINK_ACCESS_PER_MINUTE } from '../chat/access-requests'
import { canSee, messageRow } from './store'
import { roomsOf } from './service'

const reads = new WeakMap<AppContext, Map<string, number[]>>()
/** One read of `userId`, or 429 past LINK_ACCESS_PER_MINUTE in the last minute (the link pages' limit). */
function readLimit(ctx: AppContext, userId: string, at = Date.now()): void {
  let m = reads.get(ctx)
  if (!m) { m = new Map(); reads.set(ctx, m) }
  const recent = (m.get(userId) ?? []).filter((x) => at - x < 60_000)
  if (recent.length >= LINK_ACCESS_PER_MINUTE) {
    m.set(userId, recent)
    fail('rate_limited', undefined, { retryAfter: Math.max(1, Math.ceil((60_000 - (at - recent[0]!)) / 1000)) })
  }
  recent.push(at)
  m.set(userId, recent)
  if (m.size > 10_000) for (const [k, ts] of m) if (!ts.some((x) => at - x < 60_000)) m.delete(k)
}

type Found = LinkedAsk

/** Every check of the file header, in order; nothing here says why it is 'no'. `create`: make the file's link row when
 * there is none (only the POST: a GET never writes). */
function find(ctx: AppContext, userId: string, roomId: string, messageId: string, path0: string, create: boolean): Found {
  const no = { kind: 'no' } as const
  const me = loadPrincipal(ctx.db, userId)
  if (!me || me.role === 'guest') return no
  // not in the room (or a room that is not there): the room's own 404, as every other room route answers
  const member = roomsOf(ctx).mine(userId, roomId).me
  const m = messageRow(ctx.db, roomId, messageId)
  if (!m || m.deleted_at || m.event || !canSee(ctx.db, m, member)) return no
  const path = cleanLinkedPath(typeof path0 === 'string' ? path0 : '')
  if (!path || path.length > 4096) return no
  // a link in that message's own text (the room renderer's and the store's rule)
  if (!answerFilePaths(m.body).some((p) => cleanLinkedPath(p) === path)) return no
  // the message's author (or, for the AI's answer, whoever asked it) linked it (files/linked-file-ask.ts)
  return linkedFileAsk(ctx, me, path, m.author_kind === 'user' ? m.author_id : m.asked_by, create)
}

/** GET /api/rooms/:id/messages/:messageId/file-access */
export function roomFileAccess(ctx: AppContext, userId: string, roomId: string, messageId: string, path: string): RoomFileAccess {
  readLimit(ctx, userId)
  const f = find(ctx, userId, roomId, messageId, path, false)
  if (f.kind === 'open') return { status: 'open', ...(f.link ? { link: f.link } : {}) }
  if (f.kind === 'no') return { status: 'no' }
  return f.askedAt ? { status: 'asked', askedAt: f.askedAt, by: f.by } : { status: 'ask', by: f.by }
}

/** POST /api/rooms/:id/messages/:messageId/file-access: the file request (its limits, its audit, its Activity row). */
export function requestRoomFile(ctx: AppContext, userId: string, roomId: string, messageId: string, path: string, L: Locale): RoomFileRequestResult {
  readLimit(ctx, userId)
  const f = find(ctx, userId, roomId, messageId, path, true)
  if (f.kind === 'open') return { status: 'open', ...(f.link ? { link: f.link } : {}) }
  if (f.kind === 'no' || !f.shareId) return fail('not_found')
  return fileSharesOf(ctx).request(userId, f.shareId, undefined, L)
}
