// ⌘K search of room messages (docs/DECISIONS.md "⌘K에서 대화방 메시지 찾기"): the messages a person would see by opening
// the room now, and nothing else.
//   which rooms     reader.ts myRooms: the rooms they are in now, not archived (what the rooms list holds; ones they hid
//                   too, as its "숨긴 대화"). Leaving or being taken out ends it at once: no member row, no candidate.
//   which messages  store.ts canSee for each candidate with the member row of its room, the rooms' one rule (SEE_SQL is
//                   the same in SQL): where they see the room from (a later member of a group chat or a 1:1 from their
//                   join; a team room's or the everyone room's whole history once it is opened, Rooms.syncFor before a
//                   search), other people's private previews never, the old answers hidden from them and everything in
//                   their threads never. Deleted messages and event lines have no text and never match.
//   how it finds    room_messages_fts (migration 267, trigram, as the chat records' messages_fts): a phrase MATCH for 3
//                   or more characters, the trigram LIKE for 1–2 ("견적": a scan of the index's text); newest first by
//                   rowid, so a page stops as soon as it is full. Every candidate's own body is matched again with the
//                   chat records' rule (LIKE … ESCAPE: the text as one part, any case of A–Z): an index row out of step
//                   can never bring a message that does not hold the text.
//   how much        a page of at most ROOM_SEARCH_PAGE_MAX; one request looks at SCAN_MAX candidates of the person's rooms
//                   at most, and its cursor goes on below the last one it looked at.
//   what it gives   the text around the first match of a message canSee let through, as messagesOut gives it to the
//                   room (one shown as withheld is dropped): never a quote, a file or a hidden answer's text.
import type { Database } from 'bun:sqlite'
import { ROOM_REF_RE, ROOM_SEARCH_PAGE_MAX, ROOM_SEARCH_SNIPPET_MAX, type RoomSearchHit, type RoomSearchPage, type RoomSearchRoom } from '@mycel/shared/api'
import { decodeCursor, encodeCursor } from '../chat/store'
import { fail } from '../http/errors'
import { myRooms, type Mine } from './reader'
import { canSee, messagesOut, MSG_COLS, roomNaming, type MessageRow } from './store'

/** hits a page gives by default */
export const ROOM_SEARCH_DEFAULT = 20
/** candidates (messages of the person's rooms that hold the text) one request looks at, at most */
export const SCAN_MAX = 2_000
/** candidates read at a time */
const BATCH = 200
/** characters of the snippet before the match, at most */
const BEFORE = 60

const COLS = MSG_COLS.split(', ').map((c) => `m.${c}`).join(', ')
/** LIKE's own case rule (A–Z only), so the snippet finds what LIKE matched; the length never changes */
const fold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase())
const likeArg = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

export interface SearchInput { q: string; cursor?: string; limit?: number }

export function searchRoomMessages(db: Database, userId: string, o: SearchInput): RoomSearchPage {
  const q = o.q.normalize('NFC').trim()
  const cur = decodeCursor(o.cursor, ['r'])
  if (o.cursor && (!cur || !/^\d{1,18}$/.test(cur.r))) fail('validation', undefined, { fields: { 'query.cursor': 'invalid cursor' } })
  const limit = Math.min(ROOM_SEARCH_PAGE_MAX, Math.max(1, o.limit ?? ROOM_SEARCH_DEFAULT))
  const mine = new Map(myRooms(db, userId).map((m) => [m.room.id, m]))
  if (!q || !mine.size) return { items: [], rooms: [], nextCursor: null }
  // 3 characters or more: the index's phrase (a quote inside doubled); fewer: the trigram LIKE (wildcards in it are
  // matched exactly by the check on the body)
  const phrase = [...q].length >= 3
  const find = phrase ? 'room_messages_fts MATCH ?' : 'f.body LIKE ?'
  const findArg = phrase ? `"${q.replace(/"/g, '""')}"` : `%${q}%`
  // CROSS JOIN keeps SQLite on the index first, newest first: never a walk of the rooms' messages
  const sql = `SELECT f.rowid AS r, ${COLS} FROM room_messages_fts f CROSS JOIN room_messages m ON m.rowid = f.rowid
    WHERE ${find} AND f.rowid < ? AND m.room_id IN (SELECT value FROM json_each(?)) AND m.deleted_at IS NULL AND m.event IS NULL
      AND m.body LIKE ? ESCAPE '\\' ORDER BY f.rowid DESC LIMIT ?`
  const rooms = JSON.stringify([...mine.keys()])
  const found: { r: number; row: MessageRow; mine: Mine }[] = []
  let below = cur ? Number(cur.r) : Number.MAX_SAFE_INTEGER
  let looked = 0
  let done = false
  while (found.length <= limit && looked < SCAN_MAX) {
    const want = Math.min(BATCH, SCAN_MAX - looked)
    const batch = db.query(sql).all(findArg, below, rooms, likeArg(q), want) as (MessageRow & { r: number })[]
    for (const { r, ...row } of batch) {
      looked++
      below = r
      const m = mine.get(row.room_id)!
      if (canSee(db, row, m.me)) found.push({ r, row, mine: m })
      if (found.length > limit) break
    }
    // fewer than asked: nothing more holds the text below here
    if (batch.length < want) { done = found.length <= limit; break }
  }
  const page = found.slice(0, limit)
  // more: a hit past the page, or candidates not looked at yet (the next page goes on below the last one looked at)
  const nextCursor = found.length > limit ? encodeCursor({ r: String(page.at(-1)!.r) }) : !done && looked > 0 ? encodeCursor({ r: String(below) }) : null
  // each room's hits as its member sees them in the room
  const shown = new Map<string, RoomSearchHit>()
  const named: RoomSearchRoom[] = []
  for (const m of new Set(page.map((h) => h.mine))) {
    for (const msg of messagesOut(db, page.filter((h) => h.mine === m).map((h) => h.row), m.me)) {
      if (msg.withheld || msg.deletedAt || msg.event || !msg.body) continue
      shown.set(msg.id, {
        id: msg.id, roomId: msg.roomId, threadRootId: msg.threadRootId ?? null, authorKind: msg.authorKind,
        author: msg.authorKind === 'ai' ? null : msg.author, askedBy: msg.authorKind === 'ai' ? msg.askedBy : null,
        markdown: msg.authorKind === 'ai' || !!msg.sharedAnswer, snippet: snippetOf(msg.body, q), createdAt: msg.createdAt,
      })
    }
    named.push({ id: m.room.id, kind: m.room.kind, ...roomNaming(db, m.room, userId) })
  }
  const items = page.map((h) => shown.get(h.row.id)).filter((x): x is RoomSearchHit => !!x)
  return { items, rooms: named.filter((r) => items.some((i) => i.roomId === r.id)), nextCursor }
}

/** The text around the first match, on one line: room links as "#name", at most ROOM_SEARCH_SNIPPET_MAX characters with
 * … where it is cut (BEFORE characters before the match at most). No match on the line (it spans a room link): the start. */
export function snippetOf(body: string, q: string): string {
  const flat = body.replace(new RegExp(ROOM_REF_RE.source, 'g'), (_, name: string) => `#${name}`).replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  const at = fold(flat).indexOf(fold(q.replace(/\s+/g, ' ')))
  const i = at < 0 ? 0 : Array.from(flat.slice(0, at)).length
  const room = ROOM_SEARCH_SNIPPET_MAX - 2
  let start = Math.max(0, i - BEFORE)
  const end = Math.min(chars.length, start + room)
  if (end - start < room) start = Math.max(0, end - room)
  return `${start > 0 ? '…' : ''}${chars.slice(start, end).join('')}${end < chars.length ? '…' : ''}`
}
