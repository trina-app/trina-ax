// Meeting notes (docs/AGENTS/plan/20261116-1903-live-meeting-notes.md): POST /api/meetings/piece turns one piece of a
// meeting's sound into lines with the team's voice input setting, GET /api/meetings/status says whether a meeting can
// start. OpenRouter is a fake here (never the real one); the piece is deleted whatever happens.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { componentC } from '../../server/src/team-files/component'
import { updateTeamSettings } from '../../server/src/admin/settings'
import { credentialsOf } from '../../server/src/credentials/store'
import { writeSpeechKey } from '../../server/src/credentials/speech-key'
import { MeetingSpeed, meetingStatus, MEETING_LOCAL_MAX_SEC_PER_SEC, pieceSeconds, type MeetingDeps } from '../../server/src/jobs/meeting-piece'
import { pieceWav } from '../../desktop/src/common/meeting/chunker'
import { makeCApp, type CApp } from '../lib/c-app'

const KEY = 'sk-or-v1-FAKE-TEST-KEY-CANARY-0123456789abcdef'
let A: CApp
const C = () => componentC(A.ctx)
const hits: any[] = []
let reply: () => Response = () => Response.json({ text: 'hello there', language: 'en', duration: 2, segments: [{ start: 0.2, end: 1.8, text: ' hello there' }, { start: 1.8, end: 2, text: '[BLANK_AUDIO]' }] })
const fake = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) { hits.push(await req.json().catch(() => null)); return reply() } })
let saved: { url: string; whisper: string | null }

beforeAll(async () => {
  A = await makeCApp('c-meeting')
  const t = C().transcribe
  saved = { url: t.openRouterUrl, whisper: t.whisperBin }
  t.openRouterUrl = `http://127.0.0.1:${fake.port}/api/v1/audio/transcriptions`
  A.ctx.db.query("UPDATE users SET locale = 'en' WHERE id = 'alice'").run()
})
afterAll(async () => {
  const t = C().transcribe
  t.openRouterUrl = saved.url
  t.whisperBin = saved.whisper
  await A.close()
  fake.stop(true)
})
beforeEach(() => {
  hits.length = 0
  delete process.env.MYCEL_SAFE_OPS_1A
  updateTeamSettings(A.ctx.db, { speechProvider: 'openrouter' })
  writeSpeechKey(credentialsOf(A.ctx), KEY)
})

const piece = (sec = 2) => pieceWav(new Float32Array(Math.round(sec * 16000)).map((_, i) => 0.1 * Math.sin(i / 7)))
async function send(bytes: Uint8Array, fields: Record<string, string> = {}) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  fd.set('file', new File([new Uint8Array(bytes)], 'piece.wav'))
  return A.json('/api/meetings/piece', { method: 'POST', body: fd, as: 'alice' })
}
/** spooled pieces left behind in the server's folders (there must be none) */
const leftovers = () => {
  const out: string[] = []
  for (const d of [path.join(A.data, 'uploads', 'tmp'), path.join(A.data, 'work')]) {
    try { for (const f of fs.readdirSync(d)) out.push(f) } catch { /* none */ }
  }
  return out.filter((f) => !f.startsWith('.'))
}

describe('a piece through OpenRouter', () => {
  test('the WAV goes as it is, the lines come back, the mark for no words is dropped, nothing is left', async () => {
    const r = await send(piece(2), { language: 'en' })
    expect(r.status).toBe(200)
    expect(r.body.lines).toEqual([{ start: 0.2, end: 1.8, text: 'hello there' }])
    expect(hits).toHaveLength(1)
    expect(hits[0].input_audio.format).toBe('wav')
    expect(hits[0].language).toBe('en')
    expect(hits[0].provider.zdr).toBe(true)
    expect(Buffer.from(hits[0].input_audio.data, 'base64').subarray(0, 4).toString('latin1')).toBe('RIFF')
    expect(leftovers()).toEqual([])
  })
  test('no language: whisper guesses (none is sent)', async () => {
    await send(piece(1))
    expect(hits[0].language).toBeUndefined()
  })
  test('voice input off: refused, nothing sent', async () => {
    updateTeamSettings(A.ctx.db, { speechProvider: 'off' })
    const r = await send(piece(1))
    expect(r.status).toBeGreaterThanOrEqual(400)
    expect(hits).toEqual([])
    expect(leftovers()).toEqual([])
  })
  test('Safe operations 1A: sound never leaves the server, so OpenRouter is refused', async () => {
    process.env.MYCEL_SAFE_OPS_1A = '1'
    const r = await send(piece(1))
    expect(r.status).toBe(403)
    expect(r.body.error.params).toEqual({ reason: 'confidential' })
    expect(hits).toEqual([])
    const s = await A.json('/api/meetings/status', { as: 'alice' })
    expect(s.body.state).toBe('confidential')
  })
  test('not the app\'s WAV, or longer than 15.5 s: refused, nothing sent', async () => {
    const bad = piece(1); bad[22] = 2 // two channels
    expect((await send(bad)).status).toBe(400)
    const long = pieceWav(new Float32Array(16 * 16000))
    expect((await send(long)).status).toBeGreaterThanOrEqual(400)
    expect(hits).toEqual([])
    expect(leftovers()).toEqual([])
  })
  test('a provider failure is a plain sentence', async () => {
    reply = () => new Response('no', { status: 402 })
    try {
      const r = await send(piece(1))
      expect(r.status).toBeGreaterThanOrEqual(400)
      expect(JSON.stringify(r.body)).not.toContain(KEY)
    } finally { reply = () => Response.json({ text: 'ok', segments: [{ start: 0, end: 1, text: 'ok' }] }) }
  })
  test('status: ready with a key, off without', async () => {
    expect((await A.json('/api/meetings/status', { as: 'alice' })).body).toEqual({ state: 'ready' })
    writeSpeechKey(credentialsOf(A.ctx), null)
    expect((await A.json('/api/meetings/status', { as: 'alice' })).body.state).toBe('off')
  })
})

describe('a piece on this server', () => {
  const deps = (o: Partial<MeetingDeps> = {}): MeetingDeps => ({
    stt: { ...C().transcribe, whisperBin: '/nonexistent/whisper-cli', modelDir: path.join(A.data, 'meet-models'), modelOverride: { file: 'm.bin', size: 1000, sha256: '0'.repeat(64) }, baseUrl: 'http://127.0.0.1:9/' },
    provider: () => 'local', openRouter: () => null, confidential: () => false, speed: new MeetingSpeed(), ...o,
  })
  test('no whisper-cli: off', async () => {
    const d = deps()
    d.stt.whisperBin = null
    expect((await meetingStatus(d)).state).toBe('off')
  })
  test('the model not there yet: getting ready, with its size', async () => {
    const s = await meetingStatus(deps())
    expect(s.state).toBe('getting_ready')
    expect(s.progress).toBe(0)
  })
  test('the model there: ready; too slow once measured over the limit', async () => {
    const d = deps()
    fs.mkdirSync(d.stt.modelDir, { recursive: true })
    fs.writeFileSync(path.join(d.stt.modelDir, 'm.bin'), Buffer.alloc(1000))
    expect((await meetingStatus(d)).state).toBe('ready')
    // a fast Mac: a second for a 15 s piece
    for (let i = 0; i < 5; i++) d.speed.record(1000, 15)
    expect((await meetingStatus(d)).state).toBe('ready')
    // a 2-vCPU box: 20 s for a 15 s piece
    for (let i = 0; i < 10; i++) d.speed.record(20_000, 15)
    expect(d.speed.secPerSec()!).toBeGreaterThan(MEETING_LOCAL_MAX_SEC_PER_SEC)
    expect((await meetingStatus(d)).state).toBe('too_slow')
  })
  test('the speed counts only after a few pieces', () => {
    const s = new MeetingSpeed()
    s.record(60_000, 10)
    expect(s.secPerSec()).toBeNull()
    expect(s.tooSlow()).toBe(false)
  })
})

describe("the app's WAV", () => {
  test('16 kHz mono 16-bit, the data to the end, at most 15.5 s', () => {
    const w = piece(2)
    expect(pieceSeconds(w.subarray(0, 44), w.length)).toBeCloseTo(2, 3)
    expect(pieceSeconds(w.subarray(0, 44), w.length + 2)).toBeNull()
    const long = pieceWav(new Float32Array(16 * 16000))
    expect(pieceSeconds(long.subarray(0, 44), long.length)).toBeNull()
    const stereo = piece(1); stereo[22] = 2
    expect(pieceSeconds(stereo.subarray(0, 44), stereo.length)).toBeNull()
  })
})
