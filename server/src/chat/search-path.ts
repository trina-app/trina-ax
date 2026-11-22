// Where a chat's search looks when the AI gives no folder (docs/DECISIONS.md "Shared project chats"): in a shared chat
// a search without a path never starts at the team root (TurnExec.sharedArgs); "/" alone asks a shared project chat's
// search for every folder the person can open, behind the read card.
/** A search's path that names no folder: none, empty, or only separators and "." ("/", "./", "//", "\\", " . ") —
 * the team root, which a shared chat never searches by default (TurnExec.sharedArgs). */
export const noSearchPath = (p: unknown): boolean => typeof p !== 'string' || p.replace(/\\/g, '/').split('/').every((s) => s.trim() === '' || s.trim() === '.')
/** The path that asks a shared project chat's search to look through every team folder the person can open (the read card
 * asks first for what some of the chat's people cannot open): "/" alone. Any other path without a folder stays in the
 * project folder (TurnExec.sharedArgs). */
export const WHOLE_TEAM_PATH = '/'
export const wholeTeamPath = (p: unknown): boolean => typeof p === 'string' && p.trim() === WHOLE_TEAM_PATH
/** The calls (their argument objects) of a shared project chat's "/" search: it leaves out the person's own folder
 * (files/service.ts glob and grep, TurnExec.sharedSources), which is searched only by its own path, behind the read
 * card. Set before the call runs (chat/tools.ts beforeFileTool); a WeakSet, so nothing is kept after the call. */
export const SKIP_OWN = new WeakSet<object>()
/** The calls (their argument objects) of a shared chat's search or listing in a folder everyone in the chat can open,
 * with the places below it that some of them cannot open (chat/turn.ts sharedSearchLeftOut): the call runs with those
 * hidden (mcp/protocol.ts), so no read card asks about them, and its result says how many the person could have seen
 * (SEARCH_LEFT_OUT_NOTE). Set before the call runs (chat/tools.ts beforeFileTool); a WeakMap, kept no longer than the call. */
export const SEARCH_LEFT_OUT = new WeakMap<object, { scope: { userId: string; folders: readonly string[] }; count: number }>()
/** What such a search's result tells the AI: a count, never a name (QA TC-f1x S-005/S-012). */
export const searchLeftOutNote = (n: number): string => `(${n} folder${n === 1 ? ' here was' : 's here were'} left out because not everyone in this chat can open ${n === 1 ? 'it' : 'them'}; name one to look inside (that asks first).)`
/** What a search that stayed in a shared project chat's folder tells the AI, once a turn (the AI took a project-only
 * result for the whole team folder: AI scenario FIND-01.project, 2026-11-17). Names no folder: the AI writes where
 * everyone in the chat reads. */
export const PROJECT_SEARCH_NOTE = `(Only this project's folder was searched: the other team folders the user can open were not (in this shared chat grep and glob without a path stay in the project folder), so the file asked for, or another version of it such as the editable original of a scan, may be there. When the user asks where a file is, or the file they want was not found here, search again before you answer, with path "${WHOLE_TEAM_PATH}": it looks through every team folder the user can open (not their own folder), and where some people here cannot open one, the user is asked first on a card only they see. Their own folder is searched only by its own path, when they ask for it. Until then, do not call a result here the only one, and do not say a file does not exist.)`
/** A shared project chat's search that looks only in the project folder: no path (sharedArgs keeps it there), or a
 * path that is the project folder or inside it. "/" and any other folder are not. */
export const inProjectOnly = (p: unknown, projectFolder: string): boolean => {
  if (wholeTeamPath(p)) return false
  if (noSearchPath(p)) return true
  const norm = (x: string) => x.normalize('NFC').replace(/\\/g, '/').split('/').filter((s) => s && s !== '.').join('/').toLowerCase()
  const k = norm(p as string), d = norm(projectFolder)
  return !!d && (k === d || k.startsWith(d + '/'))
}
/** A glob without a path whose pattern starts with plain folder names (users/mina followed by a wildcard part): the same search with
 * those folders as its path and the rest as its pattern (path users/mina, pattern the wildcard part; glob matches the
 * pattern below its path, files/service.ts). A shared chat's search without a path never reaches a folder (TurnExec
 * sharedArgs), so the folder the AI meant is named as the path, where the read card asks for it like any path (QA
 * TC-7041: "my folder's proposal" was refused as a search without a folder). Anything else: null. The last segment
 * stays the pattern, so a pattern that is all names ("users/mina/a.html") searches its folder for that name. */
export function globFolderPrefix(args: unknown): { path: string; pattern: string } | null {
  if (!args || typeof args !== 'object') return null
  const a = args as { path?: unknown; pattern?: unknown }
  if (!noSearchPath(a.path) || typeof a.pattern !== 'string') return null
  const segs = a.pattern.split('/')
  // (a backslash escapes in a glob: a segment with one is not a plain name)
  const plain = (s: string) => s.trim() !== '' && s !== '.' && s !== '..' && !/[*?[\]{}!\\]/.test(s)
  let n = 0
  while (n < segs.length - 1 && plain(segs[n]!)) n++
  if (n === 0) return null
  const rest = segs.slice(n).join('/')
  if (!rest.trim()) return null
  return { path: segs.slice(0, n).join('/'), pattern: rest }
}
