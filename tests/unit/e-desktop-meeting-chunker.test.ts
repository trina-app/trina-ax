// Meeting notes: cutting each track into pieces at pauses (desktop/src/common/meeting/chunker.ts).
import { describe, expect, test } from 'bun:test'
import { chunker, MAX_PIECE_MS, pieceWav, RATE, type Piece } from '../../desktop/src/common/meeting/chunker'

/** a run of sound: a tone at `amp` (speech-like loudness) or near silence */
const tone = (ms: number, amp: number) => {
  const n = (ms * RATE) / 1000
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * 220 * i) / RATE)
  return out
}
const quiet = (ms: number) => tone(ms, 0.0005)
const loud = (ms: number) => tone(ms, 0.2)

function feed(parts: Float32Array[], track: 'me' | 'others' = 'me', frameMs = 20) {
  const got: Piece[] = []
  const c = chunker((p) => got.push(p))
  let at = 0
  for (const part of parts) {
    const step = (frameMs * RATE) / 1000
    for (let i = 0; i < part.length; i += step) {
      const f = part.subarray(i, Math.min(part.length, i + step))
      c.push(track, at, f)
      at += (f.length * 1000) / RATE
    }
  }
  return { got, c }
}

describe('meeting pieces', () => {
  test('a sentence followed by 1 s of quiet is one piece, on meeting time', () => {
    const { got } = feed([quiet(3000), loud(2000), quiet(1500)])
    expect(got).toHaveLength(1)
    expect(got[0]!.track).toBe('me')
    expect(got[0]!.startMs).toBeGreaterThanOrEqual(2900)
    expect(got[0]!.startMs).toBeLessThanOrEqual(3100)
    // the speech plus a little quiet at the end
    const ms = (got[0]!.samples.length * 1000) / RATE
    expect(ms).toBeGreaterThanOrEqual(2000)
    expect(ms).toBeLessThanOrEqual(2400)
  })

  test('two sentences with a short breath between stay one piece; a long pause makes two', () => {
    expect(feed([quiet(3000), loud(1500), quiet(500), loud(1500), quiet(1500)]).got).toHaveLength(1)
    expect(feed([quiet(3000), loud(1500), quiet(1500), loud(1500), quiet(1500)]).got).toHaveLength(2)
  })

  test('talking without a pause is cut at 15 s at most', () => {
    const { got, c } = feed([quiet(3000), loud(40_000)])
    c.flush()
    expect(got.length).toBeGreaterThanOrEqual(3)
    for (const p of got) expect((p.samples.length * 1000) / RATE).toBeLessThanOrEqual(MAX_PIECE_MS)
    // cut pieces follow each other back to back on meeting time
    for (let i = 1; i < got.length; i++) expect(got[i]!.startMs).toBe(got[i - 1]!.startMs + got[i - 1]!.samples.length / 16)
  })

  test('a click is not sent (too little clear speech)', () => {
    expect(feed([quiet(3000), loud(200), quiet(1500)]).got).toHaveLength(0)
  })

  test('only quiet sends nothing; flush sends what is open', () => {
    expect(feed([quiet(10_000)]).got).toHaveLength(0)
    const { got, c } = feed([quiet(3000), loud(2000)])
    expect(got).toHaveLength(0)
    expect(c.isOpen('me')).toBe(true)
    c.flush()
    expect(got).toHaveLength(1)
  })

  test('the two tracks are cut on their own', () => {
    const got: Piece[] = []
    const c = chunker((p) => got.push(p))
    const parts = [quiet(3000), loud(2000), quiet(1500)]
    let at = 0
    for (const part of parts) { c.push('me', at, part); c.push('others', at, part); at += (part.length * 1000) / RATE }
    expect(got.map((p) => p.track).sort()).toEqual(['me', 'others'])
  })

  test('a piece goes as a 16 kHz mono 16-bit WAV', () => {
    const w = pieceWav(new Float32Array([0, 1, -1, 2]))
    const v = new DataView(w.buffer)
    expect(new TextDecoder().decode(w.subarray(0, 4))).toBe('RIFF')
    expect(v.getUint32(24, true)).toBe(16000)
    expect(v.getUint16(22, true)).toBe(1)
    expect(v.getUint16(34, true)).toBe(16)
    expect(w.length).toBe(44 + 8)
    expect(v.getInt16(46, true)).toBe(0x7fff)
    expect(v.getInt16(48, true)).toBe(-0x8000)
    expect(v.getInt16(50, true)).toBe(0x7fff)
  })
})
