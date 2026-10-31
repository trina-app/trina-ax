// One whisper.cpp at a time on this server, voice input first (QA 2026-11-01 H3). Two runs of the small model at once
// do not fit the converter cgroup (system/cgroups.ts: memory.high 821 MiB on a 4 GB box, one run 750-880 MB with the
// model's pages) and share the same 2 vCPUs, so a 5-second dictation took 336 s instead of 45 s next to a video read's
// piece. A person waits at the mic; a video read can go on later. So:
// - a voice input job (local speech provider) marks itself at once, stops a video piece that is running (it yields:
//   whisper.cpp is killed, the read starts that piece again after, when its time allows) and runs alone;
// - a video piece does not start while a dictation waits or runs, and waits for one at most PIECE_WAIT_MS (a long
//   voice input job, an uploaded hour of recording, must not hold the read and the server's one media slot).
// The turn is taken in the same step that finds it free (never one await later), so a piece and a dictation that come
// in the same tick cannot both run. Voice input jobs are one at a time already (jobs/service.ts SINGLE 'transcribe')
// and video reads too (files/media.ts mediaSlot), so at most one of each waits here. OpenRouter uses no CPU here and
// takes no turn.

let dictations = 0
let dictating = false
let piece: AbortController | null = null
const waiters = new Set<() => void>()
const wake = () => { for (const w of [...waiters]) w() }

/** the longest a video piece waits for voice input before the read goes on without it */
export const PIECE_WAIT_MS = 45_000
let pieceWaitMs = PIECE_WAIT_MS
/** tests: a shorter wait (null: back to PIECE_WAIT_MS) */
export function setPieceWaitForTests(ms: number | null) { pieceWaitMs = ms ?? PIECE_WAIT_MS }
export const pieceWait = () => pieceWaitMs

/** Takes the turn with `take()` in the same step that sees `free()` (true), else false after `ms`; rejects with the
 * reason when `signal` fires. */
function acquire(free: () => boolean, take: () => void, signal: AbortSignal | undefined, ms: number): Promise<boolean> {
  signal?.throwIfAborted()
  if (free()) { take(); return Promise.resolve(true) }
  if (ms <= 0) return Promise.resolve(false)
  return new Promise<boolean>((resolve, reject) => {
    const done = () => { waiters.delete(check); clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
    const check = () => { if (free()) { take(); done(); resolve(true) } }
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
    await acquire(() => piece === null && !dictating, () => { dictating = true }, signal, Infinity)
    try { return await f() } finally { dictating = false; wake() }
  } finally { dictations--; wake() }
}

export type PieceTurn<T> = { ok: true; value: T } | { ok: false; why: 'busy' | 'yielded' }

/**
 * A video read's whisper.cpp piece: waits while voice input waits or runs (at most `waitMs`, then 'busy'), and `run`
 * gets a signal that fires when voice input comes meanwhile ('yielded' when `run` then fails, or before it starts:
 * start it again later). A run that finished keeps its answer. Stop (`signal`) throws.
 */
export async function pieceTurn<T>(run: (yieldSignal: AbortSignal) => Promise<T>, o: { signal?: AbortSignal; waitMs: number }): Promise<PieceTurn<T>> {
  const ac = new AbortController()
  if (!(await acquire(() => dictations === 0 && piece === null && !dictating, () => { piece = ac }, o.signal, o.waitMs))) return { ok: false, why: 'busy' }
  try {
    // voice input came between taking the turn and starting
    if (ac.signal.aborted) return { ok: false, why: 'yielded' }
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
