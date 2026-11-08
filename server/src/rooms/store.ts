// Team chat rooms: rows and what one person may see of them (docs/DECISIONS.md "대화방 v1"). Every read goes through a
// member row: someone who is not in the room gets nothing, whatever their role (an admin or the owner too).
//
// What a member sees: messages after where they see the room from (seesFrom: a team room's or the everyone room's whole
// history, a group chat or 1:1 from their join on), and of those the ones for the whole room or private to them
// (visibility 'private', visible_to: the AI's previews), but not the old answers hidden from them (room_hidden_answers,
// rooms/history.ts: a later member who could not open what an answer used) nor what is in their threads.
//
// Event lines (room_messages.event, docs/DECISIONS.md "그룹 대화와 방 이름"): a rename, people invited, someone left or
// taken out. They take a seq and are seen like any message, but count nowhere: no badge, never the rooms list's last
// line, no notice; their body is ''.
//
// Threads (docs/DECISIONS.md "스레드와 반응"): a reply (thread_root_id) takes a seq like any message but is not in the
// timeline (TIMELINE_SQL) unless it was sent to the room too (also_in_room). It is seen by whoever sees its root: canSee
// and SEE_SQL go by the root's seq (thread_root_seq), so a later member sees no reply of a root from before they joined.
// Who follows a thread and where they are in it: room_thread_follows. Reactions: room_reactions (8 fixed emoji),
// counted for current members only, never anywhere else.
import type { Database } from 'bun:sqlite'
import { getPreferences, type Preferences } from '../notifications/preferences'
import { roomNotifyOut } from './alerts'
import { answerFilePaths, RoomEventLine, ROOM_QUOTE_EXCERPT_MAX, ROOM_REACTION_NAMES, type Room, type RoomFile, type RoomKind, type RoomLastMessage, type RoomMember, type RoomMessage, type RoomQuote, type RoomReaction, type RoomReactionEmoji, type RoomThreadSummary, type UserRef } from '@mycel/shared/api'

export const MAX_UNREAD = 999
const EXCERPT_QUOTE = ROOM_QUOTE_EXCERPT_MAX
const EXCERPT_LIST = 120

export interface RoomRow { id: string; kind: RoomKind; group_id: string | null; dm_key: string | null; created_by: string | null; created_at: string; last_seq: number; activity_at: string; archived_at: string | null; name: string | null }
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
}
/** An event line as stored: user ids, never names (they are read when it is shown). */
export type EventData =
  | { type: 'created'; userIds: string[] }
  | { type: 'renamed'; name: string | null }
  | { type: 'added'; userIds: string[] }
  | { type: 'left' }
  | { type: 'removed'; userId: string }
export interface FileRow { id: string; room_id: string; user_id: string | null; message_id: string | null; name: string; size: number; mime: string; kind: RoomFile['kind']; width: number | null; height: number | null; sha256: string; thumb: number; created_at: string }

export const MSG_COLS = 'id, room_id, seq, author_kind, author_id, asked_by, visibility, visible_to, body, reply_to_id, mentions, client_id, created_at, edited_at, deleted_at, event, thread_root_id, thread_root_seq, also_in_room, mentions_all, answer_at, answer_cut'
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
  !!db.query('SELECT 1 FROM room_members m JOIN rooms r ON r.id = m.room_id WHERE m.room_id = ? AND m.user_id = ? AND r.archived_at IS NULL').get(roomId, userId)
export const members = (db: Database, roomId: string): MemberRow[] => db.query(`SELECT ${MEMBER_COLS} FROM room_members m WHERE m.room_id = ?`).all(roomId) as MemberRow[]
export const messageRow = (db: Database, roomId: string, id: string): MessageRow | null =>
  db.query(`SELECT ${MSG_COLS} FROM room_messages WHERE id = ? AND room_id = ?`).get(id, roomId) as MessageRow | null

/** Who may open which team file now (rooms/service.ts sets it for the server's database): an AI answer's file links
 * are shown as links only for files the viewer may open. Without one, none are (fails closed). */
const pathChecks = new WeakMap<Database, (userId: string) => (rel: string) => boolean>()
/** `check(userId)` gives one viewer's test for a list of messages (their access loaded once, each path once). */
export function setRoomPathCheck(db: Database, check: (userId: string) => (rel: string) => boolean) { pathChecks.set(db, check) }

/** Does the AI wait on this member in this room: a question of theirs shows a card for their answer (rooms/ai.ts sets it
 * for the server's database; Room.aiWaits, docs/DECISIONS.md "Session markers"). Without one, never. */
const aiWaiting = new WeakMap<Database, (roomId: string, userId: string) => boolean>()
export function setRoomAiWaiting(db: Database, check: (roomId: string, userId: string) => boolean) { aiWaiting.set(db, check) }

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
  // a private preview is its person's, and only from their join on: one of theirs from before they left and joined again
  // was never judged for the room's history (rooms/history.ts walks what went to the room)
  if (m.visibility !== 'room') return m.visible_to === member.user_id && seenSeq(m) > member.visible_from_seq
  return member.has_hidden === 0 || !isHiddenFor(db, m, member.user_id)
}
/** The same as SQL on room_messages `m`; its parameters are seeArgs(member). `m.seq > ?` first: a reply's seq is above
 * its root's, so it adds nothing to the rule and lets the (room_id, seq) index start where the member sees from. The
 * hidden answers: one primary-key probe per row (room_id, user_id, message_id), for the message and for its root,
 * skipped for a member none of whose old answers is hidden (has_hidden 0). */
export const SEE_SQL = "m.seq > ? AND COALESCE(m.thread_root_seq, m.seq) > ? AND (m.visibility = 'room' OR (m.visible_to = ? AND COALESCE(m.thread_root_seq, m.seq) > ?)) AND (? = 0 OR NOT EXISTS (SELECT 1 FROM room_hidden_answers h WHERE h.room_id = m.room_id AND h.user_id = ? AND h.message_id IN (m.id, m.thread_root_id)))"
/** The timeline's and a thread's listings only (same parameters): a hidden answer itself stays in the list, where
 * messagesOut shows it as one line without its content; what is in its thread does not. */
export const LIST_SQL = "m.seq > ? AND COALESCE(m.thread_root_seq, m.seq) > ? AND (m.visibility = 'room' OR (m.visible_to = ? AND COALESCE(m.thread_root_seq, m.seq) > ?)) AND (? = 0 OR NOT EXISTS (SELECT 1 FROM room_hidden_answers h WHERE h.room_id = m.room_id AND h.user_id = ? AND h.message_id = m.thread_root_id))"
/** The order of SEE_SQL's (and LIST_SQL's) parameters, once: where they see from, the person, their join, whether to
 * look for hidden answers. seeArgs gives values; SEE_MEMBER_SQL the same as columns. */
const seeParts = <F, U, J, P>(from: F, user: U, joined: J, probe: P) => [from, from, user, joined, probe, user] as const
export const seeArgs = (member: SeeMember) => seeParts(seesFrom(member), member.user_id, member.visible_from_seq, member.has_hidden === 0 ? 0 : 1)
/** SEE_SQL for messages of many rooms at once: the member's values read from a joined room_members row `mm` of the
 * message's room (seesFrom as COALESCE; hidden answers always looked for). The same rule, filled from seeParts: a search
 * across rooms (rooms/search.ts) decides in SQL, so what it counts, skips and points a cursor at is only what they see. */
export const SEE_MEMBER_SQL = (() => {
  const cols: readonly string[] = seeParts('COALESCE(mm.history_from_seq, mm.visible_from_seq)', 'mm.user_id', 'mm.visible_from_seq', '1')
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

function refsOf(db: Database, ids: Iterable<string | null>): Map<string, UserRef> {
  const want = [...new Set([...ids].filter((x): x is string => !!x))]
  const out = new Map<string, UserRef>()
  if (!want.length) return out
  for (const r of db.query(`SELECT id, name FROM users WHERE id IN (${want.map(() => '?').join(',')})`).all(...want) as { id: string; name: string }[]) out.set(r.id, { id: r.id, name: r.name })
  return out
}

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
      case 'removed': return typeof v.userId === 'string' ? { type: 'removed', userId: v.userId } : null
    }
  } catch { /* not an event this build reads */ }
  return null
}
const eventUserIds = (e: EventData | null): string[] => (!e ? [] : e.type === 'created' || e.type === 'added' ? e.userIds : e.type === 'removed' ? [e.userId] : [])
/** The event line as the app gets it: the people by name as they are now (an account that is gone is left out). */
function eventOut(e: EventData, people: Map<string, UserRef>): RoomEventLine {
  const refs = (ids: string[]) => ids.map((id) => people.get(id)).filter((x): x is UserRef => !!x)
  switch (e.type) {
    case 'created': return { type: 'created', users: refs(e.userIds) }
    case 'added': return { type: 'added', users: refs(e.userIds) }
    case 'renamed': return { type: 'renamed', name: e.name }
    case 'left': return { type: 'left' }
    case 'removed': return { type: 'removed', user: people.get(e.userId) ?? null }
  }
}

export const fileOut = (f: FileRow): RoomFile => ({
  id: f.id, name: f.name, size: f.size, mime: f.mime, kind: f.kind,
  ...(f.width ? { width: f.width } : {}), ...(f.height ? { height: f.height } : {}), thumb: !!f.thumb,
})

/** The rows of a list that are hidden from `viewer` (one of their hidden old answers, or in its thread). */
function hiddenAmong(db: Database, rows: readonly MessageRow[], viewer: Pick<MemberRow, 'user_id'>): Set<string> {
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
export function messagesOut(db: Database, all: readonly MessageRow[], viewer: MemberRow): RoomMessage[] {
  if (!all.length) return []
  const withheld = hiddenAmong(db, all, viewer)
  const rows = withheld.size ? all.filter((r) => !withheld.has(r.id)) : all
  const out = rows.length ? shownOut(db, rows, viewer) : []
  if (!withheld.size) return out
  const shown = new Map(out.map((m) => [m.id, m]))
  const people = refsOf(db, all.filter((r) => withheld.has(r.id)).flatMap((r) => [r.author_kind === 'ai' ? null : r.author_id, r.asked_by]))
  return all.map((r) => shown.get(r.id) ?? withheldOut(db, r, viewer, people))
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
function shownOut(db: Database, rows: readonly MessageRow[], viewer: MemberRow): RoomMessage[] {
  const ids = rows.map((r) => r.id)
  const files = new Map<string, RoomFile[]>()
  for (const f of db.query(`SELECT * FROM room_files WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at, id`).all(...ids) as FileRow[]) {
    const l = files.get(f.message_id!) ?? []
    l.push(fileOut(f))
    files.set(f.message_id!, l)
  }
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
  // answers people sent from their own AI chat with files attached: which of the answer's links each copy stands for
  const attached = attachedLinksOn(db, rows.filter((r) => sharedAnswerOf(r) && files.has(r.id)), files)
  // AI answers (rooms/ai.ts): their source count, and for the person who asked a private preview, why it is private
  const ai = rows.filter((r) => r.author_kind === 'ai').map((r) => r.id)
  // the file links of AI answers, and of answers people sent from their own AI chat (sharedAnswerOf), per viewer
  const opens = ai.length || rows.some((r) => sharedAnswerOf(r)) ? pathChecks.get(db)?.(viewer.user_id) : undefined
  const sourceCounts = new Map<string, number>()
  const previews = new Map<string, NonNullable<RoomMessage['preview']>>()
  if (ai.length) {
    const marks = ai.map(() => '?').join(',')
    for (const c of db.query(`SELECT message_id, COUNT(*) n FROM room_message_sources WHERE message_id IN (${marks}) GROUP BY message_id`).all(...ai) as { message_id: string; n: number }[]) sourceCounts.set(c.message_id, c.n)
    for (const t of db.query(`SELECT answer_id, decision FROM room_ai_turns WHERE answer_id IN (${marks})`).all(...ai) as { answer_id: string; decision: string | null }[]) {
      try {
        const d = JSON.parse(t.decision ?? 'null')
        const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x: unknown): x is string => typeof x === 'string') : [])
        if (d) previews.set(t.answer_id, { folders: strings(d.folders), ...(d.otherFolders ? { otherFolders: true } : {}), personal: !!d.personal, outside: !!d.outside, joinedLater: strings(d.joinedLater), ...(d.hidden ? { hidden: true as const } : {}) })
      } catch { /* no reason shown */ }
    }
  }
  // questions whose answer stayed private to their author (rooms/ai.ts): the others see that it was answered, no more
  const asked = rows.filter((r) => r.author_kind === 'user' && !r.event && !r.deleted_at && r.author_id !== viewer.user_id).map((r) => r.id)
  const answeredPrivately = new Set(asked.length ? (db.query(`SELECT question_id FROM room_ai_turns WHERE status = 'private' AND question_id IN (${asked.map(() => '?').join(',')})`).all(...asked) as { question_id: string }[]).map((t) => t.question_id) : [])
  return rows.map((r): RoomMessage => {
    const ev = events.get(r.id)
    if (r.event) {
      // an event line: who did it and what, nothing else. One this build cannot read (a newer build's, a damaged row)
      // is a neutral line by nobody: never a message, and never words put in its author's mouth
      return {
        id: r.id, roomId: r.room_id, seq: r.seq, authorKind: 'user', author: ev && r.author_id ? people.get(r.author_id) ?? null : null, askedBy: null,
        visibility: 'room', body: '', replyTo: null, mentions: [], files: [], createdAt: r.created_at, editedAt: null, deletedAt: null,
        event: ev ? eventOut(ev, people) : { type: 'unknown' },
      }
    }
    let replyTo: RoomQuote | null = null
    if (r.reply_to_id) {
      const q = quotes.get(r.reply_to_id)
      // a quote the viewer may not see (sent before they joined, private to someone else, an old answer hidden from
      // them) shows no content; a hidden answer says so (withheld)
      const shown = q && canSee(db, q, viewer) && !q.deleted_at && !q.event
      const hidden = !shown && !!q && !q.deleted_at && !q.event && isHiddenFor(db, q, viewer.user_id)
      replyTo = { id: r.reply_to_id, author: shown && q.author_id ? people.get(q.author_id) ?? null : null, excerpt: shown ? excerpt(q.body, EXCERPT_QUOTE) : '', fileCount: shown ? quoteFiles.get(q.id) ?? 0 : 0, deleted: !shown, ...(hidden ? { withheld: true as const } : {}) }
    }
    const thread = threads.get(r.id)
    const reacted = reactions.get(r.id)
    const shared = sharedAnswerOf(r)
    return {
      id: r.id, roomId: r.room_id, seq: r.seq, authorKind: r.author_kind,
      author: r.author_id ? people.get(r.author_id) ?? null : null,
      askedBy: r.asked_by ? people.get(r.asked_by) ?? null : null,
      visibility: r.visibility,
      body: r.deleted_at ? '' : r.body,
      replyTo,
      mentions: r.deleted_at ? [] : parseMentions(r.mentions),
      ...(r.mentions_all && !r.deleted_at ? { mentionsAll: true } : {}),
      files: r.deleted_at ? [] : files.get(r.id) ?? [],
      createdAt: r.created_at, editedAt: r.edited_at, deletedAt: r.deleted_at,
      ...(r.author_kind === 'ai' && !r.deleted_at ? { sourceCount: sourceCounts.get(r.id) ?? 0, openable: openableFor(opens, r.body) } : {}),
      // an answer of the author's own AI chat: the links of its answer part, for the files this viewer may open
      ...(shared ? { sharedAnswer: shared, openable: openableFor(opens, r.body.slice(shared.at)), ...(attached.get(r.id)?.length ? { attachedLinks: attached.get(r.id)! } : {}) } : {}),
      // only the person it is private to ever gets this (canSee: nobody else is sent a private message at all)
      ...(r.author_kind === 'ai' && r.visibility === 'private' && r.visible_to === viewer.user_id && previews.has(r.id) ? { preview: previews.get(r.id)! } : {}),
      ...(answeredPrivately.has(r.id) ? { answeredPrivately: true } : {}),
      ...(r.thread_root_id ? { threadRootId: r.thread_root_id, ...(r.also_in_room ? { alsoInRoom: true as const } : {}), ...(followed.has(r.thread_root_id) ? { following: true as const } : {}) } : {}),
      ...(thread ? { thread } : {}),
      ...(reacted?.length ? { reactions: reacted } : {}),
    }
  })
}

/** The threads under these roots as `viewer` sees them: only roots with replies they can see (not deleted) get one.
 * Bounded by the page: one grouped count, the repliers per root, and the viewer's follow rows. */
export function threadSummaries(db: Database, roomId: string, rootIds: readonly string[], viewer: MemberRow): Map<string, RoomThreadSummary> {
  const out = new Map<string, RoomThreadSummary>()
  if (!rootIds.length) return out
  const marks = rootIds.map(() => '?').join(',')
  // (a private reply of theirs only from their join on, as canSee)
  const see = "m.deleted_at IS NULL AND m.event IS NULL AND (m.visibility = 'room' OR (m.visible_to = ? AND m.thread_root_seq > ?))"
  const vfs = viewer.visible_from_seq
  const counts = db.query(`SELECT m.thread_root_id root, COUNT(*) n, MAX(m.created_at) last FROM room_messages m WHERE m.room_id = ? AND m.thread_root_id IN (${marks}) AND ${see} GROUP BY m.thread_root_id`)
    .all(roomId, ...rootIds, viewer.user_id, vfs) as { root: string; n: number; last: string }[]
  if (!counts.length) return out
  const roots = counts.map((c) => c.root)
  const rm = roots.map(() => '?').join(',')
  // the people who replied, the latest first (the AI has no author: it is not one of them)
  const by = db.query(`SELECT m.thread_root_id root, m.author_id uid, MAX(m.seq) s FROM room_messages m WHERE m.room_id = ? AND m.thread_root_id IN (${rm}) AND ${see}
    AND m.author_kind = 'user' AND m.author_id IS NOT NULL GROUP BY m.thread_root_id, m.author_id`).all(roomId, ...roots, viewer.user_id, vfs) as { root: string; uid: string; s: number }[]
  const repliers = new Map<string, { uid: string; s: number }[]>()
  for (const b of by) (repliers.get(b.root) ?? repliers.set(b.root, []).get(b.root)!).push(b)
  const top = new Map([...repliers].map(([root, l]) => [root, l.sort((a, b) => b.s - a.s).slice(0, 3).map((x) => x.uid)]))
  const people = refsOf(db, [...top.values()].flat())
  // (a reply sent to the room too is new in the timeline, not here: threadsUnread)
  const fresh = new Set((db.query(`SELECT f.root_id FROM room_thread_follows f WHERE f.user_id = ? AND f.root_id IN (${rm}) AND EXISTS (SELECT 1 FROM room_messages m
    WHERE m.thread_root_id = f.root_id AND m.seq > f.last_read_seq AND m.also_in_room = 0 AND ${see} AND (m.author_id IS NULL OR m.author_id <> ?))`).all(viewer.user_id, ...roots, viewer.user_id, vfs, viewer.user_id) as { root_id: string }[]).map((r) => r.root_id))
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
    GROUP BY r.message_id, r.emoji ORDER BY r.message_id, first, r.emoji`).all(viewer.user_id, ...messageIds) as { mid: string; emoji: RoomReactionEmoji; n: number; mine: number; first: string }[]
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

/** A shared answer as an AI reads it (rooms/reader.ts, rooms/ai.ts): the person's note, then the answer marked as
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
function openableFor(check: ((rel: string) => boolean) | undefined, body: string): string[] {
  if (!check) return []
  return answerFilePaths(body).filter((p) => { try { return check(p) } catch { return false } })
}

/** The rooms list line: the newest message of the timeline `viewer` can see. */
function lastMessage(db: Database, roomId: string, viewer: MemberRow): RoomLastMessage | null {
  // event lines are not what the room's list line shows, nor replies that stay in their thread
  const m = db.query(`SELECT ${MSG_COLS} FROM room_messages m WHERE m.room_id = ? AND ${SEE_SQL} AND ${TIMELINE_SQL} AND m.event IS NULL ORDER BY m.seq DESC LIMIT 1`).get(roomId, ...seeArgs(viewer)) as MessageRow | null
  if (!m) return null
  const author = m.author_id ? refsOf(db, [m.author_id]).get(m.author_id) ?? null : null
  const files = m.deleted_at ? 0 : (db.query('SELECT COUNT(*) n FROM room_files WHERE message_id = ?').get(m.id) as { n: number }).n
  return { id: m.id, seq: m.seq, author, excerpt: m.deleted_at ? '' : excerpt(m.body.replace(/\s+/g, ' ').trim(), EXCERPT_LIST), fileCount: files, deleted: !!m.deleted_at, createdAt: m.created_at }
}

/** Unread messages of the timeline for `viewer`: after their read position, theirs to see, not their own, not deleted,
 * no event line, no reply that stays in its thread. */
export function unreadCount(db: Database, roomId: string, viewer: MemberRow): { n: number; mentioned: boolean } {
  const from = Math.max(viewer.last_read_seq, viewer.visible_from_seq)
  const r = db.query(`SELECT COUNT(*) n, MAX(${MENTIONS_SQL}) men FROM room_messages m
    WHERE m.room_id = ? AND m.seq > ? AND ${SEE_SQL} AND ${TIMELINE_SQL} AND m.deleted_at IS NULL AND m.event IS NULL AND (m.author_id IS NULL OR m.author_id <> ?)`)
    .get(viewer.user_id, viewer.user_id, roomId, from, ...seeArgs(viewer), viewer.user_id) as { n: number; men: number | null }
  return { n: Math.min(MAX_UNREAD, r.n), mentioned: !!r.men }
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
      AND m.deleted_at IS NULL AND m.event IS NULL AND (m.visibility = 'room' OR m.visible_to = ?) AND (m.author_id IS NULL OR m.author_id <> ?)
      AND NOT EXISTS (SELECT 1 FROM room_hidden_answers h WHERE h.room_id = root.room_id AND h.user_id = f.user_id AND h.message_id IN (root.id, m.id))
    GROUP BY f.root_id ORDER BY newest DESC LIMIT ${THREADS_LOOKED_AT}`)
    .all(viewer.user_id, viewer.user_id, viewer.user_id, roomId, roomId, seesFrom(viewer), roomId, viewer.user_id, viewer.user_id) as { root_id: string; newest: number; men: number | null }[]
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
  if (room.kind === 'group') return true
  if (room.kind === 'dm') return false
  return isOwnerOrAdmin(db, userId)
}
/** An owner or an admin (an account that is active). */
export const isOwnerOrAdmin = (db: Database, userId: string): boolean =>
  !!db.query("SELECT 1 FROM users WHERE id = ? AND role IN ('owner', 'admin') AND status = 'active' AND deleted_at IS NULL").get(userId)

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

/** `prefs`: the viewer's notification preferences when the caller has them (a list of rooms), else read here. */
export function roomOut(db: Database, room: RoomRow, viewer: MemberRow, prefs: Preferences = getPreferences(db, viewer.user_id)): Room {
  const { name, memberCount, peers } = roomNaming(db, room, viewer.user_id)
  const unread = unreadCount(db, room.id, viewer)
  const threads = threadsUnread(db, room.id, viewer)
  const last = lastMessage(db, room.id, viewer)
  const since = viewer.joined_at > room.created_at ? viewer.joined_at : room.created_at
  return {
    id: room.id, kind: room.kind, name, canRename: mayRename(db, room, viewer.user_id), managerId: managerOf(db, room), groupId: room.kind === 'team' ? room.group_id : null, memberCount,
    peers,
    unreadCount: unread.n, threadsUnread: threads.n, nextThreadId: threads.next, mentioned: unread.mentioned || threads.mentioned,
    lastReadSeq: Math.max(viewer.last_read_seq, viewer.visible_from_seq), lastSeq: Math.max(lastSeqFor(db, room.id, viewer), viewer.visible_from_seq),
    lastMessage: last, muted: !!viewer.muted, notify: roomNotifyOut(room.kind, viewer, prefs), createdAt: room.created_at,
    activityAt: last && last.createdAt > since ? last.createdAt : since,
    ...(aiWaiting.get(db)?.(room.id, viewer.user_id) ? { aiWaits: true as const } : {}),
    ...(viewer.hidden_at ? { hidden: true as const } : {}),
  }
}

/** Can a member hide this kind of room (docs/DECISIONS.md "대화 숨기기"): a DM, a team room, the everyone room. A group
 * chat is left instead. */
export const hideable = (kind: RoomKind) => kind !== 'group'

export function membersOut(db: Database, roomId: string): RoomMember[] {
  return (db.query(`SELECT u.id, u.name, m.joined_at FROM room_members m JOIN users u ON u.id = m.user_id WHERE m.room_id = ? ORDER BY u.name, u.id`)
    .all(roomId) as { id: string; name: string; joined_at: string }[]).map((r) => ({ user: { id: r.id, name: r.name }, joinedAt: r.joined_at }))
}
