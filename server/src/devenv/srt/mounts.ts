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
//   - Either way a `.git` in an opened folder is not given: it is at or above a hidden folder, and its history may hold
//     that folder's files (QA TC-4945 review).
//   - Each entry given one by one is pinned (entryPins: device and inode as listed); the command first checks inside
//     the sandbox that each mount is that very entry (entryGuard), so a folder swapped for a link between the listing
//     and srt's bind (which follows links) stops the command before it runs.
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
      // a deeper entry of the view decides there already
      if (read.includes(c) || write.includes(c)) continue
      if (e.isSymbolicLink() || (!e.isDirectory() && !e.isFile())) continue
      // a git repository at or above a hidden folder may hold its files (a commit made before the folder was limited):
      // git status, show and checkout would bring them back, so it is not given at all
      if (e.name === '.git') continue
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

/** Device and inode (`dev:ino`) of every entry `given` adds to `v` (hideDeniedNames), by absolute path. Throws when one
 * is a link or gone now (fail closed: the run does not start). */
export function entryPins(v: FolderView, given: FolderView, teamRoot: string): Record<string, string> {
  const before = new Set([...v.read, ...v.write])
  const out: Record<string, string> = {}
  for (const rel of [...given.read, ...given.write]) {
    if (before.has(rel)) continue
    const abs = rel === '' ? teamRoot : path.join(teamRoot, rel)
    const st = fs.lstatSync(abs, { bigint: true })
    if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) throw new Error('a folder changed while the command started; run it again')
    out[abs] = `${st.dev}:${st.ino}`
  }
  return out
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
/** The first line of a command whose run has pinned entries (Linux, GNU stat): inside the sandbox, every pinned path
 * must be the very entry that was listed, else the command does not run (exit 97). Names only entries everyone in the
 * chat may see; prints no path. Empty when nothing is pinned. */
export function entryGuard(pins: Record<string, string>): string {
  const ps = Object.entries(pins)
  if (!ps.length) return ''
  const checks = ps.map(([p, id]) => `[ "$(stat -c %d:%i -- ${shq(p)} 2>/dev/null)" = ${shq(id)} ]`).join(' && ')
  return `{ ${checks}; } || { echo 'The command did not run: a folder changed while it started. Run it again.' >&2; exit 97; }`
}
