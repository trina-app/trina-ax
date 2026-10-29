// Voice input through OpenRouter (docs/DECISIONS.md "Voice input through OpenRouter"): the transcription job picks the
// team's speech provider; 'openrouter' sends the audio (base64 JSON, zero data retention requested) to a fake
// OpenRouter here (never the real one) and maps its answers and failures. No ffmpeg in these tests: wav goes as is.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { componentC } from '../../server/src/team-files/component'
import { updateTeamSettings } from '../../server/src/admin/settings'
import { credentialsOf } from '../../server/src/credentials/store'
import { writeSpeechKey } from '../../server/src/credentials/speech-key'
import { OPENROUTER_MAX_BYTES, parseOpenRouter } from '../../server/src/jobs/openrouter-stt'
import { makeCApp, type CApp } from '../lib/c-app'
import { which } from '../../server/src/config'

const KEY = 'sk-or-v1-FAKE-TEST-KEY-CANARY-0123456789abcdef'

let A: CApp
const C = () => componentC(A.ctx)
interface Hit { auth: string | null; body: any }
const hits: Hit[] = []
let reply: () => Response = () => Response.json({ text: 'hello' })
const fake = Bun.serve({
  port: 0, hostname: '127.0.0.1',
  async fetch(req) {
    hits.push({ auth: req.headers.get('authorization'), body: await req.json().catch(() => null) })
    return reply()
  },
})
let saved: { url: string; ffmpeg: string | null }
beforeAll(async () => {
  A = await makeCApp('c-speech-or')
  const t = C().transcribe
  saved = { url: t.openRouterUrl, ffmpeg: t.ffmpegBin }
  t.openRouterUrl = `http://127.0.0.1:${fake.port}/api/v1/audio/transcriptions`
  t.ffmpegBin = null
  // the job speaks the person's language: English here, Korean in one test below
  A.ctx.db.query("UPDATE users SET locale = 'en' WHERE id = 'alice'").run()
})
afterAll(async () => {
  const t = C().transcribe
  t.openRouterUrl = saved.url
  t.ffmpegBin = saved.ffmpeg
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
  test('success with segments: the request carries the model, wav audio, language and zero data retention', async () => {
    reply = () => Response.json({ text: ' 안녕하세요. 회의를 시작합니다. ', language: 'korean', duration: 3.2, segments: [{ start: 0, end: 1.5, text: ' 안녕하세요.' }, { start: 1.6, end: 3.2, text: '회의를 시작합니다.' }], usage: { cost: 0.0005 } })
    const bytes = wav()
    const job = await run(bytes, 'voice.wav', { language: 'ko' })
    expect(job.status, JSON.stringify(job.error)).toBe('done')
    expect(job.result).toEqual({ text: '안녕하세요. 회의를 시작합니다.', language: 'korean', durationSec: 3.2, segments: [{ start: 0, end: 1.5, text: '안녕하세요.' }, { start: 1.6, end: 3.2, text: '회의를 시작합니다.' }] })
    expect(hits.length).toBe(1)
    const h = hits[0]!
    expect(h.auth).toBe(`Bearer ${KEY}`)
    expect(h.body.model).toBe('openai/whisper-large-v3-turbo')
    expect(h.body.input_audio.format).toBe('wav')
    expect(Buffer.from(h.body.input_audio.data, 'base64').equals(Buffer.from(bytes))).toBe(true)
    expect(h.body.language).toBe('ko')
    expect(h.body.response_format).toBe('verbose_json')
    expect(h.body.provider).toEqual({ zdr: true, data_collection: 'deny' })
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
  test('401 bad key, 402 no credits, 429 rate limited, 5xx provider down: localized failures without the key', async () => {
    const cases: [number, string][] = [[401, 'refused the key'], [402, 'no credits'], [429, 'Too many requests'], [503, 'not reachable']]
    for (const [status, words] of cases) {
      reply = () => Response.json({ error: { message: 'nope ' + KEY } }, { status })
      const job = await run(wav())
      expect(job.status).toBe('failed')
      expect(job.error!.message).toContain(words)
      expect(JSON.stringify(job)).not.toContain(KEY)
    }
  })
  test('the job speaks the person\'s language (ko)', async () => {
    A.ctx.db.query("UPDATE users SET locale = 'ko' WHERE id = 'alice'").run()
    try {
      reply = () => Response.json({}, { status: 401 })
      const job = await run(wav())
      expect(job.error!.message).toContain('OpenRouter가 키를 거부했습니다')
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
  test('the production path: a webm recording goes through ffmpeg (isolated) as 16 kHz wav; duration from the wav', async () => {
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
      expect(hits[0]!.body.input_audio.format).toBe('wav')
      expect(Buffer.from(hits[0]!.body.input_audio.data, 'base64').subarray(0, 4).toString()).toBe('RIFF')
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
