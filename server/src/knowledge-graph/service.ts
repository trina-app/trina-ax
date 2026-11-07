// The knowledge graph (docs/KNOWLEDGE-GRAPH.md): the team folders' documents and code, kept up to date when files
// change, asked by the AI's knowledge_explore tool. Two parts over one list of folders, one queue and one access check:
// - documents (on by default, nothing to install): each folder's documents as searchable passages with links between
//   them, in the document index (documents/, through docs-port.ts). The service lists the files and reads their bytes
//   itself; the index extracts their text with the server's converters (files/extract.ts, isolated, low priority).
// - code (on when CodeGraph is installed): a CodeGraph index of a copy of each folder's code (mirror.ts, runner.ts).
//
// Which folders: projects/<name>, groups/<name>, users/<id>, connected/<name>, shared/ and every other top-level folder
// (each its own), any other project folder, and the folders an admin added; a folder inside another one is part of it.
//
// Where: <data>/knowledge-graph/ in the server's data folder (documents/, roots/<id>/project/{tree,.codegraph},
// state.json), never in the team folder.
//
// When: a file change (team-files/changes.ts publishChanges, connected-folder syncs) marks its folder; the folder runs
// 30 s after its last change (at most 5 minutes after its first). One folder at a time, below people's work, with a
// pause after each run as long as the run (at most a minute); at most DOC_RUN_MAX documents per run (the folder comes
// back for the rest), so a first index goes gradually. Every night (02:00–05:00 team time, at least every 30 hours) and
// a minute after the start (10–15 minutes where the limits apply) every folder is checked; unchanged files cost a listing.
//
// Access: the indexes hold everything in their folders; what an answer shows is filtered at the question, file by file,
// by the same check as a read of the file (policy/authorize.ts), for the person asking, with the rules as they are then
// (explore). Anything else is left out without a trace.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { KnowledgeGraphDocuments, KnowledgeGraphRoot, KnowledgeGraphStatus, SourceLoc } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { getSetting, getTeamSettings, setSetting } from '../admin/settings'
import { authorize } from '../policy/authorize'
import type { Principal } from '../policy/access'
import { badSegment, hiddenEntry } from '../policy/names'
import { parseInput, walk } from '../policy/resolve'
import { readRegular } from '../files/store'
import { extractText, type Tools } from '../files/extract'
import { inBackground } from '../tools/isolate'
import { currentPlan, limitsActive } from '../system/limits'
import { storageRoom } from '../system/storage'
import { CONNECTED_ROOT } from '../team-files/connected'
import { findCodeGraph } from './codegraph'
import { listFiles, mirrorFolder, plainChain, readSeen } from './mirror'
import { CodeGraphRunner, type GraphRef, type GraphRunner, type GraphSymbol } from './runner'
import type { DocHit, DocIndexOptions, DocIndexPort, OpenDocIndex } from './docs-port'
import { cutText, DocumentIndex, matchStrength, questionTerms } from './documents'
import { queryTerms } from './documents/text'
import { DocSearchWorker, docSearchWorkerScript } from './documents/search-worker'
import { MeaningIndexer, startEmbedChild, type MeaningIndexerOptions } from './meaning/indexer'

export const ENABLED_SETTING = 'knowledgeGraph.enabled'
export const ADDED_SETTING = 'knowledgeGraph.added'
/** the documents part: on unless an admin turned it off (needs nothing installed) */
export const DOCS_SETTING = 'knowledgeGraph.documents'
/** the folders whose sub-folders are each one index */
const TOPS = ['projects', 'groups', 'users', CONNECTED_ROOT] as const
/** folder names the document listing does not go into: version control, dependencies, chat attachments */
const DOC_SKIP_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', '.attachments', '__pycache__', '.venv', 'venv', '.cache', '.next', '.nuxt'])

export interface KgOptions {
  /** the code indexer; null: none on this server (the code part is off). Default: CodeGraph if found. */
  runner?: GraphRunner | null
  /** opens the document index; null: none (the documents part is off) */
  openDocs?: OpenDocIndex | null
  debounceMs?: number
  maxWaitMs?: number
  /** the first check of every folder after the start; null: none (tests) */
  firstCheckMs?: number | null
  /** the pause after a run is the run's time, between these */
  pauseMinMs?: number
  pauseMaxMs?: number
  /** documents indexed per folder run (the folder comes back for the rest) */
  docRunMax?: number
  /** a document larger than this is not read (recorded as too big) */
  docReadMax?: number
  /** search by meaning's indexing (meaning/indexer.ts): stand-ins and limits; null: never index by meaning (tests'
   * default, so no test starts the model) */
  meaning?: Partial<Omit<MeaningIndexerOptions, 'store' | 'on' | 'log'>> | null
}

interface DocState {
  status: KnowledgeGraphRoot['status']
  documents: number
  failed: number
  lastSyncAt: string | null
  error: string | null
}
interface RootState {
  id: string
  /** the code part's state */
  status: KnowledgeGraphRoot['status']
  /** it holds code (false: checked and skipped, not shown) */
  hasCode: boolean
  /** a code index was made and can answer */
  indexed: boolean
  files: number
  symbols: number
  lastSyncAt: string | null
  error: string | null
  /** the copy changed and CodeGraph has not taken it in yet (a run failed or the server stopped in between) */
  needsBuild?: boolean
  /** the documents part's state */
  docs?: DocState
}
interface State { roots: Record<string, RootState>; lastFullAt: string | null }

export interface Candidate { path: string; segs: string[]; source: 'auto' | 'added' }

export interface ExploreHit {
  path: string
  kind: string
  name: string
  line: number
  endLine: number
  signature: string | null
  /** the symbol's first lines, numbered as in the file */
  snippet: string
  callers: GraphRef[]
  callees: GraphRef[]
}
export interface ExploreRelated { path: string; from: string; reason: { kind: string; detail: string } }
/** passages: the lookup's (LOOKUP_LONG long ones, then LOOKUP_SHORT short ones); strength: theirs */
export interface ExploreResult { hits: ExploreHit[]; passages: LookupPassage[]; strength: LookupResult['strength']; related: ExploreRelated[]; pending: number; indexed: number; files: Set<string> }

// ---- lookup: the one document search of the AI's tool, the lookup before the model starts and the Files search
// (docs/AGENTS/plan/20261107-0819-knowledge-graph-fast-answers.md, wave 1)
/** passages to answer from, and their size in characters */
export const LOOKUP_LONG = 3
export const LOOKUP_LONG_CHARS = 1500
/** short labelled hits after them (file, place and a short part of the text) */
export const LOOKUP_SHORT = 12
export const LOOKUP_SHORT_CHARS = 300
/** how long knowledge_explore waits for related documents, all of them together */
const RELATED_MS = 1500
/** One passage of a lookup. `long`: up to LOOKUP_LONG_CHARS of its piece, to answer from; otherwise a short label
 * (up to LOOKUP_SHORT_CHARS). */
export interface LookupPassage { path: string; loc: SourceLoc | null; text: string; score: number; long: boolean }
export interface LookupResult {
  /** best first; at most one entry per (path, loc) */
  passages: LookupPassage[]
  /** how well the best passages match the question: strong (enough to answer from), weak (worth naming the files),
   * none (nothing found) */
  strength: 'strong' | 'weak' | 'none'
  /** every file named, for the read scope and the sources */
  files: Set<string>
}
export interface LookupOptions {
  /** only under this team path (actual names, already authorized by the caller) */
  base?: string
  /** how many long passages and short hits (defaults LOOKUP_LONG, LOOKUP_SHORT) */
  long?: number
  short?: number
  /** answer within this long with what is ready by then: a search not back in time is left out (nothing, when it is
   * the only one), and the server is never held while it runs (documents/search-worker.ts) */
  deadlineMs?: number
  /** which words of a query are searched: 'message' (default), a chat message's words without greetings, requests,
   * question words and fillers (questionTerms); 'search', every word typed into a search box (queryTerms) */
  words?: 'message' | 'search'
  /** false: leave out what only meaning found (the lookup before the model). With meaning on, an ordinary message's one
   * distinctive word gets a few loosely related files by meaning (e5 scores unrelated text nearly as close as related
   * text, so no threshold separates them); naming them in front of every message would cost tokens for nothing. The
   * AI's own knowledge_explore and the Files search keep them (default true): a Korean report for an English question. */
  meaningOnly?: boolean
}

const nowIso = () => new Date().toISOString()
const rootId = (p: string) => createHash('sha256').update(p.normalize('NFC')).digest('hex').slice(0, 24)
const under = (p: string, root: string) => p === root || p.startsWith(root + '/')
const isPersonal = (p: string) => p.startsWith('users/')
const plainRel = (rel: string) => !!rel && !rel.split('/').some((s) => s === '' || s === '.' || s === '..')
const CALLABLE = new Set(['function', 'method', 'class', 'component', 'interface', 'struct', 'trait', 'route'])
const NOT_SHOWN = new Set(['file', 'import', 'export', 'parameter'])
/** how many symbols of one name are looked at before the connections of a match are shown (F2) */
const SAME_NAME_MAX = 50
const squash = (x: string) => x.replace(/\s+/g, '')
const newDocState = (): DocState => ({ status: 'pending', documents: 0, failed: 0, lastSyncAt: null, error: null })

/** tests: options (stand-ins, null for none; short quiet times) for the apps made after this call; undefined: back to
 * the defaults */
let testOptions: KgOptions | undefined
export function setKnowledgeGraphForTests(o: KgOptions | undefined) { testOptions = o }
/** The document index (knowledge-graph/documents/) behind the port: its writes on this thread's connection, its reads
 * (search, related) in the search worker (documents/search-worker.ts), so a search never holds the server. Without the
 * worker's script (a bundle built without it), or for a while after the worker failed several times in a row
 * (DocSearchWorker.usable), the reads run here: bounded, a few hundred pieces per word. */
export function openDocumentIndex(dir: string, o: DocIndexOptions): DocIndexPort {
  const idx = DocumentIndex.open(dir, o)
  const script = docSearchWorkerScript()
  if (!script) o.warn?.('knowledge graph: the document search worker is missing; searches run on the main thread')
  const reader = script ? new DocSearchWorker(dir, script, (err) => o.warn?.('knowledge graph: ' + err), { meaning: o.meaning }) : null
  reader?.warm()
  const people = () => { try { return o.people() } catch { return [] } }
  return {
    accepts: (name) => DocumentIndex.accepts(name),
    files: (r) => idx.files(r),
    update: (r, rel, f, x) => idx.update(r, rel, f, { ...x, background: true }),
    remove: (r, rel) => idx.remove(r, rel),
    dropRoot: (r) => idx.dropRoot(r),
    search: (q, x) => reader?.usable ? reader.search(q, x) : idx.search(q, x),
    related: (r, rel, x) => reader?.usable ? reader.related(r, rel, x, people()) : idx.related(r, rel, x),
    stats: (r) => idx.stats(r),
    diskBytes: () => idx.diskBytes(),
    // search by meaning: the vectors are written on this thread's connection, like every other write
    pendingVectors: (n) => idx.pendingVectors(n),
    writeVectors: (rows) => idx.writeVectors(rows),
    vectorCounts: () => idx.vectorCounts(),
    close: () => { reader?.close(); idx.close() },
    destroy: () => { reader?.close(); idx.destroy() },
  }
}
/** the document index the server opens */
let defaultOpenDocs: OpenDocIndex | null = openDocumentIndex
export function setDefaultDocumentIndex(open: OpenDocIndex | null) { defaultOpenDocs = open }

export class KnowledgeGraph {
  readonly dir: string
  readonly runner: GraphRunner | null
  private openDocs: OpenDocIndex | null
  private docs: DocIndexPort | null = null
  private o: Required<Omit<KgOptions, 'runner' | 'openDocs' | 'firstCheckMs' | 'meaning'>> & { firstCheckMs: number | null }
  private meaningOpts: KgOptions['meaning']
  private meaning: MeaningIndexer | null = null
  private state: State
  private timers = new Map<string, { t: ReturnType<typeof setTimeout>; first: number }>()
  private queue: string[] = []
  private running: string | null = null
  private abort: AbortController | null = null
  /** bumped when a part goes off or a rebuild of everything starts: a run of an older generation drops its result */
  private gen = 0
  private loops: { first?: ReturnType<typeof setTimeout>; every?: ReturnType<typeof setInterval> } = {}
  private closed = false
  private idle: (() => void)[] = []
  private candCache: { at: number; list: Candidate[] } | null = null
  private diskCache: { at: number; bytes: number } | null = null

  constructor(private ctx: AppContext, opts: KgOptions = {}) {
    this.dir = path.join(ctx.engineConfig.dataDir, 'knowledge-graph')
    // the indexes must not be in the team folder: the data folder never is (config), checked again here
    const team = ctx.files.fx.root
    if (under(path.resolve(this.dir), team) || under(team, path.resolve(this.dir))) throw new Error('knowledge graph: the data folder must be outside the team folder')
    this.runner = opts.runner !== undefined ? opts.runner : (() => { const t = findCodeGraph(ctx.config.knowledgeGraph?.codegraph); return t ? new CodeGraphRunner(t) : null })()
    this.openDocs = opts.openDocs !== undefined ? opts.openDocs : defaultOpenDocs
    this.o = {
      debounceMs: opts.debounceMs ?? 30_000, maxWaitMs: opts.maxWaitMs ?? 5 * 60_000,
      firstCheckMs: opts.firstCheckMs !== undefined ? opts.firstCheckMs : limitsActive() ? 10 * 60_000 + (parseInt(rootId(ctx.engineConfig.dataDir).slice(0, 4), 16) % 300) * 1000 : 60_000,
      pauseMinMs: opts.pauseMinMs ?? 2_000, pauseMaxMs: opts.pauseMaxMs ?? 60_000,
      docRunMax: opts.docRunMax ?? 200, docReadMax: opts.docReadMax ?? 100 * 1024 * 1024,
    }
    this.meaningOpts = opts.meaning
    this.state = this.load()
    // a run that was going when the server stopped starts again
    for (const s of Object.values(this.state.roots)) {
      if (s.status === 'indexing') s.status = s.indexed ? 'ready' : 'pending'
      if (s.docs?.status === 'indexing') s.docs.status = 'pending'
    }
    ctx.files.events.on('tree-changed', this.onChanged)
    if (this.o.firstCheckMs !== null) {
      const first = setTimeout(() => this.checkAll(), this.o.firstCheckMs)
      // the nightly check: looked at every half hour
      const every = setInterval(() => { if (this.nightlyDue()) this.checkAll() }, 30 * 60_000)
      first.unref?.(); every.unref?.()
      this.loops = { first, every }
    }
    ctx.onClose(() => this.close())
  }

  // ---------------------------------------------------------------- settings
  /** CodeGraph is here */
  available() { return !!this.runner }
  /** the code part: an admin's choice; not chosen: on when CodeGraph is here */
  enabled() { return this.available() && (getSetting<boolean>(this.ctx.db, ENABLED_SETTING) ?? true) }
  /** the documents part as an admin set it (on unless turned off) */
  docsEnabled() { return getSetting<boolean>(this.ctx.db, DOCS_SETTING) ?? true }
  /** the documents part runs: on, and this server has the document index */
  docsOn() { return !!this.openDocs && this.docsEnabled() }
  /** anything to index */
  anyOn() { return this.enabled() || this.docsOn() }
  /**
   * Search by meaning (wave 2): `knowledgeGraph.meaning: true` in server.json, and the documents part runs. Off unless
   * set; off means no indexing and no meaning in the search (the combined search asks this). Nothing about it is in the
   * admin screens.
   */
  meaningOn() { return this.ctx.config.knowledgeGraph?.meaning === true && this.docsOn() }

  /** the background indexing of search by meaning, made when first needed while it is on */
  private meaningIndexer(): MeaningIndexer | null {
    if (this.closed || this.meaningOpts === null || !this.meaningOn()) return null
    if (this.meaning) return this.meaning
    const dataDir = this.ctx.engineConfig.dataDir
    const models = process.env.MYCEL_MODELS_DIR
    this.meaning = new MeaningIndexer({
      store: () => this.docsOn() ? this.docIndex() : null,
      on: () => !this.closed && this.meaningOn(),
      peopleWaiting: () => this.peopleWaiting(),
      log: this.ctx.log,
      // the same model folders as the old search by meaning: <data>/models, or a host's read-only shared copy
      startChild: () => startEmbedChild({ modelDir: path.join(dataDir, 'models'), sharedDir: models ? path.join(models, 'semantic') : null, threads: 1 }),
      ...this.meaningOpts,
    })
    return this.meaning
  }

  /**
   * Someone is waiting for an answer: a chat turn runs or waits in the queue (the turns table, which the chat runtime
   * keeps: queued, then running until it ends; a server start sets the ones a stop left running to their end). One
   * query on its status index; the background indexing of search by meaning pauses meanwhile.
   */
  private peopleWaiting(): boolean {
    try { return !!this.ctx.db.query("SELECT 1 FROM turns WHERE status IN ('queued', 'running') LIMIT 1").get() } catch { return false }
  }
  added(): string[] {
    const v = getSetting<unknown>(this.ctx.db, ADDED_SETTING)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  }

  setEnabled(on: boolean) {
    const was = this.enabled()
    setSetting(this.ctx.db, ENABLED_SETTING, on)
    if (was && !on) this.clearCode()
    if (!was && on) this.checkAll()
  }

  setDocsEnabled(on: boolean) {
    const was = this.docsOn()
    setSetting(this.ctx.db, DOCS_SETTING, on)
    if (was && !this.docsOn()) this.clearDocs()
    if (!was && this.docsOn()) this.checkAll()
  }

  /** A folder an admin may add: an existing plain folder outside users/ and .system/, as its actual names. */
  checkAdded(input: string): string {
    const segs = parseInput(input)
    if (!segs.length) throw new KgError('root')
    if (segs[0] === 'users') throw new KgError('personal')
    const w = walk(this.ctx.files.fx.root, segs, this.ctx.files.fx.caseInsensitive)
    if (w.problem || w.missing.length || !w.st.isDirectory() || !plainChain(this.ctx.files.fx.root, w.actual)) throw new KgError('not_found')
    return w.actual.join('/')
  }

  setAdded(paths: string[]) {
    const list = [...new Set(paths.map((p) => this.checkAdded(p)))]
    setSetting(this.ctx.db, ADDED_SETTING, list)
    this.candCache = null
    if (this.anyOn()) this.checkAll()
    return list
  }

  // ---------------------------------------------------------------- folders
  /** The folders to index now, outermost first (one inside another is part of it). */
  candidates(): Candidate[] {
    if (this.candCache && Date.now() - this.candCache.at < 10_000) return this.candCache.list
    const root = this.ctx.files.fx.root
    const found: Candidate[] = []
    const add = (p: string, source: Candidate['source']) => {
      const segs = p.split('/')
      if (segs.some((s, i) => hiddenEntry(s, i) || badSegment(s) !== null)) return
      if (plainChain(root, segs)) found.push({ path: p, segs, source })
    }
    for (const top of TOPS) {
      let names: string[] = []
      try { names = fs.readdirSync(path.join(root, top)) } catch {}
      for (const n of names.sort()) add(`${top}/${n}`, 'auto')
    }
    // every other top-level folder is one (shared/, skills/, a folder with its own rules); files at the very top are not
    let tops: string[] = []
    try { tops = fs.readdirSync(root) } catch {}
    for (const n of tops.sort()) if (!(TOPS as readonly string[]).includes(n) && n !== 'users') add(n, 'auto')
    try {
      for (const r of this.ctx.db.query('SELECT folder_path FROM projects WHERE trashed_with IS NULL').all() as { folder_path: string }[])
        if (r.folder_path && r.folder_path !== '' && !r.folder_path.startsWith('.')) add(r.folder_path, 'auto')
    } catch { /* no projects table in an old database */ }
    for (const p of this.added()) add(p, 'added')
    found.sort((a, b) => a.segs.length - b.segs.length || (a.path < b.path ? -1 : 1))
    const list: Candidate[] = []
    for (const c of found) if (!list.some((k) => under(c.path, k.path))) list.push(c)
    // an added folder that an automatic one covers is still "added" in the list
    const added = new Set(this.added())
    for (const c of list) if (added.has(c.path)) c.source = 'added'
    this.candCache = { at: Date.now(), list }
    return list
  }

  private rootDir(p: string) { return path.join(this.dir, 'roots', rootId(p)) }
  private project(p: string) { return path.join(this.rootDir(p), 'project') }

  /** the document index, opened when first needed */
  private docIndex(): DocIndexPort | null {
    if (!this.docsOn()) return null
    if (this.docs) return this.docs
    const cfg = this.ctx.engineConfig
    // a part a converter was stopped on fails the whole text, so the file is tried again later (files/extract.ts)
    const tools: Tools = { pandoc: cfg.pandoc, pdftotext: cfg.pdftotext, ocr: cfg.ocr, quarantine: this.ctx.files.quarantine, stoppedPartFails: true }
    this.docs = this.openDocs!(path.join(this.dir, 'documents'), {
      // the converters the AI's reads use, isolated (tools/isolate.ts), below people's work
      extract: (name, bytes, signal) => inBackground(() => true, () => extractText(name, bytes, tools, signal)),
      people: () => (this.ctx.db.query("SELECT name FROM users WHERE status = 'active'").all() as { name: string }[]).map((r) => r.name).filter((n) => n && n.length >= 2),
      warn: (msg, x) => this.ctx.log.warn(msg, x),
      meaning: () => this.meaningSearch(),
    })
    return this.docs
  }

  /** Searches use meaning too while the switch is on (knowledgeGraph.meaning in server.json, meaningOn). */
  private meaningSearch(): boolean { return this.meaningOn() }

  // ---------------------------------------------------------------- changes and the queue
  private onChanged = (e: { paths?: unknown }) => {
    try { if (Array.isArray(e?.paths)) this.noteChanges(e.paths.filter((x): x is string => typeof x === 'string')) } catch (err) { this.ctx.log.warn('knowledge graph: change not taken', { err: String(err) }) }
  }

  /** Team paths that changed: their folders run after the quiet time. */
  noteChanges(paths: string[]) {
    if (this.closed || !this.anyOn() || !paths.length) return
    // a new or moved folder may change the list: one look again when a path is in none of the folders known
    let roots = this.candidates()
    if (paths.some((p) => p.split('/').length <= 2 || !roots.some((r) => under(p, r.path)))) { this.candCache = null; roots = this.candidates() }
    const hit = new Set<string>()
    for (const p of paths) {
      for (const r of roots) if (under(p, r.path) || under(r.path, p)) hit.add(r.path)
      // a folder that went away (moved, deleted): its index goes at its run
      for (const known of Object.keys(this.state.roots)) if (under(p, known) || under(known, p)) hit.add(known)
    }
    for (const r of hit) this.schedule(r)
  }

  private schedule(p: string) {
    const now = Date.now()
    const t = this.timers.get(p)
    if (t) clearTimeout(t.t)
    const first = t?.first ?? now
    const wait = Math.max(0, Math.min(this.o.debounceMs, first + this.o.maxWaitMs - now))
    const timer = setTimeout(() => { this.timers.delete(p); this.enqueue(p) }, wait)
    timer.unref?.()
    this.timers.set(p, { t: timer, first })
  }

  private enqueue(p: string) {
    if (this.closed || !this.anyOn()) return
    // changed while it runs: once more after
    if (!this.queue.includes(p)) this.queue.push(p)
    const s = this.state.roots[p]
    if (s && s.status !== 'indexing' && !s.indexed) s.status = 'pending'
    if (s?.docs && s.docs.status !== 'indexing') s.docs.status = 'pending'
    void this.work()
  }

  /** Every folder: new ones are indexed, changed ones updated, gone ones removed. */
  checkAll() {
    if (this.closed || !this.anyOn()) return
    this.candCache = null
    const list = this.candidates().map((c) => c.path)
    for (const known of Object.keys(this.state.roots)) if (!list.includes(known)) this.dropRoot(known)
    for (const p of list) this.enqueue(p)
    this.state.lastFullAt = nowIso()
    this.save()
    // search by meaning: pieces still without a vector, and the try again after a refusal (memory, the model)
    this.meaningIndexer()?.kick({ retry: true })
  }

  private nightlyDue(): boolean {
    const last = this.state.lastFullAt ? Date.parse(this.state.lastFullAt) : 0
    const since = Date.now() - last
    if (since > 30 * 3600_000) return true
    if (since < 12 * 3600_000) return false
    try {
      const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: getTeamSettings(this.ctx.db).timeZone, hour: 'numeric', hourCycle: 'h23' }).format(new Date()))
      return h >= 2 && h < 5
    } catch { return false }
  }

  private async work() {
    if (this.running !== null || this.closed) return
    while (this.queue.length && !this.closed && this.anyOn()) {
      const p = this.queue.shift()!
      this.running = p
      const t0 = Date.now()
      try { await this.runRoot(p) } catch (e) {
        const s = this.state.roots[p]
        if (s) { s.status = 'error'; s.error = String((e as Error)?.message ?? e).slice(0, 200); if (s.docs) s.docs.status = 'error' }
        this.ctx.log.warn('knowledge graph: run failed', { root: rootId(p), err: String(e) })
      }
      this.running = null
      this.abort = null
      this.save()
      if (this.queue.length && !this.closed) await new Promise((r) => { const t = setTimeout(r, Math.min(this.o.pauseMaxMs, Math.max(this.o.pauseMinMs, Date.now() - t0))); t.unref?.() })
    }
    if (!this.queue.length && this.running === null && !this.timers.size) for (const f of this.idle.splice(0)) f()
  }

  /** tests: resolves when nothing is waiting, queued or running */
  whenIdle(): Promise<void> {
    if (!this.queue.length && this.running === null && !this.timers.size) return Promise.resolve()
    return new Promise((r) => this.idle.push(r))
  }

  private async runRoot(p: string) {
    const gen = this.gen
    const cand = this.candidates().find((c) => c.path === p)
    if (!cand || !plainChain(this.ctx.files.fx.root, cand.segs)) { this.dropRoot(p); return }
    const s: RootState = this.state.roots[p] ??= { id: rootId(p), status: 'pending', hasCode: true, indexed: false, files: 0, symbols: 0, lastSyncAt: null, error: null }
    this.abort = new AbortController()
    if (this.docsOn()) await this.runDocs(p, cand, s, gen)
    if (gen !== this.gen || this.closed || !this.state.roots[p]) return
    if (this.enabled()) await this.runCode(p, cand, s, gen)
  }

  // ---------------------------------------------------------------- documents
  private async runDocs(p: string, cand: Candidate, s: RootState, gen: number) {
    const idx = this.docIndex()
    if (!idx) return
    const d = s.docs ??= newDocState()
    d.status = 'indexing'
    const stale = () => gen !== this.gen || this.closed || !this.docsOn()
    const listed = await listFiles({
      teamRoot: this.ctx.files.fx.root, segs: cand.segs, skipDirs: DOC_SKIP_DIRS, keep: (name) => { try { return idx.accepts(name) } catch { return false } },
      quarantined: (abs) => this.ctx.files.quarantine.hasFile(abs), maxEntries: 200_000, maxFiles: 50_000,
    })
    if (stale()) return
    if (!listed) {
      idx.dropRoot(p)
      Object.assign(d, { status: 'too_big', documents: 0, failed: 0, lastSyncAt: nowIso(), error: null })
      return
    }
    const have = idx.files(p)
    const base = path.join(this.ctx.files.fx.root, ...cand.segs)
    let done = 0, more = false
    for (const [rel, seen] of listed) {
      const h = have.get(rel)
      if (h && h.size === seen.size && h.mtimeMs === seen.mtimeMs) continue
      if (done >= this.o.docRunMax) { more = true; break }
      done++
      // the very file the listing saw, never through a link; one too large is recorded without being read
      const big = seen.size > this.o.docReadMax
      const bytes = big ? null : readSeen(path.join(base, ...rel.split('/')), seen)
      if (!big && !bytes) continue // changed meanwhile: the next run
      if (bytes && currentPlan() && storageRoom(bytes.length)?.ok === false) { more = true; break }
      try { await idx.update(p, rel, { bytes, size: seen.size, mtimeMs: seen.mtimeMs }, { signal: this.abort?.signal }) } catch (e) {
        this.ctx.log.warn('knowledge graph: document not indexed', { root: s.id, err: String(e).slice(0, 200) })
      }
      if (stale()) return
    }
    for (const rel of have.keys()) if (!listed.has(rel)) idx.remove(p, rel)
    const st = idx.stats(p)
    Object.assign(d, { status: 'ready', documents: st.documents, failed: st.failed.length, lastSyncAt: nowIso(), error: null })
    this.diskCache = null
    if (done) this.ctx.log.info('knowledge graph: documents indexed', { root: s.id, files: done, documents: st.documents, failed: st.failed.length, more })
    // new pieces have no vector yet (a document indexed again: its pieces are new, so their vectors are made again)
    if (done) this.meaningIndexer()?.kick()
    // the rest of a large folder in the next run (after the pause), not all at once
    if (more && !this.queue.includes(p)) this.queue.push(p)
  }

  // ---------------------------------------------------------------- code
  private async runCode(p: string, cand: Candidate, s: RootState, gen: number) {
    s.status = 'indexing'
    const project = this.project(p)
    fs.mkdirSync(project, { recursive: true, mode: 0o700 })
    // a run that the code part going off (or a rebuild of everything) overtook leaves nothing behind
    const stale = () => {
      if (gen === this.gen && !this.closed) return false
      if (!this.enabled()) fs.rmSync(this.rootDir(p), { recursive: true, force: true })
      return true
    }
    const m = await mirrorFolder({
      teamRoot: this.ctx.files.fx.root, segs: cand.segs, tree: path.join(project, 'tree'),
      quarantined: (abs) => this.ctx.files.quarantine.hasFile(abs),
      room: (b) => !(currentPlan() && storageRoom(b)?.ok === false),
    })
    if (stale()) return
    if (m.missing) { this.dropRoot(p); return }
    if (m.tooBig || !m.hasCode) {
      fs.rmSync(this.rootDir(p), { recursive: true, force: true })
      Object.assign(s, { status: m.tooBig ? 'too_big' : 'ready', hasCode: m.tooBig, indexed: false, files: 0, symbols: 0, lastSyncAt: nowIso(), error: null })
      this.diskCache = null
      return
    }
    s.hasCode = true
    const changed = m.copied + m.removed > 0
    if (s.indexed && !changed && !s.needsBuild && fs.existsSync(path.join(project, '.codegraph'))) { s.status = 'ready'; s.lastSyncAt = nowIso(); return }
    // kept before CodeGraph runs: a failed run or a stop in between makes the next check run it, unchanged copy or not
    s.needsBuild = true
    this.save()
    const full = !s.indexed || !fs.existsSync(path.join(project, '.codegraph', 'codegraph.db'))
    // a full index starts from an empty index folder (a run stopped half-way may have left one)
    if (full) { fs.rmSync(path.join(project, '.codegraph'), { recursive: true, force: true }); s.indexed = false }
    const r = await this.runner!.build(project, full, this.abort?.signal)
    if (stale()) return
    if (!r.ok) {
      // an update that failed keeps the last good index answering; a failed first index has none
      s.status = 'error'; s.error = r.error ?? 'failed'
      this.ctx.log.warn('knowledge graph: index failed', { root: s.id, err: s.error })
      return
    }
    const st = await this.runner!.stats(project)
    if (stale()) return
    Object.assign(s, { status: st ? 'ready' : 'error', indexed: !!st, needsBuild: !st, files: st?.files ?? 0, symbols: st?.symbols ?? 0, lastSyncAt: nowIso(), error: st ? null : 'no index' })
    this.diskCache = null
    this.ctx.log.info('knowledge graph: indexed', { root: s.id, files: s.files, symbols: s.symbols, full, partial: m.partial })
  }

  private dropRoot(p: string) {
    fs.rmSync(this.rootDir(p), { recursive: true, force: true })
    try { this.docs?.dropRoot(p) } catch (e) { this.ctx.log.warn('knowledge graph: documents not dropped', { err: String(e) }) }
    delete this.state.roots[p]
    this.diskCache = null
  }

  /** Make the index of one folder (or all) again from the files: the code, the documents or both. */
  rebuild(p?: string, part?: 'code' | 'documents') {
    const code = this.enabled() && part !== 'documents', docs = this.docsOn() && part !== 'code'
    if (!code && !docs) return
    const targets = p ? [p] : Object.keys(this.state.roots)
    if (!p) { this.gen++; this.abort?.abort(); this.queue = [] }
    for (const t of targets) {
      const s = this.state.roots[t]
      if (code) {
        fs.rmSync(this.rootDir(t), { recursive: true, force: true })
        if (s) Object.assign(s, { status: 'pending', indexed: false, files: 0, symbols: 0, error: null, needsBuild: false })
      }
      if (docs) {
        try { this.docIndex()?.dropRoot(t) } catch {}
        if (s) s.docs = newDocState()
      }
    }
    this.diskCache = null
    this.save()
    if (p) this.enqueue(p)
    else this.checkAll()
  }

  /** The code part off: its indexes (with their copies of the code) are deleted; the documents go on. */
  private clearCode() {
    this.stopRuns()
    fs.rmSync(path.join(this.dir, 'roots'), { recursive: true, force: true })
    for (const [p, s] of Object.entries(this.state.roots)) {
      if (!s.docs) { delete this.state.roots[p]; continue }
      Object.assign(s, { status: 'pending', hasCode: true, indexed: false, files: 0, symbols: 0, lastSyncAt: null, error: null, needsBuild: false })
    }
    this.afterClear()
  }

  /** The documents part off: the document index is deleted; the code goes on. */
  private clearDocs() {
    this.stopRuns()
    this.meaning?.close()
    this.meaning = null
    try { this.docs?.destroy() } catch (e) { this.ctx.log.warn('knowledge graph: document index not deleted', { err: String(e) }) }
    this.docs = null
    // the index's folder goes even when the index could not be opened
    fs.rmSync(path.join(this.dir, 'documents'), { recursive: true, force: true })
    for (const s of Object.values(this.state.roots)) delete s.docs
    if (!this.enabled()) this.state = { roots: {}, lastFullAt: null }
    this.afterClear()
  }

  private stopRuns() {
    this.gen++
    this.abort?.abort()
    this.queue = []
    for (const t of this.timers.values()) clearTimeout(t.t)
    this.timers.clear()
  }
  private afterClear() {
    this.diskCache = null
    this.save()
    for (const f of this.idle.splice(0)) f()
    // the other part, still on, goes on with every folder
    if (this.anyOn()) this.checkAll()
  }

  // ---------------------------------------------------------------- state
  private load(): State {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(this.dir, 'state.json'), 'utf8'))
      if (j && typeof j === 'object' && j.roots && typeof j.roots === 'object') return { roots: j.roots, lastFullAt: typeof j.lastFullAt === 'string' ? j.lastFullAt : null }
    } catch {}
    return { roots: {}, lastFullAt: null }
  }
  private save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      const tmp = path.join(this.dir, `state.json.${process.pid}.tmp`)
      fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 })
      fs.renameSync(tmp, path.join(this.dir, 'state.json'))
    } catch (e) { this.ctx.log.warn('knowledge graph: state not saved', { err: String(e) }) }
  }

  private diskBytes(): number {
    if (this.diskCache && Date.now() - this.diskCache.at < 15_000) return this.diskCache.bytes
    let bytes = 0
    const stack = [path.join(this.dir, 'roots')]
    while (stack.length) {
      const d = stack.pop()!
      let names: string[] = []
      try { names = fs.readdirSync(d) } catch { continue }
      for (const n of names) {
        try { const st = fs.lstatSync(path.join(d, n)); if (st.isDirectory()) stack.push(path.join(d, n)); else bytes += st.size } catch {}
      }
    }
    this.diskCache = { at: Date.now(), bytes }
    return bytes
  }

  private busy() { return this.queue.length + (this.running ? 1 : 0) + this.timers.size }

  /** The documents part of the status. Personal folders only as totals; failed files outside them by path. */
  docStatus(): KnowledgeGraphDocuments {
    const on = this.docsOn()
    const empty = { personal: { folders: 0, documents: 0, failed: 0 }, documents: 0, failed: [], failedCount: 0, lastUpdatedAt: null, diskBytes: 0, busy: 0 }
    if (!on) return { enabled: this.docsEnabled() && !!this.openDocs, folders: [], ...empty }
    const sources = new Map(this.candidates().map((c) => [c.path, c.source]))
    const idx = this.docIndex()
    const folders: KnowledgeGraphDocuments['folders'] = []
    const personal = { folders: 0, documents: 0, failed: 0 }
    const failed: KnowledgeGraphDocuments['failed'] = []
    let documents = 0, failedCount = 0, last: string | null = null
    for (const [p, s] of Object.entries(this.state.roots).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const d = s.docs
      if (!d) continue
      if (d.lastSyncAt && (!last || d.lastSyncAt > last)) last = d.lastSyncAt
      if (isPersonal(p)) { if (d.documents || d.failed) { personal.folders++; personal.documents += d.documents; personal.failed += d.failed } continue }
      if (!d.documents && !d.failed && d.status !== 'too_big' && d.status !== 'error') continue
      folders.push({ path: p, source: sources.get(p) ?? 'auto', status: d.status, documents: d.documents, failed: d.failed, lastUpdatedAt: d.lastSyncAt })
      documents += d.documents
      failedCount += d.failed
      if (d.failed && idx && failed.length < 100) {
        try { for (const f of idx.stats(p).failed) if (failed.length < 100 && plainRel(f.relPath)) failed.push({ path: `${p}/${f.relPath}`, reason: String(f.reason).slice(0, 40) }) } catch {}
      }
    }
    let diskBytes = 0
    try { diskBytes = idx?.diskBytes() ?? 0 } catch {}
    return { enabled: true, folders, personal, documents, failed, failedCount, lastUpdatedAt: last, diskBytes, busy: this.busy() }
  }

  /** Admin › Team settings › Knowledge graph. Personal folders only as a total. */
  status(): KnowledgeGraphStatus {
    const on = this.enabled()
    const base = { available: this.available(), version: this.runner?.version ?? null, enabled: on, added: this.added(), documents: this.docStatus() }
    if (!on) return { ...base, roots: [], personal: { folders: 0, files: 0, symbols: 0 }, diskBytes: 0, busy: 0 }
    const sources = new Map(this.candidates().map((c) => [c.path, c.source]))
    const roots: KnowledgeGraphRoot[] = []
    const personal = { folders: 0, files: 0, symbols: 0 }
    for (const [p, s] of Object.entries(this.state.roots).sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (!s.hasCode && s.status !== 'too_big') continue
      if (!s.indexed && s.status === 'pending' && !s.lastSyncAt) continue // not looked at yet: counted in busy
      if (isPersonal(p)) { if (s.indexed) { personal.folders++; personal.files += s.files; personal.symbols += s.symbols } continue }
      roots.push({ path: p, source: sources.get(p) ?? 'auto', status: s.status, files: s.files, symbols: s.symbols, lastSyncAt: s.lastSyncAt })
    }
    return { ...base, roots, personal, diskBytes: this.diskBytes(), busy: this.busy() }
  }

  // ---------------------------------------------------------------- questions
  /**
   * What a question may look at for `user`, decided now and for this question only (nothing is kept between questions
   * or shared between people): the folders they can see anything in (RuleSet.canList), and a check of one file, the
   * same as a read of it (authorize(read): folder rules, personal folders, hidden sub-folders, links, quarantine).
   * `base`: only under this team path (actual names, already authorized by the caller).
   */
  private access(user: Principal, base?: string): Access {
    const fx = this.ctx.files.fx
    const rules = this.ctx.files.rules()
    const seen = new Map<string, { abs: string } | null>()
    const acc: Access = { base } as Access
    /** the person may read this file now (anywhere, whatever `base` says): authorize(read), and one link to it, as the
     * read tool requires (files/store.ts refuses a hard-linked file) */
    const readable = (teamPath: string) => {
      if (seen.has(teamPath)) return seen.get(teamPath)!
      let v: { abs: string } | null = null
      try { const a = authorize(fx, rules, user, teamPath, 'read', acc.dirs ? { dirs: acc.dirs } : {}); if (a.st?.isFile() && a.st.nlink === 1) v = { abs: a.abs } } catch { v = null }
      seen.set(teamPath, v)
      return v
    }
    /** an answer may name this file: readable, and under `base` when one was given */
    const visible = (teamPath: string) => (!base || under(teamPath, base) ? readable(teamPath) : null)
    const mine = Object.keys(this.state.roots).filter((p) => {
      if (base && !under(p, base) && !under(base, p)) return false
      return rules.canList(user, p.split('/'))
    })
    const idx = this.docIndex()
    const docRoots = idx ? mine.filter((p) => !!this.state.roots[p]!.docs) : []
    const inDocRoot = (root: string, rel: string) => docRoots.includes(root) && plainRel(rel) ? `${root}/${rel}` : null
    return Object.assign(acc, { readable, visible, mine, idx, docRoots, inDocRoot })
  }

  /**
   * The document passages of one question in one or two wordings, for the person `a` was made for: each wording's
   * distinctive words (questionTerms; `words: 'search'`: every word, queryTerms) searched in the folders they can see,
   * every hit's file checked (a.visible), a hit
   * that holds none of the words as words left out, the wordings merged by best score with one entry per (path,
   * place), best first; the first `long` with up to LOOKUP_LONG_CHARS of their piece, the next `short` with up to
   * LOOKUP_SHORT_CHARS. Strength (matchStrength): the best of each wording's first LOOKUP_LONG passages.
   *
   * Time: the searches run in the search worker, never on this thread, all wordings at once; what is not back by `due`
   * is left out (the worker does not even start a request whose deadline has passed); without a deadline (the AI's
   * tool), the worker's own (search-worker.ts DEFAULT_DEADLINE_MS).
   */
  private async docPassages(a: Access, queries: readonly string[], o: { long: number; short: number; due: number; words?: LookupOptions['words']; meaningOnly?: boolean }): Promise<{ passages: LookupPassage[]; strength: LookupResult['strength'] }> {
    const long = clampInt(o.long, 0, 10), short = clampInt(o.short, 0, 50)
    const none = { passages: [] as LookupPassage[], strength: 'none' as const }
    if ((!long && !short) || !a.idx || !a.docRoots.length) return none
    const idx = a.idx
    const wordings = [...new Set(queries.map((q) => String(q ?? '').trim()).filter((q) => q.length >= 2))].slice(0, 2)
    // a folder inside the one root asked: the index looks only there (each hit is still checked against `base`)
    const root = a.docRoots.length === 1 ? a.docRoots[0]! : null
    const prefix = root && a.base && a.base !== root && under(a.base, root) ? a.base.slice(root.length + 1) : undefined
    const limit = Math.min(100, Math.max(40, (long + short) * 3))
    let strength: LookupResult['strength'] = 'none'
    const best = new Map<string, { path: string; loc: SourceLoc | null; score: number; long: string; short: string }>()
    const due = Number.isFinite(o.due) ? o.due : undefined
    const meaning = this.meaningSearch()
    // every wording at once; each one's answer only if it is back by the deadline (the worker drops a late one too)
    const asked = wordings.map((q) => {
      const terms = o.words === 'search' ? queryTerms(q) : questionTerms(q)
      if (!terms.length) return { terms, hits: Promise.resolve(null as DocHit[] | null) }
      const run = Promise.resolve().then(() => idx.search(terms.join(' '), { rootIds: a.docRoots, limit, passage: LOOKUP_LONG_CHARS, ...(prefix ? { prefix } : {}), ...(due !== undefined ? { due } : {}), ...(meaning ? { meaning } : {}) }))
      return { terms, hits: beforeDue(run, o.due).catch((e) => { this.ctx.log.warn('knowledge graph: document search failed', { err: String(e).slice(0, 200) }); return null }) }
    })
    for (const { terms, hits: pending } of asked) {
      const hits = await pending
      if (!hits) continue
      // the hits' files are checked in one synchronous pass: a folder's names are read once for all of them (on a
      // case-insensitive disk every check lists the folder; 45 checks of a folder of 3,000 files took 30–90 ms)
      a.dirs = new Map()
      let shown = 0
      for (const h of hits) {
        if (h.byMeaning && o.meaningOnly === false) continue
        const tp = a.inDocRoot(h.rootId, h.relPath)
        if (!tp || !a.visible(tp)) continue
        const text = String(h.passage || h.snippet || '')
        // found by meaning only: kept even without the words (a Korean document for an English question) but never
        // strong, so the lookup before the model names its file instead of pasting its text; strong stays the keyword rule
        const s = h.byMeaning ? 'weak' : matchStrength(terms, text)
        if (s === 'none') continue
        if (shown++ < LOOKUP_LONG && STRENGTH_RANK[s] > STRENGTH_RANK[strength]) strength = s
        const loc = h.loc ?? null
        const k = `${tp}\u0000${JSON.stringify(loc)}`
        const score = Number.isFinite(h.score) ? h.score : 0
        if ((best.get(k)?.score ?? -Infinity) >= score) continue
        best.set(k, { path: tp, loc, score, long: cutText(text, LOOKUP_LONG_CHARS), short: cutText(String(h.snippet || text).replace(/\s+/g, ' ').trim(), LOOKUP_SHORT_CHARS) })
      }
      a.dirs = undefined
    }
    const passages = [...best.values()].sort((x, y) => y.score - x.score || (x.path < y.path ? -1 : x.path > y.path ? 1 : 0)).slice(0, long + short)
      .map((x, i): LookupPassage => ({ path: x.path, loc: x.loc, text: i < long ? x.long : x.short, score: x.score, long: i < long }))
    return passages.length ? { passages, strength } : none
  }

  /**
   * What matches `query` in the folders `user` may see something in: passages of documents with their place (the
   * lookup's, in one or two wordings: `alt` is the second), the documents linked to the first ones (with the reason),
   * and code symbols with their first lines, callers and callees. Every file named in the answer passed authorize(read)
   * for this person just now; anything else is left out without a trace (no count, no name). `base`: only under this
   * team path (actual names, already authorized by the caller). `limit`: how many code symbols.
   */
  async explore(user: Principal, query: string, o: { base?: string; limit: number; alt?: string }): Promise<ExploreResult> {
    const acc = this.access(user, o.base)
    const { readable, visible, mine, idx, docRoots, inDocRoot } = acc
    const files = new Set<string>()
    // ---- documents
    const { passages, strength } = await this.docPassages(acc, [query, o.alt ?? ''], { long: LOOKUP_LONG, short: LOOKUP_SHORT, due: Infinity })
    const related: ExploreRelated[] = []
    if (idx && docRoots.length) {
      // the documents linked to the first few, each named only when the person may read it too
      const sources = [...new Set(passages.map((x) => x.path))].slice(0, 3)
      const named = new Set(passages.map((x) => x.path))
      // one short deadline for all of them: they queue behind each other in the one search worker, and related
      // documents are a bonus next to the passages (review of wave 1: up to about 20 s with 5 s each)
      const due = Date.now() + RELATED_MS
      for (const from of sources) {
        if (Date.now() >= due) break
        const root = docRoots.filter((r) => under(from, r)).sort((a, b) => b.length - a.length)[0]!
        let links: Awaited<ReturnType<DocIndexPort['related']>> = []
        try { links = await idx.related(root, from.slice(root.length + 1), { rootIds: docRoots, limit: 10, due }) } catch { links = [] }
        for (const l of links) {
          if (related.length >= 8) break
          const tp = inDocRoot(l.rootId, l.relPath)
          if (!tp || tp === from || named.has(tp) || !visible(tp)) continue
          named.add(tp)
          related.push({ path: tp, from, reason: { kind: String(l.reason?.kind ?? ''), detail: String(l.reason?.detail ?? '').slice(0, 200) } })
        }
      }
    }
    // ---- code
    const toTeam = (root: string, filePath: string): string | null => {
      if (!filePath.startsWith('tree/')) return null
      const rel = filePath.slice(5)
      return plainRel(rel) ? `${root}/${rel}` : null
    }
    const codeOn = this.enabled()
    const ready = codeOn ? mine.filter((p) => this.state.roots[p]!.indexed) : []
    const found: { root: string; path: string; s: GraphSymbol }[] = []
    await inBatches(ready, 3, async (root) => {
      for (const s of await this.runner!.search(this.project(root), query, Math.max(20, o.limit * 4))) {
        if (NOT_SHOWN.has(s.kind)) continue
        const tp = toTeam(root, s.filePath)
        if (tp && visible(tp)) found.push({ root, path: tp, s })
      }
    })
    found.sort((a, b) => b.s.score - a.s.score)
    const keys = new Set<string>()
    const top = found.filter((f) => { const k = `${f.path}:${f.s.startLine}:${f.s.name}`; if (keys.has(k)) return false; keys.add(k); return true }).slice(0, o.limit)
    const hits: ExploreHit[] = top.map((f) => ({ path: f.path, kind: f.s.kind, name: f.s.name, line: f.s.startLine, endLine: f.s.endLine, signature: f.s.signature, snippet: '', callers: [], callees: [] }))
    // the connections of the first few callables (each a CodeGraph run; the rest are named without them)
    const linked = hits.map((h, i) => ({ h, root: top[i]!.root })).filter((x) => CALLABLE.has(x.h.kind)).slice(0, 3)
    await inBatches(linked, 3, async ({ h, root }) => {
      const keep = (list: GraphRef[]) => {
        const out: GraphRef[] = []
        for (const r of list) {
          if (r.kind === 'file' || out.length >= 6) continue
          const tp = toTeam(root, r.filePath)
          if (tp && visible(tp)) out.push({ ...r, filePath: tp })
        }
        return out
      }
      // CodeGraph finds callers and callees by name only: with another function of the same name in a file this person
      // may not read, the connections could be that one's (security review F2). Exact names rank first in its search, so
      // the list below holds them all unless it is full of them; then nothing is shown either.
      const same = (await this.runner!.search(this.project(root), h.name, SAME_NAME_MAX)).filter((x) => x.name === h.name)
      if (!same.length || same.length >= SAME_NAME_MAX || same.some((x) => { const tp = toTeam(root, x.filePath); return !tp || !readable(tp) })) return
      const [up, down] = await Promise.all([this.runner!.callers(this.project(root), h.name, 12), this.runner!.callees(this.project(root), h.name, 12)])
      h.callers = keep(up)
      h.callees = keep(down)
    })
    // the lines come from the team file itself, read now for this person (the index's copy is never shown)
    for (const h of hits) {
      const v = visible(h.path)
      if (!v) continue
      try {
        const text = readRegular(v.abs, 2 * 1024 * 1024).bytes.toString('utf8')
        const lines = text.split('\n')
        const end = Math.min(lines.length, Math.max(h.line, Math.min(h.endLine, h.line + 11)))
        h.snippet = lines.slice(h.line - 1, end).map((l, i) => `${String(h.line + i).padStart(5)}  ${l.length > 300 ? l.slice(0, 300) + '…' : l}`).join('\n')
        // the signature is the index's (it can hold values: `= "sk-…"`, default arguments): shown only while the file
        // itself still has it, so a value taken out of a file is not shown from an older index (security review F3)
        if (h.signature && !squash(text).includes(squash(h.signature))) h.signature = null
      } catch { h.signature = null /* changed meanwhile: named without lines */ }
      files.add(h.path)
      for (const r of [...h.callers, ...h.callees]) files.add(r.filePath)
    }
    for (const x of passages) files.add(x.path)
    for (const x of related) files.add(x.path)
    // only folders never indexed yet: an update in progress can come from a change in a part hidden from this person,
    // and counting it would tell them (security review F1)
    const pending = mine.filter((p) => {
      const s = this.state.roots[p]!
      const waiting = (x: { status: string; lastSyncAt: string | null }) => x.lastSyncAt === null && (x.status === 'pending' || x.status === 'indexing')
      return (codeOn && waiting(s)) || (!!s.docs && waiting(s.docs))
    }).length
    return { hits, passages, strength, related, pending, indexed: ready.length + docRoots.length, files }
  }

  /**
   * Document passages for one question in one or two wordings (e.g. the person's Korean and an English one), for this
   * person. The one search behind knowledge_explore, the lookup before the model starts (chat/turn.ts) and the Files
   * search (team-files/content-search.ts).
   *
   * - Documents only: no CodeGraph run, so it is fast enough to run before every message.
   * - Access as in explore (the same code, access()): only folders the person can see anything in, every file of an
   *   answer passes authorize(read) for them now, `base` respected, anything else left out without a trace (no name, no
   *   count, and no effect on the strength); nothing cached between questions or people.
   * - Strength (documents/index.ts matchStrength, on each wording's distinctive words, questionTerms): strong when one
   *   of the first passages holds all the words close together (four words or more: all but one; one word: only a code,
   *   a date or a file name), weak when passages hold some of them, none when nothing is found. Greetings, thanks,
   *   requests and question words do not count as words, so "hi", "thanks" or "write me an email" are none or weak.
   * - `deadlineMs`: it answers by then with what is ready: a search not back in time is left out, and with one wording
   *   that means nothing (none). The searches run in the search worker (documents/search-worker.ts), so the server is
   *   never held while they run; the search is bounded too (a few hundred pieces per word).
   * - `words: 'search'` (the Files search box): every word typed counts, not only a chat message's distinctive ones.
   */
  async lookup(user: Principal, queries: readonly string[], o: LookupOptions = {}): Promise<LookupResult> {
    const due = o.deadlineMs !== undefined && Number.isFinite(o.deadlineMs) ? Date.now() + Math.max(0, o.deadlineMs) : Infinity
    const r = await this.docPassages(this.access(user, o.base), queries, { long: o.long ?? LOOKUP_LONG, short: o.short ?? LOOKUP_SHORT, due, words: o.words, meaningOnly: o.meaningOnly })
    return { passages: r.passages, strength: r.strength, files: new Set(r.passages.map((x) => x.path)) }
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.abort?.abort()
    for (const t of this.timers.values()) clearTimeout(t.t)
    this.timers.clear()
    clearTimeout(this.loops.first)
    clearInterval(this.loops.every)
    this.ctx.files.events.off('tree-changed', this.onChanged)
    this.meaning?.close()
    try { this.docs?.close() } catch {}
    for (const f of this.idle.splice(0)) f()
  }
}

export class KgError extends Error {
  constructor(readonly code: 'root' | 'personal' | 'not_found') { super(code) }
}

async function inBatches<T>(items: T[], n: number, f: (x: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += n) await Promise.all(items.slice(i, i + n).map(f))
}

/** what a question may look at for one person (KnowledgeGraph.access) */
interface Access {
  base: string | undefined
  /** folder listings read in the current synchronous pass of checks (authorize's `dirs`), none outside one */
  dirs?: Map<string, string[]>
  /** the person may read this file now */
  readable: (teamPath: string) => { abs: string } | null
  /** an answer may name this file: readable, and under `base` */
  visible: (teamPath: string) => { abs: string } | null
  /** the indexed folders they can see anything in */
  mine: string[]
  idx: DocIndexPort | null
  /** of those, the ones with documents */
  docRoots: string[]
  /** a hit's team path, when its folder is one of docRoots and its path plain */
  inDocRoot: (root: string, rel: string) => string | null
}
const STRENGTH_RANK = { none: 0, weak: 1, strong: 2 } as const
const clampInt = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.floor(Number.isFinite(n) ? n : lo)))
/** the promise's value, or null once `due` (a Date.now() time) has passed: the deadline holds whatever index answers */
async function beforeDue<T>(p: Promise<T>, due: number): Promise<T | null> {
  if (due === Infinity) return p
  // one that fails after the deadline fails unheard (nobody waits for it any more)
  p.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((r) => { timer = setTimeout(() => r(null), Math.max(0, due - Date.now())) })
  try { return await Promise.race([p, late]) } finally { clearTimeout(timer) }
}

const SINGLETON = new WeakMap<AppContext, KnowledgeGraph>()
/** The knowledge graph of a server instance (made on first use). */
export function knowledgeGraphOf(ctx: AppContext, opts?: KgOptions): KnowledgeGraph {
  let k = SINGLETON.get(ctx)
  if (!k) {
    // tests: no first check, no CodeGraph and no document index unless a test gives them (what is installed on the
    // machine running the tests must not change other tests' tool lists); no model for search by meaning either
    k = new KnowledgeGraph(ctx, { ...(process.env.NODE_ENV === 'test' ? { firstCheckMs: null, runner: null, openDocs: null, meaning: null } : {}), ...testOptions, ...opts })
    SINGLETON.set(ctx, k)
  }
  return k
}
