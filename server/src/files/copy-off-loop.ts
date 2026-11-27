// A file copy that never holds the server's event loop (the thread that answers /api/health and every request).
import fs from 'node:fs'

const C = fs.constants

/**
 * Copy `src` to `dst` (which must not exist yet) off the event loop: a clone where the disk has them (APFS, btrfs, XFS
 * with reflink), otherwise a copy on Bun's file threads (fs.promises.copyFile). Never fs.copyFileSync for a file a
 * person, a connector or the AI made: ext4 has no clones, so a 20 GB file was copied byte by byte on the one thread
 * that also answers /api/health, for minutes, and the watchdog took a busy server for a hung one
 * (docs/decisions/20261127-restart.md; tests/unit/g-copy-off-loop.test.ts keeps it that way). A half-written `dst` is
 * removed on a failure.
 */
export async function copyOffLoop(src: string, dst: string): Promise<void> {
  try { await fs.promises.copyFile(src, dst, C.COPYFILE_EXCL | C.COPYFILE_FICLONE) } catch (e: any) {
    if (e?.code !== 'EEXIST') try { fs.rmSync(dst, { force: true }) } catch { /* left: a temp name */ }
    throw e
  }
}

/** Rename `src` to `dst`; across volumes (EXDEV) a copy off the event loop, then `src` goes. */
export async function moveOffLoop(src: string, dst: string): Promise<void> {
  try { fs.renameSync(src, dst); return } catch (e: any) { if (e?.code !== 'EXDEV') throw e }
  await copyOffLoop(src, dst)
  fs.rmSync(src, { force: true })
}
