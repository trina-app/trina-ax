// Which folder on disk a path is. Used by a scheduled task's save folder (chat/schedule-scope.ts, which re-exports
// these) and by folder sharing (files/folder-shares.ts). Its own small module: nothing here loads the chat code.
import fs from 'node:fs'
import path from 'node:path'
import type { FsCtx } from '../policy/authorize'

/** How the folder's identity reads a folder (a test replaces it to play a disk without creation times). */
export const folderStat: { lstat(p: string): { isDirectory(): boolean; dev: bigint; ino: bigint; birthtimeNs: bigint } } = {
  lstat: (p) => fs.lstatSync(p, { bigint: true }),
}

/** Which folder on disk `segs` (actual names) is: its device, inode and birth time (nanoseconds). The inode alone is
 * not enough: Linux (ext4, overlay) gives a folder made right after another was deleted the same inode number, so a
 * folder deleted and made again with its name would look like the one the card showed. A disk that keeps no birth time
 * (0) cannot tell them apart: null, as for something that is not a folder (fails closed: refused on the card, an
 * existing save folder lapses). */
export function saveFolderId(fx: FsCtx, segs: readonly string[]): string | null {
  try {
    const st = folderStat.lstat(path.join(fx.root, ...segs))
    return st.isDirectory() && st.birthtimeNs !== 0n ? `${st.dev}:${st.ino}:${st.birthtimeNs}` : null
  } catch { return null }
}
