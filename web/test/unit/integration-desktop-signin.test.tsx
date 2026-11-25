// A service that lets people sign in only from an app on their computer (Canva, Intercom, Square;
// components/integrations/IntegrationRow.tsx useSignIn, lib/desktop.ts openSignInReturn): in the desktop app the sign-in
// passes the app's one-time return port and closes that address when the server does not use it or the sign-in is
// cancelled; on the web the panel says why and links the desktop app's download instead of Try again.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { DESKTOP_BRIDGE_GLOBAL, type DesktopBridge } from '@mycel/shared'
import { translate, useLocaleStore } from '../../src/i18n'
import { SignInPanel, useSignIn, type SignInState } from '../../src/components/integrations/IntegrationRow'
import { installDom, mount, removeDom } from './dom-host'

const realFetch = globalThis.fetch
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
const ID = '01900000-0000-7000-8000-0000000000cc'
const WORDS = 'Canva only lets you sign in from an app on your computer. Open the Trina desktop app and connect it there.'
let answer: () => Response
let bodies: unknown[]
const noop = () => {}
const opened: (Window | null)[] = []

beforeAll(() => { installDom() })
afterAll(() => { removeDom() })
beforeEach(() => {
  useLocaleStore.setState({ locale: 'en' })
  bodies = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://team.localhost')
    if (url.pathname === `/api/integrations/${ID}/authorize`) { bodies.push(JSON.parse(String(init?.body ?? '{}'))); return answer() }
    if (url.pathname === '/api/integrations/flows/flow-1') return json({ flowId: 'flow-1', state: 'pending', reason: null, expiresAt: '2026-11-15T01:00:00.000Z' })
    return json({}, 204)
  }) as typeof fetch
  ;(window as unknown as { open: (u: string) => Window | null }).open = () => { opened.push(null); return null }
})
afterEach(() => {
  globalThis.fetch = realFetch
  delete (globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_GLOBAL]
})

/** a desktop app with the return address (`port`), recording what the page closes */
function desktopApp(port: number | null) {
  const closed: number[] = []
  ;(globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_GLOBAL] = {
    bridgeVersion: 1, appVersion: '0.5.9', platform: 'darwin',
    browser: { run: async () => ({}) as never, cancel: noop },
    pane: { open: noop, close: noop, toggle: noop, getState: async () => ({ open: false, tabs: [], driving: false }), onState: () => noop },
    connection: { get: async () => ({}) as never, onChange: () => noop },
    notify: noop, openTeams: noop,
    signInReturn: { open: async () => port, close: (p: number) => { closed.push(p) } },
  } satisfies DesktopBridge
  return closed
}

async function run(steps: (s: ReturnType<typeof useSignIn>) => Promise<void>) {
  const box: { s: ReturnType<typeof useSignIn> | null } = { s: null }
  function Probe() {
    box.s = useSignIn(noop)
    return <span data-testid="state">{box.s.state?.state ?? 'none'}</span>
  }
  const m = await mount(<Probe />)
  try { await steps(box.s!); await m.settle(); return box.s!.state } finally { await m.unmount() }
}
const desktopOnlyAnswer = () => json({ error: { code: 'validation', message: WORDS, params: { reason: 'oauth_desktop_only' } } }, 400)
const ok = (loopback?: boolean) => () => json({ flowId: 'flow-1', authorizationUrl: 'https://mcp.canva.com/authorize?x=1', expiresAt: '2026-11-15T01:00:00.000Z', ...(loopback ? { loopback } : {}) })

test('on the web: no port, and "only from an app on your computer" with Get the desktop app (Settings › Apps) instead of Try again', async () => {
  answer = desktopOnlyAnswer
  const state = await run(async (s) => { await act(() => s.start(ID, null)) })
  expect(bodies).toEqual([{}])
  expect(state).toMatchObject({ state: 'failed', reason: WORDS, desktopOnly: true })
  const m = await mount(<MemoryRouter><SignInPanel flow={state as SignInState} onRetry={noop} onCancel={noop} /></MemoryRouter>)
  try {
    const html = m.html()
    expect(html).toContain(WORDS)
    expect(html).toContain('href="/settings/apps"')
    expect(html).toContain(translate('en', 'integrations.signIn.getDesktop'))
    expect(html).not.toContain('integration-signin-retry')
    expect(html).toContain(translate('en', 'common.close'))
  } finally { await m.unmount() }
  // any other failure keeps Try again
  const other = await mount(<MemoryRouter><SignInPanel flow={{ id: ID, flowId: null, url: null, state: 'failed', reason: 'x' }} onRetry={noop} onCancel={noop} /></MemoryRouter>)
  try { expect(other.html()).toContain('integration-signin-retry') } finally { await other.unmount() }
})

test('in the desktop app: the return port goes with the sign-in; kept open when the server uses it', async () => {
  const closed = desktopApp(50123)
  answer = ok(true)
  const state = await run(async (s) => { await act(() => s.start(ID, null)) })
  expect(bodies).toEqual([{ loopbackPort: 50123 }])
  expect(state).toMatchObject({ state: 'pending' })
  // unmounting the page (the sign-in left behind) closes it
  expect(closed).toEqual([50123])
})

test('in the desktop app: closed at once when the server does not use it, and on Cancel', async () => {
  const closed = desktopApp(50124)
  answer = ok()
  await run(async (s) => {
    await act(() => s.start(ID, null))
    expect(closed).toEqual([50124])
  })
  const closed2 = desktopApp(50125)
  answer = ok(true)
  await run(async (s) => {
    await act(() => s.start(ID, null))
    expect(closed2).toEqual([])
    await act(async () => s.cancel())
    expect(closed2).toEqual([50125])
  })
})

test('a desktop app that could not open one, or one from before it: no port is sent', async () => {
  desktopApp(null)
  answer = ok()
  await run(async (s) => { await act(() => s.start(ID, null)) })
  expect(bodies).toEqual([{}])
})

test('in the phone app: "Connect Canva on a computer." instead of the download link, no Try again', async () => {
  const flow: SignInState = { id: ID, flowId: null, url: null, state: 'failed', reason: WORDS, desktopOnly: true }
  const m = await mount(<MemoryRouter><SignInPanel flow={flow} name="Canva" phone onRetry={noop} onCancel={noop} /></MemoryRouter>)
  try {
    const html = m.html()
    expect(html).toContain(translate('en', 'integrations.onComputer', { name: 'Canva' }))
    expect(html).not.toContain('/settings/apps')
    expect(html).not.toContain('integration-signin-retry')
    expect(html).toContain(translate('en', 'common.close'))
  } finally { await m.unmount() }
})

test('signing in to Atlassian: the wait says what its "blocked this domain" page means; other services say nothing (QA TC-4770)', async () => {
  const back = encodeURIComponent('https://team.example.com/api/integrations/oauth/callback')
  const flow: SignInState = { id: ID, flowId: 'flow-1', url: `https://auth.atlassian.com/authorize?x=1&redirect_uri=${back}`, state: 'pending', reason: null }
  const words = translate('en', 'integrations.signIn.domainBlocked', { name: 'Atlassian', host: 'team.example.com' })
  const m = await mount(<MemoryRouter><SignInPanel flow={flow} name="Atlassian" url="https://mcp.atlassian.com/v2/mcp" onRetry={noop} onCancel={noop} /></MemoryRouter>)
  try { expect(m.html()).toContain('integration-signin-domains'); expect(m.html()).toContain(words.slice(0, 30)); expect(m.html()).toContain('must add https://team.example.com/** to the allowed domains') } finally { await m.unmount() }
  const notion = await mount(<MemoryRouter><SignInPanel flow={flow} name="Notion" url="https://mcp.notion.com/mcp" onRetry={noop} onCancel={noop} /></MemoryRouter>)
  try { expect(notion.html()).not.toContain('integration-signin-domains') } finally { await notion.unmount() }
})
