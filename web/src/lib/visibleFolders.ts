// The folders a person (and so their AI) can open, for the first-time card on the new-chat screen.
// The tree shows folders the person cannot open (access 'none') only as a way to reach visible folders below them
// (e.g. groups/ above groups/마케팅, projects/ above projects/신제품-출시), so a member whose access comes from a group
// or project rule sees nothing usable at the top level. This walks down through those navigation-only folders and
// returns the first folders on each branch that the person can open.
import type { FileEntry } from '@mycel/shared/api'

export interface VisibleFolderOptions {
  /** how deep to walk through navigation-only folders (top level = 1) */
  maxDepth?: number
  /** at most this many tree listings */
  maxListings?: number
  /** paths never shown (users/: the person's own folder is shown separately) */
  skip?: (path: string) => boolean
}

export async function visibleFolders(list: (path: string) => Promise<FileEntry[]>, o: VisibleFolderOptions = {}): Promise<FileEntry[]> {
  const maxDepth = o.maxDepth ?? 3
  let budget = o.maxListings ?? 12
  const out: FileEntry[] = []
  let level: { path: string; depth: number }[] = [{ path: '', depth: 0 }]
  while (level.length && budget > 0) {
    const next: { path: string; depth: number }[] = []
    for (const dir of level) {
      if (budget-- <= 0) break
      let entries: FileEntry[]
      try { entries = await list(dir.path) } catch { continue }
      for (const e of entries) {
        if (e.type !== 'folder' || o.skip?.(e.path)) continue
        if (e.access !== 'none') out.push(e)
        else if (dir.depth + 1 < maxDepth) next.push({ path: e.path, depth: dir.depth + 1 })
      }
    }
    level = next
  }
  return out
}
