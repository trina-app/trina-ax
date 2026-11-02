// A durable empty-ledger lease preserves live search for never-used tenants.
// Once quarantine exists, content passes see only admitted immutable snapshots.
import fs from 'node:fs'
import path from 'node:path'
import { SearchAdmission } from './search-admission'
import { safeText, SAFE_OPS_TEXT } from '../safe-ops/strings'
import { atLeast, type Principal, type RuleSet } from '../policy/access'
import { visiblePath, type FsCtx } from '../policy/authorize'
import { ToolError } from '../policy/errors'
import { walk } from '../policy/resolve'
import { BackgroundTurn, ConverterStopped, extractText, isOffice, OFFICE_EXT, officeWorkersRecheck, type Tools } from './extract'
import { inBackground } from '../tools/isolate'
import { readRegular, sha256 } from './store'
import { readMaxBytes, rgThreads } from '../system/limits'
import { isLegacyKorean, isUtf8 } from '@mycel/shared/text-encoding'
import type { SourceLoc } from '@mycel/shared/api'
import { locLabel, locsOfLines, structureOf } from './locations'
import { makePlaceIndex, placesOfLines, readPlaceIndex, writePlaceIndex, type PlaceIndex } from './place-index'

type Lang = 'ko' | 'en' | 'id' | 'ja' | 'es'

export const RG_BASE = ['--no-config', '--no-ignore', '--hidden', '--no-follow', '--one-file-system', '--max-filesize', '50M',
  '--regex-size-limit', '20M', '--dfa-size-limit', '50M', '--max-columns', '2000', '--max-columns-preview', '--no-messages']
const OFFICE_GLOB = `*.{${OFFICE_EXT.join(',')}}`

const under = (anc: string[], p: string[]) => p.length > anc.length && anc.every((s, i) => s === p[i])
const join = (s: string[]) => (s.length ? s.join('/') : '.')

/** Allowed search roots under `base` for this user, plus the sub-folders inside them that must be skipped. */
export function allowedRoots(fx: FsCtx, rules: RuleSet, user: Principal, base: string[]): { roots: string[]; excludes: string[] } {
  const acc = (s: string[]) => atLeast(rules.access(user, s), 'read')
  // access can only change at a rule folder, at users/<x>, or at .system — collect those under base
  const pts = new Map<string, string[]>()
  const add = (s: string[]) => { if (under(base, s)) pts.set(s.join('/'), s) }
  for (const f of rules.ruleFolders()) if (f !== '') add(f.split('/'))
  add(['users', user.id])
  add(['.system'])
  try { for (const n of fs.readdirSync(path.join(fx.root, 'users'))) add(['users', n]) } catch {}
  const sorted = [...pts.values()].sort((a, b) => a.length - b.length)
  const nearest = (p: string[]) => { let best = base; for (const q of sorted) if (under(q, p) && q.length > best.length) best = q; return best }
  const exists = (s: string[]) => { const w = walk(fx.root, s, false); return !w.problem && w.missing.length === 0 && w.actual.every((n, i) => n === s[i]) }
  const roots: string[] = []
  const excludes: string[] = []
  if (acc(base) && exists(base)) roots.push(join(base))
  for (const p of sorted) {
    const ra = acc(nearest(p)), rp = acc(p)
    if (rp && !ra && exists(p)) roots.push(join(p))
    if (!rp && ra) excludes.push(p.join('/'))
  }
  return { roots, excludes }
}

/** escape glob metacharacters in a literal path (names never contain backslashes) */
export const globEscape = (s: string) => s.replace(/[*?[\]{}!]/g, (c) => '\\' + c)
/** slash-containing globs are anchored at ripgrep's working directory (the team root), checked in tests */
export const excludeArgs = (excludes: string[]) => excludes.flatMap((x) => ['--glob', '!' + globEscape(x), '--glob', '!' + globEscape(x) + '/**'])

interface RgResult { code: number | null; killed: null | 'cap' | 'timeout' | 'abort'; err: string; skipped: number }
/** ripgrep's argv: --threads where the resource limits apply (system/limits.ts rgThreads; else ripgrep's own choice) */
export function rgArgv(rg: string, args: string[]): string[] {
  const t = rgThreads()
  return t ? [rg, '--threads', String(t), ...args] : [rg, ...args]
}

export interface RgRunOpts {
  /** a record longer than this (UTF-16 units) is dropped, also while it arrives, so one long line (a minified file)
   * never fills the memory. ripgrep's --json ignores --max-columns, so content mode needs this cap. */
  maxRecordChars?: number
  /** kill ripgrep when this signal aborts (the person started a newer search) */
  signal?: AbortSignal
}

/** Run rg; `onRecord` gets each NUL- or newline-terminated record; return false to stop (result cap). */
export async function runRg(rg: string, args: string[], cwd: string, sep: '\n' | '\0', onRecord: (r: string) => boolean | void, timeoutMs: number, o: RgRunOpts = {}): Promise<RgResult> {
  if (o.signal?.aborted) return { code: null, killed: 'abort', err: '', skipped: 0 }
  const p = Bun.spawn(rgArgv(rg, args), { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin' } })
  let killed: RgResult['killed'] = null
  const t = setTimeout(() => { killed = 'timeout'; p.kill('SIGKILL') }, timeoutMs)
  const onAbort = () => { if (!killed) killed = 'abort'; p.kill('SIGKILL') }
  o.signal?.addEventListener('abort', onAbort, { once: true })
  const errP = new Response(p.stderr).text()
  const dec = new TextDecoder()
  const cap = o.maxRecordChars ?? Infinity
  let buf = ''
  /** true while the rest of an over-long record arrives; its text is dropped up to the next separator */
  let skipping = false
  let skipped = 0
  try {
    outer: for await (const chunk of p.stdout) {
      let s = dec.decode(chunk, { stream: true })
      if (skipping) {
        const i = s.indexOf(sep)
        if (i < 0) continue
        s = s.slice(i + 1); skipping = false
      }
      buf += s
      let i
      while ((i = buf.indexOf(sep)) >= 0) {
        const rec = buf.slice(0, i); buf = buf.slice(i + 1)
        if (rec.length > cap) { skipped++; continue }
        if (rec && onRecord(rec) === false) { killed = 'cap'; p.kill('SIGKILL'); break outer }
      }
      if (buf.length > cap) { buf = ''; skipping = true; skipped++ }
    }
  } catch {}
  if (!killed && buf && !skipping) onRecord(buf)
  const code = await p.exited
  clearTimeout(t)
  o.signal?.removeEventListener('abort', onAbort)
  return { code, killed, err: (await errP).slice(0, 2000), skipped }
}

const strip = (p: string) => p.replace(/^\.\//, '')

/** bytes of a file that grep reads to see if it is valid UTF-8 */
const UTF8_PROBE = 64 * 1024
/** the largest file ripgrep searches (RG_BASE --max-filesize) */
const RG_MAX_FILE = 50 * 1024 * 1024

/**
 * True when a file is legacy Korean text by the shared rule (CP949, as `read` decodes it). Only a file whose first
 * 64 KB are not valid UTF-8 is read in full, so a grep with many hits does not read every file. A file that is valid
 * UTF-8 in its first 64 KB but not after is thus taken as UTF-8.
 */
export function legacyKoreanFile(abs: string): boolean {
  let fd: number
  // as store.ts readRegular: O_NONBLOCK, so a FIFO put in place of a file cannot block the server; regular files with
  // one link only
  try { fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0)) } catch { return false }
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile() || st.nlink > 1 || st.size > RG_MAX_FILE) return false
    const read = (n: number) => {
      const b = Buffer.alloc(n)
      let off = 0
      while (off < n) { const k = fs.readSync(fd, b, off, n - off, off); if (k <= 0) break; off += k }
      return b.subarray(0, off)
    }
    return legacyKoreanHead(read(Math.min(st.size, UTF8_PROBE)), st.size, () => read(st.size))
  } catch { return false } finally { fs.closeSync(fd) }
}

/** Classify admitted buffers directly: no extra filesystem probe of each snapshot. */
function legacyKoreanHead(head: Buffer, size: number, wholeFile: () => Buffer): boolean {
  const whole = head.length >= size
  // A character cut at the end of the probe is not an error.
  for (let drop = 0; drop <= (whole ? 0 : 3) && drop < head.length; drop++) if (isUtf8(head.subarray(0, head.length - drop))) return false
  return isLegacyKorean(whole ? head : wholeFile())
}

// ---------------- office text sidecar cache ----------------
/** Extracted text of .docx/.pptx/.xlsx/.pdf files, mirrored under <dataDir>/textcache/<path>.txt (server-only). */
/** The text format of the cache. Change it when extractText gives other text for the same file (2: docx headers,
 * footers and comments, pptx notes and charts; 3: body lines that start like a section label are indented; 6: slide
 * labels, Word / Hangul headings, sheet ranges and `# row N` lines, OCR page breaks, files/locations.ts), so the
 * old text is made again. */
export const TEXT_CACHE_VERSION = '6'
/** older formats whose text is still right, only without the newer labels: kept at the update (grep goes on using it)
 * and made again in the background (OfficeCache.upgradeOld); any other older format is removed at start */
const UPGRADABLE_VERSIONS = new Set(['5'])
const VERSION_FILE = '.format-version' // cache files all end in .txt, so no file of the team folder has this name
/** What the folder's version file says: the oldest format whose server may use the folder's text as its own. Format 6
 * text only adds label lines that a format-5 server reads as plain text (it parses none of them), so the file keeps
 * saying 5 and 0.2.16 keeps the cache after a rollback instead of emptying it; each file's own sidecar says its format
 * (current()), and what 0.2.16 writes meanwhile has none, so it is made again after the next update. A later format
 * that a format-5 server must not use raises this too. '6' was written by test builds before the rollback fix. */
const FOLDER_VERSION = '5'
const KEPT_FOLDER_VERSIONS = new Set([FOLDER_VERSION, ...UPGRADABLE_VERSIONS, TEXT_CACHE_VERSION])

/** office files extracted at the same time by one server (foreground and background together) */
export const OFFICE_EXTRACT_PARALLEL = 4
/** the most office files that wait in the background queue; more are left to a later search */
const OFFICE_QUEUE_MAX = 10_000
/** the most office files that wait in the background queue for one owner; more are left to a later search */
export const OFFICE_QUEUE_PER_OWNER = 200
/** the owner of the files that the AI grep (and other callers without a person) adds to the background queue; a
 * person's owner key is 'user:' + id, so no user id can be the same key */
export const OFFICE_SYSTEM_OWNER = 'system'

/**
 * A file whose converters were stopped (files/extract.ts ConverterStopped: the wall clock, a SIGKILL from the
 * converter cgroup's memory.max) gets no text: on a busy server that can pass (a background converter waits for the
 * CPU behind people's work), and an empty text would stand for "no text" until the file changes. Its version is left
 * stale and tried again after OFFICE_RETRY_FIRST_MS, then OFFICE_RETRY_FACTOR times as long after each stop; until
 * then no search tries it (grep counts it in `retryLater`). Until the last try a part a converter was stopped on
 * fails the whole text (Tools.stoppedPartFails), and a retry runs at the caller's priority; the last try runs its
 * converters at normal priority with the normal limits (as a foreground extraction), so the final word comes from such
 * a run, and keeps a stopped part's labelled line. After OFFICE_RETRY_MAX stopped tries an empty text is kept for that
 * version, as for any file that has no text. Kept in memory: a restart tries such a file again.
 */
export const OFFICE_RETRY_MAX = 3
export const OFFICE_RETRY_FIRST_MS = 2 * 60_000
const OFFICE_RETRY_FACTOR = 4
/** the most files whose retry is remembered; the oldest is forgotten (it is then tried as a new file) */
const OFFICE_RETRY_TRACKED_MAX = 10_000
/** the version of a file a retry is for: a changed file is a new file */
const retryVersion = (st: fs.Stats) => `${st.dev}:${st.ino}:${Math.floor(st.mtimeMs)}:${st.size}`

/** one extraction job: it waits with low priority until a foreground caller needs the same file */
interface ExtractTicket { low: boolean; wake?: () => void }

export interface OfficeRefreshOpts {
  /** office files extracted before the answer (default 40); the rest go to the background queue */
  budget?: number
  /** the time limit of the listing (default 60 s) */
  listTimeoutMs?: number
  /** a time (Date.now()) after which refresh stops waiting: files not extracted by then go on in the background */
  deadline?: number
  /** stop waiting when this signal aborts */
  signal?: AbortSignal
  /** the person whose search adds files to the background queue (default OFFICE_SYSTEM_OWNER). The worker takes
   * files from each owner in turn, and one owner has at most OFFICE_QUEUE_PER_OWNER files in the queue. */
  owner?: string
}

export class OfficeCache {
  private inflight = new Map<string, { job: Promise<void>; ticket: ExtractTicket }>()
  private marked = false
  /** extraction slots in use, and the jobs that wait for one: a foreground job (the AI grep, an upload, the semantic
   * index) gets a free slot before a background job, until that job's turn (extract.ts BackgroundTurn) */
  private active = 0
  private waitingHigh: (() => void)[] = []
  private waitingLow: (() => void)[] = []
  private turn = new BackgroundTurn(() => this.now())
  /** the background queue: per owner (in turn order) the files in order, each with the mtime it had when it was
   * added; `owners` gives the owner of each queued path (each path is queued once). One worker. */
  private queue = new Map<string, Map<string, number>>()
  private owners = new Map<string, string>()
  private worker: Promise<void> | null = null
  /** files whose converters a limit stopped (OFFICE_RETRY_MAX): the version, the stopped tries, the next try's time */
  private retries = new Map<string, { version: string; tries: number; next: number }>()
  constructor(readonly dir: string, private fx: FsCtx, private tools: Tools) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    // text of an older format is removed; an empty cache gets the version file only with its first text (a fresh
    // server leaves the folder empty)
    let version: string | null = null
    try { version = fs.readFileSync(path.join(dir, VERSION_FILE), 'utf8').trim() } catch {}
    if (version && KEPT_FOLDER_VERSIONS.has(version)) {
      // each file's own sidecar says its format (current()): text of an upgradable older format is kept and made
      // again in the background (upgradeOld)
      if (version !== FOLDER_VERSION) fs.writeFileSync(path.join(dir, VERSION_FILE), FOLDER_VERSION + '\n', { mode: 0o600 })
      this.marked = true
      return
    }
    for (const e of fs.readdirSync(dir)) fs.rmSync(path.join(dir, e), { recursive: true, force: true })
  }
  /** the file's cached text is of the current format (text kept from an upgradable older format is fresh, not current) */
  current(rel: string): boolean {
    return (this.provenance(rel) as { format?: string } | null)?.format === TEXT_CACHE_VERSION
  }
  cachePath(rel: string) { return path.join(this.dir, rel + '.txt') }
  /** the place index of a large text (files/place-index.ts) */
  placesPath(rel: string) { return this.cachePath(rel) + '.places.json' }
  private provenance(rel: string): { source: string; text: string } | null {
    try { return JSON.parse(readRegular(this.cachePath(rel) + '.source.json', 1024).bytes.toString('utf8')) } catch { return null }
  }
  /** Bind cached text to its actual extraction source, including across path
   * replacement and concurrent cache writers. A pathname/mtime is not provenance. */
  admittedText(rel: string, source: Buffer, admission: SearchAdmission) {
    const meta = this.provenance(rel)
    if (!meta || meta.source !== sha256(source) || this.fx.quarantine?.hasHash(meta.source)) return null
    const abs = this.cachePath(rel)
    const text = admission.read(abs, () => fs.lstatSync(abs))
    return text && meta.text === sha256(text.bytes) ? { ...text, hash: meta.text } : null
  }
  fresh(rel: string, st: fs.Stats) {
    if (this.fx.quarantine?.hasFile(path.join(this.fx.root, rel))) return false
    if (this.fx.quarantine) {
      const meta = this.provenance(rel)
      if (!meta || this.fx.quarantine.hasHash(meta.source)) return false
      // Once quarantine exists, same-mtime replacements also need a source hash
      // check so an old sidecar is re-extracted instead of silently reused.
      if (this.fx.quarantine.db.query('SELECT 1 FROM safe_ops_artifacts LIMIT 1').get()) {
        try { if (meta.source !== sha256(readRegular(path.join(this.fx.root, rel), RG_MAX_FILE).bytes)) return false } catch { return false }
      }
    }
    try { return Math.floor(fs.statSync(this.cachePath(rel)).mtimeMs) === Math.floor(st.mtimeMs) } catch { return false }
  }
  /** the text of one file (a test can replace it); `lastTry`: a part a converter was stopped on gives a labelled line
   * (as for a read) instead of failing the text */
  protected extract(rel: string, bytes: Buffer, o: { lastTry?: boolean } = {}): Promise<string> {
    return extractText(rel, bytes, { ...this.tools, stoppedPartFails: !o.lastTry })
  }
  /** the clock of the retries (a test can replace it) */
  protected now(): number { return Date.now() }
  /** the retry of this version of rel, if its converters were stopped (OFFICE_RETRY_MAX) */
  private retryOf(rel: string, st: fs.Stats) {
    const r = this.retries.get(rel)
    return r && r.version === retryVersion(st) ? r : undefined
  }
  /** this version of rel waits for its retry: its converters were stopped by a limit a short while ago */
  waitsForRetry(rel: string, st: fs.Stats): boolean {
    const r = this.retryOf(rel, st)
    return !!r && this.now() < r.next
  }
  private noteStopped(rel: string, st: fs.Stats, tries: number) {
    this.retries.delete(rel)
    if (this.retries.size >= OFFICE_RETRY_TRACKED_MAX) this.retries.delete(this.retries.keys().next().value!)
    this.retries.set(rel, { version: retryVersion(st), tries, next: this.now() + OFFICE_RETRY_FIRST_MS * OFFICE_RETRY_FACTOR ** (tries - 1) })
  }
  private async slot<T>(f: () => Promise<T>, t: ExtractTicket): Promise<T> {
    // a low job also waits while a foreground job waits, so a freed slot goes to the foreground first, until its turn
    while (this.active >= OFFICE_EXTRACT_PARALLEL || (t.low && this.waitingHigh.length && !this.turn.due())) {
      if (t.low) {
        this.turn.wait()
        // woken for a slot it may not take after all (two ended at once): it goes to the first foreground job in line
        if (this.active < OFFICE_EXTRACT_PARALLEL) this.waitingHigh.shift()?.()
      }
      await new Promise<void>((r) => { t.wake = r; (t.low ? this.waitingLow : this.waitingHigh).push(r) })
      t.wake = undefined
    }
    this.active++
    if (t.low) this.turn.restart(this.waitingLow.length > 0)
    else this.turn.pass()
    try { return await f() } finally {
      this.active--
      const next = (this.turn.due() ? this.waitingLow.shift() : undefined) ?? this.waitingHigh.shift() ?? this.waitingLow.shift()
      next?.()
    }
  }
  /** a foreground caller joins a low job: the job gets high priority (it moves to the foreground waiters) */
  private raise(t: ExtractTicket) {
    if (!t.low) return
    t.low = false
    // past this queue its converter may be waiting for an office worker as background work
    officeWorkersRecheck()
    const wake = t.wake
    if (!wake) return
    const i = this.waitingLow.indexOf(wake)
    if (i < 0) return
    this.waitingLow.splice(i, 1)
    if (!this.waitingLow.length) this.turn.restart(false)
    // a free slot: the job checks again at once; else it waits with the foreground jobs
    if (this.active < OFFICE_EXTRACT_PARALLEL) wake(); else this.waitingHigh.push(wake)
  }
  /** a person waits for this file: its job, if it has one, moves up as when they join it */
  hurry(rel: string) {
    const job = this.inflight.get(rel)
    if (job) this.raise(job.ticket)
  }
  private write(rel: string, text: string, st: fs.Stats, source = '') {
    const dst = this.cachePath(rel)
    if (!this.marked) { fs.writeFileSync(path.join(this.dir, VERSION_FILE), FOLDER_VERSION + '\n', { mode: 0o600 }); this.marked = true }
    fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 })
    const bytes = Buffer.from(text)
    const hash = sha256(bytes)
    // a large text gets its place index (grep's labels, files/place-index.ts), made from the very file written
    let places: PlaceIndex | null = null
    // the old index goes first, so it is never left next to a text it was not made from (a failed write below)
    try { fs.rmSync(this.placesPath(rel), { force: true }) } catch {}
    const fd = fs.openSync(dst, 'w+', 0o600)
    try {
      fs.writeFileSync(fd, bytes)
      fs.futimesSync(fd, st.atime, st.mtime)
      try { places = makePlaceIndex(fd, structureOf(rel), hash) } catch {}
    } finally { fs.closeSync(fd) }
    fs.writeFileSync(dst + '.source.json', JSON.stringify({ source, text: hash, format: TEXT_CACHE_VERSION }), { mode: 0o600 })
    writePlaceIndex(this.placesPath(rel), places)
  }
  /**
   * The places of some lines of rel's cached text at `abs` (files/locations.ts locsOfLines), read in pieces up to the
   * last line asked for, from the last point of its place index before each line where it has a usable one. `abs`
   * is the cache itself (a live search), or an admitted copy of it whose sha256 is `admitted`. Null when the text
   * cannot be read.
   */
  linePlaces(abs: string, rel: string, lines: number[], admitted?: string): Map<number, SourceLoc> | null {
    let fd: number
    try { fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0)) } catch { return null }
    try {
      const st = fs.fstatSync(fd)
      if (!st.isFile() || st.nlink > 1 || st.size > RG_MAX_FILE) return null
      const kind = structureOf(rel)
      return placesOfLines(fd, st.size, kind, lines, kind ? readPlaceIndex(this.placesPath(rel), kind, st, admitted) : null)
    } catch { return null } finally { fs.closeSync(fd) }
  }
  /**
   * (Re)extract one file unless its text is fresh; content is read through the checked fd. When the file cannot be
   * read (too large, no access, not a regular file), its old text is removed: an empty text with the file's mtime
   * stands for "no text for this version", so the next search does not try it again until the file changes. When the
   * file is gone, its text is deleted. A converter that a limit stopped leaves the file stale for a later retry
   * (OFFICE_RETRY_MAX).
   */
  update(rel: string, o: { background?: boolean; upgrade?: boolean } = {}): Promise<void> {
    const running = this.inflight.get(rel)
    if (running) { if (!o.background) this.raise(running.ticket); return running.job }
    const ticket: ExtractTicket = { low: !!o.background }
    const job = this.slot(async () => {
      const abs = path.join(this.fx.root, ...rel.split('/'))
      let lst: fs.Stats
      try { lst = fs.lstatSync(abs) } catch { this.retries.delete(rel); fs.rmSync(this.cachePath(rel), { force: true }); return }
      if (this.fx.quarantine?.hasFile(abs)) { this.retries.delete(rel); fs.rmSync(this.cachePath(rel), {force:true}); return }
      // `upgrade`: text kept from an older format is made again too
      const kept = this.fresh(rel, lst)
      if (kept && (!o.upgrade || this.current(rel))) return
      // converters stopped by a limit a short while ago: not again before the retry's time
      const retry = this.retryOf(rel, lst)
      if (retry && this.now() < retry.next) return
      const lastTry = (retry?.tries ?? 0) + 1 >= OFFICE_RETRY_MAX
      let got: { bytes: Buffer; st: fs.Stats }
      try { got = readRegular(abs, Math.min(50 * 1024 * 1024, readMaxBytes())) } catch (e) {
        try { if (lst.isFile()) this.write(rel, '', lst); else fs.rmSync(this.cachePath(rel), { force: true }) } catch { fs.rmSync(this.cachePath(rel), { force: true }) }
        throw e
      }
      const admission = new SearchAdmission(this.fx.quarantine)
      try {
        // Re-read by identity and lease the exact bytes across async extraction.
        const input = admission.read(abs, () => {
          if (this.fx.quarantine?.hasFile(abs)) return false
          return fs.lstatSync(abs)
        }, Math.min(50 * 1024 * 1024, readMaxBytes()))
        if (!input) { fs.rmSync(this.cachePath(rel), { force: true }); return }
        let text: string
        // a background job's converters run below interactive work (tools/isolate.ts backgroundPrefix) while no
        // foreground caller has joined it; those of the last try at normal priority, and they still wait behind
        // people's work for an office worker
        try { text = await inBackground(() => ticket.low && !lastTry, () => this.extract(rel, input.bytes, { lastTry }), () => ticket.low) } catch (e) {
          // an upgrade that fails (a timeout on a busy server, the converters' memory limit) keeps the older text of
          // these very bytes: grep goes on with it, and the next start tries again
          if (kept && this.provenance(rel)?.source === sha256(input.bytes)) return
          // stopped by a limit: no text yet, tried again later (up to OFFICE_RETRY_MAX tries)
          if (e instanceof ConverterStopped && !lastTry) { this.noteStopped(rel, input.st, (retry?.tries ?? 0) + 1); return }
          text = ''
        }
        this.retries.delete(rel)
        this.write(rel, text, input.st, sha256(input.bytes))
      } finally { admission.close() }
    }, ticket).finally(() => this.inflight.delete(rel))
    this.inflight.set(rel, { job, ticket })
    return job
  }
  /**
   * Make again, in the background, the text kept from an older format at the update (UPGRADABLE_VERSIONS): newest
   * first, one file at a time with background priority (a person's grep or upload goes first), and after each file a
   * pause as long as it took, so it takes at most half of one extraction slot. Until a file is done, grep uses its old
   * text. Each file's sidecar says its format, so after a restart it goes on with what is left. Returns the files done.
   */
  async upgradeOld(o: { signal?: AbortSignal; minPauseMs?: number } = {}): Promise<number> {
    const old: { rel: string; mtime: number }[] = []
    // the scan reads every sidecar: it lets the server's other work (chats) in every few hundred files, so tens of
    // thousands of documents on a small server do not hold up the event loop at once
    let seen = 0
    const visit = async (sub: string): Promise<void> => {
      let names: fs.Dirent[]
      try { names = fs.readdirSync(path.join(this.dir, sub), { withFileTypes: true }) } catch { return }
      for (const e of names) {
        if (o.signal?.aborted) return
        if (++seen % 256 === 0) await new Promise<void>((r) => setImmediate(r))
        const rel = sub ? `${sub}/${e.name}` : e.name
        if (e.isDirectory()) await visit(rel)
        else if (e.isFile() && e.name.endsWith('.txt.source.json')) {
          const src = rel.slice(0, -'.txt.source.json'.length)
          if (this.current(src)) continue
          try { old.push({ rel: src, mtime: fs.statSync(this.cachePath(src)).mtimeMs }) } catch {}
        }
      }
    }
    await visit('')
    old.sort((a, b) => b.mtime - a.mtime)
    let done = 0
    for (const { rel } of old) {
      if (o.signal?.aborted) break
      const t0 = Date.now()
      await this.update(rel, { background: true, upgrade: true }).catch(() => {})
      done++
      const pause = Math.max(o.minPauseMs ?? 100, Date.now() - t0)
      await new Promise<void>((r) => { const t = setTimeout(r, pause); o.signal?.addEventListener('abort', () => { clearTimeout(t); r() }, { once: true }) })
    }
    return done
  }
  /** for tests and tools: resolves when no extraction runs and the background queue is empty */
  async idle() { while (this.worker || this.inflight.size) await Promise.all([this.worker, ...[...this.inflight.values()].map((x) => x.job)].map((p) => p?.catch(() => {}))) }
  /** for tests: files in the background queue (also the one the worker extracts now) */
  queued() { return this.owners.size + (this.worker ? 1 : 0) }
  /**
   * Add stale files to the one background queue of the server, for `owner`. A file that waits (any owner) or is being
   * extracted is not added again. One owner has at most OFFICE_QUEUE_PER_OWNER files in the queue. When the whole
   * queue is full, an owner with fewer files takes the place of the last file of the owner with the most files, so a
   * new owner can always add files. Files that are not added are left to a later search. Returns the number of the
   * items that wait or are being extracted after the call.
   */
  private enqueue(items: { rel: string; mtime: number }[], owner: string): number {
    let accepted = 0
    for (const { rel, mtime } of items) {
      if (this.inflight.has(rel)) { accepted++; continue }
      const had = this.owners.get(rel)
      if (had !== undefined) { this.queue.get(had)!.set(rel, mtime); accepted++; continue }
      const mine = this.queue.get(owner)
      if ((mine?.size ?? 0) >= OFFICE_QUEUE_PER_OWNER) continue
      if (this.owners.size >= OFFICE_QUEUE_MAX && !this.dropFromLargest(mine?.size ?? 0)) continue
      if (mine) mine.set(rel, mtime); else this.queue.set(owner, new Map([[rel, mtime]]))
      this.owners.set(rel, owner)
      accepted++
    }
    this.startWorker()
    return accepted
  }
  /** remove the last file of the owner with the most files, when that owner has more than `than` files */
  private dropFromLargest(than: number): boolean {
    let big: Map<string, number> | undefined
    for (const m of this.queue.values()) if (!big || m.size > big.size) big = m
    if (!big || big.size <= than + 1) return false
    const last = [...big.keys()].pop()!
    big.delete(last); this.owners.delete(last)
    return true
  }
  /** the next file of the background queue: the first file of the first owner; that owner then goes to the end */
  private takeNext(): string | undefined {
    for (const [owner, files] of this.queue) {
      this.queue.delete(owner)
      const [first] = files.keys()
      if (first === undefined) continue
      files.delete(first); this.owners.delete(first)
      if (files.size) this.queue.set(owner, files)
      return first
    }
    return undefined
  }
  private startWorker() {
    if (this.worker || !this.owners.size) return
    this.worker = (async () => {
      // one worker with low priority: it holds at most one extraction slot, and a foreground job gets a free slot first
      for (let r = this.takeNext(); r !== undefined; r = this.takeNext()) await this.update(r, { background: true }).catch(() => {})
    })().finally(() => { this.worker = null; this.startWorker() })
  }
  /**
   * Make sure cached text exists for the office files under the roots. Extracts at most `budget` now and waits for
   * them until `deadline`; the rest (and those still running at the deadline) go on in the background. `pending` is
   * the number of files whose text was not ready at the answer and that wait or are being extracted; `notQueued` is
   * the number of the other stale files (the queue did not take them; a later search adds them); `retryLater` the
   * number of those whose converters a limit stopped (OFFICE_RETRY_MAX): they are not tried before their retry time.
   */
  async refresh(rg: string, roots: string[], excludes: string[], filter: (rel: string) => fs.Stats | null, o: OfficeRefreshOpts = {}): Promise<{ pending: number; notQueued: number; retryLater: number; timedOut: boolean }> {
    if (!roots.length) return { pending: 0, notQueued: 0, retryLater: 0, timedOut: false }
    const budget = o.budget ?? 40
    const stale: string[] = []
    const stats = new Map<string, fs.Stats>()
    let retryLater = 0
    const listTimeout = Math.max(1, Math.min(o.listTimeoutMs ?? 60000, o.deadline ? o.deadline - Date.now() : Infinity))
    const listed = await runRg(rg, ['--files', '--null', ...RG_BASE, '--glob-case-insensitive', '--glob', OFFICE_GLOB, ...excludeArgs(excludes), '--', ...roots], this.fx.root, '\0', (r) => {
      const rel = strip(r); if (!isOffice(rel)) return
      const st = filter(rel); if (!st || this.fresh(rel, st)) return
      if (this.waitsForRetry(rel, st)) { retryLater++; return }
      stale.push(rel); stats.set(rel, st)
    }, listTimeout, { signal: o.signal })
    let timedOut = listed.killed === 'timeout'
    const now = stale.slice(0, budget)
    let later = stale.slice(budget)
    let unfinished = 0
    for (let i = 0; i < now.length; i += 4) {
      const left = o.deadline ? o.deadline - Date.now() : Infinity
      if (left <= 0 || o.signal?.aborted) { timedOut ||= left <= 0; later = [...now.slice(i), ...later]; break }
      const batch = now.slice(i, i + 4)
      const all = Promise.all(batch.map((r) => this.update(r).catch(() => {}))).then(() => true)
      const stops: Promise<boolean>[] = [all]
      let timer: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined
      if (left !== Infinity) stops.push(new Promise((r) => { timer = setTimeout(() => r(false), left) }))
      if (o.signal) stops.push(new Promise((r) => { onAbort = () => r(false); o.signal!.addEventListener('abort', onAbort, { once: true }) }))
      const finished = await Promise.race(stops)
      clearTimeout(timer); if (onAbort) o.signal!.removeEventListener('abort', onAbort)
      if (!finished) {
        // the batch goes on (update() is shared); its files and the rest are not ready for this answer
        timedOut ||= !o.signal?.aborted
        later = [...now.slice(i + 4), ...later]
        unfinished = batch.length
        break
      }
      // a file of the batch whose converters a limit stopped waits for its retry
      for (const r of batch) if (this.waitsForRetry(r, stats.get(r)!)) retryLater++
    }
    const queued = later.length ? this.enqueue(later.map((rel) => ({ rel, mtime: Math.floor(stats.get(rel)!.mtimeMs) })), o.owner !== undefined ? 'user:' + o.owner : OFFICE_SYSTEM_OWNER) : 0
    return { pending: queued + unfinished, notQueued: later.length - queued, retryLater, timedOut }
  }
}

export interface SearchDeps { fx: FsCtx; rules: RuleSet; user: Principal; rg: string; timeoutMs: number; office: OfficeCache }

function rootsFor(d: SearchDeps, baseSegs: string[], baseIsFile: boolean) {
  if (baseIsFile) return { roots: visiblePath(d.fx, d.rules, d.user, baseSegs.join('/')) ? [baseSegs.join('/')] : [], excludes: [] }
  return allowedRoots(d.fx, d.rules, d.user, baseSegs)
}

// ---------------- glob ----------------
export async function globFiles(d: SearchDeps, baseSegs: string[], baseIsFile: boolean, pattern: string, limit = 100) {
  const { roots, excludes } = rootsFor(d, baseSegs, baseIsFile)
  if (!roots.length) return { files: [] as string[], truncated: false, filtered: 0 }
  const fold = (s: string) => (d.fx.caseInsensitive ? s.toLowerCase() : s)
  const g = new Bun.Glob(fold(pattern))
  const prefix = baseSegs.length ? baseSegs.join('/') + '/' : ''
  const hits: { rel: string; mtime: number }[] = []
  let filtered = 0
  const r = await runRg(d.rg, ['--files', '--null', ...RG_BASE, ...excludeArgs(excludes), '--', ...roots], d.fx.root, '\0', (rec) => {
    const rel = strip(rec)
    const relToBase = rel.startsWith(prefix) ? rel.slice(prefix.length) : rel
    if (!g.match(fold(relToBase)) && !g.match(fold(rel))) return
    const st = visiblePath(d.fx, d.rules, d.user, rel)
    if (st) hits.push({ rel, mtime: st.mtimeMs }); else filtered++
    if (hits.length >= 20000) return false
  }, d.timeoutMs)
  hits.sort((a, b) => b.mtime - a.mtime || a.rel.localeCompare(b.rel))
  return { files: hits.slice(0, limit).map((h) => h.rel), truncated: hits.length > limit || r.killed !== null, filtered }
}

// ---------------- grep ----------------
export interface GrepOpts {
  pattern: string; glob?: string; type?: string; mode: 'content' | 'files_with_matches' | 'count'
  ignoreCase?: boolean; lineNumbers: boolean; before: number; after: number; limit: number; multiline?: boolean
  /** the pattern is literal text, not a regular expression (ripgrep -F; the file screen's content search) */
  fixed?: boolean
  /** at most this many matching lines from one file (ripgrep -m) */
  maxPerFile?: number
  /** the whole search, office text included, stays in d.timeoutMs; office files that are not extracted in time are
   * left to the background (stats.officePending). Without it, the office listing has its own 60 s and the last pass
   * its own d.timeoutMs (the AI tool). */
  strictTime?: boolean
  /** office files extracted before the answer (default 40); the rest are extracted in the background. 0: no
   * extraction before the answer (the content search); then stats.officePending counts the stale office files that
   * the background queue holds, and stats.officeNotQueued the stale office files that it did not take */
  officeBudget?: number
  /** the person who adds stale office files to the background queue (OfficeRefreshOpts.owner) */
  officeOwner?: string
  /** stop the search (kill ripgrep, stop waiting for office text) when this signal aborts */
  signal?: AbortSignal
  /** place labels for the lines of documents ("p.12", "sheet '매출' A12:F12"; files/locations.ts) in this language;
   * without it, no labels (the file screen's content search) */
  lang?: Lang
}

/** the longest ripgrep --json record that grep reads (UTF-16 units); the line of a longer record is skipped
 * (stats.longSkipped), because --json gives the whole line and ignores --max-columns. The limit is on the record, not
 * on the line: each match and each JSON escape make the record longer, so a shorter line with very many matches or
 * escaped characters can also be skipped. */
export const RG_MAX_RECORD_CHARS = 64 * 1024

/** One matching line (content mode): the shown path, its 1-based line number and the line text; for a document line,
 * its page, sheet row, slide or section when known (files/locations.ts). */
export interface GrepHit { path: string; line: number; text: string; loc?: SourceLoc }

export async function grepFiles(d: SearchDeps, baseSegs: string[], baseIsFile: boolean, o: GrepOpts) {
  const { roots, excludes } = rootsFor(d, baseSegs, baseIsFile)
  const stats = { roots: roots.length, excludes: excludes.length, filtered: 0, officePending: 0, officeNotQueued: 0, officeRetryLater: 0, longSkipped: 0 }
  const hits: GrepHit[] = []
  if (!roots.length) return { text: 'No matches', truncated: false, timedOut: false, stats, files: new Set<string>(), hits }
  // user glob: basename-only globs go to ripgrep; globs with "/" are matched here against the result path
  if (o.glob?.startsWith('!')) throw new ToolError('negated globs are not supported')
  const pathGlob = o.glob && o.glob.includes('/') ? new Bun.Glob(o.glob) : null
  const nameGlob = o.glob && !o.glob.includes('/') ? o.glob : null
  const common: string[] = [...RG_BASE]
  if (o.type) common.push('--type', o.type)
  common.push(o.ignoreCase ? '-i' : '-s')
  if (o.fixed) common.push('-F')
  if (o.maxPerFile) common.push('-m', String(o.maxPerFile))
  if (o.multiline) common.push('-U', '--multiline-dotall')
  if (o.mode === 'content') { common.push('--json'); if (o.before) common.push('-B', String(o.before)); if (o.after) common.push('-A', String(o.after)) }
  else if (o.mode === 'count') common.push('--count-matches', '--with-filename', '--null')
  else common.push('--files-with-matches', '--null')

  const out: string[] = []
  /** files whose content (or the fact that they match) went into the result */
  const files = new Set<string>()
  const seen = new Map<string, boolean>()
  const ok = (shown: string, real: string) => {
    if (!seen.has(real)) {
      let v = !!visiblePath(d.fx, d.rules, d.user, real)
      if (!v) stats.filtered++
      if (v && pathGlob && !pathGlob.match(shown)) v = false
      seen.set(real, v)
    }
    return seen.get(real)!
  }
  let truncated = false
  const push = (s: string) => { if (out.length >= o.limit) { truncated = true; return false } out.push(s); return true }
  let last: { file: string; line: number } | null = null
  /** document lines of the result whose place label is added once ripgrep is done: index in `out` (and in `hits`) */
  const placed: { out: number; hit: number; real: string; line: number; sep: string; text: string }[] = []
  let placing: string | null = null
  /** files that are legacy Korean text (decided once per file, only for files with results) */
  const legacy = new Map<string, boolean>()
  const isLegacy = (real: string) => {
    if (live && !legacy.has(real)) legacy.set(real, legacyKoreanFile(path.join(d.fx.root, real)))
    return legacy.get(real) ?? false
  }
  // `keep` runs after the access check, so grep reads only files that this user can see
  const handler = (map: (p: string) => { shown: string; real: string } | null, keep: (real: string) => boolean = () => true) => (rec: string) => {
    if (o.mode === 'content') {
      let j: any; try { j = JSON.parse(rec) } catch { return }
      if (j.type !== 'match' && j.type !== 'context') return
      const raw = j.data.path.text ?? Buffer.from(j.data.path.bytes, 'base64').toString('utf8')
      const m = map(raw); if (!m || !ok(m.shown, m.real) || !keep(m.real)) return
      const ln: number = j.data.line_number
      const text = (j.data.lines.text ?? Buffer.from(j.data.lines.bytes ?? '', 'base64').toString('utf8')).replace(/\r?\n$/, '')
      if (last && (last.file !== m.shown || ln > last.line + 1) && (o.before || o.after)) if (!push('--')) return false
      last = { file: m.shown, line: ln }
      const sep = j.type === 'match' ? ':' : '-'
      const pushed = push(o.lineNumbers ? `${m.shown}${sep}${ln}${sep}${text}` : `${m.shown}${sep}${text}`)
      if (pushed) {
        files.add(m.real)
        if (j.type === 'match') hits.push({ path: m.shown, line: ln, text })
        if (placing && structureOf(m.real)) placed.push({ out: out.length - 1, hit: j.type === 'match' ? hits.length - 1 : -1, real: m.real, line: ln, sep, text })
      }
      return pushed
    }
    const parts = rec.split('\0')
    const m = map(parts[0].replace(/^\n/, '')); if (!m || !ok(m.shown, m.real) || !keep(m.real)) return
    const pushed = push(o.mode === 'count' ? `${m.shown}:${(parts[1] ?? '').trim()}` : m.shown)
    if (pushed) files.add(m.real)
    return pushed
  }
  const recSep: '\n' | '\0' = o.mode === 'files_with_matches' ? '\0' : '\n'
  // literal text is searched in NFC and NFD, so Korean text written in either form matches (macOS can write NFD)
  const patterns = o.fixed ? [...new Set([o.pattern, o.pattern.normalize('NFC'), o.pattern.normalize('NFD')])] : [o.pattern]
  const patArgs = patterns.flatMap((p) => ['-e', p])
  const rgOpts: RgRunOpts = { signal: o.signal, ...(o.mode === 'content' ? { maxRecordChars: RG_MAX_RECORD_CHARS } : {}) }
  /** countSkips: false for pass 2, which reads the same files as pass 1 again (a long line would count twice) */
  const admission = new SearchAdmission(d.fx.quarantine)
  const snapshots = new Map<string, string>()
  /** the sha256 of each office text admitted into the snapshot (its place index is matched by it) */
  const admittedTexts = new Map<string, string>()
  let admissionLimited = false
  let live = false
  const run = async (args: string[], cwd: string, h: (rec: string) => boolean | void, timeoutMs: number, countSkips = true) => {
    if (live) {
      const r = await runRg(d.rg, args, cwd, recSep, h, timeoutMs, rgOpts)
      if (countSkips) stats.longSkipped += r.skipped
      return r
    }
    let frozen = snapshots.get(cwd)
    const until = Date.now() + timeoutMs
    if (!frozen) {
      const staging = path.join(path.dirname(d.office.dir), 'search-inputs')
      fs.mkdirSync(staging, { recursive: true, mode: 0o700 })
      frozen = fs.mkdtempSync(path.join(staging, admission.id + '-'))
      snapshots.set(cwd, frozen)
      // Listing cannot consume content. Preserve rg's type/glob semantics and
      // original directory exclusions; never give content rg a live team path.
      const listArgs = ['--files', '--null', ...RG_BASE]
      const end = args.indexOf('--')
      for (let i = 0; i < end; i++) {
        if (args[i] === '--glob' || args[i] === '--type') listArgs.push(args[i]!, args[++i]!)
        else if (args[i] === '--glob-case-insensitive') listArgs.push(args[i]!)
      }
      const candidates: string[] = []
      const listed = args.length === end + 1 ? { killed: null, code: 0, err: '' } : await runRg(d.rg, [...listArgs, '--', ...args.slice(end + 1)], cwd, '\0', (r) => {
        candidates.push(strip(r)); return candidates.length <= 20_000
      }, timeoutMs, { signal: o.signal })
      if (listed.code === 2 && /type.*(unrecognized|unknown)/i.test(listed.err)) throw new ToolError(listed.err)
      admissionLimited ||= listed.killed !== null
      if (candidates.length > 20_000) candidates.length = 20_000
      let bytes = 0
      const directories = new Set<string>()
      admission.transaction(() => {
        for (const rel of candidates) {
          if (o.signal?.aborted || Date.now() >= until) { admissionLimited = true; break }
          const office = cwd === d.office.dir
          const real = office ? rel.replace(/\.txt$/, '') : rel
          const validate = () => visiblePath(d.fx, d.rules, d.user, real)
          let input: { bytes: Buffer; st: fs.Stats } | null
          if (office) {
            // A sidecar is derived from this source: lease it before admitting
            // the cache too. Stale/redacted or quarantined originals never enter rg.
            const source = admission.read(path.join(d.fx.root, real), validate)
            if (!source || !d.office.fresh(real, source.st)) continue
            const text = d.office.admittedText(real, source.bytes, admission)
            if (text) admittedTexts.set(real, text.hash)
            input = text
          } else input = admission.read(path.join(cwd, rel), validate)
          if (!input) { stats.filtered++; continue }
          if (bytes + input.bytes.length > 256 * 1024 ** 2) { admissionLimited = true; break }
          bytes += input.bytes.length
          const dst = path.join(frozen!, rel)
          const parent = path.dirname(dst)
          if (!directories.has(parent)) { fs.mkdirSync(parent, { recursive: true, mode: 0o700 }); directories.add(parent) }
          fs.writeFileSync(dst, input.bytes, { mode: 0o400, flag: 'wx' })
          if (!office) legacy.set(real, legacyKoreanHead(input.bytes.subarray(0, UTF8_PROBE), input.bytes.length, () => input.bytes))
        }
      })
    }
    const left = until - Date.now()
    if (left <= 0) return { code: null, killed: 'timeout' as const, err: '', skipped: 0 }
    const r = await runRg(d.rg, [...args.slice(0, args.indexOf('--')), '--', '.'], frozen, recSep, h, left, rgOpts)
    if (countSkips) stats.longSkipped += r.skipped
    return r
  }
  // later globs win in ripgrep: user glob first, then the exclusions
  const mainArgs = [...common, '--glob-case-insensitive', ...(nameGlob ? ['--glob', nameGlob] : []), '--glob', '!' + OFFICE_GLOB, ...excludeArgs(excludes), ...patArgs, '--', ...roots.filter((r) => !isOffice(r))]
  // pass 1 searches the raw bytes; a legacy Korean (CP949) file is left to pass 2, which reads it as Korean text
  const id = (p: string) => { const r = strip(p); return { shown: r, real: r } }
  const started = Date.now()
  // strictTime: one deadline for the whole search; a pass that has no time left is not run (timedOut)
  const deadline = started + d.timeoutMs
  const stopped = () => ({ text: (out.join('\n') || 'No matches') + '\n... (search stopped after the time limit)', truncated: true, timedOut: true, stats, files, hits })
  try {
  live = admission.emptyLedger()
  // The lease rules out quarantine on every DB connection until finally below.
  // Avoid per-result quarantine probes on the default, never-used product path.
  if (live) d = { ...d, fx: { ...d.fx, quarantine: undefined } }
  const r1 = await run(mainArgs, d.fx.root, handler(id, (r) => !isLegacy(r)), d.timeoutMs)
  if (r1.code === 2 && !r1.killed && !out.length && /regex|parse|error/i.test(r1.err)) throw new ToolError('invalid pattern: ' + r1.err.trim().split('\n').filter((l) => !/pcre2/i.test(l)).slice(-3).join(' ') + (/look-?around|backreference/i.test(r1.err) ? ' (look-around and backreferences are not supported)' : ''))
  if (r1.killed === 'timeout') return stopped()

  // pass 2: the same search with ripgrep's CP949 decoder (--encoding euc-kr); only legacy Korean files count, so a
  // Korean pattern matches the text that `read` shows, and the lines come back as Korean (QA R2-FMT-08)
  if (!truncated) {
    const left = o.strictTime ? deadline - Date.now() : Math.max(1000, deadline - Date.now())
    if (left <= 0) return stopped()
    const r2 = await run(['--encoding', 'euc-kr', ...mainArgs], d.fx.root, handler(id, isLegacy), left, false)
    if (r2.killed === 'timeout') return stopped()
  }

  let timedOut = false
  // office documents: the same ripgrep over the extracted-text cache, paths mapped back to the originals
  if (!truncated && !o.type) {
    // strictTime: extraction that is not done at the deadline goes on in the background
    if (o.strictTime && deadline - Date.now() <= 0) return stopped()
    const ref = await d.office.refresh(d.rg, roots, excludes, (rel) => visiblePath(d.fx, d.rules, d.user, rel),
      { budget: o.officeBudget ?? 40, signal: o.signal, owner: o.officeOwner, ...(o.strictTime ? { deadline } : {}) })
    stats.officePending = ref.pending
    stats.officeNotQueued = ref.notQueued
    stats.officeRetryLater = ref.retryLater
    if (ref.timedOut && o.strictTime) timedOut = true
    const croots = roots.map((r) => (isOffice(r) ? r + '.txt' : r)).filter((r) => fs.existsSync(path.join(d.office.dir, r)))
    const lastLeft = o.strictTime ? deadline - Date.now() : d.timeoutMs
    if (lastLeft <= 0 && croots.length) timedOut = true
    else if (croots.length) {
      const nameG = nameGlob ? new Bun.Glob(nameGlob) : null
      const map = (p: string) => {
        const real = strip(p).replace(/\.txt$/, '')
        if (!isOffice(real)) return null
        if (nameG && !nameG.match(real.split('/').pop()!)) return null
        return { shown: real, real }
      }
      // only text of the current version of a document: a document that changed after its extraction (a redaction)
      // waits for new text, and its old text is not shown
      const current = new Map<string, boolean>()
      const isCurrent = (real: string) => {
        if (!current.has(real)) { const st = visiblePath(d.fx, d.rules, d.user, real); current.set(real, !!st && d.office.fresh(real, st)) }
        return current.get(real)!
      }
      // the AI's grep only (it gives the language): the file screen's content search shows its own snippets
      placing = o.mode === 'content' && o.lang ? d.office.dir : null
      const r3 = await run([...common, '--glob', '*.txt', ...excludeArgs(excludes), ...patArgs, '--', ...croots], d.office.dir, handler(map, isCurrent), lastLeft)
      placing = null
      if (r3.killed === 'timeout') timedOut = true
      // the place of each document line, from the very text ripgrep searched (the admitted copy, or the cache itself),
      // read only up to the last matching line, from the nearest point of its place index (files/place-index.ts)
      if (placed.length) {
        const dir = live ? d.office.dir : (snapshots.get(d.office.dir) ?? null)
        const byFile = new Map<string, typeof placed>()
        for (const p of placed) byFile.set(p.real, [...(byFile.get(p.real) ?? []), p])
        for (const [real, ps] of byFile) {
          const lines = ps.map((p) => p.line)
          const locs = dir ? d.office.linePlaces(path.join(dir, real + '.txt'), real, lines, live ? undefined : admittedTexts.get(real) ?? '') : locsOfLines('', real, lines)
          if (!locs) continue
          for (const p of ps) {
            const loc = locs.get(p.line)
            if (!loc) continue
            const tag = `${p.real} [${locLabel(loc, o.lang)}]`
            out[p.out] = o.lineNumbers ? `${tag}${p.sep}${p.line}${p.sep}${p.text}` : `${tag}${p.sep}${p.text}`
            if (p.hit >= 0) hits[p.hit]!.loc = loc
          }
        }
      }
    }
  }
  truncated ||= admissionLimited
  let text = out.join('\n') || 'No matches'
  if (admissionLimited) text += '\n' + (d.fx.quarantine ? safeText(d.fx.quarantine.db, d.user.id, 'searchLimit') : SAFE_OPS_TEXT.searchLimit.en)
  else if (truncated) text += `\n... (results cut at ${o.limit}; narrow the search)`
  if (stats.officePending) text += `\n(${stats.officePending} office documents are still being indexed; search again in a minute for complete results)`
  if (stats.officeNotQueued) text += `\n(${stats.officeNotQueued} office documents were not searched; they are not in the index queue yet; search again later)`
  if (stats.officeRetryLater) text += `\n(${stats.officeRetryLater} office documents were not searched: reading their text took too long (a busy server or a very complex file); search again in a few minutes)`
  if (stats.longSkipped) text += `\n(${stats.longSkipped} very long lines were skipped (ripgrep record over ${RG_MAX_RECORD_CHARS / 1024} K characters))`
  return { text, truncated, timedOut, stats, files, hits }
  } finally {
    // runRg has reaped the consumer before release, including timeout/abort.
    // Failed cleanup retains the durable lease (fail closed).
    for (const dir of snapshots.values()) fs.rmSync(dir, { recursive: true, force: true })
    admission.close()
  }
}
