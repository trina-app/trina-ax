// Error reports from the relay and the push gateway (shared/src/sentry-report.ts, relay/src/report.ts): off without a
// key, the scrubber, the exact field list, limits, the relay log hook, crashes. Fictional keys and a fake fetch only:
// nothing here reaches Sentry.
import { describe, expect, test } from 'bun:test'
import {
  ErrorReporter, buildEvent, checkInUrl, environmentName, parseDsn, parseStack, reportCrashes, reporterFromDsn, scrubText,
} from '../../shared/src/sentry-report.ts'
import { createRelayLog } from '../../relay/src/log.ts'
import { RELAY_VERSION } from '../../relay/src/relay.ts'
import { logLineInput, relayReportsFrom } from '../../relay/src/report.ts'

const DSN = 'https://0123abcd@o1.ingest.example.test/42'
const T0 = Date.UTC(2026, 10, 13)

function fakeFetch(status = 200, headers: Record<string, string> = {}) {
  const posts: { url: string; headers: Headers; body: string }[] = []
  const fetch = async (url: string, init: RequestInit) => {
    posts.push({ url, headers: new Headers(init.headers), body: String(init.body) })
    return new Response(null, { status, headers })
  }
  return { posts, fetch, events: () => posts.map((p) => JSON.parse(p.body.split('\n')[2]!) as Record<string, any>) }
}

describe('keys and check-in addresses', () => {
  test('parseDsn: https, a public key and a numeric project; a path prefix kept', () => {
    expect(parseDsn(DSN)).toEqual({ url: 'https://o1.ingest.example.test/api/42/envelope/', key: '0123abcd', base: 'https://o1.ingest.example.test', project: '42' })
    expect(parseDsn('https://k1@sentry.example.test/prefix/7')?.url).toBe('https://sentry.example.test/prefix/api/7/envelope/')
    for (const bad of [undefined, '', 'nope', 'http://k@o1.example.test/42', 'https://o1.example.test/42', 'https://k@o1.example.test/abc', 'https://k:secret@o1.example.test/42', 'https://k-y@o1.example.test/42']) expect(parseDsn(bad)).toBeNull()
  })

  test('checkInUrl: Sentry\'s HTTP check-in endpoint for a monitor slug', () => {
    expect(checkInUrl(DSN, 'relay-registry-backup')).toBe('https://o1.ingest.example.test/api/42/cron/relay-registry-backup/0123abcd/')
    expect(checkInUrl('https://k1@sentry.example.test:9000/prefix/7', 'relay-litestream')).toBe('https://sentry.example.test:9000/prefix/api/7/cron/relay-litestream/k1/')
    expect(checkInUrl(undefined, 'relay-litestream')).toBeNull()
    expect(checkInUrl(DSN, 'Bad Slug')).toBeNull()
    expect(checkInUrl(DSN, '../x')).toBeNull()
  })

  test('environment names: a short code, default production', () => {
    expect(environmentName(undefined)).toBe('production')
    expect(environmentName('')).toBe('production')
    expect(environmentName('staging')).toBe('staging')
    expect(environmentName('Prod Server!')).toBe('production')
  })
})

describe('no key: nothing is built, nothing is sent', () => {
  test('reporterFromDsn and relayReportsFrom without a key', () => {
    const f = fakeFetch()
    expect(reporterFromDsn(undefined, { release: 'x', environment: 'p', logger: 'relay', fetch: f.fetch })).toEqual({ reporter: null, invalid: false })
    expect(reporterFromDsn('   ', { release: 'x', environment: 'p', logger: 'relay', fetch: f.fetch })).toEqual({ reporter: null, invalid: false })
    expect(reporterFromDsn('not-a-key', { release: 'x', environment: 'p', logger: 'relay', fetch: f.fetch })).toEqual({ reporter: null, invalid: true })
    expect(relayReportsFrom({ RELAY_SENTRY_DSN: '' }, { fetch: f.fetch }).reporter).toBeNull()
    expect(relayReportsFrom({}, { fetch: f.fetch }).reporter).toBeNull()
    expect(f.posts).toEqual([])
  })

  test('the relay log without a hook writes the line and reports nothing', () => {
    const lines: string[] = []
    const log = createRelayLog((l) => lines.push(l))
    log.error('request_failed', { error: 'ECONNRESET' })
    expect(lines.length).toBe(1)
  })
})

describe('scrubbing', () => {
  const CANARIES = ['203.0.113.7', '2001:db8::1', '/var/lib/mycel-relay/registry.db', 'acme.treesoop.example', 'alice@example.test', 'fakekey_abcdefghijklmnopqrstuvwx', 's3cr3t-cookie', 'eyJhbGciOiJFUzI1NiJ9.payload.sig', '/t/acme/api/files?token=abc']
  test('addresses, paths, hosts, emails, secrets and long ids are taken out', () => {
    const msg = `connect 203.0.113.7 and 2001:db8::1 for /var/lib/mycel-relay/registry.db on acme.treesoop.example by alice@example.test with api_key=fakekey_abcdefghijklmnopqrstuvwx cookie: s3cr3t-cookie Authorization: Bearer eyJhbGciOiJFUzI1NiJ9.payload.sig GET /t/acme/api/files?token=abc`
    const out = scrubText(msg)
    for (const c of CANARIES) expect(out).not.toContain(c)
    expect(out).toContain('[ip]')
    expect(out).toContain('[path]')
    expect(out).toContain('Authorization=[redacted]')
    expect(scrubText('team name "회사" quoted')).toBe('team name [text] quoted')
    expect(scrubText('first line\nsecond line 203.0.113.7')).toBe('first line')
    expect(scrubText('x'.repeat(2000)).length).toBeLessThanOrEqual(300)
  })

  test('stack frames keep the last two parts of a file name and the code\'s own function names', () => {
    const stack = 'Error: boom\n    at handle (/opt/mycel-relay/releases/0.2.0/relay/src/relay.ts:10:5)\n    at async weird name ([eval]:1:1)\n    at node:internal/x:1:1'
    expect(parseStack(stack, 'boom')).toEqual([
      { filename: 'node:internal/x', function: '?', lineno: 1, colno: 1, in_app: false },
      { filename: '[file]', function: '?', lineno: 1, colno: 1, in_app: false },
      { filename: 'src/relay.ts', function: 'handle', lineno: 10, colno: 5, in_app: true },
    ])
  })

  test('an event holds exactly these fields', () => {
    const e = buildEvent({ type: 'RelayError', message: 'x', tags: { log_event: 'ops_error', bad: 'has space', 'Bad-Key': 'v' } }, { release: 'relay@0.2.0', environment: 'production', logger: 'relay', tags: { instance: 'a' }, now: T0 })
    expect(Object.keys(e).sort()).toEqual(['environment', 'event_id', 'exception', 'level', 'logger', 'platform', 'release', 'sdk', 'tags', 'timestamp'])
    expect(e.tags).toEqual({ instance: 'a', log_event: 'ops_error' })
    expect(e.level).toBe('error')
  })
})

describe('the relay', () => {
  test('error lines become reports with the event name and the scrubbed error only; forbidden fields never reach them', async () => {
    const f = fakeFetch()
    const { reporter } = relayReportsFrom({ RELAY_SENTRY_DSN: DSN, RELAY_SENTRY_ENV: 'staging', RELAY_INSTANCE: 'b' }, { fetch: f.fetch, now: () => T0 })
    const lines: string[] = []
    const log = createRelayLog((l) => lines.push(l), false, (ev, fields) => reporter!.capture(logLineInput(ev, fields)))
    log.info('team_connected', { team: 't_1' })
    log.warn('slow', { team: 't_1' })
    log.error('api_error', { error: 'no team at 203.0.113.7 /t/acme?token=abc', ip: '198.51.100.9', path: '/secret/path', headers: 'cookie: x', cookie: 'sid=1', team: 't_1234567890' })
    await reporter!.flush(1000)
    expect(lines.length).toBe(3)
    expect(f.posts.length).toBe(1)
    const p = f.posts[0]!
    expect(p.url).toBe('https://o1.ingest.example.test/api/42/envelope/')
    expect(p.headers.get('x-sentry-auth')).toContain('sentry_key=0123abcd')
    for (const s of ['203.0.113.7', '198.51.100.9', '/secret/path', '/t/acme', 'token=abc', 'cookie: x', 'sid=1', 't_1234567890']) expect(p.body).not.toContain(s)
    const [e] = f.events()
    expect(e!.release).toBe(`relay@${RELAY_VERSION}`)
    expect(e!.environment).toBe('staging')
    expect(e!.tags).toEqual({ instance: 'b', log_event: 'api_error' })
    expect(e!.exception.values[0].type).toBe('RelayError')
    expect(e!.exception.values[0].value).toBe('api_error: no team at [ip] [path]')
  })

  test('a log hook that throws never breaks the log', () => {
    const lines: string[] = []
    const log = createRelayLog((l) => lines.push(l), false, () => { throw new Error('x') })
    expect(() => log.error('ops_error', { error: 'TypeError' })).not.toThrow()
    expect(lines.length).toBe(1)
  })

  test('RELAY_INSTANCE outside a short code is left out', () => {
    const f = fakeFetch()
    const { reporter } = relayReportsFrom({ RELAY_SENTRY_DSN: DSN, RELAY_INSTANCE: 'a b/c' }, { fetch: f.fetch })
    reporter!.capture({ message: 'x' })
    return reporter!.flush(1000).then(() => expect(f.events()[0]!.tags).toEqual({}))
  })
})

describe('limits and crashes', () => {
  test('one copy of a repeated error a minute; at most 30 a minute; a crash always goes', async () => {
    const f = fakeFetch()
    let now = T0
    const r = new ErrorReporter(parseDsn(DSN)!, { release: 'relay@x', environment: 'production', logger: 'relay', fetch: f.fetch, now: () => now })
    r.capture({ message: 'same' })
    r.capture({ message: 'same' })
    for (let i = 0; i < 40; i++) r.capture({ message: `n${i}` })
    r.capture({ message: 'crash', fatal: true })
    await r.flush(1000)
    expect(f.posts.length).toBe(31)
    now += 61_000
    r.capture({ message: 'same' })
    await r.flush(1000)
    expect(f.posts.length).toBe(32)
  })

  test('Sentry\'s 429 pauses sending', async () => {
    const f = fakeFetch(429, { 'retry-after': '120' })
    let now = T0
    const r = new ErrorReporter(parseDsn(DSN)!, { release: 'x', environment: 'production', logger: 'relay', fetch: f.fetch, now: () => now })
    r.capture({ message: 'a' })
    await r.flush(1000)
    r.capture({ message: 'b' })
    now += 60_000
    r.capture({ message: 'c' })
    now += 61_000
    r.capture({ message: 'd' })
    await r.flush(1000)
    expect(f.events().map((e) => e.exception.values[0].value)).toEqual(['a', 'd'])
  })

  test('a network failure is swallowed', async () => {
    const r = new ErrorReporter(parseDsn(DSN)!, { release: 'x', environment: 'production', logger: 'relay', fetch: async () => { throw new Error('offline') } })
    expect(() => r.capture({ message: 'a' })).not.toThrow()
    await r.flush(1000)
  })

  test('a crash is reported as fatal, logged, and the process still exits with 1', async () => {
    const f = fakeFetch()
    const r = new ErrorReporter(parseDsn(DSN)!, { release: 'x', environment: 'production', logger: 'relay', fetch: f.fetch })
    const handlers = new Map<string, (e: unknown) => void>()
    const exits: number[] = []
    const logged: string[] = []
    reportCrashes(r, (what) => logged.push(what), { on: (ev, l) => handlers.set(ev, l), exit: (c) => exits.push(c) })
    handlers.get('uncaughtException')!(new TypeError('boom at /home/alice/x.ts'))
    handlers.get('unhandledRejection')!('ignored: already dying')
    await new Promise((d) => setTimeout(d, 50))
    expect(exits).toEqual([1])
    expect(logged).toEqual(['uncaught exception'])
    const [e] = f.events()
    expect(e!.level).toBe('fatal')
    expect(e!.exception.values[0]).toMatchObject({ type: 'TypeError', value: 'boom at [path]' })
    expect(f.posts[0]!.body).not.toContain('alice')
  })
})
