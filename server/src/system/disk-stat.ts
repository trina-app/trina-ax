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
 * an answer older than freshMs starts one refresh, and one older than maxAgeMs counts as unknown (a df that stopped
 * answering must not keep an old number alive). One-shot callers that need a real answer now (the backup, the update's
 * room check, Admin diagnostics) await primeDiskStat first; the server primes its two folders at start. */
interface DfConf { timeoutMs: number; freshMs: number; maxAgeMs: number; now: () => number }
const DF_DEFAULTS: DfConf = { timeoutMs: 5_000, freshMs: 10_000, maxAgeMs: 60_000, now: Date.now }
let conf: DfConf = { ...DF_DEFAULTS }

/** One df run: `answer` settles with its output (null on failure or at the time limit); `exited` when the process is
 * really gone (a df stuck in the kernel can outlive its answer). */
export interface DfRun { answer: Promise<string | null>; exited: Promise<void> }
type DfRunner = (p: string, timeoutMs: number) => DfRun

interface DfEntry {
  at: number
  out: string | null
  /** the answer phase of the current run (what primeDiskStat waits for) */
  running: Promise<void> | null
  /** a df process for this path is still alive: no second one starts until it exits */
  alive: boolean
}
const dfCache = new Map<string, DfEntry>()
let dfRunner: DfRunner = runDf
const DF_CACHE_MAX = 64

/** Tests: replace the df process (null = the real one; a plain function's process "exits" when it answers), the
 * times and the clock, and empty the cache. */
export function setDfRunnerForTests(r: ((p: string) => Promise<string | null>) | DfRunner | null, o: Partial<DfConf> & { raw?: boolean } = {}) {
  const { raw, ...times } = o
  dfRunner = r === null ? runDf : raw ? (r as DfRunner) : (p) => { const answer = (r as (p: string) => Promise<string | null>)(p); return { answer, exited: answer.then(() => {}, () => {}) } }
  conf = { ...DF_DEFAULTS, ...times }
  dfCache.clear()
}

/** The df process. Killed after timeoutMs; the answer is null then (and at the latest 500 ms later, even when the
 * process does not die); `exited` waits for the process itself. */
function runDf(p: string, timeoutMs: number): DfRun {
  let exit: () => void = () => {}
  const exited = new Promise<void>((r) => { exit = r })
  const answer = new Promise<string | null>((resolve) => {
    let done = false
    const finish = (v: string | null) => { if (!done) { done = true; clearTimeout(timer); resolve(v) } }
    const timer = setTimeout(() => finish(null), timeoutMs + 500)
    timer.unref?.()
    try {
      const child = execFile('/bin/df', ['-k', '-P', '--', p], { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } },
        (err, stdout) => finish(err ? null : stdout))
      child.once('exit', () => exit())
      child.once('error', () => exit())
    } catch { finish(null); exit() }
  })
  return { answer, exited }
}

function entryOf(p: string): DfEntry {
  let e = dfCache.get(p)
  if (!e) {
    // full: drop the settled entries only; one with a df still alive stays, or its path could start a second one
    if (dfCache.size >= DF_CACHE_MAX) for (const [k, v] of dfCache) if (!v.alive && !v.running) dfCache.delete(k)
    e = { at: 0, out: null, running: null, alive: false }
    dfCache.set(p, e)
  }
  return e
}

/** Start one df run for `p` unless one is alive; resolves when its answer is in (or right away when an older run's
 * process is still alive and its answer was already given up on). */
function refreshDf(p: string): Promise<void> {
  const entry = entryOf(p)
  if (entry.running) return entry.running
  if (entry.alive) return Promise.resolve()
  const run = dfRunner(p, conf.timeoutMs)
  entry.alive = true
  void run.exited.finally(() => { entry.alive = false })
  const answered = run.answer.catch(() => null).then((out) => { entry.out = out; entry.at = conf.now() })
  entry.running = answered
  void answered.finally(() => { if (entry.running === answered) entry.running = null })
  return answered
}

/** The cached df answer; never waits. A missing or old answer starts a refresh; one older than maxAgeMs is unknown. */
function cachedDf(p: string): string | null {
  const e = dfCache.get(p)
  const age = e ? conf.now() - e.at : Infinity
  if (age >= conf.freshMs) void refreshDf(p)
  return e && age < conf.maxAgeMs ? e.out : null
}

/** Make sure diskStat(p) has a fresh df answer when statfs of `p` cannot be believed (waits for df, at most about
 * timeoutMs + 1 s). Never throws. */
export async function primeDiskStat(p: string, d: Pick<DiskStatDeps, 'statfs' | 'platform'> = {}): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    if ((d.platform ?? process.platform) === 'win32') return
    if (plausibleStatfs((d.statfs ?? ((x: string) => fs.statfsSync(x)))(p))) return
    const key = path.resolve(p)
    const e = dfCache.get(key)
    if (e && conf.now() - e.at < conf.freshMs) return
    // a df that has not answered by then (stuck in the kernel) is not waited for any longer
    const limit = new Promise<void>((r) => { timer = setTimeout(r, conf.timeoutMs + 1000); timer.unref?.() })
    await Promise.race([refreshDf(key), limit])
  } catch {} finally { if (timer) clearTimeout(timer) }
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

/** The one free-space reserve: what the AI's writes (write, edit, make_file, box_shell: system/storage.ts
 * simpleFloorBytes), a download (save_url) and the speech model's download must leave free on the disk: 5% of the disk,
 * at least 2 GiB, at most 10 GiB (docs/decisions/20261118-limits-caps.md). The cap keeps a big disk usable: a 1.8 TB disk
 * with 91 GB free (5% would be 92 GB) refused every AI write before it. */
export const DISK_RESERVE_MIN = 2 * 1024 ** 3
export const DISK_RESERVE_MAX = 10 * 1024 ** 3
export const DISK_RESERVE_FRACTION = 0.05
export function diskReserve(totalBytes: number): number {
  return Math.max(DISK_RESERVE_MIN, Math.min(DISK_RESERVE_MAX, Math.floor(totalBytes * DISK_RESERVE_FRACTION)))
}
