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
import { loadPrincipal, type Principal } from '../policy/access'
import { authorize } from '../policy/authorize'
import { fileSharesOf } from '../files/shares'
import { LINK_ACCESS_PER_MINUTE } from '../chat/access-requests'
import { canSee, messageRow } from './store'
import { roomsOf } from './service'

const clean = (p: string) => p.normalize('NFC').replace(/^\/+|\/+$/g, '').split('/').filter((x) => x && x !== '.').join('/')

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

type Found = { kind: 'no' } | { kind: 'open'; link?: string } | { kind: 'ask'; shareId: string; by: string | null; askedAt: string | null }

/** Every check of the file header, in order; nothing here says why it is 'no'. */
function find(ctx: AppContext, userId: string, roomId: string, messageId: string, path0: string): Found {
  const no = { kind: 'no' } as const
  const me = loadPrincipal(ctx.db, userId)
  if (!me || me.role === 'guest') return no
  // not in the room (or a room that is not there): the room's own 404, as every other room route answers
  const member = roomsOf(ctx).mine(userId, roomId).me
  const m = messageRow(ctx.db, roomId, messageId)
  if (!m || m.deleted_at || m.event || !canSee(ctx.db, m, member)) return no
  const path = clean(typeof path0 === 'string' ? path0 : '')
  if (!path || path.length > 4096) return no
  // a link in that message's own text (the room renderer's and the store's rule)
  if (!answerFilePaths(m.body).some((p) => clean(p) === path)) return no
  const rules = ctx.files.rules()
  const reads = (p: Principal) => { try { const r = authorize(ctx.files.fx, rules, p, path, 'read'); return !!r.st && r.st.isFile() } catch { return false } }
  // they can read it by the folder rules: it opens (the panel's own load failed for another reason)
  if (reads(me)) return { kind: 'open' }
  const shares = fileSharesOf(ctx)
  // the file's link row: the live one, else made by the message's author while they can still read it (as any reader
  // makes it on first use, shares.linkFor; it never sets who owns the file)
  const authorId = m.author_kind === 'user' ? m.author_id : m.asked_by
  const author = authorId ? loadPrincipal(ctx.db, authorId) : null
  let shareId = shares.liveRow(path)?.id ?? null
  if (!shareId) {
    if (!author || author.role === 'guest' || !reads(author)) return no
    try { shareId = shares.linkFor(author.id, path).id } catch { return no }
  }
  const row = shares.row(shareId)
  if (!row || row.kind !== 'file') return no
  const o = shares.open(userId, shareId)
  if (o.kind === 'open') return { kind: 'open', ...(o.by === 'grant' ? { link: shareId } : {}) }
  if (o.kind !== 'no_access' || !o.share) return no
  const to = shares.requestTargetsOf(shareId).filter((id) => id !== userId)
  if (!to.length) return no
  const asked = ctx.db.query("SELECT created_at FROM file_access_requests WHERE share_id = ? AND requester_id = ? AND state = 'pending'").get(shareId, userId) as { created_at: string } | null
  // who answers, by name, only when that is the message's own author (whom the viewer sees in the room anyway): the
  // owner of a file in a folder they cannot open is not theirs to learn
  const by = author && to.length === 1 && to[0] === author.id ? (ctx.db.query('SELECT name FROM users WHERE id = ? AND deleted_at IS NULL').get(author.id) as { name: string } | null)?.name ?? null : null
  return { kind: 'ask', shareId, by, askedAt: asked?.created_at ?? null }
}

/** GET /api/rooms/:id/messages/:messageId/file-access */
export function roomFileAccess(ctx: AppContext, userId: string, roomId: string, messageId: string, path: string): RoomFileAccess {
  readLimit(ctx, userId)
  const f = find(ctx, userId, roomId, messageId, path)
  if (f.kind === 'open') return { status: 'open', ...(f.link ? { link: f.link } : {}) }
  if (f.kind === 'no') return { status: 'no' }
  return f.askedAt ? { status: 'asked', askedAt: f.askedAt, by: f.by } : { status: 'ask', by: f.by }
}

/** POST /api/rooms/:id/messages/:messageId/file-access: the file request (its limits, its audit, its Activity row). */
export function requestRoomFile(ctx: AppContext, userId: string, roomId: string, messageId: string, path: string, L: Locale): RoomFileRequestResult {
  readLimit(ctx, userId)
  const f = find(ctx, userId, roomId, messageId, path)
  if (f.kind === 'open') return { status: 'open', ...(f.link ? { link: f.link } : {}) }
  if (f.kind === 'no') return fail('not_found')
  return fileSharesOf(ctx).request(userId, f.shareId, undefined, L)
}
