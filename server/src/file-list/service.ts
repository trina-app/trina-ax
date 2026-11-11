// The file list (docs/AGENTS/plan/20261111-0630-file-list.md): every night the team's AI reads new and changed team
// files and the server keeps one English line per file, saying what it really is, in its sidecar (store.ts). The AI's
// file tools show the lines as a `_FILES.md` in each access folder, rendered for the person asking when they ask
// (view.ts, files/virtual.ts), so a line shows only to someone who can open its file now. Nothing is written into the
// team folder: no team file is ever moved, renamed, changed or added.
//
// A run: list the team folder (no reading); compare size, mtime and hash with the sidecar (unchanged files cost a
// stat; a rename or move with the same bytes keeps its line; deleted files drop theirs); pick what to read within the
// run's cap (policy.ts: files and tokens; documents before images, newest first); then read, unit by unit, at most
// PARALLEL model calls at once, each call holding files of one access unit only (reader.ts, engine-reader.ts). No call
// starts while a person's chat turn waits or runs. A run stops at the night window's end (05:00 team time), at the cap,
// on the AI's usage or rate limit or the team's block budget, when the switch goes off or the server stops; the rest
// waits for the next run. A lease row keeps it to one run at a time, across restarts and processes.
//
// When: every night between 02:00 and 05:00 in the team's time zone, at least every 30 hours (the knowledge graph's
// nightlyDue, 5191d9e9); a new server waits for its first night. An admin can start a run now (capped the same way).
import crypto from 'node:crypto'
import fs from 'node:fs'
import { constants as C } from 'node:fs'
import path from 'node:path'
import { isFileListName, type FileListStatus, type FileListStop } from '@mycel/shared/api'
import { PRODUCT } from '@mycel/shared'
import type { AppContext } from '../context'
import { getSetting, setSetting, teamTimeZone } from '../admin/settings'
import { budgetBlock } from '../admin/budgets'
import { atLeast, RuleSet, type Principal } from '../policy/access'
import { visiblePath } from '../policy/authorize'
import { badSegment, hiddenEntry } from '../policy/names'
import { visionOn } from '../files/vision'
import type { VirtualFile, VirtualFiles } from '../files/virtual'
import { cleanFields, unknownFields, type Fields } from './format'
import { prepare, type Item, type PrepareEnv } from './prepare'
import { buildBlocks, parseAnswer, ReaderLimit, ReaderUnavailable, type Reader } from './reader'
import { ownerId, pickReader, READER_CHAT, type ReaderPick } from './engine-reader'
import { FORGET_ON_OFF, READ_PERSONAL, RUN_FILES, RUN_TOKENS } from './policy'
import { extOf } from './sniff'
import { Sidecar, type Entry, type Via } from './store'
import { NOT_LISTED_TOP, Units } from './units'
import { byListFolder, renderList } from './view'

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
/** a run's lease is taken over when its holder has not renewed it for this long (a process that died) */
export const LEASE_STALE_MS = 15 * 60_000

const segsOf = (p: string) => (p === '' ? [] : p.split('/'))
const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.() })
const under = (p: string, folder: string) => folder === '' || p === folder || p.startsWith(folder + '/')
/** image extensions: read after documents (a guess from the name, before the bytes are read) */
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'tif', 'tiff', 'bmp'])

export interface FileListOptions {
  /** the reader (tests: a fake); default: the team's engine (engine-reader.ts pickReader) */
  reader?: () => ReaderPick
  /** the nightly check; default on, off under NODE_ENV=test */
  loops?: boolean
  /** a person's chat turn waits or runs (default: the turns table, the reader's own turns left out) */
  peopleWaiting?: () => boolean
  /** how often a waiting run looks again (ms) */
  pollMs?: number
  /** the pause before a failed call is tried again (ms) */
  retryMs?: number
  now?: () => Date
}

interface RunState { abort: AbortController; trigger: 'nightly' | 'now'; done: Promise<FileListStop>; holder: string }

export class FileList implements VirtualFiles {
  readonly store: Sidecar
  private run: RunState | null = null
  private timers: ReturnType<typeof setInterval>[] = []
  private closed = false
  /** the sidecar's lines by list folder, for the store version and the rules they were grouped with */
  private grouped: { version: number; rules: string; units: Units; byFolder: Map<string, Entry[]> } | null = null

  constructor(private ctx: AppContext, private o: FileListOptions = {}) {
    const dir = path.join(ctx.engineConfig.dataDir, 'file-list')
    // the sidecar is never in the team folder (it names files and keeps what they are)
    const team = path.resolve(ctx.files.fx.root)
    if (path.resolve(dir).startsWith(team + path.sep)) throw new Error('file list: the data folder must be outside the team folder')
    this.store = new Sidecar(dir)
    this.store.closeOpenRuns()
    // a new server waits for its first night: the 30-hour rule counts from the first start
    if (!this.store.meta('firstSeenAt')) this.store.setMeta('firstSeenAt', this.now().toISOString())
    ctx.files.events.on('tree-changed', this.onTreeChanged)
    ctx.files.virtual = this
    if (this.o.loops ?? process.env.NODE_ENV !== 'test') {
      this.timers.push(setInterval(() => { if (this.nightlyDue()) void this.start('nightly') }, 30 * 60_000))
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

  setEnabled(on: boolean) {
    setSetting(this.ctx.db, ENABLED_SETTING, on)
    if (!on) {
      this.run?.abort.abort()
      // the stored lines go (policy.ts FORGET_ON_OFF); turned on again, the files are read again over the next nights
      if (FORGET_ON_OFF) this.store.clear()
    }
  }

  // ---------------------------------------------------------------- the virtual lists (files/virtual.ts)
  private rules(): RuleSet { return RuleSet.load(this.ctx.db) }
  private groups(rules: RuleSet) {
    const folders = rules.ruleFolders().sort()
    const sig = folders.join('\u0000')
    if (!this.grouped || this.grouped.version !== this.store.version || this.grouped.rules !== sig) {
      const units = new Units(folders)
      this.grouped = { version: this.store.version, rules: sig, units, byFolder: byListFolder(this.store.all().values(), units) }
    }
    return this.grouped
  }
  private seen(user: Principal, rules: RuleSet) {
    const fx = this.ctx.files.fx
    return { visible: (rel: string) => visiblePath(fx, rules, user, rel), canRead: (rel: string) => atLeast(rules.access(user, segsOf(rel)), 'read') }
  }

  under(user: Principal, rules: RuleSet, base: readonly string[]): Map<string, VirtualFile> {
    const out = new Map<string, VirtualFile>()
    if (!this.on()) return out
    const b = base.join('/')
    const seen = this.seen(user, rules)
    for (const [folder, entries] of this.groups(rules).byFolder) {
      if (!under(folder, b)) continue
      const v = renderList(folder, entries, seen)
      if (v) out.set(Units.listPath(folder), { text: v.text, mtimeMs: v.mtimeMs })
    }
    return out
  }

  at(user: Principal, rules: RuleSet, segs: readonly string[]): VirtualFile | null {
    if (!this.on() || !segs.length || !isFileListName(segs[segs.length - 1]!)) return null
    const folder = segs.slice(0, -1).join('/')
    const entries = this.groups(rules).byFolder.get(folder)
    const v = entries ? renderList(folder, entries, this.seen(user, rules)) : null
    return v ? { text: v.text, mtimeMs: v.mtimeMs } : null
  }

  /** The person has at least one list now (the AI is told about the lists only then: chat/prompt.ts). */
  hasListFor(user: Principal): boolean {
    if (!this.on()) return false
    const rules = this.rules()
    const seen = this.seen(user, rules)
    for (const [folder, entries] of this.groups(rules).byFolder) {
      if (!seen.canRead(Units.listPath(folder))) continue
      for (const e of entries) { const st = seen.visible(e.path); if (st && st.size === e.size && st.mtimeMs === e.mtimeMs) return true }
    }
    return false
  }

  /** Files moved, were renamed or deleted (trash included): a moved line follows its file (same size and mtime), a
   * deleted one goes from the sidecar at once (no reading). */
  private onTreeChanged = (e: { paths?: string[]; moves?: { from: string; to: string }[] } | undefined) => {
    if (!e) return
    try {
      const root = this.ctx.files.fx.root
      const listable = new Units([])
      for (const m of e.moves ?? []) {
        for (const ent of this.store.under(m.from)) {
          const to = m.to + ent.path.slice(m.from.length)
          const st = lstatFile(path.join(root, ...segsOf(to)))
          this.store.tx(() => {
            this.store.delete(ent.path)
            if (st && st.size === ent.size && st.mtimeMs === ent.mtimeMs && !this.store.get(to) && listable.listable(segsOf(to))) {
              this.store.put({ ...ent, path: to, via: ent.via === 'model' || ent.via === 'copy' ? 'moved' : ent.via })
            }
          })
        }
      }
      for (const p of e.paths ?? []) for (const ent of this.store.under(p)) if (!lstatFile(path.join(root, ...segsOf(ent.path)))) this.store.delete(ent.path)
    } catch (err) { this.ctx.log.error('file list: following a move failed', { err }) }
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
        if (!pick.ok) problem = pick.problem
        else if (last?.stoppedBy === 'limit' && c.waiting > 0) problem = 'limited'
      }
    }
    return {
      enabled: this.switchedOn(), forcedOff: this.forcedOff(), running: !!this.run, listed: c.listed, waiting: c.waiting,
      lastRun: last ? { startedAt: last.startedAt, endedAt: last.endedAt, trigger: last.trigger, read: last.read, stoppedBy: last.stoppedBy } : null,
      nextRunAt: this.on() ? this.nextRunAt().toISOString() : null, problem, signIn,
    }
  }

  private pickReader(): ReaderPick {
    try { return (this.o.reader ?? (() => pickReader(this.ctx)))() } catch (e) { this.ctx.log.warn('file list: no reader', { err: e }); return { ok: false, problem: 'no_ai' } }
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
  /** Start a run in the background; null when one is going (here or in another process) or the feature is off. */
  start(trigger: 'nightly' | 'now'): Promise<FileListStop> | null {
    if (!this.on() || this.run) return null
    const holder = `${process.pid}:${crypto.randomUUID()}`
    if (!this.store.takeLease(holder, LEASE_STALE_MS)) return null
    const abort = new AbortController()
    let deadline: number | null = null
    if (trigger === 'nightly') {
      const now = this.now()
      this.store.setMeta('lastNightlyAt', now.toISOString())
      const h = this.hour(now)
      deadline = h >= WINDOW_FROM && h < WINDOW_TO ? this.nextHour(now, WINDOW_TO).getTime() : now.getTime() + CATCH_UP_MS
    }
    const state: RunState = { abort, trigger, holder, done: Promise.resolve('done') }
    this.run = state
    state.done = this.execute(state, deadline)
      .catch((e) => { this.ctx.log.error('file list: run failed', { err: e }); return 'failed' as const })
      .finally(() => { this.store.dropLease(holder); if (this.run === state) this.run = null })
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
      // the sidecar against the disk (no reading)
      await this.reconcile(st.abort.signal)
      if (!pick.ok) { stop = 'failed'; return stop }
      stop = await this.readPending(pick.reader, st, deadline, runId)
      return stop
    } catch (e) {
      stop = st.abort.signal.aborted ? (this.closed ? 'stopped' : 'off') : 'failed'
      if (!st.abort.signal.aborted) throw e
      return stop
    } finally {
      this.store.endRun(runId, stop)
      // switched off during the run: what it stored meanwhile goes too
      if (!this.switchedOn() && FORGET_ON_OFF) this.store.clear()
      const last = this.store.lastRun()
      this.ctx.log.info('file list: run ended', { trigger: st.trigger, stoppedBy: stop, read: last?.read ?? 0, calls: last?.calls ?? 0, inputTokens: last?.inputTokens ?? 0, outputTokens: last?.outputTokens ?? 0, costUsd: last?.costUsd ?? 0 })
    }
  }

  /** The team folder's listable files: team path -> size and mtime (nothing is opened). */
  private async scan(signal: AbortSignal): Promise<Map<string, { size: number; mtimeMs: number }>> {
    const root = this.ctx.files.fx.root
    const out = new Map<string, { size: number; mtimeMs: number }>()
    const q = this.ctx.files.fx.quarantine
    const units = new Units([])
    const stack: string[][] = []
    for (const e of safeReaddir(root)) {
      if (!e.isDirectory() || hiddenEntry(e.name, 0) || e.name.startsWith('.') || NOT_LISTED_TOP.has(e.name) || badSegment(e.name)) continue
      if (e.name === 'users' && !READ_PERSONAL) continue
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
        if (!e.isFile() || !units.listable(segs)) continue
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
   * (same hash), a file whose bytes belonged to a path that is gone takes that path's fields (moved, renamed, back from
   * the trash), new and changed files wait to be read, deleted files go (and with them every row of a folder that is
   * no longer read, such as personal folders).
   */
  async reconcile(signal: AbortSignal): Promise<{ kept: number; moved: number; pending: number; deleted: number }> {
    const root = this.ctx.files.fx.root
    const cur = await this.scan(signal)
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
    return { kept, moved, pending, deleted: deleted - moved }
  }

  /** What waits to be read, in the order a run reads it: documents before images, newest first. */
  private pending(units: Units): Entry[] {
    const retry = Date.now() - FAILED_RETRY_DAYS * 86_400_000
    const isImage = (p: string) => IMAGE_EXT.has(extOf(p.slice(p.lastIndexOf('/') + 1)))
    return [...this.store.all().values()]
      .filter((e) => units.listable(segsOf(e.path)) && (!e.fields || (e.via === 'failed' && Date.parse(e.readAt ?? '') < retry)))
      .sort((a, b) => Number(isImage(a.path)) - Number(isImage(b.path)) || b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : 1))
  }

  private async readPending(reader: Reader, st: RunState, deadline: number | null, runId: number): Promise<FileListStop> {
    const signal = st.abort.signal
    const rules = this.rules()
    const units = new Units(rules.ruleFolders())
    const maxFiles = this.ctx.config.fileList?.maxFilesPerRun ?? RUN_FILES
    const maxTokens = this.ctx.config.fileList?.maxTokensPerRun ?? RUN_TOKENS
    // this run's share: the first maxFiles in reading order, then grouped by access unit (one unit per model call)
    const all = this.pending(units)
    const chosen = all.slice(0, maxFiles)
    const byUnit = new Map<string, Entry[]>()
    for (const e of chosen) {
      const k = units.chain(segsOf(units.listFolderOf(segsOf(e.path))))
      const l = byUnit.get(k) ?? []
      l.push(e)
      byUnit.set(k, l)
    }
    const env: PrepareEnv = {
      root: this.ctx.files.fx.root, office: this.ctx.files.office, ocr: this.ctx.engineConfig.ocr ?? null,
      extract: { pandoc: this.ctx.engineConfig.pandoc, pdftotext: this.ctx.engineConfig.pdftotext, ocr: null, textLayerOnly: true, quarantine: this.ctx.files.quarantine },
      vision: this.ctx.files.visionTools(), images: reader.images && visionOn(this.ctx.db), signal,
    }
    const owner = ownerId(this.ctx)
    let stopBy: FileListStop | null = null
    const inflight = new Set<Promise<void>>()
    const used = () => { const r = this.store.lastRun(); return (r?.inputTokens ?? 0) + (r?.outputTokens ?? 0) }
    const why = (): FileListStop | null => {
      if (stopBy) return stopBy
      if (this.closed) return 'stopped'
      if (!this.on() || signal.aborted) return 'off'
      if (deadline !== null && this.now().getTime() >= deadline) return 'window'
      if (used() >= maxTokens) return 'limit'
      // the team's "block" budget (Admin › Usage limits): the reader's turns are the owner's
      if (owner && budgetBlock(this.ctx.db, owner, 'en')) return 'limit'
      return null
    }
    const dispatch = async (batch: Prepared[]) => {
      while (inflight.size >= PARALLEL) await Promise.race(inflight)
      // never while a person's chat turn waits or runs (their AI limits and speed come first)
      while (!why() && this.peopleWaiting()) await sleep(this.o.pollMs ?? 5000)
      if (why()) return
      this.store.renewLease(st.holder)
      const p = this.callBatch(reader, batch, signal, runId, false).catch((e) => {
        if (e instanceof ReaderLimit) stopBy ??= 'limit'
        else if (e instanceof ReaderUnavailable) stopBy ??= 'failed'
        else if (!signal.aborted) this.ctx.log.warn('file list: call failed', { err: e })
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
        const item = await prepare(env, e.path)
        if (!item) continue // not readable safely now (gone, a link, changed while read): the next run looks again
        const prep: Prepared = { item, entry: e, copies: copies.get(e.sha!) ?? [] }
        if (item.group === 'meta') { this.record(prep, item.meta!, 'meta'); continue }
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
      if (texts.length) await dispatch(texts)
      if (images.length) await dispatch(images)
    }
    await Promise.all(inflight)
    const left = all.length - chosen.length
    return why() ?? stopBy ?? (left > 0 ? 'limit' : 'done')
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
    let read = 0
    batch.forEach((b, i) => {
      const f = cleanFields(answers.get(i + 1), b.entry.path, b.item.text ?? '')
      if (f) { this.record(b, f, 'model'); read++ }
      else missing.push(b)
    })
    if (read) this.store.addUsage(runId, { read })
    // what the model left out: each once on its own, then an honest line that says so (tried again after some days)
    for (const b of missing) {
      if (batch.length > 1) { await this.callBatch(reader, [b], signal, runId, true); continue }
      this.record(b, unknownFields('reading failed'), 'failed')
    }
  }

  /** Keep a file's fields with the size, mtime and hash of the bytes that were read, and its identical copies' (same
   * bytes), unless its row went meanwhile (the file was moved or deleted while it was read). */
  private record(b: Prepared, f: Fields, via: Via) {
    const now = new Date().toISOString()
    const { size, mtimeMs, sha } = b.item.read
    this.store.tx(() => {
      const cur = this.store.get(b.entry.path)
      if (cur) this.store.put({ ...cur, size, mtimeMs, sha, kind: b.item.kind, real: b.item.real, fields: f, via, readAt: now, tries: via === 'failed' ? cur.tries + 1 : 0 })
      for (const c of b.copies) {
        const cc = this.store.get(c.path)
        if (cc && cc.sha === sha) this.store.put({ ...cc, kind: b.item.kind, real: b.item.real, fields: f, via: via === 'model' ? 'copy' : via, readAt: now, tries: 0 })
      }
    })
  }

  async close() {
    if (this.closed) return
    this.closed = true
    for (const t of this.timers) clearInterval(t)
    this.ctx.files.events.off('tree-changed', this.onTreeChanged)
    if (this.ctx.files.virtual === this) this.ctx.files.virtual = null
    this.run?.abort.abort()
    await Promise.race([this.whenIdle(), sleep(5000)])
    this.store.close()
  }
}

interface Prepared { item: Item; entry: Entry; copies: Entry[] }

function safeReaddir(dir: string): fs.Dirent[] { try { return fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] } }

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
/** The AI's instructions name the lists only while the feature is on and this person has one (chat/prompt.ts). */
export function fileListPromptOn(ctx: AppContext, user: Principal): boolean {
  try { return fileListOf(ctx).hasListFor(user) } catch { return false }
}
