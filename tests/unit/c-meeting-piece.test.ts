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
import { MeetingSpeed, meetingPiece, meetingStatus, MEETING_LOCAL_MAX_SEC_PER_SEC, MEETING_SPEED_WINDOW_MS, pieceSeconds, type MeetingDeps } from '../../server/src/jobs/meeting-piece'
import { pieceWav } from '../../desktop/src/common/meeting/chunker'
import { makeCApp, type CApp } from '../lib/c-app'
import { isolation } from '../../server/src/tools/isolate'

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
  test('voice input off: 409 with its reason (the app ends the meeting), nothing sent', async () => {
    updateTeamSettings(A.ctx.db, { speechProvider: 'off' })
    const r = await send(piece(1))
    expect(r.status).toBe(409)
    expect(r.body.error.params).toEqual({ reason: 'off' })
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
  test('a third piece while two are under way: 429 in_flight with a retry time, nothing left', async () => {
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    reply = () => Response.json({ text: 'x', segments: [{ start: 0, end: 1, text: 'x' }] })
    const slow = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch() { await held; return Response.json({ text: 'x', segments: [{ start: 0, end: 1, text: 'x' }] }) } })
    const t = C().transcribe
    const url = t.openRouterUrl
    t.openRouterUrl = `http://127.0.0.1:${slow.port}/`
    try {
      const a = send(piece(1)), b = send(piece(1))
      await Bun.sleep(150)
      const c = await send(piece(1))
      expect(c.status).toBe(429)
      expect(c.body.error.params).toEqual({ reason: 'in_flight' })
      expect(c.res.headers.get('retry-after')).toBe('2')
      release()
      expect((await a).status).toBe(200)
      expect((await b).status).toBe(200)
    } finally { t.openRouterUrl = url; slow.stop(true) }
    expect(leftovers()).toEqual([])
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
  test('the speed counts only after a few pieces; the first (the model loading) is not counted', () => {
    let now = 1_000_000
    const s = new MeetingSpeed(() => now)
    s.record(60_000, 10)
    s.record(500, 10); s.record(500, 10)
    expect(s.secPerSec()).toBeNull()
    s.record(500, 10)
    expect(s.secPerSec()).toBeCloseTo(0.05, 3)
  })
  test('a busy spell is forgotten: too slow becomes ready again after the window', () => {
    let now = 1_000_000
    const s = new MeetingSpeed(() => now)
    for (let i = 0; i < 6; i++) { s.record(20_000, 15); now += 1000 }
    expect(s.tooSlow()).toBe(true)
    now += MEETING_SPEED_WINDOW_MS + 1
    expect(s.tooSlow()).toBe(false)
    expect(s.secPerSec()).toBeNull()
  })
  test('sum over sum: a short piece does not count as a whole window', () => {
    let now = 1_000_000
    const s = new MeetingSpeed(() => now)
    s.record(0, 1)
    s.record(1000, 0.5); s.record(1000, 14.5); s.record(1000, 15)
    expect(s.secPerSec()).toBeCloseTo(3 / 30, 3)
  })
  // a script needs its shell, which the isolation (macOS sandbox, bwrap) does not let it run: only without isolation
  // (MYCEL_ISOLATION=none bun test tests/unit/c-meeting-piece.test.ts)
  test.skipIf(isolation() !== 'none')('a fake whisper-cli: lines come back on piece time, without the fallback, nothing left behind', async () => {
    const d = deps()
    const bin = path.join(A.data, 'fake-whisper-cli')
    // writes out.json as whisper.cpp does (-of out -oj) in its work folder (the only place the sandbox lets it write);
    // its arguments come back as a third line, from 1.9 s
    fs.writeFileSync(bin, `#!/bin/sh\nprintf '{"result":{"language":"en"},"transcription":[{"offsets":{"from":100,"to":1500},"text":" hi there"},{"offsets":{"from":1500,"to":1800},"text":"[BLANK_AUDIO]"},{"offsets":{"from":1900,"to":9000},"text":"ARGS %s"}]}' "$*" > out.json\n`, { mode: 0o755 })
    d.stt.whisperBin = bin
    fs.mkdirSync(d.stt.modelDir, { recursive: true })
    fs.writeFileSync(path.join(d.stt.modelDir, 'm.bin'), Buffer.alloc(1000))
    const f = path.join(A.data, 'piece-in.wav')
    fs.writeFileSync(f, piece(2))
    fs.mkdirSync(d.stt.workBase, { recursive: true })
    const work = fs.readdirSync(d.stt.workBase).length
    const r = await meetingPiece(d, 'alice', f, { locale: 'en' })
    expect(r.lines[0]).toEqual({ start: 0.1, end: 1.5, text: 'hi there' })
    expect(r.lines).toHaveLength(2)
    // the end is kept within the piece (2 s), and no temperature fallback (-nf)
    expect(r.lines[1]!.start).toBe(1.9)
    expect(r.lines[1]!.end).toBe(2)
    expect(r.lines[1]!.text).toContain('-nf')
    expect(fs.existsSync(f)).toBe(false)
    expect(fs.readdirSync(d.stt.workBase).length).toBe(work)
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
    const rate = piece(1); rate[29] = 0
    expect(pieceSeconds(rate.subarray(0, 44), rate.length)).toBeNull()
    const riff = piece(1); riff[4] = riff[4]! ^ 1
    expect(pieceSeconds(riff.subarray(0, 44), riff.length)).toBeNull()
  })
})
