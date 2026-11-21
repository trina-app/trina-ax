// A team project is its own chat room (docs/decisions/20261120-project-is-room.md, migration 430). A project room is a
// named `group` room (an older build shows it as a private channel) with a room_project_links row of mode 'room':
//
//   made       lazily, the first time someone opens Chat room (POST /api/projects/:id/room: openInTx, get-or-create
//              inside one immediate write, the unique index on project_id settling a race), named after the project;
//   members    never a choice: the project's readers (readersOf: every active account whose folder rules give at least
//              read on projects/<name>, guests by their person rules; the owner and admins outside it are not), put
//              right by Rooms.sync's project-room step (plan(): want/have per room, for the rooms near a changed folder
//              or all at start), with no group size cap; Add people, Remove, Rename and Leave are refused in it
//              (refuseInProjectRoom), leaving is leaving the project;
//   history    a later member sees it from the room's floor (history_floor_seq: 0 for a room made here; a converted
//              channel's seq at the conversion), rooms/history.ts historyRoom;
//   trash      while the project is in the trash its room is held: members, mutes, read positions and alert levels are
//              kept, the sync leaves it alone, and it is hidden and refused (HELD_SQL, Rooms.mine 404); the restore puts its
//              people right again;
//   deleted    deleteProjectForGood archives it in its own write before the project row goes (archiveRoomsOf: the link
//              cascades with the project, which would otherwise leave a plain channel that keeps everyone).
//
// The 0.5.21 linked channels (mode 'linked', or a row an older build wrote after a rollback) are settled once at start
// (settleLinkedInTx, after the step that drops disabled accounts): the same people as the project's readers become its
// room (each member keeps where they see it from, one event line), anything else loses the link and stays a plain private
// channel. Audit rows name the project and the room by its kind only (store.ts roomAuditRef), never the room's id.
import type { Database } from 'bun:sqlite'
import type { Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { newId, nowIso } from '../db'
import { fail } from '../http/errors'
import { audit } from '../admin/audit'
import { tr } from '../chat/i18n'
import { atLeast, loadPrincipal, RuleSet, type Principal } from '../policy/access'
import { FileError, httpError } from '../team-files/errors'
import { sharedUploadPlace } from '../uploads/shared-chat'
import { isPrivateChannelRow, linkableFolder, projectLinkable, type LinkedProjectRow } from './project-link'
import { memberRow, roomAuditRef, unreadCount, type RoomRow } from './store'

// (the two SQL helpers are function declarations: modules that build SQL constants at load, rooms/inbox.ts, may be
// reached while this module is still loading)
/** SQL: the room `a` is a project room (a mode 'room' link, whatever its project's state). */
export function PROJECT_ROOM_SQL(a: string): string { return `EXISTS (SELECT 1 FROM room_project_links prl WHERE prl.room_id = ${a}.id AND prl.mode = 'room')` }
/** SQL: the room `a` is not held (a project room whose project is in the trash: hidden and refused, its rows kept). */
export function NOT_HELD_SQL(a: string): string { return `NOT EXISTS (SELECT 1 FROM room_project_links hl JOIN projects hp ON hp.id = hl.project_id WHERE hl.room_id = ${a}.id AND hl.mode = 'room' AND hp.trashed_with IS NOT NULL)` }

/** The project-room link of a room (mode 'room'), whatever the state of its room and project; else null. */
export function projectRoomLink(db: Database, roomId: string): { project_id: string; history_floor_seq: number } | null {
  return db.query("SELECT project_id, history_floor_seq FROM room_project_links WHERE room_id = ? AND mode = 'room'").get(roomId) as { project_id: string; history_floor_seq: number } | null
}
/** Is this project room listed before its first message (made on purpose: a conversion, "New project with")? */
export const isListedProjectRoom = (db: Database, roomId: string): boolean =>
  !!db.query("SELECT 1 FROM room_project_links WHERE room_id = ? AND mode = 'room' AND listed = 1").get(roomId)
/** Is this room a project's chat room (a mode 'room' link)? */
export const isProjectRoom = (db: Database, roomId: string): boolean => !!projectRoomLink(db, roomId)
/** A project room whose project is in the trash: kept as it is, hidden and refused until the project is back. */
export const isHeld = (db: Database, roomId: string): boolean =>
  !!db.query("SELECT 1 FROM room_project_links l JOIN projects p ON p.id = l.project_id WHERE l.room_id = ? AND l.mode = 'room' AND p.trashed_with IS NOT NULL").get(roomId)
/** Where a later member of a project room sees it from (0 for a room made as one). */
export const historyFloor = (db: Database, roomId: string): number => projectRoomLink(db, roomId)?.history_floor_seq ?? 0

/** The project's room (its mode 'room' link, the room not archived), or null. */
export function roomOfProject(db: Database, projectId: string): RoomRow | null {
  return db.query("SELECT r.* FROM room_project_links l JOIN rooms r ON r.id = l.room_id WHERE l.project_id = ? AND l.mode = 'room' AND r.archived_at IS NULL").get(projectId) as RoomRow | null
}

/** The active accounts as principals (guests included: their person rules decide), for one pass. */
export function activePeople(db: Database): Principal[] {
  const ids = db.query("SELECT id FROM users WHERE status = 'active' AND deleted_at IS NULL ORDER BY id").all() as { id: string }[]
  return ids.map((r) => loadPrincipal(db, r.id)).filter((p): p is Principal => !!p)
}
/** Who reads the project now (chat/shared.ts Audiences.of, with the caller's rules and people): nobody while it is in
 * the trash. The room's members follow exactly this. */
export function readersOf(rules: RuleSet, people: readonly Principal[], p: Pick<LinkedProjectRow, 'folder_path' | 'trashed_with'>): Set<string> {
  if (p.trashed_with !== null) return new Set()
  const segs = p.folder_path.split('/')
  return new Set(people.filter((x) => atLeast(rules.access(x, segs), 'read')).map((x) => x.id))
}

/** An event line inside the caller's write (Rooms.eventLine's rule: the room's next seq), by the system or by `author`. */
export function systemLine(db: Database, roomId: string, e: Record<string, unknown>, now: string, author: string | null = null): string {
  const id = newId()
  const seq = (db.query('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq').get(roomId) as { last_seq: number }).last_seq
  db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, visibility, body, mentions, created_at, event)
    VALUES (?, ?, ?, 'user', ?, 'room', '', '[]', ?, ?)`).run(id, roomId, seq, author, now, JSON.stringify(e))
  return id
}

const PROJECT_COLS = 'id, name, folder_path, trashed_with, created_by'
const projectRow = (db: Database, id: string): LinkedProjectRow | null => db.query(`SELECT ${PROJECT_COLS} FROM projects WHERE id = ?`).get(id) as LinkedProjectRow | null

/**
 * D7: a mode 'linked' row (0.5.21's linked private channel, or one an older build wrote), inside the caller's write.
 * The room an active private channel, the project active in projects/<name>, and the room's members exactly the
 * project's readers: it becomes the project's room (each member keeps where they see it from, the floor is the room's
 * seq now, the room takes the project's name, one event line); anything else: the link row goes and the channel stays as
 * it is. Audited as project.room { via: 'converted' | 'unlinked' }. Returns what happened, with the line's id.
 * `made` (POST /api/rooms/:id/make-project, rooms/make-project.ts): the conversation was made the project by `actor`
 * just now; the line is theirs ({ type: 'project_made', projectId, by }) and the audit's via is 'made' (the room by its
 * kind only). The caller treats anything but 'converted' as a refusal (its write rolls back). Without it, the start
 * pass is as before.
 */
export function settleLinkedInTx(db: Database, roomId: string, rules: RuleSet, people: readonly Principal[], made?: { actor: string; via: 'made' }): { roomId: string; state: 'converted'; line: string } | { roomId: string; state: 'unlinked' } | null {
  const l = db.query("SELECT project_id FROM room_project_links WHERE room_id = ? AND mode = 'linked'").get(roomId) as { project_id: string } | null
  if (!l) return null
  const room = db.query('SELECT * FROM rooms WHERE id = ?').get(roomId) as RoomRow | null
  const p = projectRow(db, l.project_id)
  const now = nowIso()
  let same = false
  if (room && p && isPrivateChannelRow(room) && projectLinkable(p)) {
    const want = readersOf(rules, people, p)
    const have = new Set((db.query('SELECT user_id FROM room_members WHERE room_id = ?').all(roomId) as { user_id: string }[]).map((r) => r.user_id))
    same = want.size > 0 && want.size === have.size && [...want].every((u) => have.has(u))
  }
  if (!same || !room || !p) {
    db.query('DELETE FROM room_project_links WHERE room_id = ?').run(roomId)
    audit(db, { actor: null, action: 'project.room', target: l.project_id, detail: { room: roomAuditRef({ id: roomId, kind: room?.kind ?? 'group' }), via: 'unlinked' } })
    return { roomId, state: 'unlinked' }
  }
  // each member keeps their start (nobody suddenly sees messages from before they joined); later members see from now on
  db.query('UPDATE room_members SET history_from_seq = visible_from_seq, history_recheck = 0 WHERE room_id = ?').run(roomId)
  db.query("UPDATE room_project_links SET mode = 'room', history_floor_seq = ? WHERE room_id = ?").run(room.last_seq, roomId)
  if (room.name !== p.name) db.query('UPDATE rooms SET name = ? WHERE id = ?').run(p.name, roomId)
  const line = made
    ? systemLine(db, roomId, { type: 'project_made', projectId: p.id, by: made.actor }, now, made.actor)
    : systemLine(db, roomId, { type: 'project_room', projectId: p.id }, now)
  audit(db, { actor: made?.actor ?? null, action: 'project.room', target: p.id, detail: { room: roomAuditRef(room), via: made ? 'made' : 'converted' } })
  return { roomId, state: 'converted', line }
}

/** Every mode 'linked' row's room (the start pass). */
export const linkedRows = (db: Database): string[] => (db.query("SELECT room_id FROM room_project_links WHERE mode = 'linked' ORDER BY linked_at, room_id").all() as { room_id: string }[]).map((r) => r.room_id)

/** Which project rooms a sync pass looks at: all of them (start, the minute tick), those whose project folder is at,
 * under or above a folder whose access changed (afterAccessChange), or those of these projects (a restore, a rename). */
export type ProjectRoomScope = 'all' | { paths: readonly string[] } | { ids: readonly string[] }

/** One project room as the sync puts it right: who should be in it and who is. */
export interface RoomPlan { roomId: string; projectId: string; want: Set<string>; have: Set<string> }

/** The project rooms in `scope` whose project is active (not in the trash, on projects/<name>), with their readers and
 * members. One rules load and one people load per pass; held rooms and archived ones are left out. */
export function plan(db: Database, scope: ProjectRoomScope, rules: RuleSet, people: readonly Principal[]): RoomPlan[] {
  const rows = db.query(`SELECT l.room_id, p.id, p.name, p.folder_path, p.trashed_with, p.created_by FROM room_project_links l JOIN rooms r ON r.id = l.room_id
    JOIN projects p ON p.id = l.project_id WHERE l.mode = 'room' AND r.archived_at IS NULL ORDER BY l.room_id`).all() as (LinkedProjectRow & { room_id: string })[]
  const near = (f: string, c: string) => c === '' || f === c || f.startsWith(c + '/') || c.startsWith(f + '/')
  const inScope = (r: LinkedProjectRow) => scope === 'all' || ('paths' in scope ? scope.paths.some((c) => near(r.folder_path, c)) : scope.ids.includes(r.id))
  const out: RoomPlan[] = []
  for (const r of rows) {
    if (!inScope(r) || !projectLinkable(r)) continue
    const want = readersOf(rules, people, r)
    const have = new Set((db.query('SELECT user_id FROM room_members WHERE room_id = ?').all(r.room_id) as { user_id: string }[]).map((x) => x.user_id))
    out.push({ roomId: r.room_id, projectId: r.id, want, have })
  }
  return out
}

/**
 * Get or make the project's room, inside the caller's immediate write. Checked for `userId` first: they read the project
 * (not in the trash), else 404 like a missing project; a personal or older project (outside projects/<name>) has none,
 * 409 project_not_linkable. A 'linked' row of this project is settled first (D7). The room is named after the project,
 * its members the project's readers, everyone seeing it from its first line. Audited when made (project.room 'created').
 */
export function openInTx(db: Database, userId: string, projectId: string, locale: Locale, listed = false): { roomId: string; created: boolean; settled: ReturnType<typeof settleLinkedInTx> } {
  const p = projectRow(db, projectId)
  const who = loadPrincipal(db, userId)
  const rules = RuleSet.load(db)
  if (!p || !who || p.trashed_with !== null || !atLeast(rules.access(who, p.folder_path.split('/')), 'read')) return fail('not_found')
  if (!linkableFolder(p.folder_path)) fail('conflict', tr('projectRoomTeamOnly', locale), { params: { reason: 'project_not_linkable' } })
  const people = activePeople(db)
  const linked = db.query("SELECT room_id FROM room_project_links WHERE project_id = ? AND mode = 'linked'").get(p.id) as { room_id: string } | null
  const settled = linked ? settleLinkedInTx(db, linked.room_id, rules, people) : null
  const found = db.query("SELECT l.room_id, r.archived_at FROM room_project_links l JOIN rooms r ON r.id = l.room_id WHERE l.project_id = ? AND l.mode = 'room'").get(p.id) as { room_id: string; archived_at: string | null } | null
  // opened on purpose ("New project with"): listed from the start, also a room the project page made first
  if (found && !found.archived_at) {
    if (listed) db.query("UPDATE room_project_links SET listed = 1 WHERE room_id = ?").run(found.room_id)
    return { roomId: found.room_id, created: false, settled }
  }
  // an archived room's row never blocks a new one
  if (found) db.query('DELETE FROM room_project_links WHERE room_id = ?').run(found.room_id)
  const id = newId(), now = nowIso()
  db.query("INSERT INTO rooms (id, kind, created_by, created_at, activity_at, name) VALUES (?, 'group', NULL, ?, ?, ?)").run(id, now, now, p.name)
  db.query("INSERT INTO room_project_links (room_id, project_id, linked_by, linked_at, mode, history_floor_seq, listed) VALUES (?, ?, ?, ?, 'room', 0, ?)").run(id, p.id, userId, now, listed ? 1 : 0)
  const add = db.query('INSERT INTO room_members (room_id, user_id, joined_at, history_from_seq) VALUES (?, ?, ?, 0)')
  const readers = readersOf(rules, people, p)
  readers.add(userId)
  for (const u of readers) add.run(id, u, now)
  audit(db, { actor: userId, action: 'project.room', target: p.id, detail: { room: { kind: 'group' }, via: 'created' } })
  return { roomId: id, created: true, settled }
}

/** The project rooms of a project deleted for good, archived in their own write before its row goes (the link would
 * cascade with the project and leave a plain channel that keeps everyone). Returns each room with its members, for
 * the caller to tell them. Audited as project.room 'archived'. */
export function archiveRoomsOf(db: Database, projectId: string): { roomId: string; members: string[] }[] {
  return db.transaction(() => {
    const rows = db.query("SELECT l.room_id FROM room_project_links l JOIN rooms r ON r.id = l.room_id WHERE l.project_id = ? AND l.mode = 'room' AND r.archived_at IS NULL").all(projectId) as { room_id: string }[]
    const now = nowIso()
    const out: { roomId: string; members: string[] }[] = []
    for (const r of rows) {
      const members = (db.query('SELECT user_id FROM room_members WHERE room_id = ?').all(r.room_id) as { user_id: string }[]).map((x) => x.user_id)
      db.query('UPDATE rooms SET archived_at = ? WHERE id = ?').run(now, r.room_id)
      // (its link goes in the same write: nothing later treats it as a link to unlink or tell about)
      db.query('DELETE FROM room_project_links WHERE room_id = ?').run(r.room_id)
      audit(db, { actor: null, action: 'project.room', target: projectId, detail: { room: { kind: 'group' }, via: 'archived' } })
      out.push({ roomId: r.room_id, members })
    }
    return out
  })()
}

/** The project rooms of these projects whose name is not the project's: renamed to it (a project rename; an older build
 * shows the right name too). Returns the rooms renamed. */
export function followNames(db: Database, projectIds: readonly string[]): string[] {
  if (!projectIds.length) return []
  return (db.query(`UPDATE rooms SET name = (SELECT p.name FROM room_project_links l JOIN projects p ON p.id = l.project_id WHERE l.room_id = rooms.id)
    WHERE id IN (SELECT l.room_id FROM room_project_links l JOIN projects p ON p.id = l.project_id WHERE l.mode = 'room' AND l.project_id IN (${projectIds.map(() => '?').join(',')}) AND (rooms.name IS NULL OR rooms.name <> p.name))
    RETURNING id`).all(...projectIds) as { id: string }[]).map((r) => r.id)
}

/** Add people, Remove, Rename and Leave inside a project room: refused, its people follow the project (403
 * project_room). */
export function refuseInProjectRoom(db: Database, room: Pick<RoomRow, 'id' | 'kind'>, locale: Locale): void {
  if (room.kind === 'group' && isProjectRoom(db, room.id)) fail('forbidden', tr('projectRoomPeople', locale), { params: { reason: 'project_room' } })
}

/** A file from the computer into a project room: only for someone who may add files to the project's Chat attachments
 * folder (uploads/shared-chat.ts sharedUploadPlace, the project's shared chat's rule), else 403 shared_upload_read_only.
 * Any other room, and the place's other answers (safe operations, a folder not there), change nothing here. */
export function assertRoomUpload(ctx: AppContext, userId: string, roomId: string, locale: Locale): void {
  const l = projectRoomLink(ctx.db, roomId)
  if (!l) return
  try {
    sharedUploadPlace(ctx.db, { fx: ctx.files.fx, rules: () => ctx.files.rules(), principal: (id) => ctx.files.principal(id) }, userId, { project_id: l.project_id })
  } catch (e) {
    if (e instanceof FileError && e.params?.reason === 'shared_upload_read_only') throw httpError('forbidden', 'sharedUploadReadOnly', locale, undefined, { reason: 'shared_upload_read_only' })
  }
}

/** Project.room for one viewer who reads the project (the caller checked it, and that it is not `member: false`): the
 * room's id and their unread count (0 while the sync has not put them in it yet). Nothing for a project that has no
 * room, one in the trash or outside projects/<name>. */
export function roomForViewer(db: Database, p: Pick<LinkedProjectRow, 'id' | 'folder_path' | 'trashed_with'>, userId: string): { room?: { id: string; unread: number } } {
  if (!projectLinkable(p)) return {}
  const room = roomOfProject(db, p.id)
  if (!room) return {}
  const me = memberRow(db, room.id, userId)
  return { room: { id: room.id, unread: me ? unreadCount(db, room.id, me).n : 0 } }
}
