// Voice input that shows the words while the person still talks (docs/AGENTS/plan/20261117-0143-voice-live-text.md),
// without React: the microphone's samples (lib/recorder.ts, 16 kHz after `downsampler`) are cut at pauses and sent as
// they close (shared/src/speech-pieces.ts, the meeting notes' cutter and session: at most two at once, sent again only
// for the reasons the server names), and each piece's words are handed over in recording order, even when a later piece
// is answered first. lib/useVoiceInput.ts puts them at the end of the box.
// Stop (finish): the piece being collected goes out and this waits for the rest. Cancel: nothing more is sent or
// handed over. A refusal (free hours used up, a confidential chat, voice input turned off) ends it with the server's
// sentence; the words already handed over stay. A piece that never got an answer (no connection, the server busy
// after its tries) is reported by finish() as `lost`.
import { MEETING_RETRY_REASONS } from '@mycel/shared/api'
import { MeetingSession, type MeetingLine, type PieceAnswer } from '@mycel/shared/speech-pieces'

export const LIVE_RATE = 16_000
/** the first piece of a recording ends at the first short pause (FIRST_PAUSE_MS) after FIRST_MIN_MS of speech, or by
 * FIRST_PIECE_MS at the quietest moment of its last second (talking without a pause: 1.6-2.5 s), so the first words
 * show in about 3-4 s (measured on OpenRouter: a 4 s cut gave 5.4-5.9 s, the answer taking 1.3-1.6 s); later pieces go
 * up to the cutter's 15 s at its usual 1 s pause */
export const FIRST_PIECE_MS = 2_500
export const FIRST_MIN_MS = 1_500
export const FIRST_PAUSE_MS = 300
/** clearly spoken sound a piece needs before it is sent: lower than meeting notes' 300 ms, since a person dictating
 * means it, and a short quiet "yes" must not be dropped */
export const MIN_CLEAR_MS = 200

export interface LiveDictationDeps {
  /** POST /api/transcribe/piece; `signal` is aborted by cancel() */
  send(wav: Uint8Array, signal: AbortSignal): Promise<PieceAnswer>
  /** the next words, in recording order */
  onWords(text: string): void
  /** it cannot go on: the server's sentence (called once) */
  onRefused(message: string): void
  /** the wait before a piece is sent again (tests) */
  sleep?(ms: number): Promise<void>
}

/** A piece's lines as one run of words. */
export function wordsOf(lines: readonly MeetingLine[]): string {
  return lines.map((l) => l.text.trim()).filter(Boolean).join(' ')
}

export class LiveDictation {
  private readonly session: MeetingSession
  private readonly abort = new AbortController()
  private refusal: string | null = null
  /** pieces whose last try got no answer (the same bytes go to every try of a piece) */
  private readonly unanswered = new Set<Uint8Array>()
  /** words were handed over */
  heard = false

  constructor(d: LiveDictationDeps) {
    this.session = new MeetingSession({
      send: async (wav) => {
        this.unanswered.add(wav)
        const a = await d.send(wav, this.abort.signal)
        // a refusal to send again later is not an answer yet
        if (a.ok || !a.reason || !MEETING_RETRY_REASONS.includes(a.reason)) this.unanswered.delete(wav)
        return a
      },
      onLines: () => {},
      onOrdered: (lines) => {
        const said = wordsOf(lines)
        if (!said || this.abort.signal.aborted) return
        this.heard = true
        d.onWords(said)
      },
      onStop: (message) => {
        if (this.abort.signal.aborted) return
        this.refusal = message
        d.onRefused(message)
      },
      chunker: { firstMaxMs: FIRST_PIECE_MS, firstMinMs: FIRST_MIN_MS, firstPauseMs: FIRST_PAUSE_MS, minClearMs: MIN_CLEAR_MS },
      ...(d.sleep ? { sleep: d.sleep } : {}),
    })
  }

  /** 16 kHz mono samples, -1…1, as the microphone gives them */
  push(samples: Float32Array) {
    if (samples.length && !this.abort.signal.aborted) this.session.push({ track: 'me', samples })
  }

  /** Stop: the last piece goes out; resolves when every piece is answered (or given up). `refusal`: why it stopped;
   * `lost`: a piece got no answer, so words may be missing. */
  async finish(): Promise<{ heard: boolean; refusal: string | null; lost: boolean }> {
    await this.session.finish()
    return { heard: this.heard, refusal: this.refusal, lost: this.unanswered.size > 0 }
  }

  /** Esc / ✕: nothing more is sent or handed over; requests on their way are aborted. */
  cancel() {
    this.abort.abort()
    this.session.cancel()
  }
}

/** Turns the microphone's samples at `from` Hz into `to` Hz (16 kHz for the speech service): each output sample is the
 * mean of the input samples it covers (enough of a low-pass for speech), carried over between calls. */
export function downsampler(from: number, to = LIVE_RATE): (input: Float32Array) => Float32Array {
  const ratio = from / to
  let carry = new Float32Array(0)
  let pos = 0
  return (input) => {
    let buf = input
    if (carry.length) {
      buf = new Float32Array(carry.length + input.length)
      buf.set(carry)
      buf.set(input, carry.length)
    }
    const n = Math.max(0, Math.floor((buf.length - pos) / ratio))
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const a = pos + i * ratio
      const lo = Math.floor(a)
      const hi = Math.min(buf.length, Math.floor(a + ratio))
      if (hi <= lo) {
        out[i] = buf[lo] ?? 0
        continue
      }
      let s = 0
      for (let j = lo; j < hi; j++) s += buf[j]!
      out[i] = s / (hi - lo)
    }
    const used = pos + n * ratio
    const keep = Math.min(buf.length, Math.floor(used))
    carry = buf.slice(keep)
    pos = used - keep
    return out
  }
}
