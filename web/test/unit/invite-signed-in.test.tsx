// An invite link opened while someone is signed in (pages/Auth.tsx InviteWhileSignedIn, QA TC-134 and TC-174): the page
// says who is signed in and offers to sign out to accept the invite, or to keep the account. Before, App.tsx sent the
// link to Home without a word, in a browser and in the phone app (which opens the link's path in its team page).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { Me } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import { InviteWhileSignedIn } from '../../src/pages/Auth'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'

const me = {
  user: { id: 'qa-b', username: 'qa-b', name: 'QA B', email: null, role: 'member', locale: 'en', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'en', chatTrashRetentionDays: 14 }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted' },
} as unknown as Me
const realFetch = globalThis.fetch
const before = useLocaleStore.getState().locale
const status = useSession.getState().status
const calls: string[] = []
let at = ''
let locationBefore: PropertyDescriptor | undefined
function Where() { at = useLocation().pathname; return null }
beforeAll(() => {
  installDom()
  locationBefore = Object.getOwnPropertyDescriptor(globalThis, 'location')
  Object.defineProperty(globalThis, 'location', { configurable: true, writable: true, value: { origin: 'http://team.localhost', href: 'http://team.localhost/invite/tok123', pathname: '/invite/tok123', search: '', hash: '' } })
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input).split('?')[0]}`)
    return new Response(null, { status: 204 })
  }) as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  if (locationBefore) Object.defineProperty(globalThis, 'location', locationBefore)
  else delete (globalThis as { location?: unknown }).location
  removeDom()
  useLocaleStore.setState({ locale: before })
  useSession.setState({ status })
})
const page = () => (
  <MemoryRouter initialEntries={['/invite/tok123']}>
    <Where />
    <Routes>
      <Route path="/invite/:token" element={<InviteWhileSignedIn />} />
      <Route path="/" element={<p data-testid="home">home</p>} />
    </Routes>
  </MemoryRouter>
)

test('says who is signed in; "Sign out and accept" ends the session and stays on the invite address', async () => {
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  const m = await mount(page())
  try {
    await m.until(() => m.find('invite-signed-in'), 'the page')
    expect(document.body.textContent).toContain('You are signed in as QA B')
    expect(m.find('home')).toBeNull()
    await m.click('invite-sign-out')
    await m.until(() => useSession.getState().status.kind === 'signed-out' || null, 'signed out')
    expect(calls).toContain('POST /api/auth/logout')
    expect(at).toBe('/invite/tok123')
  } finally { await m.unmount() }
})

test('"Keep using this account" goes Home and signs nobody out', async () => {
  calls.length = 0
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  const m = await mount(page())
  try {
    await m.until(() => m.find('invite-keep'), 'the page')
    await m.click('invite-keep')
    await m.until(() => m.find('home'), 'home')
    expect(calls).not.toContain('POST /api/auth/logout')
    expect(useSession.getState().status.kind).toBe('signed-in')
  } finally { await m.unmount() }
})
