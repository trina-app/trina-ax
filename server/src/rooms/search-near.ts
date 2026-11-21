// Near matches of room messages (docs/decisions/20261121-search-near-every-word.md): when nothing matched as typed, the
// messages whose every word is there as typed or with a typing mistake (shared/src/search-near.ts nearMatcher), the best
// first. Used by ⌘K's message search (rooms/search.ts) and the AI's room search (rooms/reader.ts searchRooms).
//   candidates  from the room messages' trigram index (migration 267), nothing else: the rows that share the most
//               three-letter pieces with the words (its own rank), and for a Korean word that may have a typing mistake
//               the newest rows with two of its syllables (side by side, or with one between: "견젹서" has 견_서), so a
//               mistake in any one syllable still brings the message. At most NEAR_POOL of each.
//   who sees    decided in the query, as for a match as typed (store.ts SEE_MEMBER_SQL on each message's own room's
//               member row, only the rooms given); the caller checks canSee on each again. A near match widens which
//               words match, never which messages.
//   order       nearMatcher's score (whole words, then a word's start, inside a word, one mistake, two), then newest.
import type { Database } from 'bun:sqlite'
import { nearMatcher, nearPossible, nearTermsOf, nearWordBudget, type SearchParts } from '@mycel/shared'
import { MSG_COLS, SEE_MEMBER_SQL, type MessageRow } from './store'
import type { Mine } from './reader'

/** a near match looks at this many candidates of the index of each kind, the most alike (or the newest) first */
export const NEAR_POOL = 2000

const COLS = MSG_COLS.split(', ').map((c) => `m.${c}`).join(', ')
const fold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase())
const ftsPhrase = (w: string) => `"${w.replace(/"/g, '""')}"`
const likeOf = (w: string) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
const HANGUL_ONLY = /^[\uac00-\ud7a3]+$/u
/** what a near match reads of a search's text (parseSearch) */
type Words = Pick<SearchParts, 'words' | 'terms' | 'phrases'> & Partial<Pick<SearchParts, 'forms'>>

/** May a near pass find anything the search as typed did not (a word that may have a typing mistake)? */
export const nearSearchable = (parts: Words): boolean => nearPossible(nearTermsOf(parts))

/** Two syllables of each Korean word that may have a typing mistake: side by side and with one between ("견적셔":
 * 견적, 적셔, 견_셔), as LIKE patterns (a mistake in one syllable keeps one of them) */
function hangulPieces(parts: Words): string[] {
  const out = new Set<string>()
  parts.terms.forEach((t, i) => {
    if (parts.phrases[i]) return
    for (const w of new Set([t, parts.words[i]!])) {
      if (!HANGUL_ONLY.test(w) || !nearWordBudget(w)) continue
      const s = [...w]
      for (let k = 0; k + 1 < s.length; k++) out.add(likeOf(s[k]! + s[k + 1]!))
      for (let k = 0; k + 2 < s.length; k++) out.add(`%${s[k]}_${s[k + 2]}%`)
    }
  })
  return [...out]
}

/** The messages of `rooms` that `userId` sees whose every word matches as typed or near, best first (see the top of this
 * file). `who`: more SQL on room_messages `m` (from:, mentions:) and its parameters. */
export function nearRows(db: Database, userId: string, rooms: readonly Mine[], parts: Words, who: { sql: string; args: (string | number)[] } = { sql: '', args: [] }): (MessageRow & { r: number })[] {
  const terms = nearTermsOf(parts)
  if (!rooms.length || !nearPossible(terms)) return []
  const grams = new Set<string>()
  for (const t of parts.terms) { const c = [...fold(t)]; for (let i = 0; i + 3 <= c.length; i++) grams.add(c.slice(i, i + 3).join('')) }
  const pieces = hangulPieces(parts)
  const pools: string[] = []
  const args: (string | number)[] = []
  // the index ranks its own rows first (NEAR_POOL, the most alike), then who sees them is decided on those
  if (grams.size) { pools.push('SELECT rowid FROM (SELECT rowid FROM room_messages_fts WHERE room_messages_fts MATCH ? ORDER BY rank LIMIT ?)'); args.push([...grams].map(ftsPhrase).join(' OR '), NEAR_POOL) }
  // two syllables: a LIKE the trigram index cannot narrow (a read of its text, as a search of a two-letter word is)
  if (pieces.length) { pools.push(`SELECT rowid FROM (SELECT rowid FROM room_messages_fts WHERE ${pieces.map(() => "body LIKE ? ESCAPE '\\'").join(' OR ')} ORDER BY rowid DESC LIMIT ?)`); args.push(...pieces, NEAR_POOL) }
  if (!pools.length) return []
  const rows = db.query(`SELECT c.rowid AS r, ${COLS} FROM (${pools.join(' UNION ')}) c
    CROSS JOIN room_messages m ON m.rowid = c.rowid
    CROSS JOIN room_members mm ON mm.room_id = m.room_id AND mm.user_id = ?
    WHERE m.room_id IN (SELECT value FROM json_each(?)) AND m.deleted_at IS NULL AND m.event IS NULL
      AND ${SEE_MEMBER_SQL}${who.sql}`)
    .all(...args, userId, JSON.stringify(rooms.map((m) => m.room.id)), ...who.args) as (MessageRow & { r: number })[]
  const score = nearMatcher(terms)
  return rows.map((row) => ({ row, s: score(row.body) })).filter((x): x is { row: MessageRow & { r: number }; s: number } => x.s !== null)
    .sort((a, b) => a.s - b.s || b.row.r - a.row.r).map((x) => x.row)
}
