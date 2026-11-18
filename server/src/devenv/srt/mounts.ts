// Names of folders a shared chat's run must not show (QA TC-4929). srt hides a denied folder inside a readable one with
// an empty folder over it (bwrap tmpfs on Linux; on macOS the name stays listable in its parent), so `ls` of the parent
// shows its NAME. In a shared chat that name goes to everyone in it, also those who may not open the folder (in the
// file tools a listing in a shared chat counts the names it shows as read). So in a shared chat's run a readable
// folder with a denied folder inside is not given whole: its entries are given one by one, the denied ones left out,
// and srt then makes the folder itself only as the place of those entries. Applied to read-only folders only: a
// writable folder given entry by entry would lose what a command writes at its top (a shared project chat's project
// folder with a restricted sub-folder keeps showing that sub-folder's name, empty: known, see
// docs/decisions/20261118-devenv-shared-followups.md). Links are never given one by one (a link given by its own path
// would be followed by the mount and show its target). Only for the settings of a run: the view's hash stays the view's
// (a file saved in such a folder must not stop a running command).
import fs from 'node:fs'
import path from 'node:path'
import type { FolderView } from './access'

const isUnder = (child: string, parent: string) => parent === '' || child === parent || child.startsWith(parent + '/')
const join = (a: string, b: string) => (a === '' ? b : `${a}/${b}`)

/** The view with every read-only folder that holds a denied folder given entry by entry (team-relative paths). Entry
 * lists come from the disk under `teamRoot`. At most `max` entries are added (fail closed: past it the folder is left
 * out of the run whole). */
export function hideDeniedNames(v: FolderView, teamRoot: string, max = 5000): FolderView {
  let read = [...v.read]
  let denyRead = [...v.denyRead]
  const write = v.write
  let added = 0
  const holdsDeny = (r: string) => denyRead.some((d) => d !== r && isUnder(d, r))
  // a read folder below a write folder is a denyWrite there, not here: only the read list's own folders
  for (let guard = 0; guard < 10_000; guard++) {
    const r = read.find((x) => holdsDeny(x) && !write.some((w) => isUnder(w, x) || isUnder(x, w)))
    if (r === undefined) break
    read = read.filter((x) => x !== r)
    let names: fs.Dirent[] = []
    try { names = fs.readdirSync(r === '' ? teamRoot : path.join(teamRoot, r), { withFileTypes: true }) } catch { continue }
    for (const e of names) {
      const c = join(r, e.name)
      if (denyRead.includes(c)) { denyRead = denyRead.filter((d) => d !== c); continue }
      // a deeper entry of the view decides there already
      if (read.includes(c) || write.includes(c) || v.denyWrite.includes(c)) continue
      if (e.isSymbolicLink() || (!e.isDirectory() && !e.isFile())) continue
      if (++added > max) return { ...v, read: read.filter((x) => !isUnder(x, r)), denyRead }
      read.push(c)
    }
  }
  // what is denied below a folder no longer given whole is not there anyway
  denyRead = denyRead.filter((d) => [...read, ...write].some((a) => a !== d && isUnder(d, a)))
  return { read, write: v.write, denyRead, denyWrite: v.denyWrite }
}
