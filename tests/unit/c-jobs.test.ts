// Component C: the job service (queue, progress, cancel, restart recovery, cleanup), the jobs API, and
// transcription with whisper.cpp (model download with sha256 check, ffmpeg conversion, clear failures).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { Job as JobSchema } from '@mycel/shared/api'
import { JobFailure, JobServiceImpl } from '../../server/src/jobs/service'
import { ensureModel, parseWhisperJson, WHISPER_MODELS, type TranscribeConfig } from '../../server/src/jobs/transcribe'
import { componentC } from '../../server/src/team-files/component'
import { which } from '../../server/src/config'
import { jsonBody, makeCApp, sha256hex, type CApp } from '../lib/c-app'

let A: CApp
beforeAll(async () => { A = await makeCApp('c-jobs') })
afterAll(async () => { await A.close() })
const C = () => componentC(A.ctx)
setDefaultTimeout(180_000)
const CACHE = path.resolve(import.meta.dir, '..', '.cache', 'whisper')
/** The tiny model (75 MB) is downloaded once into tests/.cache (git-ignored) the way the server does it on first use. */
async function cachedTinyModel(): Promise<boolean> {
  if (fs.existsSync(path.join(CACHE, WHISPER_MODELS.tiny.file))) return true
  try {
    await ensureModel({ ...C().transcribe, modelDir: CACHE, model: 'tiny' })
    return true
  } catch (e) { console.log('could not download the tiny whisper model (offline?):', String(e)); return false }
}

describe('job service', () => {
  test('runs in the background, reports progress (throttled) and the result', async () => {
    A.hub.clear()
    const id = C().jobs.start({ kind: 'export', userId: 'alice', run: async (h) => {
      for (let i = 1; i <= 5; i++) { h.progress(i / 5, `step ${i}`); await Bun.sleep(130) }
      return { path: 'shared/export.zip', size: 10 }
    } })
    expect(C().jobs.get(id)!.status).toBe('queued')
    const job = await C().jobs.wait(id)
    expect(job).toMatchObject({ status: 'done', progress: 1, result: { path: 'shared/export.zip', size: 10 } })
    expect(JobSchema.safeParse(job).success).toBe(true)
    const prog = A.hub.of('job.progress', 'alice')
    expect(prog.length).toBeGreaterThanOrEqual(2)
    expect(prog.length).toBeLessThanOrEqual(5)
    expect(A.hub.of('job.done', 'alice').map((e) => e.data.job.id)).toEqual([id])
    expect(fs.existsSync(C().jobs.dir(id))).toBe(false)
  })
  test('failures carry a message in the person\'s language; unexpected errors stay generic', async () => {
    const a = C().jobs.start({ kind: 'export', userId: 'alice', run: async () => { throw new JobFailure('unavailable', { ko: '도구가 없습니다', en: 'tool missing', id: 'alat tidak ada' }) } })
    expect((await C().jobs.wait(a))!.error).toEqual({ code: 'unavailable', message: '도구가 없습니다' }) // alice's locale is ko
    const b = C().jobs.start({ kind: 'export', userId: 'alice', run: async () => { throw new Error('secret internal detail') } })
    const jb = (await C().jobs.wait(b))!
    expect(jb.status).toBe('failed')
    expect(jb.error!.code).toBe('internal')
    expect(JSON.stringify(jb)).not.toContain('secret internal detail')
  })
  test('one heavy job of a kind at a time; cancel a queued and a running job', async () => {
    const order: string[] = []
    const slow = (name: string) => async (h: { signal: AbortSignal }) => {
      order.push('start ' + name)
      for (let i = 0; i < 50 && !h.signal.aborted; i++) await Bun.sleep(20)
      order.push('end ' + name)
      return { backupId: name, size: 1, createdAt: new Date().toISOString() }
    }
    const j1 = C().jobs.start({ kind: 'backup', userId: null, run: slow('1') })
    const j2 = C().jobs.start({ kind: 'backup', userId: null, run: slow('2') })
    const j3 = C().jobs.start({ kind: 'backup', userId: null, run: slow('3') })
    await Bun.sleep(50)
    expect(C().jobs.get(j2)!.status).toBe('queued')
    expect(C().jobs.cancel(j3)).toBe(true)
    expect(C().jobs.get(j3)!.status).toBe('canceled')
    expect(C().jobs.cancel(j1)).toBe(true)
    expect((await C().jobs.wait(j1))!.status).toBe('canceled')
    expect((await C().jobs.wait(j2))!.status).toBe('done')
    expect(order).toEqual(['start 1', 'end 1', 'start 2', 'end 2'])
    expect(C().jobs.cancel(j2)).toBe(false)
  })
  test('after a restart, queued / running jobs of the old process are failed; old jobs are cleaned up', () => {
    const db = A.ctx.db
    db.query("INSERT INTO jobs (id, user_id, kind, status) VALUES ('01890000-0000-7000-8000-000000000001', 'bob', 'transcribe', 'running')").run()
    const fresh = new JobServiceImpl(A.ctx)
    expect(fresh.recover()).toBe(1)
    const j = fresh.get('01890000-0000-7000-8000-000000000001')!
    expect(j.status).toBe('failed')
    expect(j.error!.message).toContain('서버가 다시 시작')
    db.query("UPDATE jobs SET finished_at = '2000-01-01T00:00:00.000Z' WHERE id = '01890000-0000-7000-8000-000000000001'").run()
    expect(fresh.sweep()).toBeGreaterThanOrEqual(1)
    expect(fresh.get('01890000-0000-7000-8000-000000000001')).toBeNull()
  })
})

describe('jobs API', () => {
  test('own jobs only (the owner only sees jobs that belong to nobody); cancel', async () => {
    const id = C().jobs.start({ kind: 'export', userId: 'bob', run: async (h) => { while (!h.signal.aborted) await Bun.sleep(10); return null } })
    await Bun.sleep(20)
    expect((await A.json(`/api/jobs/${id}`, { as: 'bob' })).body.status).toBe('running')
    expect((await A.json(`/api/jobs/${id}`, { as: 'alice' })).status).toBe(404)
    expect((await A.json(`/api/jobs/${id}`, { as: 'carol' })).status).toBe(404) // admin is not owner
    expect((await A.json(`/api/jobs/${id}`, { as: 'dana' })).status).toBe(404) // a member's job (a transcript) is theirs alone
    const sys = C().jobs.start({ kind: 'backup', userId: null, run: async () => null })
    await C().jobs.wait(sys)
    expect((await A.json(`/api/jobs/${sys}`, { as: 'dana' })).status).toBe(200)
    expect((await A.json(`/api/jobs/${sys}`, { as: 'carol' })).status).toBe(404)
    expect((await A.json(`/api/jobs/${id}/cancel`, { method: 'POST', as: 'alice' })).status).toBe(404)
    expect((await A.json(`/api/jobs/${id}/cancel`, { method: 'POST', as: 'bob' })).status).toBe(200)
    expect((await C().jobs.wait(id))!.status).toBe('canceled')
  })
})

describe('transcription', () => {
  const upload = async (bytes: Uint8Array, name: string, fields: Record<string, string> = {}) => {
    const fd = new FormData()
    for (const [k, v] of Object.entries(fields)) fd.set(k, v)
    fd.set('file', new File([new Uint8Array(bytes)], name))
    return A.json('/api/transcribe', { method: 'POST', body: fd, as: 'alice' })
  }
  test('whisper.cpp missing: 202, then the job fails with an install hint', async () => {
    const t = C().transcribe
    const saved = t.whisperBin
    t.whisperBin = null
    try {
      const r = await upload(new Uint8Array(100), 'voice.webm')
      expect(r.status).toBe(202)
      const job = (await C().jobs.wait(r.body.jobId))!
      expect(job.status).toBe('failed')
      expect(job.error!.message).toContain('brew install whisper-cpp')
    } finally { t.whisperBin = saved }
  })
  test('attaching the job to someone else\'s chat is refused', async () => {
    expect((await upload(new Uint8Array(10), 'v.wav', { chatId: A.chat('bob') })).status).toBe(404)
  })
  test('model download: sha256-checked, atomic, with progress; a damaged download is discarded', async () => {
    // a stand-in "model" (3 MB) served locally: the real one is 75-470 MB
    const fake = new Uint8Array(3 * 1024 * 1024).map((_, i) => (i * 31) % 256)
    const spec = { file: 'ggml-fake.bin', size: fake.length, sha256: sha256hex(fake) }
    const srv = Bun.serve({ port: 19138, hostname: '127.0.0.1', fetch: (req) => new URL(req.url).pathname.startsWith('/bad/') ? new Response(fake.map((b) => b ^ 1)) : new Response(fake) })
    try {
      const dir = path.join(A.data, 'models-test')
      const cfg: TranscribeConfig = { ...C().transcribe, modelDir: dir, modelOverride: spec, baseUrl: 'http://127.0.0.1:19138/' }
      const seen: number[] = []
      const ac = new AbortController()
      const file = await ensureModel(cfg, { progress: (p) => { if (p !== null) seen.push(p) }, signal: ac.signal })
      expect(file).toBe(path.join(dir, 'ggml-fake.bin'))
      expect(sha256hex(fs.readFileSync(file))).toBe(spec.sha256)
      expect(seen[seen.length - 1]).toBeCloseTo(0.5, 2)
      expect(fs.existsSync(file + '.part')).toBe(false)
      const bad = path.join(A.data, 'models-bad')
      await expect(ensureModel({ ...cfg, modelDir: bad, baseUrl: 'http://127.0.0.1:19138/bad/' })).rejects.toBeInstanceOf(JobFailure)
      expect(fs.readdirSync(bad)).toEqual([])
    } finally { srv.stop(true) }
  })
  test('whisper JSON parsing', () => {
    const r = parseWhisperJson(JSON.stringify({ result: { language: 'ko' }, transcription: [{ offsets: { from: 0, to: 1500 }, text: ' 안녕하세요.' }, { offsets: { from: 1500, to: 1600 }, text: ' [BLANK_AUDIO]' }, { offsets: { from: 1600, to: 3200 }, text: ' 회의를 시작합니다.' }] }))
    expect(r).toEqual({ text: '안녕하세요. 회의를 시작합니다.', language: 'ko', durationSec: 3.2, segments: [{ start: 0, end: 1.5, text: '안녕하세요.' }, { start: 1.6, end: 3.2, text: '회의를 시작합니다.' }] })
  })
  test('real transcription (tiny model, speech made with `say`), small upload and upload session', async () => {
    const say = which('say'), whisper = which('whisper-cli')
    if (!say || !whisper || !which('ffmpeg') || !(await cachedTinyModel())) { console.log('say / whisper-cli / ffmpeg / tiny model missing: real transcription skipped'); return }
    const t = C().transcribe
    Object.assign(t, { modelDir: CACHE, model: 'tiny' })
    const aiff = path.join(A.data, 'speech.aiff')
    Bun.spawnSync([say, '-v', 'Samantha', '-o', aiff, 'Hello team, the meeting starts at three o clock.'])
    const bytes = new Uint8Array(fs.readFileSync(aiff))
    A.hub.clear()
    const r = await upload(bytes, 'memo.aiff', { language: 'en' })
    expect(r.status).toBe(202)
    const job = (await C().jobs.wait(r.body.jobId))!
    expect(job.status, JSON.stringify(job.error)).toBe('done')
    const res = job.result as { text: string; language: string; durationSec: number }
    expect(res.text.toLowerCase()).toContain('meeting')
    expect(res.language).toBe('en')
    expect(res.durationSec).toBeGreaterThan(1)
    expect(A.hub.of('job.progress', 'alice').length).toBeGreaterThan(0)
    // same through an upload session (large recordings)
    const s = await A.json('/api/upload-sessions', { ...jsonBody({ target: { kind: 'transcribe', name: 'meeting.aiff' }, size: bytes.length, sha256: sha256hex(bytes) }), as: 'alice' })
    expect(s.status).toBe(201)
    await A.json(`/api/upload-sessions/${s.body.id}/chunks/0`, { method: 'PUT', body: bytes, headers: { 'content-type': 'application/octet-stream' }, as: 'alice' })
    const done = await A.json(`/api/upload-sessions/${s.body.id}/complete`, { method: 'POST', as: 'alice' })
    expect(done.body.kind).toBe('transcribe')
    const j2 = (await C().jobs.wait(done.body.jobId))!
    expect((j2.result as { text: string }).text.toLowerCase()).toContain('meeting')
    expect(fs.readdirSync(path.join(A.data, 'work')).filter((f) => f.startsWith('stt-'))).toEqual([]) // inputs cleaned up
  })
})
