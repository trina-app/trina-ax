// Which tools keep an AI chat to the team's own words, which change nothing, and which a shared project chat may use.
// A leaf module: the chat turn (chat/turn.ts, chat/tools.ts) and the tool socket (mcp/socket.ts) read it. (It began as
// the room AI's list, docs/DECISIONS.md "대화방의 트리나"; that AI was removed, "Room @트리나 code removed".)
import { FILE_TOOLS } from '@mycel/shared'
import type { CardAlwaysKind } from '@mycel/shared/api'
import { hwpOutputPath } from '../files/hwpx-check'
import { commentDocxOutput, editOfficeOutput, makeFileOutputPath, pdfOutputPath, stampOutputOf } from '../tools/make-file-path'

/**
 * Tools whose use keeps a chat to the team's own words (OWN_CHAT_TEAM_TOOLS below): the file tools and the ones that
 * work on team files (their reads join the chat's read scope), the person's own skills, a question to the person, the
 * sub-task that runs more of them (its own calls are checked one by one), and a room's files (what they read joins the
 * read scope as the room). Any other tool, the engine's own web search included, and any tool added later (fails
 * closed), counts as something from outside.
 */
export const ROOM_FILE_TOOLS: ReadonlySet<string> = new Set([
  // Word comments on a team .docx (tools/comment-docx.ts)
  'comment_docx',
  // an existing team Office file changed in place (tools/edit-office.ts)
  'edit_office',
  ...Object.keys(FILE_TOOLS), 'edit_files', 'skill', 'find_skills', 'ask_user', 'agent',
  // the AI's own to-do list (chat/tools.ts todo_write): its words only, kept on its answer
  'todo_write',
  'make_file', 'edit_hwp', 'stamp_pdf', 'edit_pdf', 'merge_pdfs', 'split_pdf', 'resize_images', 'unzip_file', 'make_zip', 'query_data', 'hwp_render', 'move_files', 'copy_files', 'rename_file', 'share_file', 'artifact',
  'room_file', 'save_room_file',
  // many renames in one call (tools/file-moves.ts), like rename_file
  'rename_files',
  // the demo's banner words (tools/demo-banner.ts): the AI's own words over a prepared photo, nothing from outside
  'change_banner_text',
])

/** Tools a shared chat gets only while the person whose turn it is has "Always allow" on for the tool's card (Rule A,
 * decisions 1 and 2 of docs/decisions/20261123-ask-registry-findings.md): their choice holds in shared chats too. Without
 * it the tool is not offered there (it would only refuse). Each keeps all its own checks of who may change what. */
export const SHARED_UNDER_ALWAYS: Readonly<Record<string, CardAlwaysKind>> = {
  change_project_members: 'project_members', change_folder_access: 'folder_access', skill_files: 'skill_files',
}

/**
 * The only tools a shared project chat gets (docs/DECISIONS.md "Shared project chats"; an allowlist: a tool added later
 * is not offered there until it is listed). Its transcript is seen by everyone who sees its project, so: no private
 * memories (only the asker's memories kept in that chat, from the asker's own words), no chat title, no Google Drive, nothing on a computer or in the person's signed-in
 * browser, no room reading (rooms, room_read, room_file, save_room_file). Posting is there (docs/DECISIONS.md "Sending
 * to a person or a room from a shared chat"): post_to_room sends as the person whose turn it is, after their yes on its
 * card, which only they see; it brings nothing into the chat. The connections' tools are not listed here: chat/tools.ts
 * adds them in a shared chat from the connections' provider in its shared mode, each call behind the asker's card where
 * someone here could not see the answer (docs/decisions/20261118-shared-chat-connections.md).
 */
export const SHARED_TOOLS: ReadonlySet<string> = new Set([
  ...Object.keys(FILE_TOOLS),
  'edit_files', 'skill', 'find_skills', 'ask_user', 'todo_write',
  // the app's own docs (docs-help/tool.ts): public pages, nothing about anyone here
  'trina_docs',
  'make_file', 'edit_hwp', 'stamp_pdf', 'edit_pdf', 'merge_pdfs', 'split_pdf', 'resize_images', 'unzip_file', 'make_zip', 'query_data', 'hwp_render', 'move_files', 'copy_files', 'rename_file', 'share_file', 'artifact', 'web_fetch', 'save_url',
  // Word comments on a team .docx (tools/comment-docx.ts; limits audit 1 #22): a team file in, a new version or a new
  // .docx out, as edit_hwp; the document counts as read (chat/tools.ts), a new file goes through the write gates
  'comment_docx',
  // a Word, Excel or PowerPoint file changed in place: a new version of a chat file (P4,
  // docs/decisions/20261121-ai-edits-chat-files.md) or of a team file the asker may change, as edit_hwp and comment_docx
  // (S-028, docs/decisions/20261122-shared-chat-team-office-edit.md): the document counts as read, `output` is a write
  // target, and what the chat read is weighed by confirmSources before it goes into the file
  'edit_office',
  // many renames in one call (tools/file-moves.ts), like rename_file: what each names counts as read (namedPaths)
  'rename_files',
  // the original of a Gmail attachment the asker's connection gave in this chat (tools/save-connector-file.ts; drive:
  // refuses in a shared chat)
  'save_connector_file',
  // a file sent from the computer in a chat shared with people (chat/chat-file-tool.ts), and its copy into the team
  // folder behind the wider-audience card
  'chat_file', 'save_chat_file', 'restore_chat_file',
  // a command's finished file attached to the answer for everyone here (chat/work-file-tool.ts, chat mode): offered
  // only in a chat shared with people whose commands run in its own work folder
  'save_work_file',
  // "send these to bob" (chat/post-to-room.ts): as the turn's own person, behind their card
  'post_to_room',
  // "share these photos with bob" (chat/share-with-person.ts): the turn's own person's files, behind their card
  'share_with_person',
  // "stop sharing the quote with bob" (chat/stop-sharing.ts): only narrows, the turn's own person's files
  'stop_sharing',
  // "share the folder Work with bob" (chat/share-folder.ts): the turn's own person's folder, only when their own message
  // names it in a chat with other people's words; an add always behind their card
  'share_folder',
  // "why can't Jun see this chat?" (chat/who-can-open.ts): read-only; there only the chat itself and a file the asker
  // named or attached
  'who_can_open',
  // "use the price Bob put in the thread" (chat/answer-comments.ts): read-only, this chat's comments the asker sees
  'answer_comments',
  // "unzip this" (devenv/tool.ts): a command sees only what everyone in the chat may read
  // (docs/decisions/20261118-devenv-shared-chats.md)
  'box_shell',
  // "every Monday at 9, summarize this here" (tools/schedules.ts): behind the asker's card; a task made here runs as
  // them, in this chat, with its gates (chat/schedules.ts postsInto); list and delete see only this chat's tasks
  // (docs/decisions/20261118-shared-schedules-any-frequency.md)
  'schedule_create', 'schedule_list', 'schedule_delete',
  // videos (tools/higgsfield.ts behind the asker's card; promo-video/: the chat's artifact, its material and pictures
  // weighed by the read card like any named file, namedPaths)
  'generate_video', 'promo_video', 'promo_video_versions', 'save_promo_video',
  // "delete the files you just made" (chat/delete-files.ts, docs/decisions/20261121-ai-scratch-files.md rule 4): only
  // the AI's own files of this chat, made by this person's answers here, go to the trash (no card); any other path is
  // refused up front ('shared'), never a card. Not in a confidential or template chat, never a sub-agent's
  // (QA TC-7332: left out of this list, the AI said it could not delete in a shared project chat)
  'delete_files',
  // the asker's own memory (chat/tools.ts remember, forget; docs/decisions/20261125-auto-memory-shared-chats.md): what the
  // asker said here is kept in the asker's own memory, other people's words are checked as tool output, and only the
  // memories kept in this very chat are seen or changed here. A member's only (SHARED_MEMBER_ONLY_TOOLS)
  'remember', 'forget',
  // the demo's banner words (tools/demo-banner.ts; offered only on a demo with a banner kit): a local tool like make_file,
  // the banner saved into the project's folder through the write gates (WRITE_TARGET_ARGS, SAVE_CARD_TOOLS). Missing
  // here, a shared project chat never had it: the AI took 13 steps and saved a junk SVG (demo re-test 11-22)
  'change_banner_text',
])

/** Tools of SHARED_TOOLS a guest's turn in a shared chat never gets (a guest keeps no memories there) */
export const SHARED_MEMBER_ONLY_TOOLS: ReadonlySet<string> = new Set(['remember', 'forget'])

/** The arguments that name where a call writes, per tool: a shared chat's read card counts them only when something
 * is there already (chat/turn.ts sharedSources); every other path argument counts as a read. */
export const WRITE_TARGET_ARGS: Readonly<Record<string, readonly string[]>> = {
  write: ['file_path'], edit: ['file_path'], make_file: ['output'], edit_hwp: ['output'], stamp_pdf: ['output'], edit_pdf: ['output'], merge_pdfs: ['output'], split_pdf: ['output_folder'], resize_images: ['output', 'output_folder'], unzip_file: ['to_folder'], make_zip: ['output'], query_data: ['save_as'], save_url: ['save_as'], change_banner_text: ['save_as', 'source'], save_chat_file: ['save_as'], save_work_file: ['save_as'],
  move_files: ['to_folder'], copy_files: ['to_folder'], rename_file: ['new_name'],

  // (QA TC-4968: its save_as counted as a read, so a save into the asker's own folder raised the read card)
  save_connector_file: ['save_as'], save_room_file: ['save_as'], comment_docx: ['output'], skill_files: ['to_folder'], save_promo_video: ['save_as'],
  // an Office file changed in place, or saved as a new file of the same format with `output` (tools/edit-office.ts)
  edit_office: ['output'],
}

/** The tools that add an extension to the `output` they are given, each by its own rule (make_file's format, ".pdf",
 * ".docx", Hangul's own; resize_images: every path it may write, the card asks when any of them is there): a shared
 * chat's card weighs the path the tool will really write (security re-review of #1314:
 * "users/alice/hb" saved over an existing hb.pdf with no card, and the answer said it was there). */
export const OUTPUT_PATH_OF: Readonly<Record<string, (output: string, args: Record<string, unknown>) => string | readonly string[]>> = {
  make_file: (o, a) => (typeof a.format === 'string' ? makeFileOutputPath(o, a.format) : o),
  edit_pdf: (o) => pdfOutputPath(o),
  merge_pdfs: (o) => pdfOutputPath(o),
  stamp_pdf: (o) => stampOutputOf(o) ?? o,
  edit_hwp: (o, a) => hwpOutputPath(o, typeof a.file_path === 'string' ? a.file_path : ''),
  comment_docx: (o) => commentDocxOutput(o),
  edit_office: (o, a) => editOfficeOutput(o, typeof a.file_path === 'string' ? a.file_path : ''),
  // the copy's own format picks its extension (tools/resize-images.ts): the typed path, or its stem with any of them
  resize_images: (o) => { const stem = o.replace(/\/+$/, '').replace(/\.(jpe?g|png|webp|heic|heif)$/i, ''); return [o, ...['jpg', 'jpeg', 'png', 'webp'].map((e) => `${stem}.${e}`)] },
}

/** The tools of WRITE_TARGET_ARGS that save what they made or fetched: in a shared chat, a place there already that
 * some of its people cannot open asks on the save card (docs/decisions/20261118-shared-save-card-wording.md); 'many':
 * the card says "files" (one call can save several). Every entry of WRITE_TARGET_ARGS is here or in
 * WRITE_TARGET_NOT_SAVES (tests/unit/b-shared-save-card.test.ts). save_chat_file and make_zip: their own pull requests
 * add their WRITE_TARGET_ARGS entries. */
export const SAVE_CARD_TOOLS: Readonly<Record<string, 'one' | 'many'>> = {
  write: 'one', make_file: 'one', edit_hwp: 'one', stamp_pdf: 'one', edit_pdf: 'one', merge_pdfs: 'one', comment_docx: 'one', edit_office: 'one',
  save_url: 'one', change_banner_text: 'many', save_connector_file: 'one', save_room_file: 'one', save_promo_video: 'one', save_chat_file: 'one', save_work_file: 'one', make_zip: 'one',
  split_pdf: 'many', resize_images: 'many', unzip_file: 'many',
  // a query's result as a file, or one file per value with split_by (tools/query-data.ts)
  query_data: 'many',
}

/** The tools of WRITE_TARGET_ARGS whose card for a place that is there already does not say "save": an edit gives back
 * lines of the file it changed, and a move, copy or rename takes files the person has into that place. They keep the
 * read card. */
export const WRITE_TARGET_NOT_SAVES: ReadonlySet<string> = new Set(['edit', 'move_files', 'copy_files', 'rename_file', 'skill_files'])

/** Every team path a call names, nested ones too: the top-level PATH_ARGS, and the files inside edit_pdf's operations
 * (insert_pdf.file, stamp_image.image) and merge_pdfs' list ({ path } entries). A shared chat's read card and its
 * steps use this, so a file named inside a list is weighed like one named at the top. */
export function namedPaths(tool: string, input: unknown): { key: string; value: string }[] {
  const a = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
  const out: { key: string; value: string }[] = []
  // save_work_file's `path` is in the chat's work folder (chat/work-file-tool.ts), never a team path: no read card for it
  for (const k of PATH_ARGS) {
    if (tool === 'save_work_file' && k === 'path') continue
    for (const v of Array.isArray(a[k]) ? a[k] as unknown[] : [a[k]]) if (typeof v === 'string') out.push({ key: k, value: v })
  }
  if (tool === 'edit_pdf' && Array.isArray(a.operations)) {
    for (const op of a.operations as Record<string, unknown>[]) {
      const ins = op?.insert_pdf as { file?: unknown } | undefined
      const st = op?.stamp_image as { image?: unknown } | undefined
      if (typeof ins?.file === 'string') out.push({ key: 'insert_pdf.file', value: ins.file })
      if (typeof st?.image === 'string') out.push({ key: 'stamp_image.image', value: st.image })
    }
  }
  // edit_office's pictures (tools/edit-office.ts replace_picture.image, insert_picture.image): files whose bytes go into the
  // document, weighed by a shared chat's read card like the document itself (S-028 plan review)
  if (tool === 'edit_office' && Array.isArray(a.changes)) {
    for (const c of a.changes as unknown[]) {
      for (const k of ['replace_picture', 'insert_picture'] as const) {
        const img = c && typeof c === 'object' ? (c as Record<string, { image?: unknown } | undefined>)[k]?.image : undefined
        if (typeof img === 'string') out.push({ key: `${k}.image`, value: img })
      }
    }
  }
  // edit_hwp's signature or seal pictures (tools/edit-hwp.ts image changes): team files whose bytes go into the document
  if (tool === 'edit_hwp' && Array.isArray(a.changes)) {
    for (const c of a.changes as unknown[]) {
      const img = c && typeof c === 'object' ? (c as { image?: unknown }).image : undefined
      if (typeof img === 'string') out.push({ key: 'change.image', value: img })
    }
  }
  // rename_files: each listed file or folder, and the folder a pattern renames in (its names are read)
  if (tool === 'rename_files') {
    if (Array.isArray(a.renames)) for (const r of a.renames as unknown[]) { const p = r && typeof r === 'object' ? (r as { path?: unknown }).path : undefined; if (typeof p === 'string') out.push({ key: 'path', value: p }) }
    if (typeof a.folder === 'string') out.push({ key: 'path', value: a.folder })
  }
  // promo_video's logo and the pictures of its beats (promo-video/spec.ts): team files whose content goes into the video
  if (tool === 'promo_video') {
    if (typeof a.logo === 'string') out.push({ key: 'logo', value: a.logo })
    for (const beat of ['promise', 'work', 'proof']) {
      const pic = (a[beat] as { picture?: unknown } | undefined)?.picture
      if (typeof pic === 'string') out.push({ key: `${beat}.picture`, value: pic })
    }
  }
  if (tool === 'merge_pdfs' && Array.isArray(a.files)) {
    for (const f of a.files as unknown[]) {
      const p = typeof f === 'string' ? f : f && typeof f === 'object' ? (f as { path?: unknown }).path : undefined
      if (typeof p === 'string') out.push({ key: 'files', value: p })
    }
  }
  return out
}

/** Tools that look through a folder and everything under it; in a shared chat without a path, the project folder. */
export const SEARCH_TOOLS: ReadonlySet<string> = new Set(['grep', 'glob'])

/**
 * Tools that change nothing (they read, search, ask the person, or answer in the chat itself). After a room read every
 * other tool, connections' tools and tools added later included (fails closed), waits for the person to allow that one
 * call on a card first (chat/turn.ts confirmRoomChange; ROOMS_SEEN_READ_ONLY_TOOLS below): the room's messages are
 * other people's words, and one of them may tell the AI to change something.
 */
export const ROOM_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'list', 'glob', 'grep', 'read', 'skill', 'find_skills', 'ask_user', 'todo_write', 'hwp_render', 'share_file', 'artifact', 'web_fetch',
  'room_file',
  // the chat's promo video versions (promo-video/tool.ts): reads them only
  'promo_video_versions',
  // the app's own docs on this server (docs-help/tool.ts): reads them only
  'trina_docs',
])

/**
 * Tools whose calls of one answer may run at the same time on its tool connection (mcp/socket.ts CallQueue): those of
 * ROOM_READ_ONLY_TOOLS that only read team files and add to the turn's read scope and sources (each add is done
 * without a wait in between, files/service.ts TurnFiles). Every other tool, unknown ones and tools added later
 * included (fails closed), runs alone and in order. Left out on purpose: ask_user, share_file, artifact, web_fetch
 * (cards, links and chat output), room_file (it patches its step: TurnExec.patchToolStep matches
 * calls to steps first in, first out per tool), skill, find_skills and hwp_render (not needed side by side).
 */
export const PARALLEL_READ_TOOLS: ReadonlySet<string> = new Set(
  ['list', 'glob', 'grep', 'read'].filter((t) => ROOM_READ_ONLY_TOOLS.has(t)))

/** The arguments of our tools that name a team path (chat/turn.ts: what a call names joins the read scope). */
export const PATH_ARGS: readonly string[] = ['file_path', 'path', 'source', 'output', 'template', 'from', 'to', 'to_folder', 'destination', 'file_paths', 'paths', 'sources', 'images', 'image', 'output_folder', 'save_as']

/**
 * A person's own AI chat that has read their team chat rooms (chat/read-rooms.ts: chats.rooms_seen after a room tool,
 * chat/room-tools.ts; a ✦ side chat; another person's message quoted on the branch; docs/DECISIONS.md
 * "내 AI 채팅에서 대화방 읽기"): the tools that go on without the room card there. The read-only tools above, the room
 * tools themselves, and the own chat's other tools that only read or look (the scheduled tasks' list, Google
 * Drive's search, list and read, finding a connection's tools, the in-app browser's reading tools). set_title names the
 * chat for the person alone; remember raises its own card with the text it would keep (chat/tools.ts), post_to_room
 * its own card with the room and all of the text, which leads with the room line (chat/post-to-room.ts), and
 * change_project_members its own card that leads with the room line and names every person and group in full, marking
 * in red a name not in the person's own messages (chat/project-members.ts): no room card before any of them. A connection's read that the service marks read-only, whose
 * arguments carry no address or random-looking part, goes on too (chat/turn.ts confirmRoomChange; not api_request's
 * GET), and the tools with a card of their own ask there alone (ROOMS_SEEN_OWN_CARD_TOOLS, a connection's write).
 * delete_files asks on its own card every time, which leads with the room line (chat/delete-files.ts); skill_files into
 * a skill folder refuses there (chat/skill-files.ts). Every
 * other tool (writes, the browser's clicks and pages, box_shell, forget, tools added later) waits for the person's yes on
 * the room card for the rest of that chat (fails closed), but a new file in the person's own folder, and a new team file
 * the person allowed for the answer or the room (chat/turn.ts confirmRoomChange; docs/DECISIONS.md "대화방을 읽은 뒤 카드
 * 줄이기").
 */
export const ROOMS_SEEN_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  ...ROOM_READ_ONLY_TOOLS, 'rooms', 'room_read', 'room_file', 'set_title', 'remember', 'post_to_room', 'share_with_person', 'stop_sharing', 'share_folder', 'change_project_members', 'change_folder_access', 'delete_files', 'who_can_open', 'find_tools', 'schedule_list', 'drive_search', 'drive_list', 'drive_read',
  // they list names only and change nothing (chat/shared-with-me-tool.ts, chat/looking-at.ts)
  'shared_with_me', 'looking_at',
  // the folders the person can open, each with its access (chat/my-folders.ts): it changes nothing
  'my_folders',
  // the comments under answers in this chat, read like a room (chat/answer-comments.ts): it changes nothing
  'answer_comments',
])
/** ...and the in-app browser's reading tools, only in a turn that has the browser (by name otherwise: no exemption) */
export const ROOMS_SEEN_BROWSER_READ_TOOLS: ReadonlySet<string> = new Set(['read_page', 'get_page_text', 'find', 'tabs_context', 'read_console_messages', 'read_network_requests'])
/**
 * Tools whose own card shows everything the call does: after a room read in the person's own chat the room card is
 * not raised for them; their card is the call's only one, carries the room card's line and asks every time
 * (TurnPerson.roomsSeen; chat/turn.ts ownCard), unless the person chose "Always allow" for it (Rule A, also in their
 * scheduled run). A connection's tools join them by provider (chat/tools.ts connection).
 * A tool listed here must never act without asking when TurnPerson.roomsSeen is set.
 */
export const ROOMS_SEEN_OWN_CARD_TOOLS: ReadonlySet<string> = new Set(['schedule_create', 'generate_video', 'move_files', 'copy_files', 'move_skill', 'connect_service'])

/**
 * A person's own AI chat (docs/DECISIONS.md "대화방을 읽은 뒤 카드 줄이기"): the tools whose use keeps what the chat holds
 * to the team's own words: ROOM_FILE_TOOLS, with reading one of the person's rooms (room_read: its
 * words are what a room card weighs, its room joins the read scope) and naming the chat or keeping a memory (nothing
 * comes in). Any other tool (the web and its search, a connection's tools and call_tool, Google Drive, the browser,
 * box_shell, video, tools added later: fails closed) marks the chat as having used something from outside
 * (chats.room_outside, until a new session: an own chat's session carries earlier answers), and then no room card is
 * skipped there. So does `rooms`: its list names other rooms (a group chat's name is its members' words) without
 * putting them in the read scope, so their members would not be weighed.
 */
export const OWN_CHAT_TEAM_TOOLS: ReadonlySet<string> = new Set([...ROOM_FILE_TOOLS, 'room_read', 'answer_comments', 'set_title', 'remember'])

/** Tools that only make, change, send or list the person's own things and fetch nothing from outside the team (a subset
 * of OWN_WORDS_TOOLS: never a sub-agent, a skill or a new connection): they never mark a chat as having used something
 * from outside (chat/turn.ts noteRoomTool). Before 2026-11-23 a make_file or a post_to_room did, so a chat that only made
 * a file and sent it read as "used something from outside" (chats.room_outside, QA F5: docs/decisions/20261123-do-then-undo.md) */
export const NO_OUTSIDE_TOOLS: ReadonlySet<string> = new Set([
  'edit_files', 'comment_docx', 'edit_office', 'ask_user', 'todo_write',
  'make_file', 'edit_hwp', 'stamp_pdf', 'edit_pdf', 'merge_pdfs', 'split_pdf', 'resize_images', 'unzip_file', 'make_zip', 'query_data', 'hwp_render', 'move_files', 'copy_files', 'rename_file', 'delete_files', 'share_file', 'artifact',
  'set_title', 'remember', 'forget', 'post_to_room', 'share_with_person', 'stop_sharing', 'share_folder', 'change_project_members', 'change_folder_access',
  'schedule_create', 'schedule_list', 'schedule_delete', 'move_skill', 'rename_files', 'save_work_file',
  // the app's own docs, read on this server (docs-help/tool.ts)
  'trina_docs',
])

/**
 * Tools that by themselves bring nothing another person wrote into a person's own chat (chat/turn.ts noteOthersTool;
 * docs/decisions/20261116-always-allow-more-cards.md "Content written by others"): the file tools (what they read is
 * weighed file by file, by who wrote it: noteOthersReads), the tools that only write, ask the person or act for them,
 * and the lists of the person's own things. Any other tool (the web and its search, the browser, Google Drive, Slack,
 * a room's messages and files, find_skills (other people's skill descriptions), save_url, box_shell, tools added
 * later: fails closed) marks the chat as holding other
 * people's words; a connection's tools mark it when the service answers (connections/tools.ts noteAnswer).
 */
export const OWN_WORDS_TOOLS: ReadonlySet<string> = new Set([
  ...Object.keys(FILE_TOOLS), 'edit_files', 'comment_docx', 'edit_office', 'skill', 'ask_user', 'todo_write', 'agent', 'Agent', 'Task',
  'make_file', 'edit_hwp', 'stamp_pdf', 'edit_pdf', 'merge_pdfs', 'split_pdf', 'resize_images', 'unzip_file', 'make_zip', 'query_data', 'hwp_render', 'move_files', 'copy_files', 'rename_file', 'delete_files', 'share_file', 'artifact',
  'set_title', 'remember', 'forget', 'connect_service', 'post_to_room', 'share_with_person', 'stop_sharing', 'share_folder', 'change_project_members', 'change_folder_access',
  'schedule_create', 'schedule_list', 'schedule_delete', 'move_skill', 'skill_files', 'generate_video', 'save_promo_video',
  'rename_files',
  // a finished work-folder file put into the team folder (chat/work-file-tool.ts): it only writes
  'save_work_file',
  // the app's own docs, shipped with this server's version (docs-help/tool.ts): nobody here or outside wrote them for
  // this chat, as with the app's own instructions
  'trina_docs',
])
