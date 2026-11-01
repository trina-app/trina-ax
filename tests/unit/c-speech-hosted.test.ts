// Hosted speech-to-text (docs/DECISIONS.md "Hosted speech-to-text"): the hosting service's OpenRouter key arrives with
// mycel-ctl hosted-speech-key-set (admin.js hosted-speech-key), turns voice input on by default and "Turn video sound
// into text" with it, counts the seconds of sound sent with it per calendar month (Korea time) and refuses past 10
// hours; a key the team entered itself goes first and is never counted. The key is in no response, log line or audit
// row. OpenRouter is a local fake (never the real one), reached through the real request code.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { mediaTranscriptsDefault, mediaTranscriptsOn } from '@mycel/shared/api'
import { getTeamSettings, updateTeamSettings } from '../../server/src/admin/settings'
import { componentC } from '../../server/src/team-files/component'
import { credentialsOf } from '../../server/src/credentials/store'
import { dropHostedSpeechKey, readSpeechKey, speechKeySource, speechKeyStatus, voiceInputOn, writeHostedSpeechKey, writeSpeechKey, HOSTED_SPEECH_KEY_SETTING } from '../../server/src/credentials/speech-key'
import { chargeHostedSpeech, hostedSpeechLeft, hostedSpeechMonth, hostedSpeechUsage, HOSTED_SPEECH_FREE_SEC, HOSTED_SPEECH_USAGE_SETTING } from '../../server/src/credentials/hosted-speech'
import { rekeyCredentials } from '../../server/src/credentials/rekey'
import { setHostedSpeechKey } from '../../server/src/system/cloud-tenant'
import * as media from '../../server/src/files/media'
import { makeCApp, type CApp } from '../lib/c-app'

setDefaultTimeout(60_000)
const HOSTED = 'sk-or-v1-HOSTED-CANARY-' + '0a'.repeat(24)
const TEAM = 'sk-or-v1-TEAM-OWN-KEY-' + '0b'.repeat(24)

let A: CApp
const C = () => componentC(A.ctx)
const F = () => A.ctx.files
const lines: string[] = []
interface Hit { auth: string | null; body: any }
const hits: Hit[] = []
let replies: (() => Response)[] = []
let reply: () => Response = () => Response.json({ text: 'hello', duration: 2.5, segments: [{ start: 0, end: 2.5, text: 'hello' }] })
const fake = Bun.serve({
  port: 0, hostname: '127.0.0.1',
  async fetch(req) {
    hits.push({ auth: req.headers.get('authorization'), body: await req.json().catch(() => null) })
    return (replies.shift() ?? reply)()
  },
})
const wav = (seconds: number) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(40 + Math.round(seconds * 32_000))])
const video = (duration: number): media.MediaInfo => ({
  durationSec: duration, format: 'mov', video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: 30 },
  audio: { index: 1, codec: 'aac', channels: 2, sampleRate: 48000 }, cover: false,
})
const spies: { mockRestore(): void }[] = []

beforeAll(async () => {
  A = await makeCApp('c-speech-hosted')
  const t = C().transcribe
  t.openRouterUrl = `http://127.0.0.1:${fake.port}/api/v1/audio/transcriptions`
  t.ffmpegBin = null
  A.ctx.db.query("UPDATE users SET locale = 'en' WHERE id IN ('alice','bob')").run()
  fs.mkdirSync(path.join(A.team, 'users/alice'), { recursive: true })
})
afterAll(async () => { await A.close(); fake.stop(true) })
beforeEach(() => {
  hits.length = 0
  replies = []
  reply = () => Response.json({ text: 'hello', duration: 2.5, segments: [{ start: 0, end: 2.5, text: 'hello' }] })
  A.ctx.db.query("DELETE FROM settings WHERE key IN ('speechProvider', 'aiMediaTranscripts', ?, ?)").run(HOSTED_SPEECH_USAGE_SETTING, HOSTED_SPEECH_KEY_SETTING)
  writeSpeechKey(credentialsOf(A.ctx), null)
  writeHostedSpeechKey(credentialsOf(A.ctx), HOSTED)
})
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore() })

async function voice(bytes: Uint8Array = wav(3)) {
  const fd = new FormData()
  fd.set('file', new File([new Uint8Array(bytes)], 'voice.wav'))
  const r = await A.json('/api/transcribe', { method: 'POST', body: fd, as: 'alice' })
  expect(r.status).toBe(202)
  return (await C().jobs.wait(r.body.jobId))!
}

describe('defaults with the hosting key', () => {
  test('not chosen: voice input on OpenRouter; "Turn video sound into text" on by default for it', () => {
    expect(getTeamSettings(A.ctx.db).speechProvider).toBe('openrouter')
    expect(voiceInputOn(A.ctx.db)).toBe(true)
    expect(speechKeySource(A.ctx.db)).toBe('hosted')
    expect(mediaTranscriptsDefault('openrouter', 2, true)).toBe(true)
    expect(mediaTranscriptsDefault('openrouter', 16, false)).toBe(false)
    expect(mediaTranscriptsOn({ speechProvider: 'openrouter', aiMediaTranscripts: null }, 2, true)).toBe(true)
    expect(mediaTranscriptsOn({ speechProvider: 'openrouter', aiMediaTranscripts: false }, 2, true)).toBe(false)
    expect(mediaTranscriptsOn({ speechProvider: 'off', aiMediaTranscripts: null }, 2, true)).toBe(false)
  })
  test("an admin's choice wins, 'off' too; without the hosting key the default is 'off' again", () => {
    updateTeamSettings(A.ctx.db, { speechProvider: 'off' })
    expect(getTeamSettings(A.ctx.db).speechProvider).toBe('off')
    expect(voiceInputOn(A.ctx.db)).toBe(false)
    A.ctx.db.query("DELETE FROM settings WHERE key = 'speechProvider'").run()
    writeHostedSpeechKey(credentialsOf(A.ctx), null)
    expect(getTeamSettings(A.ctx.db).speechProvider).toBe('off')
    expect(voiceInputOn(A.ctx.db)).toBe(false)
  })
  test('GET /api/admin/speech-key: no team key, the free hours, never the hosting key', async () => {
    chargeHostedSpeech(A.ctx.db, 5400)
    const r = await A.json('/api/admin/speech-key', { as: 'carol' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ set: false, hint: null, updatedAt: null, hosted: { month: hostedSpeechMonth(Date.now()), usedSec: 5400, freeSec: HOSTED_SPEECH_FREE_SEC } })
    expect(JSON.stringify(r.body)).not.toContain(HOSTED.slice(-8))
    const s = await A.json('/api/admin/settings', { as: 'carol' })
    expect(s.body.speechProvider).toBe('openrouter')
    expect(JSON.stringify(s.body)).not.toContain('HOSTED-CANARY')
  })
})

describe('voice input with the hosting key', () => {
  test('the request carries the hosting key; the seconds OpenRouter heard are counted', async () => {
    const job = await voice()
    expect(job.status, JSON.stringify(job.error)).toBe('done')
    expect(hits.length).toBe(1)
    expect(hits[0]!.auth).toBe(`Bearer ${HOSTED}`)
    expect(hits[0]!.body.provider).toMatchObject({ zdr: true, data_collection: 'deny' })
    expect(hostedSpeechUsage(A.ctx.db).usedSec).toBe(2.5)
    await voice()
    expect(hostedSpeechUsage(A.ctx.db).usedSec).toBe(5)
  })
  test('the month used up: refused before anything is sent, with a clear note', async () => {
    chargeHostedSpeech(A.ctx.db, HOSTED_SPEECH_FREE_SEC)
    const job = await voice()
    expect(job.status).toBe('failed')
    expect(job.error!.message).toContain("This month's 10 free hours of transcription are used up")
    expect(hits).toEqual([])
    A.ctx.db.query("UPDATE users SET locale = 'ko' WHERE id = 'alice'").run()
    try {
      const ko = await voice()
      expect(ko.error!.message).toContain('이번 달 무료 받아쓰기 10시간을 다 썼어요')
    } finally { A.ctx.db.query("UPDATE users SET locale = 'en' WHERE id = 'alice'").run() }
  })
  test("the team's own key goes first: no count, no limit", async () => {
    writeSpeechKey(credentialsOf(A.ctx), TEAM)
    chargeHostedSpeech(A.ctx.db, HOSTED_SPEECH_FREE_SEC)
    expect(speechKeySource(A.ctx.db)).toBe('team')
    expect(readSpeechKey(credentialsOf(A.ctx))).toBe(TEAM)
    const job = await voice()
    expect(job.status, JSON.stringify(job.error)).toBe('done')
    expect(hits[0]!.auth).toBe(`Bearer ${TEAM}`)
    expect(hostedSpeechUsage(A.ctx.db).usedSec).toBe(HOSTED_SPEECH_FREE_SEC)
    // the team's key refused: the usual words, not the hosting service's
    reply = () => Response.json({}, { status: 402 })
    expect((await voice()).error!.message).toContain('no credits')
  })
  test('OpenRouter refuses the hosting key (taken away, paused, its backstop): hosted words, not "add credits"', async () => {
    for (const status of [401, 402, 403]) {
      reply = () => Response.json({ error: { message: 'nope' } }, { status })
      const job = await voice()
      expect(job.error!.message).toContain('Hosted transcription is not available right now')
      expect(job.error!.message).not.toContain('credits')
    }
    expect(hostedSpeechUsage(A.ctx.db).usedSec).toBe(0)
  })
  test('a provider failure is tried once more (OpenRouter may send it to the other provider); only both failing says so', async () => {
    replies = [() => Response.json({ error: { message: 'deepinfra down' } }, { status: 502 })]
    const ok = await voice()
    expect(ok.status, JSON.stringify(ok.error)).toBe('done')
    expect(hits.length).toBe(2)
    expect(hits[1]!.body).toEqual(hits[0]!.body)
    expect(hostedSpeechUsage(A.ctx.db).usedSec).toBe(2.5)
    hits.length = 0
    reply = () => Response.json({}, { status: 503 })
    const bad = await voice()
    expect(bad.error!.message).toContain('did not answer, twice')
    expect(hits.length).toBe(2)
    // a refusal that is not the provider's failure is not sent again
    hits.length = 0
    reply = () => Response.json({}, { status: 400 })
    await voice()
    expect(hits.length).toBe(1)
    expect(hostedSpeechUsage(A.ctx.db).usedSec).toBe(2.5)
  })
  test("a Groq answer (language as a name, 10-second billing in usage) is read the same; the sound's own seconds count", async () => {
    reply = () => Response.json({ text: ' 기밀대화 시험입니다.', usage: { seconds: 10, cost: 0.000111 }, task: 'transcribe', language: 'Korean', duration: 5.619,
      segments: [{ id: 0, seek: 0, start: 0, end: 2, text: ' 기밀대화 시험입니다.', tokens: [50365], temperature: 0, avg_logprob: -0.45, compression_ratio: 0.95, no_speech_prob: 0 }] })
    const job = await voice()
    expect(job.status, JSON.stringify(job.error)).toBe('done')
    expect(job.result).toMatchObject({ text: '기밀대화 시험입니다.', durationSec: 5.619, segments: [{ start: 0, end: 2, text: '기밀대화 시험입니다.' }] })
    expect(hostedSpeechUsage(A.ctx.db).usedSec).toBe(5.6)
  })
})

describe('the month (Korea time)', () => {
  test('a new month in Korea starts from 0; the count is one row without sound, text or key', () => {
    const oct31kst = Date.parse('2026-10-31T14:59:00Z') // 23:59 KST on 31 October
    const nov1kst = Date.parse('2026-10-31T15:00:00Z') // 00:00 KST on 1 November
    expect(hostedSpeechMonth(oct31kst)).toBe('2026-10')
    expect(hostedSpeechMonth(nov1kst)).toBe('2026-11')
    chargeHostedSpeech(A.ctx.db, 36_000, oct31kst)
    expect(hostedSpeechLeft(A.ctx.db, oct31kst)).toBe(0)
    expect(hostedSpeechUsage(A.ctx.db, nov1kst).usedSec).toBe(0)
    chargeHostedSpeech(A.ctx.db, 60, nov1kst)
    expect(hostedSpeechUsage(A.ctx.db, nov1kst)).toEqual({ month: '2026-11', usedSec: 60, freeSec: HOSTED_SPEECH_FREE_SEC })
    expect(hostedSpeechUsage(A.ctx.db, oct31kst).usedSec).toBe(0)
    const raw = (A.ctx.db.query('SELECT value FROM settings WHERE key = ?').get(HOSTED_SPEECH_USAGE_SETTING) as { value: string }).value
    expect(JSON.parse(raw)).toEqual({ month: '2026-11', seconds: 60 })
  })
  test('a broken row counts as nothing used and is replaced; zero or bad seconds are not counted', () => {
    A.ctx.db.query("INSERT INTO settings (key, value) VALUES (?, 'not json')").run(HOSTED_SPEECH_USAGE_SETTING)
    expect(hostedSpeechUsage(A.ctx.db).usedSec).toBe(0)
    chargeHostedSpeech(A.ctx.db, 10)
    chargeHostedSpeech(A.ctx.db, 0)
    chargeHostedSpeech(A.ctx.db, Number.NaN)
    chargeHostedSpeech(A.ctx.db, -5)
    expect(hostedSpeechUsage(A.ctx.db).usedSec).toBe(10)
  })
})

describe('video reads with the hosting key', () => {
  let cores: ReturnType<typeof spyOn<typeof os, 'availableParallelism'>>
  beforeEach(() => {
    cores = spyOn(os, 'availableParallelism').mockReturnValue(2)
    F().speech.openRouterUrl = `http://127.0.0.1:${fake.port}/api/v1/audio/transcriptions`
    spies.push(
      cores,
      spyOn(F(), 'mediaTools').mockReturnValue({ ffmpeg: '/fake/ffmpeg', ffprobe: '/fake/ffprobe' }),
      spyOn(F(), 'mediaProbe').mockImplementation(async () => video(18)),
      spyOn(F(), 'mediaDuration').mockResolvedValue(null),
      spyOn(F(), 'mediaFrame').mockImplementation(async () => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 2, 64, 4, 0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9])),
      spyOn(F(), 'mediaAudio').mockImplementation(async (_t, _w, _n, _s, _start: number, seconds: number) => wav(Math.min(seconds, 2))),
    )
    reply = () => Response.json({ text: 'hello', segments: [{ start: 1, end: 2, text: 'hello from the hosted key' }], language: 'en' })
  })
  let n = 0
  const put = (name: string) => { const rel = `users/alice/${name}`; fs.writeFileSync(path.join(A.team, rel), `fake media ${++n}`); return rel }
  const read = async (rel: string) => F().call('read', { file_path: rel }, A.toolCtx('alice', A.turn('alice', A.chat('alice'))))

  test('on by default even on a small server: the sound goes with the hosting key and is counted', async () => {
    const out = await read(put('h1.mp4'))
    expect(hits.length).toBe(1)
    expect(hits[0]!.auth).toBe(`Bearer ${HOSTED}`)
    expect(out.text).toContain('hello from the hosted key')
    expect(hostedSpeechUsage(A.ctx.db).usedSec).toBe(2)
    expect(JSON.stringify(out)).not.toContain(HOSTED)
  })
  test('the month used up: no sound is cut or sent, and the note says why', async () => {
    chargeHostedSpeech(A.ctx.db, HOSTED_SPEECH_FREE_SEC)
    const out = await read(put('h2.mp4'))
    expect(hits).toEqual([])
    expect(F().mediaAudio).not.toHaveBeenCalled()
    expect(out.text).toContain("This month's 10 free hours of transcription are used up")
  })
  test("with the team's own key it is off by default again (the team picks where its files' sound goes)", async () => {
    writeSpeechKey(credentialsOf(A.ctx), TEAM)
    const out = await read(put('h3.mp4'))
    expect(hits).toEqual([])
    expect(out.text).toContain('does not turn video sound into text')
  })
})

describe('admin.js hosted-speech-key (mycel-ctl hosted-speech-key-set)', () => {
  const o = (deployment: 'hosted' | 'self') => ({ db: A.ctx.db, secretsDir: credentialsOf(A.ctx).vault.secretsDir, config: { ...A.ctx.config, deployment }, log: A.ctx.log })
  test('hosted: set and take away; audited as set / removed without the key', () => {
    writeHostedSpeechKey(credentialsOf(A.ctx), null)
    const other = 'sk-or-v1-' + '0c'.repeat(32)
    expect(setHostedSpeechKey(o('hosted'), { key: other })).toEqual({ ok: true, set: true })
    expect(readSpeechKey(credentialsOf(A.ctx))).toBe(other)
    expect(setHostedSpeechKey(o('hosted'), { key: null })).toEqual({ ok: true, set: false })
    expect(speechKeySource(A.ctx.db)).toBeNull()
    const rows = (A.ctx.db.query("SELECT actor_id, detail FROM audit_log WHERE action = 'speech.hosted_key' ORDER BY rowid DESC LIMIT 2").all() as { actor_id: string | null; detail: string }[]).reverse()
    expect(rows.map((r) => [r.actor_id, JSON.parse(r.detail)])).toEqual([[null, { key: 'set' }], [null, { key: 'removed' }]])
    expect(JSON.stringify(rows)).not.toContain(other.slice(10))
  })
  test('refused on a server that is not hosted, and for anything but { key }; errors never hold the key', () => {
    const k = 'sk-or-v1-' + '0d'.repeat(32)
    expect(() => setHostedSpeechKey(o('self'), { key: k })).toThrow('hosted servers only')
    for (const bad of [{}, { key: 'sk-or-short' }, { key: k, extra: 1 }, { key: 7 }, null, []]) {
      let msg = ''
      try { setHostedSpeechKey(o('hosted'), bad) } catch (e) { msg = (e as Error).message }
      expect(msg).toContain('stdin must be')
      expect(msg).not.toContain(k)
    }
  })
  test('a server that is not hosted drops a hosting key at start (main.ts: a hosted backup restored elsewhere)', () => {
    expect(dropHostedSpeechKey(A.ctx.db)).toBe(true)
    expect(speechKeySource(A.ctx.db)).toBeNull()
    expect(dropHostedSpeechKey(A.ctx.db)).toBe(false)
  })
  test('credentials-rekey encrypts the hosting key again and it still opens', () => {
    const cc = credentialsOf(A.ctx)
    const before = JSON.parse((A.ctx.db.query('SELECT value FROM settings WHERE key = ?').get(HOSTED_SPEECH_KEY_SETTING) as { value: string }).value)
    rekeyCredentials(cc)
    const after = JSON.parse((A.ctx.db.query('SELECT value FROM settings WHERE key = ?').get(HOSTED_SPEECH_KEY_SETTING) as { value: string }).value)
    expect(after.keyVersion).toBeGreaterThan(before.keyVersion)
    expect(readSpeechKey(credentialsOf(A.ctx))).toBe(HOSTED)
  })
  test('the hosting key is in no stored value in clear, response, audit row or log line', async () => {
    for (const level of ['debug', 'info', 'warn', 'error'] as const) spies.push(spyOn(A.ctx.log, level).mockImplementation((...a: unknown[]) => { lines.push(JSON.stringify(a, (_k, v) => (v instanceof Error ? { message: v.message, stack: v.stack } : v))) }))
    await voice()
    reply = () => Response.json({ error: { message: 'nope' } }, { status: 401 })
    await voice()
    reply = () => Response.json({}, { status: 503 })
    await voice()
    const dump = JSON.stringify(A.ctx.db.query('SELECT key, value FROM settings').all()) + JSON.stringify(A.ctx.db.query('SELECT action, target, detail FROM audit_log').all())
      + JSON.stringify(speechKeyStatus(A.ctx.db)) + JSON.stringify((await A.json('/api/me', { as: 'alice' })).body) + lines.join('\n')
    expect(dump).not.toContain(HOSTED)
    expect(dump).not.toContain('HOSTED-CANARY')
  })
})
