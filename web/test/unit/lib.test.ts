import { describe, expect, test } from 'bun:test'
import { ApiError, ERROR_MESSAGES, uuidv7, type BrowserCall, type ClientFrame, type Job } from '@mycel/shared/api'
import type { DesktopBridge } from '@mycel/shared'
import { BrowserRelay, NO_PANE_ERROR } from '../../src/lib/browserRelay'
import { dateBucket, formatDateTime, formatRelative, formatSize, localDay } from '../../src/lib/format'
import { baseName, crumbs, isConflictCopy, isInside, joinPath, nameProblem, parentPath } from '../../src/lib/paths'
import { iconKind, previewKind, previewLimit, PREVIEW_TEXT_MAX } from '../../src/lib/preview'
import { errorText, PreviewTooLargeError, readBounded } from '../../src/lib/api'
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
  test('schedule dates use the team zone across midnight and DST in every locale', () => {
    const iso = '2026-10-28T15:09:00Z'
    // Assert the expected wall-clock date, leaving locale punctuation to the platform's ICU.
    const wall = (iso: string, locale = 'en-US') => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(iso))
    for (const [locale, tag] of [['en', 'en-US'], ['ko', 'ko-KR'], ['id', 'id-ID']] as const)
      expect(formatDateTime(iso, locale, 'Asia/Seoul')).toBe(wall('2026-10-29T00:09:00Z', tag))
    expect(formatDateTime(iso, 'en', 'Asia/Jakarta')).toBe(wall('2026-10-28T22:09:00Z'))
    expect(formatDateTime(iso, 'en', 'UTC')).toBe(wall('2026-10-28T15:09:00Z'))
    expect(formatDateTime('2026-03-08T06:59:00Z', 'en', 'America/New_York')).toBe(wall('2026-03-08T01:59:00Z'))
    expect(formatDateTime('2026-03-08T07:00:00Z', 'en', 'America/New_York')).toBe(wall('2026-03-08T03:00:00Z'))
    expect(formatDateTime('2026-11-01T06:00:00Z', 'en', 'America/New_York')).toBe(wall('2026-11-01T01:00:00Z'))
    expect(formatDateTime(null, 'en', 'Asia/Seoul')).toBe('')
    expect(formatDateTime(iso, 'en')).toBe(new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)))
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
  const bridge = (run: (c: BrowserCall) => Promise<unknown>, cancelled: string[] = []) =>
    ({ bridgeVersion: 1, appVersion: '0.1.0', platform: 'darwin', browser: { run, cancel: (id: string) => cancelled.push(id) } }) as unknown as DesktopBridge
  const tick = () => new Promise((r) => setTimeout(r, 0))

  test('a window without the pane answers at once with an explanation, again when the call is replayed', () => {
    const sent: ClientFrame[] = []
    const relay = new BrowserRelay((f) => sent.push(f), () => null)
    relay.handleCall(call('c1'))
    relay.handleCall(call('c1')) // re-sent after a reconnect: the server still needs the result
    const one: ClientFrame[] = [{ type: 'browser.ack', callId: 'c1' }, { type: 'browser.result', result: { callId: 'c1', ok: false, content: [], error: NO_PANE_ERROR } }]
    expect(sent).toEqual([...one, ...one])
  })

  test('the desktop app runs a call once; a replay gets the ack while running and the kept result after', async () => {
    const sent: ClientFrame[] = []
    let resolve!: (r: unknown) => void
    let runs = 0
    const app = bridge(() => { runs++; return new Promise((r) => (resolve = r)) })
    const relay = new BrowserRelay((f) => sent.push(f), () => app)
    relay.handleCall(call('c2'))
    relay.handleCall(call('c2'))
    expect(sent).toEqual([{ type: 'browser.ack', callId: 'c2' }, { type: 'browser.ack', callId: 'c2' }])
    resolve({ callId: 'c2', ok: true, content: [{ type: 'text', text: 'opened' }] })
    await tick()
    const result: ClientFrame = { type: 'browser.result', result: { callId: 'c2', ok: true, content: [{ type: 'text', text: 'opened' }] } }
    expect(sent.at(-1)).toEqual(result)
    relay.handleCall(call('c2'))
    expect(sent.at(-1)).toEqual(result)
    expect(runs).toBe(1)
  })

  test('cancel reaches the desktop app', () => {
    const cancelled: string[] = []
    const app = bridge(() => new Promise(() => {}), cancelled)
    const relay = new BrowserRelay(() => {}, () => app)
    relay.handleCall(call('c3'))
    relay.cancel('c3')
    expect(cancelled).toEqual(['c3'])
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

describe('desktop app detection', () => {
  test('sign-in says desktop inside the desktop app (browser tools are offered only there), web elsewhere', async () => {
    const { clientKind } = await import('../../src/lib/desktop')
    expect(clientKind()).toBe('web')
    ;(globalThis as Record<string, unknown>).mycelDesktop = { bridgeVersion: 1 }
    try { expect(clientKind()).toBe('desktop') } finally { delete (globalThis as Record<string, unknown>).mycelDesktop }
  })
})

describe('browser relay limits', () => {
  test('a malformed or failing desktop answer still gets a browser.result the contract accepts', async () => {
    const sent: ClientFrame[] = []
    const call = (callId: string): BrowserCall => ({ callId, turnId: uuidv7(), chatId: uuidv7(), tool: 'computer', args: {}, deadline: Date.now() + 60_000 })
    let answer: () => Promise<unknown> = async () => ({ callId: 'bad', ok: true, content: [{ type: 'text', text: 1 }] })
    const app = { bridgeVersion: 1, browser: { run: () => answer(), cancel() {} } } as unknown as DesktopBridge
    const { ClientFrame: CF } = await import('@mycel/shared/api')
    const relay = new BrowserRelay((f) => sent.push(CF.parse(f)), () => app)
    relay.handleCall(call('bad'))
    await new Promise((r) => setTimeout(r, 0))
    const bad = sent.find((f) => f.type === 'browser.result' && f.result.callId === 'bad')
    expect(bad && bad.type === 'browser.result' && bad.result.ok).toBe(false)
    answer = async () => { throw new Error('pane crashed') }
    relay.handleCall(call('boom'))
    await new Promise((r) => setTimeout(r, 0))
    const boom = sent.find((f) => f.type === 'browser.result' && f.result.callId === 'boom')
    expect(boom && boom.type === 'browser.result' && boom.result.error).toContain('pane crashed')
  })
})

describe('local data per person', () => {
  class Mem {
    m = new Map<string, string>()
    get length() { return this.m.size }
    key(i: number) { return [...this.m.keys()][i] ?? null }
    getItem(k: string) { return this.m.get(k) ?? null }
    setItem(k: string, v: string) { this.m.set(k, v) }
    removeItem(k: string) { this.m.delete(k) }
  }
  test('drafts are kept per person; signing out forgets drafts and remembered uploads only', async () => {
    const { clearLocalData, readDraft, writeDraft, UPLOADS_KEY } = await import('../../src/lib/localData')
    const s = new Mem()
    writeDraft('olga', 'new', 'secret plan', s)
    expect(readDraft('olga', 'new', s)).toBe('secret plan')
    expect(readDraft('budi', 'new', s)).toBe('')
    s.setItem(UPLOADS_KEY, '{}')
    s.setItem('mycel.theme', 'dark')
    clearLocalData(s)
    expect([...s.m.keys()]).toEqual(['mycel.theme'])
  })
})

describe('errorText', () => {
  const validation = (message: string, fields: Record<string, string>) => new ApiError(400, { code: 'validation', message, fields } as never)
  test('a specific server message is shown as is; the English field detail is not appended', () => {
    expect(errorText(validation('더 안전한 비밀번호를 정해 주세요. 아이디가 들어간 비밀번호는 쓸 수 없습니다.', { 'body.password': 'must not contain the username' }), 'ko', 'net')).toBe('더 안전한 비밀번호를 정해 주세요. 아이디가 들어간 비밀번호는 쓸 수 없습니다.')
  })
  test('the default validation message follows the UI language and names the field problem', () => {
    const e = validation(ERROR_MESSAGES.validation!.en, { 'body.name': 'too long' })
    expect(errorText(e, 'ko', 'net')).toBe(`${ERROR_MESSAGES.validation!.ko} (too long)`)
  })
})

describe('localDay', () => {
  test('the local calendar day, also when the UTC day differs', () => {
    const d = new Date(2026, 9, 21, 0, 30) // 00:30 local on 21 October
    expect(localDay(d)).toBe('2026-10-21')
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
  })
})
