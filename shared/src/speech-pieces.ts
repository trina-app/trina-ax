// Pieces of speech for the team's speech service, used by the desktop app's meeting notes
// (docs/AGENTS/plan/20261116-1903-live-meeting-notes.md) and the web app's voice input, which shows the words while the
// person still talks (docs/AGENTS/plan/20261117-0143-voice-live-text.md).
//
// The cutter: each track's sound into pieces of speech. whisper drops lines on long sound and reads a 30 s window
// whatever it is given, so it only ever gets short pieces cut at pauses: a piece ends at 1 s of quiet, or at 15 s, cut
// at the quietest 100 ms of its last 2 s. No partial readings (each would be one more paid request on a hosted team).
//
// Based on Yogurt (github.com/FrigadeHQ/yogurt, app/src/main/asr/chunker.ts), MIT License,
// Copyright (c) 2026 Frigade. The rules and their numbers are Yogurt's; the partial readings are left out. Voice input
// asks for a shorter first piece (ChunkerOptions.firstMaxMs), so the first words show early even without a pause.
//
// The session (MeetingSession): pieces → the team server → lines. A piece the server says to send again (reason in
// MEETING_RETRY_REASONS) waits its Retry-After; any other refusal ends the session with the server's sentence. Pieces
// go out in the order they were cut, at most two at once, so lines may arrive out of order (all() sorts them, and
// onOrdered hands each piece's lines over in cut order). No Node or browser APIs: both apps run it.
import { MEETING_RETRY_REASONS } from './api/jobs'

/** "me": this computer's microphone. "others": the sound coming out of the computer (the call). */
export type Track = 'me' | 'others'

export interface Piece {
  track: Track
  /** meeting time (ms from Start) of the first sample */
  startMs: number
  /** 16 kHz mono, -1…1 */
  samples: Float32Array
  /** how much of it is clearly speech: under MIN_CLEAR_MS it is a faint sound, not someone talking */
  clearMs: number
}

export const RATE = 16000
const WIN = RATE / 10 // 100 ms
/** 1 s: at 600 ms a room conversation came out as 1-2 s scraps, which whisper reads worse than whole sentences */
const SILENCE_WINS = 10
/** a little quiet at the end so the last word is not clipped */
const KEEP_SILENCE_WINS = 2
/** 15 s at most */
export const MAX_PIECE_MS = 15_000
const MAX_WINS = MAX_PIECE_MS / 100
/** the cut of a long piece is looked for in its last 2 s */
const SEARCH_WINS = 20
const MIN_VOICED_WINS = 3
/** a piece with less clearly-spoken sound than this is not sent (whisper writes "Thank you." over faint sounds) */
export const MIN_CLEAR_MS = 300
/**
 * The noise floor is the track's quietest tenth over the last minute. Speech is a window louder than 1.5× that, kept
 * between -56 dB and -34 dB: a quiet headset and a noisy room both work with a ratio, not a level. Clearly speech is 3×
 * a level of 3× the floor.
 */
const FLOOR_SHARE = 0.1
const SPEECH_FACTOR = 1.5
const LOUD_FACTOR = 3
const CLEAR_FACTOR = 3
const MIN_THRESHOLD = 0.0015
const MAX_THRESHOLD = 0.02
const START_THRESHOLD = 0.004
const HISTORY_WINS = 600
const WARMUP_WINS = 20
/** a jump in meeting time bigger than this is a pause or a restart, not the next frame */
const GAP_MS = 200

interface Win { samples: Float32Array; rms: number; voiced: boolean; clear: boolean }
interface State {
  next: number | null
  rest: Float32Array
  open: { startMs: number; wins: Win[] } | null
  winStart: number
  history: number[]
  /** pieces sent on so far (the first may be shorter) */
  emitted: number
}

export const rmsOf = (xs: Float32Array) => {
  let s = 0
  for (let i = 0; i < xs.length; i++) s += xs[i]! * xs[i]!
  return Math.sqrt(s / (xs.length || 1))
}
const join = (wins: Win[]) => {
  const out = new Float32Array(wins.length * WIN)
  wins.forEach((w, i) => out.set(w.samples, i * WIN))
  return out
}

export interface ChunkerOptions {
  /** the first piece of each track is cut at this length instead of MAX_PIECE_MS (voice input: words show early) */
  firstMaxMs?: number
  /** clearly spoken sound a piece needs (default MIN_CLEAR_MS; voice input asks for less: a short "yes" is meant) */
  minClearMs?: number
}

export interface Chunker {
  /** `ms`: meeting time of samples[0]; frames may be any size */
  push(track: Track, ms: number, samples: Float32Array): void
  /** the meeting ended: whatever is being collected goes out */
  flush(): void
  /** someone on this track is mid-sentence */
  isOpen(track: Track): boolean
}

export function chunker(onPiece: (p: Piece) => void, opts: ChunkerOptions = {}): Chunker {
  const fresh = (): State => ({ next: null, rest: new Float32Array(0), open: null, winStart: 0, history: [], emitted: 0 })
  const firstWins = Math.max(SEARCH_WINS + 1, Math.min(MAX_WINS, Math.round((opts.firstMaxMs ?? MAX_PIECE_MS) / 100)))
  const tracks: Record<Track, State> = { me: fresh(), others: fresh() }

  const emit = (track: Track, st: State, startMs: number, wins: Win[]) => {
    if (wins.filter((w) => w.voiced).length < MIN_VOICED_WINS) return
    const clearMs = wins.filter((w) => w.clear).length * 100
    if (clearMs < (opts.minClearMs ?? MIN_CLEAR_MS)) return
    st.emitted++
    onPiece({ track, startMs, samples: join(wins), clearMs })
  }

  const close = (track: Track, st: State) => {
    const o = st.open
    st.open = null
    if (!o) return
    let end = o.wins.length
    while (end > 0 && !o.wins[end - 1]!.voiced) end--
    emit(track, st, o.startMs, o.wins.slice(0, Math.min(o.wins.length, end + KEEP_SILENCE_WINS)))
  }

  const thresholdsOf = (st: State, rms: number) => {
    st.history.push(rms)
    if (st.history.length > HISTORY_WINS) st.history.shift()
    if (st.history.length < WARMUP_WINS) return { voiced: START_THRESHOLD, clear: START_THRESHOLD * CLEAR_FACTOR }
    const floor = [...st.history].sort((a, b) => a - b)[Math.floor(st.history.length * FLOOR_SHARE)]!
    const level = (factor: number) => Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, floor * factor))
    return { voiced: level(SPEECH_FACTOR), clear: level(LOUD_FACTOR) * CLEAR_FACTOR }
  }

  const addWindow = (track: Track, st: State, w: Win) => {
    if (!st.open) {
      if (w.voiced) st.open = { startMs: st.winStart, wins: [w] }
      st.winStart += 100
      return
    }
    st.open.wins.push(w)
    st.winStart += 100
    const wins = st.open.wins
    let quiet = 0
    while (quiet < wins.length && !wins[wins.length - 1 - quiet]!.voiced) quiet++
    if (quiet >= SILENCE_WINS) return close(track, st)
    if (wins.length >= (st.emitted ? MAX_WINS : firstWins)) {
      // the quietest of the last 2 s; the first of equals, so a flat run cuts as early as it may
      let cut = wins.length - SEARCH_WINS
      for (let i = cut; i < wins.length; i++) if (wins[i]!.rms < wins[cut]!.rms) cut = i
      const head = wins.slice(0, cut + 1)
      const headStart = st.open.startMs
      st.open = { startMs: headStart + head.length * 100, wins: wins.slice(cut + 1) }
      emit(track, st, headStart, head)
      if (!st.open.wins.length) st.open = null
    }
  }

  const flushTrack = (track: Track) => {
    const st = tracks[track]
    close(track, st)
    st.rest = new Float32Array(0)
    st.next = null
  }

  return {
    push(track, ms, samples) {
      const st = tracks[track]
      if (st.next !== null && Math.abs(ms - st.next) > GAP_MS) flushTrack(track)
      if (st.next === null) { st.winStart = ms; st.rest = new Float32Array(0) }
      st.next = ms + samples.length / (RATE / 1000)
      let buf = samples
      if (st.rest.length) { buf = new Float32Array(st.rest.length + samples.length); buf.set(st.rest); buf.set(samples, st.rest.length) }
      let i = 0
      for (; i + WIN <= buf.length; i += WIN) {
        const w = buf.slice(i, i + WIN)
        const rms = rmsOf(w)
        const t = thresholdsOf(st, rms)
        addWindow(track, st, { samples: w, rms, voiced: rms >= t.voiced, clear: rms >= t.clear })
      }
      st.rest = buf.slice(i)
    },
    flush() { flushTrack('me'); flushTrack('others') },
    isOpen: (track) => !!tracks[track].open,
  }
}

/** A piece as a 16-bit PCM WAV (16 kHz mono, 44-byte header): what the team server takes. */
export function pieceWav(samples: Float32Array): Uint8Array {
  const data = samples.length * 2
  const b = new ArrayBuffer(44 + data)
  const v = new DataView(b)
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); v.setUint32(4, 36 + data, true); str(8, 'WAVE')
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  str(36, 'data'); v.setUint32(40, data, true)
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]!))
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true)
  }
  return new Uint8Array(b)
}

// ---------------- the session: pieces → the team server → lines ----------------

export interface MeetingLine { track: Track; startMs: number; endMs: number; text: string }

/** What the team server answered for one piece. */
export type PieceAnswer =
  | { ok: true; lines: { start: number; end: number; text: string }[] }
  | { ok: false; status: number; reason?: string; retryAfterSec?: number; message: string }

export interface SessionDeps {
  /** POST the WAV (meeting notes: /api/meetings/piece; voice input: /api/transcribe/piece) */
  send(wav: Uint8Array): Promise<PieceAnswer>
  /** each piece's lines as they come back (in any order) */
  onLines(lines: MeetingLine[]): void
  /** each piece's lines in the order the pieces were cut: a piece answered early waits for the ones before it (a piece
   * given up or dropped counts as one with no lines). Voice input puts words into the box with this. */
  onOrdered?(lines: MeetingLine[]): void
  /** the session cannot go on (voice input off, too slow, free hours used up, …): the server's sentence */
  onStop(message: string): void
  /** pieces waiting for an answer or a retry (the page says "words are coming in late" when this grows) */
  onBacklog?(waiting: number): void
  sleep?(ms: number): Promise<void>
  /** the clock (tests) */
  now?(): number
  /** how the cutter cuts (voice input: a shorter first piece) */
  chunker?: ChunkerOptions
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
  /** cancel(): nothing more is sent or handed over */
  private dropped = false
  /** each piece's place in cut order, the next place onOrdered hands over, and answered pieces waiting for it */
  private readonly seqOf = new WeakMap<Piece, number>()
  private nextSeq = 0
  private outSeq = 0
  private readonly settled = new Map<number, MeetingLine[]>()

  constructor(private readonly deps: SessionDeps) {
    this.cut = chunker((p) => this.enqueue(p), deps.chunker)
    this.startedAt = deps.now?.() ?? Date.now()
  }

  private readonly startedAt: number
  /** a frame of the helper. Meeting time is the track's own sample count from Start, moved on to the clock when the
   * track was silent for a while (the call sound starts when a call app starts, or pauses while the tap follows the
   * call apps): its lines then land at the right time, and the cutter takes the jump as a pause. */
  push(f: { track: Track; samples: Float32Array }) {
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
    if (!this.dropped && (this.running || this.queue.length)) {
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

  /** Throw it all away (voice input's Esc): no more sending, no more lines handed over, finish() resolves at once (a
   * request still on its way is left to end by itself; its answer is dropped). */
  cancel() {
    this.dropped = true
    this.stopped = true
    this.queue.length = 0
    this.wake()
  }

  /** every line so far, in meeting time */
  all(): MeetingLine[] { return [...this.lines].sort((a, b) => a.startMs - b.startMs) }

  private enqueue(p: Piece) {
    if (this.dropped) return
    this.seqOf.set(p, this.nextSeq++)
    this.queue.push(p)
    if (this.queue.length > MEETING_BACKLOG_MAX) this.settle(this.queue.shift()!, [])
    this.deps.onBacklog?.(this.queue.length + this.running)
    this.pump()
  }

  private pump() {
    while (this.running < SEND_AT_ONCE && this.queue.length) {
      const p = this.queue.shift()!
      this.running++
      void this.run(p).catch(() => [] as MeetingLine[]).then((got) => {
        this.running--
        this.settle(p, got)
        this.deps.onBacklog?.(this.queue.length + this.running)
        if (!this.running && !this.queue.length) this.wake()
        this.pump()
      })
    }
  }

  private wake() { const w = this.idleWaiters; this.idleWaiters = []; for (const r of w) r() }

  /** a piece is answered, given up or dropped: hand over, in cut order, every piece whose turn has come */
  private settle(p: Piece, got: MeetingLine[]) {
    const seq = this.seqOf.get(p)
    if (seq === undefined) return
    this.seqOf.delete(p)
    this.settled.set(seq, got)
    while (this.settled.has(this.outSeq)) {
      const lines = this.settled.get(this.outSeq)!
      this.settled.delete(this.outSeq++)
      if (lines.length && !this.dropped) this.deps.onOrdered?.(lines)
    }
  }

  /** the piece's lines (none when it was refused or given up) */
  private async run(p: Piece): Promise<MeetingLine[]> {
    const wav = pieceWav(p.samples)
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    for (let tries = 0; tries < 6; tries++) {
      // the meeting was refused, or Stop was pressed a while ago: no more tries
      if (this.dropped || this.refused || (this.stoppedAt !== null && Date.now() - this.stoppedAt > MEETING_FINISH_MS)) return []
      let a: PieceAnswer
      try { a = await this.deps.send(wav) } catch { a = { ok: false, status: 0, reason: 'busy', retryAfterSec: 5, message: '' } }
      if (this.dropped) return []
      if (a.ok) {
        const got = a.lines.map((l) => ({ track: p.track, startMs: Math.round(p.startMs + l.start * 1000), endMs: Math.round(p.startMs + l.end * 1000), text: l.text }))
        if (got.length) { this.lines.push(...got); this.deps.onLines(got) }
        return got
      }
      if (!a.reason || !MEETING_RETRY_REASONS.includes(a.reason)) {
        // said once, also while a Stop is finishing (the person learns why the last words are missing)
        if (!this.refused) {
          this.refused = true
          this.stopped = true
          for (const q of this.queue.splice(0)) this.settle(q, [])
          this.deps.onStop(a.message)
        }
        return []
      }
      if (this.stopped && tries >= 2) return []
      await sleep(Math.min(30, Math.max(1, a.retryAfterSec ?? 5)) * 1000)
    }
    return []
  }
}
