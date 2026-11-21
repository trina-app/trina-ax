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
/** "$TRINA_WORK/…" and "${TRINA_WORK}/…" */
const PREFIX = /^\$\{?TRINA_WORK\}?(?=\/|$)/

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

/** Stream the work-folder file `rel` into `dest` (a new file, 0600) from one descriptor opened as above; its size, its
 * sha256 and its name. ToolError/Denied with plain words for the AI. `max`: refused above this many bytes, before any
 * copy. */
export async function copyWorkFile(wf: WorkFolder, rel: string, dest: string, max: number, signal?: AbortSignal): Promise<{ size: number; sha256: string; name: string }> {
  if (!rel) throw new ToolError('this is the work folder itself; name a file in it', 'is_folder')
  const shown = shownWorkPath(rel)
  const abs = path.join(wf.real, rel)
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
    if (!real || !real.startsWith(wf.real.replace(/\/+$/, '') + '/')) throw new Denied(`'${shown}' is not inside this chat's work folder (a link on the way is not followed)`)
    if (st.size > max) throw new ToolError(`'${shown}' is too large (${(st.size / 1024 ** 2).toFixed(0)} MB; at most ${(max / 1024 ** 2).toFixed(0)} MB here)`, 'too_large')
    out = fs.openSync(dest, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600)
    const hash = crypto.createHash('sha256')
    const buf = Buffer.allocUnsafe(Math.min(4 * 1024 * 1024, Math.max(1, st.size)))
    let pos = 0
    while (pos < st.size) {
      signal?.throwIfAborted()
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, st.size - pos), pos)
      if (n <= 0) break
      const piece = buf.subarray(0, n)
      hash.update(piece)
      fs.writeSync(out, piece)
      pos += n
      if (pos > max) throw new ToolError(`'${shown}' is too large`, 'too_large')
    }
    return { size: pos, sha256: hash.digest('hex'), name: path.basename(rel) }
  } finally {
    fs.closeSync(fd)
    if (out !== null) fs.closeSync(out)
  }
}
