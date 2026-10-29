// The history of one file, read from file_events (QA AITOOL-13 / B-W3-1, TEAM-03 / B-W7-6).
// file_events.path is the path at the time of the event: a move does not rewrite it. So the timeline is read backward
// from the current path and follows each move to the path before it: the file's own 'create {movedFrom}' row, or the
// one of a folder above it (a folder move writes one row for the folder only). A trash restore follows the item back
// to its original path. The walk stops at the event that made the file: a plain create, a non-replacing upload or
// copy, or the delete of another file that had the same name before.
import type { Database } from 'bun:sqlite'

export type TimelineKind = 'created' | 'edited' | 'uploaded' | 'restored' | 'moved' | 'renamed' | 'copied' | 'conflict'
export interface TimelineEntry {
  id: number
  at: string
  userId: string
  /** the AI turn the change happened in (null: a person on the file screen) */
  turnId: string | null
  kind: TimelineKind
  /** the path of the file just after the event */
  path: string
  /** moved / renamed: the path before; copied: the source file; restored from the trash: the original path */
  from: string | null
  size: number | null
  sha256: string | null
}
/** the kinds that give the file new content */
export const CONTENT_KINDS: ReadonlySet<TimelineKind> = new Set(['created', 'edited', 'uploaded', 'restored', 'copied'])

interface Row { id: number; turn_id: string | null; user_id: string; path: string; action: string; size: number | null; sha256: string | null; detail: string | null; at: string }
const BATCH = 500
const MAX_READS = 40

const parentOf = (p: string) => p.split('/').slice(0, -1).join('/')
/** `p` and every folder above it */
const selfAndAbove = (p: string) => { const s = p.split('/'); return s.map((_, i) => s.slice(0, i + 1).join('/')) }
function parse(detail: string | null): Record<string, unknown> {
  if (!detail) return {}
  try { const d = JSON.parse(detail); return d && typeof d === 'object' ? d : {} } catch { return {} }
}

/** Newest first. `stop`: end the walk after the first entry for which it returns true (that entry is included). */
export function fileTimeline(db: Database, rel: string, o: { limit?: number; stop?: (e: TimelineEntry) => boolean } = {}): TimelineEntry[] {
  const limit = o.limit ?? 200
  const out: TimelineEntry[] = []
  let cur = rel
  let before = Number.MAX_SAFE_INTEGER
  let skipTrash: string | null = null
  const push = (r: Row, kind: TimelineKind, from: string | null): boolean => {
    const e: TimelineEntry = { id: r.id, at: r.at, userId: r.user_id, turnId: r.turn_id, kind, path: cur, from, size: r.size, sha256: r.sha256 }
    out.push(e)
    return out.length >= limit || !!o.stop?.(e)
  }
  const moveKind = (from: string, to: string, d: Record<string, unknown>): TimelineKind =>
    d.tool === 'rename_file' || parentOf(from) === parentOf(to) ? 'renamed' : 'moved'

  outer: for (let reads = 0; reads < MAX_READS && cur; reads++) {
    const keys = selfAndAbove(cur)
    const rows = db.query(`SELECT id, turn_id, user_id, path, action, size, sha256, detail, at FROM file_events
      WHERE id < ? AND path IN (${keys.map(() => '?').join(',')}) ORDER BY id DESC LIMIT ${BATCH}`).all(before, ...keys) as Row[]
    for (const r of rows) {
      before = r.id
      const d = parse(r.detail)
      const folder = d.folder === true
      if (r.path !== cur) {
        // a folder above was moved or renamed: the file was at the same place inside the folder's old path
        if (r.action === 'create' && folder && typeof d.movedFrom === 'string') {
          const from = d.movedFrom + cur.slice(r.path.length)
          if (push(r, moveKind(from, cur, d), from)) break outer
          cur = from
          continue outer
        }
        continue
      }
      if (folder) continue // a folder that once had this exact path
      switch (r.action) {
        case 'delete':
          if (typeof d.movedTo === 'string') continue // the other half of a move row, read from the 'create'
          if (skipTrash && d.trashId === skipTrash) { skipTrash = null; continue } // went to the trash, came back
          break outer // another file had this name before
        case 'create': {
          if (typeof d.movedFrom === 'string') {
            if (push(r, moveKind(d.movedFrom, cur, d), d.movedFrom)) break outer
            cur = d.movedFrom
            continue outer
          }
          if (Array.isArray(d.sourcePaths)) {
            const src = typeof d.sourcePaths[0] === 'string' ? d.sourcePaths[0] : null
            if (push(r, 'copied', src) || !d.replaced) break outer
            continue
          }
          push(r, 'created', null)
          break outer
        }
        case 'upload':
          if (push(r, 'uploaded', null) || !d.replaced) break outer
          continue
        case 'update':
          if (push(r, 'edited', null)) break outer
          continue
        case 'restore': {
          const trashId = typeof d.trashId === 'string' ? d.trashId : null
          const original = typeof d.originalPath === 'string' ? d.originalPath : null
          if (push(r, 'restored', trashId ? original : null)) break outer
          if (trashId) {
            skipTrash = trashId
            if (original && original !== cur) { cur = original; continue outer }
          }
          continue
        }
        case 'conflict':
          if (push(r, 'conflict', null)) break outer
          continue
        default:
          continue
      }
    }
    if (rows.length < BATCH) break
  }
  return out
}

/** Who made the content `sha` of the file at `rel`: the newest content event, when it made exactly this content.
 * null: not known (the file changed outside the app, or its events are older than the retention period). */
export function contentOrigin(db: Database, rel: string, sha: string): { userId: string; turnId: string | null; at: string } | null {
  const [e] = fileTimeline(db, rel, { limit: 1000, stop: (x) => CONTENT_KINDS.has(x.kind) }).filter((x) => CONTENT_KINDS.has(x.kind))
  return e && e.sha256 === sha ? { userId: e.userId, turnId: e.turnId, at: e.at } : null
}

/**
 * Where the place `p` had at file event `afterId` is now: the folders above it can have been moved, renamed or put in
 * the trash since then, and their rules went with them. The live rules at the old path string are then the rules of
 * whatever folder holds that name now (or of the folder above), not the rules that held the place (review: a file
 * moved out of shared/<restricted>, then that folder renamed or trashed, showed its edits in there and the folder's
 * old name to every member). Each later move of a folder above is followed to where it went, and a trashed one to
 * where it was restored. `gone`: a folder above is still in the trash, or was purged or deleted for good.
 */
export function placeNow(db: Database, p: string, afterId: number): { at: string } | { gone: string } {
  let cur = p
  let after = afterId
  for (let n = 0; n < 64; n++) {
    const above = selfAndAbove(cur).slice(0, -1)
    if (!above.length) return { at: cur }
    const r = db.query(`SELECT id, path, detail FROM file_events WHERE id > ? AND action = 'delete'
      AND path IN (${above.map(() => '?').join(',')}) AND CASE WHEN json_valid(detail) THEN json_extract(detail, '$.folder') END = 1
      ORDER BY id ASC LIMIT 1`).get(after, ...above) as { id: number; path: string; detail: string | null } | null
    if (!r) return { at: cur }
    const d = parse(r.detail)
    const rest = cur.slice(r.path.length)
    if (typeof d.movedTo === 'string') { cur = d.movedTo + rest; after = r.id; continue }
    if (typeof d.trashId === 'string') {
      const back = db.query(`SELECT id, path FROM file_events WHERE id > ? AND action = 'restore'
        AND CASE WHEN json_valid(detail) THEN json_extract(detail, '$.trashId') END = ? ORDER BY id ASC LIMIT 1`).get(r.id, d.trashId) as { id: number; path: string } | null
      if (back) { cur = back.path + rest; after = back.id; continue }
    }
    return { gone: cur }
  }
  return { gone: cur }
}
