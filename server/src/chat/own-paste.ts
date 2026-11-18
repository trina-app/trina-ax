// "Your own paste is yours to send" (docs/decisions/20261118-dm-own-paste.md): text the person wrote or pasted in their
// own message in this chat goes to the teammate or room they name as their own words (post_to_room's own_words),
// without the provenance check of what the chat read (chat/answer-share.ts B). That check is about content the AI
// brought in from places some people cannot see; a person's own typed or pasted words came from nowhere the chat read.
//
// What counts as the person's own words: their user messages on this answer's branch (author = the person; never a
// message the server sent for them, auto_sent), "> " quote lines left out (the side chat's "Ask Trina about this"
// quotes another person's message that way, chat/read-rooms.ts) and a room picked with "#" left out (its title is
// other people's words); a message the server wrote for the person (an onboarding or skill-draft step, by its
// client id) is not theirs either. The text to send must be one stretch of one such message, starting and ending at a
// word's edge, compared with the whitespace
// (spaces, tabs, line breaks) collapsed and both sides in Unicode NFC. What then goes is that stretch of the person's
// message itself, never the AI's copy of it: a different spacing, line break or invisible character the AI put in
// cannot carry anything along. Anything else (a word changed, added or left out in the middle, two messages stitched
// together, an AI answer) is not the person's own and gets the full check. So is a stretch that shares OVERLAP_WORDS
// words in a row with an earlier AI answer on the branch: the person may have copied what the AI showed them
// (a summary of a room whose answers are hidden from the recipient), and they cannot see what is at stake (review).
// Lines are split on "\n" only, as every other quote check (chat/read-rooms.ts): a "\r" inside a quoted room message
// never makes the rest of it a line of the person's own.
import type { Database } from 'bun:sqlite'
import { ROOM_REF_RE } from '@mycel/shared/api'
import { isQuoteLine } from './read-rooms'

/** how far up the branch the person's messages are read (as chat/read-rooms.ts) */
const BRANCH_MAX = 2000
/** at most this many of the person's messages, the newest first, and this many characters of each */
const MESSAGES_MAX = 200
const MESSAGE_CHARS = 100_000
/** at most this many characters of messages read in all, the person's and the AI's each */
const TOTAL_CHARS = 400_000
/** this many words in a row shared with an earlier AI answer make a stretch not own (a shorter stretch: all of its
 * words in a row in one answer) */
export const OVERLAP_WORDS = 8
/** rows of the branch read (the person's and the AI's) */
const ROWS_MAX = MESSAGES_MAX * 2
/** client ids of user messages the server writes for the person (onboarding, skill drafts, skill sharing, file
 * ranking, schedules, Slack): never their own paste */
const SERVER_SENT = /^(onb|skd|skf|ssj|ssm|tfr|slack|n|s)-/
const WORDISH = /[\p{L}\p{M}\p{N}]/u

/** A message as the person wrote it, quote lines and "#" room picks left out, in NFC. */
export function ownText(content: string): string {
  return content.normalize('NFC').split('\n').filter((l) => !isQuoteLine(l)).join('\n').replace(new RegExp(ROOM_REF_RE.source, 'g'), ' ')
}

/** `s` with every run of whitespace as one space, and where each of its characters is in `s` */
function collapse(s: string): { text: string; at: number[] } {
  let text = ''
  const at: number[] = []
  let gap = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (/\s/.test(c)) { gap = true; continue }
    if (gap && text) { text += ' '; at.push(i) }
    gap = false
    text += c
    at.push(i)
  }
  return { text, at }
}

/**
 * The stretch of one of the person's own messages on the branch up to `answerId` that `text` is (whitespace collapsed,
 * NFC), exactly as the person wrote it; null when it is not one (or is empty). Fails closed (null).
 */
export function ownPaste(db: Database, userId: string, answerId: string, text: string): string | null {
  try {
    const want = collapse(text.normalize('NFC')).text
    if (!want) return null
    const rows = db.query(`WITH RECURSIVE up(id, parent_id, role, depth) AS (SELECT id, parent_id, role, 0 FROM messages WHERE id = ?
        UNION ALL SELECT m.id, m.parent_id, m.role, up.depth + 1 FROM messages m JOIN up ON m.id = up.parent_id WHERE up.depth < ${BRANCH_MAX})
      SELECT up.role role, m.author_id author, m.auto_sent auto, m.client_message_id cid, substr(m.content, 1, ${MESSAGE_CHARS}) content
      FROM up JOIN messages m ON m.id = up.id WHERE up.id <> ?1 ORDER BY up.depth LIMIT ${ROWS_MAX}`).all(answerId) as { role: string; author: string | null; auto: number; cid: string | null; content: string | null }[]
    let found: string | null = null
    let total = 0
    for (const r of rows) {
      if (r.role !== 'user' || r.author !== userId || r.auto || SERVER_SENT.test(r.cid ?? '')) continue
      if ((total += (r.content ?? '').length) > TOTAL_CHARS) break
      const own = ownText(r.content ?? '')
      const c = collapse(own)
      // the first place it starts and ends at a word's edge
      for (let k = c.text.indexOf(want); k >= 0; k = c.text.indexOf(want, k + 1)) {
        const before = c.text[k - 1], after = c.text[k + want.length]
        if ((before && WORDISH.test(before) && WORDISH.test(want[0]!)) || (after && WORDISH.test(after) && WORDISH.test(want.at(-1)!))) continue
        found = own.slice(c.at[k]!, c.at[k + want.length - 1]! + 1)
        break
      }
      if (found !== null) break
    }
    if (found === null) return null
    // what an earlier AI answer on the branch showed, copied into the person's message, is not their own. Compared by
    // words, so Markdown the answer was written in (bold, links, tables) and the copy left out never hides it. A branch
    // longer than the rows read: not known, not own
    if (rows.length >= ROWS_MAX) return null
    const mine = words(want)
    const grams = new Set<string>()
    let read = 0
    for (const r of rows) {
      if (r.role !== 'assistant') continue
      if ((read += (r.content ?? '').length) > TOTAL_CHARS) return null
      const a = words(r.content ?? '')
      if (mine.length < OVERLAP_WORDS) { if (` ${a.join(' ')} `.includes(` ${mine.join(' ')} `)) return null; continue }
      for (let i = 0; i + OVERLAP_WORDS <= a.length; i++) grams.add(a.slice(i, i + OVERLAP_WORDS).join(' '))
    }
    for (let i = 0; i + OVERLAP_WORDS <= mine.length; i++) if (grams.has(mine.slice(i, i + OVERLAP_WORDS).join(' '))) return null
    return found
  } catch { return null }
}

/** The words of a text (letters, marks and digits), NFC and lowercase: what a copy of its rendered form keeps. */
function words(t: string): string[] {
  return t.normalize('NFC').toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []
}
