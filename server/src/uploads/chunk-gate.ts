// How many upload chunks the server reads at once, and when it says "later". Each chunk body is written straight to
// disk, but Bun keeps the request buffers until a garbage collection that does not count their size, so chunks read
// in parallel pile up: in the 2026-11-11 stress test three 200 MB uploads took the server from 0.19 GB to 3.1 GB on a
// 4 GB machine, and every other page waited 8-12 s. So: a few chunks at a time (the rest wait, their bodies unread),
// a collection after each chunk, and 503 unavailable with retryAfter while the process is still too big (the web
// client retries unavailable with back-off, web/src/lib/upload.ts).
import os from 'node:os'
import { HttpError } from '../http/errors'

export interface ChunkGateOptions {
  /** chunks read at the same time, whole server */
  max: number
  /** chunks waiting for a slot; one more is refused (503) instead of queued */
  queueMax: number
  /** process memory (RSS) above which a new chunk is refused after one forced collection */
  rssLimit: number
  rss?: () => number
  gc?: (force: boolean) => void
}

const defaultGc = (force: boolean) => { (globalThis as { Bun?: { gc(f: boolean): void } }).Bun?.gc(force) }

export class ChunkGate {
  private active = 0
  private waiting: Array<() => void> = []
  private rss: () => number
  private gc: (force: boolean) => void

  constructor(private o: ChunkGateOptions) {
    this.rss = o.rss ?? (() => process.memoryUsage.rss())
    this.gc = o.gc ?? defaultGc
  }

  /** Waits for a slot (or refuses); call the returned release once the chunk is written or failed. */
  async enter(): Promise<() => void> {
    if (this.rss() > this.o.rssLimit) {
      this.gc(true)
      if (this.rss() > this.o.rssLimit) throw new HttpError('unavailable', undefined, { retryAfter: 5, params: { reason: 'upload_memory' } })
    }
    if (this.active >= this.o.max) {
      if (this.waiting.length >= this.o.queueMax) throw new HttpError('unavailable', undefined, { retryAfter: 5, params: { reason: 'upload_busy' } })
      await new Promise<void>((resolve) => this.waiting.push(resolve))
    } else {
      this.active++
    }
    let done = false
    return () => {
      if (done) return
      done = true
      this.gc(false)
      const next = this.waiting.shift()
      if (next) next() // the slot passes on; active stays the same
      else this.active--
    }
  }

  stats() { return { active: this.active, waiting: this.waiting.length } }
}

/** 3 chunks (24 MB of bodies) at once; refuse above 35 % of the machine's memory, never below 768 MB. */
export function defaultChunkGate(): ChunkGate {
  return new ChunkGate({ max: 3, queueMax: 64, rssLimit: Math.max(768 * 1024 * 1024, Math.floor(os.totalmem() * 0.35)) })
}
