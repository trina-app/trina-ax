// A re-check without a password (docs/decisions/20261122-google-reauth.md; src/lib/googleCheck.ts, ReauthDialog in
// src/pages/admin/common.tsx): a person with a password types it as before; one whose account was made with Google
// confirms with Google instead: the press opens a window at once (later, the browser would block it), it goes to
// Google once the server answers, and the request goes with the check's id when the server says it is confirmed. In
// the apps the check needs a browser, except where a recent sign-in stands for it (one's own account deletion).
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { ApiError, type Me } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { passwordRefusal, ReauthDialog, type ReauthProof } from '../../src/pages/admin/common'
import { transferRefusal } from '../../src/components/handover/HandoverDialog'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom, type FakeWindowHandle } from './dom-host'

const FLOW = '01900000-0000-7000-8000-0000000000f1'
const GOOGLE = 'https://accounts.google.com/o/oauth2/v2/auth?state=x'
const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
const ko = (k: Parameters<typeof translate>[1]) => translate('ko', k)
let win: FakeWindowHandle
/** what the fake server answers for the check's state, and the requests it got */
let answer: 'waiting' | 'confirmed' | 'failed' = 'confirmed'
const calls: string[] = []

const me = (hasPassword: boolean): Me => ({
  user: { id: 'pia', username: 'pia', name: 'Pia', email: null, role: 'owner', locale: 'ko', localeChoice: null, mustChangePassword: false, hasPassword, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko' }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'self' },
} as unknown as Me)

beforeAll(() => {
  win = installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${url.pathname}`)
    if (method === 'POST' && url.pathname === '/api/me/google/reauth') return json({ url: GOOGLE, flow: FLOW })
    if (method === 'GET' && url.pathname === `/api/me/google/reauth/${FLOW}`) return json({ state: answer })
    return json({ error: { code: 'not_found', message: url.pathname } }, 404)
  }) as unknown as typeof fetch
})
afterEach(() => {
  calls.length = 0
  win.opened.length = 0
  win.blocked.length = 0
  answer = 'confirmed'
  delete (globalThis as Record<string, unknown>).mycelDesktop
  useSession.setState({ status })
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale })
})

const dialog = (sent: ReauthProof[], o: { recentSignIn?: boolean } = {}) => (
  <ReauthDialog title="t" body="b" confirm="go" recentSignIn={o.recentSignIn} onClose={() => {}} onConfirm={async (p) => { sent.push(p) }} />
)

describe('the re-check dialog', () => {
  test('with a password: the field, and the password is sent', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: me(true) } })
    const sent: ReauthProof[] = []
    const m = await mount(dialog(sent))
    try {
      expect(m.find('reauth-google')).toBeNull()
      await m.type('reauth-password', 'river stone')
      await m.click('reauth-confirm')
      await m.until(() => sent.length, 'the request')
      expect(sent).toEqual([{ password: 'river stone' }])
      expect(win.opened.length).toBe(0)
    } finally { await m.unmount() }
  })

  test('without a password: Google opens in the press, and the request carries the confirmed check', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: me(false) } })
    const sent: ReauthProof[] = []
    const m = await mount(dialog(sent))
    try {
      expect(m.find('reauth-password')).toBeNull()
      expect(m.get('reauth-google').textContent).toContain(ko('reauth.google.body'))
      await m.click('reauth-confirm')
      // the window opened in the click, not after the request (a browser blocks that one)
      expect(win.blocked).toEqual([])
      expect(win.opened.map((w) => w.url)).toEqual(['about:blank'])
      await m.until(() => sent.length, 'the request', 4000)
      expect(sent).toEqual([{ reauthFlow: FLOW }])
      expect(win.opened[0]!.replaced).toEqual([GOOGLE])
      expect(calls).toEqual(['POST /api/me/google/reauth', `GET /api/me/google/reauth/${FLOW}`])
    } finally { await m.unmount() }
  })

  test('a check that did not confirm says so and sends nothing', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: me(false) } })
    answer = 'failed'
    const sent: ReauthProof[] = []
    const m = await mount(dialog(sent))
    try {
      await m.click('reauth-confirm')
      await m.until(() => m.find('reauth-google-error'), 'the words', 4000)
      expect(m.get('reauth-google-error').textContent).toBe(ko('reauth.google.failed'))
      expect(sent).toEqual([])
    } finally { await m.unmount() }
  })

  test('in the desktop app: a browser is needed, except where a recent sign-in stands for it', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: me(false) } })
    ;(globalThis as Record<string, unknown>).mycelDesktop = { bridgeVersion: 1 }
    const sent: ReauthProof[] = []
    const m = await mount(dialog(sent))
    try {
      expect(m.get('reauth-google').textContent).toContain(ko('reauth.google.inBrowser'))
      expect(m.get('reauth-confirm').getAttribute('disabled')).not.toBeNull()
    } finally { await m.unmount() }
    const r = await mount(dialog(sent, { recentSignIn: true }))
    try {
      expect(r.get('reauth-google').textContent).toContain(ko('reauth.google.recent'))
      await r.click('reauth-confirm')
      await r.until(() => sent.length, 'the request')
      expect(sent).toEqual([{}])
      expect(win.opened.length).toBe(0)
    } finally { await r.unmount() }
  })
})

describe('refusals', () => {
  const refused = (fields: Record<string, string>) => new ApiError(403, { code: 'forbidden', message: 'no', fields } as never)
  test('a refused check stays in the dialog like a wrong password, and is no lost owner role', () => {
    expect(passwordRefusal(refused({ 'body.reauthFlow': 'not confirmed' }), 'ko')).toBeTruthy()
    expect(passwordRefusal(refused({ 'body.password': 'wrong password' }), 'ko')).toBeTruthy()
    expect(transferRefusal(refused({ 'body.reauthFlow': 'not confirmed' }))).toBe('other')
    expect(transferRefusal(refused({}))).toBe('owner_changed')
  })
})
