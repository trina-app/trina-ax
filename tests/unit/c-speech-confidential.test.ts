// Voice input in confidential chats (docs/security-and-permissions.md, DECISIONS "Voice input in confidential chats"):
// the composer names the chat a recording is for, and the server never sends a confidential chat's recording to
// OpenRouter (the team's key or the hosting service's). A provider on this server still transcribes it. A chat not
// created yet (no id) is what a new chat is: confidential only while Safe operations 1A is on. Checked when the request
// comes, when an upload session is made and completed, when the job runs, and before a second send.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { componentC } from '../../server/src/team-files/component'
import { updateTeamSettings } from '../../server/src/admin/settings'
import { credentialsOf } from '../../server/src/credentials/store'
import { writeSpeechKey } from '../../server/src/credentials/speech-key'
import { makeCApp, jsonBody, sha256hex, type CApp } from '../lib/c-app'

const KEY = 'sk-or-v1-FAKE-TEST-KEY-CONFIDENTIAL-0123456789abcdef'

let A: CApp
const C = () => componentC(A.ctx)
const hits: unknown[] = []
let reply: () => Response | Promise<Response> = () => Response.json({ text: 'hello' })
const fake = Bun.serve({
  port: 0, hostname: '127.0.0.1',
  async fetch(req) {
    hits.push(await req.json().catch(() => null))
    return reply()
  },
})
let saved: { url: string; ffmpeg: string | null; whisper: string | null }
beforeAll(async () => {
  A = await makeCApp('c-speech-confidential')
  const t = C().transcribe
  saved = { url: t.openRouterUrl, ffmpeg: t.ffmpegBin, whisper: t.whisperBin }
  t.openRouterUrl = `http://127.0.0.1:${fake.port}/api/v1/audio/transcriptions`
  t.ffmpegBin = null
  A.ctx.db.query("UPDATE users SET locale = 'en' WHERE id IN ('alice', 'bob')").run()
})
afterAll(async () => {
  const t = C().transcribe
  t.openRouterUrl = saved.url
  t.ffmpegBin = saved.ffmpeg
  t.whisperBin = saved.whisper
  await A.close()
  fake.stop(true)
})
beforeEach(() => {
  hits.length = 0
  reply = () => Response.json({ text: 'hello' })
  updateTeamSettings(A.ctx.db, { speechProvider: 'openrouter' })
  writeSpeechKey(credentialsOf(A.ctx), KEY)
})
afterEach(() => { delete process.env.MYCEL_SAFE_OPS_1A })

const wav = () => { const b = new Uint8Array(3200); b.set([0x52, 0x49, 0x46, 0x46]); return b }
const lock = (chatId: string) => A.ctx.db.query('INSERT INTO safe_ops_chats (chat_id, material) VALUES (?, 1) ON CONFLICT(chat_id) DO UPDATE SET material = 1').run(chatId)
const post = (fields: Record<string, string>, as: 'alice' | 'bob' = 'alice') => {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  fd.set('file', new File([wav()], 'voice.wav'))
  return A.json('/api/transcribe', { method: 'POST', body: fd, as })
}
const work = () => { try { return fs.readdirSync(path.join(A.ctx.config.dataDir, 'work')).filter((f) => f.startsWith('stt-')) } catch { return [] } }

describe('POST /api/transcribe', () => {
  test('a confidential chat with OpenRouter: refused with a note, nothing sent, nothing kept', async () => {
    const chat = A.chat('alice')
    lock(chat)
    const before = work()
    const r = await post({ chatId: chat })
    expect(r.status).toBe(403)
    expect(r.body.error.code).toBe('forbidden')
    expect(r.body.error.params).toEqual({ reason: 'confidential' })
    expect(r.body.error.message).toContain('confidential chat')
    expect(r.body.error.message).toContain('OpenRouter')
    expect(hits).toEqual([])
    expect(work()).toEqual(before)
  })
  test('the note is 해요체 in Korean', async () => {
    const chat = A.chat('alice')
    lock(chat)
    A.ctx.db.query("UPDATE users SET locale = 'ko' WHERE id = 'alice'").run()
    try {
      const r = await post({ chatId: chat })
      expect(r.status).toBe(403)
      expect(r.body.error.message).toContain('기밀 대화라서 녹음을 바깥 음성 서비스(OpenRouter)로 보내지 않았어요.')
      expect(r.body.error.message).not.toMatch(/습니다|합니다/)
    } finally { A.ctx.db.query("UPDATE users SET locale = 'en' WHERE id = 'alice'").run() }
  })
  test('an ordinary chat goes to OpenRouter as before', async () => {
    const r = await post({ chatId: A.chat('alice') })
    expect(r.status).toBe(202)
    const job = (await C().jobs.wait(r.body.jobId))!
    expect(job.status, JSON.stringify(job.error)).toBe('done')
    expect(hits.length).toBe(1)
  })
  test('on this server a confidential chat still transcribes (nothing goes out)', async () => {
    updateTeamSettings(A.ctx.db, { speechProvider: 'local' })
    C().transcribe.whisperBin = null
    const chat = A.chat('alice')
    lock(chat)
    const r = await post({ chatId: chat })
    expect(r.status).toBe(202)
    const job = (await C().jobs.wait(r.body.jobId))!
    // the local path ran (no whisper.cpp in this test): not the confidential refusal
    expect(job.error!.message).toContain('whisper.cpp')
    expect(hits).toEqual([])
  })
  test('without a chat id (a new chat): refused only while Safe operations 1A is on', async () => {
    process.env.MYCEL_SAFE_OPS_1A = '1'
    const r = await post({})
    expect(r.status).toBe(403)
    expect(r.body.error.params).toEqual({ reason: 'confidential' })
    expect(hits).toEqual([])
    delete process.env.MYCEL_SAFE_OPS_1A
    const ok = await post({})
    expect(ok.status).toBe(202)
    expect((await C().jobs.wait(ok.body.jobId))!.status).toBe('done')
    expect(hits.length).toBe(1)
  })
  test("someone else's chat id is not found (and reveals nothing about it)", async () => {
    const theirs = A.chat('bob')
    lock(theirs)
    const r = await post({ chatId: theirs })
    expect(r.status).toBe(404)
    expect(hits).toEqual([])
  })
  test('a chat locked while the recording waits for its turn: the job refuses it when it runs', async () => {
    // the first recording holds the speech queue until released
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    reply = async () => { await held; return Response.json({ text: 'first' }) }
    const first = await post({ chatId: A.chat('alice') })
    const chat = A.chat('alice')
    const second = await post({ chatId: chat })
    expect(second.status).toBe(202)
    lock(chat)
    release()
    expect((await C().jobs.wait(first.body.jobId))!.status).toBe('done')
    const job = (await C().jobs.wait(second.body.jobId))!
    expect(job.status).toBe('failed')
    expect(job.error!.code).toBe('forbidden')
    expect(job.error!.message).toContain('confidential chat')
    expect(hits.length).toBe(1)
  })
  test('a chat locked during the first try: the provider failure is not sent a second time', async () => {
    const chat = A.chat('alice')
    reply = () => { lock(chat); return Response.json({ error: { message: 'down' } }, { status: 503 }) }
    const r = await post({ chatId: chat })
    expect(r.status).toBe(202)
    const job = (await C().jobs.wait(r.body.jobId))!
    expect(job.status).toBe('failed')
    expect(hits.length).toBe(1)
  })
})

describe('upload sessions (long recordings)', () => {
  const session = (chatId: string | undefined, size = 3200) => A.json('/api/upload-sessions', { ...jsonBody({ target: { kind: 'transcribe', name: 'long.wav', ...(chatId ? { chatId } : {}) }, size, sha256: sha256hex(wav()) }), as: 'alice' })
  test('a confidential chat: the session is refused before any byte is uploaded', async () => {
    const chat = A.chat('alice')
    lock(chat)
    const r = await session(chat)
    expect(r.status).toBe(403)
    expect(r.body.error.params).toEqual({ reason: 'confidential' })
  })
  test("someone else's chat: not found", async () => {
    expect((await session(A.chat('bob'))).status).toBe(404)
  })
  test('locked during the upload: complete refuses it, drops the recording and sends nothing', async () => {
    const chat = A.chat('alice')
    const s = await session(chat)
    expect(s.status).toBe(201)
    const put = await A.req(`/api/upload-sessions/${s.body.id}/chunks/0`, { method: 'PUT', body: wav(), as: 'alice' })
    expect(put.status).toBe(200)
    lock(chat)
    const done = await A.json(`/api/upload-sessions/${s.body.id}/complete`, { method: 'POST', as: 'alice' })
    expect(done.status).toBe(403)
    expect(fs.existsSync(path.join(A.ctx.config.dataDir, 'uploads', `${s.body.id}.part`))).toBe(false)
    expect((await A.json(`/api/upload-sessions/${s.body.id}`, { as: 'alice' })).status).toBe(404)
    expect(hits).toEqual([])
  })
  test('an ordinary chat: complete starts the job, which sends it', async () => {
    const s = await session(A.chat('alice'))
    await A.req(`/api/upload-sessions/${s.body.id}/chunks/0`, { method: 'PUT', body: wav(), as: 'alice' })
    const done = await A.json(`/api/upload-sessions/${s.body.id}/complete`, { method: 'POST', as: 'alice' })
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect((await C().jobs.wait(done.body.jobId))!.status).toBe('done')
    expect(hits.length).toBe(1)
  })
})

