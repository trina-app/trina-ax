// One reading of a file system's size and free space for every disk check (backups, update preflight, the storage
// guard, uploads, save_url, the media work folder, Admin's disk checks). It is fs.statfsSync, checked: on an Intel Mac
// the bundled Bun (1.3.12 darwin-x64) returns statfs with bsize 0 and the other fields shifted, so every check saw
// "0 MB free" with 129 GB free and refused backups and updates (QA TC-3099). A reading that cannot be right is replaced
// by `df -k -P` of the same path (no shell); a good reading (Apple silicon, Linux) is returned as it is. When df fails
// too, diskStat throws DiskSpaceUnknown: callers treat that as "could not read", never as "0 bytes free" (a backup
// goes ahead with a warning; the copy itself still fails on a really full disk).
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** The fields every caller reads (bytes = count × bsize). Numbers or bigints, like fs.StatsFs. */
export interface DiskStat { bsize: number | bigint; blocks: number | bigint; bfree: number | bigint; bavail: number | bigint; frsize?: number | bigint }

export interface DiskStatDeps {
  statfs?: (p: string) => DiskStat
  platform?: NodeJS.Platform
  /** `df -k -P -- <p>`'s output (stdout), or null when it could not run (tests; the real one is the async cache) */
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
 * at least one block, no more free or available blocks than the disk has (and no more available than free), and a disk
 * size below 1 EiB. A reading without bfree (some test
 * fakes) is judged by the rest. */
export function plausibleStatfs(s: DiskStat): boolean {
  const bsize = num(s.bsize), blocks = num(s.blocks), bavail = num(s.bavail), bfree = num(s.bfree)
  if (!(Number.isFinite(bsize) && bsize > 0)) return false
  if (s.frsize !== undefined && !(Number.isFinite(num(s.frsize)) && num(s.frsize) > 0)) return false
  if (!(Number.isFinite(blocks) && blocks > 0)) return false
  if (!(Number.isFinite(bavail) && bavail >= 0 && bavail <= blocks)) return false
  if (s.bfree !== undefined && !(Number.isFinite(bfree) && bfree >= 0 && bfree <= blocks && bavail <= bfree)) return false
  if (!(blocks * bsize <= MAX_DISK_BYTES)) return false
  return true
}

/** `df -k -P` output → a reading in 1 KiB blocks; null when it is not that shape. The data line is the line after the
 * header (-P never wraps it); the file system name may hold spaces, so the numbers are matched, not the columns. */
export function parseDfK(out: string): DiskStat | null {
  const lines = out.split(/\r?\n/).filter((l) => l.trim() !== '')
  // POSIX df -k -P: the size column is "1024-blocks" (with -P, 1 KiB units whatever BLOCKSIZE says)
  if (lines.length < 2 || !/^Filesystem\s+1024-blocks\s/i.test(lines[0])) return null
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

/** df answers by path. df runs in the background only (a df on a dead network mount can hang for minutes): the sync
 * readers on hot paths (uploads, each chat turn's full-disk check, the storage guard) read this cache and never wait;
 * a reading older than DF_FRESH_MS starts one refresh. One-shot callers that need a real answer now (the backup, the
 * update's room check, Admin diagnostics) await primeDiskStat first. */
const DF_FRESH_MS = 10_000
let dfTimeoutMs = 5_000
interface DfEntry { at: number; out: string | null; running: Promise<void> | null }
const dfCache = new Map<string, DfEntry>()
let dfRunner: (p: string) => Promise<string | null> = runDf

/** Tests: replace the df process (null = the real one), its time limit, and empty the cache. */
export function setDfRunnerForTests(r: ((p: string) => Promise<string | null>) | null, timeoutMs = 5_000) {
  dfRunner = r ?? runDf
  dfTimeoutMs = timeoutMs
  dfCache.clear()
}

/** The df process, async. Gives up after dfTimeoutMs (killed; a process stuck in the kernel is left to finish on its
 * own, and no second one starts for that path while it runs). */
function runDf(p: string): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false
    const finish = (v: string | null) => { if (!done) { done = true; clearTimeout(timer); resolve(v) } }
    const timer = setTimeout(() => finish(null), dfTimeoutMs + 500)
    try {
      execFile('/bin/df', ['-k', '-P', '--', p], { encoding: 'utf8', timeout: dfTimeoutMs, killSignal: 'SIGKILL', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } },
        (err, stdout) => finish(err ? null : stdout))
    } catch { finish(null) }
  })
}

function refreshDf(p: string): Promise<void> {
  let e = dfCache.get(p)
  if (!e) {
    if (dfCache.size > 64) dfCache.clear()
    e = { at: 0, out: null, running: null }
    dfCache.set(p, e)
  }
  const entry = e
  if (!entry.running) {
    const run = dfRunner(p).catch(() => null).then((out) => { entry.out = out; entry.at = Date.now() })
    entry.running = run
    void run.finally(() => { if (entry.running === run) entry.running = null })
  }
  return entry.running
}

/** The cached df answer (possibly a little old); never waits. A missing or old one starts a refresh. */
function cachedDf(p: string): string | null {
  const e = dfCache.get(p)
  if (!e || Date.now() - e.at >= DF_FRESH_MS) void refreshDf(p)
  return e?.out ?? null
}

/** Make sure diskStat(p) has a fresh df answer when statfs of `p` cannot be believed (waits for df, at most about
 * dfTimeoutMs). Never throws. */
export async function primeDiskStat(p: string, d: Pick<DiskStatDeps, 'statfs' | 'platform'> = {}): Promise<void> {
  try {
    if ((d.platform ?? process.platform) === 'win32') return
    if (plausibleStatfs((d.statfs ?? ((x: string) => fs.statfsSync(x)))(p))) return
    const key = path.resolve(p)
    const e = dfCache.get(key)
    if (e && Date.now() - e.at < DF_FRESH_MS) return
    // a refresh still running when the timeout passes (a df stuck in the kernel) is not waited for any longer
    await Promise.race([refreshDf(key), new Promise((r) => setTimeout(r, dfTimeoutMs + 1000))])
  } catch {}
}

/** statfs of `p` (which must exist, like fs.statfsSync). A reading that cannot be right is replaced by df's; when df
 * fails too (or on Windows, which has no df) it throws DiskSpaceUnknown. */
export function diskStat(p: string, d: DiskStatDeps = {}): DiskStat {
  const s = (d.statfs ?? ((x: string) => fs.statfsSync(x)))(p)
  if (plausibleStatfs(s)) return s
  const out = (d.platform ?? process.platform) === 'win32' ? null : (d.df ?? cachedDf)(path.resolve(p))
  const parsed = out === null ? null : parseDfK(out)
  if (!parsed) throw new DiskSpaceUnknown(`could not read the free disk space of ${p} (statfs gave bsize ${String(s.bsize)}, blocks ${String(s.blocks)}, bavail ${String(s.bavail)}; df failed)`)
  return parsed
}

/** "Unknown" warnings once per change: true when `key` (a path, with the caller's name) went from readable to
 * unknown or back since the last call, so a log line is written only then and not on every backup or diagnostics run. */
const unknownNow = new Set<string>()
export function unknownChanged(key: string, unknown: boolean): boolean {
  if (unknown === unknownNow.has(key)) return false
  if (unknown) unknownNow.add(key)
  else unknownNow.delete(key)
  return true
}
