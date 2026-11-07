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
//
// The worker is this file: built next to main.js as doc-search-worker.js in the bundles (scripts/build-bundle.ts and
// scripts/build-office.ts ENTRIES), run as TypeScript in a repository checkout.
import fs from 'node:fs'
import path from 'node:path'
import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { DocumentIndex, type DocHit, type RelatedDoc, type SearchOptions } from './index'

const MARK = 'mycel-doc-search'
/** a request without its own deadline gets nothing after this long */
export const DEFAULT_DEADLINE_MS = 5_000
/** failures in a row (the worker died, or would not start) after which it is left off for PAUSE_MS */
export const FAILS_MAX = 3
export const PAUSE_MS = 5 * 60_000

export type Req =
  | { id: number; op: 'open'; dir: string; due: number | null }
  | { id: number; op: 'search'; dir: string; due: number | null; query: string; o: SearchOptions }
  | { id: number; op: 'related'; dir: string; due: number | null; rootId: string; relPath: string; o: { rootIds: readonly string[]; limit?: number }; people: string[] }
export type Reply = { id: number; value: unknown } | { id: number; late: true } | { id: number; error: string }

// ---------------------------------------------------------------- the worker
/** what the worker reads with (DocumentIndex.openReader; tests: a stand-in) */
export interface DocReader {
  readonly dir: string
  search(query: string, o: SearchOptions): DocHit[]
  related(rootId: string, relPath: string, o: { rootIds: readonly string[]; limit?: number }): RelatedDoc[]
  close(): void
}

/** The worker's loop: one request at a time, in order; a request whose deadline has passed is answered "late" without
 * running. */
export function serveDocSearch(port: { on(ev: 'message', f: (m: Req) => void): unknown; postMessage(r: Reply): void }, open: (dir: string, people: () => readonly string[]) => DocReader) {
  let idx: DocReader | null = null
  let people: string[] = []
  port.on('message', (m: Req) => {
    let reply: Reply
    if (m.due !== null && Date.now() >= m.due) reply = { id: m.id, late: true }
    else {
      try {
        if (!idx || idx.dir !== m.dir) { idx?.close(); idx = open(m.dir, () => people) }
        if (m.op === 'open') reply = { id: m.id, value: true }
        else if (m.op === 'search') reply = { id: m.id, value: idx.search(m.query, m.o) }
        else { people = m.people; reply = { id: m.id, value: idx.related(m.rootId, m.relPath, m.o) } }
      } catch (e) {
        // a damaged or replaced database: opened again at the next request
        try { idx?.close() } catch {}
        idx = null
        reply = { id: m.id, error: String((e as Error)?.message ?? e).slice(0, 300) }
      }
    }
    port.postMessage(reply)
  })
}

// this file started as the worker (not imported by another worker script)
const started = workerData as { kind?: string; script?: string } | null
if (!isMainThread && parentPort && started?.kind === MARK && path.resolve(started.script ?? '') === path.resolve(import.meta.path)) {
  serveDocSearch(parentPort, (dir, people) => DocumentIndex.openReader(dir, { people }))
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

  constructor(readonly dir: string, private script: string, private onError: (err: string) => void = () => {}) {}

  /** the pieces that answer `query` (DocumentIndex.search); [] when not ready by `due` */
  async search(query: string, o: SearchOptions & { due?: number }): Promise<DocHit[]> {
    const { due, ...rest } = o
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
    w.postMessage({ id: 0, op: 'open', dir: this.dir, due: null } satisfies Req)
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
