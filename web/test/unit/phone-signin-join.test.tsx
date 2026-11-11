// Phone sign-in and join pages (QA TC-272, phone audit ADM-24 / ADM-27 / ADM-28) and the personal invite's Try again
// (QA 11-11): the eye button inside the password field, the button in a bar that stays above a phone's keyboard, no
// website footer inside the phone app, plain setup wording, a member's /admin link says it is for admins.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { LOCALES, translate, useLocaleStore } from '../../src/i18n'
import { AcceptInvite, ChangePasswordForm, JoinForm, Login } from '../../src/pages/Auth'
import AdminLayout from '../../src/pages/admin/AdminLayout'
import { useSession } from '../../src/store/session'
import { MOBILE_CAPABILITIES, type MobileConfig } from '../../../mobile/src/protocol'
import { installDom, mount, removeDom, type Mounted } from './dom-host'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const noop = () => {}
const realFetch = globalThis.fetch
const before = useLocaleStore.getState().locale
let routes: Record<string, () => Response> = {}
const calls: string[] = []

const g0 = globalThis as Record<string, unknown>
const wasLocation = Object.getOwnPropertyDescriptor(g0, 'location')
beforeAll(() => {
  installDom()
  Object.defineProperty(g0, 'location', { configurable: true, writable: true, value: { pathname: '/', search: '', hash: '', origin: 'https://acme.example', href: 'https://acme.example/' } })
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    calls.push(key)
    return routes[key]?.() ?? json(500, { error: { code: 'internal', message: `no route ${key}` } })
  }) as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  if (wasLocation) Object.defineProperty(g0, 'location', wasLocation); else delete g0.location
  removeDom()
  useLocaleStore.setState({ locale: before })
})

describe('the password field', () => {
  test('the join form: the eye button sits inside the field (no row of its own) and the button is in the submit bar', async () => {
    const m = await mount(<JoinForm submitLabel="가입" busy={false} error={null} onSubmit={noop} onTooShort={noop} />)
    try {
      const eye = m.get('invite-password-show')
      const input = m.get('invite-password')
      // the eye and the input share the field's box: the input keeps room for it on its right
      const aside = m.get('field-aside')
      expect(aside.contains(eye)).toBe(true)
      expect(aside.parentElement!.className).toContain('relative')
      expect(aside.parentElement!.contains(input)).toBe(true)
      expect(input.className).toContain('pr-11')
      // the eye is not part of the field's name: it is outside the <label>
      expect(input.closest('label')!.contains(eye)).toBe(false)
      // a bare icon: its name in aria-label, no words beside it
      expect(eye.getAttribute('aria-label')).toBe(translate('ko', 'auth.showPassword'))
      expect(eye.textContent).toBe('')
      expect(m.get('auth-submit-bar').contains(m.get('invite-submit'))).toBe(true)
      await m.click('invite-password-show')
      expect(input.getAttribute('type')).toBe('text')
      expect(eye.getAttribute('aria-label')).toBe(translate('ko', 'auth.hidePassword'))
    } finally { await m.unmount() }
  })

  test('the forced password change: one eye for both fields, the button in the submit bar; in Settings no bar', async () => {
    let m = await mount(<ChangePasswordForm forced onDone={noop} />)
    try {
      expect(m.container.querySelectorAll('[data-testid="password-show"]').length).toBe(1)
      expect(m.get('password-new2').className).not.toContain('pr-11')
      await m.click('password-show')
      expect(m.get('password-new').getAttribute('type')).toBe('text')
      expect(m.get('password-new2').getAttribute('type')).toBe('text')
      expect(m.get('auth-submit-bar').contains(m.get('password-submit'))).toBe(true)
    } finally { await m.unmount() }
    m = await mount(<ChangePasswordForm onDone={noop} />)
    try {
      expect(m.find('auth-submit-bar')).toBeNull()
      expect(m.find('password-submit')).not.toBeNull()
    } finally { await m.unmount() }
  })
})

describe('inside the phone app', () => {
  const g = globalThis as Record<string, unknown>
  const config: MobileConfig = { protocol: 1, appVersion: '0.2.2', platform: 'ios', nonce: 'c'.repeat(64), generation: 1, capabilities: MOBILE_CAPABILITIES }
  test('the sign-in page has no source code link and no language select; a browser keeps both', async () => {
    routes = { 'GET /api/auth/providers': () => json(200, { google: false, sso: [] }) }
    let m: Mounted = await mount(<MemoryRouter initialEntries={['/login']}><Login /></MemoryRouter>)
    try {
      expect(m.find('auth-frame')).not.toBeNull()
      expect(m.get('auth-submit-bar').contains(m.get('login-submit'))).toBe(true)
      expect(m.container.querySelector('select')).not.toBeNull()
      expect(m.container.querySelector('a[href*="github"]')).not.toBeNull()
    } finally { await m.unmount() }
    const was = { mycelMobile: g.mycelMobile, ReactNativeWebView: g.ReactNativeWebView }
    g.mycelMobile = { ...config }
    g.ReactNativeWebView = { postMessage: noop }
    try {
      m = await mount(<MemoryRouter initialEntries={['/login']}><Login /></MemoryRouter>)
      try {
        expect(m.find('auth-frame')).not.toBeNull()
        expect(m.container.querySelector('select')).toBeNull()
        expect(m.container.querySelector('a[href*="github"]')).toBeNull()
      } finally { await m.unmount() }
    } finally {
      for (const [k, v] of Object.entries(was)) { if (v === undefined) delete g[k]; else g[k] = v }
    }
  })
})

test('setup wording: no "설치 토큰" / "token" in the field\'s name in any language', () => {
  expect(translate('ko', 'setup.token')).toBe('설정 코드')
  for (const l of LOCALES) {
    expect(translate(l.id, 'setup.token').toLowerCase()).not.toContain('token')
    expect(translate(l.id, 'setup.token')).not.toContain('토큰')
  }
})

describe('/invite/<token>', () => {
  test('details that did not load say why with Try again; Try again loads the form', async () => {
    let offline = true
    const info = { teamName: 'Acme', inviterName: '이수', role: 'member', valid: true, expiresAt: '2026-11-18T00:00:00.000Z' }
    routes = { 'GET /api/invites/tok': () => { if (offline) throw new TypeError('Failed to fetch'); return json(200, info) } }
    calls.length = 0
    const m = await mount(<MemoryRouter initialEntries={['/invite/tok']}><Routes><Route path="/invite/:token" element={<AcceptInvite />} /></Routes></MemoryRouter>)
    try {
      await m.until(() => m.find('join-load-error'), 'the load error')
      expect(m.get('join-load-error').textContent).toBe(translate('ko', 'error.network'))
      expect(m.html()).not.toContain(translate('ko', 'invite.invalid'))
      offline = false
      await m.click('join-retry')
      await m.until(() => m.find('invite-submit'), 'the join form')
      expect(calls.filter((c) => c === 'GET /api/invites/tok').length).toBe(2)
    } finally { await m.unmount() }
  })

  test('the server\'s own "no such invite" still says the invite does not work; a proxy\'s 404 page is a failed load', async () => {
    routes = { 'GET /api/invites/tok': () => json(404, { error: { code: 'not_found', message: 'x' } }) }
    let m = await mount(<MemoryRouter initialEntries={['/invite/tok']}><Routes><Route path="/invite/:token" element={<AcceptInvite />} /></Routes></MemoryRouter>)
    try {
      await m.until(() => m.html().includes(translate('ko', 'invite.invalid')) || null, 'the invalid note')
      expect(m.find('join-retry')).toBeNull()
    } finally { await m.unmount() }
    routes = { 'GET /api/invites/tok': () => new Response('<html>Not Found</html>', { status: 404, headers: { 'content-type': 'text/html' } }) }
    m = await mount(<MemoryRouter initialEntries={['/invite/tok']}><Routes><Route path="/invite/:token" element={<AcceptInvite />} /></Routes></MemoryRouter>)
    try {
      await m.until(() => m.find('join-retry'), 'Try again')
      expect(m.html()).not.toContain(translate('ko', 'invite.invalid'))
    } finally { await m.unmount() }
  })
})

describe('a member opening an /admin link', () => {
  test('says the page is for admins, with a link Home (no silent redirect)', async () => {
    const status = useSession.getState().status
    const me = { user: { id: 'mia', username: 'mia', name: 'Mia', email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [], team: { name: 'Acme', defaultLocale: 'ko' }, server: { version: '0', dev: false } }
    useSession.setState({ status: { kind: 'signed-in', me } } as never)
    const m = await mount(<MemoryRouter initialEntries={['/admin/members']}><Routes><Route path="/admin/:section?/:sub?" element={<AdminLayout />} /><Route path="/" element={<p data-testid="home" />} /></Routes></MemoryRouter>)
    try {
      expect(m.find('home')).toBeNull()
      expect(m.get('admin-only').textContent).toContain('관리자만 볼 수 있어요')
      expect(m.get('admin-only-home').getAttribute('href')).toBe('/')
    } finally {
      await m.unmount()
      useSession.setState({ status } as never)
    }
  })
})
