// Voice input on silence, noise or a beep (QA TC-4581): whisper writes "you", "(beep)" or "Thank you." for sound with no
// speech, and the person must see "Nothing was recognized" instead. server/src/jobs/no-speech.ts decides from the sound
// (soundOf) and whisper's own signals (whisper.cpp's first-word probability, OpenRouter's no_speech_prob / avg_logprob);
// a real short "yes" or "네" with normal sound is kept.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pieceWav } from '@mycel/shared/speech-pieces'
import { keepSpeech, learnedLine, NOT_WORDS, silent, soundOf } from '../../server/src/jobs/no-speech'
import { parseWhisperJson, whisperUnsure } from '../../server/src/jobs/transcribe'
import { openRouterUnsure, parseOpenRouter, openRouterSpeech } from '../../server/src/jobs/openrouter-stt'

const RATE = 16_000
const db = (d: number) => 10 ** (d / 20)
/** a seeded generator: the same noise every run */
const rand = (seed = 7) => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1 }
const wav = (f: (i: number) => number, sec: number) => pieceWav(Float32Array.from({ length: Math.round(sec * RATE) }, (_, i) => f(i)))
const silence = (sec = 2) => wav(() => 0, sec)
/** a steady tone at `level` dBFS peak, as a beep */
const beep = (sec = 1, hz = 1000, level = -6) => wav((i) => db(level) * Math.sin(2 * Math.PI * hz * i / RATE), sec)
/** steady white noise, peak about `level` dBFS */
const noise = (sec = 2, level = -30) => { const r = rand(); return wav(() => db(level) * r(), sec) }
/** sound that moves like speech: syllables of a voice whose pitch glides, with a breath of noise at each start and a
 * pause between them, at `level` dBFS */
const speechLike = (syllables = 4, level = -12) => {
  const r = rand(3), syl = 0.18 * RATE, gap = 0.07 * RATE
  return wav((i) => {
    const k = Math.floor(i / (syl + gap)), t = i % (syl + gap)
    if (t >= syl) return 0
    const env = Math.sin(Math.PI * t / syl)
    const f0 = 110 + 40 * (t / syl) + 15 * (k % 3)
    let v = 0
    for (let h = 1; h <= 8; h++) v += Math.sin(2 * Math.PI * f0 * h * i / RATE) / h * (h === 2 + (k % 3) ? 2 : 1)
    const breath = t < 0.04 * RATE ? 2 * r() : 0
    return db(level) * env * (v / 3 + breath) / 2
  }, (syllables * (syl + gap)) / RATE)
}
const said = (text: string, extra: Record<string, unknown> = {}) => ({ text, language: 'en', durationSec: 1, segments: [{ start: 0, end: 1, text }], ...extra })

describe('what the sound holds', () => {
  test('silence, a beep, noise and speech-like sound', () => {
    expect(silent(soundOf(silence()))).toBe(true)
    // a pink-noise floor under -60 dBFS is silence too
    expect(silent(soundOf(noise(2, -66)))).toBe(true)
    const b = soundOf(beep())!
    expect(silent(b)).toBe(false)
    expect(b.speechLike).toBe(false)
    expect(b.seconds).toBeCloseTo(1, 2)
    // a short beep after a pause, and a beep that fades out like a chime: still a tone
    expect(soundOf(wav((i) => (i > RATE && i < 1.3 * RATE ? 0.5 * Math.sin(i / 2) : 0), 3))!.speechLike).toBe(false)
    expect(soundOf(wav((i) => 0.5 * Math.exp(-3 * i / RATE) * Math.sin(2 * Math.PI * 880 * i / RATE), 1.5))!.speechLike).toBe(false)
    expect(soundOf(noise())!.speechLike).toBe(false)
    const s = soundOf(speechLike())!
    expect(s.speechLike).toBe(true)
    expect(s.peakDb).toBeGreaterThan(-30)
    // quieter speech still moves like speech
    expect(soundOf(speechLike(4, -30))!.speechLike).toBe(true)
  })
  // real speech: macOS `say` (only where it is), as the server's 16 kHz mono WAV by afconvert, also 30 dB quieter
  test.skipIf(!fs.existsSync('/usr/bin/say') || !fs.existsSync('/usr/bin/afconvert'))('real speech moves like speech: "yes", "Thank you", a sentence, quiet', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-speech-'))
    try {
      for (const [words, gain] of [['yes', 1], ['Thank you.', 1], ['Can you send me the report from the meeting?', 1], ['Can you send me the report from the meeting?', db(-30)]] as const) {
        const aiff = path.join(dir, 'a.aiff'), out = path.join(dir, 'a.wav')
        expect(Bun.spawnSync(['/usr/bin/say', '-o', aiff, words]).exitCode).toBe(0)
        expect(Bun.spawnSync(['/usr/bin/afconvert', '-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, out]).exitCode).toBe(0)
        const w = Buffer.from(fs.readFileSync(out))
        const s = soundOf(w)!
        if (gain !== 1) {
          // the samples 30 dB down, in place
          const d = w.indexOf('data') + 8
          for (let i = d; i + 1 < w.length; i += 2) w.writeInt16LE(Math.round(w.readInt16LE(i) * gain), i)
        }
        const q = soundOf(w)!
        expect({ words, gain, like: q.speechLike, silent: silent(q) }).toEqual({ words, gain, like: true, silent: false })
        expect(s.speechLike).toBe(true)
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)
  test('only 16 kHz mono 16-bit PCM is read; a chunk before the data is skipped', () => {
    expect(soundOf(new Uint8Array([1, 2, 3]))).toBeNull()
    const stereo = beep(); stereo[22] = 2
    expect(soundOf(stereo)).toBeNull()
    const rate = beep(); rate[25] = 0xac; rate[26] = 0
    expect(soundOf(rate)).toBeNull()
    // ffmpeg's LIST chunk between fmt and data
    const w = beep(0.5)
    const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([4, 0, 0, 0]), Buffer.from('INFO')])
    const withList = Buffer.concat([w.subarray(0, 36), list, w.subarray(36)])
    withList.writeUInt32LE(withList.length - 8, 4)
    expect(soundOf(withList)!.seconds).toBeCloseTo(0.5, 2)
  })
})

/** `wav` (the app's 16 kHz WAV) with every sample times `gain`, and white noise at `floorDb` dBFS added */
const under = (w: Uint8Array, gain: number, floorDb: number | null = null) => {
  const b = Buffer.from(w), r = rand(5)
  for (let i = 44; i + 1 < b.length; i += 2) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(b.readInt16LE(i) * gain + (floorDb === null ? 0 : db(floorDb) * 32768 * r())))), i)
  return b
}
const sayWav = (dir: string, words: string, voice: string[] = []) => {
  const aiff = path.join(dir, 'a.aiff'), out = path.join(dir, 'a.wav')
  expect(Bun.spawnSync(['/usr/bin/say', ...voice, '-o', aiff, words]).exitCode).toBe(0)
  expect(Bun.spawnSync(['/usr/bin/afconvert', '-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, out]).exitCode).toBe(0)
  // as the app's piece: a plain 44-byte header (pieceWav) with afconvert's samples
  const raw = fs.readFileSync(out), d = raw.subarray(raw.indexOf('data') + 8)
  return pieceWav(Float32Array.from({ length: d.length / 2 }, (_, i) => d.readInt16LE(i * 2) / 32768))
}
const canSay = fs.existsSync('/usr/bin/say') && fs.existsSync('/usr/bin/afconvert')

describe('quiet speech is speech; a beep or noise at any level is not (review of TC-4581)', () => {
  test.skipIf(!canSay)('real single words 30-40 dB down (peak -40 to -55 dBFS), with and without a room noise floor: speech, and a learned line on them is kept', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-speech-q-'))
    try {
      const ko = Bun.spawnSync(['/usr/bin/say', '-v', '?']).stdout.toString().includes('Yuna')
      const words: [string, string[]][] = [['Thanks.', []], ['Thank you.', []], ['yes', []], ['ok', []], ['Minjun', []], ...(ko ? [['\uB124', ['-v', 'Yuna']], ['\uAC10\uC0AC\uD569\uB2C8\uB2E4', ['-v', 'Yuna']]] as [string, string[]][] : [])]
      for (const [w, voice] of words) {
        const loud = sayWav(dir, w, voice)
        for (const down of [30, 36, 40]) for (const floor of [null, -75]) {
          const s = soundOf(under(loud, db(-down), floor))!
          expect({ w, down, floor, like: s.speechLike, silent: silent(s) }).toEqual({ w, down, floor, like: true, silent: false })
          // whisper sure, or a word on the learned list ("Thanks", "감사합니다"): kept
          expect(keepSpeech(said(w), s, false).text).toBe(w)
        }
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  }, 120_000)
  test('a beep or white noise at -30 to -55 dBFS, alone or over a room noise floor, is not speech: its learned line is dropped', () => {
    for (const level of [-30, -40, -50, -55]) for (const floor of [null, -75, -70]) {
      const pad = (f: (i: number) => number) => wav((i) => (i > 8000 && i < 16000 ? f(i) : 0), 1.5)
      const b = soundOf(under(pad((i) => db(level) * Math.sin(2 * Math.PI * 1000 * i / RATE)), 1, floor))!
      expect({ level, floor, beep: b.speechLike }).toEqual({ level, floor, beep: false })
      expect(keepSpeech(said('Thank you.'), b, false).text).toBe('')
      const n = soundOf(under(noise(2, level), 1, floor))!
      expect({ level, floor, noise: n.speechLike }).toEqual({ level, floor, noise: false })
      expect(keepSpeech(said('you'), n, false).text).toBe('')
    }
  })
})

describe('keepSpeech', () => {
  test('whisper\'s marks for sound with no words are never words', () => {
    for (const t of ['(beep)', '[BLANK_AUDIO]', '(Music)', '[음악]', '♪', '♪ ♪', '*click*', '（拍手）']) expect(NOT_WORDS.test(t), t).toBe(true)
    expect(keepSpeech(said('(beep)'), soundOf(beep()), false)).toMatchObject({ text: '', segments: [] })
    // a mark next to real words: only the mark goes
    const r = keepSpeech({ text: '(beep) send the report', language: 'en', durationSec: 3, segments: [{ start: 0, end: 1, text: '(beep)' }, { start: 1, end: 3, text: 'send the report' }] }, soundOf(speechLike()), false)
    expect(r.text).toBe('send the report')
    expect(r.segments).toEqual([{ start: 1, end: 3, text: 'send the report' }])
  })
  test('silence: nothing, whatever whisper wrote', () => {
    expect(keepSpeech(said('you'), soundOf(silence()), false).text).toBe('')
    expect(keepSpeech(said('Send the report'), soundOf(silence()), false).text).toBe('')
  })
  test('a learned line on a beep or noise is dropped, in six languages', () => {
    for (const t of ['you', 'You.', 'Thank you.', 'Thanks for watching!', 'Subtitles by the Amara.org community', 'Please subscribe.',
      '시청해 주셔서 감사합니다.', '감사합니다', 'ご視聴ありがとうございました', '谢谢观看。', '字幕由Amara.org社区提供',
      'Terima kasih telah menonton.', 'Gracias por ver el video.', 'Subtítulos realizados por la comunidad de Amara.org']) {
      expect(learnedLine(t), t).toBe(true)
      expect(keepSpeech(said(t), soundOf(beep()), false).text, t).toBe('')
      expect(keepSpeech(said(t), soundOf(noise()), false).text, t).toBe('')
    }
    // every line a learned one
    expect(keepSpeech({ text: 'Thank you. Thank you.', language: 'en', durationSec: 2, segments: [{ start: 0, end: 1, text: 'Thank you.' }, { start: 1, end: 2, text: 'Thank you.' }] }, soundOf(noise()), false).text).toBe('')
  })
  test('a person who says "Thank you", "yes" or "네" is kept', () => {
    expect(keepSpeech(said('Thank you.'), soundOf(speechLike(3)), false).text).toBe('Thank you.')
    expect(keepSpeech(said('Yes'), soundOf(speechLike(1)), false).text).toBe('Yes')
    expect(keepSpeech(said('네'), soundOf(speechLike(1)), false).text).toBe('네')
    // speech-like sound: kept even when whisper was unsure
    expect(keepSpeech(said('Yes'), soundOf(speechLike(1)), true).text).toBe('Yes')
    // a sentence that only starts like a learned line
    expect(learnedLine('Thank you for the report, see you tomorrow')).toBe(false)
    expect(keepSpeech(said('Thank you for the report'), soundOf(noise()), false).text).toBe('Thank you for the report')
  })
  test('weak sound and an unsure whisper: nothing (letters in a loop over a hum); a sure answer stays', () => {
    expect(keepSpeech(said('ḍ ḍ ḍ ḍ ḍ ḍ'), soundOf(noise(3, -50)), true).text).toBe('')
    expect(keepSpeech(said('ḍ ḍ ḍ ḍ ḍ ḍ'), soundOf(noise(3, -50)), false).text).toBe('ḍ ḍ ḍ ḍ ḍ ḍ')
    // no sound to look at (a format the server did not decode): learned lines only when whisper was unsure
    expect(keepSpeech(said('Thank you.'), null, false).text).toBe('Thank you.')
    expect(keepSpeech(said('Thank you.'), null, true).text).toBe('')
  })
})

describe("whisper's own signals", () => {
  // whisper.cpp 1.9 -ojf on digital silence (small model), and on "Thank you." spoken by macOS say (tiny model)
  const tok = (text: string, p: number) => ({ text, p, id: 1, t_dtw: -1 })
  const silenceJson = { result: { language: 'en' }, transcription: [{ offsets: { from: 0, to: 2000 }, text: ' you', tokens: [tok('[_BEG_]', 0.9), tok(' you', 0.14), tok('[_TT_100]', 0.1)] }] }
  const thanksJson = { result: { language: 'en' }, transcription: [{ offsets: { from: 0, to: 640 }, text: ' - Thank you.', tokens: [tok('[_BEG_]', 0.9), tok(' -', 0.02), tok(' Thank', 0.85), tok(' you', 0.99), tok('.', 0.91)] }] }
  test('whisper.cpp: the first word\'s probability (punctuation and its own tokens skipped)', () => {
    const r = parseWhisperJson(JSON.stringify(silenceJson))
    expect(r.text).toBe('you')
    expect(r.sure).toBeCloseTo(0.14, 3)
    expect(whisperUnsure(r)).toBe(true)
    expect(keepSpeech(r, soundOf(noise(2, -45)), whisperUnsure(r)).text).toBe('')
    const t = parseWhisperJson(JSON.stringify(thanksJson))
    expect(t.sure).toBeCloseTo(0.92, 3)
    expect(whisperUnsure(t)).toBe(false)
    expect(keepSpeech(t, soundOf(speechLike(3)), whisperUnsure(t)).text).toBe('- Thank you.')
    // CJK: whisper-cli keeps the probability of a character's first byte piece, which can be low on a word it was sure
    // of; the mean of the first three letters decides then (a loop over noise stays unsure: 0.06, 0.07, 0.84)
    const cjk = { result: { language: 'zh' }, transcription: [{ offsets: { from: 0, to: 900 }, text: ' 好的', tokens: [tok('[_BEG_]', 0.9), tok(' 好', 0.12), tok('的', 0.95), tok('。', 0.9)] }] }
    expect(whisperUnsure(parseWhisperJson(JSON.stringify(cjk)))).toBe(false)
    const loop = { result: { language: 'nn' }, transcription: [{ offsets: { from: 0, to: 3000 }, text: ' ḍ ḍ ḍ ḍ', tokens: [tok(' ḍ', 0.06), tok(' ḍ', 0.07), tok(' ḍ', 0.84), tok(' ḍ', 0.87)] }] }
    expect(whisperUnsure(parseWhisperJson(JSON.stringify(loop)))).toBe(true)
    const geo = { result: { language: 'nn' }, transcription: [{ offsets: { from: 0, to: 2000 }, text: ' ლლლ', tokens: [tok(' ლ', 0.08), tok('ლ', 0.48), tok('ლ', 0.84)] }] }
    expect(whisperUnsure(parseWhisperJson(JSON.stringify(geo)))).toBe(true)
    // -oj without tokens: no signal
    expect(whisperUnsure(parseWhisperJson(JSON.stringify({ transcription: [{ offsets: { from: 0, to: 1 }, text: ' hi' }] })))).toBe(false)
  })
  test('OpenRouter: a line whisper calls no speech is dropped; a high no_speech_prob or a low avg_logprob is unsure', () => {
    const seg = (text: string, no_speech_prob: number, avg_logprob: number) => ({ start: 0, end: 1, text, no_speech_prob, avg_logprob })
    const raw = parseOpenRouter({ text: ' Thank you. Send it', segments: [seg(' Thank you.', 0.9, -1.3), { ...seg(' Send it', 0.02, -0.2), start: 1, end: 2 }] }, { language: 'en', durationSec: 2 })
    // the parse keeps every line (a file read's transcript is not changed); voice input and meeting pieces drop it
    expect(raw.text).toBe('Thank you. Send it')
    expect(raw.segments).toHaveLength(2)
    const r = openRouterSpeech(raw, soundOf(speechLike(4)))
    expect(r.text).toBe('Send it')
    expect(r.segments).toEqual([{ start: 1, end: 2, text: 'Send it' }])
    // the least likely no-speech line: one line of silence after speech does not make the answer unsure
    expect(raw.noSpeech).toBe(0.02)
    const tail = parseOpenRouter({ text: 'Send it. Thank you.', segments: [seg('Send it.', 0.02, -0.2), { ...seg('Thank you.', 0.8, -0.6), start: 1, end: 2 }] }, { language: 'en', durationSec: 2 })
    expect(tail.noSpeech).toBe(0.02)
    expect(openRouterUnsure(tail)).toBe(false)
    expect(openRouterSpeech(tail, soundOf(beep())).text).toBe('Send it. Thank you.')
    // a hallucination whisper was fairly sure of: kept by the parse, dropped on a beep, kept on speech
    const h = parseOpenRouter({ text: 'Thank you.', segments: [seg('Thank you.', 0.7, -0.5)] }, { language: 'en', durationSec: 1 })
    expect(h.text).toBe('Thank you.')
    expect(openRouterUnsure(h)).toBe(true)
    expect(openRouterSpeech(h, soundOf(beep())).text).toBe('')
    expect(openRouterSpeech(h, soundOf(speechLike(3))).text).toBe('Thank you.')
    // words whisper was unsure of on noise
    const u = parseOpenRouter({ text: 'ლლლ', segments: [seg('ლლლ', 0.1, -0.9)] }, { language: null, durationSec: 2 })
    expect(openRouterUnsure(u)).toBe(true)
    expect(openRouterSpeech(u, soundOf(noise())).text).toBe('')
    // a provider without the fields: nothing changes
    expect(openRouterUnsure(parseOpenRouter({ text: 'hi' }, { language: null, durationSec: 1 }))).toBe(false)
  })
})
