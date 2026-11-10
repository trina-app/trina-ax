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
  ...Object.keys(FILE_TOOLS), 'edit_files', 'knowledge_explore', 'skill', 'find_skills', 'ask_user', 'agent',
  'make_file', 'edit_hwp', 'hwp_render', 'move_files', 'copy_files', 'rename_file', 'share_file', 'artifact',
  // this room's own files (chat/room-tools.ts roomSessionTools): what they read joins the read scope as the room
  'room_file', 'save_room_file',
  // one thread of this room (chat/room-tools.ts, rooms/ai-context.ts readThread). Its result is this room's own messages
  // and nothing else: for the whole room only (no private preview, the asker's own included), not deleted, as the
  // asker sees them (from their join on, a thread by its root's seq), never another room's. What it showed joins the
  // read scope as the room from the root's seq, exactly like the <room_context> block, so decide() keeps the answer
  // private for any member who cannot see that thread ("들어오기 전 대화"). Nothing in it comes from outside the team:
  // it keeps an answer "team files only" as the block does (docs/DECISIONS.md "대화방의 트리나가 스레드도 본다")
  'room_thread',
  // the shared project chats the asker may view (chat/room-project-chats.ts): what the project's people already see in
  // that chat (each turn of it behind the shared chat's read card). An answer there may quote a web page an earlier turn
  // fetched, as a room message may quote one a member pasted: both count as the team's own words (the room's
  // <room_context> block keeps an answer "team files only" too). What they showed joins the read scope as the chat's
  // project folder, whose readers are the chat's audience, so decide() keeps the answer private for any member outside
  // it (docs/DECISIONS.md "대화방의 트리나가 공유 프로젝트 채팅을 읽는다")
  'project_chats', 'project_chat',
])

/**
 * The only tools a room session gets (an allowlist: a tool added later is not offered in rooms until it is listed
 * here). Left out: memories (none are loaded in a room, none are kept from one), the chat title, connecting a service
 * and every connection's tools (personal ones are the person's own; a team one's results are not team files), the
 * person's Google Drive, schedules, video generation, and anything that runs on a computer or in the person's
 * signed-in browser (box_shell; the in-app browser is off for room turns as a whole, chat/turn.ts).
 */
export const ROOM_TOOLS: ReadonlySet<string> = new Set([
  ...Object.keys(FILE_TOOLS), 'edit_files', 'knowledge_explore', 'skill', 'find_skills', 'ask_user',
  'make_file', 'edit_hwp', 'hwp_render', 'move_files', 'copy_files', 'rename_file', 'share_file', 'artifact', 'web_fetch', 'save_url',
  // this room's files: the asking message's attachments and earlier ones the person sees (read, or a copy saved)
  'room_file', 'save_room_file',
  // one whole thread of this room (read-only; in a thread question that thread only)
  'room_thread',
  // the shared project chats the asker may view: a list or search, and one chat's messages (read-only)
  'project_chats', 'project_chat',
])

/** A room's own tools: its files and its threads. */
export const ROOM_OWN_TOOLS: ReadonlySet<string> = new Set(['room_file', 'save_room_file', 'room_thread'])

/** A room session's tools that read the shared project chats the asker may view (chat/room-project-chats.ts). Never in a
 * shared project chat itself (SHARED_TOOLS) and never in a person's own chat (chat/tools.ts offers them to room sessions
 * only). */
export const ROOM_PROJECT_CHAT_TOOLS: ReadonlySet<string> = new Set(['project_chats', 'project_chat'])

/**
 * The only tools a shared project chat gets (docs/DECISIONS.md "Shared project chats"): ROOM_TOOLS without the room's
 * own tools. Its transcript is seen by everyone who sees its project, so the same allowlist as a room: no memories, no
 * chat title, no connection's tools, no Google Drive, no schedules, nothing on a computer or in the person's signed-in
 * browser, no room reading (room_read, rooms), no reading of other shared chats (project_chats, project_chat). A tool
 * added later is not offered here until it is listed.
 */
export const SHARED_TOOLS: ReadonlySet<string> = new Set([...ROOM_TOOLS].filter((t) => !ROOM_OWN_TOOLS.has(t) && !ROOM_PROJECT_CHAT_TOOLS.has(t)))

/** The arguments that name where a call writes, per tool: a shared chat's read card counts them only when something
 * is there already (chat/turn.ts sharedSources); every other path argument counts as a read. */
export const WRITE_TARGET_ARGS: Readonly<Record<string, readonly string[]>> = {
  write: ['file_path'], edit: ['file_path'], make_file: ['output'], edit_hwp: ['output'], save_url: ['save_as'],
  move_files: ['to_folder'], copy_files: ['to_folder'], rename_file: ['new_name'],
}

/** Tools that look through a folder and everything under it; in a shared chat without a path, the project folder. */
export const SEARCH_TOOLS: ReadonlySet<string> = new Set(['grep', 'glob', 'knowledge_explore'])

/**
 * Tools that change nothing (they read, search, ask the person, or answer in the session's own chat). In a room every
 * other tool of ours, connections' tools and tools added later included (fails closed), waits for the person who
 * asked to allow that one call on a card first (chat/turn.ts confirmRoomChange): the room's messages are other
 * people's words, and one of them may tell the AI to change something.
 */
export const ROOM_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'list', 'glob', 'grep', 'read', 'knowledge_explore', 'skill', 'find_skills', 'ask_user', 'hwp_render', 'share_file', 'artifact', 'web_fetch',
  'room_file', 'room_thread', 'project_chats', 'project_chat',
])

/**
 * Tools whose calls of one answer may run at the same time on its tool connection (mcp/socket.ts CallQueue): those of
 * ROOM_READ_ONLY_TOOLS that only read team files and add to the turn's read scope and sources (each add is done
 * without a wait in between, files/service.ts TurnFiles). Every other tool, unknown ones and tools added later
 * included (fails closed), runs alone and in order. Left out on purpose: ask_user, share_file, artifact, web_fetch
 * (cards, links and chat output), room_file and room_thread (they patch their step: TurnExec.patchToolStep matches
 * calls to steps first in, first out per tool), skill, find_skills and hwp_render (not needed side by side).
 */
export const PARALLEL_READ_TOOLS: ReadonlySet<string> = new Set(
  ['list', 'glob', 'grep', 'read', 'knowledge_explore'].filter((t) => ROOM_READ_ONLY_TOOLS.has(t)))

/** The arguments of our tools that name a team path (a room session counts each as a name read, chat/turn.ts). */
export const PATH_ARGS: readonly string[] = ['file_path', 'path', 'source', 'output', 'template', 'from', 'to', 'to_folder', 'destination', 'file_paths', 'paths', 'sources', 'images', 'save_as']

/**
 * A person's own AI chat that has read their team chat rooms (chats.rooms_seen, chat/room-tools.ts; docs/DECISIONS.md
 * "내 AI 채팅에서 대화방 읽기"): the tools that go on without the room card there. The room session's read-only tools, the
 * room tools themselves, and the own chat's other tools that only read or look (the scheduled tasks' list, Google
 * Drive's search, list and read, finding a connection's tools, the in-app browser's reading tools). set_title names the
 * chat for the person alone; remember raises its own card with the text it would keep (chat/tools.ts), and post_to_room
 * its own card with the room and all of the text, which leads with the room line (chat/post-to-room.ts): no room card
 * before either. A connection's read that the service marks read-only, whose arguments carry no address or
 * random-looking part, goes on too (chat/turn.ts confirmRoomChange; not api_request's GET), and the tools with a card of
 * their own ask there alone (ROOMS_SEEN_OWN_CARD_TOOLS, a connection's write). delete_files, and skill_files into a
 * skill folder, refuse there (chat/delete-files.ts, chat/skill-files.ts). Every other tool (writes, the browser's clicks
 * and pages, box_shell, forget, tools added later) waits for the person's yes on the room card for the rest of that chat
 * (fails closed).
 */
export const ROOMS_SEEN_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  ...ROOM_READ_ONLY_TOOLS, 'rooms', 'room_read', 'room_file', 'set_title', 'remember', 'post_to_room', 'find_tools', 'schedule_list', 'drive_search', 'drive_list', 'drive_read',
])
/** ...and the in-app browser's reading tools, only in a turn that has the browser (by name otherwise: no exemption) */
export const ROOMS_SEEN_BROWSER_READ_TOOLS: ReadonlySet<string> = new Set(['read_page', 'get_page_text', 'find', 'tabs_context', 'read_console_messages', 'read_network_requests'])
/**
 * Tools whose own card shows everything the call does: after a room read in the person's own chat the room card is
 * not raised for them; their card is the call's only one, carries the room card's line and asks every time
 * (TurnPerson.roomsSeen; chat/turn.ts ownCard). A connection's tools join them by provider (chat/tools.ts connection).
 * A tool listed here must never act without asking when TurnPerson.roomsSeen is set.
 */
export const ROOMS_SEEN_OWN_CARD_TOOLS: ReadonlySet<string> = new Set(['schedule_create', 'generate_video', 'move_files', 'copy_files', 'move_skill', 'connect_service'])
