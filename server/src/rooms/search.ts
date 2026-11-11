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
//   how it finds    every word of the text, in any order (shared/src/search-text.ts searchWords: "견적서 보내" finds
//                   "견적서를 보내드렸어요"). room_messages_fts (migration 267, trigram, as the chat records'
//                   messages_fts): one MATCH of the words of 3 or more characters, each a phrase; when there is none,
//                   the trigram LIKE with the longest word ("견적": a scan of the index's text); newest first by rowid,
//                   so a page stops as soon as it is full. Every candidate's own body is matched again on every word with
//                   the chat records' rule (LIKE … ESCAPE: any case of A–Z, % and _ as themselves): an index row out of
//                   step can never bring a message that does not hold them.
//   how much        a page of at most ROOM_SEARCH_PAGE_MAX; its cursor goes on below its last hit. The index is walked
//                   past matches the person does not see (other rooms') until the page is full: a word common only in
//                   other rooms costs a longer walk (DECISIONS: known limits).
//   what it gives   the text around the first word found in a message canSee let through, as messagesOut gives it to the
//                   room (one shown as withheld is dropped): never a quote, a file or a hidden answer's text.
// And the files sent in those rooms, by name (searchRoomFiles): a file only with the message it was sent with, by the same
// rule. Only files of a sent message (an upload not sent yet never) of the same room, not deleted, not an event line;
// who sees the message decided in the query (SEE_MEMBER_SQL), then canSee, then messagesOut: the message must come out
// not withheld (so never an answer hidden from them, one shared from someone's own AI chat with its files included, nor
// anything in its thread) and the file must be among its files. Every word of the text in the name (LIKE … ESCAPE, any
// case of A–Z; names are stored NFC). No index: room_files has one row per file sent, far fewer than messages; it is read
// newest first by rowid (when the file was uploaded, moments before it was sent: no sort, and a page stops as soon as it
// is full; a word no name holds reads every name once), each candidate's message found by its key
// (tests/unit/b-rooms-file-search.test.ts times 20,000). The cursor is below the page's last hit (a file they see).
import type { Database } from 'bun:sqlite'
import { searchWords } from '@mycel/shared'
import { ROOM_REF_RE, ROOM_SEARCH_PAGE_MAX, ROOM_SEARCH_SNIPPET_MAX, type RoomFileSearchHit, type RoomFileSearchPage, type RoomMessage, type RoomSearchHit, type RoomSearchPage, type RoomSearchRoom } from '@mycel/shared/api'
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
  const words = searchWords(q)
  if (!words.length || !mine.size) return { items: [], rooms: [], nextCursor: null }
  // the words of 3 characters or more: one MATCH, each a phrase (a quote inside doubled), all of them; none: the
  // trigram LIKE with the longest word (wildcards in it are matched exactly by the check on the body)
  const long = words.filter((w) => [...w].length >= 3)
  const find = long.length ? 'room_messages_fts MATCH ?' : 'f.body LIKE ?'
  const findArg = long.length ? long.map((w) => `"${w.replace(/"/g, '""')}"`).join(' AND ') : `%${words.reduce((a, b) => ([...b].length > [...a].length ? b : a))}%`
  // who sees what is decided here, on each message's own room's member row (SEE_MEMBER_SQL: SEE_SQL with that row's
  // values): the page, its LIMIT and the cursor below only ever count or name messages the person sees. CROSS JOIN keeps
  // SQLite on the index first, newest first: never a walk of the rooms' messages.
  const rows = db.query(`SELECT f.rowid AS r, ${COLS} FROM room_messages_fts f CROSS JOIN room_messages m ON m.rowid = f.rowid
    CROSS JOIN room_members mm ON mm.room_id = m.room_id AND mm.user_id = ?
    WHERE ${find} AND f.rowid < ? AND m.room_id IN (SELECT value FROM json_each(?)) AND m.deleted_at IS NULL AND m.event IS NULL
      AND ${SEE_MEMBER_SQL} AND ${words.map(() => "m.body LIKE ? ESCAPE '\\'").join(' AND ')} ORDER BY f.rowid DESC LIMIT ?`)
    .all(userId, findArg, cur ? Number(cur.r) : Number.MAX_SAFE_INTEGER, JSON.stringify([...mine.keys()]), ...words.map(likeArg), limit + 1) as (MessageRow & { r: number })[]
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
        markdown: msg.authorKind === 'ai' || !!msg.sharedAnswer, snippet: snippetOf(msg.body, words), createdAt: msg.createdAt,
      })
    }
    named.push({ id: m.room.id, kind: m.room.kind, ...roomNaming(db, m.room, userId) })
  }
  const items = kept.map((h) => shown.get(h.row.id)).filter((x): x is RoomSearchHit => !!x)
  return { items, rooms: named.filter((r) => items.some((i) => i.roomId === r.id)), nextCursor }
}

/** The room files query for `words` words (parameters: the person, their rooms as JSON, each word's LIKE, the cursor's
 * file rowid when `after`, the LIMIT). CROSS JOIN keeps SQLite on room_files, newest first by rowid: no sort, and a page
 * stops when it is full (a plain JOIN walked every message of the person's rooms and sorted: seconds on a million
 * messages, the independent review measured). Exported for the test that reads its plan. */
export const roomFilesSql = (words: number, after: boolean) => `SELECT f.rowid AS fr, f.id AS file_id, ${COLS} FROM room_files f
    CROSS JOIN room_messages m ON m.id = f.message_id AND m.room_id = f.room_id
    CROSS JOIN room_members mm ON mm.room_id = m.room_id AND mm.user_id = ?
    WHERE f.message_id IS NOT NULL AND f.room_id IN (SELECT value FROM json_each(?)) AND m.deleted_at IS NULL AND m.event IS NULL
      AND ${SEE_MEMBER_SQL} AND ${Array.from({ length: words }, () => "f.name LIKE ? ESCAPE '\\'").join(' AND ')}${after ? ' AND f.rowid < ?' : ''} ORDER BY f.rowid DESC LIMIT ?`

export function searchRoomFiles(db: Database, userId: string, o: SearchInput): RoomFileSearchPage {
  const words = searchWords(o.q.replace(/\u0000/g, ''))
  const cur = decodeCursor(o.cursor, ['f'])
  if (o.cursor && (!cur || !/^\d{1,18}$/.test(cur.f))) fail('validation', undefined, { fields: { 'query.cursor': 'invalid cursor' } })
  const limit = Math.min(ROOM_SEARCH_PAGE_MAX, Math.max(1, o.limit ?? ROOM_SEARCH_DEFAULT))
  const mine = new Map(myRooms(db, userId).map((m) => [m.room.id, m]))
  if (!words.length || !mine.size) return { items: [], rooms: [], nextCursor: null }
  // who sees the message is decided in the query, as for a message found by its text (SEE_MEMBER_SQL on its room's
  // member row)
  const rows = db.query(roomFilesSql(words.length, !!cur))
    .all(userId, JSON.stringify([...mine.keys()]), ...words.map(likeArg), ...(cur ? [Number(cur.f)] : []), limit + 1) as (MessageRow & { fr: number; file_id: string })[]
  const page = rows.slice(0, limit)
  // more: a hit past the page; the next page goes on below this page's last row of the query (a file they see), not
  // the last one kept below
  const last = page.at(-1)
  const nextCursor = rows.length > limit && last ? encodeCursor({ f: String(last.fr) }) : null
  // canSee on each (a second check), then each room's messages as its member sees them in the room
  const kept = page.filter((h) => { const m = mine.get(h.room_id); return !!m && canSee(db, h, m.me) })
  const shown = new Map<string, RoomMessage>()
  for (const roomId of new Set(kept.map((h) => h.room_id))) {
    const m = mine.get(roomId)!
    const msgs = [...new Map(kept.filter((h) => h.room_id === roomId).map(({ fr: _fr, file_id: _f, ...row }) => [row.id, row as MessageRow])).values()]
    for (const msg of messagesOut(db, msgs, m.me)) shown.set(msg.id, msg)
  }
  const items: RoomFileSearchHit[] = []
  for (const h of kept) {
    const msg = shown.get(h.id)
    const file = msg && !msg.withheld && !msg.deletedAt && !msg.event ? msg.files.find((f) => f.id === h.file_id) : undefined
    if (!msg || !file) continue
    items.push({ file, messageId: msg.id, roomId: msg.roomId, threadRootId: msg.threadRootId ?? null, author: msg.authorKind === 'ai' ? null : msg.author, createdAt: msg.createdAt })
  }
  const rooms: RoomSearchRoom[] = [...new Set(items.map((i) => i.roomId))].map((id) => { const m = mine.get(id)!; return { id, kind: m.room.kind, ...roomNaming(db, m.room, userId) } })
  return { items, rooms, nextCursor }
}

/** The text around the first match (the word found first, `q` a word or the words), on one line: room links as
 * "#name", at most ROOM_SEARCH_SNIPPET_MAX characters with … where it is cut (BEFORE characters before the match at
 * most). No match on the line (it spans a room link): the start. */
export function snippetOf(body: string, q: string | readonly string[]): string {
  const flat = body.replace(new RegExp(ROOM_REF_RE.source, 'g'), (_, name: string) => `#${name}`).replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  const folded = fold(flat)
  const found = (typeof q === 'string' ? [q.replace(/\s+/g, ' ')] : q).map((w) => folded.indexOf(fold(w))).filter((x) => x >= 0)
  const i = found.length ? Array.from(flat.slice(0, Math.min(...found))).length : 0
  const room = ROOM_SEARCH_SNIPPET_MAX - 2
  let start = Math.max(0, i - BEFORE)
  const end = Math.min(chars.length, start + room)
  if (end - start < room) start = Math.max(0, end - room)
  return `${start > 0 ? '…' : ''}${chars.slice(start, end).join('')}${end < chars.length ? '…' : ''}`
}
