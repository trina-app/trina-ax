// "Ask to view" on a team-file link someone put in front of me (QA S-120 for a room message; QA after #651 for a shared
// chat's message; docs/decisions/20261122-room-link-ask-and-team-file-names.md). The caller has already checked the
// place: I see the message and the path is a team-file link in its own text, and `linker` is the person who wrote that
// link there (a room message's author or asker, a shared chat's sender or the person whose turn made the answer).
//
// The ask is an ordinary file access request (files/shares.ts request / answer, table file_access_requests): the file's
// owner, or with none the team owner and admins, answer with Share or Decline in Activity. It answers only when the
// linker can read the file now (always, also when a link row exists: else anyone could post a link to any path and
// learn from the answer whether it is there) and I cannot, and somebody may answer. Every other case is the one 'no':
// nothing here says whether a path exists, whose it is or where.
import type { AppContext } from '../context'
import { loadPrincipal, type Principal } from '../policy/access'
import { authorize } from '../policy/authorize'
import { fileSharesOf } from './shares'

/** A team path as a link writes it, in one form: NFC, no "/" at either end, no empty or "." parts. */
export const cleanLinkedPath = (p: string) => p.normalize('NFC').replace(/^\/+|\/+$/g, '').split('/').filter((x) => x && x !== '.').join('/')

export type LinkedAsk =
  | { kind: 'no' }
  /** it opens for me (by the folder rules, or by a grant: `link`, the file's /f/ link) */
  | { kind: 'open'; link?: string }
  /** I may ask: `shareId` the file's link row (null on a GET before any exists), `by` who answers by name only when that
   * is the linker (whom I see in the place anyway), `askedAt` my waiting ask */
  | { kind: 'ask'; shareId: string | null; by: string | null; askedAt: string | null }

/** `path` already clean (cleanLinkedPath). `create`: make the file's link row when there is none (only a POST). */
export function linkedFileAsk(ctx: AppContext, me: Principal, path: string, linkerId: string | null, create: boolean): LinkedAsk {
  const no = { kind: 'no' } as const
  if (me.role === 'guest' || !path || path.length > 4096) return no
  const rules = ctx.files.rules()
  const reads = (p: Principal) => { try { const r = authorize(ctx.files.fx, rules, p, path, 'read'); return !!r.st && r.st.isFile() } catch { return false } }
  // they can read it by the folder rules: it opens (the panel's own load failed for another reason)
  if (reads(me)) return { kind: 'open' }
  const linker = linkerId ? loadPrincipal(ctx.db, linkerId) : null
  if (!linker || linker.role === 'guest' || linker.id === me.id || !reads(linker)) return no
  const shares = fileSharesOf(ctx)
  // the file's link row: the live one, else (POST only) made by the linker, as any reader makes it on first use
  // (shares.linkFor; it never sets who owns the file)
  let shareId = shares.liveRow(path)?.id ?? null
  if (!shareId && create) {
    try { shareId = shares.linkFor(linker.id, path).id } catch { return no }
  }
  let to: string[]
  let askedAt: string | null = null
  if (shareId) {
    const row = shares.row(shareId)
    if (!row || row.kind !== 'file') return no
    const o = shares.open(me.id, shareId)
    if (o.kind === 'open') return { kind: 'open', ...(o.by === 'grant' ? { link: shareId } : {}) }
    if (o.kind !== 'no_access' || !o.share) return no
    to = shares.requestTargetsOf(shareId).filter((id) => id !== me.id)
    askedAt = (ctx.db.query("SELECT created_at FROM file_access_requests WHERE share_id = ? AND requester_id = ? AND state = 'pending'").get(shareId, me.id) as { created_at: string } | null)?.created_at ?? null
  } else {
    // no row yet (a GET): no grant and no request can hang on it; who would answer, as the row would have it
    to = shares.requestTargetsAt(path).filter((id) => id !== me.id)
  }
  if (!to.length) return no
  // who answers, by name, only when that is the linker: the owner of a file in a folder I cannot open is not mine to learn
  const by = to.length === 1 && to[0] === linker.id ? (ctx.db.query('SELECT name FROM users WHERE id = ? AND deleted_at IS NULL').get(linker.id) as { name: string } | null)?.name ?? null : null
  return { kind: 'ask', shareId, by, askedAt }
}
