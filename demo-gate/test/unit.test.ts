// The gate's pure parts: header allowlist, beta handling, error shapes, prompt-too-long, weighted counting, the stream
// rewrite, the deny list, cookies, languages, start limits, config checks and log hygiene.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ConfigError, parseConfig } from '../src/config.ts'
import { createLog } from '../src/log.ts'
import {
  BUSY_TEXT, NEUTRAL_HEADERS, NEUTRAL_STATUS, OAUTH_BETA, SseRewriter, allowedResponseHeaders, betaFor, budgetError,
  isPromptTooLong, neutralError, weighted,
} from '../src/model.ts'
import { localeOf, renderPage } from '../src/pages.ts'
import { cookiesForInstance, pathVerdict, secureCookie } from '../src/public.ts'
import { GateState } from '../src/state.ts'
// the instance's own reading of upstream answers: the gate's answers must never mark its AI connection
import { accountRefusal } from '../../server/src/proxy/anthropic-refusal.ts'
import { classifyError } from '../../server/src/engine/claude-parse.ts'

describe('response headers', () => {
  test('only the allowlist goes back; the account and edge headers stay', () => {
    const out = allowedResponseHeaders({
      'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': 'req_1', 'anthropic-organization-id': 'org',
      'anthropic-ratelimit-unified-status': 'allowed', 'anthropic-ratelimit-unified-5h-utilization': '0.4', 'cf-ray': 'x', 'set-cookie': ['a=b'],
      server: 'cloudflare', via: '1.1', 'x-envoy-upstream-service-time': '3',
    })
    expect(out).toEqual({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  })
})

describe('credential modes', () => {
  test('subscription adds the oauth beta, an API key drops it', () => {
    expect(betaFor('claude-subscription', 'prompt-caching-2024-07-31')).toBe(`prompt-caching-2024-07-31,${OAUTH_BETA}`)
    expect(betaFor('claude-subscription', undefined)).toBe(OAUTH_BETA)
    expect(betaFor('anthropic-api-key', `${OAUTH_BETA},prompt-caching-2024-07-31`)).toBe('prompt-caching-2024-07-31')
    expect(betaFor('anthropic-api-key', OAUTH_BETA)).toBeNull()
    expect(betaFor('anthropic-api-key', 'not a beta, x')).toBeNull()
  })
})

describe('error shapes', () => {
  test('the neutral answer never marks the instance connection and reads as a temporary failure', () => {
    expect(NEUTRAL_STATUS).toBe(503)
    expect(neutralError()).toEqual({ type: 'error', error: { type: 'api_error', message: BUSY_TEXT } })
    expect(NEUTRAL_HEADERS['x-should-retry']).toBe('false')
    expect(Object.keys(NEUTRAL_HEADERS)).not.toContain('request-id')
    expect(Object.keys(NEUTRAL_HEADERS)).not.toContain('retry-after')
    // what the engine prints for it is a crash (retried once, then "try again"), not sign-in, limit or context
    expect(classifyError(`API Error: 503 ${JSON.stringify(neutralError())}`)).toBe('crash')
    expect(classifyError(BUSY_TEXT)).toBe('crash')
  })
  test('the budget stop and the passed-through 400 have no request-id, so the instance marks nothing', () => {
    for (const kind of ['anthropic-oauth', 'anthropic-api-key'] as const) {
      expect(accountRefusal({ path: '/v1/messages', status: 403, body: JSON.stringify(budgetError()), requestId: null, kind })).toBeNull()
      expect(accountRefusal({ path: '/v1/messages', status: 400, body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens > 200000 maximum' } }), requestId: null, kind })).toBeNull()
    }
    expect(budgetError()).toEqual({ type: 'error', error: { type: 'permission_error', message: 'budget_exceeded' } })
  })
  test('prompt too long is recognised only as Anthropic writes it', () => {
    const body = (m: string, type = 'invalid_request_error') => JSON.stringify({ type: 'error', error: { type, message: m } })
    expect(isPromptTooLong(400, body('prompt is too long: 210000 tokens > 200000 maximum'))).toBe(true)
    expect(isPromptTooLong(400, body('Prompt is too long'))).toBe(true)
    expect(isPromptTooLong(413, body('prompt is too long'))).toBe(false)
    expect(isPromptTooLong(400, body('max_tokens: too large'))).toBe(false)
    expect(isPromptTooLong(400, body('prompt is too long', 'billing_error'))).toBe(false)
    expect(isPromptTooLong(400, 'prompt is too long')).toBe(false)
  })
})

describe('weighted tokens', () => {
  test('uncached input + cache writes + output + 0.1 × cache reads', () => {
    expect(weighted({ input_tokens: 100, cache_creation_input_tokens: 50, output_tokens: 200, cache_read_input_tokens: 1000 })).toBe(450)
    expect(weighted({})).toBe(0)
    expect(weighted({ input_tokens: -5, output_tokens: Number.NaN })).toBe(0)
  })
  test('the stream reader takes input from message_start and the last output total from message_delta', () => {
    const rw = new SseRewriter()
    const ev = (e: unknown) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`
    const all = ev({ type: 'message_start', message: { usage: { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 1000, output_tokens: 1 } } })
      + ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } })
      + ev({ type: 'message_delta', usage: { output_tokens: 120 } })
      + ev({ type: 'message_delta', usage: { output_tokens: 200 } })
      + ev({ type: 'message_stop' })
    // split at awkward places: events are only passed on whole
    let out = ''
    for (let i = 0; i < all.length; i += 7) out += rw.feed(all.slice(i, i + 7))
    out += rw.end()
    expect(out).toBe(all)
    expect(weighted(rw.usage)).toBe(450)
    expect(rw.sawError).toBe(false)
  })
  test('an error event inside a stream becomes the neutral error', () => {
    const rw = new SseRewriter()
    const out = rw.feed('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n'
      + 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n')
    expect(out).not.toContain('overloaded')
    expect(out).toContain(`event: error\ndata: ${JSON.stringify(neutralError())}\n\n`)
    expect(rw.sawError).toBe(true)
    // also without the event line, and with CRLF
    const rw2 = new SseRewriter()
    expect(rw2.feed('data: {"type":"error","error":{"type":"rate_limit_error","message":"x"}}\r\n\r\n')).toContain(BUSY_TEXT)
  })
})

describe('deny list', () => {
  test.each([
    '/api/admin/credentials', '/api/admin', '/api/setup', '/api/credentials/sealing-key', '/api/me/credentials/1', '/api/me/credential-logins',
    '/api/invites/abc/accept', '/api/guest-invites', '/api/team-link/join', '/api/password-resets/tok', '/api/auth/password',
    '/api/demo/persona', '/api/integrations/oauth/callback', '/api/integrations/google-drive/callback', '/api/integrations/slack/oauth/callback',
    '/oauth/authorize', '/mcp', '/connector-uploads/x', '/invite/abc', '/join', '/reset-password/x', '/setup',
    '/API/Admin/x', '/api%2Fadmin', '//api/admin', '/api//admin/x', '/mcp?x=1',
  ])('%s is refused', (p) => expect(pathVerdict(p)).toBe('deny'))
  test.each(['/api/../api/admin', '/a/./b', '/x\\y', '/%2e%2e/api/admin', '/x%00'])('%s is a bad path', (p) => expect(pathVerdict(p)).toBe('bad'))
  test.each(['/', '/api/chats', '/api/rooms/1/files/2', '/api/demo', '/assets/app.js', '/api/administrator-notes', '/joiner', '/files/a%2Fb.md'])('%s passes', (p) => {
    // /api/administrator-notes would be denied by a bare prefix; segment boundaries matter except for credential*
    expect(pathVerdict(p)).toBe('ok')
  })
})

describe('cookies', () => {
  test('instance cookies are host-only and Secure', () => {
    expect(secureCookie('mycel-dev-sid=abc; Path=/; HttpOnly; SameSite=Lax')).toBe('mycel-dev-sid=abc; Path=/; HttpOnly; SameSite=Lax; Secure')
    expect(secureCookie('a=b; Domain=example.com; Secure')).toBe('a=b; Secure')
  })
  test('the gate cookie never reaches an instance', () => {
    expect(cookiesForInstance('__Host-tdg=x; mycel-dev-sid=y')).toBe('mycel-dev-sid=y')
    expect(cookiesForInstance('__Host-tdg=x')).toBeNull()
    expect(cookiesForInstance(undefined)).toBeNull()
  })
})

describe('pages', () => {
  test('?lang= wins over the browser language', () => {
    expect(localeOf('ko', 'en-US')).toBe('ko')
    expect(localeOf('en', 'ko-KR')).toBe('en')
    expect(localeOf(null, 'ko-KR,ko;q=0.9')).toBe('ko')
    expect(localeOf('xx', 'fr, en;q=0.5')).toBe('en')
    expect(localeOf(null, undefined)).toBe('en')
  })
  test('every page renders in both languages; links are the configured ones', () => {
    for (const l of ['en', 'ko'] as const) for (const k of ['landing', 'busy', 'ended', 'limit', 'check', 'error'] as const) {
      const html = renderPage(k, l, { siteKey: 'k"<', links: { scriptedDemo: 'https://ax.trina.app/demo', pricing: 'https://ax.trina.app/pricing' } })
      expect(html).toContain(`<html lang="${l}">`)
      expect(html).not.toContain('k"<')
      if (k === 'busy') expect(html).toContain('https://ax.trina.app/demo')
      if (k === 'landing' || k === 'ended') expect(html).toContain('action="/__demo/start"')
    }
  })
})

describe('start limits', () => {
  test('3 per hour, 6 per day, kept across a restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdg-state-'))
    try {
      const s = new GateState(dir)
      const t0 = Date.now() - 2 * 3600_000 - 10_000
      for (let i = 0; i < 3; i++) { expect(s.startRefusal('203.0.113.5', 3, 6, t0 + i)).toBeNull(); s.noteStart('203.0.113.5', t0 + i) }
      expect(s.startRefusal('203.0.113.5', 3, 6, t0 + 10)).toBe('hour')
      expect(s.startRefusal('203.0.113.6', 3, 6, t0 + 10)).toBeNull()
      const later = t0 + 3600_000 + 5_000
      for (let i = 0; i < 3; i++) s.noteStart('203.0.113.5', later + i)
      expect(s.startRefusal('203.0.113.5', 3, 6, later + 10)).toBe('day')
      s.flush()
      const s2 = new GateState(dir)
      expect(s2.startRefusal('203.0.113.5', 3, 6, later + 10)).toBe('day')
      // a day after the first three, only the later three count, and they are more than an hour old
      expect(s2.startRefusal('203.0.113.5', 3, 6, t0 + 24 * 3600_000 + 5)).toBeNull()
      expect(s2.startRefusal('203.0.113.5', 3, 6, later + 60_000)).toBe('day')
      expect(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).not.toContain('203.0.113')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
  test('the daily token count starts again on a new UTC day', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdg-state-'))
    try {
      const s = new GateState(dir)
      const t = Date.now()
      s.addTokens(500, t)
      expect(s.dailyTokens(t)).toBe(500)
      expect(s.dailyTokens(t + 24 * 3600_000)).toBe(0)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('config', () => {
  const base = {
    stateDir: 'state', turnstile: { siteKey: 'k', secretFile: 'ts' }, ai: { credentialFile: 'cred' },
    pool: { snapshotsDir: 'snap', instancesDir: '/tmp/tdg', codeVersion: '1.0.0', command: ['node', 'x.ts', '--config', '{config}'] },
  }
  test('defaults: the plan numbers', () => {
    const c = parseConfig(base, '/srv')
    expect(c.ai.mode).toBe('claude-subscription')
    expect(c.pool).toMatchObject({ warmPerLocale: 2, maxLive: 10, ttlHours: 24, locales: ['en', 'ko'], personaKey: 'newHire' })
    expect(c.limits).toMatchObject({ startsPerHour: 3, startsPerDay: 6, livePerIp: 2, maxStreams: 4 })
    expect(c.publicOrigin).toBe('https://demo.trina.app')
  })
  test('refuses what would break or leak', () => {
    const bad = (patch: Record<string, unknown>) => expect(() => parseConfig({ ...base, ...patch }, '/srv')).toThrow(ConfigError)
    bad({ pool: { ...base.pool, instancesDir: '/Users/someone/Library/Application Support/demo-gate/instances' } })
    bad({ ai: { credentialFile: 'cred', mode: 'openai' } })
    bad({ ai: { credentialFile: 'cred', upstream: 'http://api.example.com' } })
    bad({ ai: { credentialFile: 'cred', upstream: 'https://u:p@api.anthropic.com' } })
    bad({ pool: { ...base.pool, locales: ['fr'] } })
    bad({ publicOrigin: 'https://demo.trina.app/path' })
  })
})

describe('log', () => {
  test('forbidden fields never reach a line', () => {
    const lines: string[] = []
    const log = createLog((l) => lines.push(l))
    log.warn('x', { instance: 'abcd1234', ip: '203.0.113.1', authorization: 'Bearer z', prompt: 'hello', body: '{}', status: 503 })
    const o = JSON.parse(lines[0]!)
    expect(o).toMatchObject({ ev: 'x', instance: 'abcd1234', status: 503 })
    for (const k of ['ip', 'authorization', 'prompt', 'body']) expect(o[k]).toBeUndefined()
  })
})
