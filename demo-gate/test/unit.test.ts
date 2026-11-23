// The gate's pure parts: header allowlist, beta handling, error shapes, prompt-too-long, weighted counting, the stream
// rewrite, the deny list, cookies, languages, start limits, config checks and log hygiene.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ConfigError, DEFAULT_MODELS, LOCALES, instanceUserProblem, parseConfig } from '../src/config.ts'
import { createLog } from '../src/log.ts'
import {
  BUSY_TEXT, NEUTRAL_HEADERS, NEUTRAL_STATUS, OAUTH_BETA, SseRewriter, allowedResponseHeaders, betaFor, budgetError,
  isPromptTooLong, modelAllowed, neutralError, pinModel, visitorWeighted, weighted,
} from '../src/model.ts'
import { WORDMARK_DARK, WORDMARK_LIGHT } from '../src/brand.ts'
import { WORDS, localeOf, renderPage } from '../src/pages.ts'
import { LINUX_BUN, LINUX_COMMAND, LINUX_COMMAND_V1, LINUX_INSTANCES_DIR, LINUX_TDSCOPE, linuxCommandProblems, migrateLinuxCommand } from '../src/linux-command.ts'
import { asInstanceUser, groupsBelow, ownsGroup, runMode, sudoStartArgv } from '../src/pool.ts'
import { cookiesForInstance, pathVerdict, secureCookie, visitorAddress, withNoTransform } from '../src/public.ts'
import { GateState } from '../src/state.ts'
import { GateStats, KEEP_DAYS, durationBucket } from '../src/stats.ts'
import { parseUnifiedLimits } from '../src/upstream.ts'
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

describe('unified rate-limit headers', () => {
  const now = Date.parse('2026-11-21T00:00:00Z')
  test('5h/7d utilization, status, reset and other windows; numbers and status words only', () => {
    const l = parseUnifiedLimits(new Headers({
      'anthropic-ratelimit-unified-status': 'allowed', 'anthropic-ratelimit-unified-reset': '1795000000',
      'anthropic-ratelimit-unified-5h-utilization': '0.42', 'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-7d-utilization': '0.07', 'anthropic-ratelimit-unified-7d-reset': '1795500000',
      'anthropic-ratelimit-unified-7d_opus-status': 'Allowed_Warning', 'anthropic-ratelimit-unified-overage-status': 'rejected',
      'anthropic-ratelimit-unified-representative-claim': 'five_hour', 'anthropic-ratelimit-unified-fallback-percentage': '0.5',
      'request-id': 'req_1', 'anthropic-organization-id': 'org-1', authorization: 'Bearer x',
    }), now)!
    expect(l).toEqual({
      utilization5h: 0.42, utilization7d: 0.07, status: 'allowed', resetAt: new Date(1795000000 * 1000).toISOString(),
      windows: {
        '5h': { utilization: 0.42, status: 'allowed' },
        '7d': { utilization: 0.07, resetAt: new Date(1795500000 * 1000).toISOString() },
        '7d_opus': { status: 'allowed_warning' },
        overage: { status: 'rejected' },
      },
      seenAt: '2026-11-21T00:00:00.000Z',
    })
    const text = JSON.stringify(l)
    for (const bad of ['req_1', 'org-1', 'Bearer', 'five_hour']) expect(text).not.toContain(bad)
  })
  test('junk values are dropped; no unified header means nothing seen', () => {
    expect(parseUnifiedLimits(new Headers({ 'request-id': 'r', 'anthropic-ratelimit-tokens-remaining': '5' }))).toBeNull()
    expect(parseUnifiedLimits({ 'anthropic-ratelimit-unified-5h-utilization': 'org-1', 'anthropic-ratelimit-unified-status': 'sk-ant-xyz' })).toBeNull()
    const l = parseUnifiedLimits({ 'anthropic-ratelimit-unified-5h-utilization': '1e9', 'anthropic-ratelimit-unified-7d-utilization': '0.9', 'anthropic-ratelimit-unified-reset': 'tomorrow' }, now)!
    expect(l).toMatchObject({ utilization5h: null, utilization7d: 0.9, status: null, resetAt: null })
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
  test('the visitor\'s count: cache writes at 0.1 too (the instance\'s demo limit, server credentials/broker.ts)', () => {
    expect(visitorWeighted({ input_tokens: 100, cache_creation_input_tokens: 50, output_tokens: 200, cache_read_input_tokens: 1000 })).toBe(405)
    // a fresh copy's first request: the system prompt and the tools written to the cache
    expect(visitorWeighted({ input_tokens: 10, cache_creation_input_tokens: 70_000, output_tokens: 900 })).toBe(7910)
    expect(weighted({ input_tokens: 10, cache_creation_input_tokens: 70_000, output_tokens: 900 })).toBe(70_910)
    expect(visitorWeighted({})).toBe(0)
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
    '/oauth/authorize', '/mcp', '/connector-uploads/x', '/connector-downloads/x', '/invite/abc', '/join', '/reset-password/x', '/setup',
    '/API/Admin/x', '/api%2Fadmin', '//api/admin', '/api//admin/x', '/mcp?x=1',
  ])('%s is refused', (p) => expect(pathVerdict(p)).toBe('deny'))
  test.each(['/api/../api/admin', '/a/./b', '/x\\y', '/%2e%2e/api/admin', '/x%00'])('%s is a bad path', (p) => expect(pathVerdict(p)).toBe('bad'))
  test.each(['/', '/api/chats', '/api/rooms/1/files/2', '/api/demo', '/assets/app.js', '/api/administrator-notes', '/joiner', '/files/a%2Fb.md'])('%s passes', (p) => {
    // /api/administrator-notes would be denied by a bare prefix; segment boundaries matter except for credential*
    expect(pathVerdict(p)).toBe('ok')
  })
})

test('the sign-in page\'s language: GET /api/setup stays denied, GET /api/demo, which says it, passes (QA TC-6790)', () => {
  expect(pathVerdict('/api/setup')).toBe('deny')
  expect(pathVerdict('/api/demo')).toBe('ok')
})

describe('cookies', () => {
  test('instance cookies are host-only and Secure', () => {
    expect(secureCookie('mycel-dev-sid=abc; Path=/; HttpOnly; SameSite=Lax')).toBe('mycel-dev-sid=abc; Path=/; HttpOnly; SameSite=Lax; Secure')
    expect(secureCookie('a=b; Domain=example.com; Secure')).toBe('a=b; Secure')
  })
  test('the instance\'s __Host-sid stays a cookie the browser keeps: Secure once, Path=/, no Domain', () => {
    expect(secureCookie('__Host-sid=abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure')).toBe('__Host-sid=abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure')
    expect(secureCookie('__Host-sid=abc; Path=/; Domain=127.0.0.1; HttpOnly')).toBe('__Host-sid=abc; Path=/; HttpOnly; Secure')
    expect(secureCookie('__Host-sid=abc; Path=/api; HttpOnly')).toBe('__Host-sid=abc; Path=/; HttpOnly; Secure')
    expect(secureCookie('__Host-sid=abc; HttpOnly')).toBe('__Host-sid=abc; Path=/; HttpOnly; Secure')
    expect(cookiesForInstance('__Host-tdg=x; __Host-sid=y')).toBe('__Host-sid=y')
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
    for (const l of LOCALES) expect(localeOf(l, 'en-US')).toBe(l)
    expect(localeOf(null, 'ja-JP,ja;q=0.9')).toBe('ja')
    expect(localeOf(null, 'zh-CN,zh;q=0.9')).toBe('zh')
    expect(localeOf(null, 'es-MX')).toBe('es')
    expect(localeOf(null, 'id-ID,en;q=0.8')).toBe('id')
  })
  test('only the live languages (pool.locales): anything else falls back to en', () => {
    const live = ['en', 'ko'] as const
    expect(localeOf('ja', 'ja-JP', live)).toBe('en')
    expect(localeOf(null, 'zh-CN,ko;q=0.8', live)).toBe('ko')
    expect(localeOf('ko', undefined, live)).toBe('ko')
    expect(localeOf('xx', 'fr', ['ja'])).toBe('ja')
  })
  test('the mycel_locale cookie (the language used in the app) comes after ?lang= and before the browser', () => {
    expect(localeOf(null, 'en', LOCALES, 'ja')).toBe('ja')
    expect(localeOf('ko', 'en', LOCALES, 'ja')).toBe('ko')
    expect(localeOf(null, 'ko-KR', LOCALES, 'es')).toBe('es')
    expect(localeOf(null, 'ko-KR', LOCALES, null)).toBe('ko')
    // checked like ?lang=: only one of the live languages, never raw input
    expect(localeOf(null, 'en', LOCALES, '"><script>')).toBe('en')
    expect(localeOf(null, 'ko-KR', LOCALES, 'xx')).toBe('ko')
    expect(localeOf(null, 'ko-KR', ['en', 'ko'], 'ja')).toBe('ko')
    expect(localeOf(null, undefined, LOCALES, 'JA')).toBe('en')
  })
  test('the landing is short: wordmark, heading, one line, three facts, Start; the old long text is gone', () => {
    const links = { scriptedDemo: 'https://ax.trina.app/demo', pricing: 'https://ax.trina.app/pricing' }
    expect(WORDS.en.landingH).toBe('Try Trina AX')
    expect(WORDS.ko.landingH).toBe('트리나 AX 써 보기')
    expect(WORDS.en.sub).toBe("You're Mina at a made-up company. Ask, open, look around.")
    const gone = [
      'Trina AX is an AI workspace for your team',
      'Now try it yourself',
      'You get your own copy of the demo team',
      'Nothing you do here reaches real people',
      'bigger tasks count a little more',
      '트리나 AX는 팀을 위한 AI 업무 공간이에요',
      '데모 팀을 나만의 사본으로 드려요',
    ]
    for (const l of LOCALES) {
      const html = renderPage('landing', l, { siteKey: 'k', links })
      const w = WORDS[l]
      for (const old of gone) expect(html, l).not.toContain(old)
      expect(html, l).not.toContain('class="lead"')
      expect(html, l).not.toContain('class="note')
      // the one line under the heading stays one short line: at most 12 words (or 40 characters without spaces)
      if (['en', 'es', 'id'].includes(l)) expect(w.sub.split(/\s+/).length, l).toBeLessThanOrEqual(12)
      else expect(w.sub.length, l).toBeLessThanOrEqual(40)
      // the facts row: three facts of a few words, in this order, before the browser check and Start
      const facts = html.indexOf('<ul class="facts">')
      expect(facts, l).toBeGreaterThan(html.indexOf('<h1>'))
      expect(facts, l).toBeLessThan(html.indexOf('class="cf-turnstile"'))
      expect(html.indexOf('class="cf-turnstile"'), l).toBeLessThan(html.indexOf('type="submit"'))
      expect(html.match(/<li class="fact">/g)?.length, l).toBe(3)
      const order = [w.factQ, w.factHours, w.factPractice].map((t) => html.indexOf(`<span>${t}</span>`))
      expect(order.every((n) => n > facts), l).toBe(true)
      expect([...order].sort((a, b) => a - b), l).toEqual(order)
      for (const k of ['factQ', 'factHours', 'factPractice'] as const) {
        expect(w[k].length, `${l} ${k}`).toBeLessThanOrEqual(26)
        if (l !== 'en' && k !== 'factHours') expect(w[k], `${l} ${k}`).not.toBe(WORDS.en[k])
      }
      // drawn icons, never emoji
      expect(html.match(/<svg class="ic"/g)?.length, l).toBe(3)
      // the wordmark heads every page; the facts only the landing
      for (const k of ['landing', 'busy', 'ended', 'limit', 'check', 'error'] as const) {
        const page = renderPage(k, l, { siteKey: 'k', links })
        expect(page, `${l} ${k}`).toContain('<div class="brand" role="img" aria-label="Trina AX">')
        if (k !== 'landing') expect(page, `${l} ${k}`).not.toContain('class="facts"')
      }
    }
  })
  test('the full practice sentence is behind the third fact (details/summary, no script), not a visible paragraph', () => {
    const links = { scriptedDemo: 'https://ax.trina.app/demo', pricing: 'https://ax.trina.app/pricing' }
    expect(WORDS.en.practice).toBe('Gmail, Google Drive and Higgsfield here are practice copies: mail is never really sent, and new pictures come from a prepared set.')
    expect(WORDS.ko.practice).toBe('여기 Gmail·Google Drive·Higgsfield는 연습용이에요. 메일은 실제로 보내지 않고, 새 사진은 준비된 사진 중에서 골라요.')
    for (const l of LOCALES) {
      const html = renderPage('landing', l, { siteKey: 'k', links })
      const w = WORDS[l]
      for (const name of ['Gmail', 'Higgsfield']) expect(w.practice, l).toContain(name)
      expect(w.factPractice, l).toContain('Gmail')
      // closed by default; the summary's title says it on hover too
      expect(html, l).toContain(`<details class="practice"><summary title="${w.practice}">`)
      const summary = html.slice(html.indexOf('<summary'), html.indexOf('</summary><p>'))
      expect(summary, l).toContain(`<span>${w.factPractice}</span>`)
      expect(html, l).toContain(`<p>${w.practice}</p></details>`)
      expect(html, l).not.toMatch(/<script(?![^>]*challenges\.cloudflare\.com)/)
    }
    for (const k of ['busy', 'ended', 'limit'] as const) expect(renderPage(k, 'en', { siteKey: 'k', links })).not.toContain('practice copies')
  })
  test('the opened practice note pushes Turnstile and Start down, never covers them (390 px: an overlay hid the Turnstile box)', () => {
    const links = { scriptedDemo: 'https://ax.trina.app/demo', pricing: 'https://ax.trina.app/pricing' }
    for (const l of ['en', 'ko'] as const) {
      const html = renderPage('landing', l, { siteKey: 'k', links })
      const rule = (sel: string) => html.match(new RegExp(`(^|\\n)\\s*${sel.replace(/[.[\]()]/g, '\\$&')} \\{([^}]*)\\}`))?.[2] ?? ''
      // the note is in the flow: no absolute (or fixed) box over what follows, no stacking above it
      expect(rule('.practice p'), l).not.toMatch(/position\s*:\s*(absolute|fixed)/)
      expect(rule('.practice p'), l).not.toContain('z-index')
      expect(rule('.facts'), l).not.toContain('position')
      // its fact takes a line of its own when open, so the sentence wraps inside the row
      expect(rule('.fact:has(.practice[open])'), l).toContain('flex-basis:100%')
      // the note comes before Turnstile and Start in the page, so being in the flow puts them below it
      expect(html.indexOf('<p>' + WORDS[l].practice), l).toBeLessThan(html.indexOf('class="cf-turnstile"'))
      expect(html.indexOf('class="cf-turnstile"'), l).toBeLessThan(html.indexOf('<button type="submit"'))
    }
  })
  test('busy, limit, ended and error: the buttons fill the text column, stacked and centred (1440 px looked lopsided)', () => {
    const links = { scriptedDemo: 'https://ax.trina.app/demo', pricing: 'https://ax.trina.app/pricing' }
    for (const k of ['busy', 'limit', 'ended', 'error'] as const) {
      const html = renderPage(k, 'en', { siteKey: 'k', links, limit: 'hour' })
      const rule = (sel: string) => html.match(new RegExp(`(^|\\n)\\s*${sel.replace(/[.[\]()]/g, '\\$&')} \\{([^}]*)\\}`))?.[2] ?? ''
      expect(html, k).toContain(`<body class="${k}">`)
      // one column for the text and the buttons on every page but the landing
      expect(rule('body:not(.landing) main'), k).toContain('max-width:400px')
      // the buttons stack at the column's full width: no row that sizes its buttons on its own
      expect(rule('.row'), k).toContain('flex-direction:column')
      expect(rule('.row'), k).toContain('width:100%')
      expect(html, k).not.toMatch(/\.row a \{[^}]*flex:/)
    }
  })
  test('the wordmark is the branding file, both colours, each with its own mask id', () => {
    const logo = (f: string) => fs.readFileSync(path.join(import.meta.dir, '../../editions/trina/branding/logo', f), 'utf8').trim()
    expect(WORDMARK_LIGHT).toBe(logo('wordmark-light.svg'))
    expect(WORDMARK_DARK).toBe(logo('wordmark-dark.svg'))
    const html = renderPage('landing', 'en', { siteKey: 'k', links: { scriptedDemo: 'https://x', pricing: 'https://y' } })
    expect(html).toContain('id="wm-l"')
    expect(html).toContain('url(#wm-l)')
    expect(html).toContain('id="wm-d"')
    expect(html).toContain('url(#wm-d)')
    expect(html).not.toContain('id="m"')
  })
  test('busy and error pages have a Try again link to /; the limit page does not', () => {
    const links = { scriptedDemo: 'https://ax.trina.app/demo', pricing: 'https://ax.trina.app/pricing' }
    expect(WORDS.en.retry).toBe('Try again')
    expect(WORDS.ko.retry).toBe('다시 해 보기')
    for (const l of LOCALES) {
      for (const k of ['busy', 'error'] as const) {
        const html = renderPage(k, l, { siteKey: 'k', links })
        expect(html, `${l} ${k}`).toContain(`<a class="secondary" href="/">${WORDS[l].retry}</a>`)
        expect(html, `${l} ${k}`).toContain('https://ax.trina.app/demo')
      }
      expect(renderPage('limit', l, { siteKey: 'k', links, limit: 'hour' })).not.toContain('href="/"')
    }
  })
  test('the limit page says "about an hour" only for the per-hour limit; the day and live-copy limits say tomorrow', () => {
    const links = { scriptedDemo: 'https://ax.trina.app/demo', pricing: 'https://ax.trina.app/pricing' }
    expect(WORDS.en.limitP).toBe('You can start again in about an hour. Meanwhile, you can watch the guided demo.')
    expect(WORDS.en.limitLaterP).toBe('You can start again tomorrow. Meanwhile, you can watch the guided demo.')
    expect(WORDS.ko.limitP).toBe('한 시간쯤 뒤에 다시 시작할 수 있어요. 그동안 안내 데모를 볼 수 있어요.')
    expect(WORDS.ko.limitLaterP).toBe('내일 다시 시작할 수 있어요. 그동안 안내 데모를 볼 수 있어요.')
    for (const l of LOCALES) {
      expect(renderPage('limit', l, { siteKey: 'k', links, limit: 'hour' }), l).toContain(WORDS[l].limitP)
      for (const r of ['day', 'ip_live'] as const) {
        const html = renderPage('limit', l, { siteKey: 'k', links, limit: r })
        expect(html, `${l} ${r}`).toContain(WORDS[l].limitLaterP)
        expect(html, `${l} ${r}`).not.toContain(WORDS[l].limitP)
      }
      expect(WORDS[l].limitLaterP, l).not.toBe(WORDS[l].limitP)
      if (l !== 'en') expect(WORDS[l].limitLaterP, l).not.toBe(WORDS.en.limitLaterP)
    }
    // no reason given: never promise the shorter wait
    expect(renderPage('limit', 'en', { siteKey: 'k', links })).toContain(WORDS.en.limitLaterP)
    // ko says it plainly, no imperative
    expect(WORDS.ko.limitP).not.toContain('보세요')
  })
  test('word-break: keep-all only for Korean (Japanese and Chinese wrap normally)', () => {
    const links = { scriptedDemo: 'https://ax.trina.app/demo', pricing: 'https://ax.trina.app/pricing' }
    const html = renderPage('landing', 'ja', { siteKey: 'k', links })
    expect(html).toContain('html[lang="ko"] h1, html[lang="ko"] main > p')
    expect(html).not.toMatch(/(^|\n)\s*(h1|main > p|\.practice p) \{[^}]*keep-all/)
  })
  test('every page renders in all six languages; links are the configured ones', () => {
    expect(LOCALES).toEqual(['en', 'ko', 'ja', 'zh', 'es', 'id'])
    const keys = Object.keys(WORDS.en).sort()
    for (const l of LOCALES) {
      expect(Object.keys(WORDS[l]).sort(), l).toEqual(keys)
      for (const [k, v] of Object.entries(WORDS[l])) expect(v.trim(), `${l} ${k}`).not.toBe('')
      if (l !== 'en') for (const k of ['landingH', 'sub', 'factQ', 'busyP', 'endedP', 'limitP'] as const) expect(WORDS[l][k], `${l} ${k}`).not.toBe(WORDS.en[k])
    }
    for (const l of LOCALES) for (const k of ['landing', 'busy', 'ended', 'limit', 'check', 'error'] as const) {
      const html = renderPage(k, l, { siteKey: 'k"<', links: { scriptedDemo: 'https://ax.trina.app/demo', pricing: 'https://ax.trina.app/pricing' } })
      expect(html).toContain(`<html lang="${l}">`)
      expect(html).not.toContain('k"<')
      if (k === 'busy') expect(html).toContain('https://ax.trina.app/demo')
      if (k === 'landing' || k === 'ended') expect(html).toContain('action="/__demo/start"')
    }
  })
  test('the landing says up front how much they can ask, in questions, and for how long, in the facts row', () => {
    const links = { scriptedDemo: 'https://ax.trina.app/demo', pricing: 'https://ax.trina.app/pricing' }
    expect(WORDS.en.factQ).toBe('About 8 questions')
    expect(WORDS.ko.factQ).toBe('질문 8번쯤')
    expect(WORDS.en.factHours).toBe('24 hours')
    for (const l of LOCALES) {
      expect(WORDS[l].factQ, l).toContain('8')
      expect(WORDS[l].factHours, l).toContain('24')
      expect(renderPage('landing', l, { siteKey: 'k', links }), l).not.toMatch(/token|토큰|トークン|令牌/i)
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
  test('a listed address (limits.exemptIpHashes) is never refused for the hour or the day; others still are', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdg-state-'))
    try {
      const s = new GateState(dir)
      const office = '203.0.113.7', other = '203.0.113.8'
      const full = s.hash(office)
      expect(full).toMatch(/^[0-9a-f]{32}$/)
      const t0 = Date.now() - 10_000
      for (let i = 0; i < 10; i++) { s.noteStart(office, t0 + i); s.noteStart(other, t0 + i) }
      // the full hash and a short prefix both match; refused without the list
      for (const list of [[full], [full.slice(0, 8)], ['00000000', full.slice(0, 12)]]) {
        expect(s.isExempt(office, list)).toBe(true)
        expect(s.startRefusal(office, 3, 6, t0 + 20, list)).toBeNull()
        expect(s.startRefusal(office, 3, 100, t0 + 20, list)).toBeNull()
        expect(s.startRefusal(other, 3, 6, t0 + 20, list)).toBe('day')
        expect(s.startRefusal(other, 3, 100, t0 + 20, list)).toBe('hour')
      }
      expect(s.startRefusal(office, 3, 6, t0 + 20)).toBe('day')
      expect(s.startRefusal(office, 3, 100, t0 + 20, [])).toBe('hour')
      // a prefix that matches another address's hash does not exempt this one
      expect(s.isExempt(office, [s.hash(other).slice(0, 8)])).toBe(false)
      // an entry shorter than 8 never matches, even if the config check were skipped
      expect(s.isExempt(office, [full.slice(0, 4)])).toBe(false)
      s.flush()
      // the stored key is the hash the config names
      expect(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).starts)).toContain(full)
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
    expect(c.limits).toMatchObject({ startsPerHour: 3, startsPerDay: 6, livePerIp: 2, maxStreams: 4, exemptIpHashes: [], exemptLivePerIp: 6 })
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
    // the sweeper finds an instance's processes by its folder on their command line
    bad({ pool: { ...base.pool, command: ['node', 'x.ts', '--port', '{port}'] } })
    bad({ pool: { ...base.pool, runAs: { uid: 'demo' } } })
    bad({ ai: { credentialFile: 'cred', models: ['claude-sonnet-5-5'], defaultModel: 'claude-opus-4-8' } })
    bad({ ai: { credentialFile: 'cred', models: [] } })
  })
  test('limits.exemptIpHashes: hex keyed hashes or prefixes of at least 8 characters, never a raw address', () => {
    const lim = (limits: Record<string, unknown>) => parseConfig({ ...base, limits }, '/srv').limits
    expect(lim({ exemptIpHashes: ['0123ABCD', 'a'.repeat(32)], exemptLivePerIp: 4 })).toMatchObject({ exemptIpHashes: ['0123abcd', 'a'.repeat(32)], exemptLivePerIp: 4 })
    for (const bad of [['0123abc'], ['203.0.113.7'], ['2001:db8::/64'], ['xyz12345'], ['a'.repeat(33)], [''], [12345678], 'abcdef01']) {
      expect(() => lim({ exemptIpHashes: bad }), JSON.stringify(bad)).toThrow(ConfigError)
    }
    expect(() => lim({ exemptLivePerIp: -1 })).toThrow(ConfigError)
  })
  test('the instance user: never the gate\'s own, unless allowSameUser (tests)', () => {
    const c = (pool: Record<string, unknown>) => parseConfig({ ...base, pool: { ...base.pool, ...pool } }, '/srv')
    expect(instanceUserProblem(c({}), 501)).toMatch(/pool\.runAs .*required/)
    expect(instanceUserProblem(c({ runAs: { uid: 501, gid: 20 } }), 501)).toMatch(/gate's own user/)
    expect(instanceUserProblem(c({ runAs: { uid: 0, gid: 0 } }), 501)).toMatch(/root/)
    expect(instanceUserProblem(c({ runAs: { uid: 502, gid: 20 } }), 501)).toBeNull()
    expect(instanceUserProblem(c({ allowSameUser: true }), 501)).toBeNull()
    expect(c({ runAs: { uid: 502, gid: 20 } }).pool).toMatchObject({ runAs: { uid: 502, gid: 20 }, allowSameUser: false, sudo: '/usr/bin/sudo', diskCapMB: 1024 })
    expect(parseConfig(base, '/srv').limits).toMatchObject({ streamsPerInstance: 2, instanceCapMargin: 1.2 })
    expect(parseConfig(base, '/srv').ai).toMatchObject({ models: [...DEFAULT_MODELS], defaultModel: 'claude-sonnet-5-5' })
  })
  test('the example configs load; the Linux one clones by reflink, runs instances under choom and takes 30', () => {
    const dir = path.join(import.meta.dir, '..')
    // the Linux example names the instance user by placeholder (install.sh writes its ids)
    const read = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace('"<tdrun uid>"', '964').replace('"<tdrun gid>"', '964'))
    expect(fs.readFileSync(path.join(dir, 'gate.example.linux.json'), 'utf8')).toContain('"<tdrun uid>"')
    for (const f of ['gate.example.json', 'gate.example.linux.json']) expect(() => parseConfig(read(f), dir)).not.toThrow()
    const l = parseConfig(read('gate.example.linux.json'), dir)
    expect(l.pool).toMatchObject({ instancesDir: '/srv/tdg/i', snapshotsDir: '/srv/tdg/.snapshots', cloneCommand: ['cp', '--reflink=always', '-R'], maxLive: 30, portRange: [19200, 19399] })
    expect(l.pool.command.slice(0, 4)).toEqual(['/usr/bin/choom', '-n', '800', '--'])
    // each instance in its own bwrap: own pid and IPC namespaces, the instances' file system hidden but for its own
    // folder, no --new-session (the gate keeps its process group)
    const bw = l.pool.command.slice(4, l.pool.command.indexOf('--', 5) + 1)
    expect(bw[0]).toBe('/usr/bin/bwrap')
    expect(bw.join(' ')).toContain('--die-with-parent --unshare-pid --unshare-ipc --unshare-uts --hostname demo --ro-bind / / --tmpfs /srv/tdg --bind {dir} {dir} --tmpfs /run --tmpfs /tmp --tmpfs /dev/shm --dev /dev --proc /proc --')
    expect(bw).not.toContain('--new-session')
    expect(bw).not.toContain('--unshare-net')
    // the abstract-socket scope wraps the server, inside the bwrap
    expect(l.pool.command[l.pool.command.indexOf('/opt/trina-demo/bin/bun') - 1]).toBe('/opt/trina-demo/bin/tdscope')
    // root's files show as the overflow uid in there: the HTML-to-PDF browser check is told so, for the explicit browser
    // inside /opt/trina-demo only
    expect(l.pool.env.MYCEL_SANDBOX_ROOT_UNMAPPED).toBe('/opt/trina-demo')
    expect(l.pool.env.MYCEL_HTML_PDF_BROWSER!.startsWith('/opt/trina-demo/')).toBe(true)
    expect(l.pool.path.split(':')[0]).toBe('/opt/trina-demo/claude/bin')
    expect(l.limits.maxStreams).toBe(12)
    // three ports per instance: 30 live and 2 warm for each of the six languages fit the range
    expect(l.pool.portRange[1] - l.pool.portRange[0] + 1).toBeGreaterThanOrEqual(3 * (l.pool.maxLive + l.pool.warmPerLocale * l.pool.locales.length))
    // at least three ports: one instance's listener, model proxy and the proxy's internal server
    expect(() => parseConfig({ ...base, pool: { ...base.pool, portRange: [20000, 20001] } }, '/srv')).toThrow(ConfigError)
    expect(parseConfig({ ...base, pool: { ...base.pool, portRange: [20000, 20002] } }, '/srv').pool.portRange).toEqual([20000, 20002])
  })
  test('the Linux instance command: exactly the template; the one older command is migrated', () => {
    const now = (JSON.parse(fs.readFileSync(path.join(import.meta.dir, '..', 'gate.example.linux.json'), 'utf8')) as { pool: { command: string[]; instancesDir: string } }).pool
    expect(now.command).toEqual([...LINUX_COMMAND])
    expect(now.instancesDir).toBe(LINUX_INSTANCES_DIR)
    expect(linuxCommandProblems(LINUX_COMMAND)).toEqual([])
    expect(migrateLinuxCommand(LINUX_COMMAND)).toEqual([...LINUX_COMMAND])
    // the only variables are {dir} and {config}
    expect([...new Set(LINUX_COMMAND.filter((x) => x.includes('{')))].sort()).toEqual(['{config}', '{dir}'])
    expect(linuxCommandProblems(LINUX_COMMAND_V1).length).toBe(1)
    expect(migrateLinuxCommand(LINUX_COMMAND_V1)).toEqual([...LINUX_COMMAND])
  })
  test('the Linux instance command: every way around the sandbox is refused and never migrated', () => {
    const c = () => [...LINUX_COMMAND]
    const without = (flag: string, value: string) => { const x = c(); const i = x.findIndex((v, n) => v === flag && x[n + 1] === value); expect(i).toBeGreaterThan(-1); x.splice(i, 2); return x }
    const bypass: Record<string, string[]> = {
      'no --tmpfs /srv/tdg': without('--tmpfs', '/srv/tdg'),
      'no --tmpfs /run': without('--tmpfs', '/run'),
      'no --tmpfs /tmp': without('--tmpfs', '/tmp'),
      'no --tmpfs /dev/shm': without('--tmpfs', '/dev/shm'),
      '--bind / /': c().map((x, i, a) => (x === '--ro-bind' && a[i + 1] === '/' ? '--bind' : x)),
      'a wider bind after the sandbox': (() => { const x = c(); x.splice(x.indexOf('--proc'), 0, '--bind', '/home', '/home'); return x })(),
      '--unshare-uts only as a --setenv value': (() => { const x = c(); x.splice(x.indexOf('--unshare-uts'), 1, '--setenv', 'X', '--unshare-uts'); return x })(),
      'no choom': c().slice(4),
      'choom with another score': c().map((x) => (x === '800' ? '0' : x)),
      'no --unshare-pid': c().filter((x) => x !== '--unshare-pid'),
      'no tdscope': c().filter((x) => x !== LINUX_TDSCOPE),
      'tdscope after bun': (() => { const x = c().filter((v) => v !== LINUX_TDSCOPE); x.splice(x.indexOf(LINUX_BUN) + 1, 0, LINUX_TDSCOPE); return x })(),
      '--new-session': (() => { const x = c(); x.splice(5, 0, '--new-session'); return x })(),
      'a third variable': c().map((x) => (x === '{config}' ? '{port}' : x)),
      'another server': c().map((x) => (x.endsWith('/main.ts') ? '/tmp/main.ts' : x)),
      'an extra argument': [...c(), '--extra'],
    }
    for (const [what, argv] of Object.entries(bypass)) {
      expect(linuxCommandProblems(argv).length, what).toBe(1)
      expect(migrateLinuxCommand(argv), what).toEqual(argv)
    }
  })
  test('how the gate runs things as the instance user', () => {
    const c = parseConfig({ ...base, pool: { ...base.pool, runAs: { uid: 502, gid: 20 } } }, '/srv')
    expect(runMode(c, 501)).toBe('sudo')
    expect(runMode(c, 0)).toBe('root')
    expect(runMode(parseConfig({ ...base, pool: { ...base.pool, allowSameUser: true } }, '/srv'), 501)).toBe('same')
    expect(asInstanceUser(c, 'sudo', ['/bin/rm', '-rf', '--', '/tmp/tdg/ab'])).toEqual({ argv: ['/usr/bin/sudo', '-n', '-u', '#502', '-g', '#20', '--', '/bin/rm', '-rf', '--', '/tmp/tdg/ab'] })
    expect(asInstanceUser(c, 'root', ['/bin/true'])).toEqual({ argv: ['/bin/true'], uid: 502, gid: 20 })
    // sudo drops the environment: env -i sets exactly the instance's, sh enters its folder
    expect(sudoStartArgv(c, '/tmp/tdg/ab', { HOME: '/tmp/tdg/ab', MYCEL_CONFIG: '/tmp/tdg/ab/config/server.json' }, ['/usr/local/bin/bun', 'main.ts'])).toEqual([
      '/usr/bin/sudo', '-n', '-u', '#502', '-g', '#20', '--', '/usr/bin/env', '-i', 'HOME=/tmp/tdg/ab', 'MYCEL_CONFIG=/tmp/tdg/ab/config/server.json',
      '/bin/sh', '-c', 'cd -- "$0" && exec "$@"', '/tmp/tdg/ab', '/usr/local/bin/bun', 'main.ts',
    ])
  })
  test('process groups: below a pid, and only ours by the folder on a command line', () => {
    const table = [
      { pid: 100, ppid: 1, pgid: 100, command: 'sudo -n -u #502 -- env -i … bun main.ts --config /tmp/tdg/ab/config/server.json' },
      { pid: 101, ppid: 100, pgid: 101, command: 'bun main.ts --config /tmp/tdg/ab/config/server.json' },
      { pid: 102, ppid: 101, pgid: 101, command: 'mycel-launcher --agent-root /tmp/tdg/ab/data/agents' },
      { pid: 200, ppid: 1, pgid: 200, command: 'something else' },
    ]
    expect(groupsBelow(100, table).sort()).toEqual([100, 101])
    expect(ownsGroup(101, '/tmp/tdg/ab', table)).toBe(true)
    expect(ownsGroup(200, '/tmp/tdg/ab', table)).toBe(false)
    expect(ownsGroup(101, '/tmp/tdg/cd', table)).toBe(false)
  })
})

describe('visitor address', () => {
  test('IPv6 is grouped by its full /64, whatever the spelling; IPv4-mapped is the IPv4 visitor', () => {
    expect(visitorAddress('203.0.113.7')).toBe('203.0.113.7')
    expect(visitorAddress('2001:db8::1')).toBe('2001:0db8:0000:0000::/64')
    expect(visitorAddress('2001:0DB8:0:0:ffff::2')).toBe('2001:0db8:0000:0000::/64')
    // the compressed form used to give "2001:db8::1::/64" (the first four ':'-parts of a shortened address)
    expect(visitorAddress('2001:db8:5::1')).toBe('2001:0db8:0005:0000::/64')
    expect(visitorAddress('2001:db8:5:0:1::')).toBe('2001:0db8:0005:0000::/64')
    expect(visitorAddress('2001:db8:5:7:1:2:3:4')).toBe('2001:0db8:0005:0007::/64')
    expect(visitorAddress('2001:db8:5:7:1:2:3:4')).not.toBe(visitorAddress('2001:db8:5:8::1'))
    expect(visitorAddress('::1')).toBe('0000:0000:0000:0000::/64')
    expect(visitorAddress('::ffff:198.51.100.4')).toBe('198.51.100.4')
    expect(visitorAddress('::FFFF:c633:6404')).toBe('198.51.100.4')
    expect(visitorAddress('fe80::1%en0')).toBe('fe80:0000:0000:0000::/64')
    expect(visitorAddress('[2001:db8::1]')).toBe('2001:0db8:0000:0000::/64')
    expect(visitorAddress('not an address')).toBe('not an address')
  })
})

describe('model pin', () => {
  test('Sonnet and Haiku ids (dated too) pass; anything else becomes the default Sonnet', () => {
    expect(modelAllowed('claude-sonnet-4-5-20250929', DEFAULT_MODELS)).toBe(true)
    expect(modelAllowed('claude-haiku-4-5', DEFAULT_MODELS)).toBe(true)
    expect(modelAllowed('claude-opus-4-8', DEFAULT_MODELS)).toBe(false)
    expect(modelAllowed('claude-sonnet-5-5-x', DEFAULT_MODELS)).toBe(false)
    expect(modelAllowed(42, DEFAULT_MODELS)).toBe(false)
    const b = (o: unknown) => Buffer.from(JSON.stringify(o))
    const same = b({ model: 'claude-haiku-5-5', max_tokens: 1 })
    expect(pinModel(same, DEFAULT_MODELS, 'claude-sonnet-5-5')).toEqual({ body: same, was: null })
    const p = pinModel(b({ model: 'claude-opus-5-5', max_tokens: 1 }), DEFAULT_MODELS, 'claude-sonnet-5-5')
    expect(p.was).toBe('claude-opus-5-5')
    expect(JSON.parse(p.body.toString())).toEqual({ model: 'claude-sonnet-5-5', max_tokens: 1 })
    const junk = Buffer.from('not json')
    expect(pinModel(junk, DEFAULT_MODELS, 'claude-sonnet-5-5').body).toBe(junk)
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

describe('Cache-Control no-transform', () => {
  test('added, merged with what is there, never doubled', () => {
    expect(withNoTransform(undefined)).toBe('no-transform')
    expect(withNoTransform('')).toBe('no-transform')
    expect(withNoTransform('no-store')).toBe('no-store, no-transform')
    expect(withNoTransform('private,max-age=60')).toBe('private, max-age=60, no-transform')
    expect(withNoTransform(['no-cache', 'must-revalidate'])).toBe('no-cache, must-revalidate, no-transform')
    expect(withNoTransform('No-Transform, max-age=5')).toBe('No-Transform, max-age=5')
  })
})

describe('daily stats (stats.ts)', () => {
  const DAY = 24 * 3600_000
  test('duration buckets: edges', () => {
    const m = 60_000
    expect(durationBucket(-5)).toBe('dur.lt2m')
    expect(durationBucket(0)).toBe('dur.lt2m')
    expect(durationBucket(2 * m - 1)).toBe('dur.lt2m')
    expect(durationBucket(2 * m)).toBe('dur.2to10m')
    expect(durationBucket(10 * m - 1)).toBe('dur.2to10m')
    expect(durationBucket(10 * m)).toBe('dur.10to30m')
    expect(durationBucket(30 * m)).toBe('dur.30to60m')
    expect(durationBucket(60 * m - 1)).toBe('dur.30to60m')
    expect(durationBucket(60 * m)).toBe('dur.60mPlus')
    expect(durationBucket(10 * 60 * m)).toBe('dur.60mPlus')
  })
  test('counts per UTC day and locale; the day rolls over at UTC midnight; unknown locale is "-"', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdg-stats-'))
    try {
      const s = new GateStats(dir)
      const late = Date.parse('2026-11-20T23:59:59.000Z')
      s.bump('en', 'starts', 1, late)
      s.bump('en', 'starts', 1, late)
      s.bump('ko', 'questions', 1, late)
      s.bump('xx', 'startFree', 1, late)
      s.bump(undefined, 'landing', 1, late)
      s.bump('en', 'tokens', 0, late) // nothing for zero
      s.duration('en', 5 * 60_000, late)
      s.bump('en', 'starts', 1, late + 1000)
      const r = s.read(30, late + 1000)
      expect(r).toEqual({
        '2026-11-20': { en: { starts: 2, 'dur.2to10m': 1 }, ko: { questions: 1 }, '-': { startFree: 1, landing: 1 } },
        '2026-11-21': { en: { starts: 1 } },
      })
      expect(Object.keys(s.read(1, late + 1000))).toEqual(['2026-11-21'])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
  test('saved (0600) and read back; days older than 400 are dropped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdg-stats-'))
    try {
      const now = Date.now()
      const s = new GateStats(dir)
      s.bump('en', 'starts', 3, now)
      s.bump('en', 'starts', 1, now - (KEEP_DAYS + 5) * DAY)
      s.bump('ko', 'landing', 1, now - (KEEP_DAYS - 2) * DAY)
      s.flush(now)
      const file = path.join(dir, 'stats.json')
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
      const s2 = new GateStats(dir)
      const all = s2.read(KEEP_DAYS, now)
      expect(Object.keys(all).length).toBe(2)
      expect(all[new Date(now).toISOString().slice(0, 10)]).toEqual({ en: { starts: 3 } })
      expect(JSON.stringify(all)).not.toContain(new Date(now - (KEEP_DAYS + 5) * DAY).toISOString().slice(0, 10))
      // a broken file is no crash: the gate starts with empty stats
      fs.writeFileSync(file, '{not json')
      expect(new GateStats(dir).read(30, now)).toEqual({})
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
  test('distinct starters in the last 24 hours come from the start hashes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdg-state-'))
    try {
      const s = new GateState(dir)
      const now = Date.now()
      s.noteStart('203.0.113.1', now - 2 * DAY)
      s.noteStart('203.0.113.2', now - 1000)
      s.noteStart('203.0.113.2', now - 500)
      s.noteStart('203.0.113.3', now - 100)
      expect(s.distinctStarters(now)).toBe(2)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
