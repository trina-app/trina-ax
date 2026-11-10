// Room notices in the Inbox (docs/DECISIONS.md "알림함의 대화 알림"): which of them the Inbox lists and counts, how they
// make rows, and what a row says — who, where (the room, a thread), why (a mention, "@전체", replies in a thread I
// follow) and the first line of the newest message — only while the person is in the room, has not hidden it and may
// read the message.
//
// A row is one place (a room's timeline, or one thread) and what is unread there for me; once read, the notices read
// together stay one row. One notice already stands for one unread run (Notifications.roomNotice: no second notice of a
// kind and place while one is unread; what it held back is kept as last_seq / last_at), but a place can have several
// (a mention and a reply in one thread, a run split by quiet hours): the row is all of them, so the Inbox shows
// "민준 외 2명 · 답글 3개" once. Reading the row reads every notice in it.
import type { Database } from 'bun:sqlite'
import { plainLabel, type InboxNotification, type Locale } from '@mycel/shared/api'
import { ROOM_WORDS } from '../notifications/text'
import { groupName, isHiddenFor, MENTIONS_SQL, parseMentions, seenSeq, sharedAnswerOf } from './store'

/** Which room notices are rows of the Inbox (on room_notices `n` and its message `m`): mentions ("@전체" too) and
 * replies in threads I follow. A message of a DM, a group chat or a room at 모든 메시지 still makes its notice and its
 * push, but no row (the 대화 tab counts those). To list them as well, add `OR n.event_type = 'room.dm'` here (and keep
 * COUNTED_SQL as it is: listed, not counted). */
export const LISTED_SQL = `(n.event_type = 'room.mention' OR (m.thread_root_id IS NOT NULL AND EXISTS (SELECT 1 FROM room_thread_follows f WHERE f.root_id = m.thread_root_id AND f.user_id = n.user_id)))`
/** Which listed rows count in the Inbox's unread number: today all of them. */
export const COUNTED_SQL = LISTED_SQL
/** What the person may read now (`rm` their member row, `r` the room): not archived, not hidden by them, the message
 * there, theirs to see. A notice of a message they can no longer read is no row at all. */
const READABLE_SQL = `r.archived_at IS NULL AND rm.hidden_at IS NULL AND m.deleted_at IS NULL AND m.event IS NULL
  AND COALESCE(m.thread_root_seq, m.seq) > COALESCE(rm.history_from_seq, rm.visible_from_seq) AND (m.visibility = 'room' OR m.visible_to = n.user_id)
  AND NOT EXISTS (SELECT 1 FROM room_hidden_answers h WHERE h.room_id = m.room_id AND h.user_id = n.user_id AND h.message_id IN (m.id, m.thread_root_id))`

/** Has the person an unread notice in this room that the Inbox counts (hiding, showing or leaving the room changes the
 * count then, and their windows read it again)? */
export function countedUnreadIn(db: Database, userId: string, roomId: string): boolean {
  return !!db.query(`SELECT 1 FROM room_notices n JOIN room_messages m ON m.id = n.source_id WHERE n.user_id = ? AND n.room_id = ? AND n.read_at IS NULL AND n.suppressed = 0
    AND ${COUNTED_SQL} LIMIT 1`).get(userId, roomId)
}

/** The longest preview sent (the row shows one line and cuts it with an ellipsis). */
export const PREVIEW_MAX = 200
/** The longest name or title sent. */
const NAME_MAX = 80

/** The first line of a message with text, as one plain line of at most PREVIEW_MAX characters. */
export function previewLine(body: string): string {
  return plainLabel(body.split('\n').map((l) => l.trim()).find(Boolean) ?? '', PREVIEW_MAX)
}

/** One row of the Inbox from room notices: the newest notice stands for it (its id is the row's). */
export interface RoomRow {
  id: string; user_id: string; event_type: 'room.dm' | 'room.mention'; source_id: string; created_at: string; read_at: string | null; suppressed: 0
  /** the newest message time of the row (its place in the Inbox) */
  sort_at: string
  /** counts in the unread number (unread and COUNTED_SQL) */
  counted: boolean
  group: Group
}
interface Group { ids: string[]; roomId: string; place: string | null; from: number; to: number }
type Listed = { id: string; user_id: string; event_type: 'room.dm' | 'room.mention'; source_id: string; room_id: string; created_at: string; read_at: string | null; last_at: string; last_seq: number | null; seq: number; place: string | null; counted: number }

/** The person's Inbox rows of rooms (within the Inbox's 30 days), newest first. */
export function roomRows(db: Database, userId: string, cutoff: string): RoomRow[] {
  const rows = db.query(`SELECT n.id, n.user_id, n.event_type, n.source_id, n.room_id, n.created_at, n.read_at, COALESCE(n.last_at, n.created_at) last_at, n.last_seq,
      m.seq, m.thread_root_id place, ${COUNTED_SQL} counted
    FROM room_notices n JOIN room_messages m ON m.id = n.source_id JOIN room_members rm ON rm.room_id = n.room_id AND rm.user_id = n.user_id JOIN rooms r ON r.id = n.room_id
    WHERE n.user_id = ? AND n.suppressed = 0 AND n.created_at >= ? AND ${READABLE_SQL} AND ${LISTED_SQL}`).all(userId, cutoff) as Listed[]
  // one row per place and reading: what is unread there, or what was read together (one read_at)
  const groups = new Map<string, Listed[]>()
  for (const r of rows) {
    const key = `${r.room_id} ${r.place ?? ''} ${r.read_at ?? ''}`
    ;(groups.get(key) ?? groups.set(key, []).get(key)!).push(r)
  }
  const out: RoomRow[] = []
  for (const g of groups.values()) {
    g.sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1))
    const newest = g.at(-1)!
    out.push({
      id: newest.id, user_id: userId, event_type: newest.event_type, source_id: newest.source_id, created_at: newest.created_at, read_at: newest.read_at, suppressed: 0,
      sort_at: g.reduce((t, x) => (x.last_at > t ? x.last_at : t), newest.created_at),
      counted: !newest.read_at && g.some((x) => !!x.counted),
      group: {
        ids: g.map((x) => x.id), roomId: newest.room_id, place: newest.place, from: Math.min(...g.map((x) => x.seq)), to: Math.max(...g.map((x) => Math.max(x.seq, x.last_seq ?? x.seq))),
      },
    })
  }
  return out.sort((a, b) => (a.sort_at === b.sort_at ? (a.id < b.id ? 1 : -1) : a.sort_at < b.sort_at ? 1 : -1))
}

/** The row a notice belongs to (its id is any of the row's notices), for reading it. */
export function roomRowOf(db: Database, userId: string, noticeId: string, cutoff: string): RoomRow | null {
  return roomRows(db, userId, cutoff).find((r) => r.group.ids.includes(noticeId)) ?? null
}

type RoomInfo = { kind: 'team' | 'all' | 'dm' | 'group'; name: string | null; group_id: string | null; last_read_seq: number; visible_from_seq: number; history_from_seq: number | null }
type Msg = { id: string; seq: number; author_kind: 'user' | 'ai'; author_id: string | null; body: string; created_at: string; deleted_at: string | null; event: string | null; answer_at: number | null; answer_cut: number }
const MSG = 'm.id, m.seq, m.author_kind, m.author_id, m.body, m.created_at, m.deleted_at, m.event, m.answer_at, m.answer_cut'
/** A row counts at most this many messages (the pill says 99+ past 99), so a long run costs no more than that. */
export const COUNT_MAX = 100
/** What counts in a row for `?` (the person), on room_messages `m`: a message for the whole room they see (from where
 * they see the room, not an old answer hidden from them or in its thread), not deleted, not an event line, written by
 * someone else, not an AI answer they asked for. Parameters: where they see from ×2, person ×3. */
const FOR_ME_SQL = `m.seq > ? AND COALESCE(m.thread_root_seq, m.seq) > ? AND m.visibility = 'room' AND m.deleted_at IS NULL AND m.event IS NULL
  AND (m.author_id IS NULL OR m.author_id <> ?) AND (m.author_kind <> 'ai' OR m.asked_by IS NULL OR m.asked_by <> ?)
  AND NOT EXISTS (SELECT 1 FROM room_hidden_answers h WHERE h.room_id = m.room_id AND h.user_id = ? AND h.message_id IN (m.id, m.thread_root_id))`

const roomInfo = (db: Database, roomId: string, userId: string) => db.query(`SELECT r.kind, r.name, r.group_id, rm.last_read_seq, rm.visible_from_seq, rm.history_from_seq FROM rooms r
  JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = ? WHERE r.id = ?`).get(userId, roomId) as RoomInfo | null
const nameOf = (db: Database, userId: string | null) => userId ? (db.query('SELECT name FROM users WHERE id = ?').get(userId) as { name: string } | null)?.name ?? null : null
/** The room's own name, else its group's (null: a DM, or a group chat without one) */
const roomName = (db: Database, room: Pick<RoomInfo, 'kind' | 'name' | 'group_id'>) => {
  if (room.kind === 'dm') return null
  const name = room.name || groupName(db, room)
  return name ? plainLabel(name, NAME_MAX) : null
}
/** Who wrote a message, as the row says it */
const writer = (db: Database, m: Pick<Msg, 'author_kind' | 'author_id'>) => ({
  from: m.author_kind === 'ai' ? null : (() => { const n = nameOf(db, m.author_id); return n ? plainLabel(n, NAME_MAX) : null })(),
  fromId: m.author_kind === 'ai' ? null : m.author_id, ...(m.author_kind === 'ai' ? { ai: true as const } : {}),
})

/** The first line of a message as the Inbox shows it: an AI answer's (and an answer shared from an AI chat, after the
 * person's own note when there is none) without its Markdown marks. */
function messageLine(m: Msg): string {
  const shared = sharedAnswerOf(m)
  if (shared) {
    const note = previewLine(m.body.slice(0, shared.at))
    return note || previewLine(plainMarkdown(m.body.slice(shared.at)))
  }
  return previewLine(m.author_kind === 'ai' ? plainMarkdown(m.body) : m.body)
}
/** Markdown's marks off each line (headings, quotes, list marks, emphasis, code ticks, link targets): what the app's
 * rooms list does for an AI answer (web lib/rooms.ts plainLine), enough for one line. */
export function plainMarkdown(md: string): string {
  return md.split('\n').map((l) => l
    .replace(/!?\[([^\]]*)\]\([^)]*\)?/g, '$1')
    .replace(/^[ \t]{0,3}(#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)/, '')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2').replace(/\*\*|__|~~|`+/g, '')
    .replace(/^[ \t]*\|?[ \t]*:?-{2,}.*$/, '').replace(/[ \t]*\|[ \t]*/g, ' ')).join('\n')
}

/** What an Inbox row says (`InboxNotification.room`), with the first line of its newest message. The messages it counts:
 * in a thread I follow every reply, elsewhere what mentions me, from the row's first notice to the newest message its
 * notices held back (while unread: from my place there on); at most COUNT_MAX of them. Its reason: one of them mentions
 * me by name, or "@전체", else a reply or a message. */
export function roomRowOut(db: Database, row: RoomRow): NonNullable<InboxNotification['room']> | null {
  const { group } = row, me = row.user_id
  const room = roomInfo(db, group.roomId, me)
  if (!room) return null
  const follow = group.place ? db.query('SELECT last_read_seq FROM room_thread_follows WHERE root_id = ? AND user_id = ?').get(group.place, me) as { last_read_seq: number } | null : null
  const all = !!group.place && !!follow
  const read = group.place ? (follow?.last_read_seq ?? 0) : Math.max(room.last_read_seq, room.visible_from_seq)
  const from = row.read_at ? group.from : Math.max(group.from, read + 1)
  const to = group.to
  const place = group.place ? 'm.thread_root_id = ?' : 'm.room_id = ? AND m.thread_root_id IS NULL'
  const where = `${place} AND m.seq >= ? AND m.seq <= ? AND ${FOR_ME_SQL}${all ? '' : ` AND ${MENTIONS_SQL}`}`
  const sees = room.history_from_seq ?? room.visible_from_seq
  const args = [group.place ?? group.roomId, from, to, sees, sees, me, me, me, ...(all ? [] : [me, me])]
  // the newest COUNT_MAX of them (one indexed walk down from the run's end), and the first (one step up from its start)
  const sum = db.query(`SELECT COUNT(*) n, COUNT(DISTINCT CASE WHEN author_kind = 'ai' THEN '' ELSE author_id END) people, MAX(seq) last, MAX(named) named, MAX(everyone) everyone
    FROM (SELECT m.seq, m.author_kind, m.author_id, EXISTS(SELECT 1 FROM json_each(m.mentions) j WHERE j.value = ?) named, m.mentions_all = 1 everyone
      FROM room_messages m WHERE ${where} ORDER BY m.seq DESC LIMIT ${COUNT_MAX})`)
    .get(me, ...args) as { n: number; people: number; last: number | null; named: number | null; everyone: number | null }
  const firstSeq = sum.last === null ? null : (db.query(`SELECT m.seq FROM room_messages m WHERE ${where} ORDER BY m.seq LIMIT 1`).get(...args) as { seq: number } | null)?.seq ?? null
  // nothing left to count (read meanwhile, or the run's messages gone): the row's own newest notice
  const at = (seq: number) => db.query(`SELECT ${MSG} FROM room_messages m WHERE m.room_id = ? AND m.seq = ?`).get(group.roomId, seq) as Msg
  const own = db.query(`SELECT ${MSG} FROM room_messages m WHERE m.id = ?`).get(row.source_id) as Msg
  const first = firstSeq !== null ? at(firstSeq) : own, newest = sum.last !== null ? at(sum.last) : own
  const line = messageLine(newest)
  const files = line ? 0 : (db.query('SELECT COUNT(*) n FROM room_files WHERE message_id = ?').get(newest.id) as { n: number }).n
  return {
    id: group.roomId, ...writer(db, newest), ...(group.place ? { thread: group.place } : {}),
    kind: room.kind, name: roomName(db, room),
    reason: sum.named ? 'mention' : sum.everyone ? 'everyone' : group.place ? 'reply' : 'message',
    message: first.id, preview: line, ...(files ? { files } : {}),
    count: Math.max(1, sum.n), people: Math.max(1, sum.people), at: newest.created_at,
  }
}

/** A single room notice, as a push opens it (GET /api/notifications/:id): who and where. `label` is the notification's
 * title on a device in the person's language ("민준 · #마케팅 › 스레드", a DM "민준"). `preview`, the message's first line
 * (the notification's body), only with `o.preview` (the person's messagePreview) and only for a message the whole room
 * sees; never for one with only files (''). null while the person may not read its message. */
export function roomNoticeOut(db: Database, notice: { id: string; user_id: string; event_type: string; source_id: string }, locale: Locale, o: { preview?: boolean } = {}): NonNullable<InboxNotification['room']> | null {
  const s = db.query(`SELECT ${MSG}, m.room_id, m.thread_root_id, m.thread_root_seq, m.visibility, m.visible_to, m.mentions, m.mentions_all FROM room_messages m WHERE m.id = ?`)
    .get(notice.source_id) as (Msg & { room_id: string; thread_root_id: string | null; thread_root_seq: number | null; visibility: string; visible_to: string | null; mentions: string; mentions_all: number }) | null
  const room = s && db.query(`SELECT r.kind, r.name, r.group_id, rm.last_read_seq, rm.visible_from_seq, rm.history_from_seq FROM rooms r JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = ?
    WHERE r.id = ? AND r.archived_at IS NULL AND rm.hidden_at IS NULL`).get(notice.user_id, s.room_id) as RoomInfo | null
  if (!s || !room || s.deleted_at || seenSeq(s) <= (room.history_from_seq ?? room.visible_from_seq) || (s.visibility !== 'room' && s.visible_to !== notice.user_id)
    || isHiddenFor(db, { id: s.id, room_id: s.room_id, thread_root_id: s.thread_root_id }, notice.user_id)) return null
  const who = writer(db, s), name = roomName(db, room)
  const reason = parseMentions(s.mentions).includes(notice.user_id) ? 'mention' as const : s.mentions_all && s.author_id !== notice.user_id ? 'everyone' as const : s.thread_root_id ? 'reply' as const : 'message' as const
  const line = o.preview && s.visibility === 'room' ? messageLine(s) : ''
  return {
    id: s.room_id, ...who, ...(s.thread_root_id ? { thread: s.thread_root_id } : {}), kind: room.kind, name, reason, message: s.id, count: 1, people: 1, at: s.created_at,
    ...(line ? { preview: line } : {}), seq: s.seq,
    label: roomLabel(db, { roomId: s.room_id, userId: notice.user_id, kind: room.kind, name, thread: !!s.thread_root_id, who: who.from ?? (who.ai ? ROOM_WORDS[locale].ai : null) }, locale),
  }
}

/** "민준 · #마케팅 › 스레드" (a DM: "민준"; the everyone room by its word, a group chat without a name by its people, as
 * the app names rooms: web lib/rooms.ts roomTitle), one plain line. */
export function roomLabel(db: Database, o: { roomId: string; userId: string; kind: RoomInfo['kind']; name: string | null; thread: boolean; who: string | null }, locale: Locale): string {
  const w = ROOM_WORDS[locale]
  if (o.kind === 'dm') return plainLabel(o.who ?? '', 120)
  let place = o.name
  if (!place && o.kind === 'all') place = w.all
  if (!place) {
    const peers = (db.query('SELECT u.name FROM room_members m JOIN users u ON u.id = m.user_id WHERE m.room_id = ? AND m.user_id <> ? ORDER BY m.joined_at, u.name LIMIT 4')
      .all(o.roomId, o.userId) as { name: string }[]).map((p) => plainLabel(p.name, 40))
    const total = (db.query('SELECT COUNT(*) n FROM room_members WHERE room_id = ? AND user_id <> ?').get(o.roomId, o.userId) as { n: number }).n
    const shown = peers.slice(0, 3)
    place = shown.length < total ? w.more(shown.join(w.sep), total - shown.length) : shown.join(w.sep)
  }
  const where = `${o.kind === 'team' ? '#' : ''}${place}${o.thread ? ` › ${w.thread}` : ''}`
  return plainLabel(o.who ? `${o.who} · ${where}` : where, 120)
}
