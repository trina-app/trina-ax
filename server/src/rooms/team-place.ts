// Where a file sent from the computer in a room goes (docs/AGENTS/plan/20261121-0619-structure-polish.md B): a
// project's chat room puts it in the project's Chat attachments folder (docs/decisions/20261120-project-is-room.md D3),
// and a department's team room (kind 'team', group_id) in `<group folder>/Chat attachments/`, both with a
// room_file_refs row (rooms/files.ts createInTeamFolder). Any other room, and a team room whose folder is not a fit,
// keeps it in room storage (.system/rooms), as before. A team room never refuses a file for its folder: it falls back.
//
// A team room's upload stays in room storage (teamPlaceFor answers null) when
//   - the group has no folder, its folder is not there (deleted, in the trash: its row is parked under .system/), or
//     safe operations are on;
//   - the uploader may not write the Chat attachments folder (or make it): a read-only person rule;
//   - the folder is read by someone outside the room (wider): an `everyone` rule or a role rule (members) at read or
//     above, another group with an active member outside the room, a person outside the room. Only the rules on the
//     walk from Chat attachments up to the nearest limited folder (the root, `groups/`, the group folder) are read,
//     never every account; the owner and admins read every folder outside users/ and are not counted (accepted by the
//     owner on 2026-11-21: they can open a department room's new uploads in Files);
//   - Chat attachments was narrowed: a room member cannot read it;
//   - the bytes are on the download-only list (the caller: they never become a team file).
// A copy fromTeamFile makes (answer-share, a phone's team pick) is room storage by its caller (o.roomStorage).
import type { Database } from 'bun:sqlite'
import { PRODUCT } from '@mycel/shared'
import { isFileListName } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { personLocale } from '../files/media-text'
import { atLeast, type Principal, type RuleSet } from '../policy/access'
import { instructionFile } from '../team-files/ai-trash'
import { FileError, httpError } from '../team-files/errors'
import { chatAttachmentsPlace, sharedUploadPlace, type SharedUploadPlace, type UploadFiles } from '../uploads/shared-chat'
import { projectRoomLink } from './project-room'
import type { RoomRow } from './store'

/** Where an upload in this room goes: the Chat attachments folder (team-relative) and whether it is there yet. */
export interface TeamPlace extends SharedUploadPlace { via: 'project' | 'group' }

const filesOf = (ctx: AppContext): UploadFiles => ({ fx: ctx.files.fx, rules: () => ctx.files.rules(), principal: (id) => ctx.files.principal(id) })

/** A name a file placed by a room upload never takes: an instruction file's (CLAUDE.md, AGENTS.md, GEMINI.md, SKILL.md)
 * or the file list's (_FILES.md), in any case; placeUpload gives the next free one ("CLAUDE (2).md"). */
export const reservedUploadName = (name: string): boolean =>
  instructionFile(name) || isFileListName(name.split('/').at(-1) ?? '')

/** A team room's group folder path while the group has one that is not in the trash (a trashed folder's row is parked
 * under .system/); else null. The database only: teamPlaceFor checks the disk. */
export function groupFolderOf(db: Database, room: Pick<RoomRow, 'kind' | 'group_id'>): string | null {
  if (room.kind !== 'team' || !room.group_id) return null
  const p = (db.query('SELECT f.path FROM groups g JOIN folders f ON f.id = g.folder_id WHERE g.id = ?').get(room.group_id) as { path: string } | null)?.path
  if (!p || p.split('/')[0] === PRODUCT.systemDir) return null
  return p
}

/** Does this room's computer upload normally go to a team folder (a team room whose group has a folder): its
 * room-stored files are then "Only in this conversation" (RoomFile.roomOnly), its Files list shows only those
 * (Room.roomFiles). A project's chat room: rooms/project-room.ts (PR 1 of the plan). */
export function roomHasTeamPlace(db: Database, room: Pick<RoomRow, 'kind' | 'group_id'>): boolean {
  return groupFolderOf(db, room) !== null
}

/** The room still holds files of its own: a sent file (its message not deleted) in room storage. */
export function hasRoomStoredFiles(db: Database, roomId: string): boolean {
  return !!db.query(`SELECT 1 FROM room_files f JOIN room_messages m ON m.id = f.message_id AND m.room_id = f.room_id
    WHERE f.room_id = ? AND f.message_id IS NOT NULL AND m.deleted_at IS NULL AND m.event IS NULL
      AND NOT EXISTS (SELECT 1 FROM room_file_refs rr WHERE rr.room_file_id = f.id) LIMIT 1`).get(roomId)
}

/**
 * Where `userId`'s computer upload in this room goes (rooms/files.ts create), or null for room storage.
 * A project's chat room: the project's place, with its refusals (403 shared_upload_read_only, 409 safe_ops, 404).
 * A team room: the group's place when it fits (the list at the top of this file), else null; never a refusal.
 */
export function teamPlaceFor(ctx: AppContext, roomId: string, userId: string): TeamPlace | null {
  const db = ctx.db
  const link = projectRoomLink(db, roomId)
  if (link) {
    try { return { ...sharedUploadPlace(db, filesOf(ctx), userId, { project_id: link.project_id }), via: 'project' } } catch (e) {
      if (e instanceof FileError && e.params?.reason === 'shared_upload_read_only') throw httpError('forbidden', 'sharedUploadReadOnly', personLocale(db, userId), undefined, { reason: 'shared_upload_read_only' })
      throw e
    }
  }
  const room = db.query('SELECT kind, group_id, archived_at FROM rooms WHERE id = ?').get(roomId) as Pick<RoomRow, 'kind' | 'group_id' | 'archived_at'> | null
  if (!room || room.archived_at) return null
  const folder = groupFolderOf(db, room)
  if (!folder) return null
  let place: SharedUploadPlace
  // not there, not a folder, safe operations, the uploader may not write there: room storage
  try { place = chatAttachmentsPlace(db, filesOf(ctx), folder, userId) } catch { return null }
  const rules = ctx.files.rules()
  if (widerThanRoom(db, rules, roomId, room.group_id!, place.folder)) return null
  if (!membersRead(db, rules, roomId, room.group_id!, place.folder)) return null
  return { ...place, via: 'group' }
}

/** The rules that reach `folder` (team-relative): those on it and on the folders above it, up to and including the
 * nearest limited one, that give at least read. */
function reachingRules(rules: RuleSet, folder: string): { subjectType: string; subjectId: string | null }[] {
  const segs = folder.split('/')
  const out: { subjectType: string; subjectId: string | null }[] = []
  for (let len = segs.length; len >= 0; len--) {
    const key = segs.slice(0, len).join('/')
    for (const r of rules.storedAt(key)) if (r.access !== 'none') out.push({ subjectType: r.subjectType, subjectId: r.subjectId })
    if (rules.limitedAt(key)) break
  }
  return out
}

/** Someone who is not the owner or an admin, is active, is not a guest and is not in the room (the SQL's tail). */
const OUTSIDER = `u.status = 'active' AND u.deleted_at IS NULL AND u.guest = 0 AND u.role NOT IN ('owner', 'admin')
  AND NOT EXISTS (SELECT 1 FROM room_members m WHERE m.room_id = ? AND m.user_id = u.id)`

/** Is `folder` read by someone outside the room (the rule subjects only: one query per rule at most, each indexed). */
export function widerThanRoom(db: Database, rules: RuleSet, roomId: string, groupId: string, folder: string): boolean {
  const anyone = db.query(`SELECT 1 FROM users u WHERE ${OUTSIDER} LIMIT 1`)
  const member = db.query(`SELECT 1 FROM users u WHERE u.role = 'member' AND ${OUTSIDER} LIMIT 1`)
  const inGroup = db.query(`SELECT 1 FROM group_members g JOIN users u ON u.id = g.user_id WHERE g.group_id = ? AND ${OUTSIDER} LIMIT 1`)
  const person = db.query(`SELECT 1 FROM users u WHERE u.id = ? AND ${OUTSIDER}`)
  for (const r of reachingRules(rules, folder)) {
    switch (r.subjectType) {
      case 'everyone': if (anyone.get(roomId)) return true; break
      // a rule for admins or the owner adds no one (they read it anyway); a guest's role rule never applies outside
      // projects/ (policy/access.ts)
      case 'role': if (r.subjectId === 'member' && member.get(roomId)) return true; break
      // the group itself: its active people are the room's (rooms/service.ts sync)
      case 'group': if (r.subjectId && r.subjectId !== groupId && inGroup.get(r.subjectId, roomId)) return true; break
      case 'user': if (r.subjectId && person.get(r.subjectId, roomId)) return true; break
    }
  }
  return false
}

/** Does every member of the room read `folder` now. The group's own rule reaching it answers for all of them (they are
 * its people); else each member is judged, their principals read in two queries. */
export function membersRead(db: Database, rules: RuleSet, roomId: string, groupId: string, folder: string): boolean {
  if (reachingRules(rules, folder).some((r) => r.subjectType === 'group' && r.subjectId === groupId)) return true
  const people = db.query(`SELECT u.id, u.name, CASE WHEN u.guest = 1 THEN 'guest' ELSE u.role END AS role, u.status FROM room_members m JOIN users u ON u.id = m.user_id WHERE m.room_id = ?`)
    .all(roomId) as { id: string; name: string; role: Principal['role']; status: string }[]
  const groups = new Map<string, string[]>()
  for (const g of db.query('SELECT g.user_id, g.group_id FROM group_members g JOIN room_members m ON m.user_id = g.user_id AND m.room_id = ?').all(roomId) as { user_id: string; group_id: string }[]) {
    (groups.get(g.user_id) ?? groups.set(g.user_id, []).get(g.user_id)!).push(g.group_id)
  }
  const segs = folder.split('/')
  for (const p of people) {
    if (p.status !== 'active') continue
    if (!atLeast(rules.access({ id: p.id, name: p.name, role: p.role, groups: groups.get(p.id) ?? [] }, segs), 'read')) return false
  }
  return true
}
