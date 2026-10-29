// grep / glob on ripgrep (design tab 2 "grep 구현"). The permission function decides the allowed roots first;
// ripgrep only receives those roots as positional paths, and every hidden sub-folder inside them as
// `--glob '!<path>'`, so folders the user cannot see are never opened. Every result path is checked again
// (access, name rules, regular file, nlink == 1) before it is shown.
import fs from 'node:fs'
import path from 'node:path'
import { atLeast, type Principal, type RuleSet } from '../policy/access'
import { visiblePath, type FsCtx } from '../policy/authorize'
import { ToolError } from '../policy/errors'
import { walk } from '../policy/resolve'
import { extractText, isOffice, OFFICE_EXT, type Tools } from './extract'
import { readRegular } from './store'
import { readMaxBytes, rgThreads } from '../system/limits'
import { isLegacyKorean, isUtf8 } from '@mycel/shared/text-encoding'

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
    const head = read(Math.min(st.size, UTF8_PROBE))
    const whole = head.length >= st.size
    // a character cut at the end of the probe is not an error
    for (let drop = 0; drop <= (whole ? 0 : 3) && drop < head.length; drop++) if (isUtf8(head.subarray(0, head.length - drop))) return false
    return isLegacyKorean(whole ? head : read(st.size))
  } catch { return false } finally { fs.closeSync(fd) }
}

// ---------------- office text sidecar cache ----------------
/** Extracted text of .docx/.pptx/.xlsx/.pdf files, mirrored under <dataDir>/textcache/<path>.txt (server-only). */
/** The text format of the cache. Change it when extractText gives other text for the same file (2: docx headers,
 * footers and comments, pptx notes and charts; 3: body lines that start like a section label are indented), so the
 * old text is made again. */
export const TEXT_CACHE_VERSION = '3'
const VERSION_FILE = '.format-version' // cache files all end in .txt, so no file of the team folder has this name

/** office files extracted at the same time by one server (foreground and background together) */
export const OFFICE_EXTRACT_PARALLEL = 4
/** the most office files that wait in the background queue; more are left to a later search */
const OFFICE_QUEUE_MAX = 10_000
/** office files that one person (the content search) may add to the background queue in one minute */
export const OFFICE_QUEUE_PER_PERSON_MINUTE = 100
const OFFICE_QUEUE_WINDOW_MS = 60_000

export interface OfficeRefreshOpts {
  /** office files extracted before the answer (default 40); the rest go to the background queue */
  budget?: number
  /** the time limit of the listing (default 60 s) */
  listTimeoutMs?: number
  /** a time (Date.now()) after which refresh stops waiting: files not extracted by then go on in the background */
  deadline?: number
  /** stop waiting when this signal aborts */
  signal?: AbortSignal
  /** the person whose search adds files to the background queue: at most OFFICE_QUEUE_PER_PERSON_MINUTE new files a
   * minute (none: no limit, the AI grep) */
  owner?: string
}

export class OfficeCache {
  private inflight = new Map<string, Promise<void>>()
  private marked = false
  /** extraction slots in use, and the jobs that wait for one: a foreground job (the AI grep, an upload, the semantic
   * index) always gets a free slot before a background job */
  private active = 0
  private waitingHigh: (() => void)[] = []
  private waitingLow: (() => void)[] = []
  /** the background queue (in order; each path once, with the mtime it had when it was added) and its one worker */
  private queue = new Map<string, number>()
  private worker: Promise<void> | null = null
  /** per person: the times at which their searches added a file to the queue (last OFFICE_QUEUE_WINDOW_MS) */
  private added = new Map<string, number[]>()
  constructor(readonly dir: string, private fx: FsCtx, private tools: Tools) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    // text of an older format is removed; an empty cache gets the version file only with its first text (a fresh
    // server leaves the folder empty)
    let version: string | null = null
    try { version = fs.readFileSync(path.join(dir, VERSION_FILE), 'utf8').trim() } catch {}
    if (version === TEXT_CACHE_VERSION) { this.marked = true; return }
    for (const e of fs.readdirSync(dir)) fs.rmSync(path.join(dir, e), { recursive: true, force: true })
  }
  cachePath(rel: string) { return path.join(this.dir, rel + '.txt') }
  fresh(rel: string, st: fs.Stats) {
    try { return Math.floor(fs.statSync(this.cachePath(rel)).mtimeMs) === Math.floor(st.mtimeMs) } catch { return false }
  }
  /** the text of one file (a test can replace it) */
  protected extract(rel: string, bytes: Buffer): Promise<string> { return extractText(rel, bytes, this.tools) }
  private async slot<T>(f: () => Promise<T>, low: boolean): Promise<T> {
    // a low job also waits while a foreground job waits, so a freed slot goes to the foreground first
    while (this.active >= OFFICE_EXTRACT_PARALLEL || (low && this.waitingHigh.length)) {
      await new Promise<void>((r) => (low ? this.waitingLow : this.waitingHigh).push(r))
    }
    this.active++
    try { return await f() } finally { this.active--; (this.waitingHigh.shift() ?? this.waitingLow.shift())?.() }
  }
  private write(rel: string, text: string, st: fs.Stats) {
    const dst = this.cachePath(rel)
    if (!this.marked) { fs.writeFileSync(path.join(this.dir, VERSION_FILE), TEXT_CACHE_VERSION + '\n', { mode: 0o600 }); this.marked = true }
    fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 })
    fs.writeFileSync(dst, text, { mode: 0o600 })
    fs.utimesSync(dst, st.atime, st.mtime)
  }
  /**
   * (Re)extract one file unless its text is fresh; content is read through the checked fd. When the file cannot be
   * read (too large, no access, not a regular file), its old text is removed: an empty text with the file's mtime
   * stands for "no text for this version", so the next search does not try it again until the file changes. When the
   * file is gone, its text is deleted.
   */
  update(rel: string, o: { background?: boolean } = {}): Promise<void> {
    const running = this.inflight.get(rel); if (running) return running
    const job = this.slot(async () => {
      const abs = path.join(this.fx.root, ...rel.split('/'))
      let lst: fs.Stats
      try { lst = fs.lstatSync(abs) } catch { fs.rmSync(this.cachePath(rel), { force: true }); return }
      if (this.fresh(rel, lst)) return
      let got: { bytes: Buffer; st: fs.Stats }
      try { got = readRegular(abs, Math.min(50 * 1024 * 1024, readMaxBytes())) } catch (e) {
        try { if (lst.isFile()) this.write(rel, '', lst); else fs.rmSync(this.cachePath(rel), { force: true }) } catch { fs.rmSync(this.cachePath(rel), { force: true }) }
        throw e
      }
      let text: string
      try { text = await this.extract(rel, got.bytes) } catch { text = '' }
      this.write(rel, text, got.st)
    }, !!o.background).finally(() => this.inflight.delete(rel))
    this.inflight.set(rel, job)
    return job
  }
  /** for tests and tools: resolves when no extraction runs and the background queue is empty */
  async idle() { while (this.worker || this.inflight.size) await Promise.all([this.worker, ...this.inflight.values()].map((p) => p?.catch(() => {}))) }
  /** for tests: files in the background queue (also the one the worker extracts now) */
  queued() { return this.queue.size + (this.worker ? 1 : 0) }
  /**
   * Add stale files to the one background queue of the server. A file that waits (same path and mtime) or is being
   * extracted is not added again. With `owner`, at most OFFICE_QUEUE_PER_PERSON_MINUTE new files a minute are taken
   * from that person; the rest are left to a later search.
   */
  private enqueue(items: { rel: string; mtime: number }[], owner?: string) {
    let times: number[] | undefined
    if (owner) {
      const now = Date.now()
      times = (this.added.get(owner) ?? []).filter((t) => t > now - OFFICE_QUEUE_WINDOW_MS)
      this.added.set(owner, times)
    }
    for (const { rel, mtime } of items) {
      if (this.queue.size >= OFFICE_QUEUE_MAX) break
      if (this.inflight.has(rel)) continue
      const had = this.queue.get(rel)
      if (had === mtime) continue
      if (had === undefined && times) {
        if (times.length >= OFFICE_QUEUE_PER_PERSON_MINUTE) continue
        times.push(Date.now())
      }
      this.queue.set(rel, mtime)
    }
    if (owner && !times!.length) this.added.delete(owner)
    if (this.worker || !this.queue.size) return
    this.worker = (async () => {
      // one worker with low priority: it holds at most one extraction slot, and a foreground job gets a free slot first
      for (const [r] of this.queue) { this.queue.delete(r); await this.update(r, { background: true }).catch(() => {}) }
    })().finally(() => { this.worker = null; if (this.queue.size) this.enqueue([]) })
  }
  /**
   * Make sure cached text exists for the office files under the roots. Extracts at most `budget` now and waits for
   * them until `deadline`; the rest (and those still running at the deadline) go on in the background. `pending` is
   * the number of files whose text was not ready at the answer.
   */
  async refresh(rg: string, roots: string[], excludes: string[], filter: (rel: string) => fs.Stats | null, o: OfficeRefreshOpts = {}): Promise<{ pending: number; timedOut: boolean }> {
    if (!roots.length) return { pending: 0, timedOut: false }
    const budget = o.budget ?? 40
    const stale: string[] = []
    const mtimes = new Map<string, number>()
    const listTimeout = Math.max(1, Math.min(o.listTimeoutMs ?? 60000, o.deadline ? o.deadline - Date.now() : Infinity))
    const listed = await runRg(rg, ['--files', '--null', ...RG_BASE, '--glob-case-insensitive', '--glob', OFFICE_GLOB, ...excludeArgs(excludes), '--', ...roots], this.fx.root, '\0', (r) => {
      const rel = strip(r); if (!isOffice(rel)) return
      const st = filter(rel); if (st && !this.fresh(rel, st)) { stale.push(rel); mtimes.set(rel, Math.floor(st.mtimeMs)) }
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
    }
    if (later.length) this.enqueue(later.map((rel) => ({ rel, mtime: mtimes.get(rel)! })), o.owner)
    return { pending: later.length + unfinished, timedOut }
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
   * extraction before the answer (the content search); then stats.officePending counts all stale office files */
  officeBudget?: number
  /** the person who adds stale office files to the background queue (OfficeRefreshOpts.owner) */
  officeOwner?: string
  /** stop the search (kill ripgrep, stop waiting for office text) when this signal aborts */
  signal?: AbortSignal
}

/** the longest ripgrep --json record that grep reads (UTF-16 units); the line of a longer record is skipped
 * (stats.longSkipped), because --json gives the whole line and ignores --max-columns. The limit is on the record, not
 * on the line: each match and each JSON escape make the record longer, so a shorter line with very many matches or
 * escaped characters can also be skipped. */
export const RG_MAX_RECORD_CHARS = 64 * 1024

/** One matching line (content mode): the shown path, its 1-based line number and the line text. */
export interface GrepHit { path: string; line: number; text: string }

export async function grepFiles(d: SearchDeps, baseSegs: string[], baseIsFile: boolean, o: GrepOpts) {
  const { roots, excludes } = rootsFor(d, baseSegs, baseIsFile)
  const stats = { roots: roots.length, excludes: excludes.length, filtered: 0, officePending: 0, longSkipped: 0 }
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
  /** files that are legacy Korean text (decided once per file, only for files with results) */
  const legacy = new Map<string, boolean>()
  const isLegacy = (real: string) => {
    if (!legacy.has(real)) legacy.set(real, legacyKoreanFile(path.join(d.fx.root, real)))
    return legacy.get(real)!
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
      if (pushed) { files.add(m.real); if (j.type === 'match') hits.push({ path: m.shown, line: ln, text }) }
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
  const run = async (args: string[], cwd: string, h: (rec: string) => boolean | void, timeoutMs: number, countSkips = true) => {
    const r = await runRg(d.rg, args, cwd, recSep, h, timeoutMs, rgOpts)
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
      const r3 = await run([...common, '--glob', '*.txt', ...excludeArgs(excludes), ...patArgs, '--', ...croots], d.office.dir, handler(map, isCurrent), lastLeft)
      if (r3.killed === 'timeout') timedOut = true
    }
  }
  let text = out.join('\n') || 'No matches'
  if (truncated) text += `\n... (results cut at ${o.limit}; narrow the search)`
  if (stats.officePending) text += `\n(${stats.officePending} office documents are still being indexed; search again in a minute for complete results)`
  if (stats.longSkipped) text += `\n(${stats.longSkipped} very long lines were skipped (ripgrep record over ${RG_MAX_RECORD_CHARS / 1024} K characters))`
  return { text, truncated, timedOut, stats, files, hits }
}
