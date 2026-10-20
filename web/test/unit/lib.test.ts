import { describe, expect, test } from 'bun:test'
import { uuidv7, type BrowserCall, type ClientFrame, type Job } from '@mycel/shared/api'
import { BrowserRelay, NO_PANE_ERROR, toBrowserResult } from '../../src/lib/browserRelay'
import type { DesktopApi } from '../../src/lib/desktop'
import { dateBucket, formatRelative, formatSize } from '../../src/lib/format'
import { baseName, crumbs, isConflictCopy, isInside, joinPath, nameProblem, parentPath } from '../../src/lib/paths'
import { iconKind, previewKind, previewLimit, PREVIEW_TEXT_MAX } from '../../src/lib/preview'
import { PreviewTooLargeError, readBounded } from '../../src/lib/api'
import { safeHref } from '../../src/lib/safeLinks'
import { useJobs, waitForJob } from '../../src/store/jobs'

describe('paths', () => {
  test('join / parent / base / crumbs', () => {
    expect(joinPath('', 'a')).toBe('a')
    expect(joinPath('a/b', 'c')).toBe('a/b/c')
    expect(parentPath('a/b/c')).toBe('a/b')
    expect(parentPath('a')).toBe('')
    expect(baseName('a/b/c.txt')).toBe('c.txt')
    expect(crumbs('a/b')).toEqual([{ name: 'a', path: 'a' }, { name: 'b', path: 'a/b' }])
    expect(isInside('a/b', 'a')).toBe(true)
    expect(isInside('ab', 'a')).toBe(false)
    expect(isInside('x', '')).toBe(true)
  })
  test('name rules mirror the server (tab 2)', () => {
    expect(nameProblem('  ')).toBe('empty')
    expect(nameProblem('a/b')).toBe('chars')
    expect(nameProblem('a:b')).toBe('chars')
    expect(nameProblem('end.')).toBe('dots')
    expect(nameProblem('..')).toBe('dots')
    expect(nameProblem('가'.repeat(90))).toBe('long')
    expect(nameProblem('보고서 2026.docx')).toBeNull()
  })
  test('conflict copies are recognized', () => {
    expect(isConflictCopy('plan (충돌 사본 - Bob 2026-10-21 10.00).md')).toBe(true)
    expect(isConflictCopy('plan.md')).toBe(false)
  })
})

describe('format and preview kinds', () => {
  test('sizes and buckets', () => {
    expect(formatSize(0, 'en')).toBe('0 B')
    expect(formatSize(1536, 'en')).toBe('1.5 KB')
    expect(formatSize(200 * 1024 * 1024, 'en')).toBe('200 MB')
    const now = new Date('2026-10-21T12:00:00')
    expect(dateBucket('2026-10-21T01:00:00', now)).toBe('today')
    expect(dateBucket('2026-10-20T23:00:00', now)).toBe('yesterday')
    expect(dateBucket('2026-10-16T12:00:00', now)).toBe('week')
    expect(dateBucket('2026-10-01T12:00:00', now)).toBe('month')
    expect(dateBucket('2025-01-01T12:00:00', now)).toBe('older')
    expect(formatRelative(new Date(Date.now() - 5 * 60_000).toISOString(), 'en')).toBe('5 minutes ago')
  })
  test('viewers by extension', () => {
    expect(previewKind('a.PDF')).toBe('pdf')
    expect(previewKind('a.xlsx')).toBe('sheet')
    expect(previewKind('a.svg')).toBe('svg')
    expect(previewKind('a.html')).toBe('html')
    expect(previewKind('a.exe')).toBeNull()
    expect(iconKind('x', true)).toBe('folder')
    expect(iconKind('a.pptx')).toBe('slides')
  })
})

describe('browser relay (browser.call → desktop pane → browser.result)', () => {
  const call = (callId: string): BrowserCall => ({ callId, turnId: uuidv7(), chatId: uuidv7(), tool: 'navigate', args: { url: 'https://example.com' }, deadline: Date.now() + 60_000 })
  test('a window without the pane answers at once with an explanation', () => {
    const sent: ClientFrame[] = []
    const relay = new BrowserRelay((f) => sent.push(f), () => undefined)
    relay.handleCall(call('c1'))
    relay.handleCall(call('c1')) // re-sent after a reconnect: ignored
    expect(sent).toEqual([{ type: 'browser.ack', callId: 'c1' }, { type: 'browser.result', result: { callId: 'c1', ok: false, content: [], error: NO_PANE_ERROR } }])
  })
  test('the desktop pane runs it once and the result goes back; cancel stops a running call', async () => {
    const sent: ClientFrame[] = []
    let resolve!: (r: { content: { type: 'text'; text: string }[]; isError: boolean }) => void
    const cancelled: string[] = []
    const app = { browser: { call: () => new Promise((r) => (resolve = r)), cancel: (id: string) => cancelled.push(id), endTurn: () => {} } } as unknown as DesktopApi
    const relay = new BrowserRelay((f) => sent.push(f), () => app)
    relay.handleCall(call('c2'))
    resolve({ content: [{ type: 'text', text: 'opened' }], isError: false })
    await new Promise((r) => setTimeout(r, 0))
    expect(sent.at(-1)).toEqual({ type: 'browser.result', result: { callId: 'c2', ok: true, content: [{ type: 'text', text: 'opened' }], error: undefined } })
    relay.handleCall(call('c3'))
    relay.cancel('c3')
    expect(cancelled).toEqual(['c3'])
    resolve({ content: [], isError: false })
    await new Promise((r) => setTimeout(r, 0))
    expect(sent.filter((f) => f.type === 'browser.result')).toHaveLength(1)
  })
  test('results keep only allowed image types and the error text', () => {
    const r = toBrowserResult('c', { isError: true, content: [{ type: 'text', text: 'no such element' }, { type: 'image', mimeType: 'image/gif', data: 'x' }, { type: 'image', mimeType: 'image/png', data: 'AAAA', shareToChat: true }] })
    expect(r).toEqual({ callId: 'c', ok: false, error: 'no such element', content: [{ type: 'text', text: 'no such element' }, { type: 'image', mime: 'image/png', data: 'AAAA', shareToChat: true }] })
  })
})

describe('jobs', () => {
  const job = (id: string, status: Job['status']): Job => ({ id, kind: 'transcribe', status, progress: status === 'done' ? 1 : null, message: null, result: status === 'done' ? { text: 'hi', language: 'ko', durationSec: 1 } : null, error: null, createdAt: new Date().toISOString(), finishedAt: null })
  test('resolves on job.done', async () => {
    const id = uuidv7()
    const p = waitForJob(id, { pollMs: 10_000, fetchJob: async () => job(id, 'running') })
    useJobs.getState().progress(id, 'transcribe', 0.5, 'half')
    expect(useJobs.getState().jobs[id]!.progress).toBe(0.5)
    useJobs.getState().done(job(id, 'done'))
    expect((await p).status).toBe('done')
  })
  test('falls back to polling when the event never comes', async () => {
    const id = uuidv7()
    let n = 0
    const j = await waitForJob(id, { pollMs: 5, fetchJob: async () => job(id, ++n >= 3 ? 'done' : 'running') })
    expect(j.status).toBe('done')
    expect(n).toBe(3)
  })
  test('abort rejects', async () => {
    const ctrl = new AbortController()
    const p = waitForJob(uuidv7(), { pollMs: 10_000, signal: ctrl.signal, fetchJob: async () => job('x', 'running') })
    ctrl.abort()
    await expect(p).rejects.toThrow()
  })
})

describe('previews read a bounded amount', () => {
  const stream = (n: number, chunk = 1000) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < n; i += chunk) c.enqueue(new Uint8Array(Math.min(chunk, n - i)).fill(65))
        c.close()
      },
    })
  test('Content-Length above the limit is refused without reading', async () => {
    const res = new Response(stream(10), { headers: { 'content-length': '5000000' } })
    await expect(readBounded(res, 1000)).rejects.toBeInstanceOf(PreviewTooLargeError)
  })
  test('no Content-Length (chunked): reading stops at the limit', async () => {
    await expect(readBounded(new Response(stream(50_000)), 10_000)).rejects.toBeInstanceOf(PreviewTooLargeError)
    expect((await readBounded(new Response(stream(9_000)), 10_000)).size).toBe(9_000)
  })
  test('text previews keep the beginning: max + 1 bytes so the "cut" note shows', async () => {
    const b = await readBounded(new Response(stream(50_000, 4096), { headers: { 'content-type': 'text/plain' } }), 10_000, { truncate: true })
    expect(b.size).toBe(10_001)
    expect(b.type).toContain('text/plain')
    const big = await readBounded(new Response(stream(20_000), { headers: { 'content-length': '20000' } }), 10_000, { truncate: true })
    expect(big.size).toBe(10_001)
  })
  test('limits per kind (tab 5)', () => {
    expect(previewLimit('pdf')).toEqual({ max: 50 * 1024 * 1024, truncate: false })
    expect(previewLimit('image')).toEqual({ max: 20 * 1024 * 1024, truncate: false })
    expect(previewLimit('html')).toEqual({ max: PREVIEW_TEXT_MAX, truncate: true })
  })
})

describe('links inside drawn documents', () => {
  test('only absolute http(s) addresses survive', () => {
    expect(safeHref('https://example.com/a?b#c')).toBe('https://example.com/a?b#c')
    expect(safeHref(' HTTP://Example.com ')).toBe('http://example.com/')
    for (const bad of ['javascript:alert(1)', ' javascript:alert(1)', 'JaVaScRiPt:x', 'data:text/html,x', 'file:///etc/passwd', '/admin', '//evil.example/x', 'vbscript:x', 'http:/x', null, undefined, ''])
      expect(safeHref(bad as string)).toBeNull()
  })
})

describe('browser relay limits', () => {
  test('an oversized screenshot or a malformed pane answer still gets a browser.result', async () => {
    const sent: ClientFrame[] = []
    const call = (callId: string): BrowserCall => ({ callId, chatId: uuidv7(), tool: 'browser_screenshot' as BrowserCall['tool'], args: {}, deadline: Date.now() + 60_000 })
    const huge = 'A'.repeat(20_000_001)
    let answer: unknown = { content: [{ type: 'image', data: huge, mimeType: 'image/png' }], isError: false }
    const app = { browser: { call: async () => answer, cancel() {}, endTurn() {} } } as unknown as DesktopApi
    const { ClientFrame: CF } = await import('@mycel/shared/api')
    const relay = new BrowserRelay((f) => sent.push(CF.parse(f)), () => app)
    relay.handleCall(call('big'))
    await new Promise((r) => setTimeout(r, 0))
    const big = sent.find((f) => f.type === 'browser.result' && f.result.callId === 'big')
    expect(big && big.type === 'browser.result' && big.result.content[0]).toEqual({ type: 'text', text: 'The screenshot was too large to send back.' })
    answer = { content: [{ type: 'text', text: 1 }], isError: false }
    relay.handleCall(call('bad'))
    await new Promise((r) => setTimeout(r, 0))
    const bad = sent.find((f) => f.type === 'browser.result' && f.result.callId === 'bad')
    expect(bad && bad.type === 'browser.result' && bad.result.ok).toBe(false)
  })
})
