// The long answers of connected services kept for connection_result (integrations/connections/tools.ts; limits audit 1
// #13): an answer over MAX_RESULT_CHARS comes in parts the AI reads on. A leaf module, so the chat turn (chat/turn.ts)
// drops a turn's answers when it ends without importing the connection tools.
// - kept per turn and person (one store for every build of the turn's tools: connect_service rebuilds them mid-answer),
//   in memory only, as the AI was shown them (secrets hidden);
// - a store is made only when an answer is kept, and removed when its turn ends (dropKept);
// - ids are never reused, on the whole server: an id names one answer or none;
// - a turn's store is never dropped for another's: at most KEPT_RESULTS_MAX answers and KEPT_RESULTS_CHARS characters
//   per turn (its oldest go first); a person who holds KEPT_RESULTS_CHARS over all their turns, or a server that holds
//   KEPT_ALL_CHARS, keeps no new answer (the AI is told it was cut), so one person's turns never take everyone's room.
import type { Row } from './store'

export const KEPT_RESULTS_MAX = 32
export const KEPT_RESULTS_CHARS = 16_000_000
export const KEPT_ALL_CHARS = 64_000_000

interface Kept { row: Row; tool: string; text: string }
const stores = new Map<string, { rows: Map<string, Kept>; chars: number; userId: string }>()
/** characters kept per person, over all their turns */
const byPerson = new Map<string, number>()
const addPerson = (userId: string, n: number) => { const v = (byPerson.get(userId) ?? 0) + n; if (v > 0) byPerson.set(userId, v); else byPerson.delete(userId) }
let seq = 0
let all = 0
const keyOf = (t: { turnId: string; userId: string }) => `${t.turnId}\u0000${t.userId}`

/** keep an answer for this turn and person; its id, or null when the server keeps too much already */
export function keptPut(t: { turnId: string; userId: string }, row: Row, text: string, tool: string): string | null {
  if (text.length > KEPT_RESULTS_CHARS || all + text.length > KEPT_ALL_CHARS || (byPerson.get(t.userId) ?? 0) + text.length > KEPT_RESULTS_CHARS) return null
  const key = keyOf(t)
  let s = stores.get(key)
  if (!s) stores.set(key, s = { rows: new Map(), chars: 0, userId: t.userId })
  const id = `r${++seq}`
  s.rows.set(id, { row, tool, text })
  s.chars += text.length; all += text.length; addPerson(t.userId, text.length)
  for (const [k, v] of s.rows) {
    if (s.rows.size <= KEPT_RESULTS_MAX && s.chars <= KEPT_RESULTS_CHARS) break
    if (k === id) break
    s.rows.delete(k); s.chars -= v.text.length; all -= v.text.length; addPerson(t.userId, -v.text.length)
  }
  return id
}

export function keptGet(t: { turnId: string; userId: string }, id: string): Kept | null {
  return stores.get(keyOf(t))?.rows.get(id) ?? null
}

/** the turn ended: its answers go (every person's store of that turn) */
export function dropKept(turnId: string): void {
  for (const [key, s] of stores) if (key.startsWith(turnId + '\u0000')) { stores.delete(key); all -= s.chars; addPerson(s.userId, -s.chars) }
}

/** tests: how many stores and characters are kept now */
export const keptStats = () => ({ stores: stores.size, chars: all })
