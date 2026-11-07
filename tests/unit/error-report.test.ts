// Error reports to Sentry (system/error-report.ts): off without a key, refused on a hosted server, and only the named
// fields reach Sentry. The canary below is the point of this file: what a person typed or owns must not leave.
import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { Hono } from 'hono'
import { routePath } from 'hono/route'
import type { AppConfig } from '../../server/src/app-config'
import { createLogger, silentLogger } from '../../server/src/log'
import { _resetClientReportsForTest, buildEvent, clientReportAllowed, errorReportsFrom, ErrorReporter, logLineInput, parseDsn, parseStack, pauseSeconds, reportCrashes, scrubText, type ErrorInput } from '../../server/src/system/error-report'

const DSN = 'https://abc123@o1.ingest.us.sentry.io/42'
const cfg = (o: Partial<AppConfig> = {}) => ({ mode: 'prod', ...o }) as AppConfig
const target = parseDsn(DSN)!

function fakeSentry(init: ResponseInit = { status: 200 }) {
  const bodies: string[] = []
  const send = (async (_url: string, req: RequestInit) => { bodies.push(req.body as string); return new Response('{}', init) }) as unknown as typeof fetch
  return { bodies, send, events: () => bodies.map((b) => JSON.parse(b.split('\n')[2]!) as Record<string, any>) }
}
const reporter = (send: typeof fetch, now?: () => number, logger: 'server' | 'web' = 'server') => new ErrorReporter(target, { release: 'mycel@1.0.0', environment: 'dev', logger, fetch: send, now })
const event = (i: ErrorInput, browser = false) => buildEvent(i, { release: 'r', environment: 'e', logger: browser ? 'web' : 'server', browser, now: 1_000 })

describe('the key and the switch', () => {
  test('a Sentry key gives the envelope address and the public key', () => {
    expect(parseDsn(DSN)).toEqual({ url: 'https://o1.ingest.us.sentry.io/api/42/envelope/', key: 'abc123' })
    expect(parseDsn('https://k@sentry.example.com/sentry/7')).toEqual({ url: 'https://sentry.example.com/sentry/api/7/envelope/', key: 'k' })
  })

  test('anything else is not a key', () => {
    for (const bad of ['', 'nonsense', 'http://k@host/1', 'https://host/1', 'https://k@host/abc']) expect(parseDsn(bad)).toBeNull()
  })

  test('without a key nothing is built', () => {
    expect(errorReportsFrom({}, cfg(), '1')).toMatchObject({ server: null, web: null, refused: false, invalid: [] })
    expect(errorReportsFrom({ MYCEL_SENTRY_DSN: '  ' }, cfg(), '1').server).toBeNull()
  })

  test('each key turns on its own reporter', () => {
    expect(errorReportsFrom({ MYCEL_SENTRY_DSN: DSN }, cfg(), '1')).toMatchObject({ web: null })
    expect(errorReportsFrom({ MYCEL_SENTRY_DSN: DSN }, cfg(), '1').server).toBeInstanceOf(ErrorReporter)
    expect(errorReportsFrom({ MYCEL_SENTRY_WEB_DSN: DSN }, cfg(), '1').web).toBeInstanceOf(ErrorReporter)
  })

  test('a hosted server refuses a key: the terms name who receives customer content', () => {
    const r = errorReportsFrom({ MYCEL_SENTRY_DSN: DSN, MYCEL_SENTRY_WEB_DSN: DSN }, cfg({ deployment: 'hosted' }), '1')
    expect(r).toMatchObject({ server: null, web: null, refused: true })
  })

  test('a wrong key is named and turns nothing on', () => {
    expect(errorReportsFrom({ MYCEL_SENTRY_DSN: 'oops' }, cfg(), '1')).toMatchObject({ server: null, invalid: ['MYCEL_SENTRY_DSN'] })
  })
})

describe('scrubbing a message', () => {
  const cases: [string, string][] = [
    ["ENOENT: no such file or directory, open '/team/finance/salaries.xlsx'", 'ENOENT: no such file or directory, open [text]'],
    ['cannot read /Users/minjun/Documents/plan.md', 'cannot read [path]'],
    ['cannot open C:\\Users\\minjun\\plan.md', 'cannot open [path]'],
    ['failed to parse budget-2026.xlsx today', 'failed to parse [name] today'],
    ['cannot open server.key or notes.rtf', 'cannot open [name] or [name]'],
    ['Q3 Sales Report.numbers is locked', 'Q3 Sales [name] is locked'],
    ['mail to minjun.kim@acme.co.kr bounced', 'mail to [email] bounced'],
    ['fetch https://acme.trina.app/api?token=abc failed', 'fetch [url] failed'],
    ['getaddrinfo ENOTFOUND acme.trina.app', 'getaddrinfo ENOTFOUND [name]'],
    ['connect to alice-macbook.local and db.internal and acme.de and API.ACME.COM', 'connect to [name] and [name] and [name] and [name]'],
    ['host Potenlab.trina.app is down', 'host [name] is down'],
    ['connect ECONNREFUSED fe80::1ff:fe23:4567:890a', 'connect ECONNREFUSED [ip]'],
    ['refused access_token=abc123def456 and client_secret=s3 and refresh_token: r1', 'refused access_token=[redacted] and client_secret=[redacted] and refresh_token=[redacted]'],
    ['login passwd=x1 pwd=y2', 'login passwd=[redacted] pwd=[redacted]'],
    ['header Authorization: Bearer abc123def', 'header Authorization=[redacted]'],
    ['connect ECONNREFUSED 10.1.2.3', 'connect ECONNREFUSED [ip]'],
    ['bad header Bearer abcdefghijklmnop', 'bad header Bearer [redacted]'],
    ['login failed password=hunter2', 'login failed password=[redacted]'],
    ['session s3cr3tT0k3nValue1234567890 expired', 'session [id] expired'],
    ['call +82 10-1234-5678 now', 'call [number] now'],
    ['user 홍길동 not found', 'user [text] not found'],
    ["can't open 'the board notes'", "can't open [text]"],
    ['unterminated "secret plan', 'unterminated [text]'],
  ]
  for (const [input, want] of cases) test(input, () => { expect(scrubText(input)).toBe(want) })

  test('only the first line: what follows is usually tool output', () => {
    expect(scrubText('typst failed\nerror: secret line of the document')).toBe('typst failed')
  })

  test('a long message is cut, and a huge one stays fast', () => {
    expect(scrubText('x '.repeat(1000)).length).toBeLessThanOrEqual(300)
    const start = performance.now()
    scrubText('a.'.repeat(500_000))
    scrubText('a'.repeat(1_000_000))
    expect(performance.now() - start).toBeLessThan(500)
  })
})

describe('stack frames', () => {
  test('a server frame keeps the code file and drops the folder it is installed in', () => {
    const stack = 'Error: boom\n    at save (/Users/minjun/app/server/main.js:10:5)\n    at async run (/srv/mycel/app/node_modules/hono/compose.js:3:1)\n    at native:1:1'
    expect(parseStack(stack, 'boom', false)).toEqual([
      { filename: 'native', function: '?', lineno: 1, colno: 1, in_app: false },
      { filename: 'hono/compose.js', function: 'run', lineno: 3, colno: 1, in_app: false },
      { filename: 'server/main.js', function: 'save', lineno: 10, colno: 5, in_app: true },
    ])
  })

  test('a browser frame keeps a build file name only, and an extension is never ours', () => {
    const files = parseStack([
      '    at a (https://acme.trina.app/assets/ 김민준 alice@example.com hunter2:1:1)',
      '    at b (chrome-extension://abc/assets/inject.js:1:1)',
      '    at c (https://acme.trina.app/assets/index-abc.js:1:1)',
    ].join('\n'), '', true)
    expect(files.map((f) => [f.filename, f.in_app])).toEqual([['assets/index-abc.js', true], ['[external]', false], ['[external]', false]])
  })

  test('a function name with spaces or other characters is not sent', () => {
    expect(parseStack('    at alice@example.com hunter2 (/a/b.js:1:1)', '', false)[0]!.function).toBe('?')
  })

  test('a very long line is not read as a frame, and stays fast', () => {
    const start = performance.now()
    expect(parseStack(`    at ${'f'.repeat(1_000_000)} (/a/b.js:1:1)`, '', false)).toEqual([])
    expect(performance.now() - start).toBeLessThan(200)
  })

  test('a frame in a file that is not code hides the name', () => {
    expect(parseStack('Error: x\n    at f (/team/board/salaries.xlsx:1:1)', 'x', false)[0]!.filename).toBe('[file]')
  })

  test('lines of a message that look like frames are not frames', () => {
    const message = 'engine failed\n    at leak (/secret/plan.ts:1:1)'
    expect(parseStack(`Error: ${message}\n    at real (/app/server/main.js:2:2)`, message, false).map((f) => f.function)).toEqual(['real'])
  })

  test('a browser frame loses the team address and the query', () => {
    expect(parseStack('TypeError: x\n    at render (https://acme.trina.app/assets/index-abc.js?v=1:1:200)', 'x', true)[0]).toEqual({ filename: 'assets/index-abc.js', function: 'render', lineno: 1, colno: 200, in_app: true })
  })

  test("Firefox's and Safari's format is read, and other sites' code stays nameless", () => {
    expect(parseStack('render@https://acme.trina.app/assets/index-abc.js:1:200\nx@https://other.example/secret.js:1:1', '', true).map((f) => f.filename)).toEqual(['[external]', 'assets/index-abc.js'])
  })

  test('a long stack is capped', () => {
    expect(parseStack(Array.from({ length: 200 }, (_, i) => `    at f${i} (/a/b.js:1:1)`).join('\n'), '', false)).toHaveLength(40)
  })
})

describe('the canary: what may not leave', () => {
  const secrets = ['minjun.kim@acme.co.kr', '/team/finance/salaries.xlsx', 'salaries.xlsx', 'acme.trina.app', 'hunter2', 'SECRET_PROMPT_TEXT', 'ENGINE_STDERR_TAIL', '홍길동', '/api/files/board-plan', '10.1.2.3', 'minjun-macbook']

  test('a log line: only the error, the method and the route are read', () => {
    const err = new Error(`save failed for minjun.kim@acme.co.kr in '/team/finance/salaries.xlsx' at acme.trina.app password=hunter2 by 홍길동 from 10.1.2.3`)
    err.stack = `Error: ${err.message}\n    at save (/Users/minjun-macbook/team/server/main.js:1:1)`
    const input = logLineInput('unhandled error', {
      err, method: 'POST', route: '/api/files/:id', path: '/api/files/board-plan', prompt: 'SECRET_PROMPT_TEXT', stderr: 'ENGINE_STDERR_TAIL',
      host: 'minjun-macbook', email: 'minjun.kim@acme.co.kr', body: { text: 'SECRET_PROMPT_TEXT' },
    })
    const json = JSON.stringify(event(input))
    for (const s of secrets) expect(json).not.toContain(s)
    expect(json).toContain('/api/files/:id')
    expect(json).toContain('server/main.js')
  })

  test('only the named fields exist', () => {
    const e = event({ type: 'TypeError', message: 'x', stack: 'TypeError: x\n    at f (/a/b.js:1:1)', method: 'GET', route: '/api/x', page: '/files', logLine: 'y' })
    expect(Object.keys(e).sort()).toEqual(['environment', 'event_id', 'exception', 'level', 'logger', 'platform', 'release', 'sdk', 'tags', 'timestamp'])
    expect(Object.keys(e.tags as object).sort()).toEqual(['log_line', 'method', 'page', 'route'])
    expect(Object.keys((e.exception as { values: object[] }).values[0]!).sort()).toEqual(['mechanism', 'stacktrace', 'type', 'value'])
  })

  test('values in a wrong shape are dropped, not sent', () => {
    const e = event({ type: 'potenlab.trina.app', message: 'x', method: 'minjun', route: '/api/files/board plan.xlsx', page: '/files/board-plan' })
    expect(e.tags).toEqual({})
    expect((e.exception as { values: { type: string }[] }).values[0]!.type).toBe('Error')
  })

  test('a line without an error object sends only its own text', () => {
    const json = JSON.stringify(event(logLineInput('response does not match the contract', { endpoint: 'POST /api/x', issues: ['SECRET_PROMPT_TEXT'] })))
    expect(json).toContain('response does not match the contract')
    expect(json).not.toContain('SECRET_PROMPT_TEXT')
  })
})

describe('sending', () => {
  test('one envelope, with the public key in the header and no key in the body', async () => {
    let url = '', headers: Record<string, string> = {}, body = ''
    const send = (async (u: string, r: RequestInit) => { url = u; headers = r.headers as Record<string, string>; body = r.body as string; return new Response('{}') }) as unknown as typeof fetch
    const r = reporter(send)
    r.capture({ type: 'Error', message: 'boom' })
    await r.flush(100)
    expect(url).toBe('https://o1.ingest.us.sentry.io/api/42/envelope/')
    expect(headers['x-sentry-auth']).toContain('sentry_key=abc123')
    expect(body).not.toContain('abc123')
    expect(body.split('\n')).toHaveLength(4)
    expect(body.split('\n')[1]).toBe('{"type":"event"}')
  })

  test('the same error in a minute is sent once, and again after it', async () => {
    let t = 1_000_000
    const s = fakeSentry(), r = reporter(s.send, () => t)
    r.capture({ message: 'boom' }); r.capture({ message: 'boom' })
    t += 61_000
    r.capture({ message: 'boom' })
    await r.flush(100)
    expect(s.bodies).toHaveLength(2)
  })

  test('a storm cannot pass twice the limit across the edge of a minute', async () => {
    let t = 1_000_000
    const s = fakeSentry(), r = reporter(s.send, () => t)
    for (let i = 0; i < 30; i++) r.capture({ message: `early ${i}` })
    t += 59_500
    for (let i = 0; i < 30; i++) r.capture({ message: `late ${i}` })
    await r.flush(100)
    expect(s.bodies).toHaveLength(30)
  })

  test('a crash is sent even when the minute is full', async () => {
    const t = 1_000_000
    const s = fakeSentry(), r = reporter(s.send, () => t)
    for (let i = 0; i < 40; i++) r.capture({ message: `e${i}` })
    r.capture({ type: 'TypeError', message: 'the crash', fatal: true })
    await r.flush(100)
    expect(s.events().at(-1)).toMatchObject({ level: 'fatal' })
  })

  test('a clock set back does not stop reports for the length of the jump', async () => {
    let t = 10_000_000
    const s = fakeSentry(), r = reporter(s.send, () => t)
    for (let i = 0; i < 30; i++) r.capture({ message: `e${i}` })
    t -= 3_600_000
    r.capture({ message: 'after the clock moved' })
    await r.flush(100)
    expect(s.bodies).toHaveLength(31)
  })

  test('errors that differ only in an id in the message are one error, by type, message start and frames', async () => {
    const s = fakeSentry(), r = reporter(s.send, () => 1_000_000)
    const stack = (id: string) => `Error: lookup failed ${'x'.repeat(100)} ${id}\n    at find (/app/server/main.js:1:1)`
    r.capture({ type: 'Error', message: `lookup failed ${'x'.repeat(100)} 1`, stack: stack('1') })
    r.capture({ type: 'Error', message: `lookup failed ${'x'.repeat(100)} 2`, stack: stack('2') })
    await r.flush(100)
    expect(s.bodies).toHaveLength(1)
  })

  test('a storm stops at the minute limit', async () => {
    let t = 1_000_000
    const s = fakeSentry(), r = reporter(s.send, () => t)
    for (let i = 0; i < 100; i++) r.capture({ message: `boom ${i}` })
    await r.flush(100)
    expect(s.bodies).toHaveLength(30)
    t += 61_000
    r.capture({ message: 'later' })
    await r.flush(100)
    expect(s.bodies).toHaveLength(31)
  })

  for (const [name, init] of [['a 429', { status: 429, headers: { 'retry-after': '120' } }], ['a rate limit header', { status: 200, headers: { 'x-sentry-rate-limits': '120:error:organization' } }]] as const) {
    test(`${name} pauses sending for as long as Sentry says`, async () => {
      let t = 1_000_000
      const s = fakeSentry(init), r = reporter(s.send, () => t)
      r.capture({ message: 'first' })
      await r.flush(100)
      t += 60_000
      r.capture({ message: 'second' })
      await r.flush(100)
      expect(s.bodies).toHaveLength(1)
      t += 61_000
      r.capture({ message: 'third' })
      await r.flush(100)
      expect(s.bodies).toHaveLength(2)
    })
  }

  test('a failed send and a broken input do not throw', async () => {
    const r = reporter((async () => { throw new Error('no network') }) as unknown as typeof fetch)
    expect(() => r.capture({ message: 'boom' })).not.toThrow()
    await r.flush(100)
    expect(() => r.capture(null as unknown as ErrorInput)).not.toThrow()
  })

  test('flush gives up at its time limit', async () => {
    const r = reporter((() => new Promise(() => {})) as unknown as typeof fetch)
    r.capture({ message: 'boom' })
    const start = performance.now()
    await r.flush(30)
    expect(performance.now() - start).toBeLessThan(500)
  })
})

describe('the logger', () => {
  const lines = (report?: (m: string, f?: Record<string, unknown>) => void) => createLogger({ level: 'debug', sink: () => {}, ...(report ? { report } : {}) })

  test('only error lines are reported, with the fields as given, also from a child', () => {
    const seen: string[] = []
    const err = new Error('x')
    let given: unknown
    const log = lines((m, f) => { seen.push(m); given = f?.err })
    log.info('i'); log.warn('w'); log.error('e', { err })
    log.child({ module: 'm' }).error('c')
    expect(seen).toEqual(['e', 'c'])
    expect(given).toBeUndefined()
    log.error('again', { err })
    expect(given).toBe(err)
  })

  test('a logger without the hook is as before', () => {
    expect(() => lines().error('e')).not.toThrow()
  })
})

describe('the route pattern', () => {
  test('onError knows the pattern of the route that failed, not the address', async () => {
    const app = new Hono()
    let seen = ''
    app.use('*', async (_c, next) => { await next() })
    app.get('/api/files/:id', () => { throw new Error('boom') })
    app.onError((_e, c) => { seen = routePath(c); return c.text('x', 500) })
    await app.request('/api/files/board-plan')
    expect(seen).toBe('/api/files/:id')
  })
})

describe('a crash', () => {
  function crash() {
    const proc = Object.assign(new EventEmitter(), { code: null as number | null, exit(c: number) { this.code = c } })
    const s = fakeSentry()
    reportCrashes(reporter(s.send), silentLogger, proc as never)
    return { proc, s }
  }

  for (const kind of ['uncaughtException', 'unhandledRejection']) {
    test(`${kind} is sent as fatal, then the process ends with code 1`, async () => {
      const { proc, s } = crash()
      proc.emit(kind, new TypeError('boom'))
      await Bun.sleep(20)
      expect(proc.code).toBe(1)
      expect(s.events()[0]).toMatchObject({ level: 'fatal', exception: { values: [{ type: 'TypeError', value: 'boom', mechanism: { handled: false } }] } })
    })
  }

  test('a rejection with something other than an error is not sent as text', async () => {
    const { proc, s } = crash()
    proc.emit('unhandledRejection', 'SECRET_PROMPT_TEXT')
    await Bun.sleep(20)
    expect(s.bodies.join()).not.toContain('SECRET_PROMPT_TEXT')
    expect(proc.code).toBe(1)
  })

  test('a second crash while ending is ignored', async () => {
    const { proc, s } = crash()
    proc.emit('uncaughtException', new Error('one'))
    proc.emit('uncaughtException', new Error('two'))
    await Bun.sleep(20)
    expect(s.bodies).toHaveLength(1)
  })
})

describe("Sentry's rate limit answer", () => {
  test('only entries for errors, or for every category, count; the longest wins', () => {
    expect(pauseSeconds('60:transaction:key, 2700:error:organization', 200, null)).toBe(2700)
    expect(pauseSeconds('3600:transaction:key', 200, null)).toBeNull()
    expect(pauseSeconds('120::organization', 200, null)).toBe(120)
    expect(pauseSeconds('30:error;default:key', 200, null)).toBe(30)
  })
  test('a 429 without the header waits as Retry-After says, else a minute', () => {
    expect(pauseSeconds(null, 429, '90')).toBe(90)
    expect(pauseSeconds(null, 429, null)).toBe(60)
    expect(pauseSeconds(null, 200, '90')).toBeNull()
  })
  test('a limit on transactions only does not pause error reports', async () => {
    let t = 1_000_000
    const s = fakeSentry({ status: 200, headers: { 'x-sentry-rate-limits': '3600:transaction:key' } }), r = reporter(s.send, () => t)
    r.capture({ message: 'one' }); await r.flush(100)
    t += 1_000
    r.capture({ message: 'two' }); await r.flush(100)
    expect(s.bodies).toHaveLength(2)
  })
})

describe('browser reports per person', () => {
  test('ten in ten minutes for each person, then dropped; others are not affected', () => {
    _resetClientReportsForTest()
    const t = 5_000_000
    for (let i = 0; i < 10; i++) expect(clientReportAllowed('u1', t + i)).toBe(true)
    expect(clientReportAllowed('u1', t + 20)).toBe(false)
    expect(clientReportAllowed('u2', t + 20)).toBe(true)
    expect(clientReportAllowed('u1', t + 10 * 60_000 + 1)).toBe(true)
  })
})

describe('a crash while the log cannot be written', () => {
  test('the process still ends with code 1', async () => {
    const proc = Object.assign(new EventEmitter(), { code: null as number | null, exit(c: number) { this.code = c } })
    const s = fakeSentry()
    const broken = { ...silentLogger, error() { throw new Error('ENOSPC: no space left on device') } }
    reportCrashes(reporter(s.send), broken, proc as never)
    expect(() => proc.emit('unhandledRejection', new Error('boom'))).not.toThrow()
    await Bun.sleep(20)
    expect(proc.code).toBe(1)
    expect(s.bodies).toHaveLength(1)
  })
})
