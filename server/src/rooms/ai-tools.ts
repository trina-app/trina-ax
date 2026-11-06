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
  ...Object.keys(FILE_TOOLS), 'edit_files', 'search', 'knowledge_explore', 'skill', 'find_skills', 'ask_user', 'agent',
  'make_file', 'edit_hwp', 'hwp_render', 'move_files', 'copy_files', 'rename_file', 'share_file', 'artifact',
])

/**
 * The only tools a room session gets (an allowlist: a tool added later is not offered in rooms until it is listed
 * here). Left out: memories (none are loaded in a room, none are kept from one), the chat title, connecting a service
 * and every connection's tools (personal ones are the person's own; a team one's results are not team files), the
 * person's Google Drive, schedules, video generation, and anything that runs on a computer or in the person's
 * signed-in browser (box_shell; the in-app browser is off for room turns as a whole, chat/turn.ts).
 */
export const ROOM_TOOLS: ReadonlySet<string> = new Set([
  ...Object.keys(FILE_TOOLS), 'edit_files', 'search', 'knowledge_explore', 'skill', 'find_skills', 'ask_user',
  'make_file', 'edit_hwp', 'hwp_render', 'move_files', 'copy_files', 'rename_file', 'share_file', 'artifact', 'web_fetch', 'save_url',
])

/**
 * Tools that change nothing (they read, search, ask the person, or answer in the session's own chat). In a room every
 * other tool of ours, connections' tools and tools added later included (fails closed), waits for the person who
 * asked to allow that one call on a card first (chat/turn.ts confirmRoomChange): the room's messages are other
 * people's words, and one of them may tell the AI to change something.
 */
export const ROOM_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'list', 'glob', 'grep', 'read', 'search', 'knowledge_explore', 'skill', 'find_skills', 'ask_user', 'hwp_render', 'share_file', 'artifact', 'web_fetch',
])

/** The arguments of our tools that name a team path (a room session counts each as a name read, chat/turn.ts). */
export const PATH_ARGS: readonly string[] = ['file_path', 'path', 'source', 'output', 'template', 'from', 'to', 'to_folder', 'destination', 'file_paths', 'paths', 'sources', 'images']

/**
 * A person's own AI chat that has read their team chat rooms (chats.rooms_seen, chat/room-tools.ts; docs/DECISIONS.md
 * "내 AI 채팅에서 대화방 읽기"): the tools that go on without the room card there. The room session's read-only tools, the
 * room tools themselves, and the own chat's other tools that only read or look (the scheduled tasks' list, Google
 * Drive's search, list and read, finding a connection's tools, the in-app browser's reading tools). set_title names the
 * chat for the person alone; remember raises its own card with the text it would keep (chat/tools.ts). Every other
 * tool (writes, moves, schedules, connections' tools and call_tool, the browser's clicks and pages, box_shell, forget,
 * connect_service, tools added later) waits for the person's yes on a card for the rest of that chat (fails closed).
 */
export const ROOMS_SEEN_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  ...ROOM_READ_ONLY_TOOLS, 'rooms', 'room_read', 'room_file', 'set_title', 'remember', 'find_tools', 'schedule_list', 'drive_search', 'drive_list', 'drive_read',
])
/** ...and the in-app browser's reading tools, only in a turn that has the browser (by name otherwise: no exemption) */
export const ROOMS_SEEN_BROWSER_READ_TOOLS: ReadonlySet<string> = new Set(['read_page', 'get_page_text', 'find', 'tabs_context', 'read_console_messages', 'read_network_requests'])
