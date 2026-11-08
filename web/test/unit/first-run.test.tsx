// First run (docs/AGENTS/plan/20261108-0930-first-run-one-box.md), the web's part: Settings › 앱 shows the team's address
// for a new device (from GET /api/me team.address, punycode, never the page's own host) with a copy button; a used or
// expired invite or team link leads with "이미 가입했다면 로그인하세요" and a real sign-in button; both join forms end
// with "이미 가입했어요? 로그인".
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { DICTS, LOCALES, translate, useLocaleStore } from '../../src/i18n'
import { teamAddressHost } from '../../src/lib/team-address'
import { TeamAddressRow } from '../../src/pages/Settings'
import { AcceptInvite, TeamJoin } from '../../src/pages/Auth'
import { installDom, mount, removeDom } from './dom-host'

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde'
const ko = (k: Parameters<typeof translate>[1]) => translate('ko', k)

describe('the team address', () => {
  test('the host as the URL API gives it: punycode, the port kept; nothing for junk, credentials or other schemes', () => {
    expect(teamAddressHost('https://acme.trina.app')).toBe('acme.trina.app')
    expect(teamAddressHost('http://demo.localhost:19161')).toBe('demo.localhost:19161')
    expect(teamAddressHost('https://팀.example.com')).toBe('xn--x87b.example.com')
    expect(teamAddressHost('https://аcme.example.com')).toMatch(/^xn--/) // a Cyrillic "а" never reads as acme
    for (const bad of [undefined, null, '', 'acme', 'ftp://acme.trina.app', 'https://u:p@acme.trina.app', 'javascript:alert(1)']) expect(teamAddressHost(bad)).toBeNull()
  })

  test('every new text is in all five languages, Korean only in Korean', () => {
    for (const k of ['apps.teamAddress', 'apps.teamAddressHint', 'auth.alreadyJoined', 'auth.haveAccount'] as const) {
      for (const { id } of LOCALES) {
        const v = DICTS[id][k]
        expect({ id, k, ok: typeof v === 'string' && v.length > 0 && (id === 'ko' || !/[가-힣]/.test(v)) }).toEqual({ id, k, ok: true })
      }
    }
    expect(ko('apps.teamAddressHint')).toBe('새 기기에서 앱을 열고 이 주소를 넣으세요.')
    expect(ko('auth.haveAccount')).toBe('이미 가입했어요?')
    expect(ko('auth.alreadyJoined')).toBe('이미 가입했다면 로그인하세요.')
  })
})

describe('on screen', () => {
  const realFetch = globalThis.fetch
  const before = useLocaleStore.getState().locale
  let routes: Record<string, () => Response> = {}
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const g = globalThis as Record<string, unknown>
  const was = { location: Object.getOwnPropertyDescriptor(g, 'location'), history: Object.getOwnPropertyDescriptor(g, 'history'), navigator: Object.getOwnPropertyDescriptor(g, 'navigator') }
  beforeAll(() => {
    installDom()
    useLocaleStore.setState({ locale: 'ko' })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
      return routes[key]?.() ?? json(500, { error: { code: 'internal', message: `no route ${key}` } })
    }) as unknown as typeof fetch
    Object.defineProperty(g, 'history', { configurable: true, writable: true, value: { state: null, replaceState: () => {} } })
  })
  afterAll(() => {
    globalThis.fetch = realFetch
    for (const [k, d] of Object.entries(was)) { if (d) Object.defineProperty(g, k, d); else delete g[k] }
    removeDom()
    useLocaleStore.setState({ locale: before })
  })

  test('Settings › 앱: the host and a copy button that copies the whole address; no address known, no row', async () => {
    const copied: string[] = []
    Object.defineProperty(g, 'navigator', { configurable: true, writable: true, value: { userAgent: 'test', clipboard: { writeText: async (s: string) => { copied.push(s) } } } })
    Object.defineProperty(g, 'location', { configurable: true, writable: true, value: { host: '192.168.0.10:8443', origin: 'https://192.168.0.10:8443', pathname: '/settings/apps', search: '', hash: '' } })
    const m = await mount(<TeamAddressRow address="https://acme.trina.app" />)
    try {
      expect(m.get('apps-team-address-host').textContent).toBe('acme.trina.app')
      expect(m.html()).toContain(ko('apps.teamAddress'))
      expect(m.html()).toContain(ko('apps.teamAddressHint'))
      // the page's own host (the office network here) is never shown
      expect(m.html()).not.toContain('192.168.0.10')
      const button = m.get('apps-team-address').querySelectorAll('button')[0]!
      expect(button.textContent).toBe(ko('common.copy'))
      await m.click(button)
      await m.until(() => copied.length > 0, 'the copy')
      expect(copied).toEqual(['https://acme.trina.app'])
    } finally { await m.unmount() }
    for (const none of [undefined, '', 'not an address']) {
      const e = await mount(<TeamAddressRow address={none} />)
      try { expect(e.find('apps-team-address')).toBeNull() } finally { await e.unmount() }
    }
  })

  const where = <Route path="/login" element={<p data-testid="where">login</p>} />

  test('a used, expired or unknown invite: the reason, then "이미 가입했다면 로그인하세요" and a real sign-in button', async () => {
    for (const answer of [() => json(200, { teamName: 'Acme', role: 'member', expiresAt: '2026-11-15T00:00:00.000Z', valid: false }), () => json(404, { error: { code: 'not_found', message: 'x' } })]) {
      routes = { [`GET /api/invites/${TOKEN}`]: answer }
      const m = await mount(<MemoryRouter initialEntries={[`/invite/${TOKEN}`]}><Routes><Route path="/invite/:token" element={<AcceptInvite />} />{where}</Routes></MemoryRouter>)
      try {
        await m.until(() => m.find('invalid-signin'), 'the sign-in button')
        expect(m.html()).toContain(ko('invite.invalid'))
        expect(m.html()).toContain(ko('auth.alreadyJoined'))
        expect(m.get('invalid-signin').tagName.toLowerCase()).toBe('button')
        expect(m.get('invalid-signin').textContent).toBe(ko('auth.signIn'))
        expect(m.find('join-form')).toBeNull()
        await m.click('invalid-signin')
        await m.until(() => m.find('where'), 'the sign-in page')
      } finally { await m.unmount() }
    }
  })

  test('a team link that no longer works: the same sign-in button under its own reason', async () => {
    Object.defineProperty(g, 'location', { configurable: true, writable: true, value: { pathname: '/join', search: '', hash: `#t=${TOKEN}` } })
    routes = { 'POST /api/team-link/info': () => json(200, { teamName: 'Acme', valid: false, problem: 'used_up', expiresAt: '2026-11-18T00:00:00.000Z', skillName: null }) }
    const m = await mount(<MemoryRouter initialEntries={['/join']}><Routes><Route path="/join" element={<TeamJoin />} />{where}</Routes></MemoryRouter>)
    try {
      await m.until(() => m.find('invalid-signin'), 'the sign-in button')
      expect(m.get('join-problem').textContent).toBe(ko('teamLink.problem.used_up'))
      expect(m.html()).toContain(ko('auth.alreadyJoined'))
      await m.click('invalid-signin')
      await m.until(() => m.find('where'), 'the sign-in page')
    } finally { await m.unmount() }
  })

  test('both join forms end with "이미 가입했어요? 로그인", a link to /login', async () => {
    routes = { [`GET /api/invites/${TOKEN}`]: () => json(200, { teamName: 'Acme', role: 'member', expiresAt: '2026-11-15T00:00:00.000Z', valid: true }) }
    const a = await mount(<MemoryRouter initialEntries={[`/invite/${TOKEN}`]}><Routes><Route path="/invite/:token" element={<AcceptInvite />} />{where}</Routes></MemoryRouter>)
    try {
      await a.until(() => a.find('join-form'), 'the invite form')
      expect(a.get('join-have-account').textContent).toBe(`${ko('auth.haveAccount')} ${ko('auth.signIn')}`)
      expect(a.get('join-signin').getAttribute('href')).toBe('/login')
    } finally { await a.unmount() }
    Object.defineProperty(g, 'location', { configurable: true, writable: true, value: { pathname: '/join', search: '', hash: `#t=${TOKEN}` } })
    routes = { 'POST /api/team-link/info': () => json(200, { teamName: 'Acme', valid: true, problem: null, expiresAt: '2026-11-18T00:00:00.000Z', skillName: null }) }
    const j = await mount(<MemoryRouter initialEntries={['/join']}><Routes><Route path="/join" element={<TeamJoin />} />{where}</Routes></MemoryRouter>)
    try {
      await j.until(() => j.find('join-form'), 'the team link form')
      expect(j.get('join-have-account').textContent).toBe(`${ko('auth.haveAccount')} ${ko('auth.signIn')}`)
      expect(j.get('join-signin').getAttribute('href')).toBe('/login')
    } finally { await j.unmount() }
  })
})

describe('"앱에서 열기" on the join pages (phase 2)', () => {
  const at = (platform: 'ios' | 'android' | 'mac' | 'windows' | 'other', path = `/join#t=${TOKEN}`) => ({ scheme: 'trina-ax', origin: 'https://acme.trina.app', path, platform, androidPackage: 'app.trina.ax' })
  test('the token goes only where our own app receives it: Android names the package, iPhone gets none', async () => {
    const { openInAppHref } = await import('../../src/lib/team-link')
    const enc = encodeURIComponent(`https://acme.trina.app/join#t=${TOKEN}`)
    // Android: an intent link with our package; no other app that claims trina-ax can take it
    expect(openInAppHref(at('android'))).toBe(`intent://open?url=${enc}#Intent;scheme=trina-ax;package=app.trina.ax;end`)
    // the computer: the desktop app's scheme
    for (const p of ['mac', 'windows'] as const) expect(openInAppHref(at(p))).toBe(`trina-ax://open?url=${enc}`)
    expect(openInAppHref(at('mac', '/invite/abc'))).toBe('trina-ax://open?url=https%3A%2F%2Facme.trina.app%2Finvite%2Fabc')
    // iPhone: a custom scheme can be claimed by any app and names no package: no link with a token
    expect(openInAppHref(at('ios'))).toBeNull()
    expect(openInAppHref(at('ios', '/invite/abc'))).toBeNull()
    expect(openInAppHref(at('other'))).toBeNull()
    // the package is the branding's (shared/src/app-links.ts, kept equal to editions/trina/branding/mobile.json)
    const { APP_LINKS } = await import('../../../shared/src/app-links')
    expect(APP_LINKS.androidPackage).toBe('app.trina.ax')
    // what the apps read back (shared/src/team-link.ts readAppLink): the same page (Android delivers the intent as the scheme link)
    const { readAppLink } = await import('../../../shared/src/team-link')
    expect(readAppLink(openInAppHref(at('mac'))!, { teamDomain: 'trina.app', loopbackHttp: false, scheme: 'trina-ax', universal: false })).toMatchObject({ ok: true, origin: 'https://acme.trina.app', entryPath: `/join#t=${TOKEN}` })
    expect(readAppLink(`trina-ax://open?url=${enc}`, { teamDomain: 'trina.app', loopbackHttp: false, scheme: 'trina-ax', universal: true })).toMatchObject({ ok: true, entryPath: `/join#t=${TOKEN}` })
  })
  test('only in a web browser, and only with a link for this system', async () => {
    const { openInAppHref, openInAppShown } = await import('../../src/lib/team-link')
    for (const p of ['android', 'mac', 'windows'] as const) expect(openInAppShown('web', openInAppHref(at(p)))).toBe(true)
    for (const p of ['ios', 'other'] as const) expect(openInAppShown('web', openInAppHref(at(p)))).toBe(false)
    for (const c of ['desktop', 'mobile'] as const) expect(openInAppShown(c, openInAppHref(at('mac')))).toBe(false)
    for (const { id } of LOCALES) expect({ id, ok: (id === 'ko' || !/[가-힣]/.test(DICTS[id]['auth.openInApp'])) && DICTS[id]['auth.openInApp'].length > 0 }).toEqual({ id, ok: true })
    expect(ko('auth.openInApp')).toBe('앱에서 열기')
  })
})
