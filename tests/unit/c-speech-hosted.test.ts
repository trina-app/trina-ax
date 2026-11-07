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
import { hostedSpeechMeter } from '../../server/src/credentials/hosted-speech'
import { sendToOpenRouter } from '../../server/src/jobs/openrouter-stt'
import { applyPendingRestore, keepServerSettings, withoutHostingKey } from '../../server/src/system/backup'
import { openDb } from '../../server/src/db'
import { DEFAULT_SPEECH_MODEL } from '@mycel/shared/api'
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
    expect(voiceInputOn(A.ctx.db, F().speech)).toBe(true)
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
    expect(voiceInputOn(A.ctx.db, F().speech)).toBe(false)
    A.ctx.db.query("DELETE FROM settings WHERE key = 'speechProvider'").run()
    writeHostedSpeechKey(credentialsOf(A.ctx), null)
    expect(getTeamSettings(A.ctx.db).speechProvider).toBe('off')
    expect(voiceInputOn(A.ctx.db, F().speech)).toBe(false)
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
    // the month never goes back: a clock set back into October keeps counting November's row (no fresh 10 hours)
    expect(hostedSpeechUsage(A.ctx.db, oct31kst).usedSec).toBe(60)
    chargeHostedSpeech(A.ctx.db, 30, oct31kst)
    expect(hostedSpeechUsage(A.ctx.db, nov1kst).usedSec).toBe(90)
    const raw = (A.ctx.db.query('SELECT value FROM settings WHERE key = ?').get(HOSTED_SPEECH_USAGE_SETTING) as { value: string }).value
    expect(JSON.parse(raw)).toEqual({ month: '2026-11', seconds: 90 })
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
  test('one pool: voice input, a video read and an audio read count together, and a used-up pool stops them all', async () => {
    reply = () => Response.json({ text: 'hello', duration: 2.5, segments: [{ start: 0, end: 2.5, text: 'hello from the hosted key' }], language: 'en' })
    await voice()
    await read(put('pool.mp4'))
    spyOn(F(), 'mediaProbe').mockImplementation(async () => ({ ...video(18), video: null, format: 'mp3' }))
    await read(put('pool.m4a'))
    expect(hits.map((h) => h.auth)).toEqual([`Bearer ${HOSTED}`, `Bearer ${HOSTED}`, `Bearer ${HOSTED}`])
    // voice input (no ffmpeg here): the 2.5 s OpenRouter heard; each read: the 2 s WAV the server made and sent
    expect(hostedSpeechUsage(A.ctx.db).usedSec).toBe(6.5)
    chargeHostedSpeech(A.ctx.db, HOSTED_SPEECH_FREE_SEC)
    hits.length = 0
    expect((await voice()).error!.message).toContain('free hours of transcription are used up')
    expect((await read(put('pool2.mp4'))).text).toContain('free hours of transcription are used up')
    expect(hits).toEqual([])
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

describe('the meter: every request is held before it goes, counted once, given back without an answer', () => {
  const send = (o: { seconds?: number | null; cfg?: ReturnType<typeof C>['transcribe'] } = {}) =>
    sendToOpenRouter(o.cfg ?? C().transcribe, HOSTED, DEFAULT_SPEECH_MODEL, wav(1), 'wav', { seconds: o.seconds === undefined ? 30 : o.seconds })
  test('requests sent at the same time cannot all pass the last seconds of the month', async () => {
    chargeHostedSpeech(A.ctx.db, HOSTED_SPEECH_FREE_SEC - 1)
    const got = await Promise.allSettled([1, 2, 3, 4, 5].map(() => send({ seconds: 600 })))
    expect(got.filter((g) => g.status === 'fulfilled').length).toBe(1)
    expect(got.filter((g) => g.status === 'rejected').map((g) => ((g as PromiseRejectedResult).reason as Error).message))
      .toEqual(Array(4).fill(expect.stringContaining('free hours of transcription are used up')))
    expect(hits.length).toBe(1)
    expect(hostedSpeechUsage(A.ctx.db).usedSec).toBe(HOSTED_SPEECH_FREE_SEC - 1 + 600)
  })
  test('the length of what was sent counts, whatever the answer claims; an answer alone counts at most the month', async () => {
    for (const duration of [-5, 1e12, Number.MAX_VALUE, 'ten', null, 0.5]) {
      reply = () => Response.json({ text: 'x', duration })
      await send({ seconds: 30 })
    }
    expect(hostedSpeechUsage(A.ctx.db).usedSec).toBe(180)
    // without the server's own length (no ffmpeg): what OpenRouter heard, never below 0 or past the month
    reply = () => Response.json({ text: 'x', duration: -5 })
    await send({ seconds: null })
    expect(hostedSpeechUsage(A.ctx.db).usedSec).toBe(180)
    reply = () => Response.json({ text: 'x', duration: 1e12 })
    await send({ seconds: null })
    expect(hostedSpeechUsage(A.ctx.db).usedSec).toBe(180 + HOSTED_SPEECH_FREE_SEC)
  })
  test('no answer gives the hold back: both tries failing, a refusal, Stop', async () => {
    reply = () => Response.json({}, { status: 503 })
    await expect(send()).rejects.toThrow('did not answer, twice')
    expect(hits.length).toBe(2)
    reply = () => Response.json({}, { status: 401 })
    await expect(send()).rejects.toThrow('Hosted transcription is not available')
    reply = () => Response.json({}, { status: 400 })
    await expect(send()).rejects.toThrow('HTTP 400')
    const stop = new AbortController()
    reply = () => { stop.abort(); return Response.json({ text: 'late' }) }
    await sendToOpenRouter(C().transcribe, HOSTED, DEFAULT_SPEECH_MODEL, wav(1), 'wav', { seconds: 30, signal: stop.signal }).catch(() => null)
    expect(hostedSpeechUsage(A.ctx.db).usedSec).toBe(0)
    // a failure then an answer: counted once
    replies = [() => Response.json({}, { status: 502 })]
    reply = () => Response.json({ text: 'ok' })
    await send()
    expect(hostedSpeechUsage(A.ctx.db).usedSec).toBe(30)
  })
  test("a second try is checked again: the month used up meanwhile refuses it", async () => {
    replies = [() => { chargeHostedSpeech(A.ctx.db, HOSTED_SPEECH_FREE_SEC); return Response.json({}, { status: 502 }) }]
    await expect(send()).rejects.toThrow('free hours of transcription are used up')
    expect(hits.length).toBe(1)
  })
  test('a request sent in the last minute of a month counts in that month, not in the next', async () => {
    let clock = Date.parse('2026-10-31T14:59:30Z') // 23:59:30 KST, 31 October
    const cfg = { ...C().transcribe, meter: hostedSpeechMeter(A.ctx.db, () => HOSTED, () => clock) }
    reply = () => { clock = Date.parse('2026-10-31T15:00:30Z'); return Response.json({ text: 'x', duration: 45 }) }
    await send({ cfg, seconds: 45 })
    expect(hostedSpeechUsage(A.ctx.db, Date.parse('2026-10-31T14:59:30Z')).usedSec).toBe(45)
    expect(hostedSpeechUsage(A.ctx.db, clock).usedSec).toBe(0)
    // and a hold of October given back in November takes nothing from November
    chargeHostedSpeech(A.ctx.db, 100, clock)
    clock = Date.parse('2026-10-31T14:59:30Z')
    reply = () => { clock = Date.parse('2026-10-31T15:01:00Z'); return Response.json({}, { status: 400 }) }
    await send({ cfg, seconds: 45 }).catch(() => null)
    expect(hostedSpeechUsage(A.ctx.db, clock).usedSec).toBe(100)
  })
  test("the hosting key goes with its one model; the team's own key with the team's choice", async () => {
    updateTeamSettings(A.ctx.db, { speechModel: 'openai/whisper-large-v3' })
    try {
      await voice()
      expect(hits[0]!.body.model).toBe(DEFAULT_SPEECH_MODEL)
      writeSpeechKey(credentialsOf(A.ctx), TEAM)
      await voice()
      expect(hits[1]!.body.model).toBe('openai/whisper-large-v3')
    } finally { updateTeamSettings(A.ctx.db, { speechModel: DEFAULT_SPEECH_MODEL }) }
  })
  test('voice input: a second try only while voice input is still on OpenRouter', async () => {
    replies = [() => { updateTeamSettings(A.ctx.db, { speechProvider: 'off' }); return Response.json({}, { status: 502 }) }]
    const job = await voice()
    expect(job.status).toBe('failed')
    expect(hits.length).toBe(1)
    expect(hostedSpeechUsage(A.ctx.db).usedSec).toBe(0)
  })
})

describe('a read whose month runs out on the way', () => {
  beforeEach(() => {
    F().speech.openRouterUrl = `http://127.0.0.1:${fake.port}/api/v1/audio/transcriptions`
    spies.push(
      spyOn(os, 'availableParallelism').mockReturnValue(2),
      spyOn(F(), 'mediaTools').mockReturnValue({ ffmpeg: '/fake/ffmpeg', ffprobe: '/fake/ffprobe' }),
      spyOn(F(), 'mediaProbe').mockImplementation(async () => ({ ...video(1500), video: null, format: 'mp3' })),
      spyOn(F(), 'mediaDuration').mockResolvedValue(null),
      spyOn(F(), 'mediaSendable').mockImplementation(async (_t, _w, _n, bytes: Buffer) => ({ bytes, format: 'wav' })),
      spyOn(F(), 'mediaAudio').mockImplementation(async () => {
        // speech-like noise, so the piece is not skipped as silence
        const b = wav(2)
        for (let i = 44; i + 1 < b.length; i += 2) b.writeInt16LE(Math.round(Math.sin(i / 7) * 8000), i)
        return b
      }),
    )
  })
  test('stops before the next piece with the free-hours note (no "failed"), nothing more is sent', async () => {
    fs.mkdirSync(path.join(A.team, 'users/alice'), { recursive: true })
    const rel = 'users/alice/long-meeting.m4a'
    fs.writeFileSync(path.join(A.team, rel), 'fake long media')
    reply = () => { chargeHostedSpeech(A.ctx.db, HOSTED_SPEECH_FREE_SEC); return Response.json({ text: 'the first piece', language: 'en' }) }
    const out = await F().call('read', { file_path: rel }, A.toolCtx('alice', A.turn('alice', A.chat('alice'))))
    expect(hits.length).toBe(1)
    expect(out.text).toContain('the first piece')
    expect(out.text).toContain("This month's 10 free hours of transcription are used up")
    expect(out.text).not.toContain('The transcript failed')
  })
})

describe("restores and exports: the hosting service's rows", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-rows-'))
  const rows = (file: string) => {
    const d = openDb(file)
    try { return Object.fromEntries((d.query("SELECT key, value FROM settings WHERE key IN ('speech.hostedKey', 'speech.hostedUsage')").all() as { key: string; value: string }[]).map((r) => [r.key, r.value])) } finally { d.close() }
  }
  const put = (file: string, kv: Record<string, string>) => {
    const d = openDb(file)
    try { for (const [k, v] of Object.entries(kv)) d.query('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v) } finally { d.close() }
  }
  test('a restore keeps the current key and month count (an older backup gives no hours back), or none when there is none', () => {
    const dir = tmp()
    const live = path.join(dir, 'app.db'), staged = path.join(dir, 'restore-staged.db')
    put(live, { 'speech.hostedKey': '{"enc":"NEW","keyVersion":1}', 'speech.hostedUsage': '{"month":"2026-11","seconds":30000}' })
    put(staged, { 'speech.hostedKey': '{"enc":"OLD","keyVersion":1}', 'speech.hostedUsage': '{"month":"2026-11","seconds":10}' })
    fs.writeFileSync(path.join(dir, 'restore-pending.json'), JSON.stringify({ format: 1, file: staged, backupId: 'b1', requestedAt: new Date().toISOString(), requestedBy: null }))
    expect(applyPendingRestore(dir, A.ctx.log).applied).toBe(true)
    expect(rows(live)).toEqual({ 'speech.hostedKey': '{"enc":"NEW","keyVersion":1}', 'speech.hostedUsage': '{"month":"2026-11","seconds":30000}' })
    // a server without them: the restored copy brings none back
    const other = path.join(dir, 'other.db'), none = path.join(dir, 'none.db')
    put(other, { 'speech.hostedKey': '{"enc":"OLD","keyVersion":1}', 'speech.hostedUsage': '{"month":"2026-11","seconds":10}' })
    put(none, { x: '1' })
    keepServerSettings(none, other)
    expect(rows(other)).toEqual({})
    fs.rmSync(dir, { recursive: true, force: true })
  })
  test("an export's database copy has no hosting key, not even in its free pages", () => {
    const dir = tmp()
    const file = path.join(dir, 'archive.sqlite')
    const marker = 'HOSTED-CIPHERTEXT-MARKER-' + 'x'.repeat(40)
    put(file, { 'speech.hostedKey': JSON.stringify({ enc: marker, keyVersion: 1 }), 'speech.openrouterKey': '{"enc":"TEAM","keyVersion":1,"hint":"abcd"}' })
    withoutHostingKey(file)
    expect(fs.readFileSync(file).includes(marker)).toBe(false)
    const d = openDb(file)
    try { expect(d.query("SELECT key FROM settings WHERE key LIKE 'speech.%'").all()).toEqual([{ key: 'speech.openrouterKey' }]) } finally { d.close() }
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
