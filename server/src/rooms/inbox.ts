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
import { groupName, MENTIONS_SQL, parseMentions, seenSeq } from './store'

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
  AND COALESCE(m.thread_root_seq, m.seq) > rm.visible_from_seq AND (m.visibility = 'room' OR m.visible_to = n.user_id)`

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
interface Group { ids: string[]; roomId: string; place: string | null; from: number; to: number; mentions: string[] }
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
        mentions: g.filter((x) => x.event_type === 'room.mention').map((x) => x.source_id),
      },
    })
  }
  return out.sort((a, b) => (a.sort_at === b.sort_at ? (a.id < b.id ? 1 : -1) : a.sort_at < b.sort_at ? 1 : -1))
}

/** The row a notice belongs to (its id is any of the row's notices), for reading it. */
export function roomRowOf(db: Database, userId: string, noticeId: string, cutoff: string): RoomRow | null {
  return roomRows(db, userId, cutoff).find((r) => r.group.ids.includes(noticeId)) ?? null
}

type RoomInfo = { kind: 'team' | 'all' | 'dm' | 'group'; name: string | null; group_id: string | null; last_read_seq: number; visible_from_seq: number }
type Msg = { id: string; seq: number; author_kind: 'user' | 'ai'; author_id: string | null; body: string; created_at: string }
const MSG = 'm.id, m.seq, m.author_kind, m.author_id, m.body, m.created_at'
/** What counts in a row for `?` (the person), on room_messages `m`: a message for the whole room they see, not deleted,
 * not an event line, written by someone else, not an AI answer they asked for. Parameters: visible_from_seq ×2, person ×2. */
const FOR_ME_SQL = `m.seq > ? AND COALESCE(m.thread_root_seq, m.seq) > ? AND m.visibility = 'room' AND m.deleted_at IS NULL AND m.event IS NULL
  AND (m.author_id IS NULL OR m.author_id <> ?) AND (m.author_kind <> 'ai' OR m.asked_by IS NULL OR m.asked_by <> ?)`

const roomInfo = (db: Database, roomId: string, userId: string) => db.query(`SELECT r.kind, r.name, r.group_id, rm.last_read_seq, rm.visible_from_seq FROM rooms r
  JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = ? WHERE r.id = ?`).get(userId, roomId) as RoomInfo | null
const nameOf = (db: Database, userId: string | null) => userId ? (db.query('SELECT name FROM users WHERE id = ?').get(userId) as { name: string } | null)?.name ?? null : null
/** The room's own name, else its group's (null: a DM, or a group chat without one) */
const roomName = (db: Database, room: Pick<RoomInfo, 'kind' | 'name' | 'group_id'>) => {
  if (room.kind === 'dm') return null
  const name = room.name || groupName(db, room)
  return name ? plainLabel(name, NAME_MAX) : null
}
/** The strongest reason of these mention messages for the person: picked by name, or only "@전체". */
const mentionReason = (db: Database, ids: readonly string[], userId: string): 'mention' | 'everyone' | null => {
  if (!ids.length) return null
  const rows = db.query(`SELECT mentions FROM room_messages WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { mentions: string }[]
  return rows.some((r) => parseMentions(r.mentions).includes(userId)) ? 'mention' : 'everyone'
}
/** Who wrote a message, as the row says it */
const writer = (db: Database, m: Pick<Msg, 'author_kind' | 'author_id'>) => ({
  from: m.author_kind === 'ai' ? null : (() => { const n = nameOf(db, m.author_id); return n ? plainLabel(n, NAME_MAX) : null })(),
  fromId: m.author_kind === 'ai' ? null : m.author_id, ...(m.author_kind === 'ai' ? { ai: true as const } : {}),
})

/** What an Inbox row says (`InboxNotification.room`), with the first line of its newest message. The messages it counts:
 * in a thread I follow every reply, elsewhere what mentions me; while unread those after my place there (and from the
 * row's first notice on), once read those the row's notices stood for. */
export function roomRowOut(db: Database, row: RoomRow): NonNullable<InboxNotification['room']> | null {
  const { group } = row, me = row.user_id
  const room = roomInfo(db, group.roomId, me)
  if (!room) return null
  const follow = group.place ? db.query('SELECT last_read_seq FROM room_thread_follows WHERE root_id = ? AND user_id = ?').get(group.place, me) as { last_read_seq: number } | null : null
  const all = !!group.place && !!follow
  const read = group.place ? (follow?.last_read_seq ?? 0) : Math.max(room.last_read_seq, room.visible_from_seq)
  const from = row.read_at ? group.from : Math.max(group.from, read + 1)
  const to = row.read_at ? group.to : Number.MAX_SAFE_INTEGER
  const place = group.place ? 'm.thread_root_id = ?' : 'm.room_id = ? AND m.thread_root_id IS NULL'
  const where = `${place} AND m.seq >= ? AND m.seq <= ? AND ${FOR_ME_SQL}${all ? '' : ` AND ${MENTIONS_SQL}`}`
  const args = [group.place ?? group.roomId, from, to, room.visible_from_seq, room.visible_from_seq, me, me, ...(all ? [] : [me, me])]
  const sum = db.query(`SELECT COUNT(*) n, COUNT(DISTINCT CASE WHEN m.author_kind = 'ai' THEN '' ELSE m.author_id END) people, MIN(m.seq) first, MAX(m.seq) last FROM room_messages m WHERE ${where}`)
    .get(...args) as { n: number; people: number; first: number | null; last: number | null }
  // nothing left to count (read meanwhile, or the run's messages gone): the row's own newest notice
  const at = (seq: number) => db.query(`SELECT ${MSG} FROM room_messages m WHERE m.room_id = ? AND m.seq = ?`).get(group.roomId, seq) as Msg
  const own = db.query(`SELECT ${MSG} FROM room_messages m WHERE m.id = ?`).get(row.source_id) as Msg
  const first = sum.first !== null ? at(sum.first) : own, newest = sum.last !== null ? at(sum.last) : own
  const line = previewLine(newest.body)
  const files = line ? 0 : (db.query('SELECT COUNT(*) n FROM room_files WHERE message_id = ?').get(newest.id) as { n: number }).n
  return {
    id: group.roomId, ...writer(db, newest), ...(group.place ? { thread: group.place } : {}),
    kind: room.kind, name: roomName(db, room),
    reason: mentionReason(db, group.mentions, me) ?? (group.place ? 'reply' : 'message'),
    message: first.id, preview: line, ...(files ? { files } : {}),
    count: Math.max(1, sum.n), people: Math.max(1, sum.people), at: newest.created_at,
  }
}

/** A single room notice, as a push opens it (GET /api/notifications/:id): who and where, never the text. `label` is the
 * notification's title on a device in the person's language ("민준 · #마케팅 › 스레드", a DM "민준"). null while the
 * person may not read its message. */
export function roomNoticeOut(db: Database, notice: { id: string; user_id: string; event_type: string; source_id: string }, locale: Locale): NonNullable<InboxNotification['room']> | null {
  const s = db.query(`SELECT ${MSG}, m.room_id, m.thread_root_id, m.thread_root_seq, m.visibility, m.visible_to, m.deleted_at, m.mentions FROM room_messages m WHERE m.id = ?`)
    .get(notice.source_id) as (Msg & { room_id: string; thread_root_id: string | null; thread_root_seq: number | null; visibility: string; visible_to: string | null; deleted_at: string | null; mentions: string }) | null
  const room = s && db.query(`SELECT r.kind, r.name, r.group_id, rm.last_read_seq, rm.visible_from_seq FROM rooms r JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = ?
    WHERE r.id = ? AND r.archived_at IS NULL`).get(notice.user_id, s.room_id) as RoomInfo | null
  if (!s || !room || s.deleted_at || seenSeq(s) <= room.visible_from_seq || (s.visibility !== 'room' && s.visible_to !== notice.user_id)) return null
  const who = writer(db, s), name = roomName(db, room)
  const reason = notice.event_type === 'room.mention' ? (parseMentions(s.mentions).includes(notice.user_id) ? 'mention' as const : 'everyone' as const) : s.thread_root_id ? 'reply' as const : 'message' as const
  return {
    id: s.room_id, ...who, ...(s.thread_root_id ? { thread: s.thread_root_id } : {}), kind: room.kind, name, reason, message: s.id, count: 1, people: 1, at: s.created_at,
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
