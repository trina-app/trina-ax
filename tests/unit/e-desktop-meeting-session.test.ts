// Meeting notes in the desktop app: the helper's frames, pieces sent in order with retries by reason, lines on meeting
// time, a final refusal stops the meeting (desktop/src/common/meeting/session.ts, desktop/src/main/meeting.ts).
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FrameReader, FRAME_ME, FRAME_OTHERS, MeetingSession, type MeetingLine, type PieceAnswer } from '../../desktop/src/common/meeting/session'
import { RATE } from '../../desktop/src/common/meeting/chunker'
import { meetingHelperPath, pieceAnswerOf } from '../../desktop/src/main/meeting'

const frame = (kind: number, samples: Float32Array) => {
  const b = Buffer.alloc(5 + samples.length * 4)
  b[0] = kind
  b.writeUInt32LE(samples.length, 1)
  samples.forEach((v, i) => b.writeFloatLE(v, 5 + i * 4))
  return b
}
const tone = (ms: number, amp: number) => Float32Array.from({ length: (ms * RATE) / 1000 }, (_, i) => amp * Math.sin(i / 5))

describe('the helper frames', () => {
  test('split across chunks, both tracks', () => {
    const r = new FrameReader()
    const all = Buffer.concat([frame(FRAME_ME, new Float32Array([0.5, -0.25])), frame(FRAME_OTHERS, new Float32Array([1]))])
    const got = [...r.push(all.subarray(0, 7)), ...r.push(all.subarray(7, 16)), ...r.push(all.subarray(16))]
    expect(got.map((f) => [f.track, [...f.samples]])).toEqual([['me', [0.5, -0.25]], ['others', [1]]])
  })
  test('a byte that is not a frame, or a huge frame, breaks the stream', () => {
    expect(() => new FrameReader().push(Buffer.from([0x41, 0, 0, 0, 0]))).toThrow()
    const big = Buffer.alloc(5); big[0] = FRAME_ME; big.writeUInt32LE(11 * RATE, 1)
    expect(() => new FrameReader().push(big)).toThrow()
  })
})

/** feeds a sentence on a track, in 20 ms frames, then a pause */
function talk(s: MeetingSession, track: 'me' | 'others', ms: number) {
  for (const part of [tone(3000, 0.0005), tone(ms, 0.2), tone(1500, 0.0005)]) {
    for (let i = 0; i < part.length; i += 320) s.push({ track, samples: part.subarray(i, i + 320) })
  }
}

describe('the meeting session', () => {
  test('a sentence on each track comes back as lines on meeting time', async () => {
    const lines: MeetingLine[] = []
    const s = new MeetingSession({ send: async () => ({ ok: true, lines: [{ start: 0.1, end: 1.2, text: 'hello' }] }), onLines: (l) => lines.push(...l), onStop: () => { throw new Error('no stop') } })
    talk(s, 'me', 2000)
    talk(s, 'others', 2000)
    const all = await s.finish()
    expect(all.map((l) => l.track).sort()).toEqual(['me', 'others'])
    for (const l of all) { expect(l.startMs).toBeGreaterThanOrEqual(3000); expect(l.endMs).toBeGreaterThan(l.startMs) }
    expect(lines).toHaveLength(2)
  })
  test('busy is sent again after its wait; in_flight too; then the lines come', async () => {
    const answers: PieceAnswer[] = [
      { ok: false, status: 503, reason: 'busy', retryAfterSec: 5, message: 'busy' },
      { ok: false, status: 429, reason: 'in_flight', retryAfterSec: 2, message: 'later' },
      { ok: true, lines: [{ start: 0, end: 1, text: 'finally' }] },
    ]
    const waits: number[] = []
    const s = new MeetingSession({ send: async () => answers.shift()!, onLines: () => {}, onStop: () => { throw new Error('no stop') }, sleep: async (ms) => { waits.push(ms) } })
    talk(s, 'me', 2000)
    expect((await s.finish()).map((l) => l.text)).toEqual(['finally'])
    expect(waits).toEqual([5000, 2000])
  })
  test('a final refusal (voice input off, free hours used up) stops the meeting once, with the sentence', async () => {
    const stops: string[] = []
    let sent = 0
    const s = new MeetingSession({ send: async () => { sent++; return { ok: false, status: 429, reason: 'free_used', message: 'This month\'s free hours are used up.' } }, onLines: () => {}, onStop: (m) => stops.push(m), sleep: async () => {} })
    talk(s, 'me', 2000)
    talk(s, 'me', 2000)
    await s.finish()
    expect(stops).toEqual(["This month's free hours are used up."])
    expect(sent).toBeLessThanOrEqual(2)
  })
  test('a network failure counts as busy (sent again), not as the end', async () => {
    let n = 0
    const s = new MeetingSession({ send: async () => { if (n++ === 0) throw new Error('offline'); return { ok: true, lines: [{ start: 0, end: 1, text: 'back' }] } }, onLines: () => {}, onStop: () => { throw new Error('no stop') }, sleep: async () => {} })
    talk(s, 'others', 2000)
    expect((await s.finish()).map((l) => l.text)).toEqual(['back'])
  })
})

describe('the main process side', () => {
  test("the server's answers as the session reads them", async () => {
    expect(await pieceAnswerOf(Response.json({ lines: [{ start: 0, end: 1, text: 'hi' }, { bad: 1 }] }))).toEqual({ ok: true, lines: [{ start: 0, end: 1, text: 'hi' }] })
    const busy = await pieceAnswerOf(new Response(JSON.stringify({ error: { code: 'unavailable', message: 'Busy', params: { reason: 'busy' } } }), { status: 503, headers: { 'retry-after': '5' } }))
    expect(busy).toEqual({ ok: false, status: 503, reason: 'busy', retryAfterSec: 5, message: 'Busy' })
    expect(await pieceAnswerOf(new Response('nope', { status: 500 }))).toEqual({ ok: false, status: 500, message: 'HTTP 500' })
  })
  test('the helper is found next to the app on a Mac, or named for tests; none elsewhere', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-'))
    fs.writeFileSync(path.join(dir, 'meeting-audio'), '')
    expect(meetingHelperPath({}, path.join(dir, 'Trina AX'), 'darwin')).toBe(path.join(dir, 'meeting-audio'))
    expect(meetingHelperPath({}, path.join(dir, 'Trina AX'), 'win32')).toBeNull()
    expect(meetingHelperPath({ MYCEL_MEETING_HELPER: path.join(dir, 'nope') }, '/x', 'darwin')).toBeNull()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
