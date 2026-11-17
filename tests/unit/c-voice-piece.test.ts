// Voice input while recording (docs/AGENTS/plan/20261117-0143-voice-live-text.md): POST /api/transcribe/piece turns one
// piece of a recording into lines with the team's voice input setting. The same chat checks as a whole recording
// (POST /api/transcribe): the caller's own chat, never a confidential chat's sound to OpenRouter. Every piece is
// counted against the hosting key's free hours by its seconds, a person has at most two at once and a limit a minute,
// and the piece is deleted whatever happens. OpenRouter is a fake here.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { pieceWav } from '@mycel/shared/speech-pieces'
import { componentC } from '../../server/src/team-files/component'
import { updateTeamSettings } from '../../server/src/admin/settings'
import { credentialsOf } from '../../server/src/credentials/store'
import { writeHostedSpeechKey, writeSpeechKey, HOSTED_SPEECH_KEY_SETTING } from '../../server/src/credentials/speech-key'
import { chargeHostedSpeech, hostedSpeechUsage, HOSTED_SPEECH_DEFAULT_FREE_HOURS, HOSTED_SPEECH_USAGE_SETTING } from '../../server/src/credentials/hosted-speech'
import { resetPieceLimitsForTests, VOICE_SOUND_SEC_PER_MIN } from '../../server/src/jobs/meeting-piece'
import { makeCApp, type CApp } from '../lib/c-app'

const KEY = 'sk-or-v1-FAKE-TEST-KEY-VOICE-PIECE-0123456789abcdef'
const HOSTED = 'sk-or-v1-HOSTED-VOICE-CANARY-' + '0c'.repeat(20)
let A: CApp
const C = () => componentC(A.ctx)
const hits: { auth: string | null; body: any }[] = []
const HELLO = () => Response.json({ text: 'hello there', language: 'en', duration: 2, segments: [{ start: 0.2, end: 1.8, text: ' hello there' }] })
let reply: () => Response = HELLO
const fake = Bun.serve({
  port: 0, hostname: '127.0.0.1',
  async fetch(req) {
    hits.push({ auth: req.headers.get('authorization'), body: await req.json().catch(() => null) })
    return reply()
  },
})
let savedUrl = ''

beforeAll(async () => {
  A = await makeCApp('c-voice-piece')
  savedUrl = C().transcribe.openRouterUrl
  C().transcribe.openRouterUrl = `http://127.0.0.1:${fake.port}/api/v1/audio/transcriptions`
  A.ctx.db.query("UPDATE users SET locale = 'en' WHERE id IN ('alice', 'bob')").run()
})
afterAll(async () => {
  C().transcribe.openRouterUrl = savedUrl
  await A.close()
  fake.stop(true)
})
beforeEach(() => {
  hits.length = 0
  reply = HELLO
  resetPieceLimitsForTests()
  A.ctx.db.query('DELETE FROM settings WHERE key IN (?, ?)').run(HOSTED_SPEECH_USAGE_SETTING, HOSTED_SPEECH_KEY_SETTING)
  updateTeamSettings(A.ctx.db, { speechProvider: 'openrouter' })
  writeSpeechKey(credentialsOf(A.ctx), KEY)
})
afterEach(() => { delete process.env.MYCEL_SAFE_OPS_1A })

const piece = (sec = 2) => pieceWav(new Float32Array(Math.round(sec * 16000)).map((_, i) => 0.1 * Math.sin(i / 7)))
async function send(bytes: Uint8Array, fields: Record<string, string> = {}, as: 'alice' | 'bob' = 'alice') {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  fd.set('file', new File([new Uint8Array(bytes)], 'piece.wav'))
  return A.json('/api/transcribe/piece', { method: 'POST', body: fd, as })
}
const lock = (chatId: string) => A.ctx.db.query('INSERT INTO safe_ops_chats (chat_id, material) VALUES (?, 1) ON CONFLICT(chat_id) DO UPDATE SET material = 1').run(chatId)
/** spooled pieces left behind in the server's folders (there must be none) */
const leftovers = () => {
  const out: string[] = []
  for (const d of [path.join(A.data, 'uploads', 'tmp'), path.join(A.data, 'work')]) {
    try { for (const f of fs.readdirSync(d)) out.push(f) } catch { /* none */ }
  }
  return out.filter((f) => !f.startsWith('.'))
}

/** syllables of a voice whose pitch glides, with pauses: sound that moves like speech (tests/unit/no-speech.test.ts) */
const spoken = (sec = 1) => pieceWav(Float32Array.from({ length: Math.round(sec * 16000) }, (_, i) => {
  const t = i % 4000
  if (t >= 2880) return 0
  const f0 = 110 + 40 * t / 2880 + 15 * (Math.floor(i / 4000) % 3)
  let v = 0
  for (let h = 1; h <= 8; h++) v += Math.sin(2 * Math.PI * f0 * h * i / 16000) / h
  return 0.1 * Math.sin(Math.PI * t / 2880) * v
}))

describe('a piece with no speech (QA TC-4581): no stray word', () => {
  test('silence: nothing is sent, no lines', async () => {
    const r = await send(pieceWav(new Float32Array(32000)), { chatId: A.chat('alice') })
    expect(r.status).toBe(200)
    expect(r.body.lines).toEqual([])
    expect(hits).toEqual([])
    expect(leftovers()).toEqual([])
  })
  test('a beep heard as "Thank you." (whisper unsure there was speech): no lines', async () => {
    reply = () => Response.json({ text: ' Thank you.', language: 'en', duration: 2, segments: [{ start: 0, end: 2, text: ' Thank you.', avg_logprob: -0.45, no_speech_prob: 0.72 }] })
    const r = await send(piece(2))
    expect(r.status).toBe(200)
    expect(r.body.lines).toEqual([])
    expect(hits).toHaveLength(1)
  })
  test('a beep heard as "you", with no confidence fields: still no lines (a learned line on a tone)', async () => {
    reply = () => Response.json({ text: 'you', language: 'en', duration: 2 })
    expect((await send(piece(2))).body.lines).toEqual([])
  })
  test('a person who says "Thank you": kept', async () => {
    reply = () => Response.json({ text: ' Thank you.', language: 'en', duration: 1, segments: [{ start: 0, end: 1, text: ' Thank you.', avg_logprob: -0.15, no_speech_prob: 0.02 }] })
    expect((await send(spoken(1))).body.lines).toEqual([{ start: 0, end: 1, text: 'Thank you.' }])
  })
})

describe('a piece of voice input', () => {
  test('in the caller\'s chat: the WAV goes to OpenRouter as it is, the lines come back, nothing is left', async () => {
    const chat = A.chat('alice')
    const r = await send(piece(2), { chatId: chat })
    expect(r.status).toBe(200)
    expect(r.body.lines).toEqual([{ start: 0.2, end: 1.8, text: 'hello there' }])
    expect(hits).toHaveLength(1)
    expect(hits[0]!.body.input_audio.format).toBe('wav')
    expect(hits[0]!.body.provider.zdr).toBe(true)
    expect(leftovers()).toEqual([])
  })
  test('a room (no chat) works as a new chat does', async () => {
    expect((await send(piece(1))).status).toBe(200)
  })
  test('someone else\'s chat: refused before anything is sent', async () => {
    const chat = A.chat('bob')
    const r = await send(piece(1), { chatId: chat })
    expect(r.status).toBeGreaterThanOrEqual(403)
    expect(r.status).toBeLessThan(405)
    expect(hits).toEqual([])
    expect(leftovers()).toEqual([])
  })
  test('a confidential chat with OpenRouter: 403 confidential with the voice input sentence, nothing sent', async () => {
    const chat = A.chat('alice')
    lock(chat)
    const r = await send(piece(1), { chatId: chat })
    expect(r.status).toBe(403)
    expect(r.body.error.params).toEqual({ reason: 'confidential' })
    expect(r.body.error.message).toContain('OpenRouter')
    expect(hits).toEqual([])
    expect(leftovers()).toEqual([])
  })
  test('Safe operations 1A: a room\'s piece (every chat confidential) is refused too', async () => {
    process.env.MYCEL_SAFE_OPS_1A = '1'
    const r = await send(piece(1))
    expect(r.status).toBe(403)
    expect(r.body.error.params).toEqual({ reason: 'confidential' })
    expect(hits).toEqual([])
  })
  test('voice input off: 409 off, final', async () => {
    updateTeamSettings(A.ctx.db, { speechProvider: 'off' })
    const r = await send(piece(1))
    expect(r.status).toBe(409)
    expect(r.body.error.params).toEqual({ reason: 'off' })
    expect(hits).toEqual([])
  })
  test('not a piece (two channels): 400, nothing sent, nothing left', async () => {
    const bad = piece(1); bad[22] = 2
    expect((await send(bad)).status).toBe(400)
    expect(hits).toEqual([])
    expect(leftovers()).toEqual([])
  })
})

describe('cost and limits', () => {
  test('the hosting key: each piece counts its own seconds of sound against the free hours, as a recording does', async () => {
    writeSpeechKey(credentialsOf(A.ctx), null)
    writeHostedSpeechKey(credentialsOf(A.ctx), HOSTED)
    expect((await send(piece(2))).status).toBe(200)
    expect(hits[0]!.auth).toBe(`Bearer ${HOSTED}`)
    expect(hostedSpeechUsage(A.ctx.db).usedSec).toBe(2)
    expect((await send(piece(3))).status).toBe(200)
    expect(hostedSpeechUsage(A.ctx.db).usedSec).toBe(5)
  })
  test('the free hours used up: 429 free_used (final, not sent again), nothing sent', async () => {
    writeSpeechKey(credentialsOf(A.ctx), null)
    writeHostedSpeechKey(credentialsOf(A.ctx), HOSTED)
    chargeHostedSpeech(A.ctx.db, HOSTED_SPEECH_DEFAULT_FREE_HOURS * 3600)
    const r = await send(piece(1))
    expect(r.status).toBe(429)
    expect(r.body.error.params?.reason).toBe('free_used')
    expect(hits).toEqual([])
    expect(leftovers()).toEqual([])
  })
  test('more sound a minute than someone can say: 429 too_fast with a wait; other people are not held back', async () => {
    const n = Math.floor(VOICE_SOUND_SEC_PER_MIN / 15)
    for (let i = 0; i < n; i++) expect((await send(piece(15))).status).toBe(200)
    const r = await send(piece(15))
    expect(r.status).toBe(429)
    expect(r.body.error.params).toEqual({ reason: 'too_fast' })
    expect(Number(r.res.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(hits).toHaveLength(n)
    expect((await send(piece(15), {}, 'bob')).status).toBe(200)
    expect(leftovers()).toEqual([])
  })
})
