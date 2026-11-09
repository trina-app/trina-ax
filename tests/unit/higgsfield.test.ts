// generate_video's Higgsfield client (server/src/tools/higgsfield.ts) against a stand-in fetch: submit + poll, every
// terminal status, a wrong key, the key file format and the download's https rule. No real API calls.
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { downloadVideo, higgsfieldKey, runHiggsfield, TEXT } from '../../server/src/tools/higgsfield'

const W = fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-hf-'))
afterAll(() => fs.rmSync(W, { recursive: true, force: true }))

/** A stand-in API: the submit answer, then the status answers in order; records the calls. */
function api(submit: { status: number; body: object }, statuses: object[]) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: unknown }[] = []
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', headers: init?.headers as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (init?.method === 'POST') return Response.json(submit.body, { status: submit.status })
    return Response.json(statuses.shift() ?? { status: 'in_progress' })
  }) as unknown as typeof fetch
  return { f, calls }
}
const base = { key: 'kid:ksecret', endpoint: 'alibaba/happy-horse/text-to-video', body: { prompt: 'waves at sunset', duration: 5 }, idempotencyKey: 'turn-1', pollMs: 1 }

describe('runHiggsfield', () => {
  test('submits with the key pair header, polls until completed, returns the video URL', async () => {
    const { f, calls } = api({ status: 200, body: { status: 'queued', request_id: 'r1' } }, [{ status: 'in_progress' }, { status: 'completed', request_id: 'r1', video: { url: 'https://cdn.example/v.mp4' } }])
    expect(await runHiggsfield({ ...base, fetchFn: f })).toEqual({ requestId: 'r1', videoUrl: 'https://cdn.example/v.mp4' })
    expect(calls[0]!.url).toBe('https://api.higgsfield.ai/alibaba/happy-horse/text-to-video')
    expect(calls[0]!.headers.Authorization).toBe('Key kid:ksecret')
    expect(calls[0]!.headers['Idempotency-Key']).toBe('turn-1')
    expect(calls[0]!.body).toEqual(base.body)
    expect(calls.slice(1).every((c) => c.url === 'https://api.higgsfield.ai/requests/r1/status' && c.method === 'GET')).toBe(true)
  })
  test('failed / nsfw / canceled end with a clear message (not charged where the API says so)', async () => {
    for (const [st, msg] of [['failed', /could not make the video/], ['nsfw', /content moderation/], ['canceled', /canceled/]] as const) {
      const { f } = api({ status: 200, body: { status: 'queued', request_id: 'r2' } }, [{ status: st }])
      await expect(runHiggsfield({ ...base, fetchFn: f })).rejects.toThrow(msg)
    }
  })
  test('a wrong key says so; waiting too long gives the request id', async () => {
    const bad = api({ status: 401, body: { detail: 'invalid key' } }, [])
    await expect(runHiggsfield({ ...base, fetchFn: bad.f })).rejects.toThrow(/API key is wrong/)
    const slow = api({ status: 200, body: { status: 'queued', request_id: 'r3' } }, [])
    await expect(runHiggsfield({ ...base, fetchFn: slow.f, waitMaxMs: 20 })).rejects.toThrow(/request r3/)
  })
})

describe('key file and download', () => {
  test('higgsfieldKey: "<id>:<secret>" only', () => {
    const d = path.join(W, 'data'); fs.mkdirSync(path.join(d, 'secrets'), { recursive: true })
    expect(higgsfieldKey(d)).toBeNull()
    fs.writeFileSync(path.join(d, 'secrets', 'higgsfield.key'), 'abc:def\n')
    expect(higgsfieldKey(d)).toBe('abc:def')
    fs.writeFileSync(path.join(d, 'secrets', 'higgsfield.key'), 'only-one-part')
    expect(higgsfieldKey(d)).toBeNull()
  })
  // the download itself (https on every hop, each redirect's address checked, streamed): tests/unit/download.test.ts
  test('downloadVideo: https only', async () => {
    await expect(downloadVideo('http://cdn.example/v.mp4', path.join(W, 'v.mp4'))).rejects.toThrow(/not https/)
  })
  test('the confirmation card exists in every language with the same placeholders', () => {
    for (const l of ['ko', 'en', 'id'] as const) for (const p of ['{duration}', '{aspect}', '{resolution}', '{prompt}']) expect(TEXT.confirm[l]).toContain(p)
  })
})

// bug 1 (docs/DECISIONS.md "Refusals say why, who and what next"): a scheduled run's person is never asked, and the
// text said "the person did not allow this video"; a card that timed out read like a no; the daily limit said no time
describe('generate_video refusals say the real reason', () => {
  const { Database } = require('bun:sqlite') as typeof import('bun:sqlite')
  const { ToolRegistry } = require('../../server/src/tools/registry') as typeof import('../../server/src/tools/registry')
  const { registerHiggsfield } = require('../../server/src/tools/higgsfield') as typeof import('../../server/src/tools/higgsfield')
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-hf-refusals-'))
  afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dataDir, 'secrets'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'secrets', 'higgsfield.key'), 'kid:ksecret')
  const db = new Database(':memory:')
  db.run('CREATE TABLE tool_events (user_id TEXT, tool TEXT, ok INTEGER, at TEXT)')
  const reg = new ToolRegistry()
  registerHiggsfield({ engineConfig: { dataDir }, db } as never, reg)
  const args = { prompt: 'waves at sunset', duration: 5, aspect_ratio: '16:9', resolution: '720p' }
  const person = (o: { unattended?: boolean; end?: 'declined' | 'timeout' }) => ({
    locale: 'ko' as const, unattended: o.unattended, asked: 0,
    async confirm() { this.asked++; return false },
    async confirmWhy() { this.asked++; return o.end ?? 'declined' },
    *turnUrls() {},
  })
  const run = (p: ReturnType<typeof person>) => reg.call('generate_video', args, { user: { id: 'alice', name: 'Alice', role: 'member', groups: [] }, turnId: 't1', files: {} as never, person: p })

  test('a scheduled run: nobody asked, no credits, never "did not allow"', async () => {
    const p = person({ unattended: true })
    const r = await run(p)
    expect(p.asked).toBe(0)
    expect(r.isError).toBe(true)
    expect(r.text).toContain('No video was made and no credits were spent. Why: nobody could be asked: this is a scheduled run')
    expect(r.text).not.toContain('did not allow')
    expect(r.text).toContain('Next step: the user can ask for the video in a chat, where they confirm it.')
  })

  test('a card that timed out is not a no; a no says so', async () => {
    const t = await run(person({ end: 'timeout' }))
    expect(t.text).toContain('did not answer the confirmation card in time')
    expect(t.text).not.toContain('did not allow')
    const n = await run(person({ end: 'declined' }))
    expect(n.text).toContain('The person did not allow this video, so no video was made and no credits were spent.')
    expect(n.text).toContain('Next step: ask what to change.')
  })

  test('the daily limit: the number, when it frees up, who sets it (H2)', async () => {
    const at = new Date(Date.now() - 3600_000).toISOString()
    for (let i = 0; i < 10; i++) db.query("INSERT INTO tool_events VALUES ('alice', 'generate_video', 1, ?)").run(at)
    const p = person({})
    const r = await run(p)
    expect(p.asked).toBe(0)
    expect(r.text).toContain('Why: a limit of this server: 10 videos per person in any 24 hours; it resets when the oldest of them is 24 hours old, at ')
    expect(r.text).toContain('MYCEL_HIGGSFIELD_DAILY')
  })
})
