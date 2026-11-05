// What a room's AI session may use, and what keeps its answers inside the team files (docs/DECISIONS.md "대화방의
// 트리나"). A leaf module: the chat turn (chat/turn.ts, chat/tools.ts) and the rooms (rooms/ai.ts) both read it.
import { FILE_TOOLS } from '@mycel/shared'

/**
 * Tools whose use keeps an answer "team files only": the file tools and the ones that work on team files (their reads
 * join the session's read scope), the person's own skills, a question to the person who asked, and the sub-task that
 * runs more of them (its own calls are checked one by one). Any other tool, the engine's own web search included, and
 * any tool added later (fails closed), marks the session as having used something from outside: its answers then stay
 * private to the person until they post one.
 */
export const ROOM_FILE_TOOLS: ReadonlySet<string> = new Set([
  ...Object.keys(FILE_TOOLS), 'edit_files', 'search', 'skill', 'find_skills', 'ask_user', 'agent',
  'make_file', 'edit_hwp', 'hwp_render', 'move_files', 'copy_files', 'rename_file', 'share_file', 'artifact',
])

/** Tools a room session does not get: memories are not part of a room (none are loaded there, none are kept from one),
 * the session has no title, and connecting a service needs a card the room does not show. */
export const ROOM_OFF_TOOLS: ReadonlySet<string> = new Set(['remember', 'forget', 'set_title', 'connect_service'])
