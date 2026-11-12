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
  ['https://acme.trina.app입니다', acme()],
  ['https://acme.trina.app입니다.', acme()],
  ['https://acme.trina.app이에요!', acme()],
  ['https://acme.bücher.de.', other('acme.xn--bcher-kva.de')],
  ['주소:https://acme.trina.app입니다', acme()],
  ['https://team.example.com이에요', other('team.example.com')],
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
  test('no jump on a signed-in open: off the sign-in pages the line waits for /api/me, or a moment (300 ms in the apps)', () => {
    for (const m of [shared, phone]) {
      const at = (path: string, signedIn: boolean, answered: boolean, waited: boolean) => m.hostLineNow({ path, signedIn, answered, waited })
      expect(at('/login', false, false, false)).toBe(true) // a sign-in page: at once
      expect(at('/invite/abc', false, false, false)).toBe(true)
      expect(at('/', false, false, false)).toBe(false) // not yet: /api/me may still say someone is signed in
      expect(at('/', false, false, true)).toBe(true) // no answer in time: shown
      expect(at('/', false, true, false)).toBe(true) // signed out: shown
      expect(at('/signin', false, true, true)).toBe(true)
      expect(at('/', true, true, false)).toBe(false) // signed in: never shown off the sign-in pages
      expect(at('/', true, true, true)).toBe(false)
      expect(at('/login', true, true, true)).toBe(true)
    }
  })
  test('this machine, also written as an IPv4-mapped or unspecified address, is loopback (the desktop refuses it in links)', () => {
    for (const m of [shared, phone]) {
      for (const h of ['localhost', 'acme.localhost', '127.0.0.1', '127.1.2.3', '[::1]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::7f00:1]', '[::]', '0.0.0.0', '0', '[::ffff:0:0]'])
        expect({ h, loopback: m.isLoopbackHost(h) }).toEqual({ h, loopback: true })
      for (const h of ['localhost.evil.example', '1.2.3.4', '[::ffff:c0a8:1]', '[::ffff:808:808]', '[2001:db8::1]', '[::2]', 'acme.trina.app'])
        expect({ h, loopback: m.isLoopbackHost(h) }).toEqual({ h, loopback: false })
      // as the URL parser writes them in a link
      for (const inner of ['https://[::ffff:127.0.0.1]/', 'https://[::]/', 'https://0.0.0.0/', 'https://0/'])
        expect({ inner, r: m.parseTeamInput(inner, PHONE) }).toMatchObject({ inner, r: { ok: true, loopback: true, hosted: false } })
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

describe('links from outside (phase 2): the reader and screen ④\'s gate', () => {
  const enc = encodeURIComponent
  const link = (inner: string) => `trina-ax://open?url=${enc(inner)}`
  const DESK = { ...DESKTOP, scheme: 'trina-ax', universal: false }
  const PHONE_LINKS = { ...PHONE, scheme: 'trina-ax', universal: true }
  test('the scheme link: the team link or invite link inside, with its page', () => {
    for (const m of [shared, phone]) for (const o of [DESK, PHONE_LINKS]) {
      expect(m.readAppLink(link(`https://acme.trina.app/join#t=${JOIN}`), o)).toEqual(acme(`/join#t=${JOIN}`) as never)
      expect(m.readAppLink(link(`https://acme.trina.app/invite/${INVITE}`), o)).toEqual(acme(`/invite/${INVITE}`) as never)
      expect(m.readAppLink(`TRINA-AX://open/?url=${enc('https://acme.trina.app')}`, o)).toEqual(acme() as never)
    }
  })
  test('a crafted link cannot load http to another machine, javascript:, file:, data:, user:password', () => {
    for (const m of [shared, phone]) for (const o of [DESK, PHONE_LINKS]) {
      expect(m.readAppLink(link('http://evil.example/invite/K-PTTVic_Q_pfdW4-06s4zsJJlKEInlO2rHLV9HryGk'), o)).toEqual(err('insecure') as never)
      expect(m.readAppLink(link('https://trina.app@evil.example'), o)).toEqual(err('credentials') as never)
      for (const inner of ['javascript:alert(1)', 'JavaScript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'vbscript:x', '//evil.example', 'acme', 'https://a b'])
        expect(m.readAppLink(link(inner), o)).toBeNull()
      for (const raw of ['trina-ax://evil?url=' + enc('https://acme.trina.app'), 'trina-ax://open?url=a&url=b', `trina-ax://open?url=${enc('https://acme.trina.app')}&then=x`, `trina-ax://open?url=${enc('https://acme.trina.app')}#x`,
        `trina-ax://u:p@open?url=${enc('https://acme.trina.app')}`, `trina-ax://open:1?url=${enc('https://acme.trina.app')}`, `trina-ax:open?url=${enc('https://acme.trina.app')}`, `trina-ax://open/x?url=${enc('https://acme.trina.app')}`,
        `teamax-mobile://open?url=${enc('https://acme.trina.app')}`, ` trina-ax://open?url=${enc('https://acme.trina.app')}`, `trina-ax://open?url=${'a'.repeat(5000)}`])
        expect(m.readAppLink(raw, o)).toBeNull()
    }
  })
  test('an IP-literal or look-alike host shows as what the app would connect to, never as hosted', () => {
    for (const m of [shared, phone]) {
      for (const inner of ['https://0x7f.1/', 'https://2130706433/', 'https://127.1/', 'https://[::ffff:7f00:1]/']) {
        const r = m.readAppLink(link(inner), DESK) as { ok: boolean; host: string; hosted: boolean }
        expect({ inner, ok: r.ok, hosted: r.hosted, numeric: /^(127\.0\.0\.1|\[::ffff:7f00:1\])$/.test(r.host) }).toEqual({ inner, ok: true, hosted: false, numeric: true })
      }
      expect(m.readAppLink(link('https://evil.example\\@acme.trina.app'), DESK)).toMatchObject({ ok: true, host: 'evil.example', hosted: false })
      expect(m.readAppLink(link('https://acme.trina.app.evil.example/join#t=' + JOIN), DESK)).toMatchObject({ ok: true, host: 'acme.trina.app.evil.example', hosted: false })
      expect(m.readAppLink(link('https://bücher.de/'), DESK)).toMatchObject({ host: 'xn--bcher-kva.de', hosted: false })
    }
  })
  test('a universal link / app link: only a hosted team\'s invite or team link, only on the phone', () => {
    for (const m of [shared, phone]) {
      expect(m.readAppLink(`https://acme.trina.app/join#t=${JOIN}`, PHONE_LINKS)).toEqual(acme(`/join#t=${JOIN}`) as never)
      expect(m.readAppLink(`https://acme.trina.app/invite/${INVITE}`, PHONE_LINKS)).toEqual(acme(`/invite/${INVITE}`) as never)
      for (const raw of ['https://acme.trina.app/', 'https://acme.trina.app/chats/1', `https://team.example.com/join#t=${JOIN}`, `https://acme.trina.app.evil.example/invite/${INVITE}`, `http://acme.trina.app/invite/${INVITE}`])
        expect(m.readAppLink(raw, PHONE_LINKS)).toBeNull()
      expect(m.readAppLink(`https://acme.trina.app/join#t=${JOIN}`, DESK)).toBeNull()
    }
  })
  test('④ cannot be skipped: nothing without a yes, a yes for the host it showed, only once ④ has been on screen a while, once', () => {
    for (const m of [shared, phone]) {
      const g = new m.LinkGate(600)
      const a = m.readAppLink(link(`https://acme.trina.app/join#t=${JOIN}`), DESK) as never
      const evil = m.readAppLink(link('https://evil.example/'), DESK) as never
      expect(g.answer(true, 'acme.trina.app', 10_000)).toBeNull() // nothing offered
      const first = g.put(a)
      expect(first).toMatchObject({ origin: 'https://acme.trina.app', host: 'acme.trina.app', entryPath: `/join#t=${JOIN}`, hosted: true, name: 'acme' })
      expect(g.pending()?.host).toBe('acme.trina.app')
      // not on screen yet (a cold start still loading): no yes counts, however late
      expect(g.answer(true, 'acme.trina.app', 99_000)).toBeNull()
      g.shown(first.id, 100_000)
      g.shown(first.id, 200_000) // the first display counts
      expect(g.answer(true, 'acme.trina.app', 100_200)).toBeNull() // too soon after ④ appeared
      expect(g.answer(true, 'evil.example', 101_000)).toBeNull() // not the host ④ showed
      // a second link arrived while ④ was up: the yes meant for the first one does not confirm it
      const second = g.put(evil)
      expect(second.id).not.toBe(first.id)
      g.shown(first.id, 101_100) // an old screen's report does not count for the new offer
      expect(g.answer(true, 'evil.example', 102_000)).toBeNull()
      g.shown(second.id, 102_000)
      expect(g.answer(true, 'acme.trina.app', 103_000)).toBeNull()
      expect(g.answer(true, 'evil.example', 102_300)).toBeNull()
      expect(g.answer(true, 'evil.example', 102_700)).toMatchObject({ host: 'evil.example', id: second.id })
      expect(g.answer(true, 'evil.example', 109_000)).toBeNull() // used once
      // the person went elsewhere: the offer is gone
      const third = g.put(a); g.shown(third.id, 110_000); g.clear()
      expect(g.answer(true, 'acme.trina.app', 111_000)).toBeNull()
      g.put(a)
      expect(g.answer(false, 'acme.trina.app', 120_001)).toBeNull()
      expect(g.pending()).toBeNull()
    }
  })
  test('④ after a connect that could not reach the team: the same link once more, only for its host, gone after no / another link / clear', () => {
    for (const m of [shared, phone]) {
      const g = new m.LinkGate(600)
      const a = m.readAppLink(link(`https://acme.trina.app/join#t=${JOIN}`), DESK) as never
      const evil = m.readAppLink(link('https://evil.example/'), DESK) as never
      expect(g.retry('acme.trina.app')).toBeNull() // nothing confirmed yet
      const o = g.put(a); g.shown(o.id, 1_000)
      expect(g.retry('acme.trina.app')).toBeNull() // offered, but no yes yet
      const yes = g.answer(true, 'acme.trina.app', 2_000)
      expect(g.retry('acme.trina.app')).toEqual(yes)
      expect(g.retry('acme.trina.app')).toEqual(yes) // Try again may be pressed more than once
      expect(g.retry('evil.example')).toBeNull()
      g.answer(false, 'acme.trina.app', 3_000) // Cancel after the failed connect
      expect(g.retry('acme.trina.app')).toBeNull()
      const o2 = g.put(a); g.shown(o2.id, 4_000); g.answer(true, 'acme.trina.app', 5_000)
      g.put(evil) // another link came in
      expect(g.retry('acme.trina.app')).toBeNull()
      const o3 = g.put(a); g.shown(o3.id, 6_000); g.answer(true, 'acme.trina.app', 7_000); g.clear()
      expect(g.retry('acme.trina.app')).toBeNull()
    }
  })
  test('a tapped universal link that was cut off says so; text around the address inside a scheme link is refused', () => {
    for (const m of [shared, phone]) {
      expect(m.readAppLink('https://acme.trina.app/invite/abc', PHONE_LINKS)).toEqual(err('link') as never)
      expect(m.readAppLink('https://acme.trina.app/join', PHONE_LINKS)).toEqual(err('link') as never)
      expect(m.readAppLink('https://team.example.com/invite/abc', PHONE_LINKS)).toBeNull()
      expect(m.readAppLink(link(`https://x.example'https://acme.trina.app/invite/${INVITE}`), DESK)).toBeNull()
      expect(m.readAppLink(link(`x.https://acme.trina.app/invite/${INVITE}`), DESK)).toBeNull()
    }
  })
})
