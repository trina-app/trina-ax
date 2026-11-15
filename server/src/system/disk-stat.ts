// One reading of a file system's size and free space for every disk check (backups, update preflight, the storage
// guard, uploads, save_url, the media work folder, Admin's disk checks). It is fs.statfsSync, checked: on an Intel Mac
// the bundled Bun (1.3.12 darwin-x64) returns statfs with bsize 0 and the other fields shifted, so every check saw
// "0 MB free" with 129 GB free and refused backups and updates (QA TC-3099). A reading that cannot be right is replaced
// by `df -k -P` of the same path (no shell); a good reading (Apple silicon, Linux) is returned as it is. When df fails
// too, diskStat throws DiskSpaceUnknown: callers treat that as "could not read", never as "0 bytes free" (a backup
// goes ahead with a warning; the copy itself still fails on a really full disk).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** The fields every caller reads (bytes = count × bsize). Numbers or bigints, like fs.StatsFs. */
export interface DiskStat { bsize: number | bigint; blocks: number | bigint; bfree: number | bigint; bavail: number | bigint; frsize?: number | bigint }

export interface DiskStatDeps {
  statfs?: (p: string) => DiskStat
  platform?: NodeJS.Platform
  /** `df -k -P -- <p>`'s output (stdout), or null when it could not run */
  df?: (p: string) => string | null
}

/** Neither statfs nor df gave a believable free space for this path. */
export class DiskSpaceUnknown extends Error {
  readonly code = 'DISK_SPACE_UNKNOWN'
}

/** No disk is this big (1 EiB): a larger product means shifted fields. */
const MAX_DISK_BYTES = 2 ** 60

const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : NaN)

/** Can this statfs reading be right? A block size above 0 (and a fragment size above 0 when there is one), a disk of
 * at least one block, no more free or available blocks than the disk has, and a disk size below 1 EiB. A reading without bfree (some test
 * fakes) is judged by the rest. */
export function plausibleStatfs(s: DiskStat): boolean {
  const bsize = num(s.bsize), blocks = num(s.blocks), bavail = num(s.bavail), bfree = num(s.bfree)
  if (!(Number.isFinite(bsize) && bsize > 0)) return false
  if (s.frsize !== undefined && !(Number.isFinite(num(s.frsize)) && num(s.frsize) > 0)) return false
  if (!(Number.isFinite(blocks) && blocks > 0)) return false
  if (!(Number.isFinite(bavail) && bavail >= 0 && bavail <= blocks)) return false
  if (s.bfree !== undefined && !(Number.isFinite(bfree) && bfree >= 0 && bfree <= blocks)) return false
  if (!(blocks * bsize <= MAX_DISK_BYTES)) return false
  return true
}

/** `df -k -P` output → a reading in 1 KiB blocks; null when it is not that shape. The data line is the line after the
 * header (-P never wraps it); the file system name may hold spaces, so the numbers are matched, not the columns. */
export function parseDfK(out: string): DiskStat | null {
  const lines = out.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length < 2 || !/^Filesystem\s/i.test(lines[0])) return null
  const m = /^.*?\s(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s/.exec(`${lines[1]} `)
  if (!m) return null
  const blocks = Number(m[1]), used = Number(m[2]), avail = Number(m[3])
  if (![blocks, used, avail].every(Number.isSafeInteger) || blocks <= 0) return null
  // bfree = bavail, like statfs on APFS (Apple silicon gives bfree === bavail): snapshotOf's used = blocks - bfree is
  // then the whole container's use, as on a good reading. df's "Used" counts only this volume (APFS volumes share the
  // container, so used + avail is often far below blocks) and would make the Intel Mac's numbers differ from the rest.
  const bavail = Math.min(avail, blocks)
  return { bsize: 1024, frsize: 1024, blocks, bfree: bavail, bavail }
}

function runDf(p: string): string | null {
  try {
    const r = spawnSync('/bin/df', ['-k', '-P', '--', p], { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } })
    return r.status === 0 && typeof r.stdout === 'string' ? r.stdout : null
  } catch { return null }
}

/** statfs of `p` (which must exist, like fs.statfsSync). A reading that cannot be right is replaced by df's; when df
 * fails too (or on Windows, which has no df) it throws DiskSpaceUnknown. */
export function diskStat(p: string, d: DiskStatDeps = {}): DiskStat {
  const s = (d.statfs ?? ((x: string) => fs.statfsSync(x)))(p)
  if (plausibleStatfs(s)) return s
  const out = (d.platform ?? process.platform) === 'win32' ? null : (d.df ?? runDf)(path.resolve(p))
  const parsed = out === null ? null : parseDfK(out)
  if (!parsed) throw new DiskSpaceUnknown(`could not read the free disk space of ${p} (statfs gave bsize ${String(s.bsize)}, blocks ${String(s.blocks)}, bavail ${String(s.bavail)}; df failed)`)
  return parsed
}
