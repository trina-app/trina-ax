// Pieces of speech shared by meeting notes and voice input (shared/src/speech-pieces.ts): voice input's shorter first
// piece, each piece's lines handed over in cut order when answers come back out of order, Esc (cancel), and a refusal
// that gives up the pieces still waiting. The meeting rules themselves: e-desktop-meeting-chunker / -session tests.
import { describe, expect, test } from 'bun:test'
import { chunker, MAX_PIECE_MS, MeetingSession, RATE, type MeetingLine, type PieceAnswer, type Piece } from '@mycel/shared/speech-pieces'

const tone = (ms: number, amp: number) => Float32Array.from({ length: (ms * RATE) / 1000 }, (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / RATE))
const quiet = (ms: number) => tone(ms, 0.0005)
const loud = (ms: number) => tone(ms, 0.2)
const frames = (parts: Float32Array[], push: (f: Float32Array, at: number) => void) => {
  let at = 0
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 320) {
      const f = part.subarray(i, i + 320)
      push(f, at)
      at += (f.length * 1000) / RATE
    }
  }
}
const ms = (p: Piece) => (p.samples.length * 1000) / RATE

describe('the first piece', () => {
  test('voice input cuts its first piece by firstMaxMs; the rest go up to 15 s', () => {
    const got: Piece[] = []
    const c = chunker((p) => got.push(p), { firstMaxMs: 5000 })
    frames([quiet(3000), loud(40_000)], (f, at) => c.push('me', at, f))
    c.flush()
    expect(ms(got[0]!)).toBeLessThanOrEqual(5000)
    expect(ms(got[0]!)).toBeGreaterThanOrEqual(3000)
    expect(ms(got[1]!)).toBeGreaterThan(5000)
    for (const p of got) expect(ms(p)).toBeLessThanOrEqual(MAX_PIECE_MS)
  })
  const voiceFirst = { firstMaxMs: 2500, firstMinMs: 1500, firstPauseMs: 300 }
  test('voice input: the first piece ends at a short pause once 1.5 s were said; the next waits for the usual 1 s pause', () => {
    const got: Piece[] = []
    const c = chunker((p) => got.push(p), voiceFirst)
    frames([quiet(3000), loud(1800), quiet(400), loud(1800), quiet(400), loud(1800), quiet(1500)], (f, at) => c.push('me', at, f))
    c.flush()
    expect(got).toHaveLength(2)
    expect(ms(got[0]!)).toBeGreaterThanOrEqual(1800)
    expect(ms(got[0]!)).toBeLessThanOrEqual(2100)
    // the cut is right after the first sentence (its start is the pause plus a little quiet)
    expect(got[1]!.startMs).toBeGreaterThan(got[0]!.startMs + 1700)
  })
  test('voice input: a pause before 1.5 s does not end it; without a pause it is cut between 1.5 and 2.5 s', () => {
    const early: Piece[] = []
    const a = chunker((p) => early.push(p), voiceFirst)
    frames([quiet(3000), loud(800), quiet(400), loud(3000), quiet(1500)], (f, at) => a.push('me', at, f))
    a.flush()
    expect(ms(early[0]!)).toBeGreaterThan(1500)
    const flat: Piece[] = []
    const b = chunker((p) => flat.push(p), voiceFirst)
    frames([quiet(3000), loud(10_000)], (f, at) => b.push('me', at, f))
    b.flush()
    expect(ms(flat[0]!)).toBeGreaterThanOrEqual(1500)
    expect(ms(flat[0]!)).toBeLessThanOrEqual(2500)
    expect(ms(flat[1]!)).toBeGreaterThan(2500)
  })
  test('without the option the first piece is as long as any (meeting notes)', () => {
    const got: Piece[] = []
    const c = chunker((p) => got.push(p))
    frames([quiet(3000), loud(40_000)], (f, at) => c.push('me', at, f))
    c.flush()
    expect(ms(got[0]!)).toBeGreaterThan(12_000)
  })
})

/** three sentences with pauses: three pieces, cut in this order */
const threeSentences = (s: MeetingSession) => frames([quiet(3000), loud(1500), quiet(1500), loud(1500), quiet(1500), loud(1500), quiet(1500)], (f) => s.push({ track: 'me', samples: f }))

describe('in cut order', () => {
  test('a later piece answered first waits for the one before it', async () => {
    const answers: ((a: PieceAnswer) => void)[] = []
    const ordered: string[] = []
    const s = new MeetingSession({
      send: () => new Promise<PieceAnswer>((r) => answers.push(r)),
      onLines: () => {},
      onOrdered: (l) => ordered.push(l.map((x) => x.text).join(' ')),
      onStop: () => { throw new Error('no stop') },
    })
    threeSentences(s)
    // two at once
    expect(answers).toHaveLength(2)
    answers[1]!({ ok: true, lines: [{ start: 0, end: 1, text: 'two' }] })
    await Bun.sleep(0)
    expect(ordered).toEqual([])
    answers[0]!({ ok: true, lines: [{ start: 0, end: 1, text: 'one' }] })
    await Bun.sleep(0)
    expect(ordered).toEqual(['one', 'two'])
    await Bun.sleep(0)
    // a piece with no words counts too
    answers[2]!({ ok: true, lines: [] })
    const all = await s.finish()
    expect(ordered).toEqual(['one', 'two'])
    expect(all.map((l) => l.text)).toEqual(['one', 'two'])
  })

  test('cancel: nothing more is sent or handed over, finish resolves at once', async () => {
    const answers: ((a: PieceAnswer) => void)[] = []
    const ordered: MeetingLine[][] = []
    const s = new MeetingSession({ send: () => new Promise<PieceAnswer>((r) => answers.push(r)), onLines: () => {}, onOrdered: (l) => ordered.push(l), onStop: () => {} })
    threeSentences(s)
    s.cancel()
    answers[0]!({ ok: true, lines: [{ start: 0, end: 1, text: 'late' }] })
    answers[1]!({ ok: true, lines: [{ start: 0, end: 1, text: 'later' }] })
    await s.finish()
    await Bun.sleep(0)
    expect(answers).toHaveLength(2)
    expect(ordered).toEqual([])
  })

  test('cancel with requests still on their way: finish does not wait for them', async () => {
    const s = new MeetingSession({ send: () => new Promise<PieceAnswer>(() => {}), onLines: () => {}, onStop: () => {} })
    threeSentences(s)
    s.cancel()
    const r = await Promise.race([s.finish().then(() => 'done'), Bun.sleep(500).then(() => 'waited')])
    expect(r).toBe('done')
  })

  test('a refusal gives up the pieces still waiting and hands over what came before it', async () => {
    let n = 0
    const ordered: string[] = []
    const stops: string[] = []
    const s = new MeetingSession({
      send: async () => (n++ === 0 ? { ok: true, lines: [{ start: 0, end: 1, text: 'first' }] } : { ok: false, status: 429, reason: 'free_used', message: 'used up' }),
      onLines: () => {},
      onOrdered: (l) => ordered.push(l[0]!.text),
      onStop: (m) => stops.push(m),
      sleep: async () => {},
    })
    threeSentences(s)
    await s.finish()
    expect(ordered).toEqual(['first'])
    expect(stops).toEqual(['used up'])
    expect(n).toBe(2)
  })
})
