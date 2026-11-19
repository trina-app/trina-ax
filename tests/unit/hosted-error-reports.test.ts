// Opt-in error reports of the team server (server/src/system/error-reports.ts, docs/decisions/20261119-hosted-error-reports.md):
// off without MYCEL_ERROR_REPORT_URL, the allow-list of fields, content that must never leave, the turn-end report
// with its reason code, a receiver that is down or slow. Fictional keys and a fake fetch only: nothing reaches Sentry.
import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  ERROR_REPORT_ENV, errorInput, errorReports, errorReportsFrom, logLineInput, personTag, reportLogLine, reportServerCrashes, reportTurnEnd, setErrorReports, turnOutcome, turnReport,
} from '../../server/src/system/error-reports'
import { createLogger } from '../../server/src/log'

const DSN = 'https://0123abcd@o1.ingest.example.test/42'
const T0 = Date.UTC(2026, 10, 19, 3)
// users.id is made from the username (auth/users.ts deriveUserId): often a name
const USER = 'kimminsu'
const TENANT = '01JC8Z5V3Q1X2Y3Z4A5B6C7D8E'

// what must never reach a report: a message, a prompt, an answer, a file name and its text, an email, a real name
const CANARIES = ['kimminsu', 'Quarterly-Bonus-Plan', 'kimminsu@acme.example', 'Kim Minsu', '김민수', 'secret-plan.xlsx', 'Payroll_2026', 'tell me the salaries', 'The answer is 42 apples']

function fakeFetch(o: { status?: number; hang?: boolean; fail?: boolean } = {}) {
  const posts: { url: string; body: string }[] = []
  const fetch = (url: string, init: RequestInit): Promise<Response> => {
    posts.push({ url, body: String(init.body) })
    if (o.hang) return new Promise(() => {})
    if (o.fail) return Promise.reject(new Error('connect ECONNREFUSED'))
    return Promise.resolve(new Response(null, { status: o.status ?? 200 }))
  }
  return { posts, fetch, events: () => posts.map((p) => JSON.parse(p.body.split('\n')[2]!) as Record<string, any>) }
}

function on(f: ReturnType<typeof fakeFetch>, env: Record<string, string> = {}) {
  const s = errorReportsFrom({ [ERROR_REPORT_ENV]: DSN, MYCEL_INSTALL_ID: TENANT, ...env }, { version: '0.6.1', environment: 'hosted', fetch: f.fetch, now: () => T0 })
  setErrorReports(s.reports)
  return s
}

function db() {
  const d = new Database(':memory:')
  d.run(`CREATE TABLE turns (id TEXT PRIMARY KEY, chat_id TEXT, user_id TEXT, engine TEXT, model TEXT, status TEXT, started_at TEXT, dispatched_at TEXT, ended_at TEXT, client_kind TEXT, message_id TEXT, error TEXT)`)
  d.run(`CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT, error TEXT)`)
  d.run(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
  return d
}

function addTurn(d: Database, id: string, status: string, error: unknown, extra: { model?: string; engine?: string; content?: string } = {}) {
  d.query('INSERT INTO messages (id, content, error) VALUES (?, ?, ?)').run(`m-${id}`, extra.content ?? CANARIES.join(' '), error ? JSON.stringify(error) : null)
  d.query('INSERT INTO turns (id, chat_id, user_id, engine, model, status, started_at, dispatched_at, ended_at, client_kind, message_id, error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
    id, 'chat-Quarterly-Bonus-Plan', USER, extra.engine ?? 'claude-code', extra.model ?? 'claude-sonnet-4-5', status,
    '2026-11-19T03:00:00.000Z', '2026-11-19T03:00:02.000Z', '2026-11-19T03:00:44.000Z', 'chat', `m-${id}`, (error as { message?: string } | null)?.message ?? null)
}

const usageLimit = { code: 'rate_limited', message: 'Kim Minsu, your AI usage for secret-plan.xlsx is used up', params: { reason: 'rate_limit', status: 429 }, retryAfter: 120 }

afterEach(() => setErrorReports(null))

describe('off by default', () => {
  test('no setting: nothing is built, a report call does nothing', () => {
    const f = fakeFetch()
    const s = errorReportsFrom({}, { version: '0.6.1', environment: 'selfhost', fetch: f.fetch })
    expect(s).toEqual({ reports: null, invalid: false })
    expect(errorReportsFrom({ [ERROR_REPORT_ENV]: '  ' }, { version: '0.6.1', environment: 'selfhost' }).reports).toBeNull()
    setErrorReports(s.reports)
    const d = db()
    addTurn(d, 't1', 'error', usageLimit)
    reportTurnEnd(d, 't1', T0)
    reportLogLine('turn failed', { err: new Error('boom') })
    expect(f.posts).toHaveLength(0)
    expect(errorReports()).toBeNull()
  })

  test('a value that is not a Sentry key: invalid, nothing is sent', () => {
    for (const bad of ['not-a-dsn', 'http://k@o1.example.test/42', 'https://o1.example.test/42']) {
      expect(errorReportsFrom({ [ERROR_REPORT_ENV]: bad }, { version: '0.6.1', environment: 'hosted' })).toEqual({ reports: null, invalid: true })
    }
  })

  test('on: the host for the admin line is the host name only, never the key or the project', () => {
    const s = on(fakeFetch())
    expect(s.reports?.host).toBe('o1.ingest.example.test')
    expect(s.reports?.host).not.toContain('0123abcd')
  })
})

describe('the turn-end report', () => {
  test('outcomes: ok, stopped and interrupted send nothing; an error is failed; stalled is timed_out', () => {
    expect(turnOutcome('done', null)).toBe('ok')
    expect(turnOutcome('stopped', null)).toBe('stopped')
    expect(turnOutcome('interrupted', 'updating')).toBe('interrupted')
    expect(turnOutcome('error', 'rate_limit')).toBe('failed')
    expect(turnOutcome('error', 'stalled')).toBe('timed_out')
    const row = { user_id: USER, engine: 'claude-code', model: null, status: 'done', started_at: '2026-11-19T03:00:00Z', dispatched_at: null, ended_at: '2026-11-19T03:00:10Z' }
    expect(turnReport(row, null, { turns: 1, failed: 0 })).toBeNull()
    expect(turnReport({ ...row, status: 'stopped' }, null, { turns: 1, failed: 0 })).toBeNull()
    expect(turnReport({ ...row, status: 'interrupted' }, { params: { reason: 'updating' } }, { turns: 1, failed: 0 })).toBeNull()
  })

  test('a failed turn (usage used up): outcome, reason code, provider status, duration, engine, version, team and user ids', () => {
    const f = fakeFetch()
    on(f)
    const d = db()
    addTurn(d, 'ok1', 'done', null)
    addTurn(d, 't1', 'error', usageLimit)
    reportTurnEnd(d, 'ok1', T0)
    reportTurnEnd(d, 't1', T0 + 1000)
    const [e] = f.events()
    expect(f.events()).toHaveLength(1)
    expect(e!.level).toBe('error')
    expect(e!.release).toBe('mycel-server@0.6.1')
    expect(e!.environment).toBe('hosted')
    expect(e!.message).toEqual({ formatted: 'turn failed: rate_limit' })
    expect(e!.fingerprint).toEqual(['turn', 'failed', 'rate_limit'])
    expect(e!.tags).toEqual({
      team_id: TENANT, outcome: 'failed', reason: 'rate_limit', turns_1h: '2', failed_1h: '1',
      provider_status: '429', duration_s: '42', engine: 'claude-code', model: 'claude-sonnet-4-5', user: personTag(d, USER)!,
    })
  })

  test('a stalled turn is timed_out, a warning; an unknown reason is "other", none is "none"', () => {
    const f = fakeFetch()
    on(f)
    const d = db()
    addTurn(d, 's1', 'error', { code: 'engine_error', message: 'x', params: { reason: 'stalled' } })
    addTurn(d, 'u1', 'error', { code: 'engine_error', message: 'x', params: { reason: 'Kim Minsu asked about Payroll_2026' } })
    addTurn(d, 'n1', 'error', null)
    for (const id of ['s1', 'u1', 'n1']) reportTurnEnd(d, id, T0)
    const ev = f.events()
    expect(ev.map((e) => [e.level, e.tags.outcome, e.tags.reason])).toEqual([['warning', 'timed_out', 'stalled'], ['error', 'failed', 'other'], ['error', 'failed', 'none']])
  })

  test('an event holds only the allowed fields', () => {
    const f = fakeFetch()
    on(f)
    const d = db()
    addTurn(d, 't1', 'error', usageLimit)
    reportTurnEnd(d, 't1', T0)
    const [e] = f.events()
    expect(Object.keys(e!).sort()).toEqual(['environment', 'event_id', 'fingerprint', 'level', 'logger', 'message', 'platform', 'release', 'sdk', 'tags', 'timestamp'])
    const allowedTags = ['team_id', 'outcome', 'reason', 'turns_1h', 'failed_1h', 'provider_status', 'duration_s', 'engine', 'model', 'user']
    for (const k of Object.keys(e!.tags)) expect(allowedTags).toContain(k)
  })

  test('content never leaves: message text, the answer, file names, emails and names are in no body', () => {
    const f = fakeFetch()
    on(f)
    const d = db()
    // the canaries sit in the answer's text, the error's words, an unknown reason, a model and engine name, the chat id
    addTurn(d, 't1', 'error', { ...usageLimit, message: CANARIES.join(' ') })
    addTurn(d, 't2', 'error', { code: 'kimminsu@acme.example', message: 'x', params: { reason: 'secret-plan.xlsx', status: 'Kim Minsu' } }, { model: 'Kim Minsu', engine: 'Quarterly-Bonus-Plan' })
    reportTurnEnd(d, 't1', T0)
    reportTurnEnd(d, 't2', T0)
    // error lines of the log: the line's fields and the error's words with a path, an email and Korean text
    reportLogLine('saving the file failed', { err: new Error(`EACCES: open '/team/finance/secret-plan.xlsx' for kimminsu@acme.example 김민수`), path: 'finance/Payroll_2026.xlsx', chatId: 'Quarterly-Bonus-Plan', content: 'tell me the salaries' })
    reportLogLine('a turn end step failed', { step: 'The answer is 42 apples', user: 'Kim Minsu' })
    // plain words with no quote, path or dot: the scrubber cannot tell them from a name, so the words never go
    reportLogLine('opening a folder failed', { err: new Error('Folder Kim Minsu Payroll_2026 not found') })
    expect(f.posts.length).toBe(5)
    const all = f.posts.map((p) => p.body).join('\n')
    for (const c of CANARIES) expect(all).not.toContain(c)
    expect(all).not.toContain('/team/finance')
  })

  test('an id or a team id that looks like an email is left out', () => {
    const f = fakeFetch()
    on(f, { MYCEL_INSTALL_ID: 'kimminsu@acme.example' })
    const d = db()
    addTurn(d, 't1', 'error', usageLimit)
    d.query('UPDATE turns SET user_id = ? WHERE id = ?').run('kimminsu@acme.example', 't1')
    reportTurnEnd(d, 't1', T0)
    expect(f.posts[0]!.body).not.toContain('kimminsu')
  })

  test('the person is a stable stand-in made with a key of this server, never the id', () => {
    const d = db()
    const a = personTag(d, 'kimminsu')
    expect(a).toMatch(/^u_[0-9a-f]{16}$/)
    expect(personTag(d, 'kimminsu')).toBe(a)
    expect(personTag(d, 'leejiwoo')).not.toBe(a)
    // another server (another key): another stand-in for the same id
    expect(personTag(db(), 'kimminsu')).not.toBe(a)
    expect(personTag(new Database(':memory:'), 'kimminsu')).toBeNull()
  })

  test('a storm of failures is held to the per-minute limit', () => {
    const f = fakeFetch()
    on(f)
    const d = db()
    // one person's run of the same end: once a minute
    for (let i = 0; i < 50; i++) { addTurn(d, `t${i}`, 'error', usageLimit); reportTurnEnd(d, `t${i}`, T0 + i * 100) }
    expect(f.posts.length).toBe(1)
    addTurn(d, 'later', 'error', usageLimit)
    reportTurnEnd(d, 'later', T0 + 61_000)
    expect(f.posts.length).toBe(2)
    // many people at once: the shared sender's 30 a minute
    for (let i = 0; i < 50; i++) { addTurn(d, `p${i}`, 'error', usageLimit); d.query('UPDATE turns SET user_id = ? WHERE id = ?').run(`person-${i}`, `p${i}`); reportTurnEnd(d, `p${i}`, T0 + 62_000) }
    expect(f.posts.length).toBeLessThanOrEqual(30)
  })
})

describe('turns still running, rows missing, crashes', () => {
  test('a turn still queued or running sends nothing; an error without an answer row is reason none', () => {
    const f = fakeFetch()
    on(f)
    const d = db()
    addTurn(d, 'q', 'queued', null)
    addTurn(d, 'r', 'running', null)
    addTurn(d, 'e', 'error', usageLimit)
    d.query('UPDATE turns SET message_id = NULL WHERE id = ?').run('e')
    for (const id of ['q', 'r', 'e']) reportTurnEnd(d, id, T0)
    expect(f.events().map((e) => e.tags.reason)).toEqual(['none'])
  })

  test('a crash: reported without its words, then the process exits with 1', async () => {
    const f = fakeFetch()
    const s = on(f)
    const handlers: Record<string, (e: unknown) => void> = {}
    let code = null as number | null
    const proc = { on: (ev: string, h: (e: unknown) => void) => { handlers[ev] = h; return proc }, exit: (c: number) => { code = c } }
    const stderr = process.stderr.write
    process.stderr.write = (() => true) as typeof process.stderr.write
    try {
      reportServerCrashes(s.reports!, () => {}, proc as never)
      handlers.uncaughtException!(new RangeError('Kim Minsu broke Quarterly-Bonus-Plan'))
      await Bun.sleep(20)
    } finally { process.stderr.write = stderr }
    expect(code).toBe(1)
    const [e] = f.events()
    expect(e!.level).toBe('fatal')
    expect(e!.exception.values[0].type).toBe('RangeError')
    expect(JSON.stringify(e)).not.toContain('Kim Minsu')
  })
})

describe('a receiver that is down or slow', () => {
  test('a receiver that never answers: the turn end returns at once and nothing throws', async () => {
    for (const mode of [{ hang: true }, { fail: true }, { status: 500 }]) {
      const f = fakeFetch(mode)
      on(f)
      const d = db()
      addTurn(d, 't1', 'error', usageLimit)
      const t = performance.now()
      expect(() => reportTurnEnd(d, 't1', T0)).not.toThrow()
      expect(() => reportLogLine('boom', { err: new Error('x') })).not.toThrow()
      expect(performance.now() - t).toBeLessThan(50)
      await Promise.resolve()
      expect(f.posts.length).toBe(2)
    }
  })

  test('a broken database read is swallowed', () => {
    on(fakeFetch())
    const d = new Database(':memory:')
    expect(() => reportTurnEnd(d, 'nope', T0)).not.toThrow()
  })
})

describe('the log hook', () => {
  test('only error lines reach it, with the raw fields; a hook that throws does not break logging', () => {
    const seen: string[] = []
    const lines: string[] = []
    const log = createLogger({ level: 'debug', sink: (l) => lines.push(l), onError: (m) => { seen.push(m); throw new Error('hook') } })
    log.info('fine')
    log.warn('careful')
    expect(() => log.child({ turn: 't' }).error('broke', { err: new Error('x') })).not.toThrow()
    expect(seen).toEqual(['broke'])
    expect(lines).toHaveLength(3)
  })

  test('logLineInput: the error type, its fixed code and frames, never its words; or the line alone', () => {
    const err = new TypeError('cannot read x')
    const i = logLineInput('turn failed', { err, path: 'a/b' })
    expect(i.type).toBe('TypeError')
    expect(i.message).toBe('turn failed')
    expect(i.stack).toMatch(/^TypeError\n\s+at /)
    expect(i.stack).not.toContain('cannot read x')
    const enoent = Object.assign(new Error("ENOENT: no such file or directory, open 'Payroll Alice Park.xlsx'"), { code: 'ENOENT' })
    expect(logLineInput('reading failed', { err: enoent }).message).toBe('reading failed: ENOENT')
    expect(logLineInput('queue dispatch failed', { tries: 3 })).toEqual({ type: 'ServerError', message: 'queue dispatch failed', kind: 'message' })
  })

  test('an error message line that looks like a frame is not read as one', () => {
    const err = new Error('bad input\n    at Kim Minsu (/team/Quarterly-Bonus-Plan.ts:1:2)')
    const i = errorInput('x', err)
    expect(i.stack ?? '').not.toContain('Quarterly-Bonus-Plan')
    expect(i.stack ?? '').not.toContain('Kim Minsu')
  })
})
