// Meaning mode of the search quality test: the parts that use the wave 2 code, on the same paths the server uses
// (docs/AGENTS/plan/20261107-0819-knowledge-graph-fast-answers.md, steps 9–13):
// - the model: ensureModel() (meaning/embedder.ts) into the test's model folder, checked against the pinned hashes
// - the vectors: the server's background indexing loop, MeaningIndexer (meaning/indexer.ts), with its embedding
//   process (startEmbedChild, embed-worker.ts: passageText of file name, heading and text; quantize), reading
//   DocumentIndex.pendingVectors and writing DocumentIndex.writeVectors. Only the pace differs: more ONNX threads and
//   bigger batches than the server's one thread and batches of 4, so the test finishes in minutes, not hours
// - the search: the real search worker (DocSearchWorker with documents/search-worker.ts), which embeds the question
//   in its own thread (meaningModelDirs: <index dir>/../../models, no download) and fuses by rank; a search asks
//   `meaning: true` exactly as service.ts docPassages does when the switch is on
import fs from 'node:fs'
import path from 'node:path'
import type { DocHit, DocumentIndex, SearchOptions } from '../../../server/src/knowledge-graph/documents/index'
import { DocSearchWorker, docSearchWorkerScript } from '../../../server/src/knowledge-graph/documents/search-worker'
import { ensureModel, modelFilesOk } from '../../../server/src/knowledge-graph/meaning/embedder'
import { embedWorkerScript, MeaningIndexer, processMemoryMiB, startEmbedChild, type EmbedChild } from '../../../server/src/knowledge-graph/meaning/indexer'
import type { EmbedWorkerConfig, WorkerMessage } from '../../../server/src/knowledge-graph/meaning/embed-worker'
import { MEANING_DIMS } from '../../../server/src/knowledge-graph/meaning/vectors'

/** the folders of one test index, laid out like a server's data folder: <base>/knowledge-graph/documents (the index)
 * and <base>/models (where the search worker looks for the model, meaningModelDirs) */
export const indexDirOf = (base: string) => path.join(base, 'knowledge-graph', 'documents')

/** the model in `modelDir` (downloaded and checked when missing, unless download is false); throws when it cannot */
export async function readyModel(modelDir: string, download: boolean): Promise<{ downloadedMs: number }> {
  const t = performance.now()
  if (await modelFilesOk(modelDir)) return { downloadedMs: 0 }
  if (!download) throw new Error(`the model files are missing in ${modelDir} (and --no-download)`)
  await ensureModel(modelDir)
  return { downloadedMs: Math.round(performance.now() - t) }
}

/** <base>/models pointing at the model folder (the search worker resolves the model there) */
export function linkModels(base: string, modelDir: string) {
  const link = path.join(base, 'models')
  fs.rmSync(link, { recursive: true, force: true })
  fs.symlinkSync(path.resolve(modelDir), link, 'dir')
}

export interface EmbedResult { pieces: number; ms: number; perSecond: number; threads: number; batch: number; peakMiB: number; loadPeakMiB: number; logs: string[] }

/**
 * Every piece without a vector gets one, through the server's own indexing loop and embedding process (see the top).
 * `maxRssMiB`: the loop's memory limit for the process (the server's 800 MB is for one thread and batches of 4).
 */
export async function embedAll(idx: DocumentIndex, o: { modelDir: string; threads: number; batch: number; maxRssMiB: number; background: boolean; onProgress?: (done: number, pending: number) => void }): Promise<EmbedResult> {
  if (!embedWorkerScript()) throw new Error('meaning/embed-worker.ts is missing')
  const logs: string[] = []
  const log = { info: (m: string, x?: Record<string, unknown>) => { logs.push(`${m} ${x ? JSON.stringify(x) : ''}`.trim()) }, warn: (m: string, x?: Record<string, unknown>) => { logs.push(`WARN ${m} ${x ? JSON.stringify(x) : ''}`.trim()) } }
  const before = idx.vectorCounts()
  const ix = new MeaningIndexer({
    store: () => idx,
    on: () => true,
    peopleWaiting: () => false,
    log,
    startChild: () => (o.background ? startEmbedChild : startNormalChild)({ modelDir: o.modelDir, sharedDir: null, threads: o.threads, download: false }),
    batch: o.batch,
    maxRssMiB: o.maxRssMiB,
  })
  const t = performance.now()
  const timer = setInterval(() => { const c = idx.vectorCounts(); o.onProgress?.(c.done, c.pending) }, 30_000)
  try {
    ix.kick()
    await ix.whenIdle()
  } finally {
    clearInterval(timer)
    ix.close()
  }
  const ms = performance.now() - t
  const after = idx.vectorCounts()
  const pieces = after.done - before.done
  if (after.pending) throw new Error(`${after.pending} pieces still have no vector: ${logs.slice(-3).join(' | ')}`)
  return { pieces, ms: Math.round(ms), perSecond: Math.round((pieces / (ms / 1000)) * 10) / 10, threads: o.threads, batch: o.batch, peakMiB: ix.peak(), loadPeakMiB: ix.loadPeak(), logs }
}

/** The search worker of one index, as the server opens it (service.ts openDocumentIndex), meaning on from the start
 * when asked (it then loads the vectors and the query's model as soon as it starts). */
export function openWorker(dir: string, meaning: boolean, warnings: string[]): DocSearchWorker {
  const script = docSearchWorkerScript()
  if (!script) throw new Error('documents/search-worker.ts is missing')
  const w = new DocSearchWorker(dir, script, (err) => warnings.push(err), { meaning: () => meaning })
  w.warm()
  return w
}

/** One search in the worker: keyword-only, or combined (`meaning: true`); `dueMs` far enough that the deadline, which
 * is about chat latency, never cuts the meaning part */
export function workerSearch(w: DocSearchWorker, text: string, o: SearchOptions, meaning: boolean, dueMs: number): Promise<DocHit[]> {
  return w.search(text, { ...o, ...(meaning ? { meaning: true } : {}), due: Date.now() + dueMs })
}

/**
 * The embedding process (embed-worker.ts, the same script and protocol as startEmbedChild) at normal priority.
 * startEmbedChild puts it below people's work (macOS: taskpolicy -c utility), which on an M-series Mac keeps it to the
 * efficiency cores: 3.4 pieces/s with 6 threads, about 1.2 CPUs. That is the server's pace by design; the test only
 * wants the vectors, so by default it starts the same process without the priority prefix (--embed-priority
 * background: the server's way).
 */
export function startNormalChild(cfg: EmbedWorkerConfig): EmbedChild {
  const script = embedWorkerScript()!
  const p = Bun.spawn([process.execPath, '--smol', '--no-env-file', script, JSON.stringify(cfg)], {
    cwd: path.dirname(script), env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NO_COLOR: '1' }, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore',
  })
  let ended: string | null = null, seq = 0
  const waiting = new Map<number, { ok: (v: Uint8Array[]) => void; fail: (e: Error) => void }>()
  let readyOk!: () => void, readyFail!: (e: Error) => void
  const ready = new Promise<void>((ok, fail) => { readyOk = ok; readyFail = fail })
  ready.catch(() => {})
  const end = (why: string) => { if (ended) return; ended = why; readyFail(new Error(why)); for (const w of waiting.values()) w.fail(new Error(why)); waiting.clear() }
  const onMessage = (m: WorkerMessage) => {
    if ('ready' in m) return readyOk()
    if (!('id' in m)) return end(`the embedding process could not start: ${String(m.error).slice(0, 300)}`)
    const w = waiting.get(m.id)
    if (!w) return
    waiting.delete(m.id)
    if ('error' in m) return w.fail(new Error(String(m.error)))
    const vecs = m.vecs.map((b) => new Uint8Array(Buffer.from(String(b), 'base64')))
    if (vecs.some((v) => v.byteLength !== MEANING_DIMS)) return w.fail(new Error('vectors of another size'))
    w.ok(vecs)
  }
  void (async () => {
    const dec = new TextDecoder()
    let buf = ''
    try {
      for await (const chunk of p.stdout) {
        buf += dec.decode(chunk, { stream: true })
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { onMessage(JSON.parse(line) as WorkerMessage) } catch {} }
      }
    } catch {}
  })()
  void p.exited.then((code) => end(`the embedding process ended (exit ${code})`))
  return {
    ready,
    embed(passages) {
      if (ended) return Promise.reject(new Error(ended))
      const id = ++seq
      return new Promise<Uint8Array[]>((ok, fail) => { waiting.set(id, { ok, fail }); p.stdin.write(JSON.stringify({ id, texts: passages }) + '\n'); p.stdin.flush() })
    },
    async rssMiB() { return ended ? 0 : processMemoryMiB(p.pid) },
    stop(now = false) {
      if (now) { end('stopped'); try { p.kill('SIGKILL') } catch {} ; return }
      try { p.stdin.end() } catch {}
      const t = setTimeout(() => { try { p.kill('SIGKILL') } catch {} }, 5_000)
      void p.exited.then(() => clearTimeout(t))
    },
  }
}
