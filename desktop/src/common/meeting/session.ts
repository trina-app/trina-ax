// Meeting notes (docs/AGENTS/plan/20261116-1903-live-meeting-notes.md), the desktop app's part without Electron:
// - readFrames: the capture helper's stdout (desktop/native/meeting-audio) as tracks of 16 kHz mono samples;
// - MeetingSession: frames → pieces at pauses (chunker.ts) → the team server (POST /api/meetings/piece) → lines on
//   meeting time. A piece the server says to send again (reason in MEETING_RETRY_REASONS) waits its Retry-After; any
//   other refusal ends the meeting with the server's sentence. Pieces go out in the order they were cut, at most two at
//   once, so lines may arrive out of order (all() sorts them).
// The sound is never written anywhere: a piece lives in memory until its answer.
import { MEETING_RETRY_REASONS } from '@mycel/shared/api'
import { chunker, pieceWav, RATE, type Chunker, type Piece, type Track } from './chunker'

/** One frame of the helper: 'M' (microphone) or 'O' (others: the call apps' sound), a uint32 LE sample count, then
 * that many float32 LE samples at 16 kHz mono. */
export const FRAME_ME = 0x4d
export const FRAME_OTHERS = 0x4f
/** a frame of more than 10 s is not the helper's (it sends ~20 ms frames): the stream is broken */
export const FRAME_MAX_SAMPLES = 10 * RATE

export interface Frame { track: Track; samples: Float32Array }

/** Splits the helper's byte stream into frames; bytes of an unfinished frame wait for the next chunk. Throws on a
 * byte that is not a frame's start. */
export class FrameReader {
  private buf = Buffer.alloc(0)
  push(chunk: Uint8Array): Frame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk)
    const out: Frame[] = []
    let at = 0
    while (this.buf.length - at >= 5) {
      const kind = this.buf[at]!
      if (kind !== FRAME_ME && kind !== FRAME_OTHERS) throw new Error('meeting audio: not a frame')
      const n = this.buf.readUInt32LE(at + 1)
      if (n > FRAME_MAX_SAMPLES) throw new Error('meeting audio: frame too large')
      if (this.buf.length - at - 5 < n * 4) break
      const samples = new Float32Array(n)
      for (let i = 0; i < n; i++) samples[i] = this.buf.readFloatLE(at + 5 + i * 4)
      out.push({ track: kind === FRAME_ME ? 'me' : 'others', samples })
      at += 5 + n * 4
    }
    this.buf = this.buf.subarray(at)
    return out
  }
}

export interface MeetingLine { track: Track; startMs: number; endMs: number; text: string }

/** What the team server answered for one piece. */
export type PieceAnswer =
  | { ok: true; lines: { start: number; end: number; text: string }[] }
  | { ok: false; status: number; reason?: string; retryAfterSec?: number; message: string }

export interface SessionDeps {
  /** POST /api/meetings/piece with the WAV */
  send(wav: Uint8Array): Promise<PieceAnswer>
  onLines(lines: MeetingLine[]): void
  /** the meeting cannot go on (voice input off, too slow, …): the server's sentence */
  onStop(message: string): void
  /** pieces waiting for an answer or a retry (the page says "words are coming in late" when this grows) */
  onBacklog?(waiting: number): void
  sleep?(ms: number): Promise<void>
  /** the clock (tests) */
  now?(): number
}

/** at most this many pieces wait for the server; beyond it the oldest is dropped (about 5 minutes of speech) */
export const MEETING_BACKLOG_MAX = 40
/** after Stop, the pieces still waiting get this long for their answers; then the meeting ends without them */
export const MEETING_FINISH_MS = 60_000
const SEND_AT_ONCE = 2

export class MeetingSession {
  private readonly cut: Chunker
  private readonly at: Record<Track, number> = { me: 0, others: 0 }
  private readonly queue: Piece[] = []
  private running = 0
  private stopped = false
  private refused = false
  private stoppedAt: number | null = null
  private readonly lines: MeetingLine[] = []
  private idleWaiters: (() => void)[] = []

  constructor(private readonly deps: SessionDeps) {
    this.cut = chunker((p) => this.enqueue(p))
    this.startedAt = deps.now?.() ?? Date.now()
  }

  private readonly startedAt: number
  /** a frame of the helper. Meeting time is the track's own sample count from Start, moved on to the clock when the
   * track was silent for a while (the call sound starts when a call app starts, or pauses while the tap follows the
   * call apps): its lines then land at the right time, and the cutter takes the jump as a pause. */
  push(f: Frame) {
    if (this.stopped) return
    const ms = (f.samples.length * 1000) / RATE
    const clock = (this.deps.now?.() ?? Date.now()) - this.startedAt
    if (clock - ms - this.at[f.track] > 1000) this.at[f.track] = clock - ms
    this.cut.push(f.track, this.at[f.track], f.samples)
    this.at[f.track] += ms
  }

  /** Stop: the open pieces go out, and this resolves once every piece has its answer (or was given up). */
  async finish(): Promise<MeetingLine[]> {
    if (!this.stopped) { this.cut.flush(); this.stoppedAt = Date.now() }
    this.stopped = true
    if (this.running || this.queue.length) {
      // every caller waits for the same end (a Stop and a refusal during it); never longer than MEETING_FINISH_MS
      let timer: ReturnType<typeof setTimeout> | undefined
      await new Promise<void>((r) => {
        this.idleWaiters.push(r)
        timer = setTimeout(r, Math.max(0, (this.stoppedAt ?? Date.now()) + MEETING_FINISH_MS - Date.now()))
      })
      clearTimeout(timer)
    }
    return this.all()
  }

  /** every line so far, in meeting time */
  all(): MeetingLine[] { return [...this.lines].sort((a, b) => a.startMs - b.startMs) }

  private enqueue(p: Piece) {
    this.queue.push(p)
    if (this.queue.length > MEETING_BACKLOG_MAX) this.queue.shift()
    this.deps.onBacklog?.(this.queue.length + this.running)
    this.pump()
  }

  private pump() {
    while (this.running < SEND_AT_ONCE && this.queue.length) {
      const p = this.queue.shift()!
      this.running++
      void this.run(p).finally(() => {
        this.running--
        this.deps.onBacklog?.(this.queue.length + this.running)
        if (!this.running && !this.queue.length) { const w = this.idleWaiters; this.idleWaiters = []; for (const r of w) r() }
        this.pump()
      })
    }
  }

  private async run(p: Piece) {
    const wav = pieceWav(p.samples)
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    for (let tries = 0; tries < 6; tries++) {
      // the meeting was refused, or Stop was pressed a while ago: no more tries
      if (this.refused || (this.stoppedAt !== null && Date.now() - this.stoppedAt > MEETING_FINISH_MS)) return
      let a: PieceAnswer
      try { a = await this.deps.send(wav) } catch { a = { ok: false, status: 0, reason: 'busy', retryAfterSec: 5, message: '' } }
      if (a.ok) {
        const got = a.lines.map((l) => ({ track: p.track, startMs: Math.round(p.startMs + l.start * 1000), endMs: Math.round(p.startMs + l.end * 1000), text: l.text }))
        if (got.length) { this.lines.push(...got); this.deps.onLines(got) }
        return
      }
      if (!a.reason || !MEETING_RETRY_REASONS.includes(a.reason)) {
        // said once, also while a Stop is finishing (the person learns why the last words are missing)
        if (!this.refused) { this.refused = true; this.stopped = true; this.queue.length = 0; this.deps.onStop(a.message) }
        return
      }
      if (this.stopped && tries >= 2) return
      await sleep(Math.min(30, Math.max(1, a.retryAfterSec ?? 5)) * 1000)
    }
  }
}
