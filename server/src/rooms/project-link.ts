// The project link of a room (migration 427, docs/decisions/20261119-channel-project-link.md, retired by
// docs/decisions/20261120-project-is-room.md): what is left of 0.5.21's "private channel linked to a project" are the
// read helpers a project's own chat room uses (rooms/project-room.ts). A row counts here only as an ACTIVE project room:
// mode 'room' (a 'linked' row is settled at start, rooms/project-room.ts settleLinkedInTx), the room a named group room
// that is not archived, the project not in the trash and on a folder exactly projects/<name> (the members-only zone).
// Link, unlink, Create a channel and Undo of Save to project are gone (their endpoints answer 410).
//
// Who sees what: Room.project only for a viewer who can open the project now (read on its folder). The event lines
// name the project only to a viewer who can open it. Audit rows name the project only, never the room (store.ts
// roomAuditRef: a group room by its kind).
import type { Database } from 'bun:sqlite'
import type { Room } from '@mycel/shared/api'
import { CHAT_FILES_FOLDER } from '@mycel/shared'
import { atLeast, inProjectZone, loadPrincipal, RuleSet, type Principal } from '../policy/access'
import { audit } from '../admin/audit'
import { roomAuditRef, type RoomRow } from './store'

/** A projects row as the link reads it. */
export interface LinkedProjectRow { id: string; name: string; folder_path: string; trashed_with: string | null; created_by: string | null }

/** A project's folder is exactly projects/<name> (the members-only zone's floor): the only kind that links. */
export const linkableFolder = (folder: string): boolean => { const s = folder.split('/'); return s.length === 2 && !!s[1] && inProjectZone(s) }
/** A private channel: a group room with a name of its own, not archived. */
export const isPrivateChannelRow = (r: Pick<RoomRow, 'kind' | 'name' | 'archived_at'>): boolean => r.kind === 'group' && !!r.name?.trim() && !r.archived_at
/** The project side of an active link: not in the trash, on projects/<name>. */
export const projectLinkable = (p: Pick<LinkedProjectRow, 'folder_path' | 'trashed_with'>): boolean => p.trashed_with === null && linkableFolder(p.folder_path)

const PROJECT_COLS = 'p.id, p.name, p.folder_path, p.trashed_with, p.created_by'

/** The project whose chat room this is, while it is active; else null. */
export function activeProjectOf(db: Database, roomId: string): LinkedProjectRow | null {
  const r = db.query(`SELECT ${PROJECT_COLS}, r.kind, r.name AS room_name, r.archived_at FROM room_project_links l JOIN rooms r ON r.id = l.room_id JOIN projects p ON p.id = l.project_id WHERE l.room_id = ? AND l.mode = 'room'`)
    .get(roomId) as (LinkedProjectRow & { kind: RoomRow['kind']; room_name: string | null; archived_at: string | null }) | null
  if (!r || !isPrivateChannelRow({ kind: r.kind, name: r.room_name, archived_at: r.archived_at }) || !projectLinkable(r)) return null
  return { id: r.id, name: r.name, folder_path: r.folder_path, trashed_with: r.trashed_with, created_by: r.created_by }
}

/** The project's chat room, while it is active; else null. */
export function activeRoomOf(db: Database, projectId: string): RoomRow | null {
  const r = db.query(`SELECT r.*, p.folder_path, p.trashed_with FROM room_project_links l JOIN rooms r ON r.id = l.room_id JOIN projects p ON p.id = l.project_id WHERE l.project_id = ? AND l.mode = 'room'`)
    .get(projectId) as (RoomRow & { folder_path: string; trashed_with: string | null }) | null
  if (!r || !isPrivateChannelRow(r) || !projectLinkable(r)) return null
  const { folder_path: _f, trashed_with: _t, ...room } = r
  return room
}

/** The rooms linked to these projects (any row, active or not, either mode): who to tell when a project changes. */
export function linkedRoomsOf(db: Database, projectIds: readonly string[]): string[] {
  if (!projectIds.length) return []
  return (db.query(`SELECT room_id FROM room_project_links WHERE project_id IN (${projectIds.map(() => '?').join(',')})`).all(...projectIds) as { room_id: string }[]).map((r) => r.room_id)
}

/** What the viewer may do with a project folder: open it (read, and the folder listable), save into it (write, not a
 * guest). */
function sight(rules: RuleSet, who: Principal, folder: string): { opens: boolean; writes: boolean } {
  const segs = folder.split('/')
  const access = rules.access(who, segs)
  const opens = atLeast(access, 'read') && rules.canList(who, segs)
  return { opens, writes: opens && !rules.isGuest(who) && atLeast(access, 'write') }
}

/** Room.project for one viewer (store.ts roomOut): the project of an active project room when they can open it now. `rules`: the
 * caller's set when it judges many rooms at once (rulesOnce). */
export function projectForViewer(db: Database, room: Pick<RoomRow, 'id' | 'kind' | 'name' | 'archived_at'>, userId: string, rules?: () => RuleSet, memberCount?: number): Room['project'] | undefined {
  if (!isPrivateChannelRow(room)) return undefined
  const p = activeProjectOf(db, room.id)
  if (!p) return undefined
  const who = loadPrincipal(db, userId)
  if (!who) return undefined
  const set = rules ? rules() : RuleSet.load(db)
  const s = sight(set, who, p.folder_path)
  if (!s.opens) return undefined
  // its members are the project's people (the sync keeps them so): the last one cannot leave (chat/project-leave.ts)
  const n = memberCount ?? (db.query('SELECT COUNT(*) n FROM room_members WHERE room_id = ?').get(room.id) as { n: number }).n
  return { id: p.id, name: p.name, folderPath: p.folder_path, canSave: s.writes, room: true, attach: attachFor(set, who, p.folder_path), leave: n > 1 ? 'yes' : 'last' }
}

/** Room.project.attach: write on the project folder and on its Chat attachments folder by any language's name (the
 * upload reuses the one there: uploads/shared-chat.ts sharedUploadPlace, which checks again), guests included. */
function attachFor(rules: RuleSet, who: Principal, folder: string): 'ok' | 'read_only' | 'folder' {
  const segs = folder.split('/')
  if (!atLeast(rules.access(who, segs), 'write')) return 'read_only'
  return Object.values(CHAT_FILES_FOLDER).every((name) => atLeast(rules.access(who, [...segs, name]), 'write')) ? 'ok' : 'folder'
}

/** The project's name as an event line shows it to one viewer: only when they can open it now. One RuleSet for a page. */
export function eventProjectsFor(db: Database, projectIds: readonly string[], userId: string): Map<string, { id: string; name: string }> {
  const out = new Map<string, { id: string; name: string }>()
  const ids = [...new Set(projectIds)]
  if (!ids.length || !userId) return out
  const who = loadPrincipal(db, userId)
  if (!who) return out
  const rules = RuleSet.load(db)
  for (const r of db.query(`SELECT id, name, folder_path, trashed_with FROM projects WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as LinkedProjectRow[]) {
    if (r.trashed_with !== null) continue
    const segs = r.folder_path.split('/')
    if (atLeast(rules.access(who, segs), 'read')) out.set(r.id, { id: r.id, name: r.name })
  }
  return out
}

/** Inside the caller's transaction: the link of a room that is archived (its last person left), or of a project deleted
 * for good, goes, audited by the system. Returns the rooms whose link went (for room.updated). */
export function dropLinksInTx(db: Database, by: { roomId: string } | { projectId: string }): string[] {
  const rows = db.query(`SELECT l.room_id, l.project_id, r.kind FROM room_project_links l JOIN rooms r ON r.id = l.room_id WHERE ${'roomId' in by ? 'l.room_id' : 'l.project_id'} = ?`)
    .all('roomId' in by ? by.roomId : by.projectId) as { room_id: string; project_id: string; kind: RoomRow['kind'] }[]
  for (const r of rows) {
    db.query('DELETE FROM room_project_links WHERE room_id = ?').run(r.room_id)
    audit(db, { actor: null, action: 'project.channel_unlink', target: r.project_id, detail: { room: roomAuditRef({ id: r.room_id, kind: r.kind }), via: 'roomId' in by ? 'room_archived' : 'project_deleted', replaced: false } })
  }
  return rows.map((r) => r.room_id)
}

// ---------------- live: Room.project follows an access change ----------------
/** The project rooms these people sit in now, as `<roomId> <userId>` (read before an access change). One query
 * per 500 people. Never throws. */
export function linkedRoomSeats(db: Database, userIds: readonly string[]): Set<string> {
  const out = new Set<string>()
  try {
    for (let i = 0; i < userIds.length; i += 500) {
      const part = userIds.slice(i, i + 500)
      const rows = db.query(`SELECT m.room_id, m.user_id FROM room_members m JOIN room_project_links l ON l.room_id = m.room_id JOIN rooms r ON r.id = m.room_id
        WHERE r.kind = 'group' AND r.archived_at IS NULL AND l.mode = 'room' AND m.user_id IN (${part.map(() => '?').join(',')})`).all(...part) as { room_id: string; user_id: string }[]
      for (const r of rows) out.add(`${r.room_id} ${r.user_id}`)
    }
  } catch { /* nobody is told */ }
  return out
}

/** For the live pass: who in `seats` whose answer for the room's project folder (open it: Room.project; save into it:
 * canSave) differs before and after an access change, by room. Only rooms whose project folder is at, under or above a
 * changed folder. */
export function linkedSightFlips(db: Database, before: { principals: readonly Principal[]; rules: RuleSet }, after: { principals: readonly Principal[]; rules: RuleSet }, changed: readonly string[], seats: ReadonlySet<string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  if (!changed.length || !seats.size) return out
  const near = (f: string, p: string) => p === '' || f === p || f.startsWith(p + '/') || p.startsWith(f + '/')
  const byRoom = new Map<string, string[]>()
  for (const seat of seats) {
    const [roomId, userId] = seat.split(' ') as [string, string]
    ;(byRoom.get(roomId) ?? byRoom.set(roomId, []).get(roomId)!).push(userId)
  }
  const stillIn = db.query('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?')
  const was = new Map(before.principals.map((p) => [p.id, p])), now = new Map(after.principals.map((p) => [p.id, p]))
  for (const [roomId, users] of byRoom) {
    const p = activeProjectOf(db, roomId)
    if (!p || !changed.some((c) => near(p.folder_path, c))) continue
    const flipped = new Set<string>()
    for (const u of users) {
      const pb = was.get(u), pa = now.get(u)
      if (!pb || !pa || !stillIn.get(roomId, u)) continue
      const a = sight(before.rules, pb, p.folder_path), b = sight(after.rules, pa, p.folder_path)
      if (a.opens !== b.opens || a.writes !== b.writes) flipped.add(u)
    }
    if (flipped.size) out.set(roomId, flipped)
  }
  return out
}
