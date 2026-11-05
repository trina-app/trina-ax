// Admin › Slack and Settings › App connectors › Slack (docs/SLACK.md): the setup is four steps, each with its Slack page,
// and no manifest on the page; a refused token is said under its own field until the next try, never in a toast; once
// set up, one status line with one button, a problem names the one place to fix it, "Remove" waits behind "Replace
// tokens"; without an https address one line says "Sign in with Slack" needs it. Settings: the Slack line replaces the
// empty card; "Sign in with Slack" goes to Slack and its outcome is said when it comes back.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type { MySlack, SlackAdmin } from '@mycel/shared/api'
import AdminSlack from '../../src/pages/admin/Slack'
import ConnectorConnections from '../../src/pages/ConnectorConnections'
import { useLocaleStore } from '../../src/i18n'
import { useUi } from '../../src/store/ui'
import { installDom, mount, removeDom } from './dom-host'

const realFetch = globalThis.fetch
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
let admin: SlackAdmin
let me: MySlack
let assigned: string[] = []
let adminQueries: string[] = []
let saveAnswer: () => Response
let calls: string[] = []
let sealingKey: unknown

const base = (o: Partial<SlackAdmin> = {}): SlackAdmin => ({
  enabled: false, tokens: false, workspace: null, botName: null, appId: null, state: 'off', lastError: null, linkOrigin: null, linked: 0,
  manifest: '{"display_information":{"name":"Trina AX"}}', createUrl: 'https://api.slack.com/apps?new_app=1&manifest_json=%7B%7D',
  signIn: false, redirectUrl: 'https://team.example/api/integrations/slack/oauth/callback', ...o,
})
const on = (o: Partial<SlackAdmin> = {}) => base({ enabled: true, tokens: true, workspace: { teamId: 'T0ACME', name: 'Acme', url: null }, botName: 'trina-ax', appId: 'A0APP', state: 'connected', linked: 2, signIn: true, ...o })

const realResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver
beforeAll(async () => {
  installDom(); useLocaleStore.setState({ locale: 'en' })
  // the admin pages' one-line explanations measure themselves (no layout here)
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  // the page's own address (links of the app open there unless the server says another)
  Object.defineProperty(globalThis, 'location', { configurable: true, writable: true, value: { origin: 'http://team.localhost', href: 'http://team.localhost/admin/slack', assign(u: string) { assigned.push(u) } } })
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  sealingKey = { kid: 'k1', alg: 'ECDH-ES+P256+HKDF-SHA256+A256GCM', publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } }
})
afterAll(() => { removeDom(); (globalThis as { ResizeObserver?: unknown }).ResizeObserver = realResizeObserver; delete (globalThis as { location?: unknown }).location })
beforeEach(() => {
  calls = []
  assigned = []
  adminQueries = []
  useUi.setState({ toasts: [] })
  admin = base()
  me = { available: true, workspace: 'Acme', link: null, signIn: false, emailSetByOther: false }
  saveAnswer = () => json(on({ enabled: false, state: 'off' }))
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://team.localhost')
    const what = `${init?.method ?? 'GET'} ${url.pathname}`
    calls.push(what)
    if (what === 'GET /api/admin/slack') adminQueries.push(url.search)
    if (what === 'GET /api/admin/slack') return json(admin)
    if (what === 'GET /api/credentials/sealing-key') return json(sealingKey)
    if (what === 'PUT /api/admin/slack/tokens') return saveAnswer()
    if (what === 'POST /api/admin/slack/enabled') return json(on())
    if (what === 'POST /api/slack/signin') return json({ authorizationUrl: 'https://slack.com/openid/connect/authorize?state=s' })
    if (what === 'GET /api/slack/me') return json(me)
    if (what === 'GET /api/connectors/remote') return json({ configured: false, resource: null, items: [] })
    return json({ error: { code: 'not_found', message: 'not here' } }, 404)
  }) as typeof fetch
})
afterEach(() => { globalThis.fetch = realFetch })

const page = () => mount(<MemoryRouter><AdminSlack /></MemoryRouter>)
const BOT = 'xoxb-111-222-' + 'b'.repeat(24), APP = 'xapp-1-A0APP-333-' + 'a'.repeat(32)
const fill = async (m: Awaited<ReturnType<typeof page>>) => {
  await m.type('slack-bot-token', BOT)
  await m.type('slack-app-token', APP)
  await m.type('slack-client-id', '1234567890.1234567890')
  await m.type('slack-client-secret', 'c'.repeat(32))
}

describe('Admin › Slack', () => {
  test('not set up: four steps with their Slack pages, no manifest; saving turns it on', async () => {
    const m = await page()
    await m.until(() => m.find('slack-setup'), 'the steps')
    expect(m.get('slack-setup').querySelectorAll('li').length).toBe(4)
    expect(m.get('slack-create').getAttribute('href')).toBe(admin.createUrl)
    expect(m.html()).toContain('href="https://api.slack.com/apps"')
    expect(m.html()).not.toContain('display_information')
    expect(m.html()).not.toContain('It starts with xoxb-')
    await fill(m)
    await m.click('slack-save')
    await m.until(() => m.find('slack-status'), 'the status line')
    expect(calls).toContain('POST /api/admin/slack/enabled')
    expect(m.find('slack-setup')).toBeNull()
    await m.unmount()
  })

  test('a refused token: said under its field, with the Slack page to fix it, until the next try; no toast', async () => {
    saveAnswer = () => json({ error: { code: 'validation', message: 'server words', fields: { 'body.appToken': 'socket_mode_off' }, params: { reason: 'socket_mode_off' } } }, 400)
    const m = await page()
    await m.until(() => m.find('slack-setup'), 'the steps')
    await fill(m)
    await m.click('slack-save')
    const alert = await m.until(() => m.container.querySelector('[role="alert"]'), 'the error')
    expect(alert.textContent).toBe('Turn on Slack app settings › Socket Mode.')
    expect(alert.querySelector('a')!.getAttribute('href')).toBe('https://api.slack.com/apps')
    // under the app token's field: the input says it is invalid and points at the error
    expect(m.get('slack-app-token').getAttribute('aria-invalid')).toBe('true')
    expect(m.get('slack-app-token').getAttribute('aria-describedby')).toBe(alert.getAttribute('id'))
    expect(m.get('slack-bot-token').getAttribute('aria-invalid')).toBeNull()
    expect(useUi.getState().toasts).toEqual([])
    await m.settle(50)
    expect(m.container.querySelector('[role="alert"]')).not.toBeNull()
    // the next try clears it
    saveAnswer = () => json(on({ enabled: false, state: 'off' }))
    await m.click('slack-save')
    await m.until(() => m.find('slack-status'), 'saved')
    await m.unmount()
  })

  test('set up: one status line, one button, the invite line; Remove only behind Replace tokens; rows without buttons', async () => {
    admin = on({ linkOrigin: 'http://team.localhost' })
    const m = await page()
    await m.until(() => m.find('slack-status'), 'the status line')
    expect(m.get('slack-status').textContent).toContain('Connected')
    expect(m.get('slack-status').querySelectorAll('button').length).toBe(1)
    expect(m.get('slack-invite').textContent).toContain('/invite @trina-ax')
    // the links open where this page is: no address to show
    expect(m.html()).not.toContain('links open at')
    expect(m.find('slack-remove')).toBeNull()
    await m.click('slack-replace')
    expect(m.find('slack-remove')).not.toBeNull()
    expect(m.html()).toContain('href="https://api.slack.com/apps/A0APP/install-on-team"')
    // no list of people to link by hand: each person links their own account
    expect(m.find('slack-people')).toBeNull()
    expect(m.find('slack-https-needed')).toBeNull()
    await m.unmount()
  })

  test('the client secret goes sealed with the tokens; without an https address one line says Sign in with Slack needs it', async () => {
    admin = base({ redirectUrl: null })
    let body = ''
    saveAnswer = () => json(on({ enabled: false, state: 'off', redirectUrl: null }))
    const f = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => { if (String(input).endsWith('/api/admin/slack/tokens')) body = String(init?.body ?? ''); return f(input, init) }) as typeof fetch
    const m = await page()
    await m.until(() => m.find('slack-setup'), 'the steps')
    expect(m.get('slack-https-needed').textContent).toContain('needs the team\'s https address')
    await fill(m)
    await m.click('slack-save')
    await m.until(() => m.find('slack-status'), 'saved')
    const sent = JSON.parse(body)
    // one address for the manifest shown and for where links open: the page's own, sent with both
    expect(adminQueries[0]).toBe(`?origin=${encodeURIComponent('http://team.localhost')}`)
    expect(sent.origin).toBe('http://team.localhost')
    expect(sent.clientId).toBe('1234567890.1234567890')
    expect(sent.clientSecret.ct).toBeTruthy()
    expect(body).not.toContain('c'.repeat(32))
    await m.unmount()
  })

  test('a connection problem names the one place to fix it, with its link', async () => {
    admin = on({ state: 'error', lastError: 'socket_mode_off', linkOrigin: 'https://acme.example' })
    const m = await page()
    await m.until(() => m.find('slack-error'), 'the problem')
    expect(m.get('slack-error').textContent).toBe('Turn on Slack app settings › Socket Mode.')
    expect(m.get('slack-error').querySelector('a')!.getAttribute('href')).toBe('https://api.slack.com/apps/A0APP/socket-mode')
    expect(m.find('slack-invite')).toBeNull()
    expect(m.html()).toContain('links open at https://acme.example')
    await m.unmount()
  })

  test('a refused saved app token points to Replace tokens here', async () => {
    admin = on({ state: 'error', lastError: 'invalid_auth' })
    const m = await page()
    await m.until(() => m.find('slack-error'), 'the problem')
    expect(m.find('slack-setup')).toBeNull()
    await m.click(m.get('slack-error').querySelector('button')!)
    expect(m.find('slack-setup')).not.toBeNull()
    await m.unmount()
  })
})

describe('Settings › App connectors', () => {
  const settings = () => mount(<MemoryRouter><ConnectorConnections /></MemoryRouter>)

  test('the team uses Slack: the Slack line, no empty card saying the admin must set connectors up', async () => {
    const m = await settings()
    await m.until(() => m.find('slack-account'), 'the Slack line')
    await m.settle()
    expect(m.find('connectors-empty')).toBeNull()
    expect(m.get('slack-account').textContent).toContain('Mention @Trina AX in Acme')
    await m.unmount()
  })

  test('no Slack: the empty card stays', async () => {
    me = { ...me, available: false }
    const m = await settings()
    await m.until(() => m.find('connectors-empty'), 'the empty card')
    expect(m.find('slack-account')).toBeNull()
    await m.unmount()
  })

  test('Sign in with Slack: the button goes to Slack; the outcome is said when it comes back', async () => {
    me = { ...me, signIn: true }
    let m = await settings()
    await m.until(() => m.find('slack-signin'), 'the button')
    expect(m.get('slack-account').textContent).toContain('Sign in with your Slack account of Acme')
    await m.click('slack-signin')
    await m.until(() => assigned.length > 0, 'went to Slack')
    expect(calls).toContain('POST /api/slack/signin')
    expect(assigned[0]).toStartWith('https://slack.com/openid/connect/authorize')
    await m.unmount()
    me = { ...me, link: { slackUserId: 'U0ME', slackName: 'me.slack', linkedAt: new Date().toISOString() } }
    m = await mount(<MemoryRouter initialEntries={['/settings/connectors?slack=linked']}><ConnectorConnections /></MemoryRouter>)
    await m.until(() => m.find('slack-signin-outcome'), 'the outcome')
    expect(m.get('slack-signin-outcome').textContent).toBe('Your Slack account is linked. You can ask in Slack now.')
    expect(m.find('slack-unlink')).not.toBeNull()
    await m.unmount()
    m = await mount(<MemoryRouter initialEntries={['/settings/connectors?slack=signin_other_user']}><ConnectorConnections /></MemoryRouter>)
    await m.until(() => m.find('slack-signin-outcome'), 'the outcome')
    expect(m.get('slack-signin-outcome').textContent).toContain('signed in to a different account')
    await m.unmount()
    // an outcome that is not one (a name every object has): the general failure, no crash
    m = await mount(<MemoryRouter initialEntries={['/settings/connectors?slack=constructor']}><ConnectorConnections /></MemoryRouter>)
    await m.until(() => m.find('slack-signin-outcome'), 'the outcome')
    expect(m.get('slack-signin-outcome').textContent).toBe('Could not link with the Slack sign-in. Try again in a moment.')
    await m.unmount()
  })

  test('the outcome is said once and taken out of the address; the line reads the link again when the app is used again', async () => {
    let path = ''
    const Where = () => { path = useLocation().pathname + useLocation().search; return null }
    me = { ...me, signIn: true }
    const m = await mount(<MemoryRouter initialEntries={['/settings/connectors?slack=signin_cancelled&tab=x']}><ConnectorConnections /><Where /></MemoryRouter>)
    await m.until(() => m.find('slack-signin-outcome'), 'the outcome')
    await m.until(() => !path.includes('slack='), 'the address without it')
    expect(path).toBe('/settings/connectors?tab=x')
    expect(m.find('slack-signin-outcome')).not.toBeNull()
    // linked in another browser meanwhile: shown when the window is focused again
    me = { ...me, link: { slackUserId: 'U0ME', slackName: 'me.slack', linkedAt: new Date().toISOString() } }
    const reads = calls.filter((c) => c === 'GET /api/slack/me').length
    window.dispatchEvent(new Event('focus'))
    await m.until(() => m.find('slack-unlink'), 'the linked line')
    expect(calls.filter((c) => c === 'GET /api/slack/me').length).toBeGreaterThan(reads)
    await m.unmount()
  })
})
