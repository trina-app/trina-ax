// "This chat has read rooms": other people's words from the person's team chat rooms came into their own chat, so
// whatever those words could ask for is refused or waits for the person's yes on a card. One rule for every such gate
// (delete_files, skill_files S7, the room card and the tools whose own card stands in for it, remember, the turn's
// outside mark). Three ways in:
//   - a room tool read a room (chats.rooms_seen, chat/room-tools.ts): kept for the rest of the chat;
//   - a ✦ side chat (chats.side_room_id): it is about its room, and its asks bring the room's words in;
//   - a "> " quote in the person's own messages on this answer's branch: "Ask Trina about this" quotes another person's
//     message there (up to 4,000 characters, web components/rooms/SideChatPanel.tsx withQuote) with no room tool run.
//     Any quote counts, a pasted one too: its words are not the person's. An edit that takes the quote out leaves it
//     on the old branch only.
import type { Database } from 'bun:sqlite'
import type { TurnExec } from './turn'

/** how far up the branch the quote check reads (as chat/project-members.ts ownWords) */
const BRANCH_MAX = 2000

/** What the check needs of the chat turn: narrow, so the gates' own tests can hand in a plain object. */
export type ReadRoomsExec = Pick<TurnExec, 'roomsSeen' | 'spec' | 'rt'>

/** The side chat and quote part, per turn: neither changes while a turn runs (a chat's side room is set when it is
 * made; an edit or a new message is a new turn). rooms_seen is read each time: a room tool can set it mid-turn. */
const fixed = new WeakMap<object, boolean>()

/** Has this chat read rooms (rooms_seen, a side chat, or a quote on this answer's branch)? */
export function readRooms(exec: ReadRoomsExec): boolean {
  if (exec.roomsSeen) return true
  let seen = fixed.get(exec)
  if (seen === undefined) {
    const db = exec.rt.db
    const chat = db.query('SELECT side_room_id FROM chats WHERE id = ?').get(exec.spec.chatId) as { side_room_id: string | null } | null
    seen = !!chat?.side_room_id || (!!exec.spec.assistantId && quotesOnBranch(db, exec.spec.assistantId))
    fixed.set(exec, seen)
  }
  return seen
}

/** Does a user message on the branch up to `answerId` hold a line that starts with ">" (spaces before it allowed)? */
export function quotesOnBranch(db: Database, answerId: string): boolean {
  // only the messages with a ">" anywhere are read; the walk itself follows parent_id like the turn's history
  const rows = db.query(`WITH RECURSIVE up(id, parent_id, role, depth) AS (SELECT id, parent_id, role, 0 FROM messages WHERE id = ?
      UNION ALL SELECT m.id, m.parent_id, m.role, up.depth + 1 FROM messages m JOIN up ON m.id = up.parent_id WHERE up.depth < ${BRANCH_MAX})
    SELECT m.content content FROM up JOIN messages m ON m.id = up.id WHERE up.role = 'user' AND instr(m.content, '>') > 0`).all(answerId) as { content: string | null }[]
  return rows.some((r) => (r.content ?? '').split('\n').some((line) => /^\s*>/.test(line)))
}
