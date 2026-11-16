// A team file search also says when the person's rooms mention the same words (docs/AGENTS/plan/*-ai-search-rooms.md).
// Asked for a client visit prep sheet, the AI searched the team files only and said nothing answered a question that a
// teammate had answered in the client's group chat (AI scenario FLOW-03, 2026-11-16). The rooms tool and its description
// were in the request (no tool is deferred: ToolSearch is denied, engine/claude.ts); words in the instructions and in the
// tool's description did not make the AI think of rooms while it searched files. So the grep result says so itself.
//
// Only for the main AI (a sub-agent has no rooms tool) of a turn that offers the rooms tool, and not where reading a
// room would carry on further than the person's own chat (chat/tools.ts: no shared, confidential, draft, template or
// guest chat; here also no scheduled run, Slack chat or room side chat). Counted as the rooms tool searches
// (rooms/reader.ts roomMatchCount): only what the person sees. The line names no room and quotes nothing.
import { searchWords } from '@mycel/shared'
import { roomMatchCount } from '../rooms/reader'
import { roomsOf } from '../rooms/service'
import type { TurnExec } from './turn'

/** at most this many words of one pattern, and lookups in one turn */
const MAX_WORDS = 4
export const MAX_LOOKUPS = 8
/** words too common to say anything about a room (English and Korean) */
const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'file', 'files', 'notes', 'todo', 'draft', 'final', 'copy', 'report', 'docx', 'xlsx', 'pptx', 'pdf', 'hwp', 'hwpx', '파일', '문서', '내용', '자료', '보고서', '최종', '초안', '회의록'])

/**
 * A pattern's plain words: "a|b" whose parts are letters, digits, spaces and . _ - (a "." counts as itself, not as "any
 * character": the room lookup is a plain substring), with an optional (?i), each part split into words at spaces
 * (shared/search-text.ts searchWords). Words of 3 or more characters that are not stop words; anything else: none.
 */
export function plainWords(pattern: unknown): string[] {
  if (typeof pattern !== 'string') return []
  const p = pattern.replace(/^\(\?i\)/, '').trim()
  if (!p || p.length > 200) return []
  const parts = p.split('|').map((x) => x.trim())
  if (!parts.every((x) => /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u.test(x))) return []
  const words = new Map<string, string>()
  for (const w of parts.flatMap((x) => searchWords(x))) if ([...w].length >= 3 && !STOP.has(w.toLowerCase())) words.set(w.toLowerCase(), w)
  return [...words.values()].slice(0, MAX_WORDS)
}

interface State { asked: Set<string>; lookups: number; synced: boolean }
/** per turn (kept on the turn, so a tool refresh in the turn does not start it again) */
const states = new WeakMap<TurnExec, State>()

/** Whether this turn's grep results may carry the line: the person's own chat that offers the rooms tool, and none of
 * the places where a room read is carried on (a scheduled run, a Slack chat, a room's side chat). */
export function hintsHere(exec: TurnExec, offered: boolean): boolean {
  if (!offered || exec.spec.clientKind === 'schedule' || exec.fromSlack) return false
  return !(exec.rt.db.query('SELECT side_room_id FROM chats WHERE id = ?').get(exec.spec.chatId) as { side_room_id: string | null } | null)?.side_room_id
}

/** The line for a grep of team files by the main AI, or null: the words of `pattern` that room messages the person sees
 * also contain, counted. Each word once a turn, at most MAX_LOOKUPS lookups a turn. */
export function roomHint(exec: TurnExec, pattern: unknown): string | null {
  const st = states.get(exec) ?? { asked: new Set<string>(), lookups: 0, synced: false }
  states.set(exec, st)
  const words = plainWords(pattern).filter((w) => !st.asked.has(w.toLowerCase()))
  if (!words.length || st.lookups >= MAX_LOOKUPS) return null
  // as the rooms tool does before a search (chat/room-tools.ts): the person as they are now, their rooms in step
  try { exec.livePrincipal() } catch { return null }
  if (!st.synced) { st.synced = true; try { roomsOf(exec.rt.ctx).syncFor(exec.spec.userId) } catch { /* the member rows as they are */ } }
  let messages = 0, more = false
  const rooms: number[] = [], found: string[] = []
  for (const w of words) {
    if (st.lookups >= MAX_LOOKUPS) break
    st.lookups++
    st.asked.add(w.toLowerCase())
    let c
    try { c = roomMatchCount(exec.rt.db, exec.spec.userId, w) } catch { continue }
    if (!c.messages) continue
    found.push(w); messages = Math.max(messages, c.messages); rooms.push(c.rooms); more ||= c.more
  }
  if (!found.length) return null
  const n = more ? `${messages} or more` : String(messages)
  const r = Math.max(...rooms)
  return `The user's chat rooms also mention ${found.map((w) => `"${w}"`).join(', ')} (${n} message${messages === 1 && !more ? '' : 's'} in ${r} room${r === 1 ? '' : 's'}). When you are looking for an answer the files do not hold, search them with rooms (query) and read the threads before saying nothing answers it.`
}
