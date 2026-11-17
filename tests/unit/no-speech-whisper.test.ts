// Voice input on silence, noise or a beep with the real whisper-cli (QA TC-4581): a recording with no speech gives no
// text (the app says "Nothing was recognized"), a spoken "Thank you" is kept. Before the fix whisper.cpp 1.9 wrote, with
// the tiny model, "Thank you for watching!" over white noise at -35 dBFS, and with the small model "you" over digital
// silence, "(beep)" over a beep and a loop of one letter over noise. The tiny model (tests/.cache/whisper, downloaded
// once); skipped without whisper-cli (MYCEL_TEST_WHISPER_BIN or one on PATH), so not in CI.
import { beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pieceWav } from '@mycel/shared/speech-pieces'
import { which } from '../../server/src/config'
import { ensureModel, transcribe, transcribeConfig, WHISPER_MODELS, type TranscribeConfig } from '../../server/src/jobs/transcribe'
import type { JobHandle } from '../../server/src/services'

setDefaultTimeout(180_000)
const whisperBin = process.env.MYCEL_TEST_WHISPER_BIN || which('whisper-cli')
const CACHE = path.resolve(import.meta.dir, '..', '.cache', 'whisper')
const T = whisperBin ? describe : describe.skip
if (!whisperBin) console.log('no whisper-cli: no-speech-whisper tests skipped')

let dir: string
let cfg: TranscribeConfig
const h = (): JobHandle => ({ id: 'j', signal: new AbortController().signal, progress: () => {} })
const db = (d: number) => 10 ** (d / 20)
const write = (name: string, f: (i: number) => number, sec: number) => {
  fs.writeFileSync(path.join(dir, name), pieceWav(Float32Array.from({ length: Math.round(sec * 16000) }, (_, i) => f(i))))
  return name
}
const text = async (name: string) => (await transcribe(cfg, path.join(dir, name), name, { locale: 'en' }, h())).text

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-speech-whisper-'))
  if (!whisperBin) return
  const base = transcribeConfig(dir, {})
  if (!fs.existsSync(path.join(CACHE, WHISPER_MODELS.tiny.file))) await ensureModel({ ...base, modelDir: CACHE, model: 'tiny' })
  // whisper-cli reads the WAV itself (no ffmpeg, no macOS decoder): the server checks the sound of that WAV
  cfg = { ...base, whisperBin, ffmpegBin: null, mac: null, modelDir: CACHE, sharedModelDir: null, model: 'tiny', workBase: path.join(dir, 'work') }
})

T('voice input with no speech, whisper-cli for real', () => {
  test('silence, a beep, a chime and white noise: no text', async () => {
    let seed = 11
    const r = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1 }
    expect(await text(write('silence.wav', () => 0, 2))).toBe('')
    expect(await text(write('beep.wav', (i) => db(-6) * Math.sin(2 * Math.PI * 1000 * i / 16000), 1))).toBe('')
    expect(await text(write('chime.wav', (i) => 0.5 * Math.exp(-3 * i / 16000) * Math.sin(2 * Math.PI * 880 * i / 16000), 1.5))).toBe('')
    expect(await text(write('noise.wav', () => 0.05 * r(), 2))).toBe('')
  })
  test.skipIf(!fs.existsSync('/usr/bin/say') || !fs.existsSync('/usr/bin/afconvert'))('a spoken "Thank you" and a sentence are kept', async () => {
    for (const [words, want] of [['Thank you.', /thank you/i], ['Please send me the report from the meeting.', /report/i]] as const) {
      const aiff = path.join(dir, 'said.aiff')
      expect(Bun.spawnSync(['/usr/bin/say', '-o', aiff, words]).exitCode).toBe(0)
      expect(Bun.spawnSync(['/usr/bin/afconvert', '-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, path.join(dir, 'said.wav')]).exitCode).toBe(0)
      expect(await text('said.wav')).toMatch(want)
    }
  })
})
