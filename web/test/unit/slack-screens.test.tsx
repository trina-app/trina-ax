// Admin › Connected apps › Slack and Settings › Connectors › Slack (docs/SLACK.md). Slack is one row of Admin ›
// Connected apps (the owner's and admins'; an admin never gets the team's own app's steps, tokens or its Remove), not a
// menu item of its own; /admin/slack leads to its page. The setup is four
// steps, each with its Slack page,
// and no manifest on the page; a refused token is said under its own field until the next try, never in a toast; once
// set up, one status line with one button, a problem names the one place to fix it, "Remove" waits behind "Replace
// tokens"; without an https address one line says "Sign in with Slack" needs it. Settings: the person's Slack line
// (SlackAccount, under Connectors' list); "Sign in with Slack" goes to Slack and its outcome is said when it comes back.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import type { MySlack, SlackAdmin } from '@mycel/shared/api'
import AdminSlack from '../../src/pages/admin/Slack'
import AdminIntegrations, { slackAdded, slackRowStatus } from '../../src/pages/admin/Integrations'
import { redirectOf } from '../../src/pages/admin/AdminLayout'
import { useSession } from '../../src/store/session'
import { SlackAccount } from '../../src/components/settings/SlackAccount'
import { useLocaleStore } from '../../src/i18n'
import { useUi } from '../../src/store/ui'
import { DialogHost } from '../../src/components/ui'
import { act } from 'react'
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
let installAnswer: () => Response
let enabledAnswer: () => Response
/** who is signed in: the owner, unless a test says an admin */
const signedIn = (role: 'owner' | 'admin') => useSession.setState({ status: { kind: 'signed-in', me: { user: { id: 'u1', username: 'olga', name: 'Olga', email: null, role, locale: 'en', localeChoice: 'en', mustChangePassword: false, prefs: {} }, groups: [], team: { name: 'Acme', defaultLocale: 'en' }, server: { version: '0', dev: false, features: {} } } } } as never)

const base = (o: Partial<SlackAdmin> = {}): SlackAdmin => ({
  mode: 'own', official: false, enabled: false, tokens: false, workspace: null, botName: null, appId: null, state: 'off', lastError: null, linkOrigin: null, linked: 0,
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
  Object.defineProperty(globalThis, 'location', { configurable: true, writable: true, value: { origin: 'http://team.localhost', href: 'http://team.localhost/admin/connectors/slack', assign(u: string) { assigned.push(u) } } })
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  sealingKey = { kid: 'k1', alg: 'ECDH-ES+P256+HKDF-SHA256+A256GCM', publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } }
})
afterAll(() => { removeDom(); (globalThis as { ResizeObserver?: unknown }).ResizeObserver = realResizeObserver; delete (globalThis as { location?: unknown }).location })
beforeEach(() => {
  signedIn('owner')
  calls = []
  assigned = []
  adminQueries = []
  useUi.setState({ toasts: [] })
  admin = base()
  me = { available: true, workspace: 'Acme', link: null, signIn: false, emailSetByOther: false }
  saveAnswer = () => json(on({ enabled: false, state: 'off' }))
  installAnswer = () => json({ authorizationUrl: 'https://slack.com/oauth/v2/authorize?client_id=1111111111.2222222222&state=s' })
  enabledAnswer = () => json(on())
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://team.localhost')
    const what = `${init?.method ?? 'GET'} ${url.pathname}`
    calls.push(what)
    if (what === 'GET /api/admin/slack') adminQueries.push(url.search)
    if (what === 'GET /api/admin/slack') return json(admin)
    if (what === 'GET /api/credentials/sealing-key') return json(sealingKey)
    if (what === 'PUT /api/admin/slack/tokens') return saveAnswer()
    if (what === 'POST /api/admin/slack/enabled') return enabledAnswer()
    // Remove: nothing of Slack left (the hosting service still serves this server)
    if (what === 'DELETE /api/admin/slack') return json(base({ official: true }))
    if (what === 'POST /api/slack/signin') return json({ authorizationUrl: 'https://slack.com/openid/connect/authorize?state=s' })
    if (what === 'POST /api/admin/slack/official/install') return installAnswer()
    if (what === 'GET /api/slack/me') return json(me)
    if (what === 'GET /api/connectors/remote') return json({ configured: false, resource: null, items: [] })
    if (what === 'GET /api/admin/integrations') return json({ items: [] })
    return json({ error: { code: 'not_found', message: 'not here' } }, 404)
  }) as typeof fetch
})
afterEach(() => { globalThis.fetch = realFetch })

const page = (at = '/admin/connectors/slack') => mount(<MemoryRouter initialEntries={[at]}><AdminSlack /></MemoryRouter>)
const BOT = 'xoxb-111-222-' + 'b'.repeat(24), APP = 'xapp-1-A0APP-333-' + 'a'.repeat(32)
const fill = async (m: Awaited<ReturnType<typeof page>>) => {
  await m.type('slack-bot-token', BOT)
  await m.type('slack-app-token', APP)
  await m.type('slack-client-id', '1234567890.1234567890')
  await m.type('slack-client-secret', 'c'.repeat(32))
}

describe('Admin › Connected apps › Slack: the official app (the hosting service serves this server)', () => {
  test('Add to Slack in place of the four steps (also on a phone); it goes to Slack\'s own page', async () => {
    admin = base({ official: true })
    const m = await page()
    await m.until(() => m.find('slack-official'), 'Add to Slack')
    expect(m.find('slack-setup')).toBeNull()
    expect(m.get('slack-official').textContent).toContain('Nothing to copy')
    await m.click('slack-add')
    await m.until(() => assigned.length > 0, 'went to Slack')
    expect(calls).toContain('POST /api/admin/slack/official/install')
    expect(assigned).toEqual(['https://slack.com/oauth/v2/authorize?client_id=1111111111.2222222222&state=s'])
    await m.unmount()
  })

  test('a refusal is said by the button; the own app\'s four steps are one link away, and back', async () => {
    admin = base({ official: true })
    installAnswer = () => json({ error: { code: 'unavailable', message: 'Could not reach the hosting service. Try again in a moment.', params: { reason: 'broker_unreachable' } } }, 503)
    const m = await page()
    await m.until(() => m.find('slack-official'), 'Add to Slack')
    await m.click('slack-add')
    const err = await m.until(() => m.find('slack-add-error'), 'the refusal')
    expect(err.textContent).toContain('hosting service')
    expect(assigned).toEqual([])
    await m.click('slack-own-app')
    await m.until(() => m.find('slack-setup'), 'the steps')
    expect(m.find('slack-official')).toBeNull()
    await m.click('slack-use-official')
    await m.until(() => m.find('slack-official'), 'Add to Slack again')
    await m.unmount()
  })

  test('added: the status line with Remove in place of Replace tokens; no https line', async () => {
    admin = on({ mode: 'official', official: true, redirectUrl: null })
    const m = await page()
    await m.until(() => m.find('slack-status'), 'the status line')
    expect(m.get('slack-status').textContent).toContain('Connected')
    expect(m.find('slack-replace')).toBeNull()
    expect(m.find('slack-remove')).not.toBeNull()
    expect(m.find('slack-https-needed')).toBeNull()
    expect(m.find('slack-official')).toBeNull()
    await m.unmount()
  })

  test('the hosting service\'s problems in plain words; removed in Slack: add it again', async () => {
    admin = on({ mode: 'official', official: true, state: 'error', lastError: 'broker_unreachable' })
    let m = await page()
    expect((await m.until(() => m.find('slack-error'), 'the problem')).textContent).toBe("The server can't reach the hosting service. It reconnects by itself.")
    await m.unmount()
    admin = base({ mode: 'official', official: true, enabled: true, lastError: 'removed', workspace: { teamId: 'T0ACME', name: 'Acme', url: null } })
    m = await page()
    expect((await m.until(() => m.find('slack-removed'), 'removed')).textContent).toBe('The app was removed from Slack. Add it to Slack again.')
    expect(m.find('slack-add')).not.toBeNull()
    await m.unmount()
  })

  test('removed in Slack: Remove beside Add to Slack clears it, after a confirm', async () => {
    admin = base({ mode: 'official', official: true, enabled: true, lastError: 'removed', linked: 3, workspace: { teamId: 'T0ACME', name: 'Acme', url: null } })
    const m = await mount(<MemoryRouter initialEntries={['/admin/connectors/slack']}><AdminSlack /><DialogHost /></MemoryRouter>)
    // the confirm says what goes (not "taken out of your Slack workspace": it is out already); Cancel deletes nothing
    await m.click(await m.until(() => m.find('slack-remove'), 'Remove'))
    await m.until(() => m.find('dialog-confirm'), 'the confirm')
    expect(document.body.textContent).toContain("Slack leaves Connected apps and everyone's account links are deleted.")
    const cancel = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Cancel')!
    await m.click(cancel as never)
    await m.until(() => (m.find('dialog-confirm') ? null : true), 'the confirm closed')
    expect(calls).not.toContain('DELETE /api/admin/slack')
    expect(m.find('slack-removed')).not.toBeNull()
    await m.click('slack-remove')
    await m.click(await m.until(() => m.find('dialog-confirm'), 'the confirm'))
    await m.until(() => (calls.includes('DELETE /api/admin/slack') && !m.find('slack-removed') ? true : null), 'removed')
    // nothing left: Add to Slack, and no Remove
    expect(m.find('slack-add')).not.toBeNull()
    expect(m.find('slack-remove')).toBeNull()
    await m.unmount()
  })

  test('how Add to Slack went is said once, from the address', async () => {
    admin = on({ mode: 'official', official: true })
    let m = await page('/admin/connectors/slack?slack=installed')
    expect((await m.until(() => m.find('slack-outcome'), 'the outcome')).textContent).toBe('Added to Slack. Invite the app to the channels where people will use it.')
    await m.unmount()
    admin = base({ official: true })
    m = await page('/admin/connectors/slack?slack=workspace_taken')
    expect((await m.until(() => m.find('slack-outcome'), 'the outcome')).textContent).toBe('This Slack workspace is connected to another team. Remove it there, or remove the app in Slack, then try again.')
    await m.unmount()
    m = await page('/admin/connectors/slack?slack=not_workspace_admin')
    expect((await m.until(() => m.find('slack-outcome'), 'the outcome')).textContent).toBe('A Slack workspace admin has to add it. Ask an admin to do it.')
    await m.unmount()
    m = await page('/admin/connectors/slack?slack=install_pending')
    expect((await m.until(() => m.find('slack-outcome'), 'the outcome')).textContent).toBe('Added to Slack. It turns on by itself once Slack confirms it.')
    await m.unmount()
    m = await page('/admin/connectors/slack?slack=constructor')
    expect((await m.until(() => m.find('slack-outcome'), 'the outcome')).textContent).toBe('Could not link with the Slack sign-in. Try again in a moment.')
    await m.unmount()
  })
})

describe('Admin › Connected apps › Slack: the own app', () => {
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

describe('Admin › Connected apps › Slack: one service of the list, no menu item', () => {
  test('its page has a connector page\'s header: the way back to Connected apps, the logo, the name and one line', async () => {
    admin = on()
    const m = await page()
    await m.until(() => m.find('slack-status'), 'the status line')
    const back = m.get('app-breadcrumb-connectors')
    expect(back.getAttribute('href')).toBe('/admin/connectors')
    expect(back.textContent).toBe('Connected apps')
    expect(m.get('slack-admin').querySelector('h1')!.textContent).toBe('Slack')
    expect(m.get('app-by').textContent).toContain('People ask @Trina AX in Slack')
    expect(m.get('connector-logo').getAttribute('src')).toBe('/icons/connectors/slack.svg')
    // not an app the AI uses for a person: no About, tools or details
    expect(m.find('app-about')).toBeNull()
    expect(m.find('app-info')).toBeNull()
    await m.unmount()
  })

  test('the old address: the owner and admins get Slack\'s page with the query Add to Slack came back with', () => {
    expect(redirectOf('slack', undefined, '?slack=installed', false)).toBe('/admin/connectors/slack?slack=installed')
    expect(redirectOf('slack', undefined, '', true)).toBe('/admin/connectors/slack')
    // its page is the owner's and admins' (Admin is theirs only)
    expect(redirectOf('connectors', 'slack', '', false)).toBeNull()
  })

  test('its state on the row: on, off, a problem, Reconnect after it was removed in Slack; not added: Discover', () => {
    expect(slackRowStatus(on())).toBe('on')
    expect(slackRowStatus(on({ state: 'connecting' }))).toBe('on')
    expect(slackRowStatus(on({ enabled: false, state: 'off' }))).toBe('off')
    expect(slackRowStatus(on({ state: 'error', lastError: 'unreachable' }))).toBe('attention')
    const removed = base({ mode: 'official', official: true, enabled: true, lastError: 'removed' })
    expect(slackRowStatus(removed)).toBe('reconnect')
    expect(slackAdded(removed)).toBe(true)
    expect(slackAdded(on())).toBe(true)
    expect(slackAdded(base({ official: true }))).toBe(false)
  })

  // the way back by the breadcrumb (this DOM does not follow a link's click): its address, in the same router
  let go: (path: string) => void = () => {}
  function Nav() { go = useNavigate(); return null }
  const list = (role: 'owner' | 'admin', at = '/admin/connectors') => {
    const me = { user: { id: 'u1', username: 'olga', name: 'Olga', email: null, role, locale: 'en', localeChoice: 'en', mustChangePassword: false, prefs: {} }, groups: [], team: { name: 'Acme', defaultLocale: 'en' }, server: { version: '0', dev: false, features: {} } }
    useSession.setState({ status: { kind: 'signed-in', me } } as never)
    return mount(<MemoryRouter initialEntries={[at]}><Routes><Route path="/admin/:section/:sub?/:item?" element={<AdminIntegrations />} /></Routes><DialogHost /><Nav /></MemoryRouter>)
  }
  const back = async (m: Awaited<ReturnType<typeof list>>) => { const to = m.get('app-breadcrumb-connectors').getAttribute('href')!; await act(async () => { go(to) }) }
  const slackRow = (m: Awaited<ReturnType<typeof page>>, kind: 'connected-app' | 'connector-card') => m.container.querySelector(`[data-testid="${kind}"][data-id="slack"]`)

  test('the owner: added, a row in Connected with its state; not added, a card in Discover', async () => {
    const status = useSession.getState().status
    try {
      admin = on()
      let m = await list('owner')
      const row = await m.until(() => slackRow(m, 'connected-app'), 'the Slack row')
      expect(row.getAttribute('data-state')).toBe('on')
      expect(row.textContent).toContain('Slack')
      expect(slackRow(m, 'connector-card')).toBeNull()
      expect(adminQueries).toEqual(['?origin=http%3A%2F%2Fteam.localhost'])
      await m.unmount()
      admin = base({ official: true })
      m = await list('owner')
      const card = await m.until(() => slackRow(m, 'connector-card'), 'the Slack card')
      expect(card.textContent).toContain('People ask @Trina AX in Slack')
      expect(slackRow(m, 'connected-app')).toBeNull()
      await m.unmount()
    } finally { useSession.setState({ status } as never) }
  })

  test('what changes on Slack\'s page is on its row on the way back: Turn off, then Off; Remove, then a Discover card', async () => {
    const status = useSession.getState().status
    try {
      admin = on()
      enabledAnswer = () => json(on({ enabled: false, state: 'off' }))
      let m = await list('owner', '/admin/connectors/slack')
      await m.click(await m.until(() => m.find('slack-toggle'), 'Turn off'))
      await m.until(() => (m.find('slack-toggle')?.textContent === 'Turn on' ? true : null), 'turned off')
      await back(m)
      expect((await m.until(() => slackRow(m, 'connected-app'), 'the Slack row')).getAttribute('data-state')).toBe('off')
      await m.unmount()
      admin = base({ mode: 'official', official: true, enabled: true, lastError: 'removed', workspace: { teamId: 'T0ACME', name: 'Acme', url: null } })
      m = await list('owner', '/admin/connectors/slack')
      await m.click(await m.until(() => m.find('slack-remove'), 'Remove'))
      await m.click(await m.until(() => m.find('dialog-confirm'), 'the confirm'))
      await m.until(() => (m.find('slack-removed') ? null : true), 'removed')
      await back(m)
      await m.until(() => slackRow(m, 'connector-card'), 'the Slack card')
      expect(slackRow(m, 'connected-app')).toBeNull()
      await m.unmount()
    } finally { useSession.setState({ status } as never) }
  })

  test('an admin: Slack in Connected (or Discover) as for the owner; its page has Add to Slack, Turn off and Remove, never the own app', async () => {
    const status = useSession.getState().status
    try {
      admin = on({ mode: 'official', official: true })
      let m = await list('admin')
      expect((await m.until(() => slackRow(m, 'connected-app'), 'the Slack row')).getAttribute('data-state')).toBe('on')
      await m.unmount()
      admin = base({ official: true })
      m = await list('admin')
      await m.until(() => slackRow(m, 'connector-card'), 'the Slack card')
      await m.unmount()
      // no Add to Slack here: no card for an admin (only the owner can set up the team's own app)
      admin = base()
      m = await list('admin')
      await m.until(() => m.find('connector-discover'), 'the list')
      await m.settle()
      expect(slackRow(m, 'connector-card')).toBeNull()
      await m.unmount()
      // not added, the hosting service serves it: Add to Slack, but no "Use your own Slack app"
      admin = base({ official: true })
      m = await list('admin', '/admin/connectors/slack')
      await m.click(await m.until(() => m.find('slack-add'), 'Add to Slack'))
      expect(calls).toContain('POST /api/admin/slack/official/install')
      expect(m.find('slack-own-app')).toBeNull()
      await m.unmount()
      // added: Turn off and Remove
      admin = on({ mode: 'official', official: true })
      enabledAnswer = () => json(on({ mode: 'official', official: true, enabled: false, state: 'off' }))
      m = await list('admin', '/admin/connectors/slack')
      await m.click(await m.until(() => m.find('slack-toggle'), 'Turn off'))
      await m.until(() => (m.find('slack-toggle')?.textContent === 'Turn on' ? true : null), 'turned off')
      expect(m.find('slack-remove')).not.toBeNull()
      expect(m.find('slack-replace')).toBeNull()
      await m.unmount()
    } finally { useSession.setState({ status } as never) }
  })

  test('an admin and the team\'s own app: its state and Turn off, but no steps, tokens, Replace or Remove; one line says only the owner can', async () => {
    signedIn('admin')
    // set up: the status line with its button; "Replace tokens" is a plain line instead
    admin = on({ state: 'error', lastError: 'invalid_auth' })
    let m = await page()
    await m.until(() => m.find('slack-status'), 'the status')
    expect(m.find('slack-toggle')).not.toBeNull()
    expect(m.find('slack-replace')).toBeNull()
    expect(m.find('slack-remove')).toBeNull()
    expect(m.get('slack-owner-only').textContent).toBe('Only the team owner can change or remove this Slack app.')
    // the fix "[Replace tokens]" asks the owner instead (no button to open the token form)
    expect(m.get('slack-error').textContent).toBe('Slack is not working with this app now. Ask the team owner to fix it.')
    expect(m.get('slack-error').querySelector('button')).toBeNull()
    expect(m.find('slack-bot-token')).toBeNull()
    await m.unmount()
    // not set up and no "Add to Slack" here: no four steps, one line
    admin = base()
    m = await page()
    expect((await m.until(() => m.find('slack-owner-only'), 'the line')).textContent).toContain('Only the team owner can connect Slack here.')
    expect(m.find('slack-setup')).toBeNull()
    expect(m.find('slack-bot-token')).toBeNull()
    await m.unmount()
  })
})

describe('Settings › Connectors › Slack', () => {
  const settings = () => mount(<MemoryRouter><SlackAccount /></MemoryRouter>)

  test('the team uses Slack: the Slack line', async () => {
    const m = await settings()
    await m.until(() => m.find('slack-account'), 'the Slack line')
    await m.settle()
    expect(m.get('slack-account').textContent).toContain('Mention @Trina AX in Acme')
    await m.unmount()
  })

  test('no Slack: no Slack line', async () => {
    me = { ...me, available: false }
    const m = await settings()
    await m.until(() => calls.includes('GET /api/slack/me'), 'the Slack state read')
    await m.settle()
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
    m = await mount(<MemoryRouter initialEntries={['/settings/connectors?slack=linked']}><SlackAccount /></MemoryRouter>)
    await m.until(() => m.find('slack-signin-outcome'), 'the outcome')
    expect(m.get('slack-signin-outcome').textContent).toBe('Your Slack account is linked. You can ask in Slack now.')
    expect(m.find('slack-unlink')).not.toBeNull()
    await m.unmount()
    m = await mount(<MemoryRouter initialEntries={['/settings/connectors?slack=signin_other_user']}><SlackAccount /></MemoryRouter>)
    await m.until(() => m.find('slack-signin-outcome'), 'the outcome')
    expect(m.get('slack-signin-outcome').textContent).toContain('signed in to a different account')
    await m.unmount()
    // an outcome that is not one (a name every object has): the general failure, no crash
    m = await mount(<MemoryRouter initialEntries={['/settings/connectors?slack=constructor']}><SlackAccount /></MemoryRouter>)
    await m.until(() => m.find('slack-signin-outcome'), 'the outcome')
    expect(m.get('slack-signin-outcome').textContent).toBe('Could not link with the Slack sign-in. Try again in a moment.')
    await m.unmount()
  })

  test('the outcome is said once and taken out of the address; the line reads the link again when the app is used again', async () => {
    let path = ''
    const Where = () => { path = useLocation().pathname + useLocation().search; return null }
    me = { ...me, signIn: true }
    const m = await mount(<MemoryRouter initialEntries={['/settings/connectors?slack=signin_cancelled&tab=x']}><SlackAccount /><Where /></MemoryRouter>)
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
