// Where a folder share may live, and what the people on it may see (docs/decisions/20261116-folder-share-server.md;
// the design: docs/AGENTS/plan/20261116-1147-folder-sharing.md D2, D3, "Opening a child" steps 7 and 10).
//
// Only a folder inside a person's own files can be shared: users/<owner>/<name>/… (depth 3 or deeper). The places the
// server keeps there are never shared, nor anything inside them: every one of the server's own save places sits at
// depth 3, so none can be inside a shared folder. Names are compared with foldKey (NFKC, lower case, NFKC again), so a
// case, width or Unicode twin of a kept name ("Downloads", "downloadſ", a decomposed archive name) is the kept name.
// Each list comes from the constant its writer uses, never from a retyped string: a new server-named folder under
// users/<id>/ is added to SERVER_OWN_FOLDERS (files/own-folders.ts) and is excluded here at once
// (tests/unit/c-share-places.test.ts fails on a name the list misses).
//
// Three functions, no state, no disk:
//   neverShared(db, segs)   may nothing at `segs` be shared? Asked when sharing and again on every open (a rename can
//                           move a shared folder into such a place).
//   receiverSees(db, segs)  may a receiver see this path inside a shared folder? The same answer for opening a child,
//                           for a listing and for "is this content already shared" (the widening hook).
//   childSegs(rowPath, sub) the path inside a shared folder as the client sent it, checked BEFORE it touches the disk.
import type { Database } from 'bun:sqlite'
import { ARCHIVE_DIR, FROM_COMPUTER_DIR, PRODUCT } from '@mycel/shared'
import type { FolderShareBlock } from '@mycel/shared/api'
import { badSegment, foldKey, MAX_DEPTH, MAX_PATH_CHARS, MAX_SEGMENT_BYTES } from '../policy/names'
import { inSkills, SKILLS_DIR } from '../skills/guard'
import { ATTACHMENTS_DIR } from '../uploads/attachments-dir'
import { SERVER_OWN_FOLDERS } from './own-folders'

/** A personal notes file some builds keep at users/<id>/notes.md: never shared, by name. */
export const PERSONAL_NOTES = 'notes.md'

/** The names right under users/<id>/ that are never shared (and nothing inside them), as their writers name them. */
export function keptNames(): string[] {
  return [SKILLS_DIR, ...SERVER_OWN_FOLDERS, ATTACHMENTS_DIR, PERSONAL_NOTES, FROM_COMPUTER_DIR, ...Object.values(ARCHIVE_DIR)]
}
let kept: Set<string> | null = null
const keptKeys = () => (kept ??= new Set(keptNames().map(foldKey)))

/** A name no receiver ever sees and no share lives under: hidden (a leading dot), a server temp file, the system
 * folder, or one the name rules refuse. */
export function hiddenName(name: string): boolean {
  return name.startsWith('.') || name.startsWith(PRODUCT.tmpPrefix) || name === PRODUCT.systemDir || badSegment(name) !== null
}

/** The folders of projects under users/<owner>/ (a personal project may sit on any folder there, not only projects/). */
export function personalProjectFolders(db: Database, owner: string): string[] {
  const prefix = `users/${owner}/`
  return (db.query('SELECT folder_path p FROM projects WHERE substr(folder_path, 1, length(?)) = ?').all(prefix, prefix) as { p: string }[]).map((r) => r.p)
}
const within = (p: string, base: string) => p === base || p.startsWith(base + '/')

/**
 * Why nothing at `segs` (actual names, a team path) may be shared, or null when it may:
 *   team_folder   not under users/ (admins share team folders in their own dialog; a member never does);
 *   root          users/ itself or a person's whole personal folder;
 *   system_place  at or inside a place the server keeps (keptNames), a hidden or temp name, a skill root;
 *   project       it is a project's folder, holds one, or is inside one.
 */
export function sharePlaceBlock(db: Database, segs: readonly string[], projects?: readonly string[]): Extract<FolderShareBlock, 'root' | 'system_place' | 'project' | 'team_folder'> | null {
  if (segs[0] !== 'users') return 'team_folder'
  if (segs.length < 3 || !segs[1]) return 'root'
  if (keptKeys().has(foldKey(segs[2]!))) return 'system_place'
  for (let i = 2; i < segs.length; i++) if (hiddenName(segs[i]!)) return 'system_place'
  const rel = segs.join('/')
  if (inSkills(rel)) return 'system_place'
  for (const p of projects ?? personalProjectFolders(db, segs[1])) if (within(rel, p) || within(p, rel)) return 'project'
  return null
}

/** May nothing at `segs` be shared (see sharePlaceBlock)? True for every path outside a person's own files. */
export function neverShared(db: Database, segs: readonly string[], projects?: readonly string[]): boolean {
  return sharePlaceBlock(db, segs, projects) !== null
}

/**
 * May a receiver of a folder share see `segs` (actual names, the whole team path of something at or inside a shared
 * folder)? Not when it is at or under a project's folder, a skill root or a kept place, or has a hidden or temp name
 * on the way: things that got into the folder after it was shared. A folder that only HOLDS a project is seen (its
 * listing shows the project's folder name; going into it is refused here).
 * `projects`: personalProjectFolders() read once for a whole listing.
 */
export function receiverSees(db: Database, segs: readonly string[], projects?: readonly string[]): boolean {
  if (segs[0] !== 'users' || segs.length < 3 || !segs[1]) return false
  if (keptKeys().has(foldKey(segs[2]!))) return false
  for (let i = 2; i < segs.length; i++) if (hiddenName(segs[i]!)) return false
  const rel = segs.join('/')
  if (inSkills(rel)) return false
  for (const p of projects ?? personalProjectFolders(db, segs[1])) if (within(rel, p)) return false
  return true
}

/** Does the whole team path stay within the path limits (1024 characters, 64 segments, 255 bytes a name)? */
export function withinPathLimits(segs: readonly string[]): boolean {
  if (segs.length > MAX_DEPTH) return false
  let chars = segs.length - 1
  for (const s of segs) {
    if (Buffer.byteLength(s, 'utf8') > MAX_SEGMENT_BYTES) return false
    chars += s.length
  }
  return chars <= MAX_PATH_CHARS
}

/**
 * The names of `sub` (a path inside the shared folder at `rowPath`, '' = the folder itself) when every one of them may
 * be asked of the disk, else null. Each name: not empty, not '.' or '..', no NUL or control character, at most 255
 * bytes, not hidden, not a temp name, not the system folder, and accepted by the name rules (which also refuse a
 * backslash and look-alike slashes). The WHOLE team path (the shared folder's path and `sub`) stays within the path
 * limits. Nothing is normalised here: the walk matches a Unicode twin to the name on disk, and the caller then checks
 * that the result is still inside the shared folder.
 */
export function childSegs(rowPath: string, sub: unknown): string[] | null {
  if (typeof sub !== 'string') return null
  if (sub === '') return []
  if (sub.length > MAX_PATH_CHARS || sub.includes('\0')) return null
  const names = sub.split('/')
  for (const n of names) if (n === '' || n === '.' || n === '..' || hiddenName(n)) return null
  return withinPathLimits([...rowPath.split('/'), ...names]) ? names : null
}
