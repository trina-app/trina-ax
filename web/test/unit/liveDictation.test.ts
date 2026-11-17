// Voice input that shows the words while the person talks (lib/liveDictation.ts): the microphone's rate down to 16 kHz,
// words handed over in recording order, Stop waiting for the last piece, Esc, and a refusal.
import { describe, expect, test } from 'bun:test'
import type { PieceAnswer } from '@mycel/shared/speech-pieces'
import { downsampler, LiveDictation, LIVE_RATE, wordsOf } from '../../src/lib/liveDictation'

const tone = (ms: number, amp: number, rate = LIVE_RATE) => Float32Array.from({ length: Math.round((ms * rate) / 1000) }, (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / rate))
/** a sentence after a quiet start, then a pause: one piece */
const sentence = (ms = 1500) => [tone(2500, 0.0005), tone(ms, 0.2), tone(1500, 0.0005)]
const feed = (d: LiveDictation, parts: Float32Array[]) => {
  for (const p of parts) for (let i = 0; i < p.length; i += 1024) d.push(p.subarray(i, i + 1024))
}

describe('downsampler', () => {
  test('48 kHz in frames of 4096 comes out at 16 kHz, nothing lost between frames', () => {
    const down = downsampler(48_000)
    let n = 0
    for (let k = 0; k < 30; k++) n += down(new Float32Array(4096).fill(0.5)).length
    expect(Math.abs(n - (30 * 4096) / 3)).toBeLessThanOrEqual(1)
  })
  test('44.1 kHz: the count follows the ratio and a steady level stays the same', () => {
    const down = downsampler(44_100)
    const out: number[] = []
    for (let k = 0; k < 20; k++) out.push(...down(new Float32Array(4096).fill(0.25)))
    expect(Math.abs(out.length - Math.floor((20 * 4096 * 16_000) / 44_100))).toBeLessThanOrEqual(1)
    for (const v of out) expect(v).toBeCloseTo(0.25, 5)
  })
  test('16 kHz passes through as it is', () => {
    const x = Float32Array.from({ length: 100 }, (_, i) => i / 100)
    expect([...downsampler(16_000)(x)]).toEqual([...x])
  })
})

describe('live dictation', () => {
  test('words are handed over in recording order even when the second piece is answered first; finish waits for both', async () => {
    const answers: ((a: PieceAnswer) => void)[] = []
    const words: string[] = []
    const d = new LiveDictation({ send: () => new Promise((r) => answers.push(r)), onWords: (w) => words.push(w), onRefused: () => { throw new Error('no refusal') } })
    feed(d, [...sentence(), ...sentence()])
    expect(answers).toHaveLength(2)
    answers[1]!({ ok: true, lines: [{ start: 0, end: 1, text: ' world ' }] })
    await Bun.sleep(0)
    expect(words).toEqual([])
    answers[0]!({ ok: true, lines: [{ start: 0, end: 1, text: 'hello' }, { start: 1, end: 2, text: 'there' }] })
    const done = await d.finish()
    expect(words).toEqual(['hello there', 'world'])
    expect(done).toEqual({ heard: true, refusal: null, lost: false })
  })
  test('talking without a pause: the first piece goes out within 2.5 s of speech', async () => {
    const at: number[] = []
    let samples = 0
    const d = new LiveDictation({ send: async () => { at.push(samples / LIVE_RATE); return { ok: true, lines: [{ start: 0, end: 1, text: 'x' }] } }, onWords: () => {}, onRefused: () => {} })
    const parts = [tone(2500, 0.0005), tone(8000, 0.2)]
    for (const p of parts) for (let i = 0; i < p.length; i += 1024) { const f = p.subarray(i, i + 1024); samples += f.length; d.push(f) }
    await d.finish()
    // 2.5 s of quiet first, then at most 2.5 s of speech
    expect(at[0]!).toBeLessThanOrEqual(5.1)
    expect(at[0]!).toBeGreaterThanOrEqual(4)
  })
  test('Stop sends the piece being collected', async () => {
    const sent: Uint8Array[] = []
    const words: string[] = []
    const d = new LiveDictation({ send: async (wav) => { sent.push(wav); return { ok: true, lines: [{ start: 0, end: 1, text: 'last words' }] } }, onWords: (w) => words.push(w), onRefused: () => {} })
    // still talking when Stop is pressed: no pause has closed the piece
    feed(d, [tone(2500, 0.0005), tone(1500, 0.2)])
    expect(sent).toHaveLength(0)
    expect(await d.finish()).toEqual({ heard: true, refusal: null, lost: false })
    expect(sent).toHaveLength(1)
    expect(words).toEqual(['last words'])
  })
  test('quiet only: nothing is sent, nothing heard', async () => {
    let sent = 0
    const d = new LiveDictation({ send: async () => { sent++; return { ok: true, lines: [] } }, onWords: () => {}, onRefused: () => {} })
    feed(d, [tone(4000, 0.0005)])
    expect(await d.finish()).toEqual({ heard: false, refusal: null, lost: false })
    expect(sent).toBe(0)
  })
  test('cancel: the request on its way is aborted and its words never come', async () => {
    const signals: AbortSignal[] = []
    const answers: ((a: PieceAnswer) => void)[] = []
    const words: string[] = []
    const d = new LiveDictation({ send: (_w, signal) => { signals.push(signal); return new Promise((r) => answers.push(r)) }, onWords: (w) => words.push(w), onRefused: () => {} })
    feed(d, sentence())
    d.cancel()
    expect(signals[0]!.aborted).toBe(true)
    answers[0]!({ ok: true, lines: [{ start: 0, end: 1, text: 'late' }] })
    await Bun.sleep(0)
    expect(words).toEqual([])
  })
  test('a refusal: said once, and finish names it', async () => {
    const refused: string[] = []
    const d = new LiveDictation({ send: async () => ({ ok: false, status: 429, reason: 'free_used', message: "This month's free hours are used up." }), onWords: () => {}, onRefused: (m) => refused.push(m) })
    feed(d, [...sentence(), ...sentence()])
    const done = await d.finish()
    expect(refused).toEqual(["This month's free hours are used up."])
    expect(done.refusal).toBe("This month's free hours are used up.")
  })
  test('a piece that never gets an answer (no connection) is reported as lost; the words that came stay', async () => {
    let n = 0
    const words: string[] = []
    const d = new LiveDictation({
      send: async () => { if (n++ === 0) return { ok: true, lines: [{ start: 0, end: 1, text: 'came' }] }; throw new TypeError('Failed to fetch') },
      onWords: (w) => words.push(w), onRefused: () => { throw new Error('no refusal') }, sleep: async () => {},
    })
    feed(d, sentence())
    await Bun.sleep(0)
    feed(d, [tone(1500, 0.2)])
    const done = await d.finish()
    expect(words).toEqual(['came'])
    expect(done.lost).toBe(true)
  })
  test('a short quiet "yes" on Stop is still sent', async () => {
    let sent = 0
    const d = new LiveDictation({ send: async () => { sent++; return { ok: true, lines: [{ start: 0, end: 0.3, text: 'yes' }] } }, onWords: () => {}, onRefused: () => {} })
    feed(d, [tone(2500, 0.0005), tone(400, 0.02)])
    expect((await d.finish()).heard).toBe(true)
    expect(sent).toBe(1)
  })
  test("wordsOf joins a piece's lines and drops empty ones", () => {
    expect(wordsOf([{ track: 'me', startMs: 0, endMs: 1, text: ' a ' }, { track: 'me', startMs: 1, endMs: 2, text: '' }, { track: 'me', startMs: 2, endMs: 3, text: 'b' }])).toBe('a b')
  })
})
