// An invite link opened while someone is signed in (pages/Auth.tsx InviteWhileSignedIn, QA TC-134 and TC-174): the page
// says who is signed in and offers to sign out to accept the invite, or to keep the account. Before, App.tsx sent the
// link to Home without a word, in a browser and in the phone app (which opens the link's path in its team page).
// The team link (/join#t=…, App.tsx AfterJoin) the same way (QA TC-200), and right after a join /join still goes where
// the join said.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { Me } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import { AfterJoin } from '../../src/App'
import { setAfterJoin } from '../../src/lib/team-link'
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
let hashAt = ''
let locationBefore: PropertyDescriptor | undefined
let historyBefore: PropertyDescriptor | undefined
function Where() { const l = useLocation(); at = l.pathname + l.search; hashAt = l.hash; return null }
beforeAll(() => {
  installDom()
  locationBefore = Object.getOwnPropertyDescriptor(globalThis, 'location')
  historyBefore = Object.getOwnPropertyDescriptor(globalThis, 'history')
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
  if (historyBefore) Object.defineProperty(globalThis, 'history', historyBefore)
  else delete (globalThis as { history?: unknown }).history
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

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde'
/** the address bar as the page sees it, and what it put there instead */
const replaced: string[] = []
function address(hash: string) {
  Object.defineProperty(globalThis, 'location', { configurable: true, writable: true, value: { origin: 'http://team.localhost', href: `http://team.localhost/join${hash}`, pathname: '/join', search: '', hash } })
  Object.defineProperty(globalThis, 'history', { configurable: true, writable: true, value: { state: null, replaceState: (_s: unknown, _t: string, url: string) => { replaced.push(url) } } })
}
const joinPage = () => (
  <MemoryRouter initialEntries={['/join']}>
    <Where />
    <Routes>
      <Route path="/join" element={<AfterJoin />} />
      <Route path="/" element={<p data-testid="home">home</p>} />
      <Route path="/skills" element={<p data-testid="skills">skills</p>} />
    </Routes>
  </MemoryRouter>
)

test('a team link opened while signed in (QA TC-200): who is signed in, the token out of the address; "Sign out and join" opens the join page with it', async () => {
  calls.length = 0
  replaced.length = 0
  address(`#t=${TOKEN}`)
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  const m = await mount(joinPage())
  try {
    await m.until(() => m.find('invite-signed-in'), 'the page')
    expect(document.body.textContent).toContain('You are signed in as QA B. This link is for someone who joins the team.')
    expect(document.body.textContent).toContain('Sign out and join')
    expect(m.find('home')).toBeNull()
    // never left in the address bar (history, a shared screen), as on the join page
    expect(replaced).toEqual(['/join'])
    await m.click('invite-sign-out')
    await m.until(() => useSession.getState().status.kind === 'signed-out' || null, 'signed out')
    expect(calls).toContain('POST /api/auth/logout')
    expect([at, hashAt]).toEqual(['/join', `#t=${TOKEN}`])
  } finally { await m.unmount() }
})

test('a team link opened while signed in: "Keep using this account" goes Home and signs nobody out', async () => {
  calls.length = 0
  address(`#t=${TOKEN}`)
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  const m = await mount(joinPage())
  try {
    await m.click('invite-keep')
    await m.until(() => m.find('home'), 'home')
    expect(calls).not.toContain('POST /api/auth/logout')
    expect(useSession.getState().status.kind).toBe('signed-in')
  } finally { await m.unmount() }
})

test('right after joining (the join page took the token out of the address already): /join goes where the join said', async () => {
  calls.length = 0
  address('')
  setAfterJoin('/skills?run=skills%2Fad-copy%2FSKILL.md')
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  const m = await mount(joinPage())
  try {
    await m.until(() => m.find('skills'), 'the skill the link named')
    expect(at).toBe('/skills?run=skills%2Fad-copy%2FSKILL.md')
    expect(m.find('invite-signed-in')).toBeNull()
    expect(calls).toEqual([])
  } finally { await m.unmount() }
})
