// One whisper.cpp at a time on this server, voice input first (QA 2026-11-01 H3). Two runs of the small model at once
// do not fit the converter cgroup (system/cgroups.ts: memory.high 821 MiB on a 4 GB box, one run 750-880 MB with the
// model's pages) and share the same 2 vCPUs, so a 5-second dictation took 336 s instead of 45 s next to a video read's
// piece. A person waits at the mic; a video read can go on later. So:
// - a voice input job (local speech provider) marks itself at once, stops a video piece that is running (it yields:
//   whisper.cpp is killed, the read starts that piece again after, when its time allows) and runs alone;
// - a video piece does not start while a dictation waits or runs.
// Voice input jobs are one at a time already (jobs/service.ts SINGLE 'transcribe') and video reads too (files/media.ts
// mediaSlot), so at most one of each waits here. OpenRouter uses no CPU here and takes no turn.

let dictations = 0
let dictating = false
let piece: AbortController | null = null
const waiters = new Set<() => void>()
const wake = () => { for (const w of [...waiters]) w() }

/** Resolves true once `ready()` holds, false after `ms`; rejects with the reason when `signal` fires. */
function until(ready: () => boolean, signal: AbortSignal | undefined, ms: number): Promise<boolean> {
  signal?.throwIfAborted()
  if (ready()) return Promise.resolve(true)
  if (ms <= 0) return Promise.resolve(false)
  return new Promise<boolean>((resolve, reject) => {
    const done = () => { waiters.delete(check); clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
    const check = () => { if (ready()) { done(); resolve(true) } }
    const onAbort = () => { done(); reject(signal!.reason) }
    const timer = setTimeout(() => { done(); resolve(false) }, Math.min(ms, 2 ** 31 - 1))
    waiters.add(check)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Voice input on this server: `f` runs once no video piece runs (one that does is stopped first). */
export async function dictationTurn<T>(f: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  dictations++
  try {
    piece?.abort(new Error('voice input goes first'))
    await until(() => piece === null && !dictating, signal, Infinity)
    dictating = true
    try { return await f() } finally { dictating = false; wake() }
  } finally { dictations--; wake() }
}

export type PieceTurn<T> = { ok: true; value: T } | { ok: false; why: 'busy' | 'yielded' }

/**
 * A video read's whisper.cpp piece: waits while voice input waits or runs (at most `waitMs`, then 'busy'), and `run`
 * gets a signal that fires when voice input comes meanwhile ('yielded' when `run` then fails: start it again later).
 * Stop (`signal`) throws.
 */
export async function pieceTurn<T>(run: (yieldSignal: AbortSignal) => Promise<T>, o: { signal?: AbortSignal; waitMs: number }): Promise<PieceTurn<T>> {
  if (!(await until(() => dictations === 0 && piece === null, o.signal, o.waitMs))) return { ok: false, why: 'busy' }
  const ac = new AbortController()
  piece = ac
  try {
    // a run that finished just as voice input came keeps its answer
    return { ok: true, value: await run(ac.signal) }
  } catch (e) {
    if (ac.signal.aborted && !o.signal?.aborted) return { ok: false, why: 'yielded' }
    throw e
  } finally {
    if (piece === ac) piece = null
    wake()
  }
}

/** voice input waiting or running, and whether a video piece runs (tests, diagnostics) */
export const whisperTurns = () => ({ dictations, dictating, piece: piece !== null })
