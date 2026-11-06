// The language of OpenRouter transcripts (jobs/speech-language.ts) and the sound OpenRouter gets
// (jobs/openrouter-stt.ts quietGainDb), on answers OpenRouter really gave (tests/fixtures/stt: recorded 2026-11-01, fictional speech; never
// called here). whisper names one language for a whole request from its first 30 seconds: the QA meeting came back
// translated into Japanese; the check sends a long piece once more told the team's language and keeps the answer
// whisper is surer of.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { parseOpenRouter, quietGainDb, wavData } from '../../server/src/jobs/openrouter-stt'
import { confidence, keepLongRetry, longRetryLanguage, scoreSegments, writingSystem, type ScoredAnswer } from '../../server/src/jobs/speech-language'

const FIX = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '..', 'fixtures', 'stt', 'openrouter-answers.json'), 'utf8')) as Record<string, { language: string; duration: number; provider: string; segments: unknown[] }>
const answer = (name: string): ScoredAnswer => parseOpenRouter(FIX[name]!, { language: null, durationSec: null })
/** what a piece keeps: the first answer, or the retry the rule asks for and keeps */
function kept(first: string, retry: string | null, o: { team: string; file?: string }) {
  const a = answer(first), told = longRetryLanguage(a, o)
  if (!told || !retry) return { told, answer: a, retried: false }
  const b = answer(retry)
  return keepLongRetry(a, b, told) ? { told, answer: b, retried: true } : { told, answer: a, retried: false }
}

describe('reading OpenRouter\'s answer', () => {
  test('the language as a code (Groq names it), how sure whisper was of its words', () => {
    expect(FIX['qa-c02']!.provider).toBe('Groq')
    expect(FIX['qa-c02']!.language).toBe('English')
    expect(answer('qa-c02').language).toBe('en')
    expect(answer('qa-c14').language).toBe('ko')
    const p1 = answer('qa-meeting-p1')
    expect(p1.language).toBe('ja')
    expect(confidence(p1.scored!)).toBeCloseTo(-0.932, 2)
    expect(confidence(answer('qa-meeting-p1-ko').scored!)).toBeCloseTo(-0.193, 2)
    // silence: one empty line, nothing to compare by
    expect(answer('silence30').segments).toEqual([])
    expect(answer('silence30').scored).toBeUndefined()
  })
  test('a line with text but no avg_logprob: no confidence at all (never half of one)', () => {
    expect(scoreSegments([{ start: 0, end: 2, text: 'a', avg_logprob: -0.1 }, { start: 2, end: 4, text: 'b' }])).toBeUndefined()
    expect(scoreSegments([{ start: 0, end: 2, text: 'a', avg_logprob: -0.1 }, { start: 2, end: 4, text: ' ', avg_logprob: 0 }])).toEqual({ covered: 2, logprob: -0.2 })
  })
  test('what an answer left out counts against it', () => {
    expect(confidence({ covered: 100, logprob: -20 })).toBeCloseTo(-0.2)
    expect(confidence({ covered: 100, logprob: -20 }, 150)).toBeCloseTo((-20 - 50) / 150)
  })
})

describe('long pieces on a Korean team', () => {
  test('the QA meeting\'s first 10 minutes, heard as Japanese: told "ko", that answer is kept', () => {
    const r = kept('qa-meeting-p1', 'qa-meeting-p1-ko', { team: 'ko' })
    expect(r.told).toBe('ko')
    expect(r.retried).toBe(true)
    expect(writingSystem(r.answer.segments!.slice(0, 5).map((s) => s.text).join(' '))).toBe('hangul')
  })
  test('its last 3 minutes, heard as English (two thirds of it are): checked, and English stays (told "ko" dropped 55 s of English)', () => {
    const r = kept('qa-meeting-p2', 'qa-meeting-p2-ko', { team: 'ko' })
    expect(r.told).toBe('ko')
    expect(r.retried).toBe(false)
    const a = answer('qa-meeting-p2'), b = answer('qa-meeting-p2-ko')
    // by its own lines the retry looks surer; over the time the first answer covered it is not
    expect(confidence(b.scored!)).toBeGreaterThan(confidence(a.scored!) + 0.2)
    expect(confidence(b.scored!, a.scored!.covered)).toBeLessThan(confidence(a.scored!) + 0.1)
  })
  test('a Japanese meeting: checked, and Japanese stays (told "ko", whisper kept writing Japanese and was less sure)', () => {
    const r = kept('ja100', 'ja100-ko', { team: 'ko' })
    expect(r.told).toBe('ko')
    expect(r.retried).toBe(false)
    expect(r.answer.language).toBe('ja')
  })
  test('no retry: Korean heard (10 minutes; a Korean-English meeting), English whisper was sure of, silence', () => {
    for (const n of ['ko600', 'mix120', 'en30', 'silence30']) expect(longRetryLanguage(answer(n), { team: 'ko' }), n).toBeUndefined()
  })
  test('another piece of the file heard in another language: checked against the file\'s language', () => {
    expect(longRetryLanguage(answer('en30'), { team: 'ko', file: 'ko' })).toBe('ko')
    expect(longRetryLanguage(answer('ko600'), { team: 'en', file: 'ko' })).toBeUndefined()
    // an English team: Korean heard is neither the team's language nor English, so it is checked; told "en", the
    // Korean answer whisper is surer of stays
    expect(longRetryLanguage(answer('ko600'), { team: 'en' })).toBe('en')
  })
  test('every half-minute piece of the QA meeting: the answer kept is in the language mostly spoken (26 of 27)', () => {
    // the language spoken most in each 30 s (the QA's section times)
    const spoken = 'ko ko en en ko ko en en en ko ko en en ko ko en en en ko ko en en ko ko en en en'.split(' ')
    const got = spoken.map((_, i) => { const n = `qa-c${String(i).padStart(2, '0')}`; const r = kept(n, `${n}-ko`, { team: 'ko' }); return r.retried ? r.told : r.answer.language })
    // piece 6 (16 s English, 12 s Korean): whisper heard Korean, the team's language, so it is not checked
    expect(got).toEqual(spoken.map((l, i) => (i === 6 ? 'ko' : l)))
  })
  test('a retry is not kept when it is only whisper\'s "(foreign language)" caption, or not in the told language\'s script', () => {
    const first = answer('qa-meeting-p1')
    const caption: ScoredAnswer = { text: '', language: 'ko', durationSec: 600, segments: [{ start: 0, end: 600, text: '(speaking in foreign language)' }], scored: { covered: 600, logprob: -6 } }
    expect(keepLongRetry(first, caption, 'ko')).toBe(false)
    const latin: ScoredAnswer = { ...answer('qa-meeting-p1-ko'), segments: answer('qa-meeting-p1-ko').segments!.map((s) => ({ ...s, text: 'still not Korean' })) }
    expect(keepLongRetry(first, latin, 'ko')).toBe(false)
    expect(keepLongRetry(first, latin, 'en')).toBe(true)
  })
})

describe('the sound OpenRouter gets: quiet sound raised', () => {
  /** a 16 kHz mono 16-bit WAV of `seconds` (with a LIST chunk, as ffmpeg writes it): a 440 Hz tone peaking at `peakDb`,
   * and `clicks` full-scale samples */
  function wav(seconds: number, peakDb: number | null, clicks = 0): Buffer {
    const n = seconds * 16_000, pcm = Buffer.alloc(n * 2)
    const peak = peakDb === null ? 0 : 32767 * 10 ** (peakDb / 20)
    for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(peak * Math.sin((2 * Math.PI * 440 * i) / 16_000)), i * 2)
    for (let c = 0; c < clicks; c++) pcm.writeInt16LE(32767, Math.floor((c + 0.5) * (n / clicks)) * 2)
    const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([4, 0, 0, 0]), Buffer.from('INFO')])
    const fmt = Buffer.alloc(24)
    fmt.write('fmt ', 0, 'latin1'); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(1, 10); fmt.writeUInt32LE(16_000, 12); fmt.writeUInt32LE(32_000, 16); fmt.writeUInt16LE(2, 20); fmt.writeUInt16LE(16, 22)
    const data = Buffer.alloc(8); data.write('data', 0, 'latin1'); data.writeUInt32LE(pcm.length, 4)
    const body = Buffer.concat([Buffer.from('WAVE'), fmt, list, data, pcm])
    const head = Buffer.alloc(8); head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(body.length, 4)
    return Buffer.concat([head, body])
  }
  test('the data chunk behind ffmpeg\'s LIST chunk; not a WAV: none', () => {
    expect(wavData(wav(1, -12))!.length).toBe(32_000)
    expect(wavData(Buffer.from('RIFF....WAVX'))).toBeNull()
  })
  test('speech at a normal level is left as it is; quiet sound is raised to -40 dBFS (RMS), by 20 dB at most', () => {
    expect(quietGainDb(wav(5, -12))).toBe(0)
    expect(quietGainDb(wav(5, -35))).toBe(0)
    // a tone's RMS is 3 dB under its peak: peak -52 is RMS -55, raised by 15
    expect(quietGainDb(wav(5, -52))).toBeCloseTo(15, 0)
    // room tone level (RMS about -61): 20 at most (from +30 dB DeepInfra wrote "Thank you." over it)
    expect(quietGainDb(wav(5, -60))).toBe(20)
    // digital silence: nothing to raise
    expect(quietGainDb(wav(5, null))).toBe(0)
  })
  test('the loudest samples stay under -1 dBFS; a few clicks (under 0.1% of the samples) do not hold the gain back', () => {
    expect(quietGainDb(wav(10, -52, 2))).toBeCloseTo(15, 0)
    // quiet sound with a burst near full scale in 4 of its 100 frames (0.2% of the samples): raised only as far as the
    // burst allows
    const burst = wav(10, -52)
    const d = wavData(burst)!
    for (let i = 0; i < 300; i++) d.writeInt16LE(25000, (20_800 + i * 20) * 2)
    const g = quietGainDb(burst)
    expect(g).toBeGreaterThan(0)
    expect(g).toBeLessThan(2)
  })
})
