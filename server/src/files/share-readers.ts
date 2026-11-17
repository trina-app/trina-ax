// Who reads a path, counting folder shares (docs/decisions/20261116-folder-share-widening.md; the design:
// docs/AGENTS/plan/20261116-1147-folder-sharing.md "The widening hook").
//
// Before folder sharing, "who reads this path" was asked of the folder rules alone, and inside users/<id>/ the answer
// was always "only that person" (the rules give nobody else anything there, admins included). A folder share
// (files/folder-shares.ts) lets the people on it open everything inside the folder by its link. So every place that
// counts readers (the wider-audience card, the move and copy confirms, restores, the dev environment's view) asks here
// too. tests/unit/c-reader-counters.test.ts lists every such place and fails when a new one does not come through here.
//
// The rules:
//   - A share counts for a path at or below a live folder row (paused ones too: more readers is the safe direction for
//     a warning) whose owner is the users/<id> of the path, and only where a receiver could see the path at all
//     (share-places.ts receiverSees: not a hidden, temp, project or skill place inside the folder).
//   - Nested shares add up: every row at or above the path counts.
//   - Nothing here touches the disk, and nothing here imports chat code (chat/read-scope.ts imports this file).
import type { Database } from 'bun:sqlite'
import { FILE_SHARE_EVERYONE } from '@mycel/shared/api'
import { atLeast, type Principal, type RuleSet } from '../policy/access'
import { receiverSees } from './share-places'

const ALL = FILE_SHARE_EVERYONE

/** The paths that can carry a folder share at or above `segs` (depth 3 or deeper), nearest first. */
function sharePaths(segs: readonly string[]): string[] {
  const out: string[] = []
  for (let n = segs.length; n >= 3; n--) out.push(segs.slice(0, n).join('/'))
  return out
}

interface RowAt { id: string; path: string; paused: boolean }

/** The live folder rows at or above `segs` of the person whose folder it is, nearest first. `unpaused`: leave paused
 * rows out (what a receiver can open now); without it they count (a warning counts more readers, never fewer). */
function rowsAt(db: Database, segs: readonly string[], o: { unpaused?: boolean } = {}): RowAt[] {
  if (segs[0] !== 'users' || segs.length < 3 || !segs[1]) return []
  const paths = sharePaths(segs)
  const rows = db.query(`SELECT id, path, paused_at FROM file_shares WHERE kind = 'folder' AND state = 'live' AND owner_id = ?
      AND path IN (${paths.map(() => '?').join(',')})${o.unpaused ? ' AND paused_at IS NULL' : ''}`).all(segs[1], ...paths) as { id: string; path: string; paused_at: string | null }[]
  return rows.map((r) => ({ id: r.id, path: r.path, paused: !!r.paused_at })).sort((a, b) => b.path.length - a.path.length)
}

/** The active members (not guests) the grants of `ids` let in: by name, through a group, or the whole team. `upTo`: only
 * grants given at or before that time. */
function granteesOf(db: Database, ids: readonly string[], upTo?: string): Set<string> {
  const out = new Set<string>()
  if (!ids.length) return out
  const inIds = `g.share_id IN (${ids.map(() => '?').join(',')})${upTo ? ' AND g.granted_at <= ?' : ''}`
  const args = upTo ? [...ids, upTo] : [...ids]
  const alive = "u.status = 'active' AND u.deleted_at IS NULL AND u.guest = 0"
  for (const r of db.query(`SELECT u.id FROM file_share_grants g JOIN users u ON u.id = g.subject_id WHERE ${inIds} AND g.subject_type = 'user' AND ${alive}
      UNION SELECT u.id FROM file_share_grants g JOIN group_members m ON m.group_id = g.subject_id JOIN users u ON u.id = m.user_id WHERE ${inIds} AND g.subject_type = 'group' AND ${alive}
      UNION SELECT u.id FROM users u WHERE ${alive} AND EXISTS(SELECT 1 FROM file_share_grants g WHERE ${inIds} AND g.subject_type = 'group' AND g.subject_id = '${ALL}')`)
    .all(...args, ...args, ...args) as { id: string }[]) out.add(r.id)
  return out
}

/**
 * The active members a folder share at or above `segs` (actual names, a team path) lets in, besides its owner. Empty
 * for a path not under users/<id>/<name>, and for a path receiverSees() refuses. Counts live rows, paused ones too
 * (`unpaused` leaves them out), without touching the disk. `upTo`: only grants given at or before that time (a restore:
 * who had it then).
 */
export function shareReaders(db: Database, segs: readonly string[], o: { unpaused?: boolean; upTo?: string } = {}): Set<string> {
  const rows = rowsAt(db, segs, o)
  if (!rows.length || !receiverSees(db, segs)) return new Set()
  const out = granteesOf(db, rows.map((r) => r.id), o.upTo)
  out.delete(segs[1]!)
  return out
}

/** The ids of `people` who read `segs`: the folder rules, plus a folder share's people. */
export function readersAt(db: Database, rules: RuleSet, segs: readonly string[], people: readonly Principal[]): Set<string> {
  const shared = shareReaders(db, segs)
  return new Set(people.filter((p) => atLeast(rules.access(p, segs as string[]), 'read') || shared.has(p.id)).map((p) => p.id))
}

/** A check "does this person read `segs`" for many people and paths at once (the share readers of each path read
 * once): the folder rules, plus a folder share's people. */
export function readerCheck(db: Database, rules: RuleSet): (p: Principal, segs: readonly string[]) => boolean {
  const memo = new Map<string, Set<string>>()
  return (p, segs) => {
    if (atLeast(rules.access(p, segs as string[]), 'read')) return true
    if (segs[0] !== 'users' || segs.length < 3) return false
    const k = segs.join('/')
    let s = memo.get(k)
    if (!s) memo.set(k, (s = shareReaders(db, segs)))
    return s.has(p.id)
  }
}

/** users/<me>/… with nobody else on it: the only case that may still be treated as "only I see this". */
export function privateToMe(db: Database, me: string, segs: readonly string[]): boolean {
  return segs[0] === 'users' && segs[1] === me && shareReaders(db, segs).size === 0
}

/** A live share row (a file's link or a folder share, paused or not, with people on it or not yet) at `segs` or at any
 * folder above it: a row whose people may open it, or may be added by its owner's earlier link (a request) without the
 * file changing. Stricter than shareReaders, which counts only the people on it now: the test for "nobody else can open
 * this" before a change goes without a card (chat/turn.ts ownFolderTarget). Fails closed: an error says yes. */
export function anyShareAt(db: Database, segs: readonly string[]): boolean {
  try {
    if (!segs.length) return false
    const paths = segs.map((_, i) => segs.slice(0, i + 1).join('/'))
    return !!db.query(`SELECT 1 FROM file_shares WHERE state = 'live' AND path IN (${paths.map(() => '?').join(',')}) LIMIT 1`).get(...paths)
  } catch { return true }
}

/** The nearest live, unpaused folder share row at or above `segs` that a receiver would open this path through, or
 * null (also for a path a receiver cannot see: a hidden, temp, project or skill place inside the folder). */
export function shareAbove(db: Database, segs: readonly string[]): string | null {
  const rows = rowsAt(db, segs, { unpaused: true })
  if (!rows.length || !receiverSees(db, segs)) return null
  return rows[0]!.id
}

/** Who reads what came from inside the folder share `shareId` now, besides its owner: its people and those of the
 * shares above it, while the row is live and not paused (else nobody: the owner alone). */
export function shareSourceReaders(db: Database, shareId: string): Set<string> {
  const row = db.query("SELECT path, owner_id FROM file_shares WHERE id = ? AND kind = 'folder' AND state = 'live' AND paused_at IS NULL").get(shareId) as { path: string; owner_id: string | null } | null
  if (!row) return new Set()
  const segs = row.path.split('/')
  if (segs[0] !== 'users' || segs[1] !== row.owner_id) return new Set()
  return shareReaders(db, segs, { unpaused: true })
}

/** The folders of `userId`'s own files that are shared with someone now (live rows with people, paused ones too): the
 * dev environment never writes in them (devenv/srt/access.ts). */
export function ownSharedFolders(db: Database, userId: string): string[] {
  return (db.query(`SELECT s.path FROM file_shares s WHERE s.kind = 'folder' AND s.state = 'live' AND s.owner_id = ?
      AND substr(s.path, 1, length(?)) = ? AND EXISTS(SELECT 1 FROM file_share_grants g WHERE g.share_id = s.id) ORDER BY s.path`).all(userId, `users/${userId}/`, `users/${userId}/`) as { path: string }[]).map((r) => r.path)
}

/** The active members (not guests) the grants of the share `shareId` let in now (its own grants only). */
export function shareGrantees(db: Database, shareId: string): Set<string> {
  return granteesOf(db, [shareId])
}

/** The people the live folder share rows at or under `rel` let in (a trash or a removal ends them). */
export function folderGranteesUnder(db: Database, rel: string): string[] {
  const ids = (db.query("SELECT id FROM file_shares WHERE kind = 'folder' AND state = 'live' AND (path = ? OR substr(path, 1, length(?) + 1) = ? || '/')").all(rel, rel, rel) as { id: string }[]).map((r) => r.id)
  return [...granteesOf(db, ids)]
}

/** The people `ownerId`'s live folder shares let in (the owner's account turned off or removed). */
export function ownerFolderGrantees(db: Database, ownerId: string): string[] {
  const ids = (db.query("SELECT id FROM file_shares WHERE kind = 'folder' AND state = 'live' AND owner_id = ?").all(ownerId) as { id: string }[]).map((r) => r.id)
  return [...granteesOf(db, ids)]
}

/** Does the team have a live folder share row (with people or not: a group's delete has just taken its grants)? */
export function anyFolderShare(db: Database): boolean {
  return !!db.query("SELECT 1 FROM file_shares WHERE kind = 'folder' AND state = 'live' LIMIT 1").get()
}
