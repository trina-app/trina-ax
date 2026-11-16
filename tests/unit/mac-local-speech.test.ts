// Voice input and the AI's reads of recordings on an Apple silicon Mac with no ffmpeg and no key
// (docs/decisions/20261116-mac-local-speech.md), with the real programs: `say` speaks Korean, afconvert makes the m4a /
// mp4 / caf (ffmpeg, where this Mac has it, makes the mp3 and a video with a picture), macOS's afinfo / afconvert /
// avconvert decode it in the converter sandbox, and the real whisper-cli (the office zip's build when it is in
// dist/mac-whisper/, else MYCEL_TEST_WHISPER_BIN or one on PATH) with the tiny model (tests/.cache/whisper) writes it
// down. Apple silicon only; skipped elsewhere and without whisper-cli.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { which } from '../../server/src/config'
import { getTeamSettings, setLocalSpeechReady, setSetting, SPEECH_KEY_SETTING, updateTeamSettings } from '../../server/src/admin/settings'
import { macAudioTools, macDecode, macWavPiece } from '../../server/src/jobs/mac-audio'
import { ensureModel, transcribe, WHISPER_MODELS, type TranscribeConfig } from '../../server/src/jobs/transcribe'
import * as media from '../../server/src/files/media'
import type { JobHandle } from '../../server/src/services'
import { makeCApp, type CApp } from '../lib/c-app'

setDefaultTimeout(180_000)
const REPO = path.resolve(import.meta.dir, '..', '..')
const mac = macAudioTools()
const built = path.join(REPO, 'dist', 'mac-whisper', 'whisper-cli')
const whisperBin = process.env.MYCEL_TEST_WHISPER_BIN || (fs.existsSync(built) ? built : which('whisper-cli'))
const sayOk = process.platform === 'darwin' && fs.existsSync('/usr/bin/say')
const T = mac && whisperBin && sayOk ? describe : describe.skip
if (!mac) console.log('not an Apple silicon Mac: mac-local-speech tests skipped')
else if (!whisperBin) console.log('no whisper-cli (bash scripts/macos/build-whisper.sh --out dist/mac-whisper): mac-local-speech tests skipped')
const CACHE = path.resolve(import.meta.dir, '..', '.cache', 'whisper')
const ffmpeg = which('ffmpeg')

let A: CApp
let dir: string
/** the config of these tests: this Mac's decoders, never ffmpeg, the tiny model */
let cfg: TranscribeConfig
const h = (): JobHandle => ({ id: 'j', signal: new AbortController().signal, progress: () => {} })
const run = (argv: string[]) => { const r = Bun.spawnSync(argv); if (r.exitCode !== 0) throw new Error(`${argv[0]}: ${r.stderr.toString()}`) }
/** 토요일 배송, 볼펜 샘플, 종이 20박스 (the AI scenario VIEW-08's call) in Korean, or English without the Korean voice */
const voice = () => (Bun.spawnSync(['/usr/bin/say', '-v', '?']).stdout.toString().includes('Yuna') ? 'ko' : 'en')
const SAY = { ko: ['-v', 'Yuna', '토요일에 배송 가능한지 물어봤고 볼펜 샘플은 다음 주 화요일까지 보내 주시기로 했습니다. 종이는 20박스로 확정했어요.'], en: ['Saturday delivery is fine, the pen samples come next Tuesday, and twenty boxes of paper are confirmed.'] }
// the tiny model: 토요일 can come out 소요일, so any weekday or the 20 boxes count
const HEARD = { ko: /요일|박스/, en: /saturday|tuesday|boxes/i }
let lang: 'ko' | 'en' = 'en'

beforeAll(async () => {
  A = await makeCApp('mac-local-speech')
  dir = path.join(A.data, 'fixtures')
  fs.mkdirSync(dir, { recursive: true })
  if (!mac || !whisperBin || !sayOk) return
  if (!fs.existsSync(path.join(CACHE, WHISPER_MODELS.tiny.file))) await ensureModel({ ...A.ctx.files.speech, modelDir: CACHE, model: 'tiny' })
  cfg = { ...A.ctx.files.speech, whisperBin, ffmpegBin: null, mac, modelDir: CACHE, sharedModelDir: null, model: 'tiny', workBase: path.join(A.data, 'work') }
  lang = voice()
  run(['/usr/bin/say', '-o', path.join(dir, 'memo.aiff'), ...SAY[lang]])
  run(['/usr/bin/afconvert', '-f', 'm4af', '-d', 'aac', path.join(dir, 'memo.aiff'), path.join(dir, 'memo.m4a')])
  // an mp4 and a caf with the sound alone (afconvert writes no picture)
  run(['/usr/bin/afconvert', '-f', 'mp4f', '-d', 'aac', path.join(dir, 'memo.aiff'), path.join(dir, 'memo.mp4')])
  run(['/usr/bin/afconvert', '-f', 'caff', '-d', 'LEI16', path.join(dir, 'memo.aiff'), path.join(dir, 'memo.caf')])
  // afconvert does not write mp3; ffmpeg (Homebrew, here only to make the files) makes it and a video with a picture,
  // one with Opus sound that only avconvert takes out, and one with no sound
  if (ffmpeg) {
    const f = (out: string, args: string[]) => run([ffmpeg, '-nostdin', '-loglevel', 'error', '-y', ...args, path.join(dir, out)])
    f('memo.mp3', ['-i', path.join(dir, 'memo.aiff')])
    f('call.mov', ['-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=12', '-i', path.join(dir, 'memo.aiff'), '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'])
    f('opus.mp4', ['-f', 'lavfi', '-i', 'color=c=red:s=160x120:d=12', '-i', path.join(dir, 'memo.aiff'), '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'libopus'])
    f('silent.mp4', ['-f', 'lavfi', '-i', 'color=c=red:s=160x120:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'])
  }
})
afterAll(async () => { setLocalSpeechReady(false); await A.close() })

T('voice input on this Mac: say -> afconvert -> transcribe with whisper-cli', () => {
  for (const f of ['memo.m4a', 'memo.mp4', 'memo.caf', 'memo.mp3']) {
    test(f, async () => {
      if (!fs.existsSync(path.join(dir, f))) { console.log(`${f} not made (no ffmpeg here)`); return }
      const r = await transcribe(cfg, path.join(dir, f), f, { language: lang, locale: 'en' }, h())
      expect(r.text).toMatch(HEARD[lang])
      expect(r.durationSec!).toBeGreaterThan(5)
    })
  }
  test('a browser\'s webm is refused in plain words (the web app sends WAV to this Mac)', async () => {
    fs.writeFileSync(path.join(dir, 'voice.webm'), Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]))
    await expect(transcribe(cfg, path.join(dir, 'voice.webm'), 'voice.webm', { locale: 'en' }, h())).rejects.toMatchObject({ messages: { en: expect.stringContaining("can't be read here") } })
  })
  test('the decode runs in the converter sandbox: nothing is left in the job\'s work folders', async () => {
    const before = fs.existsSync(cfg.workBase) ? fs.readdirSync(cfg.workBase) : []
    await transcribe(cfg, path.join(dir, 'memo.m4a'), 'memo.m4a', { language: lang, locale: 'en' }, h())
    expect(fs.readdirSync(cfg.workBase)).toEqual(before)
  })
})

T('decoding and cutting with the real programs', () => {
  test('a video afconvert cannot open goes through avconvert; one with no sound is named', async () => {
    for (const [f, want] of [['call.mov', 'ok'], ['opus.mp4', 'ok'], ['silent.mp4', 'media_mac_no_sound']] as const) {
      if (!fs.existsSync(path.join(dir, f))) continue
      const w = media.mediaWork(path.join(A.data, 'work'))
      try {
        fs.copyFileSync(path.join(dir, f), path.join(w, `in${path.extname(f)}`))
        const got = await macDecode(mac!, w, `in${path.extname(f)}`, 'full.wav', { timeoutMs: 60_000, maxSeconds: 3600 }).then(() => 'ok', (e) => e.code)
        expect({ f, got }).toEqual({ f, got: want })
        if (want === 'ok') expect(macWavPiece(w, 'full.wav', 0, 30)!.length).toBeGreaterThan(44 + 8 * 32_000)
      } finally { media.dropWork(w) }
    }
  })
})

T('the AI reads a voice memo and a video on this Mac (VIEW-08), nothing to install, no key', () => {
  test('not chosen reads "this Mac" once local is ready here; a saved key and an admin\'s choice win', () => {
    A.ctx.db.query("DELETE FROM settings WHERE key = 'speechProvider'").run()
    expect(getTeamSettings(A.ctx.db).speechProvider).toBe('off')
    setLocalSpeechReady(true)
    expect(getTeamSettings(A.ctx.db).speechProvider).toBe('local')
    updateTeamSettings(A.ctx.db, { speechProvider: 'off' })
    expect(getTeamSettings(A.ctx.db).speechProvider).toBe('off')
    A.ctx.db.query("DELETE FROM settings WHERE key = 'speechProvider'").run()
    // a team that saved its OpenRouter key keeps OpenRouter after the update (the key turned voice input on)
    setSetting(A.ctx.db, SPEECH_KEY_SETTING, { enc: 'x', keyVersion: 1, hint: 'abcd', updatedAt: new Date().toISOString() })
    expect(getTeamSettings(A.ctx.db).speechProvider).toBe('openrouter')
    A.ctx.db.query('DELETE FROM settings WHERE key = ?').run(SPEECH_KEY_SETTING)
    expect(getTeamSettings(A.ctx.db).speechProvider).toBe('local')
  })
  for (const [f, kind] of [['통화메모.m4a', 'Audio'], ['call.mov', 'Video']] as const) {
    test(`${f}: the transcript, and a video says its pictures are not read`, async () => {
      const src = path.join(dir, f === 'call.mov' ? 'call.mov' : 'memo.m4a')
      if (!fs.existsSync(src)) { console.log(`${f} not made (no ffmpeg here)`); return }
      fs.mkdirSync(path.join(A.team, 'users/alice'), { recursive: true })
      fs.copyFileSync(src, path.join(A.team, 'users/alice', f))
      A.ctx.db.query("UPDATE users SET locale = 'en' WHERE id = 'alice'").run()
      setLocalSpeechReady(true)
      updateTeamSettings(A.ctx.db, { aiMediaTranscripts: true })
      const saved = { ...A.ctx.files.speech }
      Object.assign(A.ctx.files.speech, { whisperBin, ffmpegBin: null, mac, modelDir: CACHE, sharedModelDir: null, model: 'tiny' })
      const tools = spyOn(A.ctx.files, 'mediaTools')
      try {
        const out = await A.ctx.files.call('read', { file_path: `users/alice/${f}` }, A.toolCtx('alice', A.turn('alice', A.chat('alice'))))
        expect(tools.mock.results[0]!.value).toEqual({ mac })
        expect(out.isError, out.text).toBeFalsy()
        expect(out.text).toContain(`${kind} users/alice/${f}:`)
        expect(out.text).toContain('Automatic transcript')
        expect(out.text).toMatch(HEARD[lang])
        if (kind === 'Video') expect(out.text).toContain('Only the sound of this video was read')
        expect((out.content ?? []).filter((c) => c.type === 'image')).toEqual([])
        expect(fs.readdirSync(path.join(A.data, 'work')).filter((x) => x.startsWith('vid-'))).toEqual([])
      } finally { tools.mockRestore(); Object.assign(A.ctx.files.speech, saved) }
    })
  }
})
