// "Make it a project" (프로젝트로 만들기) on a conversation: GET and POST /api/rooms/:id/make-project
// (docs/AGENTS/plan/20261121-0619-structure-polish.md A, shared/src/api/rooms.ts MakeProjectInfo / MakeProjectBody). A
// named private channel or an unnamed group chat (kind 'group', not archived, no project link of either mode) becomes a
// new team project: its active members are the project's people, the room becomes the project's chat room (renamed to
// it, each member keeps where they see it from, people added later see it from now on), and the files every member
// sees move to the project's Chat attachments afterwards (rooms/file-moves.ts). The room id stays, so each person's pin,
// hidden state, mute, read position, section, threads, reactions and apps stay.
//
// Checks, in this order: an active member who is not a guest (else 404 from Rooms.mine, admins outside included, and
// an archived room is one nobody is in; a guest never gets here: the guest gate refuses both endpoints with 403,
// http/route.ts GUEST_ENDPOINTS); convertible (else 409 not_convertible, again inside the write: two conversions at
// once give one project and one 409, the loser's folder unmade); may make team projects (403, the GET too); safe
// operations off (409 safe_ops); the name (422); no guest who holds another project (409 guest_one_place with
// guestId); inside the write the active members still hash to what the confirm showed (409 members_changed).
// The GET is rate limited like the project access dry run (routes/chats.ts previewLimit) and names a clash of the name
// with another project's folder only when the caller reads that project: otherwise it answers the name as typed, so
// it never tells which project folders exist.
// Steps, as POST /api/projects team (routes/chats.ts): captureState, the folder (outside the write: it touches the disk),
// then one immediate write: the gone accounts leave the room, the project row, its people's rules (writeFolderAccess
// limited; a guest takes it as their project there, auth/guests.ts claimGuestProject), the room renamed, a 'linked' row
// settled at once (rooms/project-room.ts settleLinkedInTx with `made`: the rules and people read after the rules' write
// and the guest's claim; anything but 'converted' rolls it all back as members_changed), alert levels kept, the guests'
// group-chat slot cleared, the move rows, the audit (project.create { via: 'room' }, naming no room). Then markTeamShares,
// afterAccessChange, room.updated to every member and the mover's kick. Any failure unmakes the folder.
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { roomLevel, type Locale, type MakeProjectInfo, type UserRef } from '@mycel/shared/api'
import { isFileListName } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { newId, nowIso } from '../db'
import { fail } from '../http/errors'
import { audit } from '../admin/audit'
import { afterAccessChange, captureState, ensureFolderRow, validateRules, writeFolderAccess } from '../admin/folders'
import { GUEST_ONE_PLACE_MSG, heldProject } from '../auth/guests'
import { tr } from '../chat/i18n'
import { assertMayCreateTeamProject, checkParticipants, makeProjectFolder, newProjectRules, unmakeProjectFolder } from '../chat/project-access'
import { assertFolderFree, canRead, projectFolderName, projectOnFolder, takenProjectPaths } from '../chat/projects'
import { markTeamShares } from '../chat/team-shares'
import { getPreferences } from '../notifications/preferences'
import { RuleSet, type Principal } from '../policy/access'
import { safeOpsEnabled } from '../safe-ops/runner'
import { instructionFile } from '../team-files/ai-trash'
import { ownLevel, setOwnLevel } from './alerts'
import { roomFileMovesOf, splitFiles } from './file-moves'
import { activePeople, settleLinkedInTx } from './project-room'
import { roomsOf } from './service'
import { memberRow, messageRow, roomRow, type RoomRow } from './store'

/** A new project's name: at most this many characters (shared/src/api/chats.ts CreateProjectBody). */
export const PROJECT_NAME_MAX = 100

interface Member { id: string; name: string; guest: number }
/** The room's active members (disabled and deleted accounts left out), by name. */
export function activeMembers(db: Database, roomId: string): Member[] {
  return db.query(`SELECT u.id, u.name, u.guest FROM room_members m JOIN users u ON u.id = m.user_id
    WHERE m.room_id = ? AND u.status = 'active' AND u.deleted_at IS NULL ORDER BY u.name, u.id`).all(roomId) as Member[]
}
/** The hash of the member ids the confirm showed (MakeProjectInfo.membersHash). */
export const membersHash = (ids: readonly string[]): string => createHash('sha256').update([...ids].sort().join('\n')).digest('hex').slice(0, 32)

/** A group chat with no project link of either mode, not archived: it may become a project. */
function convertible(db: Database, room: Pick<RoomRow, 'id' | 'kind' | 'archived_at'>): boolean {
  return room.kind === 'group' && !room.archived_at && !db.query('SELECT 1 FROM room_project_links WHERE room_id = ?').get(room.id)
}
/**
 * 409 for a room that cannot become a project. Called only after the caller's own checks passed (a member who is not a
 * guest, roomFor; one who may make team projects, assertMayCreateTeamProject), so it is never a probe for anyone else.
 * The loser of a simultaneous conversion (TC-6731) is told it just became a project, with its id: reason already_project,
 * only for a room a conversation became (its 'project_made' line, the one file-moves.ts closeLine also looks for) and
 * only for a caller who reads that project. Every other case (a room made as a project's own room, a project the caller
 * cannot read, a DM, a team room) is the same not_convertible as before, naming nothing.
 */
function notConvertible(ctx: AppContext, p: Principal, roomId: string, locale: Locale): never {
  const db = ctx.db
  const link = db.query("SELECT l.project_id, l.history_floor_seq, pr.folder_path FROM room_project_links l JOIN projects pr ON pr.id = l.project_id WHERE l.room_id = ? AND l.mode = 'room'").get(roomId) as { project_id: string; history_floor_seq: number; folder_path: string } | null
  const made = !!link && !!db.query("SELECT 1 FROM room_messages WHERE room_id = ? AND seq > ? AND event IS NOT NULL AND json_extract(event, '$.type') = 'project_made' AND json_extract(event, '$.projectId') = ? LIMIT 1").get(roomId, link.history_floor_seq, link.project_id)
  if (!link || !made || !canRead(ctx.files, p, link.folder_path)) return fail('conflict', tr('roomNotConvertible', locale), { params: { reason: 'not_convertible' } })
  return fail('conflict', tr('roomAlreadyProject', locale), { params: { reason: 'already_project', projectId: link.project_id } })
}
const membersChanged = (locale: Locale): never => fail('conflict', tr('roomMembersChanged', locale), { params: { reason: 'members_changed' } })

/** The room for an active member who is not a guest, else 404 (an outsider, an admin outside it and a guest alike). */
function roomFor(ctx: AppContext, p: Principal, roomId: string): RoomRow {
  if (p.role === 'guest') return fail('not_found')
  return roomsOf(ctx).mine(p.id, roomId).room
}

/** Why a name cannot be a new project's (the confirm's line), or null. */
export function nameError(name: string, locale: Locale): string | null {
  const n = name.normalize('NFC').trim()
  if (!n) return tr('makeProjectNameEmpty', locale)
  if ([...n].length > PROJECT_NAME_MAX) return tr('makeProjectNameLong', locale, { n: String(PROJECT_NAME_MAX) })
  if (instructionFile(n) || isFileListName(n)) return tr('makeProjectNameReserved', locale)
  return null
}

/** The guests among the members who hold another project: they cannot take this one (the confirm's block). */
function guestsBlocked(db: Database, members: readonly Member[]): UserRef[] {
  return members.filter((m) => m.guest && heldProject(db, m.id) !== null).map((m) => ({ id: m.id, name: m.name }))
}

/** The name field's first value: the room's own name, or for an unnamed group chat "New project" in the caller's
 * language (QA TC-6955: the other people's names, "Mina, Olga", made a poor project and folder name; the field opens
 * selected, so typing replaces it, and a taken name steps to "-2" as any other). */
function suggestedName(room: RoomRow, locale: Locale): string {
  const own = room.name?.trim()
  if (own) return own
  return tr('makeProjectDefaultName', locale)
}

/** GET /api/rooms/:id/make-project: what the confirm shows. */
export function makeProjectInfo(ctx: AppContext, p: Principal, roomId: string, typed: string | undefined, locale: Locale): MakeProjectInfo {
  const db = ctx.db
  const room = roomFor(ctx, p, roomId)
  // permission first: who may not make a project is refused as such, before anything is said about the room
  assertMayCreateTeamProject(db, p, locale, 'projectsAdminsOnlyRoom')
  if (!convertible(db, room)) notConvertible(ctx, p, room.id, locale)
  const members = activeMembers(db, room.id)
  const suggested = suggestedName(room, locale)
  const name = (typed ?? suggested).normalize('NFC').trim()
  const err = nameError(name, locale)
  const stepped = err ? '' : projectFolderName(path.join(ctx.files.fx.root, 'projects'), 'projects', takenProjectPaths(db), name, newId())
  // the folder name steps around another project's folder ("-2"): said only when the caller reads that project
  // (assertFolderFree's mayName rule); any other reason to step (a folder or a project they cannot see) stays unsaid
  const clash = !err && stepped !== name ? projectOnFolder(db, ctx.files.fx.caseInsensitive, `projects/${name}`) : null
  const told = !!clash && canRead(ctx.files, p, clash.folderPath)
  const folderName = err ? '' : told ? stepped : name
  const files = splitFiles(ctx, room.id)
  return {
    suggestedName: suggested, members: members.map((m) => ({ id: m.id, name: m.name })), guestsBlocked: guestsBlocked(db, members),
    filesMoving: files.moving.length, filesStaying: files.staying, membersHash: membersHash(members.map((m) => m.id)),
    folderName, nameTaken: told, ...(err ? { nameError: err } : {}),
  }
}

/** POST /api/rooms/:id/make-project: the new project's id (the caller answers with the Project and the Room). */
export function makeProject(ctx: AppContext, p: Principal, roomId: string, body: { name: string; membersHash: string }, locale: Locale): { projectId: string } {
  const db = ctx.db
  const rooms = roomsOf(ctx)
  const room = roomFor(ctx, p, roomId)
  // permission first: who may not make a project is refused as such, before anything is said about the room
  assertMayCreateTeamProject(db, p, locale, 'projectsAdminsOnlyRoom')
  if (!convertible(db, room)) notConvertible(ctx, p, room.id, locale)
  if (safeOpsEnabled()) fail('conflict', tr('sharedChatSafeOps', locale), { params: { reason: 'safe_ops' } })
  const name = body.name.normalize('NFC').trim()
  const bad = nameError(name, locale)
  if (bad) fail('validation', bad, { fields: { 'body.name': bad } })
  const guestBlock = () => {
    const g = guestsBlocked(db, activeMembers(db, room.id))[0]
    if (g) fail('conflict', GUEST_ONE_PLACE_MSG[locale] ?? GUEST_ONE_PLACE_MSG.en, { params: { reason: 'guest_one_place', guestId: g.id } })
  }
  guestBlock()
  if (membersHash(activeMembers(db, room.id).map((m) => m.id)) !== body.membersHash) membersChanged(locale)
  const id = newId()
  const before = captureState(db)
  const made = makeProjectFolder(ctx, { id, name, locale })
  const moves = roomFileMovesOf(ctx)
  let gone: ReturnType<typeof rooms.dropGoneInTx> = null
  let line = ''
  try {
    db.transaction(() => {
      // 2 again: another conversion may have won meanwhile
      const now = roomRow(db, room.id)
      if (!now || !convertible(db, now)) notConvertible(ctx, p, room.id, locale)
      // the gone accounts leave first: the settle below compares every member row with the project's readers
      gone = rooms.dropGoneInTx(room.id)
      const members = activeMembers(db, room.id)
      if (membersHash(members.map((m) => m.id)) !== body.membersHash) membersChanged(locale)
      guestBlock()
      // each member's alert level, as it applies before (a group chat) and would after (a project room)
      const levels: { userId: string; level: 'all' | 'mentions' | 'off' }[] = []
      for (const m of members) {
        const row = memberRow(db, room.id, m.id)
        if (!row || ownLevel(row)) continue
        const def = getPreferences(db, m.id).roomLevel
        const was = roomLevel('group', null, def, false), will = roomLevel('group', null, def, true)
        if (was !== will) levels.push({ userId: m.id, level: was })
      }
      assertFolderFree(db, ctx.files.fx.caseInsensitive, made.path, locale, { mayName: (f) => canRead(ctx.files, p, f) })
      db.query('INSERT INTO projects (id, name, folder_path, instructions, created_by, created_at, instructions_author, instructions_authored, folder_made) VALUES (?,?,?,?,?,?,?,?,1)')
        .run(id, name, made.path, '', p.id, nowIso(), p.id, '')
      // its people: every active member (the caller is its creator); a guest among them takes it as their project here
      const participants = checkParticipants(db, p, members.filter((m) => m.id !== p.id).map((m) => ({ subjectType: 'user' as const, subjectId: m.id })), locale)
      const rules = newProjectRules(participants, p.id)
      validateRules(db, rules, locale, 'body.name')
      writeFolderAccess(db, ensureFolderRow(db, made.path).id, { rules, limited: true }, p.id)
      // named after the project (an unnamed group chat gets its name here: a project room is a named group room)
      db.query('UPDATE rooms SET name = ? WHERE id = ?').run(name, room.id)
      db.query("INSERT INTO room_project_links (room_id, project_id, linked_by, linked_at, mode) VALUES (?, ?, ?, ?, 'linked')").run(room.id, id, p.id, nowIso())
      // the rules and people read now, after the rules' write and a guest's claim (a guest's reach is in RuleSet.load)
      const settled = settleLinkedInTx(db, room.id, RuleSet.load(db), activePeople(db), { actor: p.id, via: 'made' })
      if (settled?.state !== 'converted') membersChanged(locale)
      line = (settled as { line: string }).line
      // made on purpose: listed for everyone before its first message (rooms/project-room.ts isListedProjectRoom)
      db.query('UPDATE room_project_links SET listed = 1 WHERE room_id = ?').run(room.id)
      for (const l of levels) setOwnLevel(db, room.id, l.userId, l.level)
      // a project room is never a guest's group-chat place: their project slot holds it now
      db.query('UPDATE guests SET room_id = NULL WHERE room_id = ?').run(room.id)
      moves.planInTx(room.id, id, p.id)
      audit(db, { actor: p.id, action: 'project.create', target: id, detail: { name, folderPath: made.path, rules, via: 'room' } })
    }).immediate()
  } catch (e) {
    unmakeProjectFolder(ctx, made)
    throw e
  }
  markTeamShares(db, p.id, 'created', [id])
  afterAccessChange(ctx, before, { actor: p.id, target: made.path, created: [made.path] })
  rooms.afterGoneDropped(room.id, gone)
  rooms.roomEvent(room.id, 'updated')
  const m = messageRow(db, room.id, line)
  if (m) rooms.messageEvent('room.message', m)
  moves.kick(room.id)
  return { projectId: id }
}
