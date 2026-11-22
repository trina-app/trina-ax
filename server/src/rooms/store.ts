// Team chat rooms: rows and what one person may see of them (docs/DECISIONS.md "대화방 v1"). Every read goes through a
// member row: someone who is not in the room gets nothing, whatever their role (an admin or the owner too).
//
// What a member sees: messages after where they see the room from (seesFrom: a team room's or the everyone room's whole
// history, a group chat or 1:1 from their join on), and of those the ones for the whole room (visibility 'room'; the old
// room AI's unposted 'private' previews are nobody's since its code was removed), but not the old answers hidden from them (room_hidden_answers,
// rooms/history.ts: a later member who could not open what an answer used) nor what is in their threads.
//
// Event lines (room_messages.event, docs/DECISIONS.md "그룹 대화와 방 이름"): a rename, people invited, someone left or
// taken out. They take a seq and are seen like any message, but count nowhere: no badge, never the rooms list's last
// line, no notice; their body is ''.
//
// Threads (docs/DECISIONS.md "스레드와 반응"): a reply (thread_root_id) takes a seq like any message but is not in the
// timeline (TIMELINE_SQL) unless it was sent to the room too (also_in_room). It is seen by whoever sees its root: canSee
// and SEE_SQL go by the root's seq (thread_root_seq), so a later member sees no reply of a root from before they joined.
// Who follows a thread and where they are in it: room_thread_follows. Reactions: room_reactions (any one emoji,
// shared/src/api/rooms.ts RoomReactionEmoji), counted for current members only, never anywhere else.
import type { Database } from 'bun:sqlite'
import { getPreferences, type Preferences } from '../notifications/preferences'
import { loadPrincipal, RuleSet } from '../policy/access'
import { roomNotifyOut } from './alerts'
import { parseStored, unescapeMarkdown } from './apps/card'
import { iconsOf } from './apps/icon'
import { linkPreviewsFor, prepareLinkPreviews, type LinkPrep } from './link-previews'
import { eventProjectsFor, projectForViewer, type EventProjectView } from './project-link'
import { isListedProjectRoom, isProjectRoom, NOT_HELD_SQL } from './project-room'
import { filesMovingIn, hasRoomStoredFiles, roomOnlyAmong } from './team-place'
import { answerFilePaths, RoomEventLine, ROOM_QUOTE_EXCERPT_MAX, ROOM_REACTION_NAMES, type Room, type RoomFile, type RoomKind, type RoomLastMessage, type RoomMember, type RoomMessage, type RoomQuote, type RoomReaction, type RoomThreadSummary, type UserRef, RoomAppKind, RoomAppPreset, type RoomAppRef } from '@mycel/shared/api'

export const MAX_UNREAD = 999
const EXCERPT_QUOTE = ROOM_QUOTE_EXCERPT_MAX
const EXCERPT_LIST = 120

export interface RoomRow { id: string; kind: RoomKind; group_id: string | null; dm_key: string | null; created_by: string | null; created_at: string; last_seq: number; activity_at: string; archived_at: string | null; name: string | null; /** the team category (migration 429); absent from rows made in code or read with named columns */ category_id?: string | null }
/** muted / notify_level: my level for the room (rooms/alerts.ts ownLevel; notify_level is absent from rows made in code).
 * hidden_at: when I hid the room from my own lists (docs/DECISIONS.md "대화 숨기기"); null or absent: shown */
/** visible_from_seq: the room's last seq when they joined (the floor of their read position); history_from_seq: where
 * they see the room from once their hidden old answers are worked out (0 in a team room or the everyone room), null
 * before that and in group chats and 1:1s (they see from visible_from_seq): seesFrom */
export interface MemberRow { room_id: string; user_id: string; joined_at: string; last_read_seq: number; visible_from_seq: number; history_from_seq: number | null; history_recheck?: number; /** 0: none of the room's old answers is hidden from them (read with the row: a check per message is then skipped); absent: not known (checked) */ has_hidden?: number; muted: number; notify_level?: string | null; hidden_at?: string | null }
export interface MessageRow {
  id: string; room_id: string; seq: number; author_kind: 'user' | 'ai'; author_id: string | null; asked_by: string | null
  visibility: 'room' | 'private'; visible_to: string | null; body: string; reply_to_id: string | null; mentions: string
  client_id: string | null; created_at: string; edited_at: string | null; deleted_at: string | null
  /** an event line's JSON (EventData), else null */
  event: string | null
  /** a thread reply: its root, and the root's seq (what decides who sees it) */
  thread_root_id: string | null; thread_root_seq: number | null
  /** a thread reply also sent to the room's timeline */
  also_in_room: number
  /** an answer of the author's own AI chat they sent here ("대화방에 보내기", migration 261): where it starts in body
   * (before it: their note), else null; answer_cut: it was cut to fit */
  answer_at: number | null; answer_cut: number
  /** "@전체": it mentions every member who can see it (never its sender); absent from rows made in code */
  mentions_all?: number
  /** a message an app posted (rooms/apps, migration 299): the app (no foreign key: a removed app's id stays), its card
   * as JSON (with the app's name and kind then), and whether it was posted quiet (no unread, no notice, not the list's
   * line); absent from rows made in code */
  app_id?: string | null; app_card?: string | null; app_quiet?: number
  /** a person's message: the previews its sender removed and the snapshots they chose to show (migration 402,
   * rooms/link-previews.ts); absent from rows made in code */
  link_previews?: string | null
}
/** An event line as stored: user ids, never names (they are read when it is shown). */
export type EventData =
  | { type: 'created'; userIds: string[] }
  | { type: 'renamed'; name: string | null }
  | { type: 'added'; userIds: string[] }
  | { type: 'left' }
  | { type: 'removed'; userId: string }
  | { type: 'joined' }
  /** a private channel linked to a team project, or unlinked (rooms/project-link.ts): the project by id, its name read
   * per viewer when shown (only to someone who can open it) */
  | { type: 'project_linked'; projectId: string }
  | { type: 'project_unlinked'; projectId: string }
  /** a linked channel became the project's chat room at the upgrade (rooms/project-room.ts settleLinked): by the system */
  | { type: 'project_room'; projectId: string }
  /** the author made this conversation the project (POST /api/rooms/:id/make-project, rooms/make-project.ts); `by` the
   * same person, kept in the line itself */
  | { type: 'project_made'; projectId: string; by: string | null }
  /** its files finished moving to the project's Chat attachments (rooms/file-moves.ts): by the system */
  | { type: 'project_files_moved'; projectId: string; moved: number; kept: number }
export interface FileRow { id: string; room_id: string; user_id: string | null; message_id: string | null; name: string; size: number; mime: string; kind: RoomFile['kind']; width: number | null; height: number | null; sha256: string; thumb: number; created_at: string; team_path?: string | null; team_stamp?: string | null }

export const MSG_COLS = 'id, room_id, seq, author_kind, author_id, asked_by, visibility, visible_to, body, reply_to_id, mentions, client_id, created_at, edited_at, deleted_at, event, thread_root_id, thread_root_seq, also_in_room, mentions_all, answer_at, answer_cut, app_id, app_card, app_quiet, link_previews'
/** Does the message on room_messages `m` mention the person `?` (picked by name, or "@전체" by someone else)? */
export const MENTIONS_SQL = '(EXISTS(SELECT 1 FROM json_each(m.mentions) j WHERE j.value = ?) OR (m.mentions_all = 1 AND (m.author_id IS NULL OR m.author_id <> ?)))'

export const roomRow = (db: Database, id: string): RoomRow | null => db.query('SELECT * FROM rooms WHERE id = ?').get(id) as RoomRow | null
/** A member row as read here carries has_hidden (rows only ever become fewer while they are in the room, and are added
 * only in the step that opens their history, so an older copy of a row never skips a check it needs) */
const MEMBER_COLS = 'm.*, EXISTS (SELECT 1 FROM room_hidden_answers h WHERE h.room_id = m.room_id AND h.user_id = m.user_id) has_hidden'
export const memberRow = (db: Database, roomId: string, userId: string): MemberRow | null =>
  db.query(`SELECT ${MEMBER_COLS} FROM room_members m WHERE m.room_id = ? AND m.user_id = ?`).get(roomId, userId) as MemberRow | null
/** Is this person in the room now? (the realtime hub asks before it replays a room event) */
export const isRoomMember = (db: Database, roomId: string, userId: string): boolean =>
  !!db.query(`SELECT 1 FROM room_members m JOIN rooms r ON r.id = m.room_id WHERE m.room_id = ? AND m.user_id = ? AND r.archived_at IS NULL AND ${NOT_HELD_SQL('r')}`).get(roomId, userId)
export const members = (db: Database, roomId: string): MemberRow[] => db.query(`SELECT ${MEMBER_COLS} FROM room_members m WHERE m.room_id = ?`).all(roomId) as MemberRow[]
export const messageRow = (db: Database, roomId: string, id: string): MessageRow | null =>
  db.query(`SELECT ${MSG_COLS} FROM room_messages WHERE id = ? AND room_id = ?`).get(id, roomId) as MessageRow | null

/** Who may open which team file now (rooms/service.ts sets it for the server's database): an AI answer's file links
 * are shown as links only for files the viewer may open. Without one, none are (fails closed). */
const pathChecks = new WeakMap<Database, (userId: string) => (rel: string) => boolean>()
/** `check(userId)` gives one viewer's test for a list of messages (their access loaded once, each path once). */
export function setRoomPathCheck(db: Database, check: (userId: string) => (rel: string) => boolean) { pathChecks.set(db, check) }
/** One viewer's test of the team files they may open (none set: undefined, nothing opens). */
export const pathCheckFor = (db: Database, userId: string): ((rel: string) => boolean) | undefined => pathChecks.get(db)?.(userId)


/** The seq that decides who sees a message: its own, or for a thread reply its root's (a thread follows its root). */
export const seenSeq = (m: Pick<MessageRow, 'seq'> & { thread_root_seq?: number | null }) => m.thread_root_seq ?? m.seq
/** Where a member sees the room from (docs/DECISIONS.md "지난 대화"): a team room's or the everyone room's whole history
 * (history_from_seq 0) once their hidden answers are worked out (rooms/history.ts); else from their join on
 * (visible_from_seq: group chats and 1:1s, and a later member until then). visible_from_seq stays the floor of their
 * read position: nothing from before they joined is unread. */
export const seesFrom = (m: Pick<MemberRow, 'visible_from_seq'> & { history_from_seq?: number | null }): number => m.history_from_seq ?? m.visible_from_seq
/** A message as the visibility rule reads it. */
export type SeeMessage = Pick<MessageRow, 'id' | 'room_id' | 'seq' | 'visibility' | 'visible_to'> & { thread_root_id?: string | null; thread_root_seq?: number | null }
export type SeeMember = Pick<MemberRow, 'user_id' | 'visible_from_seq'> & { history_from_seq?: number | null; has_hidden?: number }
/** Is this message one of the member's hidden old answers, or in the thread of one (room_hidden_answers: a later member
 * of a team room or the everyone room who could not open what the answer used)? */
export function isHiddenFor(db: Database, m: Pick<SeeMessage, 'id' | 'room_id'> & { thread_root_id?: string | null }, userId: string): boolean {
  return !!db.query('SELECT 1 FROM room_hidden_answers WHERE room_id = ? AND user_id = ? AND message_id IN (?, ?) LIMIT 1').get(m.room_id, userId, m.id, m.thread_root_id ?? m.id)
}
/** May this member see this message (from where they see the room, for the whole room or for them, not one of their
 * hidden old answers or in its thread)? */
export function canSee(db: Database, m: SeeMessage, member: SeeMember): boolean {
  if (seenSeq(m) <= seesFrom(member)) return false
  // an unposted private preview of the old room AI is nobody's to see since its code was removed (docs/DECISIONS.md
  // "Room @트리나 code removed"): the row stays, unlisted
  if (m.visibility !== 'room') return false
  return member.has_hidden === 0 || !isHiddenFor(db, m, member.user_id)
}
/** The same as SQL on room_messages `m`; its parameters are seeArgs(member). `m.seq > ?` first: a reply's seq is above
 * its root's, so it adds nothing to the rule and lets the (room_id, seq) index start where the member sees from. The
 * hidden answers: one primary-key probe per row (room_id, user_id, message_id), for the message and for its root,
 * skipped for a member none of whose old answers is hidden (has_hidden 0). */
export const SEE_SQL = "m.seq > ? AND COALESCE(m.thread_root_seq, m.seq) > ? AND m.visibility = 'room' AND (? = 0 OR NOT EXISTS (SELECT 1 FROM room_hidden_answers h WHERE h.room_id = m.room_id AND h.user_id = ? AND h.message_id IN (m.id, m.thread_root_id)))"
/** The timeline's and a thread's listings only (same parameters): a hidden answer itself stays in the list, where
 * messagesOut shows it as one line without its content; what is in its thread does not. */
export const LIST_SQL = "m.seq > ? AND COALESCE(m.thread_root_seq, m.seq) > ? AND m.visibility = 'room' AND (? = 0 OR NOT EXISTS (SELECT 1 FROM room_hidden_answers h WHERE h.room_id = m.room_id AND h.user_id = ? AND h.message_id = m.thread_root_id))"
/** The order of SEE_SQL's (and LIST_SQL's) parameters, once: where they see from, whether to look for hidden answers,
 * the person. seeArgs gives values; SEE_MEMBER_SQL the same as columns. */
const seeParts = <F, U, P>(from: F, user: U, probe: P) => [from, from, probe, user] as const
export const seeArgs = (member: SeeMember) => seeParts(seesFrom(member), member.user_id, member.has_hidden === 0 ? 0 : 1)
/** SEE_SQL for messages of many rooms at once: the member's values read from a joined room_members row `mm` of the
 * message's room (seesFrom as COALESCE; hidden answers always looked for). The same rule, filled from seeParts: a search
 * across rooms (rooms/search.ts) decides in SQL, so what it counts, skips and points a cursor at is only what they see. */
export const SEE_MEMBER_SQL = (() => {
  const cols: readonly string[] = seeParts('COALESCE(mm.history_from_seq, mm.visible_from_seq)', 'mm.user_id', '1')
  let i = 0
  const sql = SEE_SQL.replace(/\?/g, () => cols[i++] ?? '?')
  if (i !== cols.length) throw new Error('SEE_SQL and seeParts are out of step')
  return sql
})()
/** The room's timeline on room_messages `m`: no thread replies but those sent to the room too. */
export const TIMELINE_SQL = '(m.thread_root_id IS NULL OR m.also_in_room = 1)'
/** Can a thread hang under this message (or is one there): a message of the timeline, for the whole room, not an event
 * line. A deleted one keeps the replies it has; new ones need it not deleted (Rooms.send). */
export const threadable = (m: Pick<MessageRow, 'thread_root_id' | 'visibility' | 'event'>) => !m.thread_root_id && m.visibility === 'room' && !m.event

/** People by id as rooms name them (UserRef), the ones still there. */
export function refsOf(db: Database, ids: Iterable<string | null>): Map<string, UserRef> {
  const want = [...new Set([...ids].filter((x): x is string => !!x))]
  const out = new Map<string, UserRef>()
  if (!want.length) return out
  for (const r of db.query(`SELECT id, name FROM users WHERE id IN (${want.map(() => '?').join(',')})`).all(...want) as { id: string; name: string }[]) out.set(r.id, { id: r.id, name: r.name })
  return out
}

/** Of these authors, the ones whose account is turned off or removed (RoomMessage.authorLeft): 'guest' or 'member' */
export function leftOf(db: Database, ids: Iterable<string | null>): Map<string, 'member' | 'guest'> {
  const want = [...new Set([...ids].filter((x): x is string => !!x))]
  const out = new Map<string, 'member' | 'guest'>()
  if (!want.length) return out
  for (const r of db.query(`SELECT id, guest FROM users WHERE id IN (${want.map(() => '?').join(',')}) AND (status <> 'active' OR deleted_at IS NOT NULL)`).all(...want) as { id: string; guest: number }[]) out.set(r.id, r.guest ? 'guest' : 'member')
  return out
}
const leftField = (left: Map<string, 'member' | 'guest'>, authorId: string | null) => { const l = authorId ? left.get(authorId) : undefined; return l ? { authorLeft: l } : {} }

const excerpt = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + '…' : s)
/** A long message for the AI: its start and its end, the middle said to be left out (a request at the end of a long
 * paste, "…위 내용으로 견적서 만들어줘", stays in). `head`: the start's share of `max`. */
export function clipMiddle(s: string, max: number, head = 0.7): string {
  if (s.length <= max) return s
  const a = Math.round(max * head), b = max - a
  return `${s.slice(0, a)}\n… [${s.length - max} of ${s.length} characters left out here] …\n${s.slice(s.length - b)}`
}
/** The people a stored message mentions (room_messages.mentions JSON). */
export const parseMentions = (s: string): string[] => { try { const v = JSON.parse(s); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [] } catch { return [] } }

/** An event line's stored JSON, or null when it is none (or not one this build knows). */
export function parseEvent(s: string | null): EventData | null {
  if (!s) return null
  try {
    const v = JSON.parse(s) as Record<string, unknown>
    const ids = (x: unknown) => (Array.isArray(x) ? x.filter((y): y is string => typeof y === 'string') : [])
    switch (v?.type) {
      case 'created': case 'added': return { type: v.type, userIds: ids(v.userIds) }
      case 'renamed': return { type: 'renamed', name: typeof v.name === 'string' ? v.name : null }
      case 'left': return { type: 'left' }
      case 'joined': return { type: 'joined' }
      case 'removed': return typeof v.userId === 'string' ? { type: 'removed', userId: v.userId } : null
      case 'project_linked': case 'project_unlinked': case 'project_room': return typeof v.projectId === 'string' ? { type: v.type, projectId: v.projectId } : null
      case 'project_made': return typeof v.projectId === 'string' ? { type: 'project_made', projectId: v.projectId, by: typeof v.by === 'string' ? v.by : null } : null
      case 'project_files_moved': {
        const n = (x: unknown) => (typeof x === 'number' && Number.isInteger(x) && x >= 0 ? x : null)
        const moved = n(v.moved), kept = n(v.kept)
        return typeof v.projectId === 'string' && moved !== null && kept !== null ? { type: 'project_files_moved', projectId: v.projectId, moved, kept } : null
      }
    }
  } catch { /* not an event this build reads */ }
  return null
}
const eventUserIds = (e: EventData | null): string[] => (!e ? [] : e.type === 'created' || e.type === 'added' ? e.userIds : e.type === 'removed' ? [e.userId] : [])
/** A project line's project for one viewer, from the one resolver (rooms/project-link.ts eventProjectsFor): named and
 * linked only while they can open it; in the trash or deleted said so (RoomEventLine's EventProject). */
function projectOut(v: EventProjectView | undefined): Pick<Extract<RoomEventLine, { type: 'project_linked' }>, 'project' | 'projectGone'> {
  if (v?.state === 'open') return { project: { id: v.id, name: v.name, ...(v.folder ? { folder: v.folder } : {}) } }
  if (v?.state === 'trash') return { project: null, projectGone: { state: 'trash', name: v.name } }
  if (v?.state === 'deleted') return { project: null, projectGone: { state: 'deleted' } }
  return { project: null }
}

/** The event line as the app gets it: the people by name as they are now (an account that is gone is left out); a
 * project as it is now for this viewer (`projects`, rooms/project-link.ts eventProjectsFor). */
function eventOut(e: EventData, people: Map<string, UserRef>, projects: Map<string, EventProjectView> = new Map()): RoomEventLine {
  const refs = (ids: string[]) => ids.map((id) => people.get(id)).filter((x): x is UserRef => !!x)
  switch (e.type) {
    case 'created': return { type: 'created', users: refs(e.userIds) }
    case 'added': return { type: 'added', users: refs(e.userIds) }
    case 'renamed': return { type: 'renamed', name: e.name }
    case 'left': return { type: 'left' }
    case 'joined': return { type: 'joined' }
    case 'removed': return { type: 'removed', user: people.get(e.userId) ?? null }
    case 'project_linked': case 'project_unlinked': case 'project_room': case 'project_made': return { type: e.type, ...projectOut(projects.get(e.projectId)) }
    case 'project_files_moved': return { type: 'project_files_moved', ...projectOut(projects.get(e.projectId)), moved: e.moved, kept: e.kept }
  }
}

export const fileOut = (f: FileRow): RoomFile => ({
  id: f.id, name: f.name, size: f.size, mime: f.mime, kind: f.kind,
  ...(f.width ? { width: f.width } : {}), ...(f.height ? { height: f.height } : {}), thumb: !!f.thumb,
})

/** How a room file kept in the team folder (room_file_refs: a project room's file) is shown to one viewer (rooms/
 * file-refs.ts RoomFileRefs.view: checked now, as a member who reads its path; rooms/service.ts sets it for the server's
 * database). Without one, such a file is "unavailable" to everyone (fails closed). */
const refViews = new WeakMap<Database, (viewerId: string) => (f: FileRow) => RoomFile>()
export function setRoomRefView(db: Database, view: (viewerId: string) => (f: FileRow) => RoomFile) { refViews.set(db, view) }
/** The room files as `viewerId` sees them, in order: a room-stored file as it was sent (fileOut; "Only in this
 * conversation", roomOnly, in a room whose files otherwise go to a team folder: rooms/team-place.ts roomHasTeamPlace),
 * one kept in the team folder as it is now for them (a member of its room the caller checked). */
export function filesOutFor(db: Database, rows: readonly FileRow[], viewerId: string): RoomFile[] {
  if (!rows.length) return []
  const refs = new Set<string>()
  for (let i = 0; i < rows.length; i += 500) {
    const part = rows.slice(i, i + 500)
    for (const r of db.query(`SELECT room_file_id FROM room_file_refs WHERE room_file_id IN (${part.map(() => '?').join(',')})`).all(...part.map((f) => f.id)) as { room_file_id: string }[]) refs.add(r.room_file_id)
  }
  // a room-stored file of a room whose files otherwise go to a team folder (rooms/team-place.ts): "Only in this
  // conversation", unless it is on its way there
  const kinds = new Map<string, RoomRow['kind'] | null>()
  const kindOf = (id: string) => { if (!kinds.has(id)) kinds.set(id, (db.query('SELECT kind FROM rooms WHERE id = ?').get(id) as { kind: RoomRow['kind'] } | null)?.kind ?? null); return kinds.get(id)! }
  const only = roomOnlyAmong(db, rows.filter((f) => !refs.has(f.id) && !!f.message_id), kindOf)
  const stored = (f: FileRow): RoomFile => (only.has(f.id) ? { ...fileOut(f), roomOnly: true } : fileOut(f))
  if (!refs.size) return rows.map(stored)
  const view = refViews.get(db)?.(viewerId)
  return rows.map((f) => (!refs.has(f.id) ? stored(f) : view ? view(f) : { id: f.id, name: '', size: 0, mime: 'application/octet-stream', kind: 'other', thumb: false, teamFile: true, state: 'unavailable' }))
}

/** The rows of a list that are hidden from `viewer` (one of their hidden old answers, or in its thread). */
export function hiddenAmong(db: Database, rows: readonly MessageRow[], viewer: Pick<MemberRow, 'user_id'>): Set<string> {
  const keys = [...new Set(rows.flatMap((r) => (r.thread_root_id ? [r.id, r.thread_root_id] : [r.id])))]
  if (!viewer.user_id || !keys.length) return new Set()
  const out = new Set<string>()
  for (let i = 0; i < keys.length; i += 500) {
    const part = keys.slice(i, i + 500)
    for (const h of db.query(`SELECT message_id FROM room_hidden_answers WHERE room_id = ? AND user_id = ? AND message_id IN (${part.map(() => '?').join(',')})`).all(rows[0]!.room_id, viewer.user_id, ...part) as { message_id: string }[]) out.add(h.message_id)
  }
  return new Set(rows.filter((r) => out.has(r.id) || (!!r.thread_root_id && out.has(r.thread_root_id))).map((r) => r.id))
}

/** Messages as `viewer` sees them (all rows must be visible to them already, or listed by LIST_SQL). An old answer hidden
 * from them (rooms/history.ts), or anything in its thread, goes as one line: who and when, never its text, files,
 * sources, links, reactions or thread (RoomMessage.withheld). */
/** `links`: the message links' previews (rooms/link-previews.ts): read here (default), shared by the caller (one live
 * event to every member: prepareLinkPreviews once), or false for a reader that never shows them (search, the AI). */
export function messagesOut(db: Database, all: readonly MessageRow[], viewer: MemberRow, links?: LinkPrep | null | false): RoomMessage[] {
  if (!all.length) return []
  const withheld = hiddenAmong(db, all, viewer)
  const rows = withheld.size ? all.filter((r) => !withheld.has(r.id)) : all
  const out = rows.length ? shownOut(db, rows, viewer, links === false ? null : links === undefined ? prepareLinkPreviews(db, rows) : links) : []
  if (!withheld.size) return out
  const shown = new Map(out.map((m) => [m.id, m]))
  const people = refsOf(db, all.filter((r) => withheld.has(r.id)).flatMap((r) => [r.author_kind === 'ai' ? null : r.author_id, r.asked_by]))
  const left = leftOf(db, all.filter((r) => withheld.has(r.id) && r.author_kind !== 'ai').map((r) => r.author_id))
  return all.map((r) => shown.get(r.id) ?? { ...withheldOut(db, r, viewer, people), ...(r.author_kind === 'ai' ? {} : leftField(left, r.author_id)) })
}

/** One hidden answer as the viewer gets it: who wrote or asked it and when; an AI answer keeps the question it answers
 * (a person's words they see). Nothing else. */
function withheldOut(db: Database, r: MessageRow, viewer: MemberRow, people: Map<string, UserRef>): RoomMessage {
  const q = r.author_kind === 'ai' && r.reply_to_id ? messageRow(db, r.room_id, r.reply_to_id) : null
  const quoted = q && canSee(db, q, viewer) && !q.deleted_at && !q.event ? q : null
  return {
    id: r.id, roomId: r.room_id, seq: r.seq, authorKind: r.author_kind,
    author: r.author_kind === 'ai' || !r.author_id ? null : people.get(r.author_id) ?? null,
    askedBy: r.asked_by ? people.get(r.asked_by) ?? null : null,
    visibility: 'room', body: '',
    replyTo: quoted ? { id: quoted.id, author: quoted.author_id ? refsOf(db, [quoted.author_id]).get(quoted.author_id) ?? null : null, excerpt: excerpt(quoted.body, EXCERPT_QUOTE), fileCount: 0, deleted: false } : null,
    mentions: [], files: [], createdAt: r.created_at, editedAt: null, deletedAt: r.deleted_at,
    ...(r.thread_root_id ? { threadRootId: r.thread_root_id } : {}),
    withheld: true,
  }
}

/** Messages as `viewer` sees them, none hidden from them. */
function shownOut(db: Database, rows: readonly MessageRow[], viewer: MemberRow, links: LinkPrep | null): RoomMessage[] {
  const ids = rows.map((r) => r.id)
  const files = new Map<string, RoomFile[]>()
  const fileRows = db.query(`SELECT * FROM room_files WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at, id`).all(...ids) as FileRow[]
  // a project room's file (kept in the team folder) as this viewer may see it now
  const shown = filesOutFor(db, fileRows, viewer.user_id)
  fileRows.forEach((f, i) => {
    const l = files.get(f.message_id!) ?? []
    l.push(shown[i]!)
    files.set(f.message_id!, l)
  })
  const replyIds = [...new Set(rows.map((r) => r.reply_to_id).filter((x): x is string => !!x))]
  const quotes = new Map<string, MessageRow>()
  if (replyIds.length) for (const q of db.query(`SELECT ${MSG_COLS} FROM room_messages WHERE room_id = ? AND id IN (${replyIds.map(() => '?').join(',')})`).all(rows[0]!.room_id, ...replyIds) as MessageRow[]) quotes.set(q.id, q)
  const quoteFiles = new Map<string, number>()
  if (quotes.size) for (const r of db.query(`SELECT message_id, COUNT(*) n FROM room_files WHERE message_id IN (${[...quotes.keys()].map(() => '?').join(',')}) GROUP BY message_id`).all(...quotes.keys()) as { message_id: string; n: number }[]) quoteFiles.set(r.message_id, r.n)
  const events = new Map<string, EventData>()
  for (const r of rows) { const e = parseEvent(r.event); if (e) events.set(r.id, e) }
  // threads under the roots on this page, and the reactions on its messages, as this viewer sees them
  const threads = threadSummaries(db, rows[0]!.room_id, rows.filter((r) => threadable(r)).map((r) => r.id), viewer)
  const reactions = reactionsOf(db, rows.filter((r) => !r.event && !r.deleted_at).map((r) => r.id), viewer)
  // the threads of the replies on this page that the viewer follows
  const replyRoots = [...new Set(rows.map((r) => r.thread_root_id).filter((x): x is string => !!x))]
  const followed = new Set(replyRoots.length ? (db.query(`SELECT root_id FROM room_thread_follows WHERE user_id = ? AND root_id IN (${replyRoots.map(() => '?').join(',')})`).all(viewer.user_id, ...replyRoots) as { root_id: string }[]).map((r) => r.root_id) : [])
  const people = refsOf(db, [...rows.flatMap((r) => [r.author_id, r.asked_by]), ...[...quotes.values()].map((q) => q.author_id), ...[...events.values()].flatMap(eventUserIds)])
  // (S-110: a removed guest's old messages read "정하늘 · 게스트 · 나감", not a plain name)
  const left = leftOf(db, rows.filter((r) => !r.event).map((r) => r.author_id))
  // the projects the page's project lines name, as they are now for this viewer (one resolver: eventProjectsFor)
  const linkIds = [...events.values()].flatMap((e) => ('projectId' in e ? [e.projectId] : []))
  const projects = linkIds.length ? eventProjectsFor(db, linkIds, viewer.user_id) : undefined
  // answers people sent from their own AI chat with files attached: which of the answer's links each copy stands for
  const attached = attachedLinksOn(db, rows.filter((r) => sharedAnswerOf(r) && files.has(r.id)), files)
  // the room AI's earlier answers (author_kind 'ai'), and answers people sent from their own AI chat (sharedAnswerOf):
  // the file links of each, for the files this viewer may open
  const ai = rows.some((r) => r.author_kind === 'ai')
  const opens = ai || rows.some((r) => sharedAnswerOf(r)) ? pathChecks.get(db)?.(viewer.user_id) : undefined
  // messages apps posted (rooms/apps): the app as it is now (or as it was, once removed) and its card
  const apps = appRefsOf(db, rows)
  // the messages they link to, as this viewer may see them (rooms/link-previews.ts)
  const previews = linkPreviewsFor(db, links, rows, viewer)
  return rows.map((r): RoomMessage => {
    const ev = events.get(r.id)
    if (r.event) {
      // an event line: who did it and what, nothing else. One this build cannot read (a newer build's, a damaged row)
      // is a neutral line by nobody: never a message, and never words put in its author's mouth
      return {
        id: r.id, roomId: r.room_id, seq: r.seq, authorKind: 'user', author: ev && r.author_id ? people.get(r.author_id) ?? null : null, askedBy: null,
        visibility: 'room', body: '', replyTo: null, mentions: [], files: [], createdAt: r.created_at, editedAt: null, deletedAt: null,
        event: ev ? eventOut(ev, people, projects) : { type: 'unknown' },
      }
    }
    let replyTo: RoomQuote | null = null
    if (r.reply_to_id) {
      const q = quotes.get(r.reply_to_id)
      // a quote the viewer may not see (sent before they joined, private to someone else, an old answer hidden from
      // them) shows no content; a hidden answer says so (withheld)
      const shown = q && canSee(db, q, viewer) && !q.deleted_at && !q.event
      const hidden = !shown && !!q && !q.deleted_at && !q.event && isHiddenFor(db, q, viewer.user_id)
      // a quoted app message (rooms/apps): its plain text (the body escapes Markdown marks and addresses) and the app
      const qApp = shown && q.app_card ? appRefsOf(db, [q]).get(q.id) : undefined
      replyTo = { id: r.reply_to_id, author: shown && q.author_id ? people.get(q.author_id) ?? null : null, excerpt: shown ? excerpt(qApp ? unescapeMarkdown(q.body).replace(/<(https:\/\/[^>\s]+)>/g, '$1').replace(/\s+/g, ' ').trim() : q.body, EXCERPT_QUOTE) : '', fileCount: shown ? quoteFiles.get(q.id) ?? 0 : 0, deleted: !shown, ...(hidden ? { withheld: true as const } : {}), ...(qApp ? { app: qApp } : {}) }
    }
    const thread = threads.get(r.id)
    const reacted = reactions.get(r.id)
    const shared = sharedAnswerOf(r)
    return {
      id: r.id, roomId: r.room_id, seq: r.seq, authorKind: r.author_kind,
      author: r.author_id ? people.get(r.author_id) ?? null : null,
      ...(r.author_id && people.has(r.author_id) ? leftField(left, r.author_id) : {}),
      askedBy: r.asked_by ? people.get(r.asked_by) ?? null : null,
      visibility: r.visibility,
      body: r.deleted_at ? '' : r.body,
      replyTo,
      mentions: r.deleted_at ? [] : parseMentions(r.mentions),
      ...(r.mentions_all && !r.deleted_at ? { mentionsAll: true } : {}),
      files: r.deleted_at ? [] : files.get(r.id) ?? [],
      createdAt: r.created_at, editedAt: r.edited_at, deletedAt: r.deleted_at,
      ...(r.author_kind === 'ai' && !r.deleted_at ? { openable: openableFor(opens, r.body) } : {}),
      // an answer of the author's own AI chat: the links of its answer part, for the files this viewer may open
      ...(shared ? { sharedAnswer: shared, openable: openableFor(opens, r.body.slice(shared.at)), ...(attached.get(r.id)?.length ? { attachedLinks: attached.get(r.id)! } : {}) } : {}),
      ...(r.thread_root_id ? { threadRootId: r.thread_root_id, ...(r.also_in_room ? { alsoInRoom: true as const } : {}), ...(followed.has(r.thread_root_id) ? { following: true as const } : {}) } : {}),
      ...(thread ? { thread } : {}),
      ...(reacted?.length ? { reactions: reacted } : {}),
      // the id the author's app sent it with, to the author only: a send whose answer was lost is matched to it
      ...(r.author_kind === 'user' && r.client_id && r.author_id === viewer.user_id ? { clientMessageId: r.client_id } : {}),
      ...appOut(apps, r),
      ...(previews.get(r.id) ? { linkPreviews: previews.get(r.id)! } : {}),
    }
  })
}

/** The threads under these roots as `viewer` sees them: only roots with replies they can see (not deleted) get one.
 * Bounded by the page: one grouped count, the repliers per root, and the viewer's follow rows. */
export function threadSummaries(db: Database, roomId: string, rootIds: readonly string[], viewer: MemberRow): Map<string, RoomThreadSummary> {
  const out = new Map<string, RoomThreadSummary>()
  if (!rootIds.length) return out
  const marks = rootIds.map(() => '?').join(',')
  const see = "m.deleted_at IS NULL AND m.event IS NULL AND m.visibility = 'room'"
  const counts = db.query(`SELECT m.thread_root_id root, COUNT(*) n, MAX(m.created_at) last FROM room_messages m WHERE m.room_id = ? AND m.thread_root_id IN (${marks}) AND ${see} GROUP BY m.thread_root_id`)
    .all(roomId, ...rootIds) as { root: string; n: number; last: string }[]
  if (!counts.length) return out
  const roots = counts.map((c) => c.root)
  const rm = roots.map(() => '?').join(',')
  // the people who replied, the latest first (the AI has no author: it is not one of them)
  const by = db.query(`SELECT m.thread_root_id root, m.author_id uid, MAX(m.seq) s FROM room_messages m WHERE m.room_id = ? AND m.thread_root_id IN (${rm}) AND ${see}
    AND m.author_kind = 'user' AND m.author_id IS NOT NULL GROUP BY m.thread_root_id, m.author_id`).all(roomId, ...roots) as { root: string; uid: string; s: number }[]
  const repliers = new Map<string, { uid: string; s: number }[]>()
  for (const b of by) (repliers.get(b.root) ?? repliers.set(b.root, []).get(b.root)!).push(b)
  const top = new Map([...repliers].map(([root, l]) => [root, l.sort((a, b) => b.s - a.s).slice(0, 3).map((x) => x.uid)]))
  const people = refsOf(db, [...top.values()].flat())
  // (a reply sent to the room too is new in the timeline, not here: threadsUnread)
  const fresh = new Set((db.query(`SELECT f.root_id FROM room_thread_follows f WHERE f.user_id = ? AND f.root_id IN (${rm}) AND EXISTS (SELECT 1 FROM room_messages m
    WHERE m.thread_root_id = f.root_id AND m.seq > f.last_read_seq AND m.also_in_room = 0 AND ${see} AND (m.author_id IS NULL OR m.author_id <> ?))`).all(viewer.user_id, ...roots, viewer.user_id) as { root_id: string }[]).map((r) => r.root_id))
  for (const c of counts) {
    out.set(c.root, { replyCount: c.n, lastReplyAt: c.last, repliers: (top.get(c.root) ?? []).map((id) => people.get(id)).filter((x): x is UserRef => !!x), newReplies: fresh.has(c.root) })
  }
  return out
}

/** One thread's summary for `viewer`, or null when they see no reply in it. */
export const threadSummary = (db: Database, roomId: string, rootId: string, viewer: MemberRow): RoomThreadSummary | null => threadSummaries(db, roomId, [rootId], viewer).get(rootId) ?? null

/** The reactions on these messages as `viewer` sees them: per emoji (in the order it was first used) how many people
 * in the room now put it there, whether the viewer did, and the first ROOM_REACTION_NAMES of them. */
export function reactionsOf(db: Database, messageIds: readonly string[], viewer: Pick<MemberRow, 'user_id'>): Map<string, RoomReaction[]> {
  const out = new Map<string, RoomReaction[]>()
  if (!messageIds.length) return out
  const marks = messageIds.map(() => '?').join(',')
  const now = 'room_reactions r JOIN room_members rm ON rm.room_id = r.room_id AND rm.user_id = r.user_id'
  const groups = db.query(`SELECT r.message_id mid, r.emoji, COUNT(*) n, MAX(r.user_id = ?) mine, MIN(r.created_at) first FROM ${now} WHERE r.message_id IN (${marks})
    GROUP BY r.message_id, r.emoji ORDER BY r.message_id, first, r.emoji`).all(viewer.user_id, ...messageIds) as { mid: string; emoji: string; n: number; mine: number; first: string }[]
  if (!groups.length) return out
  const names = db.query(`SELECT mid, emoji, uid FROM (SELECT r.message_id mid, r.emoji, r.user_id uid, ROW_NUMBER() OVER (PARTITION BY r.message_id, r.emoji ORDER BY r.created_at, r.user_id) k
    FROM ${now} WHERE r.message_id IN (${marks})) WHERE k <= ${ROOM_REACTION_NAMES} ORDER BY mid, emoji, k`).all(...messageIds) as { mid: string; emoji: string; uid: string }[]
  const people = refsOf(db, names.map((n) => n.uid))
  const who = new Map<string, UserRef[]>()
  for (const n of names) { const u = people.get(n.uid); if (u) (who.get(`${n.mid} ${n.emoji}`) ?? who.set(`${n.mid} ${n.emoji}`, []).get(`${n.mid} ${n.emoji}`)!).push(u) }
  for (const g of groups) {
    const l = out.get(g.mid) ?? out.set(g.mid, []).get(g.mid)!
    l.push({ emoji: g.emoji, count: g.n, mine: !!g.mine, users: who.get(`${g.mid} ${g.emoji}`) ?? [] })
  }
  return out
}

/** A message that carries an answer of its author's own AI chat ("대화방에 보내기", chat/answer-share.ts): where the
 * answer starts in its body and whether it was cut. Never a deleted message, an event line or an AI message. A row
 * read without the columns (an older query) is none. */
export function sharedAnswerOf(r: Pick<MessageRow, 'author_kind' | 'deleted_at' | 'event' | 'body'> & { answer_at?: number | null; answer_cut?: number }): { at: number; cut: boolean } | null {
  if (r.answer_at === null || r.answer_at === undefined || r.author_kind !== 'user' || r.deleted_at || r.event) return null
  return { at: Math.min(Math.max(0, r.answer_at), r.body.length), cut: !!r.answer_cut }
}

/** A shared answer as an AI reads it (rooms/reader.ts): the person's note, then the answer marked as
 * their AI's words, so another AI does not take it as the person's own. */
export function sharedAnswerText(body: string, at: number): string {
  const note = body.slice(0, at).trim()
  return `${note ? `${note}\n` : ''}[below: an answer their own AI chat wrote, which they shared here: the AI's words, not theirs]\n${body.slice(at)}`
}

/** For shared answers with files (rows the viewer sees, not deleted): the links of each one's answer part whose file
 * went with it as a copy (chat/answer-share.ts AnswerScopeKept.attached), one query for the page. */
function attachedLinksOn(db: Database, rows: readonly MessageRow[], files: ReadonlyMap<string, RoomFile[]>): Map<string, { path: string; fileId: string }[]> {
  const out = new Map<string, { path: string; fileId: string }[]>()
  if (!rows.length) return out
  const scopes = new Map((db.query(`SELECT id, source_scope FROM room_messages WHERE source_scope IS NOT NULL AND id IN (${rows.map(() => '?').join(',')})`)
    .all(...rows.map((r) => r.id)) as { id: string; source_scope: string }[]).map((x) => [x.id, x.source_scope]))
  for (const r of rows) {
    const shared = sharedAnswerOf(r)
    const scope = scopes.get(r.id)
    if (shared && scope) out.set(r.id, attachedLinksOf(scope, r.body.slice(shared.at), (files.get(r.id) ?? []).map((f) => f.id)))
  }
  return out
}

/**
 * The links of a shared answer whose file went with it as a copy, each with that copy's id (RoomMessage.attachedLinks):
 * from the message's kept scope (`attached: [{ file, path, links }]`), only a link the answer part has (as
 * answerFilePaths names it: text the viewer already gets) and only a file of this message now (`fileIds`). The team path
 * the copy was made from is never in it. An older message (no `attached`), a scope that does not read: none.
 */
export function attachedLinksOf(scope: string | null, answerPart: string, fileIds: readonly string[]): { path: string; fileId: string }[] {
  if (!scope || !fileIds.length) return []
  let copies: unknown
  try { copies = (JSON.parse(scope) as { attached?: unknown } | null)?.attached } catch { return [] }
  if (!Array.isArray(copies)) return []
  const inText = new Set(answerFilePaths(answerPart))
  const mine = new Set(fileIds)
  const out = new Map<string, string>()
  for (const c of copies as { file?: unknown; links?: unknown }[]) {
    if (!c || typeof c.file !== 'string' || !mine.has(c.file) || !Array.isArray(c.links)) continue
    for (const link of c.links) if (typeof link === 'string' && inText.has(link) && !out.has(link)) out.set(link, c.file)
  }
  return [...out].map(([path, fileId]) => ({ path, fileId }))
}

/** The team files an AI answer names that this viewer may open now. */
export function openableFor(check: ((rel: string) => boolean) | undefined, body: string): string[] {
  if (!check) return []
  return answerFilePaths(body).filter((p) => { try { return check(p) } catch { return false } })
}

/** The rooms list line: the newest message of the timeline `viewer` can see. */
function lastMessage(db: Database, roomId: string, viewer: MemberRow): RoomLastMessage | null {
  // event lines are not what the room's list line shows, nor replies that stay in their thread
  // nor an app's quiet lines (rooms/apps: Quiet, the paused line)
  const m = db.query(`SELECT ${MSG_COLS} FROM room_messages m WHERE m.room_id = ? AND ${SEE_SQL} AND ${TIMELINE_SQL} AND m.event IS NULL AND m.app_quiet = 0 ORDER BY m.seq DESC LIMIT 1`).get(roomId, ...seeArgs(viewer)) as MessageRow | null
  if (!m) return null
  const author = m.author_id ? refsOf(db, [m.author_id]).get(m.author_id) ?? null : null
  const files = m.deleted_at ? 0 : (db.query('SELECT COUNT(*) n FROM room_files WHERE message_id = ?').get(m.id) as { n: number }).n
  const app = m.app_card ? appRefsOf(db, [m]).get(m.id) : undefined
  // an app's message: its plain text (the body escapes Markdown marks: rooms/apps/card.ts)
  const text = app ? unescapeMarkdown(m.body) : m.body
  return { id: m.id, seq: m.seq, author, excerpt: m.deleted_at ? '' : excerpt(text.replace(/\s+/g, ' ').trim(), EXCERPT_LIST), fileCount: files, deleted: !!m.deleted_at, createdAt: m.created_at, ...(app ? { app } : {}) }
}

/** unreadCount reads at most this many messages for its number (one more than it can answer). */
const UNREAD_COUNTED = MAX_UNREAD + 1
/** Unread messages of the timeline on room_messages `m` (parameters: room, read position, seeArgs, the person): after
 * their read position, theirs to see, not their own, not deleted, no event line, no reply that stays in its thread. */
const UNREAD_SQL = `m.room_id = ? AND m.seq > ? AND ${SEE_SQL} AND ${TIMELINE_SQL} AND m.deleted_at IS NULL AND m.event IS NULL AND m.app_quiet = 0 AND (m.author_id IS NULL OR m.author_id <> ?)`
/** Is one of them a mention of the person? Read from where they are mentioned, never the room's messages (reading every
 * unread message for it took 120-170 ms at 300k, TC-4796): the messages that pick them (room_message_mentions, kept by
 * triggers from room_messages.mentions: migration 416), then the ones that mention everyone (the partial index
 * room_messages_mention_all). Each candidate is checked by the whole rule (UNREAD_SQL and MENTIONS_SQL). Parameters:
 * room, person, read position, then UNREAD_SQL's, then the person twice (UNREAD_MENTION_PICKED_SQL); UNREAD_SQL's, then
 * the person twice (UNREAD_MENTION_ALL_SQL). Exported for their query plan guards. */
export const UNREAD_MENTION_PICKED_SQL = `SELECT 1 FROM room_message_mentions x CROSS JOIN room_messages m ON m.room_id = x.room_id AND m.seq = x.seq
  WHERE x.room_id = ? AND x.user_id = ? AND x.seq > ? AND ${UNREAD_SQL} AND ${MENTIONS_SQL} LIMIT 1`
export const UNREAD_MENTION_ALL_SQL = `SELECT 1 FROM room_messages m WHERE ${UNREAD_SQL} AND m.mentions_all = 1 AND ${MENTIONS_SQL} LIMIT 1`
/** Unread messages of the timeline for `viewer` (UNREAD_SQL), counted up to MAX_UNREAD, and whether one mentions them. */
export function unreadCount(db: Database, roomId: string, viewer: MemberRow): { n: number; mentioned: boolean } {
  const from = Math.max(viewer.last_read_seq, viewer.visible_from_seq)
  const args = [roomId, from, ...seeArgs(viewer), viewer.user_id]
  // counted up to UNREAD_COUNTED only: the answer stops at MAX_UNREAD, and a person far behind in a big room made every
  // read count the whole rest of it (TC-4772)
  const r = db.query(`SELECT COUNT(*) n, MAX(men) men FROM (SELECT ${MENTIONS_SQL} men FROM room_messages m WHERE ${UNREAD_SQL} LIMIT ${UNREAD_COUNTED})`)
    .get(viewer.user_id, viewer.user_id, ...args) as { n: number; men: number | null }
  // a mention past those rows still counts: looked for in the rest only when they had none
  const mentioned = !!r.men || (r.n >= UNREAD_COUNTED && (
    !!db.query(UNREAD_MENTION_PICKED_SQL).get(roomId, viewer.user_id, from, ...args, viewer.user_id, viewer.user_id)
    || !!db.query(UNREAD_MENTION_ALL_SQL).get(...args, viewer.user_id, viewer.user_id)))
  return { n: Math.min(MAX_UNREAD, r.n), mentioned }
}

/** The newest position of the timeline `viewer` can see (an event line's too), 0 for none: the room's own counter would
 * count replies in threads they cannot see and other people's private previews. */
export function lastSeqFor(db: Database, roomId: string, viewer: MemberRow): number {
  // (a hidden old answer's line is in the timeline they get: LIST_SQL)
  return (db.query(`SELECT m.seq FROM room_messages m WHERE m.room_id = ? AND ${LIST_SQL} AND ${TIMELINE_SQL} ORDER BY m.seq DESC LIMIT 1`).get(roomId, ...seeArgs(viewer)) as { seq: number } | null)?.seq ?? 0
}

/** At most this many followed threads are looked at for a room's badge (the newest first). */
const THREADS_LOOKED_AT = 1000
/** The threads `viewer` follows in this room with replies after their position there that they can see and did not
 * write (counted up to MAX_UNREAD), the one with the newest such reply, and whether one of those replies mentions them.
 * A reply sent to the room too counts in the timeline (unreadCount), not here as well. CROSS JOIN keeps SQLite on the
 * follow rows first (room_thread_follows_user, then room_messages_thread), never a walk of the room's messages. */
export function threadsUnread(db: Database, roomId: string, viewer: MemberRow): { n: number; next: string | null; mentioned: boolean } {
  const rows = db.query(`SELECT f.root_id, MAX(m.seq) newest, MAX(${MENTIONS_SQL}) men
    FROM room_thread_follows f CROSS JOIN room_messages root ON root.id = f.root_id CROSS JOIN room_messages m ON m.thread_root_id = f.root_id AND m.seq > f.last_read_seq
    WHERE f.user_id = ? AND f.room_id = ? AND root.room_id = ? AND root.seq > ? AND m.room_id = ? AND m.also_in_room = 0
      AND m.deleted_at IS NULL AND m.event IS NULL AND m.app_quiet = 0 AND m.visibility = 'room' AND (m.author_id IS NULL OR m.author_id <> ?)
      AND NOT EXISTS (SELECT 1 FROM room_hidden_answers h WHERE h.room_id = root.room_id AND h.user_id = f.user_id AND h.message_id IN (root.id, m.id))
    GROUP BY f.root_id ORDER BY newest DESC LIMIT ${THREADS_LOOKED_AT}`)
    .all(viewer.user_id, viewer.user_id, viewer.user_id, roomId, roomId, seesFrom(viewer), roomId, viewer.user_id) as { root_id: string; newest: number; men: number | null }[]
  return { n: Math.min(MAX_UNREAD, rows.length), next: rows[0]?.root_id ?? null, mentioned: rows.some((r) => !!r.men) }
}

/** How an audit row names a room: a team room or the everyone room by id; a DM or a group chat by its kind only (admins
 * read the audit log and must not learn who talks to whom, which the same room id on two people's rows would tell). */
export const roomAuditRef = (room: Pick<RoomRow, 'id' | 'kind'>): { roomId: string } | { kind: 'dm' | 'group' } =>
  room.kind === 'dm' || room.kind === 'group' ? { kind: room.kind } : { roomId: room.id }

/** The group's name of a team room (null for the other kinds, or when the group is gone). */
export const groupName = (db: Database, room: Pick<RoomRow, 'kind' | 'group_id'>): string | null =>
  room.kind === 'team' && room.group_id ? (db.query('SELECT name FROM groups WHERE id = ?').get(room.group_id) as { name: string } | null)?.name ?? null : null

/** May this person rename the room: a group chat's members; a team room's and the everyone room's members who are owner
 * or admin; nobody in a DM (its name is the other person). Membership is checked by the caller. */
export function mayRename(db: Database, room: Pick<RoomRow, 'kind'>, userId: string): boolean {
  // a guest never renames their one place (Room.canRename false, so the room info shows no pencil: guest walkthrough M2)
  if (room.kind === 'group') return !db.query('SELECT 1 FROM users WHERE id = ? AND guest = 1').get(userId)
  if (room.kind === 'dm') return false
  return isOwnerOrAdmin(db, userId)
}
/** An owner or an admin (an account that is active). */
export const isOwnerOrAdmin = (db: Database, userId: string): boolean =>
  !!db.query("SELECT 1 FROM users WHERE id = ? AND role IN ('owner', 'admin') AND status = 'active' AND deleted_at IS NULL").get(userId)

/** May this person manage the apps of a room they are in (rooms/apps, docs/DECISIONS.md "Apps posting in rooms"): in a
 * team room and the everyone room its owners and admins; in a 1:1 or a group chat any of its members (no admins
 * there) but a guest (QA TC-1922: a guest reaches no apps route, so they neither delete an app's message nor are told
 * about its pauses or leavers). Membership is checked by the caller. */
export function mayManageApps(db: Database, room: Pick<RoomRow, 'kind'>, userId: string): boolean {
  if (room.kind === 'dm' || room.kind === 'group') return !db.query('SELECT 1 FROM users WHERE id = ? AND guest = 1').get(userId)
  return isOwnerOrAdmin(db, userId)
}

/** A group chat's manager (방장), computed, never stored: its maker while they are still in it (rooms.created_by, cleared
 * when they leave, are taken out or their account goes), else the member who joined first (then by id). null for the
 * other kinds or a room with nobody in it. */
export function managerOf(db: Database, room: Pick<RoomRow, 'id' | 'kind' | 'created_by'>): string | null {
  if (room.kind !== 'group') return null
  if (room.created_by && db.query('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(room.id, room.created_by)) return room.created_by
  return (db.query('SELECT user_id FROM room_members WHERE room_id = ? ORDER BY joined_at, user_id LIMIT 1').get(room.id) as { user_id: string } | null)?.user_id ?? null
}

/** What names a room to a viewer: its own name or the group's, how many are in it, up to 4 other members (a DM: the
 * other person). The rooms list's (roomOut) and the search's (rooms/search.ts). */
export function roomNaming(db: Database, room: RoomRow, viewerId: string): Pick<Room, 'name' | 'memberCount' | 'peers'> {
  // the room's own name wins over the server's (the group's name); a DM is always the other person
  const name = room.kind !== 'dm' && room.name ? room.name : groupName(db, room)
  const memberCount = (db.query('SELECT COUNT(*) n FROM room_members WHERE room_id = ?').get(room.id) as { n: number }).n
  const peers = db.query(`SELECT u.id, u.name FROM room_members m JOIN users u ON u.id = m.user_id WHERE m.room_id = ? AND m.user_id <> ?
    ORDER BY m.joined_at, u.name LIMIT 4`).all(room.id, viewerId) as UserRef[]
  return { name, memberCount, peers: peers.map((p) => ({ id: p.id, name: p.name })) }
}

/** A team room's group folder (its folders row's path, e.g. `groups/leads`) when this person may open it: the folder
 * rules as the Files page judges a folder (RuleSet.canList, the same test as listing it), no other path. null for the
 * other kinds, a group without a folder and someone the rules keep out (Room.groupFolder, the header's Files button;
 * docs/decisions/20261116-room-group-folder-button.md). `rules`: the caller's set when it judges many rooms at once. */
export function groupFolderFor(db: Database, room: Pick<RoomRow, 'kind' | 'group_id'>, userId: string, rules?: () => RuleSet): string | null {
  if (room.kind !== 'team' || !room.group_id) return null
  const f = (db.query('SELECT f.path FROM groups g JOIN folders f ON f.id = g.folder_id WHERE g.id = ?').get(room.group_id) as { path: string } | null)?.path
  if (!f) return null
  const who = loadPrincipal(db, userId)
  if (!who) return null
  return (rules ? rules() : RuleSet.load(db)).canList(who, f.split('/')) ? f : null
}

/** The folder rules read once, when a team room first needs them (a list or a fan-out of rooms: groupFolderFor). */
export function rulesOnce(db: Database): () => RuleSet {
  let rules: RuleSet | undefined
  return () => (rules ??= RuleSet.load(db))
}

/** `prefs`: the viewer's notification preferences when the caller has them (a list of rooms), else read here. `rules`:
 * the folder rules when the caller judges many rooms at once (groupFolderFor). */
export function roomOut(db: Database, room: RoomRow, viewer: MemberRow, prefs: Preferences = getPreferences(db, viewer.user_id), rules?: () => RuleSet): Room {
  const { name, memberCount, peers } = roomNaming(db, room, viewer.user_id)
  const unread = unreadCount(db, room.id, viewer)
  const threads = threadsUnread(db, room.id, viewer)
  const last = lastMessage(db, room.id, viewer)
  const since = viewer.joined_at > room.created_at ? viewer.joined_at : room.created_at
  // the viewer's own pin: each member's copy of the room carries theirs only
  const pinned = pinOf(db, room.id, viewer)
  // and the viewer's own list folder (chat/nav-folders.ts): none while hidden, and only one filed during this membership
  const folder = folderOf(db, room.id, viewer)
  // the team-wide category it is in (rooms/categories.ts): the same for every member
  const category = room.category_id !== undefined ? room.category_id : ((db.query('SELECT category_id FROM rooms WHERE id = ?').get(room.id) as { category_id: string | null } | null)?.category_id ?? null)
  const groupFolder = groupFolderFor(db, room, viewer.user_id, rules)
  // a project's own chat room (rooms/project-room.ts): the project for a viewer who can open it; its name, people and
  // alert default follow the project
  const projectRoom = room.kind === 'group' && isProjectRoom(db, room.id)
  const project = projectRoom ? projectForViewer(db, room, viewer.user_id, rules, memberCount) : undefined
  // a room whose files go to a team folder (rooms/team-place.ts: a project's chat room, a department's room with a
  // folder): whether it still holds files of its own (its Files list), and whether files of a conversation made a
  // project are still moving (rooms/file-moves.ts)
  const roomFiles = (projectRoom || room.kind === 'team') && hasRoomStoredFiles(db, room)
  const filesMoving = projectRoom && filesMovingIn(db, room.id)
  const listed = projectRoom && isListedProjectRoom(db, room.id)
  return {
    id: room.id, kind: room.kind, name, canRename: !projectRoom && mayRename(db, room, viewer.user_id), managerId: projectRoom ? null : managerOf(db, room), canManageApps: mayManageApps(db, room, viewer.user_id), groupId: room.kind === 'team' ? room.group_id : null, memberCount,
    peers,
    unreadCount: unread.n, threadsUnread: threads.n, nextThreadId: threads.next, mentioned: unread.mentioned || threads.mentioned,
    lastReadSeq: Math.max(viewer.last_read_seq, viewer.visible_from_seq), lastSeq: Math.max(lastSeqFor(db, room.id, viewer), viewer.visible_from_seq),
    lastMessage: last, muted: !!viewer.muted, notify: roomNotifyOut(room.kind, viewer, prefs, projectRoom), createdAt: room.created_at,
    activityAt: last && last.createdAt > since ? last.createdAt : since,
    ...(viewer.hidden_at ? { hidden: true as const } : {}),
    ...(pinned ? { pinnedAt: pinned } : {}),
    ...(folder ? { folderId: folder } : {}),
    ...(category ? { categoryId: category } : {}),
    ...(dmPeerGone(db, room) ? { gone: true as const } : {}),
    ...(groupFolder ? { groupFolder } : {}),
    ...(project ? { project } : {}),
    ...(projectRoom ? { projectRoom: true as const } : {}),
    ...(roomFiles ? { roomFiles: true as const } : {}),
    ...(filesMoving ? { filesMoving: true as const } : {}),
    ...(listed ? { listed: true as const } : {}),
  }
}

/** A DM whose other person was deleted from the team (their account is a tombstone, users.deleted_at): readable, closed to
 * new messages. Never a group or team room: those go on without them. */
export function dmPeerGone(db: Database, room: Pick<RoomRow, 'id' | 'kind'>): boolean {
  if (room.kind !== 'dm') return false
  return !!db.query('SELECT 1 FROM room_members m JOIN users u ON u.id = m.user_id WHERE m.room_id = ? AND u.deleted_at IS NOT NULL LIMIT 1').get(room.id)
}

/** The list folder this member keeps the room in (Room.folderId; docs/DECISIONS.md "List folders"), or null: never while
 * they hide it, never a row from before they joined (the rule of chat/nav-folders.ts VISIBLE_ROOM_ITEMS). */
export function folderOf(db: Database, roomId: string, viewer: Pick<MemberRow, 'user_id' | 'joined_at' | 'hidden_at'>): string | null {
  if (viewer.hidden_at || !viewer.user_id) return null
  const row = db.query("SELECT folder_id, added_at FROM nav_folder_items WHERE user_id = ? AND room_id = ? AND kind = 'rooms'").get(viewer.user_id, roomId) as { folder_id: string; added_at: string } | null
  return row && row.added_at >= viewer.joined_at ? row.folder_id : null
}

/** When this member pinned the room to the top of their 대화 list (docs/DECISIONS.md "Pinned conversations"), or null.
 * Only a pin of their membership now counts: never one of a room they hid, nor one made before they joined (a row an
 * older build left when they hid or left the room; the server drops both itself). */
export function pinOf(db: Database, roomId: string, viewer: Pick<MemberRow, 'user_id' | 'joined_at' | 'hidden_at'>): string | null {
  if (viewer.hidden_at) return null
  const at = (db.query('SELECT pinned_at FROM room_pins WHERE user_id = ? AND room_id = ?').get(viewer.user_id, roomId) as { pinned_at: string } | null)?.pinned_at ?? null
  return at && at >= viewer.joined_at ? at : null
}
/** The same rule in SQL, for room_pins p joined with the member's row m. */
export const PIN_COUNTS_SQL = 'm.hidden_at IS NULL AND p.pinned_at >= m.joined_at'

/** Can a member hide this kind of room (docs/DECISIONS.md "대화 숨기기"): a DM, a team room, the everyone room. A group
 * chat is left instead. */
export const hideable = (kind: RoomKind) => kind !== 'group'

export function membersOut(db: Database, roomId: string): RoomMember[] {
  return (db.query(`SELECT u.id, u.name, m.joined_at FROM room_members m JOIN users u ON u.id = m.user_id WHERE m.room_id = ? ORDER BY u.name, u.id`)
    .all(roomId) as { id: string; name: string; joined_at: string }[]).map((r) => ({ user: { id: r.id, name: r.name }, joinedAt: r.joined_at }))
}

/** The apps of these messages (rooms/apps), as a message shows its sender: the name and kind the app had when it posted
 * (a rename never changes what was said before), and its id while the app is there (null once removed). Messages that
 * no app posted are not in it. */
export function appRefsOf(db: Database, rows: readonly Pick<MessageRow, 'id' | 'app_id' | 'app_card' | 'app_quiet'>[]): Map<string, RoomAppRef> {
  const out = new Map<string, RoomAppRef>()
  const mine = rows.filter((r) => r.app_card)
  if (!mine.length) return out
  const ids = [...new Set(mine.map((r) => r.app_id).filter((x): x is string => !!x))]
  // live apps, with who added it while they are in the team (the sender's popover: "Set up by …")
  const live = new Map(ids.length ? (db.query(`SELECT a.id, a.kind, a.preset, u.id by_id, u.name by_name FROM room_apps a LEFT JOIN users u ON u.id = a.created_by AND u.deleted_at IS NULL
    WHERE a.id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { id: string; kind: string; preset: string | null; by_id: string | null; by_name: string | null }[]).map((a) => [a.id, a]) : [])
  // a plain Other app's own icon now (apps/icon.ts): a new one shows on its past messages too; a removed app has none
  const icons = iconsOf(db, [...live.values()].filter((a) => a.kind === 'other' && !a.preset).map((a) => a.id))
  for (const r of mine) {
    const stored = parseStored(r.app_card ?? null)
    if (!stored) continue
    const kind = stored.app.kind as RoomAppKind
    out.set(r.id, {
      id: r.app_id && live.has(r.app_id) ? r.app_id : null, name: stored.app.name, kind: RoomAppKind.safeParse(kind).success ? kind : 'other',
      // the service of a preset app (its logo), when this build knows it
      ...(kind === 'other' && RoomAppPreset.safeParse(stored.app.preset).success ? { preset: stored.app.preset as RoomAppPreset } : {}),
      ...(r.app_id && icons.has(r.app_id) ? { icon: icons.get(r.app_id)! } : {}),
      by: (() => { const l = r.app_id ? live.get(r.app_id) : undefined; return l?.by_id && l.by_name ? { id: l.by_id, name: l.by_name } : null })(),
      ...(r.app_quiet ? { quiet: true as const } : {}), ...(stored.example ? { example: true as const } : {}),
    })
  }
  return out
}

/** A message's app fields (none for a person's message): the app and its card; a deleted one keeps its sender only. */
function appOut(apps: Map<string, RoomAppRef>, r: MessageRow): Pick<RoomMessage, 'app' | 'appCard'> {
  const app = apps.get(r.id)
  if (!app) return {}
  const card = r.deleted_at ? null : parseStored(r.app_card ?? null)?.card
  return { app, ...(card ? { appCard: card } : {}) }
}
