// ⌘K search of room messages (docs/DECISIONS.md "⌘K에서 대화방 메시지 찾기"): the messages a person would see by opening
// the room now, and nothing else.
//   which rooms     reader.ts myRooms: the rooms they are in now, not archived (what the rooms list holds; ones they hid
//                   too, as its "숨긴 대화"). Leaving or being taken out ends it at once: no member row, no candidate.
//   which messages  the rooms' one rule, decided in the query: store.ts SEE_MEMBER_SQL (SEE_SQL with the values of the
//                   member row of each message's room), so the page, its LIMIT and its cursor only ever count or name a
//                   message they see (an independent review found that filtering after the query let a cursor point at
//                   one they do not); then canSee, the same rule in code, on each. Where they see the room from (a later
//                   member of a group chat or a 1:1 from their join; a team room's or the everyone room's whole history
//                   once it is opened, Rooms.syncFor before a search), other people's private previews never, the old
//                   answers hidden from them and everything in their threads never. Deleted messages and event lines
//                   have no text and never match.
//   how it finds    room_messages_fts (migration 267, trigram, as the chat records' messages_fts): a phrase MATCH for 3
//                   or more characters, the trigram LIKE for 1–2 ("견적": a scan of the index's text); newest first by
//                   rowid, so a page stops as soon as it is full. Every candidate's own body is matched again with the
//                   chat records' rule (LIKE … ESCAPE: the text as one part, any case of A–Z): an index row out of step
//                   can never bring a message that does not hold the text.
//   how much        a page of at most ROOM_SEARCH_PAGE_MAX; its cursor goes on below its last hit. The index is walked
//                   past matches the person does not see (other rooms') until the page is full: a word common only in
//                   other rooms costs a longer walk (DECISIONS: known limits).
//   what it gives   the text around the first match of a message canSee let through, as messagesOut gives it to the
//                   room (one shown as withheld is dropped): never a quote, a file or a hidden answer's text.
import type { Database } from 'bun:sqlite'
import { ROOM_REF_RE, ROOM_SEARCH_PAGE_MAX, ROOM_SEARCH_SNIPPET_MAX, type RoomSearchHit, type RoomSearchPage, type RoomSearchRoom } from '@mycel/shared/api'
import { decodeCursor, encodeCursor } from '../chat/store'
import { fail } from '../http/errors'
import { myRooms, type Mine } from './reader'
import { canSee, messagesOut, MSG_COLS, roomNaming, SEE_MEMBER_SQL, type MessageRow } from './store'

/** hits a page gives by default */
export const ROOM_SEARCH_DEFAULT = 20
/** characters of the snippet before the match, at most */
const BEFORE = 60

const COLS = MSG_COLS.split(', ').map((c) => `m.${c}`).join(', ')
/** LIKE's own case rule (A–Z only), so the snippet finds what LIKE matched; the length never changes */
const fold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase())
const likeArg = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

export interface SearchInput { q: string; cursor?: string; limit?: number }

export function searchRoomMessages(db: Database, userId: string, o: SearchInput): RoomSearchPage {
  // (NUL ends an FTS5 query string; the contract refuses it, this keeps the function safe on its own)
  const q = o.q.replace(/\u0000/g, '').normalize('NFC').trim()
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
  // who sees what is decided here, on each message's own room's member row (SEE_MEMBER_SQL: SEE_SQL with that row's
  // values): the page, its LIMIT and the cursor below only ever count or name messages the person sees. CROSS JOIN keeps
  // SQLite on the index first, newest first: never a walk of the rooms' messages.
  const rows = db.query(`SELECT f.rowid AS r, ${COLS} FROM room_messages_fts f CROSS JOIN room_messages m ON m.rowid = f.rowid
    CROSS JOIN room_members mm ON mm.room_id = m.room_id AND mm.user_id = ?
    WHERE ${find} AND f.rowid < ? AND m.room_id IN (SELECT value FROM json_each(?)) AND m.deleted_at IS NULL AND m.event IS NULL
      AND ${SEE_MEMBER_SQL} AND m.body LIKE ? ESCAPE '\\' ORDER BY f.rowid DESC LIMIT ?`)
    .all(userId, findArg, cur ? Number(cur.r) : Number.MAX_SAFE_INTEGER, JSON.stringify([...mine.keys()]), likeArg(q), limit + 1) as (MessageRow & { r: number })[]
  const page = rows.slice(0, limit)
  // more: a hit past the page; the next page goes on below this page's last (a message they see)
  const nextCursor = rows.length > limit ? encodeCursor({ r: String(page.at(-1)!.r) }) : null
  // and canSee, the same rule in code, on each with its member row as the rooms read it (a second check)
  const kept: { row: MessageRow; mine: Mine }[] = []
  for (const { r: _r, ...row } of page) {
    const m = mine.get(row.room_id)
    if (m && canSee(db, row, m.me)) kept.push({ row, mine: m })
  }
  // each room's hits as its member sees them in the room
  const shown = new Map<string, RoomSearchHit>()
  const named: RoomSearchRoom[] = []
  for (const m of new Set(kept.map((h) => h.mine))) {
    for (const msg of messagesOut(db, kept.filter((h) => h.mine === m).map((h) => h.row), m.me)) {
      if (msg.withheld || msg.deletedAt || msg.event || !msg.body) continue
      shown.set(msg.id, {
        id: msg.id, roomId: msg.roomId, threadRootId: msg.threadRootId ?? null, authorKind: msg.authorKind,
        author: msg.authorKind === 'ai' ? null : msg.author, askedBy: msg.authorKind === 'ai' ? msg.askedBy : null,
        markdown: msg.authorKind === 'ai' || !!msg.sharedAnswer, snippet: snippetOf(msg.body, q), createdAt: msg.createdAt,
      })
    }
    named.push({ id: m.room.id, kind: m.room.kind, ...roomNaming(db, m.room, userId) })
  }
  const items = kept.map((h) => shown.get(h.row.id)).filter((x): x is RoomSearchHit => !!x)
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
