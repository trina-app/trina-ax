// The document index's searches off the server's main thread. A search in documents.db is synchronous SQLite work
// (tens to hundreds of milliseconds on a large index); on the main thread it held every request of every person for that
// long, and no deadline could fire before it ended. So the reads (search, related) run in one long-lived Bun Worker with
// its own connection (DocumentIndex.openReader: query_only, WAL), and the caller waits only until its deadline:
// - requests and replies carry an id; a reply nobody waits for any more is dropped
// - the caller's deadline (`due`, a Date.now() time) passes: the caller gets null at once; a request still queued in the
//   worker when its deadline has passed is dropped there without running
// - the worker starts when the index opens (warm: its first answer takes 0.1–0.5 s, more than a lookup's deadline),
//   starts again at the next read after it died, and ends with the index (close)
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

  constructor(readonly dir: string, private script: string, private onError: (err: string) => void = () => {}) {}

  /** the pieces that answer `query` (DocumentIndex.search); [] when not ready by `due` */
  async search(query: string, o: SearchOptions & { due?: number }): Promise<DocHit[]> {
    const { due, ...rest } = o
    const r = await this.ask({ op: 'search', query, o: rest }, due ?? null)
    return Array.isArray(r) ? r as DocHit[] : []
  }

  /** the documents related to one (DocumentIndex.related), with the team members' names for "people" links */
  async related(rootId: string, relPath: string, o: { rootIds: readonly string[]; limit?: number }, people: string[]): Promise<RelatedDoc[]> {
    const r = await this.ask({ op: 'related', rootId, relPath, o, people }, null)
    return Array.isArray(r) ? r as RelatedDoc[] : []
  }

  /** Start the worker and open its connection now, so the first search does not wait for them (about 0.1–0.5 s: a
   * lookup before the model starts has 200 ms). */
  warm() { void this.ask({ op: 'open' }, null).catch((e) => this.onError(String(e))) }

  /** the worker ends; anyone still waiting gets nothing */
  close() {
    this.closed = true
    this.stop()
  }

  /** tests: the worker runs now */
  get running() { return !!this.w }

  private ask(body: Record<string, unknown>, due: number | null): Promise<unknown> {
    if (this.closed) return Promise.resolve(null)
    if (due !== null && Date.now() >= due) return Promise.resolve(null)
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
      if (due !== null) entry.timer = setTimeout(() => entry.done(null), Math.max(0, due - Date.now()))
      this.waiting.set(id, entry)
      try { this.worker().postMessage({ id, dir: this.dir, due, ...body }) } catch (e) { entry.done({ id, error: String(e) }) }
    })
  }

  private worker(): Worker {
    if (this.w) return this.w
    const w = new Worker(this.script, { workerData: { kind: MARK, script: this.script } } as WorkerOptions)
    w.addEventListener('message', (e: MessageEvent<Reply>) => this.waiting.get(e.data?.id)?.done(e.data))
    // it died (an error it did not catch, or its thread ended): those waiting get nothing; the next read starts another
    const gone = (why: string) => {
      if (this.w !== w) return
      this.onError(why)
      this.stop()
    }
    w.addEventListener('error', (e: ErrorEvent) => gone(`document search worker failed: ${String(e.message ?? e).slice(0, 200)}`))
    w.addEventListener('close', () => gone('document search worker ended'))
    // never keeps the process alive (Bun's Worker has unref; the DOM type does not say so)
    ;(w as Worker & { unref?: () => void }).unref?.()
    this.w = w
    return w
  }

  private stop() {
    const w = this.w
    this.w = null
    for (const x of [...this.waiting.values()]) x.done(null)
    try { w?.terminate() } catch {}
  }
}
