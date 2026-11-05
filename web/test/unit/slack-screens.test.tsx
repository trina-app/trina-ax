// Admin › Slack and Settings › App connectors › Slack (docs/SLACK.md): the setup is four steps, each with its Slack page,
// and no manifest on the page; a refused token is said under its own field until the next try, never in a toast; once
// set up, one status line with one button, a problem names the one place to fix it, "Remove" waits behind "Replace
// tokens"; people rows carry no buttons. Settings: the Slack line replaces the empty card; after accepting a proposal,
// one next step and no warning.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { MySlack, SlackAdmin, SlackMembers } from '@mycel/shared/api'
import AdminSlack from '../../src/pages/admin/Slack'
import ConnectorConnections from '../../src/pages/ConnectorConnections'
import { useLocaleStore } from '../../src/i18n'
import { useUi } from '../../src/store/ui'
import { installDom, mount, removeDom } from './dom-host'

const realFetch = globalThis.fetch
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
let admin: SlackAdmin
let me: MySlack
let members: SlackMembers
let saveAnswer: () => Response
let calls: string[] = []
let sealingKey: unknown

const base = (o: Partial<SlackAdmin> = {}): SlackAdmin => ({
  enabled: false, tokens: false, workspace: null, botName: null, appId: null, state: 'off', lastError: null, linkOrigin: null, linked: 0,
  manifest: '{"display_information":{"name":"Trina AX"}}', createUrl: 'https://api.slack.com/apps?new_app=1&manifest_json=%7B%7D', ...o,
})
const on = (o: Partial<SlackAdmin> = {}) => base({ enabled: true, tokens: true, workspace: { teamId: 'T0ACME', name: 'Acme', url: null }, botName: 'trina-ax', appId: 'A0APP', state: 'connected', linked: 2, ...o })

const realResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver
beforeAll(async () => {
  installDom(); useLocaleStore.setState({ locale: 'en' })
  // the admin pages' one-line explanations measure themselves (no layout here)
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  // the page's own address (links of the app open there unless the server says another)
  Object.defineProperty(globalThis, 'location', { configurable: true, writable: true, value: { origin: 'http://team.localhost', href: 'http://team.localhost/admin/slack' } })
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  sealingKey = { kid: 'k1', alg: 'ECDH-ES+P256+HKDF-SHA256+A256GCM', publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } }
})
afterAll(() => { removeDom(); (globalThis as { ResizeObserver?: unknown }).ResizeObserver = realResizeObserver; delete (globalThis as { location?: unknown }).location })
beforeEach(() => {
  calls = []
  useUi.setState({ toasts: [] })
  admin = base()
  me = { available: true, workspace: 'Acme', link: null, proposal: null, emailSetByOther: false }
  members = { available: true, truncated: false, members: [
    { slackUserId: 'U0ALICE', name: 'alice.slack', realName: 'Alice', handle: 'alice', email: 'alice@acme.example', linkedTo: { id: 'alice', name: 'Alice Kim', username: 'alice' }, pending: null },
    { slackUserId: 'U0BOB', name: 'bob.slack', realName: 'Bob', handle: 'bob', email: 'bob@other.example', linkedTo: null, pending: null },
  ] }
  saveAnswer = () => json(on({ enabled: false, state: 'off' }))
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://team.localhost')
    const what = `${init?.method ?? 'GET'} ${url.pathname}`
    calls.push(what)
    if (what === 'GET /api/admin/slack') return json(admin)
    if (what === 'GET /api/credentials/sealing-key') return json(sealingKey)
    if (what === 'PUT /api/admin/slack/tokens') return saveAnswer()
    if (what === 'POST /api/admin/slack/enabled') return json(on())
    if (what === 'GET /api/admin/slack/members') return json(members)
    if (what === 'GET /api/admin/users') return json({ items: [] })
    if (what === 'GET /api/slack/me') return json(me)
    if (what === 'GET /api/connectors/remote') return json({ configured: false, resource: null, items: [] })
    return json({ error: { code: 'not_found', message: 'not here' } }, 404)
  }) as typeof fetch
})
afterEach(() => { globalThis.fetch = realFetch })

const page = () => mount(<MemoryRouter><AdminSlack /></MemoryRouter>)
const BOT = 'xoxb-111-222-' + 'b'.repeat(24), APP = 'xapp-1-A0APP-333-' + 'a'.repeat(32)

describe('Admin › Slack', () => {
  test('not set up: four steps with their Slack pages, no manifest; saving turns it on', async () => {
    const m = await page()
    await m.until(() => m.find('slack-setup'), 'the steps')
    expect(m.get('slack-setup').querySelectorAll('li').length).toBe(4)
    expect(m.get('slack-create').getAttribute('href')).toBe(admin.createUrl)
    expect(m.html()).toContain('href="https://api.slack.com/apps"')
    expect(m.html()).not.toContain('display_information')
    expect(m.html()).not.toContain('It starts with xoxb-')
    await m.type('slack-bot-token', BOT)
    await m.type('slack-app-token', APP)
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
    await m.type('slack-bot-token', BOT)
    await m.type('slack-app-token', APP)
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
    await m.until(() => m.find('slack-person-open'), 'the people')
    // the linked row is plain text; the other row is the one control (no buttons inside rows)
    expect(m.get('slack-people').querySelectorAll('button').length).toBe(1)
    await m.click('slack-person-open')
    await m.until(() => m.find('slack-link-member-confirm'), 'the dialog')
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

  test('a proposal: the warning before accepting; after, one next step and no warning', async () => {
    const proposal = { id: 'p1', slack: { userId: 'U0BOB', name: 'bob.slack', realName: null, handle: 'bob', email: null }, proposedBy: 'Dana', expiresAt: new Date(Date.now() + 86_400_000).toISOString(), memberAccepted: false, slackConfirmed: false }
    me = { ...me, proposal, emailSetByOther: true }
    let m = await settings()
    await m.until(() => m.find('slack-proposal'), 'the proposal')
    expect(m.get('slack-proposal').textContent).toContain('Link it only if this Slack account is yours')
    // the e-mail note and "how to link" are not repeated under a proposal
    expect(m.find('slack-email-set-by-other')).toBeNull()
    expect(m.find('slack-proposal-accept')).not.toBeNull()
    await m.unmount()
    me = { ...me, proposal: { ...proposal, memberAccepted: true } }
    m = await settings()
    await m.until(() => m.find('slack-proposal-slack-half'), 'the next step')
    expect(m.get('slack-proposal-slack-half').textContent).toBe('Next: ask Trina AX something in Slack once, then open the link Trina AX sends you there.')
    expect(m.get('slack-proposal').textContent).not.toContain('Link it only if')
    expect(m.find('slack-proposal-accept')).toBeNull()
    await m.unmount()
  })
})
