// Search by meaning, the indexing (docs/AGENTS/plan/20261107-0819-knowledge-graph-fast-answers.md, wave 2, step 13):
// the pieces of the document index that have no vector yet get one, in the background, without getting in people's way.
//
// - One process (embed-worker.ts), below people's work like the converters (tools/isolate.ts backgroundPrefix:
//   `taskpolicy -c utility` on macOS, `nice -n 10` and `ionice -c 2 -n 7` on Linux), with one ONNX thread, sent
//   batches of BATCH pieces. It only embeds: this side reads the pieces and writes the vectors (DocumentIndex
//   writeVectors), so documents.db keeps one writer.
// - It starts when there is something to embed (and the switch is on: KnowledgeGraph.meaningOn) and ends after IDLE_MS
//   with nothing to do.
// - Memory: it starts only with MIN_FREE_MIB available (freeMemoryMiB); otherwise one log line, and nothing more until
//   the service's nightly check (kick with `retry`). Its own memory (processMemoryMiB) is looked at every MEM_POLL_MS;
//   once the model is loaded it is stopped above MAX_RSS_MIB and the batch is done again by a new one. After
//   RESTARTS_MAX stops in a row it waits for the nightly check too. Loading peaks higher for a moment (the
//   tokenizer's vocabulary is parsed and the model file read into memory, then dropped): stopping it there would only
//   load it again. Measured on an M-series Mac with the real model, one thread, batches of 4 pieces of up to 512
//   tokens: about 0.6 GB while it works, up to 0.7 GB for a moment while it loads; 3 pieces a second of full-size
//   pieces at utility priority on a busy Mac.
// - Someone waiting for an answer (a running or queued chat turn): it pauses between batches, and ends after IDLE_MS of
//   pause, so the memory goes back to people's work.
// - Progress goes to the log only: no screen, no admin field (the owner's rule: admins see nothing about it).
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { dlopen, FFIType, ptr } from 'bun:ffi'
import { availableMemoryMiB } from '../../system/limits'
import { backgroundPrefix } from '../../tools/isolate'
import type { PendingPiece, PieceVector } from '../docs-port'
import { MEANING_DIMS, passageText } from './vectors'
import type { EmbedWorkerConfig, WorkerMessage } from './embed-worker'

/** pieces per batch (the plan's measurement: batches of 4 kept the old index at about 0.8 GB) */
export const BATCH = 4
/** pieces read from the index at a time */
const PAGE = 64
/** memory that must be available before the process starts (about 1.5 GB) */
export const MIN_FREE_MIB = 1536
/** the process is stopped above this much memory of its own (about 800 MB; processMemoryMiB) */
export const MAX_RSS_MIB = 800
/** the process ends after this long with nothing to do, or this long paused */
export const IDLE_MS = 60_000
/** how often a pause looks again whether people's work is done */
const PAUSE_POLL_MS = 2_000
/** how often the process's memory is looked at */
const MEM_POLL_MS = 2_000
/** stops in a row (memory, a crash, a failed batch) with no batch done in between, after which it waits for the
 * nightly check */
export const RESTARTS_MAX = 3
/** a progress line at most this often */
const PROGRESS_MS = 5 * 60_000
const MIB = 1024 * 1024

/** what the indexer asks of the document index (DocIndexPort's vector methods) */
export interface VectorStore {
  pendingVectors?(limit: number): PendingPiece[]
  writeVectors?(rows: readonly PieceVector[]): number
  vectorCounts?(): { done: number; pending: number }
}

/** The embedding process as the indexer sees it (startEmbedChild; tests: a stand-in). */
export interface EmbedChild {
  /** resolves once the model is loaded; rejects with the reason it could not be */
  readonly ready: Promise<void>
  /** int8 vectors (MEANING_DIMS bytes each) of passage texts, in order; rejects when the process failed, ended or
   * was stopped */
  embed(passages: string[]): Promise<Uint8Array[]>
  /** its own memory now, in MiB (processMemoryMiB; 0: not known) */
  rssMiB(): Promise<number>
  /** end it (`now`: killed at once, its batch failing) */
  stop(now?: boolean): void
}

export interface MeaningIndexerOptions {
  /** the document index; null: gone (the documents part went off) */
  store: () => VectorStore | null
  /** search by meaning is on now */
  on: () => boolean
  /** someone is waiting for an answer: a pause between batches */
  peopleWaiting: () => boolean
  log: { info(msg: string, x?: Record<string, unknown>): void; warn(msg: string, x?: Record<string, unknown>): void }
  /** starts the embedding process */
  startChild: () => EmbedChild
  /** memory available now, in MiB; null: not known (then it starts) */
  freeMemoryMiB?: () => number | null
  batch?: number
  minFreeMiB?: number
  maxRssMiB?: number
  idleMs?: number
  pausePollMs?: number
  memPollMs?: number
  restartsMax?: number
}

const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); (t as { unref?: () => void }).unref?.() })
const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200)

/**
 * Memory that can be used now without pushing other work out, in MiB; null where it is not known.
 * - Linux: MemAvailable of /proc/meminfo (system/limits.ts availableMemoryMiB, which counts the cache the kernel takes
 *   back).
 * - macOS has no MemAvailable, and os.freemem() counts only the free pages: a few hundred MB on a busy Mac that has
 *   gigabytes to give. The estimate is the kernel's own "memory free" percentage, kern.memorystatus_level (what
 *   `memory_pressure` prints as "System-wide memory free percentage" and what the kernel acts on under memory
 *   pressure; it counts the file cache and memory the kernel can take back), times the physical memory.
 */
export function freeMemoryMiB(): number | null {
  const known = availableMemoryMiB()
  if (known !== null || process.platform !== 'darwin') return known
  try {
    const r = Bun.spawnSync(['/usr/sbin/sysctl', '-n', 'kern.memorystatus_level'], { stdout: 'pipe', stderr: 'ignore' })
    const pct = Number(r.stdout.toString().trim())
    if (r.exitCode === 0 && Number.isFinite(pct) && pct > 0 && pct <= 100) return Math.floor((os.totalmem() / MIB) * pct / 100)
  } catch { /* not known */ }
  return null
}

let footprint: ((pid: number) => number) | null | undefined
/**
 * A process's own memory in MiB (0: not known), without the unchanged pages of the program and libraries it maps,
 * which other processes share and the system can drop at any time:
 * - Linux: RssAnon plus VmSwap of /proc/<pid>/status.
 * - macOS: its physical footprint (proc_pid_rusage), the memory Activity Monitor shows for it. ps's resident size also
 *   counts the mapped files of bun and onnxruntime: about 250 MB more for the embedding process (measured: 610 MB
 *   footprint, 893 MB resident).
 */
export function processMemoryMiB(pid: number): number {
  if (process.platform === 'linux') {
    try {
      const st = fs.readFileSync(`/proc/${pid}/status`, 'utf8')
      const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm').exec(st)?.[1] ?? 0)
      return Math.round((kb('RssAnon') + kb('VmSwap')) / 1024)
    } catch { return 0 }
  }
  if (process.platform !== 'darwin') return 0
  if (footprint === undefined) {
    try {
      const lib = dlopen('/usr/lib/libSystem.B.dylib', { proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 } })
      // struct rusage_info_v2 (RUSAGE_INFO_V2 = 2): a 16-byte uuid, then 64-bit counters; ri_phys_footprint is the 8th
      const buf = new BigUint64Array(64)
      footprint = (q) => (lib.symbols.proc_pid_rusage(q, 2, ptr(buf)) === 0 ? Math.round(Number(buf[9]) / MIB) : 0)
    } catch { footprint = null }
  }
  return footprint?.(pid) ?? 0
}

/** The embedding process's script: built next to the server's main.js in the bundles, embed-worker.ts in a checkout;
 * null: neither. */
export function embedWorkerScript(): string | null {
  const built = path.join(import.meta.dir, 'kg-embed-worker.js')
  if (fs.existsSync(built)) return built
  const src = path.join(import.meta.dir, 'embed-worker.ts')
  return fs.existsSync(src) ? src : null
}

/** the environment variables the embedding process gets: no secrets of the server's, only what it needs to run and to
 * download the model (a proxy, when the server goes through one) */
const CHILD_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']

/**
 * Start the embedding process (embed-worker.ts) below people's work, with the settings as one argument and a short
 * environment. The model is checked (and downloaded when missing) inside it, off the server's main thread.
 */
export function startEmbedChild(cfg: EmbedWorkerConfig, script: string | null = embedWorkerScript()): EmbedChild {
  if (!script) {
    const ready = Promise.reject(new Error('the embedding process script is missing next to the server files'))
    ready.catch(() => {})
    return { ready, embed: () => Promise.reject(new Error('not started')), rssMiB: async () => 0, stop() {} }
  }
  const env: Record<string, string> = { BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', NO_COLOR: '1' }
  for (const k of CHILD_ENV) if (process.env[k]) env[k] = process.env[k]!
  const p = Bun.spawn([...backgroundPrefix(), process.execPath, '--smol', '--no-env-file', script, JSON.stringify(cfg)], {
    cwd: path.dirname(script), env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  })
  let ended: string | null = null
  let seq = 0
  const waiting = new Map<number, { ok: (v: Uint8Array[]) => void; fail: (e: Error) => void }>()
  let readyOk!: () => void, readyFail!: (e: Error) => void
  const ready = new Promise<void>((ok, fail) => { readyOk = ok; readyFail = fail })
  ready.catch(() => {})
  let stderrTail = ''
  const end = (why: string) => {
    if (ended) return
    ended = why
    readyFail(new Error(why))
    for (const w of waiting.values()) w.fail(new Error(why))
    waiting.clear()
  }
  const onMessage = (m: WorkerMessage) => {
    if ('ready' in m) return readyOk()
    if (!('id' in m)) return end(`the embedding process could not start: ${String(m.error).slice(0, 300)}`)
    const w = waiting.get(m.id)
    if (!w) return
    waiting.delete(m.id)
    if ('error' in m) return w.fail(new Error(String(m.error).slice(0, 300)))
    const vecs = (Array.isArray(m.vecs) ? m.vecs : []).map((b) => new Uint8Array(Buffer.from(String(b), 'base64')))
    if (vecs.some((v) => v.byteLength !== MEANING_DIMS)) return w.fail(new Error('the embedding process gave vectors of another size'))
    w.ok(vecs)
  }
  void (async () => {
    const dec = new TextDecoder()
    let buf = ''
    try {
      for await (const chunk of p.stdout) {
        buf += dec.decode(chunk, { stream: true })
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          try { onMessage(JSON.parse(line) as WorkerMessage) } catch { /* not a protocol line */ }
        }
        if (buf.length > 4 * MIB) buf = ''
      }
    } catch { /* ended */ }
  })()
  void (async () => {
    const dec = new TextDecoder()
    try { for await (const chunk of p.stderr) stderrTail = (stderrTail + dec.decode(chunk, { stream: true })).slice(-2000) } catch { /* ended */ }
  })()
  void p.exited.then((code) => end(`the embedding process ended (${code === null ? 'killed' : 'exit ' + code}${stderrTail.trim() ? ': ' + stderrTail.trim().split('\n').pop()!.slice(0, 200) : ''})`))
  return {
    ready,
    embed(passages) {
      if (ended) return Promise.reject(new Error(ended))
      const id = ++seq
      return new Promise<Uint8Array[]>((ok, fail) => {
        waiting.set(id, { ok, fail })
        try { p.stdin.write(JSON.stringify({ id, texts: passages }) + '\n'); p.stdin.flush() } catch (e) { waiting.delete(id); fail(new Error(errText(e))) }
      })
    },
    async rssMiB() { return ended ? 0 : processMemoryMiB(p.pid) },
    stop(now = false) {
      if (now) { end('the embedding process was stopped'); try { p.kill('SIGKILL') } catch {} ; return }
      try { p.stdin.end() } catch {}
      const t = setTimeout(() => { try { p.kill('SIGKILL') } catch {} }, 5_000)
      ;(t as { unref?: () => void }).unref?.()
      void p.exited.then(() => clearTimeout(t))
    },
  }
}

/** The background indexing of search by meaning for one document index (see the top of this file). */
export class MeaningIndexer {
  private o: Required<Omit<MeaningIndexerOptions, 'freeMemoryMiB'>> & { freeMemoryMiB: () => number | null }
  private running: Promise<void> | null = null
  private again = false
  /** set after a refusal (memory, the model, too many stops): nothing until a kick with `retry` (the nightly check) */
  private waitRetry = false
  private closed = false
  private child: EmbedChild | null = null
  private idle: ReturnType<typeof setTimeout> | null = null
  private memTimer: ReturnType<typeof setInterval> | null = null
  private memBusy = false
  /** the most memory of its own an embedding process had since the start: while it worked, and while it loaded */
  private peakMiB = 0
  private loadPeakMiB = 0
  private idleWaiters: (() => void)[] = []

  constructor(o: MeaningIndexerOptions) {
    this.o = {
      batch: BATCH, minFreeMiB: MIN_FREE_MIB, maxRssMiB: MAX_RSS_MIB, idleMs: IDLE_MS, pausePollMs: PAUSE_POLL_MS, memPollMs: MEM_POLL_MS, restartsMax: RESTARTS_MAX,
      ...o, freeMemoryMiB: o.freeMemoryMiB ?? freeMemoryMiB,
    }
  }

  /** There may be pieces to embed (documents indexed, or the nightly check: `retry` also ends a wait after a
   * refusal). Starts a run unless one goes on (then it looks again after it). */
  kick(x: { retry?: boolean } = {}) {
    if (x.retry) this.waitRetry = false
    if (this.closed || this.waitRetry || !this.o.on()) return
    if (this.running) { this.again = true; return }
    this.running = this.run().catch((e) => this.o.log.warn('knowledge graph: search by meaning stopped', { err: errText(e) })).finally(() => {
      this.running = null
      if (this.again && !this.closed) { this.again = false; this.kick() }
      if (!this.running) for (const f of this.idleWaiters.splice(0)) f()
    })
  }

  /** the most memory of its own the embedding process had so far, in MiB: while it worked, and while it loaded */
  peak(): number { return this.peakMiB }
  loadPeak(): number { return this.loadPeakMiB }

  /** tests: resolves when no run goes on */
  whenIdle(): Promise<void> {
    if (!this.running) return Promise.resolve()
    return new Promise((r) => this.idleWaiters.push(r))
  }

  /** the indexing ends for good (the server stops, or the documents part went off) */
  close() {
    if (this.closed) return
    this.closed = true
    this.stopChild(true)
    if (!this.running) for (const f of this.idleWaiters.splice(0)) f()
  }

  private async run() {
    let store = this.o.store()
    if (!store?.pendingVectors || !store.writeVectors) return
    let page = store.pendingVectors(PAGE)
    if (!page.length) return
    if (this.idle) { clearTimeout(this.idle); this.idle = null }
    const t0 = Date.now()
    const counts = store.vectorCounts?.()
    if (counts && counts.pending > 100) this.o.log.info('knowledge graph: search by meaning: indexing', { pending: counts.pending, done: counts.done })
    let done = 0, restarts = 0, inARow = 0, lastLog = t0, pausedAt = 0
    try {
      while (!this.closed) {
        store = this.o.on() ? this.o.store() : null
        if (!store?.pendingVectors || !store.writeVectors) break
        // people first: wait between batches while someone waits for an answer; end the process if that goes on
        if (this.o.peopleWaiting()) {
          pausedAt ||= Date.now()
          if (this.child && Date.now() - pausedAt >= this.o.idleMs) this.stopChild(false)
          await sleep(this.o.pausePollMs)
          continue
        }
        pausedAt = 0
        if (!page.length) { page = store.pendingVectors(PAGE); if (!page.length) break }
        const child = this.child ?? await this.startChild()
        if (!child) return
        const batch = page.splice(0, this.o.batch)
        const passages = batch.map((p) => passageText(p.name, p.heading, p.text))
        let vecs: Uint8Array[]
        try { vecs = await child.embed(passages) } catch (e) {
          if (this.closed) return
          // it ended, was stopped above the memory limit, or failed the batch: a new process does the batch again
          this.stopChild(true)
          page.unshift(...batch)
          restarts++
          if (++inARow >= this.o.restartsMax) {
            this.o.log.warn('knowledge graph: search by meaning paused until the nightly check', { err: errText(e), restarts })
            this.waitRetry = true
            return
          }
          continue
        }
        if (this.closed) return
        inARow = 0
        done += store.writeVectors(batch.map((p, i) => ({ id: p.id, passage: passages[i]!, vec: vecs[i]! })))
        if (Date.now() - lastLog >= PROGRESS_MS) {
          lastLog = Date.now()
          this.o.log.info('knowledge graph: search by meaning: progress', { done, pending: store.vectorCounts?.().pending, perSecond: rate(done, t0) })
        }
      }
    } finally {
      if (done) this.o.log.info('knowledge graph: search by meaning: indexed', { pieces: done, seconds: Math.round((Date.now() - t0) / 1000), perSecond: rate(done, t0), peakMiB: this.peakMiB, loadPeakMiB: this.loadPeakMiB, restarts })
      // the process stays a while for the next upload, then ends
      if (this.child && !this.closed) {
        this.idle = setTimeout(() => { this.idle = null; if (!this.running) this.stopChild(false) }, this.o.idleMs)
        ;(this.idle as { unref?: () => void }).unref?.()
      }
    }
  }

  /** a new process, when there is memory for it; null (and one log line) when not */
  private async startChild(): Promise<EmbedChild | null> {
    const free = this.o.freeMemoryMiB()
    if (free !== null && free < this.o.minFreeMiB) {
      this.o.log.info('knowledge graph: search by meaning waits for the nightly check: not enough free memory', { freeMiB: free, needMiB: this.o.minFreeMiB })
      this.waitRetry = true
      return null
    }
    let c: EmbedChild
    try { c = this.o.startChild() } catch (e) {
      this.o.log.warn('knowledge graph: search by meaning could not start; trying again at the nightly check', { err: errText(e) })
      this.waitRetry = true
      return null
    }
    this.child = c
    const loaded = { yes: false }
    this.watchMemory(c, loaded)
    try { await c.ready; loaded.yes = true } catch (e) {
      if (this.child === c) this.stopChild(true)
      if (!this.closed) {
        // no internet for the first download, a model file that does not match, no runtime for this machine
        this.o.log.warn('knowledge graph: search by meaning could not load its model; trying again at the nightly check', { err: errText(e) })
        this.waitRetry = true
      }
      return null
    }
    return this.closed ? null : c
  }

  private watchMemory(c: EmbedChild, loaded: { yes: boolean }) {
    if (this.memTimer) clearInterval(this.memTimer)
    this.memTimer = setInterval(() => {
      if (this.memBusy || this.child !== c) return
      this.memBusy = true
      void c.rssMiB().then((mib) => {
        if (this.child !== c) return
        if (!loaded.yes) { if (mib > this.loadPeakMiB) this.loadPeakMiB = mib; return }
        if (mib > this.peakMiB) this.peakMiB = mib
        if (mib > this.o.maxRssMiB) {
          this.o.log.info('knowledge graph: search by meaning: the embedding process went above its memory limit and is started again', { rssMiB: mib, limitMiB: this.o.maxRssMiB })
          // its batch fails and the run starts a new process for it (RESTARTS_MAX)
          if (this.memTimer) { clearInterval(this.memTimer); this.memTimer = null }
          c.stop(true)
        }
      }).catch(() => {}).finally(() => { this.memBusy = false })
    }, this.o.memPollMs)
    ;(this.memTimer as { unref?: () => void }).unref?.()
  }

  private stopChild(now: boolean) {
    if (this.idle) { clearTimeout(this.idle); this.idle = null }
    if (this.memTimer) { clearInterval(this.memTimer); this.memTimer = null }
    const c = this.child
    this.child = null
    try { c?.stop(now) } catch { /* gone */ }
  }
}

const rate = (n: number, t0: number) => Math.round((n / Math.max(0.001, (Date.now() - t0) / 1000)) * 10) / 10
