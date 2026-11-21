// The piece runner under voice input (server/src/jobs/meeting-piece.ts, POST /api/transcribe/piece): the parts the
// voice input tests (c-voice-piece.test.ts) do not cover: a provider failure, two pieces at once, the app's WAV header,
// and whisper.cpp on this server. (These tests came from the desktop meeting notes, removed 2026-11-19.) OpenRouter is
// a fake here (never the real one); the piece is deleted whatever happens.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { componentC } from '../../server/src/team-files/component'
import { updateTeamSettings } from '../../server/src/admin/settings'
import { credentialsOf } from '../../server/src/credentials/store'
import { writeSpeechKey } from '../../server/src/credentials/speech-key'
import { pieceSeconds, resetPieceLimitsForTests, speechPiece, type MeetingDeps } from '../../server/src/jobs/meeting-piece'
import { pieceWav } from '@mycel/shared/speech-pieces'
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
  A = await makeCApp('c-speech-piece')
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
  resetPieceLimitsForTests()
  delete process.env.MYCEL_SAFE_OPS_1A
  updateTeamSettings(A.ctx.db, { speechProvider: 'openrouter' })
  writeSpeechKey(credentialsOf(A.ctx), KEY)
})

const piece = (sec = 2) => pieceWav(new Float32Array(Math.round(sec * 16000)).map((_, i) => 0.1 * Math.sin(i / 7)))
async function send(bytes: Uint8Array, fields: Record<string, string> = {}) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  fd.set('file', new File([new Uint8Array(bytes)], 'piece.wav'))
  return A.json('/api/transcribe/piece', { method: 'POST', body: fd, as: 'alice' })
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
})

describe('a piece on this server', () => {
  const deps = (o: Partial<MeetingDeps> = {}): MeetingDeps => ({
    stt: { ...C().transcribe, whisperBin: '/nonexistent/whisper-cli', modelDir: path.join(A.data, 'meet-models'), modelOverride: { file: 'm.bin', size: 1000, sha256: '0'.repeat(64) }, baseUrl: 'http://127.0.0.1:9/' },
    provider: () => 'local', openRouter: () => null, confidential: () => false, ...o,
  })
  /** the piece as the route hands it over: a server-owned file */
  const pieceFile = (name: string, wav: Uint8Array) => { const f = path.join(A.data, name); fs.writeFileSync(f, wav); return f }
  test('no whisper-cli: off (final), the piece removed', async () => {
    const d = deps()
    d.stt.whisperBin = null
    const f = pieceFile('piece-off.wav', piece(1))
    await expect(speechPiece(d, 'alice', f, { locale: 'en' })).rejects.toMatchObject({ reason: 'off' })
    expect(fs.existsSync(f)).toBe(false)
  })
  test('the model not there yet: not_ready (sent again later), the piece removed', async () => {
    const f = pieceFile('piece-model.wav', piece(1))
    await expect(speechPiece(deps(), 'alice', f, { locale: 'en' })).rejects.toMatchObject({ reason: 'not_ready' })
    expect(fs.existsSync(f)).toBe(false)
  })
  // a script needs its shell, which the isolation (macOS sandbox, bwrap) does not let it run: only without isolation
  // (MYCEL_ISOLATION=none bun test tests/unit/c-speech-piece.test.ts)
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
    const r = await speechPiece(d, 'alice', f, { locale: 'en' })
    expect(r.lines[0]).toEqual({ start: 0.1, end: 1.5, text: 'hi there' })
    expect(r.lines).toHaveLength(2)
    // the end is kept within the piece (2 s), and no temperature fallback (-nf)
    expect(r.lines[1]!.start).toBe(1.9)
    expect(r.lines[1]!.end).toBe(2)
    expect(r.lines[1]!.text).toContain('-nf')
    expect(fs.existsSync(f)).toBe(false)
    expect(fs.readdirSync(d.stt.workBase).length).toBe(work)
  })
  // whisper.cpp's JSON with token probabilities (-ojf), as 1.9 writes it: " you" over digital silence (first word 0.14
  // sure) and " Yes" from a person (0.81); a beep is written as "(beep)"
  test.skipIf(isolation() !== 'none')('a fake whisper-cli (QA TC-4581): its unsure word on a beep, "(beep)" and silence give no lines; a sure "Yes" is kept', async () => {
    const d = deps()
    const bin = path.join(A.data, 'fake-whisper-ojf')
    fs.mkdirSync(d.stt.modelDir, { recursive: true })
    fs.writeFileSync(path.join(d.stt.modelDir, 'm.bin'), Buffer.alloc(1000))
    d.stt.whisperBin = bin
    const answer = (text: string, p: number) => JSON.stringify({ result: { language: 'en' }, transcription: [{ offsets: { from: 0, to: 1000 }, text: ` ${text}`, tokens: [{ text: '[_BEG_]', p: 0.9 }, { text: ` ${text}`, p }, { text: '[_TT_50]', p: 0.1 }] }] })
    const run = async (json: string, wav: Uint8Array) => {
      // the script also leaves a mark that it ran, next to itself
      fs.writeFileSync(bin, `#!/bin/sh\ntouch ${JSON.stringify(bin + '.ran')} 2>/dev/null\nprintf '%s' '${json}' > out.json\n`, { mode: 0o755 })
      fs.rmSync(bin + '.ran', { force: true })
      const f = path.join(A.data, 'piece-ojf.wav')
      fs.writeFileSync(f, wav)
      return speechPiece(d, 'alice', f, { locale: 'en' })
    }
    const tone = pieceWav(Float32Array.from({ length: 16000 }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 1000 * i / 16000)))
    expect((await run(answer('you', 0.14), tone)).lines).toEqual([])
    expect((await run(answer('(beep)', 0.41), tone)).lines).toEqual([])
    // silence never reaches whisper.cpp
    expect((await run(answer('you', 0.14), pieceWav(new Float32Array(16000)))).lines).toEqual([])
    expect(fs.existsSync(bin + '.ran')).toBe(false)
    // a person: syllables of a voice with pauses
    const spoken = pieceWav(Float32Array.from({ length: 16000 }, (_, i) => {
      const t = i % 4000
      if (t >= 2880) return 0
      let v = 0
      for (let h = 1; h <= 8; h++) v += Math.sin(2 * Math.PI * (110 + 40 * t / 2880 + 15 * (Math.floor(i / 4000) % 3)) * h * i / 16000) / h
      return 0.1 * Math.sin(Math.PI * t / 2880) * v
    }))
    expect((await run(answer('Yes', 0.81), spoken)).lines).toEqual([{ start: 0, end: 1, text: 'Yes' }])
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
