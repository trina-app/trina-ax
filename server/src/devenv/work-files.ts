// The files box_shell's commands made in a chat's work folder ($TRINA_WORK), opened by the server for the AI
// (docs/decisions/20261121-ai-sees-and-saves-workspace-output.md): `read` shows them (pictures, video frames, PDF pages,
// text) and save_work_file hands a finished one over. The work folder is written by sandboxed commands at any time, so
// a file is opened only like this:
//   - its path is the work folder's real path plus a relative path with no "..", no empty part and no absolute part;
//   - the last part is opened with O_NOFOLLOW (a link there is refused), the file must be a regular file with one link
//     (a hard link to a server file is refused), and the kernel's path of the OPEN file (devenv/snapshot.ts
//     openFilePath: /proc/self/fd on Linux, F_GETPATH on macOS) must be inside the work folder, which also covers a
//     folder on the way swapped for a link. No kernel path: refused (no fallback);
//   - its bytes are streamed from that one descriptor into a server-only copy, and everything after works on the copy.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Denied, ToolError } from '../policy/errors'
import { openFilePath } from './snapshot'

/** where a work folder is, for the person and chat of a turn: its real path, and the path as made (they differ where a
 * folder on the way is a link, such as /tmp on macOS) */
export interface WorkFolder { real: string; path: string }

const C = fs.constants
/** "$TRINA_WORK/…", "${TRINA_WORK}/…" and the chat place form "chat:work/…" (shared/src/places.ts) */
const PREFIX = /^(?:\$\{?TRINA_WORK\}?|chat:work)(?=\/|$)/i

/** Does this path name the work folder (by its variable)? */
export const namesWorkFolder = (p: unknown): boolean => typeof p === 'string' && PREFIX.test(p.trim())

/** The path in the work folder that `input` names ($TRINA_WORK/…, or the folder's absolute path as a command prints it),
 * or null when it names none. `''` for the folder itself. */
export function workRel(input: string, wf: WorkFolder): string | null {
  let p = input.trim().replace(/\\/g, '/')
  if (PREFIX.test(p)) p = p.replace(PREFIX, '')
  else {
    const root = [wf.real, wf.path].map((r) => r.replace(/\/+$/, '')).find((r) => p === r || p.startsWith(r + '/'))
    if (!root) return null
    p = p.slice(root.length)
  }
  p = p.replace(/^\/+/, '')
  const segs = p.split('/').filter((s) => s !== '.')
  if (segs.length === 1 && segs[0] === '') return ''
  if (segs.some((s) => s === '' || s === '..' || s.includes('\u0000'))) throw new ToolError('a path in the work folder has no "..", "//" or other folders around it', 'bad_path')
  return segs.join('/')
}

/** Is `input` a path in this work folder (by the variable, or the folder's absolute path)? */
export function isWorkPath(input: unknown, wf: WorkFolder | null): boolean {
  if (typeof input !== 'string') return false
  if (namesWorkFolder(input)) return true
  if (!wf) return false
  const p = input.trim()
  return [wf.real, wf.path].some((r) => p === r || p.startsWith(r.replace(/\/+$/, '') + '/'))
}

/** How the AI and the person see a work-folder path: never the server's absolute path */
export const shownWorkPath = (rel: string) => (rel ? `$TRINA_WORK/${rel}` : '$TRINA_WORK')

/** Why a chat has no work folder to open now (QA TC-6936): one reason for every spelling of the path ($TRINA_WORK/…,
 * ${TRINA_WORK}/…, the folder's absolute path, chat:work/…) and every tool (read, list, glob, grep, copy_files,
 * save_work_file). The turn knows which (chat/tools.ts TurnFiles.workWhy):
 *   none      the commands run in a work folder here, and none ran yet (or it was emptied)
 *   changed   a chat shared with people whose people (or what they may open) changed: its commands start in a new folder
 *   off       the person may not run commands now
 *   elsewhere this chat has no work folder (a project chat's commands run in the project folder; no box_shell here)
 *   helper    a sub-agent: only the chat's main AI opens it */
export type NoWorkWhy = 'none' | 'changed' | 'off' | 'elsewhere' | 'helper'

/** The words for the AI, plain enough to pass on: no "sub-agent" or "dev environment" unless that is the reason */
export const NO_WORK_WORDS: Record<NoWorkWhy, string> = {
  none: "This chat's work folder has nothing in it yet: no command has run here. Make the file with a box_shell command first, or bring a team file in with copy_files (to_folder \"chat:work/\").",
  changed: "The people in this chat (or what they may open) changed, so its commands now start in a new, empty work folder: the files made or copied there before are not in it. Copy them in again (copy_files to_folder \"chat:work/\") or make them again, and tell the person why in these plain words.",
  off: 'Commands are turned off for this person now, so this chat\'s work folder cannot be opened.',
  elsewhere: "This chat has no work folder: its commands do not run in one (in a project chat they run in the project folder; read files there by their team path).",
  helper: "Only the chat's own assistant opens its work folder: say in your report which file in it to look at.",
}

/** write and edit of a work-folder path (any spelling): what to do instead (QA TC-6938, where the AI then saved an extra
 * copy in the person's own folder that nobody asked for) */
export const WORK_WRITE_WORDS = "write and edit do not change the work folder. Make a file there with a box_shell command (it starts in the work folder: cat > report.txt <<'EOF' … EOF), or bring a team file in with copy_files (to_folder \"chat:work/\"). To hand a finished file over, copy_files it from chat:work/… to chat:files/ in a chat shared with people (in a chat only the person sees: to their own folder). Do not save an extra copy anywhere the person did not ask for."

/** After a not-found in a work folder made after the people of the chat changed: it may have been made before */
export const WORK_RENEWED_WORDS = "If it was made or copied before the people in this chat (or what they may open) changed, it is not here: commands now use a new work folder. Copy it in again (copy_files to_folder \"chat:work/\") or make it again."

/** The work folder could not be recorded for this answer (shared chats): the reason when the turn knows it, else "try
 * again" */
export const workUnavailableText = (why: NoWorkWhy | null | undefined) => (why === 'changed' || why === 'off' ? NO_WORK_WORDS[why] : "This chat's work folder cannot be opened right now. Try again.")

/** The refusal for this reason */
export const noWorkText = (why: NoWorkWhy | null | undefined) => NO_WORK_WORDS[why ?? 'elsewhere']

/** The path in the work folder that a $TRINA_WORK / ${TRINA_WORK} / chat:work spelling names, without the folder
 * itself ('' for the folder), or null for any other spelling. The same checks as workRel. */
export function workAliasRel(input: string): string | null {
  const p = input.trim().replace(/\\/g, '/')
  if (!PREFIX.test(p)) return null
  const segs = p.replace(PREFIX, '').replace(/^\/+/, '').split('/').filter((s) => s !== '.')
  if (segs.length === 1 && segs[0] === '') return ''
  if (segs.some((s) => s === '' || s === '..' || s.includes('\u0000'))) throw new ToolError('a path in the work folder has no "..", "//" or other folders around it', 'bad_path')
  return segs.join('/')
}

/** Stream the work-folder file `rel` into `dest` (a new file, 0600) from one descriptor opened as above; its size, its
 * sha256 and its name. ToolError/Denied with plain words for the AI. `max`: refused above this many bytes, before any
 * copy; `beforeCopy`: the caller's own check of the size (the team disk), also before any copy. */
export async function copyWorkFile(wf: WorkFolder, rel: string, dest: string, max: number, signal?: AbortSignal, o: { beforeCopy?: (size: number) => void } = {}): Promise<{ size: number; sha256: string; name: string }> {
  if (!rel) throw new ToolError('this is the work folder itself; name a file in it', 'is_folder')
  const shown = shownWorkPath(rel)
  const abs = path.join(wf.real, rel)
  const inside = (p: string) => p.startsWith(wf.real.replace(/\/+$/, '') + '/')
  // a folder on the way that is a link out of the work folder now (to /dev, a server folder): refused before anything
  // is opened there (opening a device can do something by itself). Not the check itself: the box can swap a folder
  // between this and the open, which the open file's kernel path below catches
  let parent: string | null = null
  try { parent = fs.realpathSync(path.dirname(abs)) } catch { parent = null }
  if (parent !== null && parent !== wf.real.replace(/\/+$/, '') && !inside(parent)) throw new Denied(`'${shown}' is not inside this chat's work folder (a link on the way is not followed)`)
  let fd: number
  try { fd = fs.openSync(abs, C.O_RDONLY | C.O_NOFOLLOW | (C.O_NONBLOCK ?? 0)) } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new ToolError(`'${shown}' was not found in this chat's work folder`, 'not_found')
    if (code === 'ELOOP' || code === 'EMLINK') throw new Denied(`'${shown}' is a link; links in the work folder are not followed`)
    if (code === 'EISDIR') throw new ToolError(`'${shown}' is a folder; list it with box_shell (ls)`, 'is_folder')
    throw new ToolError(`'${shown}' cannot be opened (${code})`)
  }
  let out: number | null = null
  try {
    const st = fs.fstatSync(fd)
    if (st.isDirectory()) throw new ToolError(`'${shown}' is a folder; list it with box_shell (ls)`, 'is_folder')
    if (!st.isFile()) throw new Denied(`'${shown}' is not a regular file`)
    if (st.nlink > 1) throw new Denied(`'${shown}' is a hard-linked file; those are refused`)
    let real: string | null = null
    try { real = openFilePath(fd) } catch { real = null }
    if (!real || !inside(real)) throw new Denied(`'${shown}' is not inside this chat's work folder (a link on the way is not followed)`)
    if (st.size > max) throw new ToolError(`'${shown}' is too large (${(st.size / 1024 ** 2).toFixed(0)} MB; at most ${(max / 1024 ** 2).toFixed(0)} MB here)`, 'too_large')
    o.beforeCopy?.(st.size)
    out = fs.openSync(dest, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600)
    const hash = crypto.createHash('sha256')
    const buf = Buffer.allocUnsafe(Math.min(4 * 1024 * 1024, Math.max(1, st.size)))
    let pos = 0
    // asynchronous reads and writes on the one checked descriptor: a large file (a 1 GB video) never holds the
    // server's event loop, and a stopped answer stops the copy between two pieces
    while (pos < st.size) {
      signal?.throwIfAborted()
      const n = await readAt(fd, buf, Math.min(buf.length, st.size - pos), pos)
      if (n <= 0) break
      const piece = buf.subarray(0, n)
      hash.update(piece)
      await writeAll(out, piece)
      pos += n
      if (pos > max) throw new ToolError(`'${shown}' is too large`, 'too_large')
    }
    return { size: pos, sha256: hash.digest('hex'), name: path.basename(rel) }
  } finally {
    fs.closeSync(fd)
    if (out !== null) fs.closeSync(out)
  }
}

const readAt = (fd: number, buf: Buffer, length: number, position: number) =>
  new Promise<number>((resolve, reject) => fs.read(fd, buf, 0, length, position, (e, n) => (e ? reject(e) : resolve(n))))
async function writeAll(fd: number, piece: Buffer) {
  let off = 0
  while (off < piece.length) off += await new Promise<number>((resolve, reject) => fs.write(fd, piece, off, piece.length - off, null, (e, n) => (e ? reject(e) : resolve(n))))
}

// ---------------- list, glob and grep of the work folder (chat:work/, plan 20261121-0615 P2) ----------------
// Names only for a listing (nothing is opened), and a grep opens each file like copyWorkFile does (O_NOFOLLOW, one link,
// the kernel's path of the open file inside the work folder). A link is shown as a link and never followed. Each folder
// is read by its path after its real path was checked to be exactly where the walk expects it, and checked again after
// its readdir: a folder swapped for a link in between shows nothing of it.

export interface WorkEntry { rel: string; kind: 'file' | 'folder' | 'link' | 'other'; size: number; mtime: string }

/** entries a walk looks at, at most (glob, grep) */
export const WORK_WALK_MAX = 5000
/** a grep opens text files of at most this size */
export const WORK_GREP_FILE_MAX = 4 * 1024 * 1024
/** a grep searches at most this much text in all (the files are copied for ripgrep first) */
export const WORK_GREP_TOTAL_MAX = 64 * 1024 * 1024

/** The entries directly in `rel` ('' for the folder itself), sorted by name; ToolError for a missing or non-folder. */
export function workEntries(wf: WorkFolder, rel: string): WorkEntry[] {
  const root = wf.real.replace(/\/+$/, '')
  const dir = rel ? path.join(root, ...rel.split('/')) : root
  const shown = shownWorkPath(rel)
  const expect = () => {
    let real: string
    try { real = fs.realpathSync(dir) } catch { throw new ToolError(`'${shown}' was not found in this chat's work folder`, 'not_found') }
    if (real !== dir) throw new Denied(`'${shown}' is not inside this chat's work folder (a link on the way is not followed)`)
    if (!fs.lstatSync(dir).isDirectory()) throw new ToolError(`'${shown}' is a file; read it with read`, 'not_folder')
  }
  expect()
  let names: fs.Dirent[]
  try { names = fs.readdirSync(dir, { withFileTypes: true }) } catch { throw new ToolError(`'${shown}' cannot be listed`, 'not_found') }
  expect()
  const out: WorkEntry[] = []
  for (const e of names.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name.includes('\u0000')) continue
    let st: fs.Stats
    try { st = fs.lstatSync(path.join(dir, e.name)) } catch { continue }
    const kind = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'folder' : st.isFile() ? 'file' : 'other'
    out.push({ rel: rel ? `${rel}/${e.name}` : e.name, kind, size: kind === 'file' ? st.size : 0, mtime: st.mtime.toISOString() })
  }
  return out
}

/** Every entry under `rel` (folders first walked in name order), at most `max`; `more` when the walk stopped there.
 * Links are listed and never entered. */
export function walkWork(wf: WorkFolder, rel: string, max = WORK_WALK_MAX): { entries: WorkEntry[]; more: boolean } {
  const entries: WorkEntry[] = []
  const todo = [rel]
  while (todo.length) {
    const at = todo.shift()!
    let list: WorkEntry[]
    try { list = workEntries(wf, at) } catch (e) { if (at === rel) throw e; continue }
    for (const e of list) {
      if (entries.length >= max) return { entries, more: true }
      entries.push(e)
      if (e.kind === 'folder') todo.push(e.rel)
    }
  }
  return { entries, more: false }
}

/** The text of a small work-folder file, opened as copyWorkFile opens one (nothing followed), or null when it is not a
 * regular file inside the work folder or is larger than `max`. */
export function readWorkSmall(wf: WorkFolder, rel: string, max = WORK_GREP_FILE_MAX): Buffer | null {
  let fd: number
  try { fd = fs.openSync(path.join(wf.real, rel), C.O_RDONLY | C.O_NOFOLLOW | (C.O_NONBLOCK ?? 0)) } catch { return null }
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile() || st.nlink > 1 || st.size > max) return null
    let real: string | null = null
    try { real = openFilePath(fd) } catch { real = null }
    if (!real || !real.startsWith(wf.real.replace(/\/+$/, '') + '/')) return null
    const buf = Buffer.alloc(st.size)
    let pos = 0
    while (pos < st.size) { const n = fs.readSync(fd, buf, pos, st.size - pos, pos); if (n <= 0) break; pos += n }
    return buf.subarray(0, pos)
  } finally { fs.closeSync(fd) }
}
