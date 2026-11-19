// Names of folders a shared chat's run must not show (QA TC-4929, TC-4945). srt hides a denied folder inside a readable
// one with an empty folder over it (bwrap tmpfs on Linux; on macOS the name stays listable in its parent), so `ls` of
// the parent shows its NAME. In a shared chat that name goes to everyone in it, also those who may not open the folder.
// So in a shared chat's run a folder with a denied folder inside is not given whole: its entries are given one by one,
// the denied ones left out, and srt then makes the folder itself only as the place of those entries.
//   - A read-only folder: its entries are given read-only, as before.
//   - A writable folder (a shared project chat's project folder, or a sub-folder of it, that holds a sub-folder not
//     everyone in the chat may open; docs/decisions/20261118-shared-hide-subfolder-names.md): its sub-folders stay
//     writable, its files are given read-only, and the folder itself is only a place. A command there cannot add,
//     rename or delete an entry at its top (Linux: what it makes there lands in srt's empty place and is not kept;
//     a rename or delete of an entry fails as busy; macOS: refused), which the tool tells the AI (lockedTops). Not the
//     skill folders and no folder whose name starts with a dot (.vscode, .claude): srt protects names inside a
//     writable root it is given, not one given as a root of its own, so those are read-only there (fail closed).
//   - Either way a git repository in an opened folder (`.git` in any letter case, or a folder with HEAD, objects/ and
//     refs/ such as web.git/) is not given: it is at or above a hidden folder, and its history may hold that folder's
//     files (QA TC-4945 review).
//   - Every entry given inside an opened folder is pinned (entryPins: device and inode as listed, the view's own entries
//     there too); the command first checks inside the sandbox, with one stat, that each mount is that very entry
//     (writePins, entryGuard), so a folder swapped for a link between the listing and srt's bind (which follows links)
//     stops the command (exit 97) before it runs.
// Links are never given one by one (a link given by its own path would be followed by the mount and show its target).
// Only for the settings of a run: the view's hash stays the view's (a file saved in such a folder must not stop a
// running command).
import fs from 'node:fs'
import path from 'node:path'
import type { FolderView } from './access'
// the path rule of skill roots, from shared/ (this folder runs on its own in tests/linux/Dockerfile.srt)
import { skillRootOf } from '@mycel/shared/skill-roots'

const isUnder = (child: string, parent: string) => parent === '' || child === parent || child.startsWith(parent + '/')
const join = (a: string, b: string) => (a === '' ? b : `${a}/${b}`)

/** The view with every folder that holds a denied folder given entry by entry (team-relative paths). Entry lists come
 * from the disk under `teamRoot`. At most `max` entries are added (fail closed: past it the folder is left out of the
 * run whole). */
export function hideDeniedNames(v: FolderView, teamRoot: string, max = 5000): FolderView {
  let read = [...v.read]
  let write = [...v.write]
  let denyRead = [...v.denyRead]
  let denyWrite = [...v.denyWrite]
  let added = 0
  const holdsDeny = (r: string) => denyRead.some((d) => d !== r && isUnder(d, r))
  for (let guard = 0; guard < 10_000; guard++) {
    // a read folder below a write folder is a denyWrite there, not here: only the read list's own folders. A read
    // folder with a write folder inside it is opened too (the write one stays given as it is: srtSettings binds it
    // writable again over the read one); a write folder with another write folder inside it is opened from the top
    // (the inner one is then one of its entries)
    const r = read.find((x) => holdsDeny(x) && !write.some((w) => isUnder(x, w)))
    const w = r === undefined ? write.find((x) => holdsDeny(x)) : undefined
    const g = r ?? w
    if (g === undefined) break
    const writable = r === undefined
    if (writable) write = write.filter((x) => x !== g)
    else read = read.filter((x) => x !== g)
    let names: fs.Dirent[] = []
    try { names = fs.readdirSync(g === '' ? teamRoot : path.join(teamRoot, g), { withFileTypes: true }) } catch { continue }
    for (const e of names) {
      const c = join(g, e.name)
      if (denyRead.includes(c)) { denyRead = denyRead.filter((d) => d !== c); continue }
      // a git repository at or above a hidden folder may hold its files (a commit made before the folder was limited):
      // git status, show and checkout would bring them back, so it is not given at all, also when the view gave it
      if (!e.isSymbolicLink() && gitLike(path.join(teamRoot, c), e.name, e.isDirectory())) { read = read.filter((x) => x !== c); write = write.filter((x) => x !== c); continue }
      // a deeper entry of the view decides there already
      if (read.includes(c) || write.includes(c)) continue
      if (e.isSymbolicLink() || (!e.isDirectory() && !e.isFile())) continue
      if (++added > max) return { read: read.filter((x) => !isUnder(x, g)), write: write.filter((x) => !isUnder(x, g)), denyRead, denyWrite: denyWrite.filter((x) => !isUnder(x, g)) }
      // a read-only folder inside a writable one (a skill folder, a shared folder): given read-only on its own now
      if (denyWrite.includes(c)) { denyWrite = denyWrite.filter((x) => x !== c); read.push(c); continue }
      if (writable && e.isDirectory() && !e.name.startsWith('.') && skillRootOf(c) === null) write.push(c)
      else read.push(c)
    }
  }
  // what is denied below a folder no longer given whole is not there anyway
  denyRead = denyRead.filter((d) => [...read, ...write].some((a) => a !== d && isUnder(d, a)))
  denyWrite = denyWrite.filter((d) => write.some((a) => a !== d && isUnder(d, a)))
  return { read, write, denyRead, denyWrite }
}

/** The writable folders of `v` whose top a run cannot change once hideDeniedNames gave them entry by entry, shallowest
 * first. For the tool's note to the AI (they are folders everyone in the chat may open: their names may show). */
export function lockedTops(v: FolderView, given: FolderView): string[] {
  return v.write.filter((w) => !given.write.includes(w)).sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1))
}

/** The read-only folders of `v` that hideDeniedNames gave entry by entry (absolute paths, shallowest first). On Linux
 * the top of such a folder is srt's empty place inside the sandbox, which bwrap makes writable: a file made there
 * would seem written and never reach the disk (attack S12). The command's first line makes these places read-only
 * (entryGuard), so such a write fails as it does in a folder given whole. Never one under a writable entry of `given`:
 * there the path could be the real folder on disk. */
export function readOnlyTops(v: FolderView, given: FolderView, teamRoot: string): string[] {
  const now = new Set([...given.read, ...given.write])
  return v.read.filter((r) => !now.has(r) && !given.write.some((w) => isUnder(r, w)) && !v.write.some((w) => isUnder(r, w)))
    .sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1))
    .map((r) => (r === '' ? teamRoot : path.join(teamRoot, r)))
}

/** A git repository by its look: `.git` in any letter case (a folder, or the file of a worktree), or a folder with
 * HEAD, objects/ and refs/ (a bare repository such as web.git/). */
function gitLike(abs: string, name: string, dir: boolean): boolean {
  if (name.toLowerCase() === '.git') return true
  if (!dir) return false
  try { return fs.statSync(path.join(abs, 'HEAD')).isFile() && fs.statSync(path.join(abs, 'objects')).isDirectory() && fs.statSync(path.join(abs, 'refs')).isDirectory() } catch { return false }
}

/** Device and inode (`dev:ino`) of every entry given inside a folder that hideDeniedNames opened (the ones it added and
 * the ones the view gave already: each is bound by its own path now), by absolute path. Throws when one is a link or
 * gone now (fail closed: the run does not start). */
export function entryPins(v: FolderView, given: FolderView, teamRoot: string): Record<string, string> {
  const now = new Set([...given.read, ...given.write])
  const opened = [...v.read, ...v.write].filter((f) => !now.has(f))
  const out: Record<string, string> = {}
  for (const rel of now) {
    if (!opened.some((f) => rel !== f && isUnder(rel, f))) continue
    const abs = rel === '' ? teamRoot : path.join(teamRoot, rel)
    const st = fs.lstatSync(abs, { bigint: true })
    if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) throw new Error('a folder changed while the command started; run it again')
    out[abs] = `${st.dev}:${st.ino}`
  }
  return out
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
/** The pins of a run as files in `dir` (the run's own TMPDIR): the paths NUL-separated, the expected `dev:ino` lines,
 * and (when there are any) the read-only tops to lock (readOnlyTops), NUL-separated. */
export function writePins(dir: string, pins: Record<string, string>, readOnly: readonly string[] = []): { paths: string; ids: string; readOnly?: string } | null {
  const ps = Object.entries(pins)
  if (!ps.length) return null
  const paths = path.join(dir, '.trina-pins'), ids = path.join(dir, '.trina-pins.ids')
  fs.writeFileSync(paths, ps.map(([p]) => p + '\0').join(''), { mode: 0o600 })
  fs.writeFileSync(ids, ps.map(([, id]) => id + '\n').join(''), { mode: 0o600 })
  if (!readOnly.length) return { paths, ids }
  const ro = path.join(dir, '.trina-pins.ro')
  fs.writeFileSync(ro, readOnly.map((p) => p + '\0').join(''), { mode: 0o600 })
  return { paths, ids, readOnly: ro }
}
/** The first line of a command whose run has pinned entries (Linux): inside the sandbox one stat (GNU, by its full
 * path; xargs splits only a very long list) prints every pinned entry's `dev:ino`, which must be the list written
 * before the run, else the command does not run (exit 97). Then the read-only tops (readOnlyTops) lose their write
 * bits: they are srt's places in the sandbox's own tmpfs, so nothing on the disk changes, and a file made there fails
 * ("Permission denied") instead of seeming written. The files are removed before the command. Prints no path. */
export function entryGuard(f: { paths: string; ids: string; readOnly?: string } | null): string {
  if (!f) return ''
  const lock = f.readOnly ? `/usr/bin/xargs -0 /bin/chmod a-w -- < ${shq(f.readOnly)} 2>/dev/null; ` : ''
  return `/usr/bin/xargs -0 /usr/bin/stat -c %d:%i -- < ${shq(f.paths)} 2>/dev/null | /usr/bin/cmp -s - ${shq(f.ids)} || { echo 'The command did not run: a folder changed while it started. Run it again.' >&2; exit 97; }; ${lock}/bin/rm -f ${shq(f.paths)} ${shq(f.ids)}${f.readOnly ? ` ${shq(f.readOnly)}` : ''}`
}
