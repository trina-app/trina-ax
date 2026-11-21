// The one resolver of a file tool's path argument (docs/decisions/20261121-chat-places-as-paths.md, plan
// docs/AGENTS/plan/20261121-0615-chat-places-as-paths.md section 2): a team path, this chat's files (chat:files/…) or
// this chat's work folder (chat:work/…) → where the bytes are (storage), who can see them (viewers: the read scope's
// sources) and whether this call may write there (writable). Every tool that takes a chat place asks here; nothing else
// turns a chat place into storage.
//
// Contract for the builders of the later phases (P2 copy, P3 produce tools, P4 versions):
//   - resolvePlace never opens a file and never creates a folder: it looks up. Opening a chat file is ChatFiles.open
//     (and P4's root → head resolution inside chat/chat-files.ts); writing into the work folder is P2's in-sandbox
//     writer. Both are called through their own exports, never re-implemented here.
//   - Every call checks the person again (an inactive account: nothing) and their sight of the chat (seesChatFiles):
//     ChatFiles.open does not check the chat.
//   - A personal chat's upload (users/<id>/.attachments/…) and a team attachment stay team paths: chat:files/ names only
//     chat_files rows (review fix 1). The resolver never maps a team path to a chat file (review fix 7: only #207's
//     file-access lookup does that).
//   - Only the main AI of a chat turn reaches chat places (ResolveCtx.main); a sub-agent, remote MCP and a scheduled
//     template get `refused`.
import type { Database } from 'bun:sqlite'
import { parsePlace, type Place } from '@mycel/shared/places'
import { seesChatFiles } from '../chat/chat-files-access'
import type { ReadSource } from '../chat/read-scope'
import { noWorkText, type NoWorkWhy, type WorkFolder } from '../devenv/work-files'

/** chat:files/ where no chat files are reachable (the file tools and the resolver say the same): plain words first, so
 * what the AI passes on is "no files in this chat" (QA TC-6941), then where an attached file is read from */
export const CHAT_FILES_NONE = "This chat has no files of its own. A file someone attached to a message is read by the path shown with it in the conversation."

export type PlaceUse = 'read' | 'list' | 'write'

/** The turn as the resolver needs it (chat/turn.ts builds it; a test may build it by hand) */
export interface ResolveCtx {
  db: Database
  /** the person of the turn; checked again on every call */
  userId: string
  /** the chat of the turn; null outside a chat (remote MCP, a background job) */
  chatId: string | null
  /** the main AI of a chat turn (not a sub-agent, not remote MCP) */
  main: boolean
  /** what kind of chat: a personal one, shared with people, a shared project chat (its project folder is its place) */
  chatKind: 'personal' | 'people' | 'project' | 'locked' | 'scheduled' | 'guest'
  /** the turn has a hidden-answer (k) group: no new chat file may be attached in it */
  hiddenGroup?: boolean
  /** the chat's work folder now, looked up without creating it (TurnFiles.workFolder); null: none here */
  workFolder?: (() => WorkFolder | null) | null
  /** why there is no work folder now (TurnFiles.workWhy); absent: this chat has none */
  workWhy?: (() => NoWorkWhy) | null
  /** may a copy go into the work folder here (box_shell's commands of this person run in a work folder, made or not
   * yet: devenv/srt/runner.ts runsInWorkFolder)? The copy itself makes the folder (devenv/work-write.ts writeIntoWork) */
  workCopyIn?: (() => boolean) | null
  /** is the person's account active now (TurnExec.livePrincipal not throwing) */
  live: () => boolean
  /** a team path as the read scope records it (chat/read-scope.ts sourceOf with the team's rules) */
  teamSource?: (rel: string) => ReadSource
}

/** Where the bytes of a resolved path are; nothing is opened yet */
export type PlaceStorage =
  | { kind: 'team'; path: string }
  /** one chat file by id, or by name (the newest of that name the person may open: ChatFiles.open decides) */
  | { kind: 'chatFile'; chatId: string; id: string | null; name: string }
  /** the chat's file list */
  | { kind: 'chatFiles'; chatId: string }
  /** a path inside the work folder ('' for the folder itself); `folder` null only for a write (a copy in) before the
   * first command made it */
  | { kind: 'work'; folder: WorkFolder | null; rel: string }

export interface Resolved {
  /** the parsed place; `{ kind: 'team' }` for a team path */
  place: Place | { kind: 'team'; path: string }
  /** null when refused */
  storage: PlaceStorage | null
  /** the read scope's sources a read of it adds (its readers): a team path's folder, or the chat's people */
  viewers: ReadSource[]
  /** true, or the plain words of why this call may not write there */
  writable: true | string
  /** the plain words of why it may not be used at all (then storage is null) */
  refused?: string
}

export const PLACE_WORDS = {
  noChat: "A chat's own files and work folder open only inside that Trina chat.",
  notSeen: CHAT_FILES_NONE,
  projectSave: "In a project chat, files are saved in the project's folder, where its people find them: save it there.",
  personalSave: 'In a chat only the person sees, files are not attached to the chat: save it in My files (their own folder) and link it in the answer; a file already there needs nothing more.',
  hiddenTurn: 'This answer used a connection whose results some people who may join this chat cannot see, so it cannot attach files to the chat.',
  lockedSave: 'Files are not attached in a confidential chat.',
  workWrite: 'Files come into the work folder only with copy_files (to_folder "chat:work/…") or your box_shell commands, in a chat whose commands run in a work folder; write and edit do not change it.',
  inPlace: 'This tool does not change a chat file in place: write, edit and edit_office (without output) save a new version of it; this tool makes a new file (output chat:files/<new name>, or a team folder).',
  projectReadOnly: "In a project chat the chat's files are read-only: save a changed copy in the project folder (its path in projects/), where its people find it.",
  hiddenVersion: "This answer used a connection whose results some people who may join this chat cannot see, so it cannot change this chat's files.",
  versionNotHere: "A chat file is not changed here (a confidential chat, a scheduled run or a guest's chat): read it, and save a changed copy in a team folder.",
  noContinue: 'You cannot continue this chat now (it is in the trash, read-only, or no longer shared with you), so its files are not changed.',
} as const

/**
 * May this turn save a new version of an existing chat file (P4: ChatFiles.putVersion with origin 'ai')? The main AI of
 * a chat shared with people, or of a personal chat (a chat made private again keeps its chat files for its creator:
 * the caller finds the file), in an answer with no k group: putVersion itself does not know the turn, so this is the
 * check. A project chat's files are read-only (its project folder is its save place: owner, 2026-11-21). The chat being
 * continued by the person (chatFor 'continue') and the file itself are the caller's (chat/place-ctx.ts version).
 */
export function mayWriteChatVersion(c: ResolveCtx): true | string {
  if (!c.chatId || !c.main) return PLACE_WORDS.noChat
  if (!c.live()) return 'Access denied: this account is disabled.'
  if (c.chatKind === 'project') return PLACE_WORDS.projectReadOnly
  if (c.chatKind !== 'people' && c.chatKind !== 'personal') return PLACE_WORDS.versionNotHere
  if (c.hiddenGroup) return PLACE_WORDS.hiddenVersion
  return true
}

/** Who may write a chat file here: the chat kinds where an attach is a place of its own (plan section 2's table) */
function chatFileWritable(c: ResolveCtx, existing: boolean): true | string {
  // a new version of an existing chat file (P4)
  if (existing) return mayWriteChatVersion(c)
  if (c.chatKind === 'project') return PLACE_WORDS.projectSave
  if (c.chatKind === 'personal') return PLACE_WORDS.personalSave
  if (c.chatKind !== 'people') return PLACE_WORDS.lockedSave
  if (c.hiddenGroup) return PLACE_WORDS.hiddenTurn
  return true
}

/**
 * Resolve one path argument. A team path comes back as `{ kind: 'team' }` with its source (the team rules decide the
 * rest, as before: authorize); a chat place with its storage, viewers and writability, or `refused` in plain words.
 */
export function resolvePlace(input: string, c: ResolveCtx, use: PlaceUse): Resolved {
  const place = parsePlace(input)
  if (!place) {
    const p = input.trim()
    return { place: { kind: 'team', path: p }, storage: { kind: 'team', path: p }, viewers: c.teamSource ? [c.teamSource(p)] : [], writable: true }
  }
  const refuse = (why: string): Resolved => ({ place, storage: null, viewers: [], writable: why, refused: why })
  if (place.kind === 'reserved') return refuse(`${place.why}.`)
  if (!c.chatId || !c.main) return refuse(PLACE_WORDS.noChat)
  if (!c.live()) return refuse('Access denied: this account is disabled.')
  const chat: ReadSource = { type: 'chat', id: c.chatId }
  if (place.kind === 'work') {
    const folder = c.workFolder?.() ?? null
    // a copy in (P2) may make the folder; a read, a list or a search never does
    const copyIn = use === 'write' && (c.chatKind === 'people' || c.chatKind === 'personal') && !!c.workCopyIn?.()
    if (!folder && !copyIn) return refuse(noWorkText(c.workWhy?.()))
    // a shared chat's work folder is its people's (sharedWorkOf); a personal chat's is the person's own
    const viewers: ReadSource[] = c.chatKind === 'people' ? [chat] : [{ type: 'user', id: c.userId }]
    return { place, storage: { kind: 'work', folder, rel: place.rel }, viewers, writable: use === 'write' ? (copyIn ? true : PLACE_WORDS.workWrite) : true }
  }
  if (!seesChatFiles(c.db, c.userId, c.chatId)) return refuse(PLACE_WORDS.notSeen)
  if (!place.id && !place.name) return { place, storage: { kind: 'chatFiles', chatId: c.chatId }, viewers: [chat], writable: use === 'write' ? 'chat:files/ is the list of this chat\'s files; name a file in it.' : true }
  return { place, storage: { kind: 'chatFile', chatId: c.chatId, id: place.id, name: place.name }, viewers: [chat], writable: use === 'write' ? chatFileWritable(c, true) : true }
}

/** May a new chat file named `name` be attached in this turn (P3's `output: chat:files/<name>`)? true or the words */
export function mayAttachChatFile(c: ResolveCtx): true | string {
  if (!c.chatId || !c.main) return PLACE_WORDS.noChat
  if (!c.live()) return 'Access denied: this account is disabled.'
  return chatFileWritable(c, false)
}
