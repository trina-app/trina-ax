// Following a team file that something refers to by its path (a chat's "Add from team files" reference,
// uploads/team-refs.ts; a project room's file kept in the project folder, rooms/file-refs.ts). Both tables keep the
// same columns for it: where the file was last found (path), how far the file log was read (event_id), the trash item
// it went to (trash_id, trash_suffix), whether it was looked for and not found (lost), and its inode (ino, dev).
//   - moves and renames on the file screen are followed from file_events (delete {movedTo} / create {movedFrom}, also
//     of a folder above it), a trashed-then-restored file from its trash id, and a rename in the same folder that left
//     no event (the Mac's Finder) by inode. The events are read in batches until none are left, and how far the log was
//     read is remembered (also for a file that is gone), so a lookup only reads the events since the last one;
//   - reads keep what they learn in memory only (`persist` false); POST paths move the row forward.
// Who may see the file is not decided here: the caller checks it with today's rules once it knows the path.
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'

/** The follow columns of a reference row (team_file_refs, room_file_refs). */
export interface FollowCols { path: string; event_id: number; trash_id: string | null; trash_suffix: string | null; lost: number; ino: number | null; dev: number | null }

/** How far a reference was followed: its place after file event `eventId`. */
interface Follow { path: string; eventId: number; trash: { id: string; suffix: string } | null; lost: boolean }

/** What a follow found: the file's path now (null: gone), and where it was last (a trashed file: the place it was
 * trashed from). */
export interface Followed { found: string | null; last: string; trashed: boolean }

/** file_events read per query while following a reference (all of them are read, batch after batch) */
const EVENT_BATCH = 2000
/** follow states kept in memory (reads); the oldest are dropped first */
const CACHE_MAX = 20_000

export class RefFollower {
  private cache = new Map<string, Follow>()
  /** `table`/`key`: where the rows are and their id column; `root`: the team folder on disk */
  constructor(private db: Database, private root: () => string, private table: 'team_file_refs' | 'room_file_refs', private key: 'id' | 'room_file_id') {}

  /** the newest file event's id (a new reference starts after it) */
  lastEvent(): number { return (this.db.query('SELECT COALESCE(MAX(id), 0) AS n FROM file_events').get() as { n: number }).n }

  forget(id: string) { this.cache.delete(id) }

  /** The current path of the referenced file (found: null when it is gone: trashed, deleted, moved without a trace).
   * `persist`: the row's place is saved (and `row` updated in place). */
  follow(id: string, row: FollowCols, persist: boolean): Followed {
    const saved: Follow = { path: row.path, eventId: row.event_id, trash: row.trash_id ? { id: row.trash_id, suffix: row.trash_suffix ?? '' } : null, lost: row.lost === 1 }
    const mem = this.cache.get(id)
    const start = mem && mem.eventId >= saved.eventId ? mem : saved
    let p = start.path
    let trash = start.trash
    let last = start.eventId
    const q = this.db.query("SELECT id, path, action, detail FROM file_events WHERE id > ? AND action IN ('delete', 'restore') ORDER BY id LIMIT ?")
    for (;;) {
      const evs = q.all(last, EVENT_BATCH) as { id: number; path: string; action: string; detail: string | null }[]
      for (const e of evs) {
        last = e.id
        if (e.action === 'delete' && !trash) {
          const suffix = p === e.path ? '' : p.startsWith(e.path + '/') ? p.slice(e.path.length) : null
          if (suffix === null) continue
          const d = parse(e.detail)
          if (typeof d.movedTo === 'string') p = d.movedTo + suffix
          else if (typeof d.trashId === 'string') trash = { id: d.trashId, suffix }
        } else if (e.action === 'restore' && trash) {
          const d = parse(e.detail)
          if (d.trashId !== trash.id) continue
          p = e.path + trash.suffix
          trash = null
        }
      }
      if (evs.length < EVENT_BATCH) break
    }
    // a file that is gone is looked for again only at its place (an inode search of the folder ran once already)
    let lost = false
    let found: string | null = null
    if (!trash) {
      if (this.sameFile(p)) found = p
      else if (start.lost && start.path === p) lost = true
      else {
        found = this.byInode(p, row)
        if (found === null) lost = true
        else p = found
      }
    }
    const next: Follow = { path: p, eventId: last, trash, lost }
    if (next.path !== start.path || next.eventId !== start.eventId || next.lost !== start.lost || next.trash?.id !== start.trash?.id) {
      this.cache.delete(id)
      this.cache.set(id, next)
      if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!)
    }
    if (persist && (next.path !== saved.path || next.eventId !== saved.eventId || next.lost !== saved.lost || next.trash?.id !== saved.trash?.id)) {
      this.db.query(`UPDATE ${this.table} SET path = ?, event_id = ?, trash_id = ?, trash_suffix = ?, lost = ? WHERE ${this.key} = ?`)
        .run(next.path, next.eventId, next.trash?.id ?? null, next.trash?.suffix ?? null, next.lost ? 1 : 0, id)
      Object.assign(row, { path: next.path, event_id: next.eventId, trash_id: next.trash?.id ?? null, trash_suffix: next.trash?.suffix ?? null, lost: next.lost ? 1 : 0 })
    }
    return { found, last: p, trashed: !!trash }
  }

  /** a regular file at p (a file saved in place keeps its path even when the save made a new inode) */
  private sameFile(p: string): boolean {
    try { return fs.lstatSync(path.join(this.root(), ...p.split('/'))).isFile() } catch { return false }
  }

  /** a rename without an event (Finder): the same inode in the same folder */
  private byInode(p: string, row: Pick<FollowCols, 'ino' | 'dev'>): string | null {
    if (row.ino === null) return null
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
    const abs = path.join(this.root(), ...(dir ? dir.split('/') : []))
    try {
      for (const n of fs.readdirSync(abs)) {
        let st: fs.Stats
        try { st = fs.lstatSync(path.join(abs, n)) } catch { continue }
        if (st.isFile() && st.ino === row.ino && st.dev === row.dev) return dir ? `${dir}/${n}` : n
      }
    } catch {}
    return null
  }
}

/** Another reference, in either table, to the very file at `path` (`path_at_attach`) with this inode: a chat's or a
 * room's. A file someone else (or another chat or room) still shows is never trashed by one of them. `self`: the
 * reference asking, left out. */
export function otherRefTo(db: Database, self: { table: 'team_file_refs' | 'room_file_refs'; id: string }, f: { ino: number | null; dev: number | null; path: string; path_at_attach: string }): boolean {
  const where = 'ino = ? AND dev = ? AND (path IN (?, ?) OR path_at_attach IN (?, ?))'
  const args = [f.ino, f.dev, f.path, f.path_at_attach, f.path, f.path_at_attach]
  if (db.query(`SELECT 1 FROM team_file_refs WHERE id <> ? AND ${where} LIMIT 1`).get(self.table === 'team_file_refs' ? self.id : '', ...args)) return true
  return !!db.query(`SELECT 1 FROM room_file_refs WHERE room_file_id <> ? AND ${where} LIMIT 1`).get(self.table === 'room_file_refs' ? self.id : '', ...args)
}

function parse(s: string | null): Record<string, unknown> {
  try { const v = s ? JSON.parse(s) : {}; return v && typeof v === 'object' ? v : {} } catch { return {} }
}
