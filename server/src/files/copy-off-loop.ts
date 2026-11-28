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

/**
 * Bring `src` to `dst` (which must not exist yet; best in the folder of its final place): a rename when the system
 * allows it, else (EXDEV) a copy off the event loop, checked and flushed to disk. `src` stays after a copy: the caller
 * removes it once the copy is in place, so a failure never loses the only whole copy.
 *
 * EXDEV is found by trying, never from st_dev: systemd's ReadWritePaths bind-mounts the data and the team folder as
 * two mounts of one file system, both with one st_dev, and Linux refuses a rename between two mounts (Windows QA
 * 2026-11-28, WSL2 Debian 13, 0.20.4: every AI file save failed with EXDEV; the same on every systemd Linux install
 * since 0.20.2). A source that is not a regular, singly linked file is refused: a copy would follow a link.
 */
export async function renameOrCopy(src: string, dst: string): Promise<'renamed' | 'copied'> {
  const st = fs.lstatSync(src)
  if (!st.isFile() || st.nlink > 1) throw new Error('not a regular file')
  try { fs.renameSync(src, dst); return 'renamed' } catch (e: any) { if (e?.code !== 'EXDEV') throw e }
  await copyOffLoop(src, dst)
  try {
    const after = fs.lstatSync(src)
    if (after.ino !== st.ino || after.dev !== st.dev || after.size !== st.size) throw new Error('the file changed while it was copied')
    const h = await fs.promises.open(dst, 'r')
    try {
      if ((await h.stat()).size !== st.size) throw new Error('the copy is short')
      await h.sync()
    } finally { await h.close() }
  } catch (e) { try { fs.rmSync(dst, { force: true }) } catch { /* left: a temp name */ } throw e }
  return 'copied'
}

/** Rename `src` to `dst`; across volumes or mounts (EXDEV) a copy off the event loop (renameOrCopy), then `src` goes. */
export async function moveOffLoop(src: string, dst: string): Promise<void> {
  if (await renameOrCopy(src, dst) === 'copied') fs.rmSync(src, { force: true })
}
