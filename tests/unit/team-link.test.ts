// The first-run box's reader (shared/src/team-link.ts), one table for the desktop app and the phone app: the phone
// app's copy (mobile/src/team-link.ts) must be the same file, and every row runs against both.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import * as shared from '../../shared/src/team-link'
import * as phone from '../../mobile/src/team-link'

const ROOT = path.join(import.meta.dir, '../..')
const DESKTOP = { teamDomain: 'trina.app', loopbackHttp: true }
const PHONE = { teamDomain: 'trina.app', loopbackHttp: false }
const JOIN = '0INpvAqjFG3OhdmwH4CfCuxr-mz7rx3dLOr1tEwbB7E'
const INVITE = 'K-PTTVic_Q_pfdW4-06s4zsJJlKEInlO2rHLV9HryGk'
const acme = (entryPath = '/') => ({ ok: true, origin: 'https://acme.trina.app', host: 'acme.trina.app', name: 'acme', hosted: true, loopback: false, entryPath })
const other = (host: string, entryPath = '/') => ({ ok: true, origin: `https://${host}`, host, name: null, hosted: false, loopback: false, entryPath })
const err = (error: string) => ({ ok: false, error })

/** [what was typed or pasted, desktop result, phone result (when it differs)] */
const TABLE: [string, unknown, unknown?][] = [
  // a bare name: the hosted team address (the check happens on the button, never on another domain)
  ['acme', acme()],
  ['  ACME  ', acme()],
  ['acme-corp', { ...acme(), origin: 'https://acme-corp.trina.app', host: 'acme-corp.trina.app', name: 'acme-corp' }],
  // full addresses, with or without https://; a page that is not a link opens the team's start
  ['acme.trina.app', acme()],
  ['https://acme.trina.app/', acme()],
  ['HTTPS://ACME.TRINA.APP', acme()],
  ['acme.trina.app/chats/1', acme()],
  ['https://acme.trina.app/login?next=/rooms', acme()],
  ['team.example.com', other('team.example.com')],
  ['https://team.example.com:8443', other('team.example.com:8443')],
  // an invite link and a team link keep their page (the fragment of the team link too)
  [`https://acme.trina.app/invite/${INVITE}`, acme(`/invite/${INVITE}`)],
  [`acme.trina.app/invite/${INVITE}`, acme(`/invite/${INVITE}`)],
  [`https://acme.trina.app/join#t=${JOIN}`, acme(`/join#t=${JOIN}`)],
  [`acme.trina.app/join#t=${JOIN}`, acme(`/join#t=${JOIN}`)],
  [`https://team.example.com/join#t=${JOIN}`, other('team.example.com', `/join#t=${JOIN}`)],
  // a whole message pasted from KakaoTalk or Slack: the first invite or team link in it
  [`홍길동님이 함께 일하자고 초대했어요. 링크로 바로 들어올 수 있어요: https://acme.trina.app/join#t=${JOIN}`, acme(`/join#t=${JOIN}`)],
  [`초대 링크예요\nhttps://acme.trina.app/invite/${INVITE}\n7일 동안 쓸 수 있어요.`, acme(`/invite/${INVITE}`)],
  [`(https://acme.trina.app/invite/${INVITE}).`, acme(`/invite/${INVITE}`)],
  [`링크:https://acme.trina.app/invite/${INVITE}입니다`, acme(`/invite/${INVITE}`)],
  [`see https://example.org/blog and https://acme.trina.app/join#t=${JOIN}`, acme(`/join#t=${JOIN}`)],
  ['우리 팀 주소는 https://acme.trina.app 이에요', acme()],
  // a word, punctuation or an invisible character glued right after the link (no space in between)
  [`https://acme.trina.app/invite/${INVITE}입니다`, acme(`/invite/${INVITE}`)],
  [`https://acme.trina.app/join#t=${JOIN}입니다`, acme(`/join#t=${JOIN}`)],
  [`https://acme.trina.app/invite/${INVITE}.`, acme(`/invite/${INVITE}`)],
  [`https://acme.trina.app/invite/${INVITE})`, acme(`/invite/${INVITE}`)],
  [`https://acme.trina.app/invite/${INVITE}」`, acme(`/invite/${INVITE}`)],
  [`https://acme.trina.app/invite/${INVITE}\u200b`, acme(`/invite/${INVITE}`)],
  [`\ufeffhttps://acme.trina.app/join#t=${JOIN}\u200b`, acme(`/join#t=${JOIN}`)],
  [`acme.trina.app/invite/${INVITE},`, acme(`/invite/${INVITE}`)],
  ['acme.', acme()],
  // fullwidth letters (an IME's full-width mode) read as ASCII; the path in any letter case
  ['ｈｔｔｐｓ：／／ａｃｍｅ．ｔｒｉｎａ．ａｐｐ', acme()],
  ['ａｃｍｅ', acme()],
  [`https://acme.trina.app/INVITE/${INVITE}`, acme(`/invite/${INVITE}`)],
  [`https://acme.trina.app/Join#t=${JOIN}`, acme(`/join#t=${JOIN}`)],
  // hints
  ['ㅁ츼', err('hangul')],
  ['트리나', err('hangul')],
  ['우리 팀', err('hangul')],
  ['https://한글.com', err('hangul')],
  ['someone@acme.com', err('email')],
  ['', err('empty')],
  ['   ', err('empty')],
  // a cut-off link says so instead of opening the sign-in page
  ['https://acme.trina.app/invite/', err('link')],
  ['https://acme.trina.app/invite/abc', err('link')],
  ['https://acme.trina.app/join', err('link')],
  ['https://acme.trina.app/join#t=short', err('link')],
  // tokens are 43 characters: a link cut part-way says so too
  [`https://acme.trina.app/invite/${INVITE.slice(0, 20)}`, err('link')],
  [`https://acme.trina.app/join#t=${JOIN.slice(0, 30)}`, err('link')],
  [`https://acme.trina.app/invite/${INVITE}?x=1`, err('link')],
  // safety: https only (http to this machine only on the desktop), no user:password, no other scheme
  ['http://acme.trina.app', err('insecure')],
  ['http://192.168.0.10:8443', err('insecure')],
  ['https://trina.app@evil.example', err('credentials')],
  ['https://user:pw@acme.trina.app', err('credentials')],
  ['javascript:alert(1)', err('unsupported_scheme')],
  ['file:///etc/passwd', err('unsupported_scheme')],
  ['ftp://acme.trina.app', err('unsupported_scheme')],
  ['data:text/html,hi', err('unsupported_scheme')],
  ['https://', err('invalid')],
  ['acme team', err('invalid')],
  ['localhost:19100', { ok: true, origin: 'http://localhost:19100', host: 'localhost:19100', name: null, hosted: false, loopback: true, entryPath: '/' }, { ok: true, origin: 'https://localhost:19100', host: 'localhost:19100', name: null, hosted: false, loopback: true, entryPath: '/' }],
  ['http://acme.localhost:19883', { ok: true, origin: 'http://acme.localhost:19883', host: 'acme.localhost:19883', name: 'acme', hosted: false, loopback: true, entryPath: '/' }, err('insecure')],
  // look-alikes are not hosted (the apps ask before connecting to them)
  ['https://acme.trina.app.evil.example', other('acme.trina.app.evil.example')],
  ['https://acmetrina.app', other('acmetrina.app')],
  ['https://1.2.3.4', other('1.2.3.4')],
  // shown as punycode, never Unicode
  ['https://bücher.de', other('xn--bcher-kva.de')],
]

describe('the first-run box (one table, desktop and phone)', () => {
  test('the phone app\'s copy is the same file', () => {
    expect(fs.readFileSync(path.join(ROOT, 'mobile/src/team-link.ts'), 'utf8')).toBe(fs.readFileSync(path.join(ROOT, 'shared/src/team-link.ts'), 'utf8'))
  })
  for (const [input, desktop, mobile] of TABLE) {
    test(JSON.stringify(input).slice(0, 70), () => {
      for (const m of [shared, phone]) {
        expect(m.parseTeamInput(input, DESKTOP)).toEqual(desktop as never)
        expect(m.parseTeamInput(input, PHONE)).toEqual((mobile ?? desktop) as never)
      }
    })
  }
  test('without a team domain (a build with no hosted service) a bare name is not an address', () => {
    expect(shared.parseTeamInput('acme', { teamDomain: null, loopbackHttp: false })).toEqual(err('invalid') as never)
    expect(shared.parseTeamInput('team.example.com', { teamDomain: null, loopbackHttp: false })).toMatchObject({ ok: true, hosted: false })
  })
  test('very long input is refused without work; punctuation after a link is trimmed in linear time', () => {
    expect(shared.parseTeamInput('a'.repeat(9000), DESKTOP)).toEqual(err('invalid') as never)
    const t0 = performance.now()
    expect(shared.parseTeamInput(`see https://acme.trina.app${'.'.repeat(8000)}`, DESKTOP)).toEqual(acme() as never)
    expect(performance.now() - t0).toBeLessThan(50)
  })
})

describe('where the apps show the team address', () => {
  test('the sign-in pages in any letter case, and every page until the team said someone is signed in', () => {
    for (const m of [shared, phone]) {
      for (const p of ['/login', '/LOGIN', '/join', '/join/', '/setup', '/invite/abc', '/Invite/abc', '/reset-password/abc']) expect(m.isSignInPath(p)).toBe(true)
      for (const p of ['/', '/signin', '/chats/1', '/invite', '/joined', '/login/x', '']) expect(m.isSignInPath(p)).toBe(false)
      // a fake sign-in page at "/" or "/signin" still gets the address until /api/me answers for a signed-in person
      for (const p of ['/', '/signin', '/login']) expect(m.hostLineShown(p, false)).toBe(true)
      expect(m.hostLineShown('/', true)).toBe(false)
      expect(m.hostLineShown('/login', true)).toBe(true)
    }
  })
})

describe('what the relay answered', () => {
  test('x-relay-error: unknown name, suspended team, offline team; anything else is not the relay', () => {
    for (const m of [shared, phone]) {
      expect(m.relayAnswer(404, 'team_unknown')).toBe('unknown')
      expect(m.relayAnswer(403, 'team_suspended')).toBe('suspended')
      expect(m.relayAnswer(403, 'team_suspended_billing')).toBe('suspended')
      for (const k of ['team_offline', 'team_offline_cloud', 'team_busy', 'team_maintenance', 'team_timeout', 'team_connection_lost', 'bad_gateway']) expect(m.relayAnswer(503, k)).toBe('offline')
      expect(m.relayAnswer(404, null)).toBeNull()
      expect(m.relayAnswer(404, 'not_found')).toBeNull()
      expect(m.relayAnswer(200, 'team_unknown')).toBeNull()
    }
  })
  test('a rename is followed only to another name under the same team domain, scheme and port', () => {
    for (const m of [shared, phone]) {
      expect(m.relayRename('https://acme.trina.app', 'https://acme-corp.trina.app/api/health', PHONE)).toBe('https://acme-corp.trina.app')
      expect(m.relayRename('https://acme.trina.app', '/api/health', PHONE)).toBeNull()
      for (const away of ['https://evil.example/api/health', 'http://acme-corp.trina.app/', 'https://acme-corp.trina.app:444/', 'https://x.acme.trina.app/', 'https://u@acme-corp.trina.app/', 'https://trina.app/', 'https://acme-corp.trina.app./api/health', 'javascript:alert(1)', null])
        expect(m.relayRename('https://acme.trina.app', away, PHONE)).toBeNull()
      // from an address that is not a hosted one, nothing is followed
      expect(m.relayRename('https://team.example.com', 'https://acme.trina.app/', PHONE)).toBeNull()
      // the development relay (*.localhost) only where http to this machine is allowed
      expect(m.relayRename('http://acme.localhost:19883', 'http://acme-co.localhost:19883/api/health', DESKTOP)).toBe('http://acme-co.localhost:19883')
      expect(m.relayRename('http://acme.localhost:19883', 'http://acme-co.localhost:19883/api/health', PHONE)).toBeNull()
    }
  })
})
