// Voice input through OpenRouter (docs/DECISIONS.md "Voice input through OpenRouter"): the transcription job picks the
// team's speech provider; 'openrouter' sends the audio (base64 JSON, zero data retention requested, the model's providers) to
// a fake OpenRouter here (never the real one) and maps its answers and failures. No ffmpeg in most of these tests: wav
// goes as is. The answers of the long-recording language check are shaped like OpenRouter's recorded ones (plans
// stt-hosted-2026-11-01 results/: verbose_json segments with avg_logprob).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { componentC } from '../../server/src/team-files/component'
import { updateTeamSettings } from '../../server/src/admin/settings'
import { credentialsOf } from '../../server/src/credentials/store'
import { writeSpeechKey } from '../../server/src/credentials/speech-key'
import { ELEVENLABS_STT_PROVIDERS, OPENROUTER_MAX_BYTES, OPENROUTER_STT_PROVIDERS, openRouterRouting, parseOpenRouter, resetPlainJsonModelsForTests, speechProviders } from '../../server/src/jobs/openrouter-stt'
import { languageCode } from '../../server/src/jobs/speech-language'
import { setSetting } from '../../server/src/admin/settings'
import { makeCApp, type CApp } from '../lib/c-app'
import type { TranscribeConfig } from '../../server/src/jobs/transcribe'
import { which } from '../../server/src/config'
import { pieceWav } from '@mycel/shared/speech-pieces'

const KEY = 'sk-or-v1-FAKE-TEST-KEY-CANARY-0123456789abcdef'

let A: CApp
const C = () => componentC(A.ctx)
interface Hit { auth: string | null; body: any }
const hits: Hit[] = []
let reply: (body: any) => Response = () => Response.json({ text: 'hello' })
const fake = Bun.serve({
  port: 0, hostname: '127.0.0.1',
  async fetch(req) {
    const body = await req.json().catch(() => null)
    hits.push({ auth: req.headers.get('authorization'), body })
    return reply(body)
  },
})
let saved: { url: string; ffmpeg: string | null; mac: TranscribeConfig['mac'] }
beforeAll(async () => {
  A = await makeCApp('c-speech-or')
  const t = C().transcribe
  saved = { url: t.openRouterUrl, ffmpeg: t.ffmpegBin, mac: t.mac ?? null }
  t.openRouterUrl = `http://127.0.0.1:${fake.port}/api/v1/audio/transcriptions`
  t.ffmpegBin = null
  // a server without ffmpeg as on Linux (an Apple silicon Mac decodes with its own programs: mac-local-speech.test.ts)
  t.mac = null
  // the job speaks the person's language: English here, Korean in one test below
  A.ctx.db.query("UPDATE users SET locale = 'en' WHERE id = 'alice'").run()
})
afterAll(async () => {
  const t = C().transcribe
  t.openRouterUrl = saved.url
  t.ffmpegBin = saved.ffmpeg
  t.mac = saved.mac
  await A.close()
  fake.stop(true)
})
beforeEach(() => {
  hits.length = 0
  updateTeamSettings(A.ctx.db, { speechProvider: 'openrouter' })
  writeSpeechKey(credentialsOf(A.ctx), KEY)
})

const wav = (n = 3200) => { const b = new Uint8Array(n); b.set([0x52, 0x49, 0x46, 0x46]); return b }
async function run(bytes: Uint8Array, name = 'voice.wav', fields: Record<string, string> = {}) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  fd.set('file', new File([new Uint8Array(bytes)], name))
  const r = await A.json('/api/transcribe', { method: 'POST', body: fd, as: 'alice' })
  expect(r.status).toBe(202)
  return (await C().jobs.wait(r.body.jobId))!
}

describe('a recording with no speech (QA TC-4581): no stray word, "Nothing was recognized" in the app', () => {
  test('silence: nothing is sent, the job is done with no text', async () => {
    const job = await run(pieceWav(new Float32Array(3 * 16000)))
    expect(job.status, JSON.stringify(job.error)).toBe('done')
    expect((job.result as { text: string }).text).toBe('')
    expect(hits).toEqual([])
  })
  test('a beep heard as "Thank you." with a high no_speech_prob: no text', async () => {
    reply = () => Response.json({ text: ' Thank you.', language: 'en', duration: 1, segments: [{ start: 0, end: 1, text: ' Thank you.', avg_logprob: -0.5, no_speech_prob: 0.8 }] })
    try {
      const job = await run(pieceWav(Float32Array.from({ length: 16000 }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 1000 * i / 16000))))
      expect(job.status, JSON.stringify(job.error)).toBe('done')
      expect(job.result).toMatchObject({ text: '', segments: [] })
      expect(hits).toHaveLength(1)
    } finally { reply = () => Response.json({ text: 'hello' }) }
  })
})

describe('speech provider', () => {
  test("default 'off': the job fails at once and OpenRouter is not called", async () => {
    updateTeamSettings(A.ctx.db, { speechProvider: 'off' })
    const job = await run(wav())
    expect(job.status).toBe('failed')
    expect(job.error!.message).toContain('Voice input is off')
    expect(hits).toEqual([])
  })
  test('openrouter without a key: a clear failure, no call', async () => {
    writeSpeechKey(credentialsOf(A.ctx), null)
    const job = await run(wav())
    expect(job.status).toBe('failed')
    expect(job.error!.message).toContain('no OpenRouter key')
    expect(hits).toEqual([])
  })
})

describe('OpenRouter transcription', () => {
  test('the default model is Scribe v2: only ElevenLabs, zero data retention', async () => {
    reply = () => Response.json({ text: 'Hello team.', language: 'eng', duration: 1, segments: [{ start: 0, end: 1, text: 'Hello team.' }] })
    const job = await run(wav())
    expect(job.status, JSON.stringify(job.error)).toBe('done')
    expect(hits.length).toBe(1)
    expect(hits[0]!.body.model).toBe('elevenlabs/scribe-v2')
    expect(hits[0]!.body.provider).toMatchObject({ zdr: true, data_collection: 'deny', only: ['elevenlabs'] })
  })
  test('success with segments (whisper chosen in Team settings): the request carries the model, wav audio, language and zero data retention', async () => {
    updateTeamSettings(A.ctx.db, { speechModel: 'openai/whisper-large-v3-turbo' })
    try {
    reply = () => Response.json({ text: ' 안녕하세요. 회의를 시작합니다. ', language: 'korean', duration: 3.2, segments: [{ start: 0, end: 1.5, text: ' 안녕하세요.' }, { start: 1.6, end: 3.2, text: '회의를 시작합니다.' }], usage: { cost: 0.0005 } })
    const bytes = wav()
    const job = await run(bytes, 'voice.wav', { language: 'ko' })
    expect(job.status, JSON.stringify(job.error)).toBe('done')
    expect(job.result).toEqual({ text: '안녕하세요. 회의를 시작합니다.', language: 'ko', durationSec: 3.2, segments: [{ start: 0, end: 1.5, text: '안녕하세요.' }, { start: 1.6, end: 3.2, text: '회의를 시작합니다.' }] })
    expect(hits.length).toBe(1)
    const h = hits[0]!
    expect(h.auth).toBe(`Bearer ${KEY}`)
    // whisper turbo goes through DeepInfra then Groq
    expect(h.body.model).toBe('openai/whisper-large-v3-turbo')
    expect(h.body.input_audio.format).toBe('wav')
    expect(Buffer.from(h.body.input_audio.data, 'base64').equals(Buffer.from(bytes))).toBe(true)
    expect(h.body.language).toBe('ko')
    expect(h.body.response_format).toBe('verbose_json')
    expect(h.body.provider).toEqual({ zdr: true, data_collection: 'deny', order: ['deepinfra', 'groq'], only: ['deepinfra', 'groq'], allow_fallbacks: true })
    } finally { updateTeamSettings(A.ctx.db, { speechModel: 'elevenlabs/scribe-v2' }) }
  })
  test('Scribe v2 chosen in Team settings: only ElevenLabs, without audio-event tags (whisper\'s list gave 404)', async () => {
    updateTeamSettings(A.ctx.db, { speechModel: 'elevenlabs/scribe-v2' })
    try {
      reply = () => Response.json({ text: 'Hello team.', language: 'eng', duration: 1, segments: [{ start: 0, end: 1, text: 'Hello team.' }] })
      const job = await run(wav())
      expect(job.status, JSON.stringify(job.error)).toBe('done')
      expect(hits[0]!.body.model).toBe('elevenlabs/scribe-v2')
      expect(hits[0]!.body.provider).toEqual({ zdr: true, data_collection: 'deny', order: ['elevenlabs'], only: ['elevenlabs'], allow_fallbacks: true, options: { elevenlabs: { tag_audio_events: false } } })
    } finally { updateTeamSettings(A.ctx.db, { speechModel: 'openai/whisper-large-v3-turbo' }) }
  })
  test('the providers the request asks for are constants per model (whisper: DeepInfra first, Groq when it is down; Scribe: ElevenLabs)', () => {
    expect(OPENROUTER_STT_PROVIDERS).toEqual(['deepinfra', 'groq'])
    expect(ELEVENLABS_STT_PROVIDERS).toEqual(['elevenlabs'])
    expect(speechProviders('openai/whisper-large-v3-turbo')).toEqual(['deepinfra', 'groq'])
    expect(speechProviders('openai/whisper-large-v3')).toEqual(['deepinfra', 'groq'])
    expect(speechProviders('elevenlabs/scribe-v2')).toEqual(['elevenlabs'])
    // any other model: its own providers (whisper's list would leave OpenRouter no endpoint: 404)
    for (const m of ['openai/gpt-transcribe', 'google/gemini-3.5-transcribe', 'openai/whisper-1', 'openai/gpt-4o-transcribe']) {
      expect(speechProviders(m)).toBe(null)
      expect(openRouterRouting(m)).toEqual({ zdr: true, data_collection: 'deny' })
    }
    const w = 'openai/whisper-large-v3-turbo'
    expect(openRouterRouting(w)).toEqual({ zdr: true, data_collection: 'deny', order: ['deepinfra', 'groq'], only: ['deepinfra', 'groq'], allow_fallbacks: true })
    expect(openRouterRouting('elevenlabs/scribe-v2')).toEqual({ zdr: true, data_collection: 'deny', order: ['elevenlabs'], only: ['elevenlabs'], allow_fallbacks: true, options: { elevenlabs: { tag_audio_events: false } } })
    // a fresh copy each time: nobody can change the next request's list through it
    openRouterRouting(w).only!.push('openai')
    openRouterRouting(w).order!.push('openai')
    expect(openRouterRouting(w).only).toEqual(['deepinfra', 'groq'])
    expect(openRouterRouting(w).order).toEqual(['deepinfra', 'groq'])
    expect(OPENROUTER_STT_PROVIDERS).toEqual(['deepinfra', 'groq'])
  })
  test('a model that refuses verbose_json (400 naming it): the same request once more as json, and json from then on', async () => {
    resetPlainJsonModelsForTests()
    updateTeamSettings(A.ctx.db, { speechModel: 'elevenlabs/scribe-v2' })
    try {
      reply = (b) => (b?.response_format === 'verbose_json'
        ? Response.json({ error: { message: 'response_format verbose_json is not supported for this model' } }, { status: 400 })
        : Response.json({ text: 'Hello team.' }))
      const job = await run(wav(), 'voice.wav', { language: 'en' })
      expect(job.status, JSON.stringify(job.error)).toBe('done')
      expect((job.result as { text: string }).text).toBe('Hello team.')
      expect(hits.map((h) => h.body.response_format)).toEqual(['verbose_json', 'json'])
      // the language and the routing stay
      expect(hits[1]!.body.language).toBe('en')
      expect(hits[1]!.body.provider.only).toEqual(['elevenlabs'])
      hits.length = 0
      await run(wav())
      expect(hits.map((h) => h.body.response_format)).toEqual(['json'])
    } finally { resetPlainJsonModelsForTests(); updateTeamSettings(A.ctx.db, { speechModel: 'openai/whisper-large-v3-turbo' }) }
  })
  test('whisper: a 400 that does not name the answer format keeps verbose_json (one request, the usual failure)', async () => {
    resetPlainJsonModelsForTests()
    updateTeamSettings(A.ctx.db, { speechModel: 'openai/whisper-large-v3-turbo' })
    try {
      reply = () => Response.json({ error: { message: 'invalid audio' } }, { status: 400 })
      const job = await run(wav())
      expect(job.status).toBe('failed')
      expect(job.error!.message).toContain('HTTP 400')
      expect(hits.map((h) => h.body.response_format)).toEqual(['verbose_json'])
      hits.length = 0
      reply = () => Response.json({ text: 'Hello team.' })
      await run(wav())
      expect(hits.map((h) => h.body.response_format)).toEqual(['verbose_json'])
    } finally { updateTeamSettings(A.ctx.db, { speechModel: 'openai/whisper-large-v3-turbo' }) }
  })
  test('another model: any 400 to verbose_json goes once more as json; json is kept only after an answer', async () => {
    resetPlainJsonModelsForTests()
    updateTeamSettings(A.ctx.db, { speechModel: 'openai/gpt-transcribe' })
    try {
      // a bad sound: both fail, nothing remembered
      reply = () => Response.json({ error: { message: 'invalid audio' } }, { status: 400 })
      expect((await run(wav())).status).toBe('failed')
      expect(hits.map((h) => h.body.response_format)).toEqual(['verbose_json', 'json'])
      expect(hits[0]!.body.provider).toEqual({ zdr: true, data_collection: 'deny' })
      hits.length = 0
      // a model without structured answers, whatever its error says
      reply = (b) => (b?.response_format === 'verbose_json' ? Response.json({ error: { message: 'Provider returned error' } }, { status: 400 }) : Response.json({ text: 'Hello team.' }))
      const job = await run(wav())
      expect(job.status, JSON.stringify(job.error)).toBe('done')
      expect(hits.map((h) => h.body.response_format)).toEqual(['verbose_json', 'json'])
      hits.length = 0
      await run(wav())
      expect(hits.map((h) => h.body.response_format)).toEqual(['json'])
    } finally { resetPlainJsonModelsForTests(); updateTeamSettings(A.ctx.db, { speechModel: 'openai/whisper-large-v3-turbo' }) }
  })
  test('404 (no zero-data-retention endpoint for the model, or no such model): a clear failure naming another model, no second try', async () => {
    updateTeamSettings(A.ctx.db, { speechModel: 'google/gemini-3.5-transcribe' })
    try {
      reply = () => Response.json({ error: { message: 'No endpoints found matching your data policy' } }, { status: 404 })
      const job = await run(wav())
      expect(job.status).toBe('failed')
      expect(job.error!.message).toContain('zero data retention')
      expect(job.error!.message).toContain('elevenlabs/scribe-v2')
      expect(hits.length).toBe(1)
    } finally { updateTeamSettings(A.ctx.db, { speechModel: 'openai/whisper-large-v3-turbo' }) }
  })
  test('a Scribe answer without whisper scores: the text is kept and nothing is sent twice', async () => {
    updateTeamSettings(A.ctx.db, { speechModel: 'elevenlabs/scribe-v2' })
    try {
      reply = () => Response.json({ text: '안녕하세요. 회의를 시작합니다.', language: 'kor', duration: 3.2, segments: [{ start: 0, end: 3.2, text: '안녕하세요. 회의를 시작합니다.' }] })
      const job = await run(wav())
      expect(job.status, JSON.stringify(job.error)).toBe('done')
      expect(job.result).toEqual({ text: '안녕하세요. 회의를 시작합니다.', language: 'ko', durationSec: 3.2, segments: [{ start: 0, end: 3.2, text: '안녕하세요. 회의를 시작합니다.' }] })
      expect(hits.length).toBe(1)
    } finally { updateTeamSettings(A.ctx.db, { speechModel: 'openai/whisper-large-v3-turbo' }) }
  })
  test('the answer\'s language as whisper\'s code: Groq\'s "Korean" / "English" are ko / en', async () => {
    expect(['Korean', 'English', 'japanese', ' Chinese ', 'ko', 'EN', 'haw', 'Cantonese', 'Mandarin'].map(languageCode)).toEqual(['ko', 'en', 'ja', 'zh', 'ko', 'en', 'haw', 'yue', 'zh'])
    // ElevenLabs Scribe names it in ISO 639-3
    expect(['kor', 'ENG', 'ind', 'jpn', 'cmn', 'yue', 'zsm'].map(languageCode)).toEqual(['ko', 'en', 'id', 'ja', 'zh', 'yue', 'ms'])
    expect([null, 5, '', 'Klingon', 'ko-KR'].map(languageCode)).toEqual([null, null, null, null, null])
    reply = () => Response.json({ text: 'Hello team.', language: 'English', duration: 1, segments: [{ start: 0, end: 1, text: 'Hello team.' }] })
    const job = await run(wav())
    expect((job.result as { language: string }).language).toBe('en')
    // a name it does not know: the language it was told, else none
    reply = () => Response.json({ text: 'Hello team.', language: 'Klingon' })
    expect(((await run(wav(), 'voice.wav', { language: 'en' })).result as { language: string | null }).language).toBe('en')
    expect(((await run(wav())).result as { language: string | null }).language).toBe(null)
  })
  test('success without segments: one segment with the whole text; the team model setting is used', async () => {
    updateTeamSettings(A.ctx.db, { speechModel: 'openai/whisper-1' })
    try {
      reply = () => Response.json({ text: 'Hello team.' })
      const job = await run(wav(), 'memo.m4a')
      expect(job.status, JSON.stringify(job.error)).toBe('done')
      expect(job.result).toEqual({ text: 'Hello team.', language: null, durationSec: null, segments: [{ start: 0, end: 0, text: 'Hello team.' }] })
      expect(hits[0]!.body.model).toBe('openai/whisper-1')
      expect(hits[0]!.body.input_audio.format).toBe('m4a')
      expect('language' in hits[0]!.body).toBe(false)
    } finally { updateTeamSettings(A.ctx.db, { speechModel: 'openai/whisper-large-v3-turbo' }) }
  })
  test('401 bad key, 402 no credits, 429 rate limited, 5xx provider down (tried twice): localized failures without the key', async () => {
    const cases: [number, string, number][] = [[401, 'refused the key', 1], [402, 'no credits', 1], [429, 'Too many requests', 1], [503, 'did not answer, twice', 2]]
    for (const [status, words, tries] of cases) {
      hits.length = 0
      reply = () => Response.json({ error: { message: 'nope ' + KEY } }, { status })
      const job = await run(wav())
      expect(job.status).toBe('failed')
      expect(job.error!.message).toContain(words)
      expect(JSON.stringify(job)).not.toContain(KEY)
      expect(hits.length).toBe(tries)
    }
  })
  test('the job speaks the person\'s language (ko)', async () => {
    A.ctx.db.query("UPDATE users SET locale = 'ko' WHERE id = 'alice'").run()
    try {
      reply = () => Response.json({}, { status: 401 })
      const job = await run(wav())
      expect(job.error!.message).toContain('OpenRouter가 키를 거부했어요')
    } finally { A.ctx.db.query("UPDATE users SET locale = 'en' WHERE id = 'alice'").run() }
  })
  test('audio over 25 MB is refused before anything is sent', async () => {
    const job = await run(new Uint8Array(OPENROUTER_MAX_BYTES + 1024))
    expect(job.status).toBe('failed')
    expect(job.error!.message).toContain('too long')
    expect(hits).toEqual([])
  })
  test('without ffmpeg, a browser recording (webm) needs ffmpeg: clear failure, no call', async () => {
    const job = await run(wav(), 'voice.webm')
    expect(job.status).toBe('failed')
    expect(job.error!.message).toContain('needs ffmpeg')
    expect(hits).toEqual([])
    expect(fs.readdirSync(`${A.data}/work`).filter((f) => f.startsWith('stt-'))).toEqual([])
  })
  test('the production path: a webm recording goes through ffmpeg (isolated) as 16 kHz wav, then FLAC; duration from the wav', async () => {
    const ffmpeg = which('ffmpeg')
    if (!ffmpeg) { console.log('ffmpeg missing: the conversion path is not tested here'); return }
    const src = `${A.data}/tone.webm`
    const made = Bun.spawnSync([ffmpeg, '-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libopus', src])
    if (made.exitCode !== 0) { console.log('ffmpeg could not make a webm/opus sample: the conversion path is not tested here'); return }
    const t = C().transcribe
    t.ffmpegBin = ffmpeg
    try {
      reply = () => Response.json({ text: 'beep' })
      const job = await run(new Uint8Array(fs.readFileSync(src)), 'voice.webm')
      expect(job.status, JSON.stringify(job.error)).toBe('done')
      expect(hits[0]!.body.input_audio.format).toBe('flac')
      expect(Buffer.from(hits[0]!.body.input_audio.data, 'base64').subarray(0, 4).toString()).toBe('fLaC')
      // nothing of the work folder is left
      expect(fs.readdirSync(`${A.data}/work`).filter((f) => f.startsWith('stt-'))).toEqual([])
      const r = job.result as { durationSec: number; segments: { end: number }[] }
      expect(r.durationSec).toBeGreaterThan(0.8)
      expect(r.durationSec).toBeLessThan(1.3)
      expect(r.segments[0]!.end).toBe(r.durationSec)
    } finally { t.ffmpegBin = null }
  })
  test('answer parsing: odd fields are ignored', () => {
    expect(parseOpenRouter({ text: 5, segments: 'x' }, { language: 'en', durationSec: 2 })).toEqual({ text: '', language: 'en', durationSec: 2, segments: [] })
    expect(parseOpenRouter({ text: 'a', duration: -1 }, { language: null, durationSec: 1.5 })).toEqual({ text: 'a', language: null, durationSec: 1.5, segments: [{ start: 0, end: 1.5, text: 'a' }] })
  })
})

/** an OpenRouter answer of `seconds` in lines of 10 s, whisper `sure` of its words (avg_logprob) */
const answer = (language: string, text: (i: number) => string, avg_logprob: number, seconds = 600) => ({
  text: '', language, duration: seconds, usage: { seconds, cost: seconds * 0.0000033 },
  segments: Array.from({ length: seconds / 10 }, (_, i) => ({ id: i, start: i * 10, end: i * 10 + 9.5, text: ` ${text(i)}`, avg_logprob, compression_ratio: 1.2, no_speech_prob: 0 })),
})
describe('a long recording heard in an unlikely language (whisper decides from its first 30 seconds)', () => {
  beforeAll(() => setSetting(A.ctx.db, 'defaultLocale', 'ko'))
  afterAll(() => setSetting(A.ctx.db, 'defaultLocale', 'en'))
  // what DeepInfra did with the QA meeting: Korean speech heard as Japanese, written in Japanese (avg_logprob -0.93);
  // told "ko", Korean (-0.19)
  const meeting = (b: any) => b.language === 'ko' ? answer('ko', (i) => `구간 ${i}입니다.`, -0.19) : answer('ja', (i) => `区間${i}です。`, -0.93)

  test('10 minutes heard as Japanese on a Korean team: sent once more told "ko", the answer whisper is surer of is kept, the told language not reported', async () => {
    reply = (b) => Response.json(meeting(b))
    const job = await run(wav(600 * 32_000))
    expect(job.status, JSON.stringify(job.error)).toBe('done')
    expect(hits.map((h) => h.body.language ?? 'auto')).toEqual(['auto', 'ko'])
    expect(hits[0]!.body.input_audio.data).toBe(hits[1]!.body.input_audio.data)
    const r = job.result as { text: string; language: string | null; segments: { text: string }[] }
    expect(r.segments[0]!.text).toBe('구간 0입니다.')
    expect(r.language).toBe(null)
    // nothing of how sure whisper was, or which request it was, in the job's result
    expect(Object.keys(r).sort()).toEqual(['durationSec', 'language', 'segments', 'text'])
  })
  test('a Japanese recording on a Korean team: the retry is less sure (it kept writing Japanese), so the Japanese answer stays', async () => {
    reply = (b) => Response.json(b.language === 'ko' ? answer('ko', (i) => `会議${i}です。`, -0.24, 90) : answer('ja', (i) => `会議${i}です。`, -0.12, 90))
    const job = await run(wav(90 * 32_000))
    expect(hits.length).toBe(2)
    expect((job.result as { language: string }).language).toBe('ja')
  })
  test('no retry: a short recording, English heard with sure words, the team\'s own language, or a language the person gave', async () => {
    reply = () => Response.json(answer('ja', (i) => `区間${i}です。`, -0.93, 50))
    await run(wav(50 * 32_000))
    expect(hits.length).toBe(1)
    hits.length = 0
    reply = () => Response.json(answer('en', (i) => `Section ${i}.`, -0.08))
    await run(wav(600 * 32_000))
    expect(hits.length).toBe(1)
    hits.length = 0
    reply = () => Response.json(answer('ko', (i) => `구간 ${i}입니다.`, -0.6))
    await run(wav(600 * 32_000))
    expect(hits.length).toBe(1)
    hits.length = 0
    reply = (b) => Response.json(meeting(b))
    await run(wav(600 * 32_000), 'voice.wav', { language: 'ja' })
    expect(hits.map((h) => h.body.language)).toEqual(['ja'])
  })
  test('English that whisper was unsure of is checked; a retry that drops what it found hard does not win by it', async () => {
    // the QA meeting's last piece: heard as English (-0.48, a Korean part translated); told "ko" -0.23, but 55 s of its
    // English left out: over the whole time that is no surer, so whisper's own guess stays
    const dropped = (seconds: number) => { const a = answer('ko', (i) => `구간 ${i}입니다.`, -0.23); a.segments = a.segments.slice(0, seconds / 10); return a }
    reply = (b) => Response.json(b.language === 'ko' ? dropped(400) : answer('en', (i) => `Section ${i}.`, -0.48))
    let job = await run(wav(600 * 32_000))
    expect(hits.length).toBe(2)
    expect((job.result as { language: string }).language).toBe('en')
    // the same retry covering all of it is surer by more than the margin: kept
    hits.length = 0
    reply = (b) => Response.json(b.language === 'ko' ? dropped(600) : answer('en', (i) => `Section ${i}.`, -0.48))
    job = await run(wav(600 * 32_000))
    expect(hits.length).toBe(2)
    expect((job.result as { language: string | null }).language).toBe(null)
    expect((job.result as { segments: { text: string }[] }).segments[0]!.text).toBe('구간 0입니다.')
  })
  test('a retry that fails keeps the first answer; a retry that only says "(foreign language)" is not taken', async () => {
    reply = (b) => b.language === 'ko' ? Response.json({ error: 'busy' }, { status: 503 }) : Response.json(meeting(b))
    let job = await run(wav(600 * 32_000))
    expect(job.status).toBe('done')
    expect((job.result as { language: string }).language).toBe('ja')
    hits.length = 0
    reply = (b) => Response.json(b.language === 'ko' ? answer('ko', () => '(speaking in foreign language)', -0.05) : meeting(b))
    job = await run(wav(600 * 32_000))
    expect(hits.length).toBe(2)
    expect((job.result as { language: string }).language).toBe('ja')
  })
})
