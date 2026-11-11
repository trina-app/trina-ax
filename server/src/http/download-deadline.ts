// Deadlines for a long fetch() download (the speech model, an update bundle): the caller's cancel signal, an idle
// timer that starts again on every chunk received, and an overall deadline. A connection that stops sending without
// closing would otherwise hold its job (and the one transcription slot, or the system operations lock) forever.
// Untrusted URLs (the AI's web reads) go through tools/download.ts instead, which has its own timers.

/** No byte for this long: the connection is taken as stalled (generous: a slow link still sends something). */
export const DOWNLOAD_IDLE_MS = 120_000
/** The whole download may take 10 minutes plus the time it takes at 250 KB/s (about 2 Mbit/s): 488 MB → ~43 min. */
export const downloadTotalMs = (bytes: number) => 10 * 60_000 + Math.ceil(bytes / 250)

/** The abort reason when a download stopped for one of the deadlines (DownloadDeadline.stalled() returns it). */
export class DownloadStalled extends Error {
  name = 'DownloadStalled'
  constructor(readonly why: 'idle' | 'total') { super(why === 'idle' ? 'download stalled (no data received)' : 'download took too long') }
}

export interface DownloadDeadline {
  /** pass to fetch(): fires on the caller's cancel or either deadline */
  signal: AbortSignal
  /** call on every chunk received: restarts the idle timer */
  tick(): void
  /** call when the download ended (either way): clears the timers */
  done(): void
  /** why the deadline stopped the download, or null when it did not (the caller cancelled, or another error) */
  stalled(): DownloadStalled | null
}

/** Start the deadlines now (the idle timer also covers waiting for the response headers). */
export function downloadDeadline(o: { signal?: AbortSignal; idleMs: number; totalMs: number }): DownloadDeadline {
  const ac = new AbortController()
  let why: DownloadStalled | null = null
  const stop = (w: 'idle' | 'total') => { if (!ac.signal.aborted && !o.signal?.aborted) { why = new DownloadStalled(w); ac.abort(why) } }
  let idle = setTimeout(() => stop('idle'), o.idleMs)
  const total = setTimeout(() => stop('total'), o.totalMs)
  return {
    signal: o.signal ? AbortSignal.any([o.signal, ac.signal]) : ac.signal,
    tick() { if (why) return; clearTimeout(idle); idle = setTimeout(() => stop('idle'), o.idleMs) },
    done() { clearTimeout(idle); clearTimeout(total) },
    stalled: () => why,
  }
}
