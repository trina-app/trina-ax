// A hosted team's owner who forgot the password (QA TC-6060, TC-6061, TC-6063): GET /api/setup names the hosting
// console's fixed /recover page (server/src/auth/accounts.ts ownerRecoveryUrl), the session keeps it in the signed-out
// state, and the sign-in page links there with ?team=<its own host>. No URL: the plain "ask an admin" line, as before.
// A removed guest's screen never shows either line.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { translate, useLocaleStore } from '../../src/i18n'
import { Login } from '../../src/pages/Auth'
import { useSession, type AuthStatus } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'

const RECOVER = 'https://account.example.app/recover'
const HOST = 'acme.example.app'
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
let setupAnswer: Record<string, unknown> = {}
const realFetch = globalThis.fetch
const g = globalThis as Record<string, unknown>
const wasLocation = Object.getOwnPropertyDescriptor(g, 'location')
const localeBefore = useLocaleStore.getState().locale
const before = useSession.getState().status

beforeAll(() => {
  installDom()
  Object.defineProperty(g, 'location', { configurable: true, writable: true, value: { pathname: '/login', search: '', hash: '', host: HOST, origin: `https://${HOST}`, href: `https://${HOST}/login` } })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input).split('?')[0]
    if (path.endsWith('/api/me')) return json(401, { error: { code: 'unauthorized', message: 'Signed out' } })
    if (path.endsWith('/api/setup')) return json(200, setupAnswer)
    return json(404, { error: { code: 'not_found', message: 'no route' } })
  }) as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  if (wasLocation) Object.defineProperty(g, 'location', wasLocation); else delete g.location
  useSession.setState({ status: before })
  useLocaleStore.setState({ locale: localeBefore })
  removeDom()
})
beforeEach(() => { useLocaleStore.setState({ locale: 'en' }) })

test('the session keeps a hosted server\'s recovery page in the signed-out state; none when the server sends null or nothing', async () => {
  for (const [answer, want] of [
    [{ needed: false, teamName: null, defaultLocale: 'en', ownerRecoveryUrl: RECOVER }, RECOVER],
    [{ needed: false, teamName: null, defaultLocale: 'en', ownerRecoveryUrl: null }, undefined],
    [{ needed: false, teamName: null, defaultLocale: 'en' }, undefined], // an older server
  ] as const) {
    setupAnswer = answer
    useSession.getState().reset()
    await useSession.getState().load()
    const st = useSession.getState().status
    expect(st.kind).toBe('signed-out')
    expect(st.kind === 'signed-out' ? st.ownerRecoveryUrl : 'x').toBe(want)
  }
  // a later sign-out on the same page keeps it (the same server)
  setupAnswer = { needed: false, teamName: null, defaultLocale: 'en', ownerRecoveryUrl: RECOVER }
  await useSession.getState().load()
  useSession.getState().signedOut('ended')
  const st = useSession.getState().status
  expect(st.kind === 'signed-out' ? st.ownerRecoveryUrl : null).toBe(RECOVER)
})

async function loginWith(status: AuthStatus) {
  useSession.setState({ status })
  return mount(<MemoryRouter initialEntries={['/login']}><Login /></MemoryRouter>)
}

test('hosted: the owner line and a plain new-tab link to /recover?team=<this host>; the guest line stays', async () => {
  for (const locale of ['en', 'ko'] as const) {
    useLocaleStore.setState({ locale })
    const m = await loginWith({ kind: 'signed-out', ownerRecoveryUrl: RECOVER })
    try {
      await m.until(() => m.find('login-username'), 'the sign-in form')
      const a = m.get('login-owner-recovery')
      expect(a.tagName.toLowerCase()).toBe('a')
      expect(a.getAttribute('href')).toBe(`${RECOVER}?team=${encodeURIComponent(HOST)}`)
      expect(a.getAttribute('target')).toBe('_blank')
      expect(a.getAttribute('rel')).toBe('noopener noreferrer')
      expect(a.textContent).toBe(translate(locale, 'auth.ownerRecovery'))
      const line = m.get('login-forgot-hosted').textContent ?? ''
      expect(line).toContain(translate(locale, 'auth.forgotHosted'))
    } finally { await m.unmount() }
  }
  // the guest sentence of the old line is kept in every language
  expect(translate('en', 'auth.forgotHosted')).toContain('the person who invited you')
  expect(translate('ko', 'auth.forgotHosted')).toContain('초대한 분께')
})

test('self-installed (no URL): the old line and no link', async () => {
  const m = await loginWith({ kind: 'signed-out' })
  try {
    await m.until(() => m.find('login-username'), 'the sign-in form')
    expect(m.find('login-owner-recovery')).toBeFalsy()
    expect(m.find('login-forgot-hosted')).toBeFalsy()
    expect(m.container.textContent).toContain(translate('en', 'auth.forgot'))
    expect(m.container.textContent).not.toContain(translate('en', 'auth.forgotHosted'))
  } finally { await m.unmount() }
})

test('a removed guest: neither line nor the link, even on a hosted team', async () => {
  const m = await loginWith({ kind: 'signed-out', reason: 'removed', team: 'Acme', ownerRecoveryUrl: RECOVER })
  try {
    await m.until(() => m.find('login-removed'), 'the removed-guest screen')
    expect(m.find('login-owner-recovery')).toBeFalsy()
    expect(m.find('login-forgot-hosted')).toBeFalsy()
    expect(m.container.textContent).not.toContain('Forgot your password')
  } finally { await m.unmount() }
})
