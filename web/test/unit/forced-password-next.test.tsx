// Signing in with a temporary password from a link that asked to sign in first (a Slack "link your account" link, a
// connector consent): the forced password change keeps ?next= and goes there afterwards, never another site.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { useLocaleStore } from '../../src/i18n'
import { safeNext } from '../../src/lib/nav'
import { ForcedPassword, Login } from '../../src/pages/Auth'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom, type Mounted } from './dom-host'

const me = {
  user: { id: 'hana', username: 'hana', name: 'Hana', email: null, role: 'member', locale: 'en', localeChoice: null, mustChangePassword: true, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'en' },
  session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z', tempLogin: true }, server: { version: '0', dev: true },
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const routes: Record<string, () => Response> = {
  'POST /api/auth/login': () => json(200, { me }),
  'POST /api/auth/password': () => json(200, { ok: true }),
}
const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const g = globalThis as Record<string, unknown>
const wasLocation = Object.getOwnPropertyDescriptor(g, 'location')
const session = { status: useSession.getState().status, signedIn: useSession.getState().signedIn, load: useSession.getState().load }
beforeAll(() => {
  installDom()
  Object.defineProperty(g, 'location', { configurable: true, writable: true, value: { pathname: '/login', search: '', hash: '', origin: 'https://acme.example', href: 'https://acme.example/login' } })
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    return routes[key]?.() ?? json(404, { error: { code: 'not_found', message: `no route ${key}` } })
  }) as unknown as typeof fetch
  // the store's own sign-in and reload (theme, realtime) are not what this tests
  useSession.setState({ status: { kind: 'signed-in', me }, signedIn: () => {}, load: async () => {} } as never)
})
afterAll(() => {
  globalThis.fetch = realFetch
  if (wasLocation) Object.defineProperty(g, 'location', wasLocation); else delete g.location
  useSession.setState(session as never)
  useLocaleStore.setState({ locale: localeBefore })
  removeDom()
})

function Where() { const l = useLocation(); return <p data-testid="where">{l.pathname + l.search}</p> }

const SLACK = '/slack/link?c=abc'

test('safeNext: paths on this site only', () => {
  expect(safeNext(`?next=${encodeURIComponent(SLACK)}`)).toBe(SLACK)
  for (const bad of ['//evil.example/x', '/\\evil.example', '/\t/evil.example', '/\n/evil.example', 'https://evil.example', 'evil', '']) expect(safeNext(`?next=${encodeURIComponent(bad)}`)).toBeNull()
  expect(safeNext('')).toBeNull()
})

test('sign-in with a temporary password keeps ?next= on the way to the password page', async () => {
  let m: Mounted | null = null
  try {
    m = await mount(
      <MemoryRouter initialEntries={[`/login?next=${encodeURIComponent(SLACK)}`]}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    )
    await m.until(() => m!.find('login-username'), 'the sign-in form')
    await m.type('login-username', 'hana')
    await m.type('login-password', 'temp-pass-123')
    await m.click('login-submit')
    await m.until(() => m!.find('where'), 'the password page')
    expect(m.get('where').textContent).toBe(`/password?next=${encodeURIComponent(SLACK)}`)
  } finally { await m?.unmount() }
})

for (const [label, next, landing] of [
  ['the link it came from', encodeURIComponent(SLACK), SLACK],
  ['Home for another site', encodeURIComponent('//evil.example/x'), '/'],
  ['Home without one', null, '/'],
] as const) {
  test(`after the new password: ${label}`, async () => {
    let m: Mounted | null = null
    try {
      m = await mount(
        <MemoryRouter initialEntries={[`/password${next ? `?next=${next}` : ''}`]}>
          <Routes>
            <Route path="/password" element={<ForcedPassword />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>,
      )
      await m.until(() => m!.find('password-new'), 'the password form')
      await m.type('password-new', 'tulip meadow 2026')
      await m.type('password-new2', 'tulip meadow 2026')
      await m.click('password-submit')
      await m.until(() => m!.find('where'), 'the page after')
      expect(m.get('where').textContent).toBe(landing)
    } finally { await m?.unmount() }
  })
}
