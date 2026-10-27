import { expect, test } from 'bun:test'
import { DRIVE_API, GoogleTransport } from '../../server/src/integrations/google-drive/client'

test('transport refuses redirects, unauthorized destinations and both declared and streaming oversize bodies', async () => {
  let calls = 0
  const t = new GoogleTransport(async () => { calls++; return new Response('too large', { headers: { 'content-length': '9000' } }) })
  await expect(t.request('https://evil.example.test/', {}, 5)).rejects.toThrow('invalid_endpoint')
  expect(calls).toBe(0)
  await expect(t.request(DRIVE_API + 'files', {}, 5)).rejects.toThrow('too_large')
  const stream = new GoogleTransport(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(3)); c.enqueue(new Uint8Array(3)); c.close() } })))
  await expect(stream.request(DRIVE_API + 'files', {}, 5)).rejects.toThrow('too_large')
  const redirect = new GoogleTransport(async (_, init) => { expect(init?.redirect).toBe('manual'); return new Response('', { status: 302, headers: { location: 'http://localhost/' } }) })
  await expect(redirect.request(DRIVE_API + 'files')).rejects.toThrow('provider_redirect')
})
test('transport hides arbitrary provider exceptions and cancels a stalled stream', async () => {
  const bad = new GoogleTransport(async () => { throw new Error('CANARY-secret bearer token and private data') })
  await expect(bad.request(DRIVE_API + 'files')).rejects.toThrow('drive_provider_unavailable')
  let cancelled = false
  const stall = new GoogleTransport(async () => new Response(new ReadableStream({ cancel() { cancelled = true } })))
  const abort = new AbortController(), result = stall.request(DRIVE_API + 'files', { signal: abort.signal })
  await new Promise(r => setTimeout(r, 1)); abort.abort()
  await expect(result).rejects.toThrow('drive_cancelled'); expect(cancelled).toBe(true)
})
