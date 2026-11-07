// Search by meaning in the document search worker (documents/search-worker.ts; docs/AGENTS/plan/
// 20261107-0819-knowledge-graph-fast-answers.md, wave 2): the pieces' vectors held in memory, the query's embedding,
// and the closest pieces (top-k by dot8) in the folders asked. The worker fuses them with the keyword search's pieces
// (documents/index.ts hits); meaning results are never used alone in a way that pretends confidence. Contract:
// meaning/vectors.ts.
//
// - Vectors: chunks.vec (int8, 384 bytes, NULL until embedded) of the pieces of documents not failed, about 38 MB per
//   100,000 pieces, grouped by folder (root) and document. A database without the column yet holds none.
// - Kept current per document, not per search: a look happens before a meaning search when the index changed since
//   the last one (PRAGMA data_version) and the last one is at least REFRESH_MS old. It reads the docs table (one row per
//   document) and loads again only the documents that are new, changed (updated_at, hash, pieces: a document indexed
//   again gets new piece ids), or not fully embedded at the last look; documents gone are dropped. Between two looks a
//   vector can name a piece deleted since: the fused search reads every piece only meaning found again, within the
//   folders asked, so such a piece gives nothing. The loads yield between batches, so searches go on meanwhile.
// - The query's embedding: the embedder opened when first needed (or when the worker starts with meaning on and
//   vectors exist), with a few threads, tried again RETRY_MS after a failure. The model and the vectors leave memory
//   after IDLE_MS without a meaning search.
// - Time: a search gives the closest pieces only when the vectors and the query's embedding are ready by its time;
//   otherwise null, and the keyword result goes out alone.
import type { Database } from 'bun:sqlite'
import { plainPrefix } from '../documents/index'
import { blobToVec, dot8, MEANING_DIMS, quantize, type Embedder } from './vectors'

/** the closest pieces fused with the keyword list */
export const MEANING_K = 50
/** the model and the vectors leave memory after this long without a meaning search (the model holds 150–300 MB) */
export const MEANING_IDLE_MS = 15 * 60_000
/** at most one look at the index's changes this often */
export const MEANING_REFRESH_MS = 10_000
/** a model that would not open is tried again after this long, not on every search */
const RETRY_MS = 10 * 60_000
/** documents loaded between two yields */
const BATCH_DOCS = 200
const FULL = 127 * 127

export type OpenEmbedder = () => Promise<Embedder>
export interface MeaningOptions {
  /** opens the embedder (meaning/embedder.ts openEmbedder; tests: a stand-in) */
  open: OpenEmbedder
  k?: number
  idleMs?: number
  refreshMs?: number
  now?: () => number
  /** a problem worth a log line (the model would not open) */
  warn?: (msg: string) => void
}

const yieldNow = () => new Promise<void>((r) => setImmediate(r))
const dataVersion = (db: Database) => (db.query('PRAGMA data_version').get() as { data_version: number }).data_version
const hasVec = (db: Database) => !!db.query("SELECT 1 FROM pragma_table_info('chunks') WHERE name = 'vec'").get()

interface DocVecs { root: string; rel: string; key: string; ids: number[]; vecs: Int8Array[]; complete: boolean }

/** The vectors of the pieces in one documents.db, in memory (read through the search worker's connection). */
export class MeaningVectors {
  private docs = new Map<number, DocVecs>()
  private roots = new Map<string, Map<number, DocVecs>>()
  private count = 0
  private perRoot = new Map<string, number>()
  private version: number | null = null
  private checkedAt = -Infinity
  private running: Promise<void> | null = null
  /** bumped by clear(): a load that was going drops what it read */
  private gen = 0
  /** the first load is done */
  ready = false

  constructor(private db: Database, private o: { refreshMs?: number; now?: () => number } = {}) {}

  /** vectors held */
  get size() { return this.count }
  /** any vector in these folders */
  has(rootIds: readonly string[]) { return rootIds.some((r) => (this.perRoot.get(r) ?? 0) > 0) }

  /** Look at the index now and load what changed (everything the first time); one look at a time. */
  refresh(): Promise<void> {
    return this.running ??= this.load().finally(() => { this.running = null })
  }

  /** A look, when the index changed since the last one and that one is at least refreshMs old; not waited for. */
  maybeRefresh() {
    const now = (this.o.now ?? Date.now)()
    if (this.running || now - this.checkedAt < (this.o.refreshMs ?? MEANING_REFRESH_MS)) return
    try { if (dataVersion(this.db) === this.version) return } catch { return }
    void this.refresh().catch(() => {})
  }

  /** The `k` pieces closest to `q` in these folders (and under `prefix` of the root, as in documents/index.ts), best
   * first: chunk id and closeness (dot8 / 127², about the cosine). */
  topK(q: Int8Array, o: { rootIds: readonly string[]; prefix?: string; k: number }): { id: number; score: number }[] {
    const k = Math.max(1, Math.floor(o.k))
    const prefix = o.prefix && plainPrefix(o.prefix) ? o.prefix : null
    const lo = prefix ? prefix + '/' : null, hi = prefix ? prefix + '0' : null
    const best: { id: number; s: number }[] = []
    let floor = -Infinity
    for (const root of new Set(o.rootIds)) {
      const docs = this.roots.get(root)
      if (!docs) continue
      for (const d of docs.values()) {
        if (lo !== null && !(d.rel >= lo && d.rel < hi!)) continue
        for (let i = 0; i < d.vecs.length; i++) {
          const s = dot8(q, d.vecs[i]!)
          const id = d.ids[i]!
          if (best.length >= k && (s < floor || (s === floor && id > best[best.length - 1]!.id))) continue
          let at = best.length
          while (at > 0 && (best[at - 1]!.s < s || (best[at - 1]!.s === s && best[at - 1]!.id > id))) at--
          best.splice(at, 0, { id, s })
          if (best.length > k) best.pop()
          if (best.length >= k) floor = best[best.length - 1]!.s
        }
      }
    }
    return best.map((x) => ({ id: x.id, score: x.s / FULL }))
  }

  /** Everything out of memory (idle, or the worker ends); the next search loads again. */
  clear() {
    this.gen++
    this.docs.clear()
    this.roots.clear()
    this.perRoot.clear()
    this.count = 0
    this.version = null
    this.checkedAt = -Infinity
    this.ready = false
  }

  private async load() {
    const gen = this.gen
    this.checkedAt = (this.o.now ?? Date.now)()
    this.version = dataVersion(this.db)
    // the column comes with the meaning index (meaning/embedder.ts); until then there is nothing to hold
    if (!hasVec(this.db)) { for (const id of [...this.docs.keys()]) this.drop(id); this.ready = true; return }
    const rows = this.db.query('SELECT id, root_id, rel, updated_at, hash, chunks FROM docs WHERE failed IS NULL AND chunks > 0')
      .all() as { id: number; root_id: string; rel: string; updated_at: number; hash: string | null; chunks: number }[]
    const seen = new Set<number>()
    const todo: { id: number; root: string; rel: string; key: string; chunks: number }[] = []
    for (const r of rows) {
      seen.add(r.id)
      const key = `${r.updated_at}:${r.hash ?? ''}:${r.chunks}`
      const old = this.docs.get(r.id)
      if (!old || old.key !== key || !old.complete || old.root !== r.root_id || old.rel !== r.rel) todo.push({ id: r.id, root: r.root_id, rel: r.rel, key, chunks: r.chunks })
    }
    for (const id of [...this.docs.keys()]) if (!seen.has(id)) this.drop(id)
    const piecesOf = this.db.query('SELECT id, vec FROM chunks WHERE doc_id = ? AND vec IS NOT NULL ORDER BY ord')
    for (let i = 0; i < todo.length; i++) {
      if (i && i % BATCH_DOCS === 0) { await yieldNow(); if (gen !== this.gen) return }
      const t = todo[i]!
      const got = piecesOf.all(t.id) as { id: number; vec: Uint8Array | null }[]
      // one buffer per document, a view per piece (no allocation per search)
      const buf = new Int8Array(got.length * MEANING_DIMS)
      const ids: number[] = [], vecs: Int8Array[] = []
      for (const g of got) {
        const v = blobToVec(g.vec)
        if (!v) continue
        const at = ids.length * MEANING_DIMS
        buf.set(v, at)
        ids.push(g.id)
        vecs.push(buf.subarray(at, at + MEANING_DIMS))
      }
      this.put(t.id, { root: t.root, rel: t.rel, key: t.key, ids, vecs, complete: got.length === t.chunks && ids.length === got.length })
    }
    if (gen === this.gen) this.ready = true
  }

  private put(id: number, d: DocVecs) {
    this.drop(id)
    this.docs.set(id, d)
    let m = this.roots.get(d.root)
    if (!m) { m = new Map(); this.roots.set(d.root, m) }
    m.set(id, d)
    this.count += d.ids.length
    this.perRoot.set(d.root, (this.perRoot.get(d.root) ?? 0) + d.ids.length)
  }

  private drop(id: number) {
    const d = this.docs.get(id)
    if (!d) return
    this.docs.delete(id)
    this.roots.get(d.root)?.delete(id)
    this.count -= d.ids.length
    this.perRoot.set(d.root, (this.perRoot.get(d.root) ?? 0) - d.ids.length)
  }
}

/** The query's embedder: opened when first needed, tried again RETRY_MS after a failure, unloaded when idle. */
export class QueryEmbedder {
  private ready: Promise<Embedder | null> | null = null
  private model: Embedder | null = null
  private failedAt = -Infinity
  private busy = 0
  private lastUse = 0

  constructor(private open: OpenEmbedder, private o: { now?: () => number; warn?: (msg: string) => void } = {}) {}

  private now() { return (this.o.now ?? Date.now)() }
  /** the model is in memory */
  loaded() { return this.model !== null }
  /** start opening it now (not waited for) */
  warm() { void this.get() }

  /** the query's vector, as int8; null when the model cannot open. A loaded model starts at once (no await before
   * it), so the caller's keyword search runs while it does. */
  async embed(text: string): Promise<Int8Array | null> {
    this.lastUse = this.now()
    const m = this.model ?? await this.get()
    if (!m) return null
    this.busy++
    try {
      const [v] = await m.embed([text], 'query')
      return v && v.length === MEANING_DIMS ? quantize(v) : null
    } finally { this.busy--; this.lastUse = this.now() }
  }

  /** unload when unused for `idleMs` (not while embedding) */
  idle(idleMs: number): boolean {
    if (!this.ready || this.busy > 0 || this.now() - this.lastUse < idleMs) return false
    this.unload()
    return true
  }

  unload() {
    const m = this.model
    this.model = null
    this.ready = null
    if (m) Promise.resolve().then(() => m.dispose()).catch(() => {})
  }

  private get(): Promise<Embedder | null> {
    if (this.ready) return this.ready
    if (this.now() - this.failedAt < RETRY_MS) return Promise.resolve(null)
    const p: Promise<Embedder | null> = this.open().then(
      (m) => {
        // unloaded while it opened
        if (this.ready !== p) { Promise.resolve().then(() => m.dispose()).catch(() => {}); return null }
        this.model = m
        return m
      },
      (e) => {
        this.failedAt = this.now()
        if (this.ready === p) this.ready = null
        this.o.warn?.(`search by meaning: the embedding model could not open; keyword search only for ${RETRY_MS / 60_000} minutes: ${String((e as Error)?.message ?? e).slice(0, 200)}`)
        return null
      })
    this.ready = p
    return p
  }
}

/** a promise's value, or null once `until` (a Date.now() time) has passed */
async function until<T>(p: Promise<T>, at: number): Promise<T | null> {
  if (at === Infinity) return p
  p.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((r) => { timer = setTimeout(() => r(null), Math.max(0, at - Date.now())) })
  try { return await Promise.race([p, late]) } finally { clearTimeout(timer) }
}

/** Search by meaning over one documents.db, for the search worker: the vectors, the query's embedder, the idle unload. */
export class MeaningSearch {
  readonly vectors: MeaningVectors
  readonly embedder: QueryEmbedder
  private lastUse: number
  private timer: ReturnType<typeof setInterval> | null = null
  /** how long the last top-k took: one that would end past a search's time is not started */
  private topKMs = 0

  constructor(db: Database, private o: MeaningOptions) {
    this.vectors = new MeaningVectors(db, { refreshMs: o.refreshMs, now: o.now })
    this.embedder = new QueryEmbedder(o.open, { now: o.now, warn: o.warn })
    this.lastUse = this.now()
    if (!o.now) {
      this.timer = setInterval(() => this.checkIdle(), Math.min(60_000, this.idleMs))
      ;(this.timer as { unref?: () => void }).unref?.()
    }
  }

  private now() { return (this.o.now ?? Date.now)() }
  private get idleMs() { return this.o.idleMs ?? MEANING_IDLE_MS }

  /** The vectors loaded now, then the model when there are any (the worker started with meaning on). */
  warm() {
    this.lastUse = this.now()
    void this.vectors.refresh().then(() => { if (this.vectors.size) this.embedder.warm() }, () => {})
  }

  /**
   * The pieces closest in meaning to `query` in these folders (and under `prefix`), best first; null when there are
   * no vectors there, or when the vectors or the query's embedding are not ready by `at` (a Date.now() time; the
   * keyword result then goes out alone). The embedding starts at once, so the caller can run the keyword search while
   * it runs.
   */
  async topK(query: string, o: { rootIds: readonly string[]; prefix?: string; at?: number }): Promise<{ id: number; score: number }[] | null> {
    this.lastUse = this.now()
    const at = o.at ?? Infinity
    if (!this.vectors.ready) await until(this.vectors.refresh().catch(() => {}), at)
    else this.vectors.maybeRefresh()
    if (!this.vectors.ready || !this.vectors.has(o.rootIds)) return null
    const q = await until(this.embedder.embed(query), at)
    if (!q || Date.now() + this.topKMs >= at) return null
    const t0 = performance.now()
    const top = this.vectors.topK(q, { rootIds: o.rootIds, prefix: o.prefix, k: this.o.k ?? MEANING_K })
    this.topKMs = performance.now() - t0
    return top
  }

  /** The model and the vectors out of memory after the idle time without a meaning search. */
  checkIdle(): boolean {
    if (this.now() - this.lastUse < this.idleMs) return false
    const was = this.embedder.loaded() || this.vectors.ready
    this.embedder.idle(0)
    this.vectors.clear()
    return was
  }

  close() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.embedder.unload()
    this.vectors.clear()
  }
}
