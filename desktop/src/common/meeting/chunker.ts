// Meeting notes: cuts each track's sound into pieces of speech for the team's speech service
// (docs/AGENTS/plan/20261116-1903-live-meeting-notes.md). whisper drops lines on long sound and reads a 30 s window
// whatever it is given, so it only ever gets short pieces cut at pauses: a piece ends at 1 s of quiet, or at 15 s, cut
// at the quietest 100 ms of its last 2 s. No partial readings (each would be one more paid request on a hosted team).
//
// Based on Yogurt (github.com/FrigadeHQ/yogurt, app/src/main/asr/chunker.ts), MIT License,
// Copyright (c) 2026 Frigade. The rules and their numbers are Yogurt's; the partial readings are left out.

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

export interface Chunker {
  /** `ms`: meeting time of samples[0]; frames may be any size */
  push(track: Track, ms: number, samples: Float32Array): void
  /** the meeting ended: whatever is being collected goes out */
  flush(): void
  /** someone on this track is mid-sentence */
  isOpen(track: Track): boolean
}

export function chunker(onPiece: (p: Piece) => void): Chunker {
  const fresh = (): State => ({ next: null, rest: new Float32Array(0), open: null, winStart: 0, history: [] })
  const tracks: Record<Track, State> = { me: fresh(), others: fresh() }

  const emit = (track: Track, startMs: number, wins: Win[]) => {
    if (wins.filter((w) => w.voiced).length < MIN_VOICED_WINS) return
    const clearMs = wins.filter((w) => w.clear).length * 100
    if (clearMs < MIN_CLEAR_MS) return
    onPiece({ track, startMs, samples: join(wins), clearMs })
  }

  const close = (track: Track, st: State) => {
    const o = st.open
    st.open = null
    if (!o) return
    let end = o.wins.length
    while (end > 0 && !o.wins[end - 1]!.voiced) end--
    emit(track, o.startMs, o.wins.slice(0, Math.min(o.wins.length, end + KEEP_SILENCE_WINS)))
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
    if (wins.length >= MAX_WINS) {
      // the quietest of the last 2 s; the first of equals, so a flat run cuts as early as it may
      let cut = wins.length - SEARCH_WINS
      for (let i = cut; i < wins.length; i++) if (wins[i]!.rms < wins[cut]!.rms) cut = i
      const head = wins.slice(0, cut + 1)
      const headStart = st.open.startMs
      st.open = { startMs: headStart + head.length * 100, wins: wins.slice(cut + 1) }
      emit(track, headStart, head)
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
