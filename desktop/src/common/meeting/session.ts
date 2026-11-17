// Meeting notes (docs/AGENTS/plan/20261116-1903-live-meeting-notes.md), the desktop app's part without Electron:
// - readFrames: the capture helper's stdout (desktop/native/meeting-audio) as tracks of 16 kHz mono samples;
// - MeetingSession: frames → pieces at pauses → the team server (POST /api/meetings/piece) → lines on meeting time.
//   It lives in shared/src/speech-pieces.ts with the cutter, since the web app's voice input sends pieces the same way
//   (docs/AGENTS/plan/20261117-0143-voice-live-text.md); this file re-exports it.
// The sound is never written anywhere: a piece lives in memory until its answer.
import { RATE, type Track } from '@mycel/shared/speech-pieces'

export { MeetingSession, MEETING_BACKLOG_MAX, MEETING_FINISH_MS, type MeetingLine, type PieceAnswer, type SessionDeps } from '@mycel/shared/speech-pieces'

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

