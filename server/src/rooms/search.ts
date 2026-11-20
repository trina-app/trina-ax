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
// who sees the message decided in the query (SEE_MEMBER_SQL), then canSee, then messagesOut's own withheld rule
// (hiddenAmong: never an answer hidden from them, one shared from someone's own AI chat with its files included, nor
// anything in its thread); the file is given as the room gives it (fileOut), still sent with that message. Every word
// of the text in the name (LIKE … ESCAPE, any case of A–Z; names are stored NFC). No index: room_files has one row per file sent, far fewer than messages; it is read
// newest first by rowid (when the file was uploaded, moments before it was sent: no sort, and a page stops as soon as it
// is full; a word no name holds reads every name once), each candidate's message found by its key
// (tests/unit/b-rooms-file-search.test.ts times 20,000). The cursor is below the page's last hit (a file they see).
import type { Database } from 'bun:sqlite'
import { nameMatch, nearBudget, nearMatch, parseSearch, particleNext, type SearchParts } from '@mycel/shared'
import { ROOM_REF_RE, ROOM_SEARCH_PAGE_MAX, ROOM_SEARCH_SNIPPET_MAX, type MyRoomFilesPage, type RoomFileSearchHit, type RoomFileSearchPage, type RoomSearchFilters, type RoomSearchHit, type RoomSearchPage, type RoomSearchRoom, type RoomSearchSort, type UserRef } from '@mycel/shared/api'
import { decodeCursor, encodeCursor } from '../chat/store'
import { fail } from '../http/errors'
import { reachFilter } from '../auth/guests'
import { myRooms, ROOM_EVERYONE_WORDS, titleOf, type Mine } from './reader'
import { unescapeMarkdown } from './apps/card'
import { canSee, fileOut, hiddenAmong, messagesOut, MSG_COLS, refsOf, roomNaming, SEE_MEMBER_SQL, type FileRow, type MessageRow } from './store'

/** hits a page gives by default */
export const ROOM_SEARCH_DEFAULT = 20
/** characters of the snippet before the match, at most */
const BEFORE = 60

const COLS = MSG_COLS.split(', ').map((c) => `m.${c}`).join(', ')
/** LIKE's own case rule (A–Z only), so the snippet finds what LIKE matched; the length never changes */
const fold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase())
const likeArg = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

export interface SearchInput { q: string; cursor?: string; limit?: number; sort?: RoomSearchSort }

/** "Best match" ranks this many of the newest matches a person sees (bounded: a page never sorts a whole room's
 * history); past them the pages go on newest first */
export const RELEVANT_POOL = 300
/** a near match (typing mistakes) looks at this many candidates of the index, the most alike first */
const NEAR_POOL = 2000

/** The people `from:` names: "me"; a username or a name, exactly (any case); else every person whose name or username
 * holds it (nameMatch: Korean initials too). At most 50. Only people the searcher may see (guests.ts reachFilter: a
 * guest only the people of their places, a member no guest outside theirs), and of the accounts no longer in use only
 * those still in one of the searcher's rooms: anyone else reads as a name nobody has (no list of the team through it). */
function fromPeople(db: Database, userId: string, v: string, roomIds: string): UserRef[] {
  if (v.toLowerCase() === 'me' || v === '나') return db.query('SELECT id, name FROM users WHERE id = ?').all(userId) as UserRef[]
  const reach = reachFilter(db, userId)
  const all = (db.query(`SELECT id, username, name FROM users u WHERE (u.status = 'active' AND u.deleted_at IS NULL)
      OR EXISTS (SELECT 1 FROM room_members rm WHERE rm.user_id = u.id AND rm.room_id IN (SELECT value FROM json_each(?))) ORDER BY name, id`)
    .all(roomIds) as { id: string; username: string; name: string }[]).filter((u) => reach(u.id))
  const low = v.toLowerCase().replace(/\s+/g, ' ')
  const exact = all.filter((u) => u.username.toLowerCase() === low || u.name.toLowerCase().replace(/\s+/g, ' ') === low)
  const some = exact.length ? exact : all.filter((u) => u.username.toLowerCase().includes(low) || nameMatch(u.name, v) !== null)
  return some.slice(0, 50).map((u) => ({ id: u.id, name: u.name }))
}

/** The rooms of mine `in:` names: by the name the app shows (roomNaming: a 1:1 chat is the other person, by name or
 * username), exactly first, else every room whose name holds it; "everyone" and its words for the everyone room. */
type Named = { m: Mine; names: string[] }
/** Each of my rooms with the names in: matches it by, read once per search */
function roomNames(db: Database, userId: string, mine: Map<string, Mine>): Named[] {
  const usernames = new Map((db.query('SELECT id, username FROM users').all() as { id: string; username: string }[]).map((u) => [u.id, u.username]))
  return [...mine.values()].map((m) => {
    const n = roomNaming(db, m.room, userId)
    const names = m.room.kind === 'dm'
      ? n.peers.flatMap((p) => [p.name, usernames.get(p.id) ?? ''])
      : m.room.kind === 'all' ? [n.name ?? '', ...ROOM_EVERYONE_WORDS] : [n.name ?? titleOf({ kind: m.room.kind, ...n })]
    return { m, names: names.filter(Boolean) }
  })
}
function inRooms(named: Named[], v: string): Mine[] {
  const low = v.toLowerCase().replace(/\s+/g, ' ')
  const exact = named.filter((x) => x.names.some((n) => n.toLowerCase().replace(/\s+/g, ' ') === low))
  return (exact.length ? exact : named.filter((x) => x.names.some((n) => nameMatch(n, v) !== null))).map((x) => x.m)
}

/** How well a message matches, for "best match": the whole text in that order (a phrase, the words together: 4), each
 * word as a whole word (2; a Korean particle after it counts as its end) and as typed (1), a short message over a long
 * one (up to 0.5), and how recent it is (up to 1, halved in a month): a whole word from April above a part of a word
 * from yesterday ("회의" finds "내일 회의 10시" before "회의실 예약"). */
export function matchScore(body: string, parts: SearchParts, createdAt: string, now = Date.now()): number {
  const b = fold(body)
  let s = 0
  const whole = fold(parts.words.join(' '))
  if (parts.words.length > 1 && b.includes(whole)) s += 4
  parts.words.forEach((w, i) => {
    const f = fold(w), t = fold(parts.terms[i]!)
    if (b.includes(f)) s += 1
    // as a word of its own (a Korean particle after it counts as its end)
    const at = b.indexOf(t)
    if (at >= 0) {
      const before = at === 0 ? '' : b[at - 1]!, after = b.slice(at + t.length)
      if (!/[\p{L}\p{N}]/u.test(before) && (!after || /^[^\p{L}\p{N}]/u.test(after) || (HANGUL.test(t) && particleNext(after)))) s += 2
    }
  })
  s += 0.5 / (1 + [...body].length / 200)
  const days = Math.max(0, (now - Date.parse(createdAt)) / 86_400_000)
  return s + 1 / (1 + days / 30)
}
const HANGUL = /[가-힣]$/u

export function searchRoomMessages(db: Database, userId: string, o: SearchInput): RoomSearchPage {
  const parts = parseSearch(o.q)
  const sort: RoomSearchSort = o.sort ?? 'recent'
  // a cursor: {r} below a message (newest first), or {o, t, n} a place in a "best match" order, with that order's pool
  // (its newest message t) and time n, so every page of it ranks the same messages the same way
  const cur = decodeCursor(o.cursor, ['r']) ?? decodeCursor(o.cursor, ['o', 't', 'n'])
  const bad = !!o.cursor && (!cur || ('r' in cur ? !/^\d{1,18}$/.test(cur.r)
    : sort !== 'relevant' || !/^\d{1,4}$/.test((cur as { o: string }).o) || !/^\d{1,18}$/.test((cur as { t: string }).t) || !/^\d{1,15}$/.test((cur as { n: string }).n)))
  if (bad) fail('validation', undefined, { fields: { 'query.cursor': 'invalid cursor' } })
  const limit = Math.min(ROOM_SEARCH_PAGE_MAX, Math.max(1, o.limit ?? ROOM_SEARCH_DEFAULT))
  const mine = new Map(myRooms(db, userId).map((m) => [m.room.id, m]))
  const f = resolveFilters(db, userId, mine, parts)
  const empty: RoomSearchPage = { items: [], rooms: [], nextCursor: null, ...(f.out ? { filters: f.out } : {}) }
  if ((!parts.terms.length && !f.filtered) || !f.rooms.length || f.authors?.length === 0) return empty
  const q = candidates(parts, f)
  const before = cur && 'r' in cur ? Number(cur.r) : Number.MAX_SAFE_INTEGER
  let page: (MessageRow & { r: number })[]
  let nextCursor: string | null = null
  let near = false
  if (sort === 'relevant' && !(cur && 'r' in cur)) {
    // the newest RELEVANT_POOL matches they see, best first; the cursor is a place in that order, then (past the pool)
    // the newest first below its oldest
    const placed = cur && 'o' in cur ? (cur as { o: string; t: string; n: string }) : null
    const pool = q.rows(db, placed ? Number(placed.t) + 1 : Number.MAX_SAFE_INTEGER, RELEVANT_POOL)
    const now = placed ? Number(placed.n) : Date.now()
    const ranked = pool.map((row) => ({ row, s: matchScore(row.body, parts, row.created_at, now) })).sort((a, b) => b.s - a.s || b.row.r - a.row.r).map((x) => x.row)
    const at = placed ? Number(placed.o) : 0
    page = ranked.slice(at, at + limit)
    if (at + limit < ranked.length) nextCursor = encodeCursor({ o: String(at + limit), t: placed?.t ?? String(Math.max(...pool.map((x) => x.r))), n: String(now) })
    else if (pool.length === RELEVANT_POOL) nextCursor = encodeCursor({ r: String(Math.min(...pool.map((x) => x.r))) })
  } else {
    const rows = q.rows(db, before, limit + 1)
    page = rows.slice(0, limit)
    // more: a hit past the page; the next page goes on below this page's last (a message they see)
    nextCursor = rows.length > limit ? encodeCursor({ r: String(page.at(-1)!.r) }) : null
  }
  // nothing: a near match, once (the first page), for words of four letters or more (typing mistakes)
  if (!page.length && !cur && parts.terms.some((t, i) => !parts.phrases[i] && nearBudget(t) > 0)) {
    page = nearRows(db, parts, f).slice(0, limit)
    near = page.length > 0
  }
  // and canSee, the same rule in code, on each with its member row as the rooms read it (a second check)
  const kept: { row: MessageRow; mine: Mine }[] = []
  for (const { r: _r, ...row } of page) {
    const m = mine.get(row.room_id)
    if (m && canSee(db, row, m.me)) kept.push({ row, mine: m })
  }
  // each room's hits as its member sees them in the room
  const shown = new Map<string, RoomSearchHit>()
  const named: RoomSearchRoom[] = []
  const marks = near ? parts.words : parts.terms
  for (const m of new Set(kept.map((h) => h.mine))) {
    for (const msg of messagesOut(db, kept.filter((h) => h.mine === m).map((h) => h.row), m.me, false)) {
      if (msg.withheld || msg.deletedAt || msg.event || !msg.body) continue
      shown.set(msg.id, {
        id: msg.id, roomId: msg.roomId, threadRootId: msg.threadRootId ?? null, authorKind: msg.authorKind,
        author: msg.authorKind === 'ai' ? null : msg.author, askedBy: msg.authorKind === 'ai' ? msg.askedBy : null,
        markdown: msg.authorKind === 'ai' || !!msg.sharedAnswer, snippet: snippetOf(msg.app ? unescapeMarkdown(msg.body) : msg.body, marks), createdAt: msg.createdAt,
        ...(msg.app ? { app: msg.app } : {}),
      })
    }
    named.push({ id: m.room.id, kind: m.room.kind, ...roomNaming(db, m.room, userId) })
  }
  const items = kept.map((h) => shown.get(h.row.id)).filter((x): x is RoomSearchHit => !!x)
  return { items, rooms: named.filter((r) => items.some((i) => i.roomId === r.id)), nextCursor: near ? null : nextCursor, ...(near ? { near: true } : {}), ...(f.out ? { filters: f.out } : {}) }
}

interface Filters {
  /** the rooms searched: mine, or those in: names */
  rooms: Mine[]
  /** from: the authors (null: anyone; empty: nobody of that name) */
  authors: string[] | null
  filtered: boolean
  /** what the filters were read as (for the app to say it) */
  out: RoomSearchFilters | null
  userId: string
}
function resolveFilters(db: Database, userId: string, mine: Map<string, Mine>, parts: SearchParts): Filters {
  if (!parts.from.length && !parts.in.length) return { rooms: [...mine.values()], authors: null, filtered: false, out: null, userId }
  const missing: string[] = []
  let authors: UserRef[] | null = null
  if (parts.from.length) {
    const found = new Map<string, UserRef>()
    const ids = JSON.stringify([...mine.keys()])
    for (const v of parts.from) { const p = fromPeople(db, userId, v, ids); if (!p.length) missing.push(`from:${v}`); for (const x of p) found.set(x.id, x) }
    authors = [...found.values()]
  }
  let rooms = [...mine.values()]
  if (parts.in.length) {
    const found = new Map<string, Mine>()
    const named = roomNames(db, userId, mine)
    for (const v of parts.in) { const r = inRooms(named, v); if (!r.length) missing.push(`in:${v}`); for (const x of r) found.set(x.room.id, x) }
    rooms = [...found.values()]
  }
  return {
    rooms, authors: authors ? authors.map((a) => a.id) : null, filtered: true, userId,
    out: { from: (authors ?? []).slice(0, 10), in: parts.in.length ? rooms.slice(0, 10).map((m) => ({ id: m.room.id, kind: m.room.kind, ...roomNaming(db, m.room, userId) })) : [], missing },
  }
}

/** The candidates' query: who sees what decided in it (SEE_MEMBER_SQL on each message's own room's member row), so a
 * page, its LIMIT and a cursor only ever count or name messages the person sees. Every term matched again on the body
 * (LIKE … ESCAPE: any case of A–Z, % and _ as themselves): an index row out of step can never bring a message without
 * them. Newest first by rowid, so a page stops as soon as it is full. */
function candidates(parts: SearchParts, f: Filters) {
  const terms = parts.terms
  // the terms of 3 characters or more: one MATCH, each a phrase (a quote inside doubled), all of them; none: the trigram
  // LIKE with the longest term; no term (filters only): the rooms' messages themselves
  const long = terms.filter((w) => [...w].length >= 3)
  const roomIds = JSON.stringify(f.rooms.map((m) => m.room.id))
  const who = f.authors ? ` AND m.author_kind = 'user' AND m.author_id IN (${f.authors.map(() => '?').join(',')})` : ''
  const check = terms.map(() => " AND m.body LIKE ? ESCAPE '\\'").join('')
  if (!terms.length) {
    const sql = `SELECT m.rowid AS r, ${COLS} FROM room_messages m CROSS JOIN room_members mm ON mm.room_id = m.room_id AND mm.user_id = ?
      WHERE m.rowid < ? AND m.room_id IN (SELECT value FROM json_each(?)) AND m.deleted_at IS NULL AND m.event IS NULL AND m.body <> ''
        AND ${SEE_MEMBER_SQL}${who} ORDER BY m.rowid DESC LIMIT ?`
    return { rows: (db: Database, before: number, n: number) => db.query(sql).all(f.userId, before, roomIds, ...(f.authors ?? []), n) as (MessageRow & { r: number })[] }
  }
  const find = long.length ? 'room_messages_fts MATCH ?' : 'f.body LIKE ?'
  const findArg = long.length ? long.map(ftsPhrase).join(' AND ') : `%${terms.reduce((a, b) => ([...b].length > [...a].length ? b : a))}%`
  // CROSS JOIN keeps SQLite on the index first, newest first: never a walk of the rooms' messages
  const sql = `SELECT f.rowid AS r, ${COLS} FROM room_messages_fts f CROSS JOIN room_messages m ON m.rowid = f.rowid
    CROSS JOIN room_members mm ON mm.room_id = m.room_id AND mm.user_id = ?
    WHERE ${find} AND f.rowid < ? AND m.room_id IN (SELECT value FROM json_each(?)) AND m.deleted_at IS NULL AND m.event IS NULL
      AND ${SEE_MEMBER_SQL}${who}${check} ORDER BY f.rowid DESC LIMIT ?`
  return { rows: (db: Database, before: number, n: number) => db.query(sql).all(f.userId, findArg, before, roomIds, ...(f.authors ?? []), ...terms.map(likeArg), n) as (MessageRow & { r: number })[] }
}
const ftsPhrase = (w: string) => `"${w.replace(/"/g, '""')}"`

/** Near matches (nothing matched as typed): the index's rows that share the most three-letter pieces with the words (its
 * own rank, NEAR_POOL of them, who sees them decided in the query as above), each word then in the text as typed or with
 * at most nearBudget typing mistakes (nearMatch), newest first. */
function nearRows(db: Database, parts: SearchParts, f: Filters): (MessageRow & { r: number })[] {
  const grams = new Set<string>()
  for (const t of parts.terms) { const c = [...fold(t)]; for (let i = 0; i + 3 <= c.length; i++) grams.add(c.slice(i, i + 3).join('')) }
  if (!grams.size) return []
  const roomIds = JSON.stringify(f.rooms.map((m) => m.room.id))
  const who = f.authors ? ` AND m.author_kind = 'user' AND m.author_id IN (${f.authors.map(() => '?').join(',')})` : ''
  // the index ranks its own rows first (NEAR_POOL, the most alike), then who sees them is decided on those
  const rows = db.query(`SELECT c.rowid AS r, ${COLS} FROM (SELECT rowid FROM room_messages_fts WHERE room_messages_fts MATCH ? ORDER BY rank LIMIT ?) c
    CROSS JOIN room_messages m ON m.rowid = c.rowid
    CROSS JOIN room_members mm ON mm.room_id = m.room_id AND mm.user_id = ?
    WHERE m.room_id IN (SELECT value FROM json_each(?)) AND m.deleted_at IS NULL AND m.event IS NULL
      AND ${SEE_MEMBER_SQL}${who}`)
    .all([...grams].map(ftsPhrase).join(' OR '), NEAR_POOL, f.userId, roomIds, ...(f.authors ?? [])) as (MessageRow & { r: number })[]
  return rows.filter((row) => parts.terms.every((t, i) => fold(row.body).includes(fold(t)) || (!parts.phrases[i] && (nearMatch(row.body, parts.words[i]!) || nearMatch(row.body, t)))))
    .sort((a, b) => b.r - a.r)
}

/** The room files query for `words` terms (parameters: the person, the rooms searched as JSON, each author when
 * `authors`, each term's LIKE, the cursor's file rowid when `after`, the LIMIT). CROSS JOIN keeps SQLite on room_files,
 * newest first by rowid: no sort, and a page stops when it is full (a plain JOIN walked every message of the person's
 * rooms and sorted: seconds on a million messages, the independent review measured). Exported for the test that reads
 * its plan. */
export const roomFilesSql = (words: number, after: boolean, authors = 0) => `SELECT f.rowid AS fr, f.id AS file_id, ${COLS} FROM room_files f
    CROSS JOIN room_messages m ON m.id = f.message_id AND m.room_id = f.room_id
    CROSS JOIN room_members mm ON mm.room_id = m.room_id AND mm.user_id = ?
    WHERE f.message_id IS NOT NULL AND f.room_id IN (SELECT value FROM json_each(?)) AND m.deleted_at IS NULL AND m.event IS NULL
      AND ${SEE_MEMBER_SQL}${authors ? ` AND m.author_kind = 'user' AND m.author_id IN (${Array.from({ length: authors }, () => '?').join(',')})` : ''}${Array.from({ length: words }, () => " AND f.name LIKE ? ESCAPE '\\'").join('')}${after ? ' AND f.rowid < ?' : ''} ORDER BY f.rowid DESC LIMIT ?`

/** Files sent in my rooms by name: every term of the text (parseSearch: a word without its particle or ending, a
 * quoted phrase as it is), in the rooms in: names and sent by the people from: names, when the text has them (only
 * filters: every file of those rooms or people). */
export function searchRoomFiles(db: Database, userId: string, o: SearchInput): RoomFileSearchPage {
  const parts = parseSearch(o.q)
  const cur = decodeCursor(o.cursor, ['f'])
  if (o.cursor && (!cur || !/^\d{1,18}$/.test(cur.f))) fail('validation', undefined, { fields: { 'query.cursor': 'invalid cursor' } })
  const limit = Math.min(ROOM_SEARCH_PAGE_MAX, Math.max(1, o.limit ?? ROOM_SEARCH_DEFAULT))
  const mine = new Map(myRooms(db, userId).map((m) => [m.room.id, m]))
  const f = resolveFilters(db, userId, mine, parts)
  const empty: RoomFileSearchPage = { items: [], rooms: [], nextCursor: null, ...(f.out ? { filters: f.out } : {}) }
  if ((!parts.terms.length && !f.filtered) || !f.rooms.length || f.authors?.length === 0) return empty
  // who sees the message is decided in the query, as for a message found by its text (SEE_MEMBER_SQL on its room's
  // member row)
  const rows = db.query(roomFilesSql(parts.terms.length, !!cur, f.authors?.length ?? 0))
    .all(userId, JSON.stringify(f.rooms.map((m) => m.room.id)), ...(f.authors ?? []), ...parts.terms.map(likeArg), ...(cur ? [Number(cur.f)] : []), limit + 1) as (MessageRow & { fr: number; file_id: string })[]
  const page = rows.slice(0, limit)
  // more: a hit past the page; the next page goes on below this page's last row of the query (a file they see), not
  // the last one kept below
  const last = page.at(-1)
  const nextCursor = rows.length > limit && last ? encodeCursor({ f: String(last.fr) }) : null
  return { ...fileHits(db, userId, mine, page), nextCursor, ...(f.out ? { filters: f.out } : {}) }
}

/** The files of a page of rows of the room files query, as the room shows them, and their rooms: canSee on each (a
 * second check), then, per room, what messagesOut would withhold from its member (one of their hidden old answers or
 * in its thread: a third check): never a withheld message's files. */
function fileHits(db: Database, userId: string, mine: Map<string, Mine>, page: (MessageRow & { file_id: string })[]): { items: RoomFileSearchHit[]; rooms: RoomSearchRoom[] } {
  const seen = page.filter((h) => { const m = mine.get(h.room_id); return !!m && canSee(db, h, m.me) })
  const withheld = new Set<string>()
  for (const roomId of new Set(seen.map((h) => h.room_id))) for (const id of hiddenAmong(db, seen.filter((h) => h.room_id === roomId), mine.get(roomId)!.me)) withheld.add(id)
  const kept = seen.filter((h) => !withheld.has(h.id))
  // the files as the room gives them (fileOut), still sent with that message, and their senders
  const files = new Map(kept.length ? (db.query(`SELECT * FROM room_files WHERE id IN (${kept.map(() => '?').join(',')})`).all(...kept.map((h) => h.file_id)) as FileRow[]).map((f) => [f.id, f]) : [])
  const people = refsOf(db, kept.map((h) => (h.author_kind === 'ai' ? null : h.author_id)))
  const items: RoomFileSearchHit[] = []
  for (const h of kept) {
    const f = files.get(h.file_id)
    if (!f || f.message_id !== h.id || f.room_id !== h.room_id) continue
    items.push({ file: fileOut(f), messageId: h.id, roomId: h.room_id, threadRootId: h.thread_root_id ?? null, author: h.author_kind === 'ai' || !h.author_id ? null : people.get(h.author_id) ?? null, createdAt: h.created_at })
  }
  const rooms: RoomSearchRoom[] = [...new Set(items.map((i) => i.roomId))].map((id) => { const m = mine.get(id)!; return { id, kind: m.room.kind, ...roomNaming(db, m.room, userId) } })
  return { items, rooms }
}

/** Mine only: the rows of the rooms I am in now, of a message of mine that is sent, not deleted and that I see. */
const MINE_WHERE = `f.user_id = ? AND f.message_id IS NOT NULL AND m.author_kind = 'user' AND m.author_id = f.user_id
  AND f.room_id IN (SELECT value FROM json_each(?)) AND m.deleted_at IS NULL AND m.event IS NULL AND ${SEE_MEMBER_SQL}`
const MINE_FROM = `room_files f CROSS JOIN room_messages m ON m.id = f.message_id AND m.room_id = f.room_id
    CROSS JOIN room_members mm ON mm.room_id = m.room_id AND mm.user_id = f.user_id`

/** "Files you sent" (docs/decisions/20261116-room-files-cleanup.md): my files in the rooms I am in now, of my messages
 * I still see, largest first (equal sizes oldest first: the index's own order), by the index room_files_by_sender
 * (migration 414); the cursor is the last row's (size, rowid). totalBytes: all of them together, with the first page.
 * The same checks as the search on each row. */
export function listMyRoomFiles(db: Database, userId: string, o: { cursor?: string; limit?: number }): MyRoomFilesPage {
  const cur = decodeCursor(o.cursor, ['s', 'f'])
  if (o.cursor && (!cur || !/^\d{1,18}$/.test(cur.s) || !/^\d{1,18}$/.test(cur.f))) fail('validation', undefined, { fields: { 'query.cursor': 'invalid cursor' } })
  const limit = Math.min(ROOM_SEARCH_PAGE_MAX, Math.max(1, o.limit ?? ROOM_SEARCH_DEFAULT))
  const mine = new Map(myRooms(db, userId).map((m) => [m.room.id, m]))
  if (!mine.size) return { items: [], rooms: [], nextCursor: null, totalBytes: 0 }
  const ids = JSON.stringify([...mine.keys()])
  const rows = db.query(`SELECT f.rowid AS fr, f.size AS fsize, f.id AS file_id, ${COLS} FROM ${MINE_FROM}
    WHERE ${MINE_WHERE}${cur ? ' AND (f.size < ? OR (f.size = ? AND f.rowid > ?))' : ''} ORDER BY f.size DESC, f.rowid LIMIT ?`)
    .all(userId, ids, ...(cur ? [Number(cur.s), Number(cur.s), Number(cur.f)] : []), limit + 1) as (MessageRow & { fr: number; fsize: number; file_id: string })[]
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  const nextCursor = rows.length > limit && last ? encodeCursor({ s: String(last.fsize), f: String(last.fr) }) : null
  // the total with the first page only (a later page answers 0: the app keeps the first one's)
  const total = cur ? 0 : (db.query(`SELECT COALESCE(SUM(f.size), 0) AS n FROM ${MINE_FROM} WHERE ${MINE_WHERE}`).get(userId, ids) as { n: number }).n
  return { ...fileHits(db, userId, mine, page), nextCursor, totalBytes: total }
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
