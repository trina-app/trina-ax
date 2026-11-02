import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { API, ApiError, uuidv7 } from '@mycel/shared/api'
import { api, isNetworkError, windowId } from '../../src/lib/api'
import { xhrFetch } from '../../src/lib/xhr'

type Handler = ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null

/** The part of XMLHttpRequest that xhrFetch uses. The test plays the browser by calling the handlers. */
class FakeXhr {
  static made: FakeXhr[] = []
  /** changes each new request before it is used */
  static prepare: ((x: FakeXhr) => void) | null = null
  upload = { onprogress: null as Handler, onload: null as (() => void) | null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  responseType = ''
  withCredentials = false
  method = ''
  url = ''
  headers: Record<string, string> = {}
  body: unknown
  sent = false
  aborted = false
  status = 0
  response: unknown = null
  responseHeaders: Record<string, string> = {}
  constructor() { FakeXhr.made.push(this); FakeXhr.prepare?.(this) }
  open(method: string, url: string) { this.method = method; this.url = url }
  setRequestHeader(k: string, v: string) { this.headers[k] = v }
  getResponseHeader(k: string) { return this.responseHeaders[k.toLowerCase()] ?? null }
  send(body: unknown) { this.sent = true; this.body = body }
  abort() { this.aborted = true; this.onabort?.() }
  answer(status: number, body: string | null, contentType = 'application/json') {
    this.status = status
    this.response = body === null ? null : new Blob([body], { type: contentType })
    this.responseHeaders['content-type'] = contentType
    this.onload?.()
  }
}

const original = globalThis.XMLHttpRequest
beforeEach(() => {
  FakeXhr.made = []
  FakeXhr.prepare = null
  globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest
})
afterEach(() => { globalThis.XMLHttpRequest = original })
const last = () => FakeXhr.made.at(-1)!

describe('xhrFetch', () => {
  test('sends what fetch would send and hands back a Response', async () => {
    const body = new FormData()
    const shares: number[] = []
    const r = xhrFetch('/api/uploads', { method: 'POST', headers: { 'x-a': '1' }, body, credentials: 'same-origin' }, (s) => shares.push(s))
    const x = last()
    expect([x.method, x.url, x.body, x.sent]).toEqual(['POST', '/api/uploads', body, true])
    expect(x.headers).toEqual({ 'x-a': '1' })
    expect(x.withCredentials).toBe(false)
    x.answer(201, '{"ok":true}')
    const res = await r
    expect(res.status).toBe(201)
    expect(res.ok).toBe(true)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(await res.json()).toEqual({ ok: true })
  })

  test('credentials: include is honored', () => {
    void xhrFetch('/x', { method: 'POST', credentials: 'include' }, () => {})
    expect(last().withCredentials).toBe(true)
  })

  test('the share of the body that went out, whatever the form adds around the file; the end is 1 even when no count came', async () => {
    const shares: number[] = []
    const r = xhrFetch('/x', { method: 'POST' }, (s) => shares.push(s))
    const x = last()
    expect(x.upload.onprogress).not.toBeNull()
    x.upload.onprogress!({ lengthComputable: true, loaded: 300, total: 1200 })
    x.upload.onprogress!({ lengthComputable: false, loaded: 900, total: 0 })
    x.upload.onload!()
    expect(shares).toEqual([0.25, 1])
    x.answer(200, '{}')
    await r
  })

  test('an answer without a body is a Response too', async () => {
    const r = xhrFetch('/x', { method: 'DELETE' }, () => {})
    last().answer(204, '')
    const res = await r
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
  })

  test('a status a Response cannot hold fails the call instead of leaving it open', async () => {
    const r = xhrFetch('/x', { method: 'POST' }, () => {})
    last().answer(999, 'odd')
    expect(await r.catch((e: unknown) => e)).toBeInstanceOf(RangeError)
  })

  test('a network failure is a TypeError, like fetch: the upload retries it and the screen says "network"', async () => {
    const r = xhrFetch('/x', { method: 'POST' }, () => {})
    last().onerror!()
    const e = await r.catch((x: unknown) => x)
    expect(e).toBeInstanceOf(TypeError)
    expect(isNetworkError(e)).toBe(true)
  })

  test('the signal stops the request, and rejects as an abort', async () => {
    const stop = new AbortController()
    const r = xhrFetch('/x', { method: 'POST', signal: stop.signal }, () => {})
    stop.abort()
    const e = await r.catch((x: unknown) => x)
    expect(last().aborted).toBe(true)
    expect((e as DOMException).name).toBe('AbortError')
    expect(isNetworkError(e)).toBe(false)
  })

  test('a signal that already stopped sends nothing', async () => {
    const stop = new AbortController()
    stop.abort()
    const e = await xhrFetch('/x', { method: 'POST', signal: stop.signal }, () => {}).catch((x: unknown) => x)
    expect((e as DOMException).name).toBe('AbortError')
    expect(FakeXhr.made).toHaveLength(0)
  })

  test('the signal lets go of a finished request', async () => {
    const stop = new AbortController()
    const r = xhrFetch('/x', { method: 'POST', signal: stop.signal }, () => {})
    last().answer(200, '{}')
    await r
    stop.abort()
    expect(last().aborted).toBe(false)
  })

  test('an abort without a signal (the browser ending the request) is an AbortError too', async () => {
    const r = xhrFetch('/x', { method: 'POST' }, () => {})
    last().abort()
    expect(((await r.catch((x: unknown) => x)) as DOMException).name).toBe('AbortError')
  })

  test.each([
    ['open', (x: FakeXhr) => { x.open = () => { throw new DOMException('bad method', 'SyntaxError') } }],
    ['setRequestHeader', (x: FakeXhr) => { x.setRequestHeader = () => { throw new DOMException('bad header', 'SyntaxError') } }],
    ['send', (x: FakeXhr) => { x.send = () => { throw new DOMException('not open', 'InvalidStateError') } }],
  ] as const)('%s throwing rejects the call and lets go of the signal', async (_name, breakIt) => {
    FakeXhr.prepare = breakIt
    const stop = new AbortController()
    const e = await xhrFetch('/x', { method: 'POST', headers: { 'x-a': '1' }, signal: stop.signal }, () => {}).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(DOMException)
    stop.abort()
    expect(last().aborted).toBe(false)
  })
})

describe('the web app\'s client', () => {
  const chatId = uuidv7()
  const send = (onUploadProgress?: (share: number) => void) => api.call(API.uploadAttachment, { body: { fields: { chatId, name: 'a.pdf' }, file: new File(['x'], 'a.pdf'), filename: 'a.pdf' }, onUploadProgress })

  test('a watched upload carries the same headers as any call, and its answer is parsed by the contract', async () => {
    const shares: number[] = []
    const r = send((s) => shares.push(s))
    await Promise.resolve()
    const x = last()
    expect(x.url).toBe('/api/uploads')
    expect(x.headers['x-mycel-csrf']).toBe('1')
    expect(x.headers['x-mycel-window']).toBe(windowId())
    expect(x.headers['x-mycel-locale']).toBeTruthy()
    expect(x.withCredentials).toBe(false)
    expect(Object.keys(x.headers).map((k) => k.toLowerCase())).not.toContain('content-type')
    expect(x.body).toBeInstanceOf(FormData)
    x.upload.onprogress!({ lengthComputable: true, loaded: 1, total: 2 })
    expect(shares).toEqual([0.5])
    const attachment = { id: uuidv7(), name: 'a.pdf', path: 'users/u/.attachments/c/a.pdf', size: 1, mime: 'application/pdf', kind: 'pdf' }
    x.answer(201, JSON.stringify(attachment))
    expect((await r).name).toBe('a.pdf')
  })

  test('a refusal is an ApiError, and a relay\'s HTML page too', async () => {
    const refused = send(() => {})
    await Promise.resolve()
    last().answer(413, JSON.stringify({ error: { code: 'payload_too_large', message: 'too large' } }))
    const e = await refused.catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ApiError)
    expect((e as ApiError).code).toBe('payload_too_large')

    const relay = send(() => {})
    await Promise.resolve()
    last().answer(504, '<html>timeout</html>', 'text/html')
    const page = await relay.catch((x: unknown) => x)
    expect(page).toBeInstanceOf(ApiError)
    expect((page as ApiError).status).toBe(504)
  })
})
