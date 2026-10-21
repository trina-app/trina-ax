// Relay-side helpers from the review: every page the relay answers with exists in ko / en / id with the right status,
// Set-Cookie from a team server is made host-only, and the registration rate-limit table stays bounded.
import { describe, expect, test } from 'bun:test'
import type http from 'node:http'
import { PAGE_STATUS, htmlPage, pageMessage, pickLang, type PageKind } from '../../relay/src/pages.ts'
import { hostOnlyCookie } from '../../relay/src/relay.ts'
import { startRelay } from '../lib/f-relay'

describe('relay pages', () => {
  test('every kind has a title in every language and a status', () => {
    const kinds = Object.keys(PAGE_STATUS) as PageKind[]
    expect(kinds).toContain('bad_request')
    expect(kinds).toContain('request_timeout')
    for (const k of kinds) {
      for (const lang of ['ko', 'en', 'id'] as const) {
        expect(pageMessage(k, lang).length).toBeGreaterThan(2)
        expect(htmlPage(k, lang)).toContain(`lang="${lang}"`)
      }
    }
    expect(PAGE_STATUS.bad_request).toBe(400)
    expect(PAGE_STATUS.request_timeout).toBe(408)
    expect(pageMessage('team_offline', 'ko', 5 * 60_000)).toContain('5분째')
  })

  test("language the team's page last showed (cookie / X-Mycel-Locale), English by default; never the browser's", () => {
    expect(pickLang({})).toBe('en')
    expect(pickLang({ 'accept-language': 'ko-KR,ko;q=0.9' } as never)).toBe('en')
    expect(pickLang({ cookie: 'a=b; mycel_locale=ko; c=d' })).toBe('ko')
    expect(pickLang({ cookie: 'mycel_locale=fr' })).toBe('en')
    expect(pickLang({ 'x-mycel-locale': 'id', cookie: 'mycel_locale=ko' })).toBe('id')
  })
})

describe('hostOnlyCookie', () => {
  test('drops Domain attributes in any case and spacing, keeps everything else', () => {
    expect(hostOnlyCookie('sid=1; Path=/; Domain=treesoop.com; HttpOnly; Secure')).toBe('sid=1; Path=/; HttpOnly; Secure')
    expect(hostOnlyCookie('a=b;domain=.treesoop.com')).toBe('a=b')
    expect(hostOnlyCookie('a=b; DOMAIN = x.y ; Path=/')).toBe('a=b; Path=/')
    // a cookie whose value mentions domain= is left alone
    expect(hostOnlyCookie('domain=x; Path=/')).toBe('domain=x; Path=/')
    expect(hostOnlyCookie('__Host-sid=abc; Path=/; Secure; HttpOnly; SameSite=Lax')).toBe('__Host-sid=abc; Path=/; Secure; HttpOnly; SameSite=Lax')
  })
})

describe('registration rate limit', () => {
  test('the per-IP table is bounded (a flood from many addresses can not grow it without limit)', async () => {
    const R = await startRelay(19164, { RELAY_REGISTER_PER_IP: '2' })
    try {
      const req = (ip: string) => ({ headers: {}, socket: { remoteAddress: ip } }) as unknown as http.IncomingMessage
      expect(R.relay.allowRegistration(req('10.0.0.1'))).toBe(true)
      expect(R.relay.allowRegistration(req('10.0.0.1'))).toBe(true)
      expect(R.relay.allowRegistration(req('10.0.0.1'))).toBe(false)
      for (let i = 0; i < 60_000; i++) R.relay.allowRegistration(req(`2001:db8::${i.toString(16)}`))
      expect((R.relay as unknown as { registerHits: Map<string, number[]> }).registerHits.size).toBeLessThanOrEqual(50_000)
    } finally {
      await R.stop()
    }
  })
})
