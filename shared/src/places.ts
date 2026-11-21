// The chat's own places as paths of the AI's file tools (docs/decisions/20261121-chat-places-as-paths.md, plan
// docs/AGENTS/plan/20261121-0615-chat-places-as-paths.md): beside a team path (shared/…, users/<id>/…, groups/…,
// projects/…, skills/…) a tool's path argument may name
//   chat:files/<name>            a file of this chat (chat_files: an upload in a chat shared with people, a file the AI
//   chat:files/<file_id>/<name>  attached to an answer, a share-time copy), by its name (the newest of that name) or id
//   chat:files/                  the chat's files (list, glob, grep)
//   chat:work/<path>             the chat's work folder for this person now ($TRINA_WORK of box_shell)
// The prefixes "chat:" and "room:" are reserved: a team path never starts with them (its first part is one of
// TOP_FOLDERS), and any other form under them is refused, never taken as a web address. One parser for the server and
// the web, so a step line and a link read the same.
import { isUuid7 } from './ids'

/** "chat:" or "room:" at the start, in any case: never a team path, never a web address */
const RESERVED = /^\s*(chat|room):/i

/** Does this path argument use a reserved place prefix (chat:, room:)? */
export const isReservedPlace = (p: unknown): boolean => typeof p === 'string' && RESERVED.test(p)

export type Place =
  /** chat:files/…: `id` when the path names the file by id, `name` its name ('' for the list itself) */
  | { kind: 'chatFiles'; id: string | null; name: string }
  /** chat:work/…: the path inside the work folder ('' for the folder itself) */
  | { kind: 'work'; rel: string }
  /** a reserved prefix this build does not take (room:…, chat:<anything else>, a bad path under one) */
  | { kind: 'reserved'; why: string }

/**
 * The place a path argument names, or null for anything that is not under a reserved prefix (a team path, a URL, a
 * connector id: each keeps its own handling).
 */
export function parsePlace(input: unknown): Place | null {
  if (typeof input !== 'string' || !isReservedPlace(input)) return null
  const raw = input.trim().replace(/\\/g, '/')
  const m = /^chat:(files|work)(?:\/(.*))?$/i.exec(raw)
  if (!m) return { kind: 'reserved', why: /^room:/i.test(raw) ? 'room files are not paths yet (use room_file)' : 'the only chat places are chat:files/ and chat:work/' }
  const rest = (m[2] ?? '').normalize('NFC')
  const segs = rest.split('/').filter((s, i, all) => s !== '' || i < all.length - 1).filter((s) => s !== '.')
  if (segs.some((s) => s === '' || s === '..' || /[\u0000-\u001f]/.test(s))) return { kind: 'reserved', why: 'a chat place path has no "..", "//" or control characters' }
  if (m[1]!.toLowerCase() === 'work') return { kind: 'work', rel: segs.join('/') }
  if (segs.length === 0) return { kind: 'chatFiles', id: null, name: '' }
  // chat:files/<id>/<name> or chat:files/<id> (the transcript's form), else chat:files/<name> (a name has no "/")
  if (isUuid7(segs[0])) {
    if (segs.length > 2) return { kind: 'reserved', why: 'chat files have no folders' }
    return { kind: 'chatFiles', id: segs[0]!, name: segs[1] ?? '' }
  }
  if (segs.length > 1) return { kind: 'reserved', why: 'chat files have no folders' }
  return { kind: 'chatFiles', id: null, name: segs[0]! }
}

/** The path the AI is told for a chat file (the transcript, results): by id, so two files of one name never mix. The
 * name is anyone's in the chat and goes inside our blocks (<attachments>, a tool result): no "<", ">", quote or line
 * break, so it never closes a block or opens one (the id finds the file; the name part is only read by people) */
export const chatFilePath = (id: string, name: string) => `chat:files/${id}/${name.replace(/[\r\n\u2028\u2029/\\<>"]+/g, ' ').trim() || 'file'}`

/** The work-folder path in the chat place form */
export const workPlacePath = (rel: string) => (rel ? `chat:work/${rel}` : 'chat:work/')
