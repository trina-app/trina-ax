// The file list (docs/AGENTS/plan/20261111-0630-file-list.md): every night the team's own AI reads new and changed team
// files and the server keeps one English line per file, saying what it really is, in a `_FILES.md` in each access
// folder (units.ts). The in-app AI greps those lists (chat/prompt.ts FILE_LIST_RULE). It never moves, renames or
// changes a team file: it writes only its own lists (render.ts) and its sidecar in the data folder (store.ts).
//
// A run: list the team folder (no reading); compare size, mtime and hash with the sidecar (unchanged files cost a
// stat, a rename or move with the same bytes moves the line, deleted files drop theirs); write the lists; then read
// what is new or changed, unit by unit, at most PARALLEL model calls at once, each call holding files of one access unit
// only (reader.ts, engine-reader.ts), and write that unit's lists after every call. No call starts while a person's chat
// turn waits or runs. It stops at the night window's end (05:00 team time), on the AI's usage or rate limit, when the
// switch goes off or the server stops; the rest waits for the next run.
//
// When: every night between 02:00 and 05:00 in the team's time zone, at least every 30 hours (the knowledge graph's
// nightlyDue, 5191d9e9); a new server waits for its first night. An admin can start a run now.
//
// At once, without reading: an access change (admin/folders.ts afterAccessChange emits 'access-changed') and a move or
// delete in the team folder (team-files/changes.ts 'tree-changed') rewrite the lists from the sidecar before the request
// that caused them returns, so no list names a file its readers cannot open for longer than that rewrite.
import fs from 'node:fs'
import { constants as C } from 'node:fs'
import path from 'node:path'
import { isFileListName, type FileListStatus, type FileListStop } from '@mycel/shared/api'
import { PRODUCT } from '@mycel/shared'
import type { AppContext } from '../context'
import { getSetting, setSetting, teamTimeZone } from '../admin/settings'
import { RuleSet } from '../policy/access'
import { badSegment, hiddenEntry } from '../policy/names'
import { visionOn } from '../files/vision'
import { cleanFields, unknownFields, type Fields } from './format'
import { prepare, type Item, type PrepareEnv } from './prepare'
import { buildBlocks, parseAnswer, ReaderLimit, ReaderUnavailable, type Reader } from './reader'
import { pickReader, READER_CHAT, type ReaderPick } from './engine-reader'
import { planLists, removeList, writeLists } from './render'
import { Sidecar, type Entry, type Via } from './store'
import { NOT_LISTED_TOP, Units } from './units'

export const ENABLED_SETTING = 'fileList.enabled'
/** model calls at once */
export const PARALLEL = 2
/** files per call: images (each a page or a photo) and texts; texts also by characters; images also by bytes */
export const IMAGE_BATCH = 8
export const TEXT_BATCH = 12
export const TEXT_BATCH_CHARS = 30_000
export const IMAGE_BATCH_BYTES = 12 * 1024 * 1024
/** a file whose reading failed is tried again after this many days */
export const FAILED_RETRY_DAYS = 7
/** the night window (team time) and how often a run is due at least */
export const WINDOW_FROM = 2
export const WINDOW_TO = 5
export const MAX_GAP_H = 30
/** a run due outside the window (a server that is off at night) gets this long */
export const CATCH_UP_MS = 3 * 3600_000

const segsOf = (p: string) => (p === '' ? [] : p.split('/'))
const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.() })
const under = (p: string, folder: string) => p === folder || p.startsWith(folder + '/')

export interface FileListOptions {
  /** the reader (tests: a fake); default: the team's engine (engine-reader.ts pickReader) */
  reader?: () => ReaderPick
  /** the nightly check and the safety recheck; default on, off under NODE_ENV=test */
  loops?: boolean
  /** a person's chat turn waits or runs (default: the turns table, the reader's own turns left out) */
  peopleWaiting?: () => boolean
  /** how often a waiting run looks again (ms) */
  pollMs?: number
  /** the pause before a batch that failed is tried again (ms) */
  retryMs?: number
  now?: () => Date
}

interface RunState { abort: AbortController; trigger: 'nightly' | 'now'; done: Promise<FileListStop>; stop: FileListStop | null }

export class FileList {
  readonly store: Sidecar
  private run: RunState | null = null
  private timers: ReturnType<typeof setInterval>[] = []
  private closed = false
  /** the rule folders the lists were last written with (a change found by the recheck rewrites them) */
  private ruleSig: string | null = null

  constructor(private ctx: AppContext, private o: FileListOptions = {}) {
    const dir = path.join(ctx.engineConfig.dataDir, 'file-list')
    // the sidecar is never in the team folder (it names every file and keeps their descriptions)
    const team = path.resolve(ctx.files.fx.root)
    if (path.resolve(dir).startsWith(team + path.sep)) throw new Error('file list: the data folder must be outside the team folder')
    this.store = new Sidecar(dir)
    this.store.closeOpenRuns()
    // a new server waits for its first night: the 30-hour rule counts from the first start
    if (!this.store.meta('firstSeenAt')) this.store.setMeta('firstSeenAt', this.now().toISOString())
    ctx.files.events.on('tree-changed', this.onTreeChanged)
    ctx.files.events.on('access-changed', this.onAccessChanged)
    if (this.o.loops ?? process.env.NODE_ENV !== 'test') {
      this.timers.push(setInterval(() => { if (this.nightlyDue()) void this.start('nightly') }, 30 * 60_000))
      // the safety net under the hooks: rules changed some other way are noticed within a minute
      this.timers.push(setInterval(() => { try { if (this.on() && this.ruleSig !== this.units().signature) this.rewrite() } catch (e) { this.ctx.log.warn('file list: recheck failed', { err: e }) } }, 60_000))
      const first = setTimeout(() => { if (this.nightlyDue()) void this.start('nightly') }, 2 * 60_000)
      first.unref?.()
      for (const t of this.timers) t.unref?.()
    }
    ctx.onClose(() => this.close())
  }

  private now() { return this.o.now?.() ?? new Date() }
  /** Tests: the reader to use. */
  useReader(pick: () => ReaderPick) { this.o.reader = pick }

  // ---------------------------------------------------------------- the switch
  /** the host turned it off in server.json */
  forcedOff(): boolean { return this.ctx.config.fileList?.enabled === false }
  /** the admin's switch (on unless turned off) */
  switchedOn(): boolean { return getSetting<boolean>(this.ctx.db, ENABLED_SETTING) ?? true }
  on(): boolean { return !this.closed && !this.forcedOff() && this.switchedOn() }
  /** The AI gets the list line: the feature is on and some list exists. */
  promptLine(): boolean { return this.on() && this.store.lists().size > 0 }

  setEnabled(on: boolean) {
    setSetting(this.ctx.db, ENABLED_SETTING, on)
    if (!on) {
      this.run?.abort.abort()
      this.removeAll()
    } else if (this.on()) {
      // the sidecar may be behind (files moved or deleted while off): compare first, then write; nothing is read
      void this.reconcile(new AbortController().signal).then((r) => { this.rewrite(); this.removeStrays(r.lists) }, (e) => this.ctx.log.warn('file list: catching up failed', { err: e }))
    }
  }

  /** Remove every list the server wrote (the sidecar stays). */
  removeAll(): number {
    let n = 0
    for (const rel of this.store.lists().keys()) { if (removeList(this.ctx.files.fx.root, rel)) n++; this.store.dropList(rel) }
    return n
  }

  // ---------------------------------------------------------------- lists
  private units(): Units & { signature: string } {
    const folders = RuleSet.load(this.ctx.db).ruleFolders().sort()
    return Object.assign(new Units(folders), { signature: folders.join('\u0000') })
  }

  /** Write every list as the sidecar and the rules say now (no reading); remove the server's lists not wanted now. */
  rewrite() {
    if (!this.on()) return null
    const units = this.units()
    const p = planLists(this.store.all().values(), units)
    if (p.mismatched.length) this.ctx.log.warn('file list: lines left out (access differs from their list)', { count: p.mismatched.length })
    const w = writeLists(this.ctx.files.fx.root, p.texts, this.store, p.lines)
    this.ruleSig = units.signature
    if (w.skipped.length) this.ctx.log.info('file list: lists not written (a file of that name that is not the server\'s, or the folder is gone)', { count: w.skipped.length })
    return w
  }

  /** Write the lists of the folders these files are listed in (after a batch: lists only grow). */
  private writeFor(paths: Iterable<string>) {
    if (!this.on()) return
    const units = this.units()
    // the rules changed since the lists were written: everything is rewritten (lines may move to other lists)
    if (units.signature !== this.ruleSig) { this.rewrite(); return }
    const bases = new Set<string>()
    for (const p of paths) { const s = segsOf(p); if (units.listable(s)) bases.add(units.listFolderOf(s)) }
    for (const base of bases) {
      const entries = this.store.under(base).filter((e) => { const s = segsOf(e.path); return units.listable(s) && units.listFolderOf(s) === base })
      const p = planLists(entries, units)
      writeLists(this.ctx.files.fx.root, p.texts, this.store, p.lines, false)
    }
  }

  /** An admin changed rules, groups, roles or people: lines whose unit changed move at once. */
  private onAccessChanged = () => {
    try { if (this.on() && this.units().signature !== this.ruleSig) this.rewrite() } catch (e) { this.ctx.log.error('file list: rewrite after an access change failed', { err: e }) }
  }

  /** Files moved, were renamed or deleted: their lines follow or go at once; a list a moved folder carried is removed
   * there (no reading). */
  private onTreeChanged = (e: { paths?: string[]; moves?: { from: string; to: string }[] } | undefined) => {
    if (!this.on() || !e) return
    try {
      const root = this.ctx.files.fx.root
      let changed = false
      for (const m of e.moves ?? []) {
        // lists the server wrote inside a moved folder came along: removed at their new place (the rewrite below writes
        // what is wanted there)
        for (const rel of this.store.lists().keys()) {
          if (!under(rel, m.from)) continue
          removeList(root, m.to + rel.slice(m.from.length))
          this.store.dropList(rel)
          changed = true
        }
        for (const ent of this.store.under(m.from)) {
          const to = m.to + ent.path.slice(m.from.length)
          const st = lstatFile(path.join(root, ...segsOf(to)))
          this.store.tx(() => {
            this.store.delete(ent.path)
            // the same file at its new path (a move keeps size and mtime): its line moves without a read
            if (st && st.size === ent.size && st.mtimeMs === ent.mtimeMs && !this.store.get(to)) this.store.put({ ...ent, path: to, via: ent.via === 'model' || ent.via === 'copy' ? 'moved' : ent.via })
          })
          changed = true
        }
      }
      const found: string[] = []
      for (const p of e.paths ?? []) {
        for (const ent of this.store.under(p)) if (!lstatFile(path.join(root, ...segsOf(ent.path)))) { this.store.delete(ent.path); changed = true }
        // a folder that arrived (restored, moved in) may hold a list of the server's from where it was
        findLists(root, p, found)
      }
      if (changed) this.rewrite()
      if (found.length) this.removeStrays(found)
    } catch (err) { this.ctx.log.error('file list: rewrite after a move failed', { err }) }
  }

  // ---------------------------------------------------------------- status
  status(): FileListStatus {
    const c = this.store.counts()
    const last = this.store.lastRun()
    let problem: FileListStatus['problem'] = null
    let signIn: FileListStatus['signIn'] = null
    if (this.forcedOff()) problem = 'forced_off'
    else {
      const pick = this.pickReader()
      if (pick.ok) { try { signIn = pick.reader.signIn?.() ?? null } catch (e) { this.ctx.log.warn('file list: sign-in not known', { err: e }) } }
      if (this.switchedOn()) {
        if (!pick.ok) problem = 'no_engine'
        else if (last?.stoppedBy === 'limit') problem = 'limited'
      }
    }
    return {
      enabled: this.switchedOn(), forcedOff: this.forcedOff(), running: !!this.run, listed: c.listed, waiting: c.waiting,
      lastRun: last ? { startedAt: last.startedAt, endedAt: last.endedAt, trigger: last.trigger, read: last.read, stoppedBy: last.stoppedBy } : null,
      nextRunAt: this.on() ? this.nextRunAt().toISOString() : null, problem, signIn,
    }
  }

  private pickReader(): ReaderPick {
    try { return (this.o.reader ?? (() => pickReader(this.ctx)))() } catch (e) { this.ctx.log.warn('file list: no reader', { err: e }); return { ok: false, problem: 'no_engine' } }
  }

  // ---------------------------------------------------------------- when
  private tz(): string { try { return teamTimeZone(this.ctx.db) } catch { return 'UTC' } }
  private hour(d: Date): number { return Number(new Intl.DateTimeFormat('en-US', { timeZone: this.tz(), hour: 'numeric', hourCycle: 'h23' }).format(d)) }
  private lastNightly(): number { return Date.parse(this.store.meta('lastNightlyAt') ?? this.store.meta('firstSeenAt') ?? '') || 0 }

  /** A nightly run is due: 12 hours after the last one inside the window (02:00–05:00 team time), or 30 hours after it. */
  nightlyDue(): boolean {
    if (!this.on() || this.run) return false
    const now = this.now(), since = now.getTime() - this.lastNightly()
    if (since > MAX_GAP_H * 3600_000) return true
    if (since < 12 * 3600_000) return false
    const h = this.hour(now)
    return h >= WINDOW_FROM && h < WINDOW_TO
  }

  /** The first moment from `from` on (in 15-minute steps, within 2 days) whose team-time hour is `h`. */
  private nextHour(from: Date, h: number): Date {
    const step = 15 * 60_000
    let t = Math.ceil(from.getTime() / step) * step
    for (let i = 0; i < 200; i++, t += step) if (this.hour(new Date(t)) === h && this.hour(new Date(t - step)) !== h) return new Date(t)
    return new Date(from.getTime() + 24 * 3600_000)
  }

  nextRunAt(): Date {
    const now = this.now(), last = this.lastNightly()
    const earliest = new Date(Math.max(now.getTime(), last + 12 * 3600_000))
    const h = this.hour(earliest)
    let next = h >= WINDOW_FROM && h < WINDOW_TO ? earliest : this.nextHour(earliest, WINDOW_FROM)
    const gap = last + MAX_GAP_H * 3600_000
    if (gap < next.getTime()) next = new Date(Math.max(now.getTime(), gap))
    return next
  }

  // ---------------------------------------------------------------- runs
  /** Start a run in the background (nothing when one is going or the feature is off). */
  start(trigger: 'nightly' | 'now'): Promise<FileListStop> | null {
    if (!this.on() || this.run) return this.run?.done ?? null
    const abort = new AbortController()
    let deadline: number | null = null
    if (trigger === 'nightly') {
      const now = this.now()
      this.store.setMeta('lastNightlyAt', now.toISOString())
      const h = this.hour(now)
      deadline = h >= WINDOW_FROM && h < WINDOW_TO ? this.nextHour(now, WINDOW_TO).getTime() : now.getTime() + CATCH_UP_MS
    }
    const state: RunState = { abort, trigger, stop: null, done: Promise.resolve('done') }
    this.run = state
    state.done = this.execute(state, deadline).catch((e) => { this.ctx.log.error('file list: run failed', { err: e }); return 'failed' as const }).finally(() => { if (this.run === state) this.run = null })
    return state.done
  }

  /** Tests and close: the run going now, if any. */
  whenIdle(): Promise<unknown> { return this.run?.done ?? Promise.resolve() }

  private peopleWaiting(): boolean {
    if (this.o.peopleWaiting) return this.o.peopleWaiting()
    try { return !!this.ctx.db.query("SELECT 1 FROM turns WHERE status IN ('queued', 'running') AND chat_id <> ? LIMIT 1").get(READER_CHAT) } catch { return false }
  }

  private async execute(st: RunState, deadline: number | null): Promise<FileListStop> {
    const pick = this.pickReader()
    const runId = this.store.startRun(st.trigger, pick.ok ? pick.reader.engine : null, pick.ok ? pick.reader.model : null)
    let stop: FileListStop = 'done'
    try {
      // the sidecar against the disk (no reading), then the lists as they are
      const found = await this.reconcile(st.abort.signal)
      this.rewrite()
      this.removeStrays(found.lists)
      if (!pick.ok) { stop = 'failed'; return stop }
      stop = await this.readPending(pick.reader, st, deadline, runId)
      return stop
    } catch (e) {
      stop = st.abort.signal.aborted ? (this.closed ? 'stopped' : 'off') : 'failed'
      if (!st.abort.signal.aborted) throw e
      return stop
    } finally {
      st.stop = stop
      this.store.endRun(runId, stop)
      if (this.on()) this.rewrite()
      this.ctx.log.info('file list: run ended', { trigger: st.trigger, stoppedBy: stop, ...(this.store.lastRun() ? { read: this.store.lastRun()!.read } : {}) })
    }
  }

  /** The team folder's files: team path -> size and mtime (nothing is opened); `lists`: the `_FILES.md` found. */
  private async scan(signal: AbortSignal, lists: string[] = []): Promise<Map<string, { size: number; mtimeMs: number }>> {
    const root = this.ctx.files.fx.root
    const out = new Map<string, { size: number; mtimeMs: number }>()
    const q = this.ctx.files.fx.quarantine
    const stack: string[][] = []
    for (const e of safeReaddir(root)) {
      if (!e.isDirectory() || hiddenEntry(e.name, 0) || e.name.startsWith('.') || NOT_LISTED_TOP.has(e.name) || badSegment(e.name)) continue
      stack.push([e.name])
    }
    let n = 0
    while (stack.length) {
      signal.throwIfAborted()
      const dir = stack.pop()!
      for (const e of safeReaddir(path.join(root, ...dir))) {
        if (e.name.startsWith('.') || e.name.startsWith(PRODUCT.tmpPrefix) || badSegment(e.name) || e.isSymbolicLink()) continue
        const segs = [...dir, e.name]
        if (e.isDirectory()) { stack.push(segs); continue }
        if (!e.isFile()) continue
        if (isFileListName(e.name)) { lists.push(segs.join('/')); continue }
        const abs = path.join(root, ...segs)
        const s = lstatFile(abs)
        if (!s || q?.hasFile(abs)) continue
        out.set(segs.join('/'), { size: s.size, mtimeMs: s.mtimeMs })
      }
      if (++n % 200 === 0) await sleep(0)
    }
    return out
  }

  /**
   * The sidecar against the disk, without reading: unchanged files are kept (same size and mtime), touched ones too
   * (same hash), a file whose bytes belonged to a path that is gone takes that path's fields (moved or renamed), new and
   * changed files wait to be read, deleted files go.
   */
  async reconcile(signal: AbortSignal): Promise<{ kept: number; moved: number; pending: number; deleted: number; lists: string[] }> {
    const root = this.ctx.files.fx.root
    const lists: string[] = []
    const cur = await this.scan(signal, lists)
    const old = this.store.all()
    const gone = new Map<string, Entry[]>()
    for (const [p, e] of old) if (!cur.has(p) && e.sha && e.fields) { const l = gone.get(e.sha) ?? []; l.push(e); gone.set(e.sha, l) }
    let kept = 0, moved = 0, pending = 0, deleted = 0
    const taken = new Set<string>()
    for (const [rel, f] of [...cur].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      signal.throwIfAborted()
      const e = old.get(rel)
      if (e && e.size === f.size && e.mtimeMs === f.mtimeMs) { kept++; continue }
      const sha = await hashFile(path.join(root, ...segsOf(rel)))
      if (!sha) continue
      if (e && e.sha === sha) { this.store.put({ ...e, size: f.size, mtimeMs: f.mtimeMs }); kept++; continue }
      // moved or renamed: the same bytes at a path that is gone (the same name first)
      const name = rel.slice(rel.lastIndexOf('/') + 1)
      const cands = (gone.get(sha) ?? []).filter((g) => !taken.has(g.path))
      const src = cands.find((g) => g.path.slice(g.path.lastIndexOf('/') + 1) === name) ?? cands[0]
      if (src && !e) {
        taken.add(src.path)
        this.store.put({ ...src, path: rel, size: f.size, mtimeMs: f.mtimeMs, via: src.via === 'model' || src.via === 'copy' ? 'moved' : src.via })
        moved++
        continue
      }
      this.store.put({ path: rel, size: f.size, mtimeMs: f.mtimeMs, sha, kind: null, real: null, fields: null, via: null, readAt: null, tries: e?.tries ?? 0 })
      pending++
    }
    this.store.tx(() => { for (const p of old.keys()) if (!cur.has(p)) { this.store.delete(p); deleted++ } })
    return { kept, moved, pending, deleted: deleted - moved, lists }
  }

  /** Lists of the server found where it does not keep one now (a folder restored from the trash, a copy made outside
   * the server): removed. Only a file whose first line is the server's header is touched. */
  private removeStrays(found: Iterable<string>) {
    const known = this.store.lists()
    for (const rel of found) if (!known.has(rel)) removeList(this.ctx.files.fx.root, rel)
  }

  /** What waits to be read: never read, changed, or failed long enough ago. */
  private pending(units: Units): Entry[] {
    const retry = Date.now() - FAILED_RETRY_DAYS * 86_400_000
    return [...this.store.all().values()].filter((e) => units.listable(segsOf(e.path)) && (!e.fields || (e.via === 'failed' && Date.parse(e.readAt ?? '') < retry)))
  }

  private async readPending(reader: Reader, st: RunState, deadline: number | null, runId: number): Promise<FileListStop> {
    const signal = st.abort.signal
    const units = this.units()
    // one access unit after another (the same rule chain = the same people); in path order inside
    const byUnit = new Map<string, Entry[]>()
    for (const e of this.pending(units).sort((a, b) => (a.path < b.path ? -1 : 1))) {
      const k = units.chain(segsOf(units.listFolderOf(segsOf(e.path))))
      const l = byUnit.get(k) ?? []
      l.push(e)
      byUnit.set(k, l)
    }
    const env: PrepareEnv = { extract: { pandoc: this.ctx.engineConfig.pandoc, pdftotext: this.ctx.engineConfig.pdftotext, ocr: null, textLayerOnly: true, quarantine: this.ctx.files.quarantine },
      vision: this.ctx.files.visionTools(), images: reader.images && visionOn(this.ctx.db), signal }
    let stopBy: FileListStop | null = null
    const inflight = new Set<Promise<void>>()
    const why = (): FileListStop | null => {
      if (stopBy) return stopBy
      if (this.closed) return 'stopped'
      if (!this.on() || signal.aborted) return 'off'
      if (deadline !== null && this.now().getTime() >= deadline) return 'window'
      return null
    }
    const dispatch = async (batch: Prepared[]) => {
      while (inflight.size >= PARALLEL) await Promise.race(inflight)
      // never while a person's chat turn waits or runs (their AI limits and speed come first)
      while (!why() && this.peopleWaiting()) await sleep(this.o.pollMs ?? 5000)
      if (why()) return
      const p = this.callBatch(reader, batch, signal, runId, false).catch((e) => {
        if (e instanceof ReaderLimit) stopBy ??= 'limit'
        else if (e instanceof ReaderUnavailable) stopBy ??= 'failed'
        else if (!signal.aborted) this.ctx.log.warn('file list: batch failed', { err: e })
      }).finally(() => inflight.delete(p))
      inflight.add(p)
    }
    outer: for (const entries of byUnit.values()) {
      // identical files of the unit are read once
      const first = new Map<string, Entry>()
      const copies = new Map<string, Entry[]>()
      for (const e of entries) {
        if (e.sha && first.has(e.sha)) { const l = copies.get(e.sha) ?? []; l.push(e); copies.set(e.sha, l) }
        else if (e.sha) first.set(e.sha, e)
      }
      let images: Prepared[] = [], imageBytes = 0, texts: Prepared[] = [], textChars = 0
      for (const e of first.values()) {
        if (why()) break outer
        const item = await prepare(env, path.join(this.ctx.files.fx.root, ...segsOf(e.path)), e.path)
        const prep: Prepared = { item, entry: e, copies: copies.get(e.sha!) ?? [] }
        if (item.group === 'meta') { this.record(prep, item.meta!, 'meta'); this.writeFor([e.path, ...prep.copies.map((c) => c.path)]); continue }
        if (item.group === 'image') {
          const bytes = (item.images ?? []).reduce((a, im) => a + im.data.length, 0)
          if (images.length && (images.length >= IMAGE_BATCH || imageBytes + bytes > IMAGE_BATCH_BYTES)) { await dispatch(images); images = []; imageBytes = 0 }
          images.push(prep); imageBytes += bytes
        } else {
          const n = item.text?.length ?? 0
          if (texts.length && (texts.length >= TEXT_BATCH || textChars + n > TEXT_BATCH_CHARS)) { await dispatch(texts); texts = []; textChars = 0 }
          texts.push(prep); textChars += n
        }
      }
      if (images.length) await dispatch(images)
      if (texts.length) await dispatch(texts)
    }
    await Promise.all(inflight)
    return why() ?? (stopBy as FileListStop | null) ?? 'done'
  }

  /** One model call for files of one unit; each file's fields go only to that file (and its identical copies). */
  private async callBatch(reader: Reader, batch: Prepared[], signal: AbortSignal, runId: number, retried: boolean): Promise<void> {
    let text: string
    try {
      const ans = await reader.read(buildBlocks(batch.map((b) => b.item)), signal)
      this.store.addUsage(runId, { calls: 1, input: ans.usage.input, output: ans.usage.output, cost: ans.usage.costUsd })
      text = ans.text
    } catch (e) {
      if (e instanceof ReaderLimit || e instanceof ReaderUnavailable || signal.aborted) throw e
      if (!retried) { await sleep(this.o.retryMs ?? 10_000); return this.callBatch(reader, batch, signal, runId, true) }
      text = ''
    }
    const answers = parseAnswer(text, batch.length)
    const missing: Prepared[] = []
    const done: string[] = []
    batch.forEach((b, i) => {
      const f = cleanFields(answers.get(i + 1), b.entry.path, b.item.text ?? '')
      if (f) { this.record(b, f, 'model'); done.push(b.entry.path, ...b.copies.map((c) => c.path)) }
      else missing.push(b)
    })
    if (done.length) { this.store.addUsage(runId, { read: batch.length - missing.length }); this.writeFor(done) }
    // what the model left out: each once on its own, then an honest line that says so (tried again after some days)
    for (const b of missing) {
      if (batch.length > 1) { await this.callBatch(reader, [b], signal, runId, true); continue }
      this.record(b, unknownFields('reading failed'), 'failed')
      this.writeFor([b.entry.path, ...b.copies.map((c) => c.path)])
    }
  }

  /** Keep a file's fields (and its identical copies'), unless it changed or went meanwhile. */
  private record(b: Prepared, f: Fields, via: Via) {
    const now = new Date().toISOString()
    this.store.tx(() => {
      for (const [e, v] of [[b.entry, via], ...b.copies.map((c) => [c, via === 'model' ? 'copy' : via] as const)] as const) {
        const cur = this.store.get(e.path)
        if (!cur || cur.sha !== e.sha) continue
        this.store.put({ ...cur, kind: b.item.kind, real: b.item.real, fields: f, via: v as Via, readAt: now, tries: via === 'failed' ? cur.tries + 1 : 0 })
      }
    })
  }

  async close() {
    if (this.closed) return
    this.closed = true
    for (const t of this.timers) clearInterval(t)
    this.ctx.files.events.off('tree-changed', this.onTreeChanged)
    this.ctx.files.events.off('access-changed', this.onAccessChanged)
    this.run?.abort.abort()
    await Promise.race([this.whenIdle(), sleep(5000)])
    this.store.close()
  }
}

interface Prepared { item: Item; entry: Entry; copies: Entry[] }

function safeReaddir(dir: string): fs.Dirent[] { try { return fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] } }

/** The `_FILES.md` in a folder that just arrived, and below it (at most 5,000 entries looked at); nothing for a file. */
function findLists(root: string, rel: string, out: string[]) {
  let st: fs.Stats
  try { st = fs.lstatSync(path.join(root, ...segsOf(rel))) } catch { return }
  if (!st.isDirectory()) return
  const stack = [rel]
  let seen = 0
  while (stack.length && seen < 5000) {
    const d = stack.pop()!
    for (const e of safeReaddir(path.join(root, ...segsOf(d)))) {
      if (++seen > 5000) break
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue
      if (e.isDirectory()) stack.push(`${d}/${e.name}`)
      else if (e.isFile() && isFileListName(e.name)) out.push(`${d}/${e.name}`)
    }
  }
}

/** A regular single-link file's stat, or null (a link, a folder, a hard link, gone). */
function lstatFile(abs: string): fs.Stats | null {
  try { const s = fs.lstatSync(abs); return s.isFile() && s.nlink === 1 ? s : null } catch { return null }
}

/** sha256 of a file read without following a link; null when it cannot be read. */
async function hashFile(abs: string): Promise<string | null> {
  let fh: fs.promises.FileHandle | null = null
  try {
    fh = await fs.promises.open(abs, C.O_RDONLY | C.O_NOFOLLOW)
    const st = await fh.stat()
    if (!st.isFile() || st.nlink > 1) return null
    const h = new Bun.CryptoHasher('sha256')
    const buf = Buffer.alloc(1 << 20)
    for (;;) { const { bytesRead } = await fh.read(buf, 0, buf.length); if (!bytesRead) break; h.update(buf.subarray(0, bytesRead)) }
    return h.digest('hex')
  } catch { return null } finally { await fh?.close() }
}

const SINGLETON = new WeakMap<AppContext, FileList>()
/** The file list of this server (made on first use; the files module makes it at start). */
export function fileListOf(ctx: AppContext, o?: FileListOptions): FileList {
  let f = SINGLETON.get(ctx)
  if (!f) { f = new FileList(ctx, o); SINGLETON.set(ctx, f) }
  return f
}
/** The AI's instructions name the lists only while they run and exist (chat/prompt.ts FILE_LIST_RULE). */
export function fileListPromptOn(ctx: AppContext): boolean {
  try { return fileListOf(ctx).promptLine() } catch { return false }
}
