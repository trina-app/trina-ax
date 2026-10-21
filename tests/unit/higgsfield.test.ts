// generate_video's Higgsfield client (server/src/tools/higgsfield.ts) against a stand-in fetch: submit + poll, every
// terminal status, a wrong key, the key file format and the download checks. No real API calls.
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
  test('downloadVideo: https only, address checked, bytes saved', async () => {
    const dst = path.join(W, 'v.mp4')
    await expect(downloadVideo('http://cdn.example/v.mp4', dst)).rejects.toThrow(/not https/)
    let checked = ''
    const n = await downloadVideo('https://cdn.example/v.mp4', dst, (async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch, async (u) => { checked = u })
    expect(n).toBe(3)
    expect(checked).toBe('https://cdn.example/v.mp4')
    expect([...fs.readFileSync(dst)]).toEqual([1, 2, 3])
  })
  test('the confirmation card exists in every language with the same placeholders', () => {
    for (const l of ['ko', 'en', 'id'] as const) for (const p of ['{duration}', '{aspect}', '{resolution}', '{prompt}']) expect(TEXT.confirm[l]).toContain(p)
  })
})
