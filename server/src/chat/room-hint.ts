// A team file search also says when the person's rooms mention the same words (docs/AGENTS/plan/*-ai-search-rooms.md).
// Asked for a client visit prep sheet, the AI searched the team files only and said nothing answered a question that a
// teammate had answered in the client's group chat (AI scenario FLOW-03, 2026-11-16). The rooms tool and its description
// were in the request (no tool is deferred: ToolSearch is denied, engine/claude.ts); words in the instructions and in the
// tool's description did not make the AI think of rooms while it searched files. So the grep result says so itself.
//
// Only in a turn that offers the rooms tool (the person's own chat: chat/tools.ts does not add it in a shared,
// confidential, draft, template or guest chat), only messages the person sees (rooms/search.ts searchRoomMessages), and
// the line names no room and quotes nothing: how many messages, in how many rooms, and which tool to use.
import type { Database } from 'bun:sqlite'
import { searchRoomMessages } from '../rooms/search'

/** at most this many words of one pattern are looked up */
const MAX_WORDS = 4
/** a pattern's plain words: "a|b|c" of letters, digits, spaces and . _ -, with an optional (?i); anything else: none */
export function plainWords(pattern: unknown): string[] {
  if (typeof pattern !== 'string') return []
  const p = pattern.replace(/^\(\?i\)/, '').trim()
  if (!p || p.length > 200) return []
  const parts = p.split('|').map((x) => x.trim())
  if (!parts.every((x) => /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u.test(x) && [...x].length >= 2)) return []
  return [...new Set(parts.map((x) => x.normalize('NFC')))].slice(0, MAX_WORDS)
}

/** The line for a grep of team files in a turn whose person may read their rooms, or null: the words of `pattern` that
 * room messages they see also contain, counted. `asked`: the words this turn already looked up (each once a turn). */
export function roomHint(db: Database, userId: string, pattern: unknown, asked: Set<string>): string | null {
  const words = plainWords(pattern).filter((w) => !asked.has(w.toLowerCase()))
  if (!words.length) return null
  const ids = new Set<string>(), rooms = new Set<string>(), found: string[] = []
  for (const w of words) {
    asked.add(w.toLowerCase())
    let page
    try { page = searchRoomMessages(db, userId, { q: w, limit: 20 }) } catch { continue }
    if (!page.items.length) continue
    found.push(w)
    for (const m of page.items) { ids.add(m.id); rooms.add(m.roomId) }
  }
  if (!ids.size) return null
  const n = ids.size >= 20 ? '20 or more' : String(ids.size)
  return `The user's chat rooms also mention ${found.map((w) => `"${w}"`).join(', ')}: ${n} message${ids.size === 1 ? '' : 's'} in ${rooms.size} room${rooms.size === 1 ? '' : 's'}. What was said or decided may be only there: search them with rooms (query) and read the threads before saying nothing answers a question.`
}
