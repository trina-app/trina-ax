// The document index's searches off the server's main thread. A search in documents.db is synchronous SQLite work
// (tens to hundreds of milliseconds on a large index); on the main thread it held every request of every person for that
// long, and no deadline could fire before it ended. So the reads (search, related) run in one long-lived Bun Worker with
// its own connection (DocumentIndex.openReader: query_only, WAL), and the caller waits only until its deadline:
// - requests and replies carry an id; a reply nobody waits for any more is dropped
// - the caller's deadline (`due`, a Date.now() time) passes: the caller gets null at once; a request still queued in the
//   worker when its deadline has passed is dropped there without running. A request without one (the AI's tool,
//   related documents) gets DEFAULT_DEADLINE_MS, so a worker that hangs cannot hold the AI's turn
// - the worker starts when the index opens and again as soon as it died, and opens its connection at once both times
//   (warm: its first answer takes 0.1–0.5 s, more than a lookup's deadline, and a request already late never opens it)
// - after FAILS_MAX failures in a row it is left off for PAUSE_MS (usable: false) and the caller searches on its own
//   thread meanwhile, bounded, instead of starting a worker that dies again; the next read after that starts it again;
//   it ends with the index (close)
// - the index's writes (update, remove, dropRoot) stay on the main thread's connection; WAL lets this one read the last
//   committed state meanwhile
// - search by meaning (wave 2) lives here too: a search asked with `meaning` and vectors in its folders is the combined
//   search (combinedSearch): the query's embedding starts, the keyword search runs meanwhile, and the closest pieces
//   (meaning/search.ts) are fused with its pieces by rank. What is not ready MEANING_MARGIN_MS before the deadline is
//   left out, so the keyword result goes out alone and in time. Without `meaning`, or without vectors, the search is
//   the keyword search exactly. The model and the vectors are loaded when first needed, or as soon as the worker starts
//   when the index says meaning is on (DocSearchWorker's `meaning`), and leave memory after 15 minutes unused. The
//   worker searches only the folders it is asked (rootIds, prefix), the vectors as well as the pieces; access is still
//   decided for every hit on the main thread (service.ts).
// - the model runs in a thread of its own, which this worker starts from this same script (threadEmbedder): opening it
//   holds its thread for about a second (the ONNX session: 0.7–0.8 s in one stretch on an M1 Pro, more on 2 cores),
//   which here would hold every search, keyword ones too, so a lookup in that time got nothing at all. Unloading it
//   ends that thread, and the model's memory with it.
//
// The worker is this file: built next to main.js as doc-search-worker.js in the bundles (scripts/build-bundle.ts and
// scripts/build-office.ts ENTRIES), run as TypeScript in a repository checkout.
import fs from 'node:fs'
import path from 'node:path'
import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { DocumentIndex, type DocHit, type RelatedDoc, type SearchOptions } from './index'
import { openEmbedder, type EmbedderOptions } from '../meaning/embedder'
import { MeaningSearch, type OpenEmbedder } from '../meaning/search'
import type { Embedder } from '../meaning/vectors'

const MARK = 'mycel-doc-search'
/** this script started as the search worker's embedder thread */
const EMBED_MARK = 'mycel-doc-embed'
/** a request without its own deadline gets nothing after this long */
export const DEFAULT_DEADLINE_MS = 5_000
/** failures in a row (the worker died, or would not start) after which it is left off for PAUSE_MS */
export const FAILS_MAX = 3
export const PAUSE_MS = 5 * 60_000
/** the combined search answers this long before its deadline, with what is ready by then, so the answer is back in time */
export const MEANING_MARGIN_MS = 15
/** ONNX threads for a person's query (the background indexing has its own) */
const QUERY_THREADS = 2

export type Req =
  | { id: number; op: 'open'; dir: string; due: number | null; meaning?: boolean }
  | { id: number; op: 'search'; dir: string; due: number | null; query: string; o: SearchOptions }
  | { id: number; op: 'related'; dir: string; due: number | null; rootId: string; relPath: string; o: { rootIds: readonly string[]; limit?: number }; people: string[] }
export type Reply = { id: number; value: unknown } | { id: number; late: true } | { id: number; error: string } | { id: 0; warn: string }

// ---------------------------------------------------------------- the worker
/** what the worker reads with (openSearchReader; tests: a stand-in). `due`: the request's deadline (a Date.now() time).
 * A combined search answers asynchronously. */
export interface DocReader {
  readonly dir: string
  search(query: string, o: SearchOptions, due?: number | null): DocHit[] | Promise<DocHit[]>
  related(rootId: string, relPath: string, o: { rootIds: readonly string[]; limit?: number }): RelatedDoc[]
  /** the worker started with meaning on: load the vectors and, when there are any, the model now */
  warm?(meaning: boolean): void
  close(): void
}

/**
 * The worker's reader: the keyword search on its own connection (DocumentIndex.openReader), and with `open` (an
 * embedder opener: meaning/embedder.ts openEmbedder; tests: a stand-in) the combined search for searches asked with
 * `meaning`. The meaning part is made when first needed.
 */
export function openSearchReader(dir: string, people: () => readonly string[], open: OpenEmbedder | null, warn?: (msg: string) => void): DocReader {
  const idx = DocumentIndex.openReader(dir, { people })
  let meaning: MeaningSearch | null = null
  const meaningPart = (o: OpenEmbedder) => meaning ??= new MeaningSearch(idx.readerDb(), { open: o, warn })
  return {
    dir,
    search: (query, o, due) => o.meaning && open ? combinedSearch(idx, meaningPart(open), query, o, due ?? null) : idx.search(query, o),
    related: (rootId, relPath, o) => idx.related(rootId, relPath, o),
    warm: (on) => { if (on && open) meaningPart(open).warm() },
    close: () => { meaning?.close(); meaning = null; idx.close() },
  }
}

/**
 * Keyword and meaning together: the query's embedding starts first (meaning/search.ts topK), the keyword search runs
 * while it does, and the closest pieces in the same folders are fused with the keyword pieces by rank
 * (documents/index.ts hits). The meaning part counts only when ready MEANING_MARGIN_MS before `due`; otherwise, or
 * without vectors in these folders, the hits are the keyword search's exactly.
 */
export async function combinedSearch(idx: DocumentIndex, meaning: MeaningSearch, query: string, o: SearchOptions, due: number | null): Promise<DocHit[]> {
  const at = due === null ? Infinity : due - MEANING_MARGIN_MS
  const top = meaning.topK(query, { rootIds: o.rootIds, prefix: o.prefix, at }).catch(() => null)
  const ranked = idx.rankKeywords(query, o)
  return idx.hits(ranked, o, await top)
}

/** The worker's loop: one request at a time, in order (a combined search answers when its meaning part is in, and the
 * next requests run meanwhile); a request whose deadline has passed is answered "late" without running. */
export function serveDocSearch(port: { on(ev: 'message', f: (m: Req) => void): unknown; postMessage(r: Reply): void }, open: (dir: string, people: () => readonly string[]) => DocReader) {
  let idx: DocReader | null = null
  let people: string[] = []
  const failed = (id: number, e: unknown, reader: DocReader | null): Reply => {
    // a damaged or replaced database: opened again at the next request
    if (reader) { try { reader.close() } catch {} }
    if (idx === reader) idx = null
    return { id, error: String((e as Error)?.message ?? e).slice(0, 300) }
  }
  port.on('message', (m: Req) => {
    let reply: Reply
    if (m.due !== null && Date.now() >= m.due) reply = { id: m.id, late: true }
    else {
      try {
        if (!idx || idx.dir !== m.dir) { idx?.close(); idx = open(m.dir, () => people) }
        if (m.op === 'open') { if (m.meaning) idx.warm?.(true); reply = { id: m.id, value: true } }
        else if (m.op === 'search') {
          const v = idx.search(m.query, m.o, m.due)
          if (v instanceof Promise) {
            const reader = idx
            v.then((value) => port.postMessage({ id: m.id, value }), (e) => port.postMessage(failed(m.id, e, reader)))
            return
          }
          reply = { id: m.id, value: v }
        } else { people = m.people; reply = { id: m.id, value: idx.related(m.rootId, m.relPath, m.o) } }
      } catch (e) {
        reply = failed(m.id, e, idx)
      }
    }
    port.postMessage(reply)
  })
}

// ---------------------------------------------------------------- the embedder's thread
type EmbedReq = { id: number; texts: string[]; kind: 'query' | 'passage' }
type EmbedReply = { ready: true } | { id: number; vecs: Float32Array[] } | { id: number; error: string }

/** The embedder thread's loop: opens the embedder, says ready (or why not, with id 0), then embeds one request after
 * another. */
export function serveEmbedder(port: { on(ev: 'message', f: (m: EmbedReq) => void): unknown; postMessage(r: EmbedReply): void }, open: OpenEmbedder) {
  open().then((emb) => {
    port.on('message', (m) => {
      emb.embed(m.texts, m.kind).then((vecs) => port.postMessage({ id: m.id, vecs }), (e) => port.postMessage({ id: m.id, error: String((e as Error)?.message ?? e).slice(0, 300) }))
    })
    port.postMessage({ ready: true })
  }, (e) => port.postMessage({ id: 0, error: String((e as Error)?.message ?? e).slice(0, 300) }))
}

/**
 * The embedder in a thread of its own, started from `script` (this file, or its built doc-search-worker.js) with
 * `o` for openEmbedder: resolves once the model is open there, rejects when it cannot open or the thread fails.
 * The search worker's thread never waits on the model's opening (about a second of blocking work). dispose() ends the
 * thread; an embedding asked after the thread failed is refused, and the caller opens a new one.
 */
export function threadEmbedder(script: string, o: EmbedderOptions): Promise<Embedder> {
  return new Promise((resolve, reject) => {
    let w: Worker
    try { w = new Worker(script, { workerData: { kind: EMBED_MARK, script, o } } as WorkerOptions) } catch (e) { reject(e); return }
    let seq = 0, gone: Error | null = null
    const waiting = new Map<number, { ok: (v: Float32Array[]) => void; no: (e: Error) => void }>()
    const end = (e: Error) => {
      if (gone) return
      gone = e
      for (const x of waiting.values()) x.no(e)
      waiting.clear()
      reject(e)
      try { w.terminate() } catch {}
    }
    const emb: Embedder = {
      embed: (texts, kind) => new Promise((ok, no) => {
        if (gone) return no(gone)
        const id = ++seq
        waiting.set(id, { ok, no })
        w.postMessage({ id, texts, kind } satisfies EmbedReq)
      }),
      dispose: () => end(new Error('embedder closed')),
    }
    w.addEventListener('message', (e: MessageEvent<EmbedReply>) => {
      const m = e.data
      if ('ready' in m) return resolve(emb)
      if (m.id === 0 && 'error' in m) return end(new Error(m.error))
      const x = waiting.get(m.id)
      if (!x) return
      waiting.delete(m.id)
      if ('error' in m) x.no(new Error(m.error))
      else x.ok(m.vecs)
    })
    w.addEventListener('error', (e: ErrorEvent) => end(new Error(`embedder thread failed: ${String(e.message ?? e).slice(0, 200)}`)))
    w.addEventListener('close', () => end(new Error('embedder thread ended')))
    ;(w as Worker & { unref?: () => void }).unref?.()
  })
}

// this file started as the worker, or as its embedder thread (not imported by another worker script)
const started = workerData as { kind?: string; script?: string; o?: EmbedderOptions } | null
if (!isMainThread && parentPort && started?.script && path.resolve(started.script) === path.resolve(import.meta.path)) {
  const port = parentPort
  const script = started.script
  if (started.kind === MARK) {
    const warn = (msg: string) => port.postMessage({ id: 0, warn: msg } satisfies Reply)
    serveDocSearch(port, (dir, people) => openSearchReader(dir, people, () => threadEmbedder(script, meaningModelDirs(dir)), warn))
  } else if (started.kind === EMBED_MARK && started.o) {
    const o = started.o
    serveEmbedder(port, () => openEmbedder(o))
  }
}

/** The embedder's folders for a document index in `dir` (<data>/knowledge-graph/documents, service.ts): the team's
 * own <data>/models, or the host's shared $MYCEL_MODELS_DIR/semantic when its files match (as the meaning index).
 * Never a download here: the background indexing (meaning/indexer.ts) fetched and checked the files before any vector
 * existed, and a person's search does not go to the network; files missing or wrong mean keyword search only. */
export function meaningModelDirs(dir: string): EmbedderOptions {
  const shared = process.env.MYCEL_MODELS_DIR ? path.join(process.env.MYCEL_MODELS_DIR, 'semantic') : null
  return { modelDir: path.resolve(dir, '..', '..', 'models'), sharedDir: shared, threads: QUERY_THREADS, download: false }
}

// ---------------------------------------------------------------- the main thread's side
/** The worker's script: built next to the server's main.js in the bundles, this file in a checkout; null: neither. */
export function docSearchWorkerScript(): string | null {
  const built = path.join(import.meta.dir, 'doc-search-worker.js')
  if (fs.existsSync(built)) return built
  const src = path.join(import.meta.dir, 'search-worker.ts')
  return fs.existsSync(src) ? src : null
}

/** The searches of one document index (in `dir`), run in the worker. */
export class DocSearchWorker {
  private w: Worker | null = null
  private seq = 0
  private waiting = new Map<number, { done: (r: Reply | null) => void; timer?: ReturnType<typeof setTimeout> }>()
  private closed = false
  private fails = 0
  private pausedUntil = 0

  /** a search asked with meaning since the start: a worker that starts again warms it too */
  private meaningAsked = false

  /** `meaning`: search by meaning is on, so the worker loads its vectors and model as soon as it starts */
  constructor(readonly dir: string, private script: string, private onError: (err: string) => void = () => {}, private o: { meaning?: () => boolean } = {}) {}

  /** the pieces that answer `query` (DocumentIndex.search, or the combined search with `meaning`); [] when not ready
   * by `due` */
  async search(query: string, o: SearchOptions & { due?: number }): Promise<DocHit[]> {
    const { due, ...rest } = o
    if (rest.meaning) this.meaningAsked = true
    const r = await this.ask({ op: 'search', query, o: rest }, due)
    return Array.isArray(r) ? r as DocHit[] : []
  }

  /** the documents related to one (DocumentIndex.related), with the team members' names for "people" links */
  async related(rootId: string, relPath: string, o: { rootIds: readonly string[]; limit?: number; due?: number }, people: string[]): Promise<RelatedDoc[]> {
    const { due, ...rest } = o
    const r = await this.ask({ op: 'related', rootId, relPath, o: rest, people }, due)
    return Array.isArray(r) ? r as RelatedDoc[] : []
  }

  /** Start the worker and open its connection now, so the first search does not wait for them (about 0.1–0.5 s: a
   * lookup before the model starts has 200 ms). */
  warm() { if (this.usable && !this.closed) try { this.worker() } catch {} }

  /** false for PAUSE_MS after FAILS_MAX failures in a row: the caller searches on its own thread meanwhile */
  get usable() { return Date.now() >= this.pausedUntil }

  /** the worker ends; anyone still waiting gets nothing */
  close() {
    this.closed = true
    this.stop()
  }

  /** tests: the worker runs now */
  get running() { return !!this.w }

  private ask(body: Record<string, unknown>, at?: number): Promise<unknown> {
    if (this.closed || !this.usable) return Promise.resolve(null)
    const due = at ?? Date.now() + DEFAULT_DEADLINE_MS
    if (Date.now() >= due) return Promise.resolve(null)
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const entry: { done: (r: Reply | null) => void; timer?: ReturnType<typeof setTimeout> } = {
        done: (r) => {
          this.waiting.delete(id)
          clearTimeout(entry.timer)
          if (r && 'error' in r) reject(new Error(r.error))
          else resolve(r && 'value' in r ? r.value : null)
        },
      }
      // the deadline: what is ready now (nothing), not what comes later
      entry.timer = setTimeout(() => entry.done(null), Math.max(0, due - Date.now()))
      this.waiting.set(id, entry)
      try { this.worker().postMessage({ id, dir: this.dir, due, ...body }) } catch (e) { entry.done({ id, error: String(e) }) }
    })
  }

  private worker(): Worker {
    if (this.w) return this.w
    let w: Worker
    try { w = new Worker(this.script, { workerData: { kind: MARK, script: this.script } } as WorkerOptions) } catch (e) {
      this.failed(`document search worker did not start: ${String((e as Error)?.message ?? e).slice(0, 200)}`)
      throw e
    }
    w.addEventListener('message', (e: MessageEvent<Reply>) => {
      if (e.data && 'warn' in e.data) return this.onError(String(e.data.warn).slice(0, 300))
      const entry = this.waiting.get(e.data?.id)
      if (!entry) return
      if ('value' in e.data) this.fails = 0
      entry.done(e.data)
    })
    // it died (an error it did not catch, or its thread ended): those waiting get nothing, and another one starts and
    // opens its connection now, so the next lookup finds it ready (not while left off after FAILS_MAX)
    const gone = (why: string) => {
      if (this.w !== w) return
      this.failed(why)
      this.stop()
      this.warm()
    }
    w.addEventListener('error', (e: ErrorEvent) => gone(`document search worker failed: ${String(e.message ?? e).slice(0, 200)}`))
    w.addEventListener('close', () => gone('document search worker ended'))
    // never keeps the process alive (Bun's Worker has unref; the DOM type does not say so)
    ;(w as Worker & { unref?: () => void }).unref?.()
    this.w = w
    // its connection opens now, before any request (id 0: no one waits for the answer); a request already late when it
    // arrives is dropped before the connection opens, so without this the lookups after a crash were lost one by one
    let meaning = this.meaningAsked
    try { meaning ||= !!this.o.meaning?.() } catch {}
    w.postMessage({ id: 0, op: 'open', dir: this.dir, due: null, ...(meaning ? { meaning } : {}) } satisfies Req)
    return w
  }

  /** the worker died or did not start: one log line; after FAILS_MAX in a row, left off for PAUSE_MS (the line says so) */
  private failed(why: string) {
    if (++this.fails < FAILS_MAX) return this.onError(why)
    this.pausedUntil = Date.now() + PAUSE_MS
    this.onError(`${why}; ${this.fails} failures in a row: searches run on the main thread for the next ${PAUSE_MS / 60_000} minutes`)
  }

  private stop() {
    const w = this.w
    this.w = null
    for (const x of [...this.waiting.values()]) x.done(null)
    try { w?.terminate() } catch {}
  }
}
