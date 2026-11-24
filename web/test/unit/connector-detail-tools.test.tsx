// A listed service's page before it is connected and a connection's page (components/integrations/ConnectionPage.tsx,
// laid out like the Google connectors' pages, QA TC-197). Before it is connected: the first 12 tools the service lists,
// "Show all" shows the rest in place (Figma's weave_* tools), and the link to the service's own page stays (QA final).
// A connection that fails: its error shows once, with what to do next; Check again, Edit and Delete are in ⋯; the
// address shows only for one added by its address.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Integration } from '@mycel/shared/api'
import { t, translate, useLocaleStore } from '../../src/i18n'
import { ConnectionPage, errorLine, LISTED_TOOLS, ListedServicePage } from '../../src/components/integrations/ConnectionPage'
import { useIntegrationActions } from '../../src/components/integrations/IntegrationRow'
import { CONNECTOR_DOCS, CONNECTORS } from '../../src/lib/connectors'
import { installDom, mount, removeDom } from './dom-host'

const locale = useLocaleStore.getState().locale
beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'en' }) })
afterAll(() => { removeDom(); useLocaleStore.setState({ locale }) })

test('Figma: 12 tools, then all of them in place, Weave included; the service\'s page stays linked', async () => {
  const docs = CONNECTOR_DOCS.figma!
  const c = CONNECTORS.find((x) => x.id === 'figma')!
  expect(docs.tools!.length).toBeGreaterThan(LISTED_TOOLS)
  const m = await mount(<MemoryRouter><ListedServicePage c={c} state="available" about="" /></MemoryRouter>)
  try {
    const items = () => [...m.get('app-tools').querySelectorAll('li')].map((li) => li.getAttribute('data-name'))
    expect(items()).toHaveLength(LISTED_TOOLS)
    expect(m.get('connector-tools-more').textContent).toBe(translate('en', 'connectors.toolsShowAll', { count: docs.tools!.length }))
    await m.click('connector-tools-more')
    expect(items()).toEqual([...docs.tools!])
    expect(items()).toContain('weave_run_model')
    expect(m.get('connector-tools-more').getAttribute('aria-expanded')).toBe('true')
    expect(m.find('connector-tools-link')).not.toBeNull()
    expect(m.find('app-privacy')).not.toBeNull()
    expect(m.find('connector-docs-link')).not.toBeNull()
    // no raw address on a listed service's page
    expect(m.html()).not.toContain(c.url)
  } finally { await m.unmount() }
})

const now = new Date().toISOString()
const failing: Integration = {
  id: '01900000-0000-7000-8000-0000000000c1', scope: 'team', kind: 'mcp', name: 'Higgsfield', slug: 'higgsfield', url: 'https://mcp.higgsfield.ai/mcp',
  auth: 'bearer', authHeader: null, hasSecret: true, account: null, notes: null, writePolicy: 'ask', status: 'error',
  lastError: 'The service did not answer within 30 seconds.', lastErrorReason: 'timeout', tools: [{ name: 'make_video', title: 'Make video', description: '', readOnly: false }],
  toolsTotal: 185, toolsUpdatedAt: null, access: null, createdBy: null, createdAt: now, updatedAt: now, lastUsedAt: now, canManage: true,
}

function Page({ i }: { i: Integration }) {
  const actions = useIntegrationActions({ add: () => {}, replace: () => {}, reload: () => {} })
  return <MemoryRouter><ConnectionPage i={i} actions={actions} onEdit={() => {}} about="" /></MemoryRouter>
}

test('a failing connection: the error once with what to do next, the actions in ⋯, no address for a listed service', async () => {
  const m = await mount(<Page i={failing} />)
  try {
    // one line in the page's words with one next step; the server's own sentence is not added to it
    expect(m.get('integration-error').textContent).toBe(`${translate('en', 'connectors.err.slow')} ${translate('en', 'connectors.step.checkAgain')}`)
    expect(m.html()).not.toContain(failing.lastError!)
    expect(m.get('app-tools-note').textContent).not.toContain(translate('en', 'connectors.toolsAfter'))
    expect(m.get('connection-status').textContent).toBe(translate('en', 'integrations.status.error'))
    expect(m.find('integration-refresh')).toBeNull()
    await m.click('connection-menu')
    expect(m.find('integration-refresh')).not.toBeNull()
    expect(m.find('integration-edit')).not.toBeNull()
    expect(m.find('integration-delete')).not.toBeNull()
    expect(m.find('connector-address')).toBeNull()
    expect(m.html()).not.toContain(failing.url)
    expect(m.get('integration-meta').textContent).toContain(translate('en', 'connectors.page.lastTried'))
  } finally { await m.unmount() }
})

test('one added by its address shows the address in its details; a member reads "ask an admin"', async () => {
  const custom = { ...failing, name: 'Board', url: 'https://board.example.com/mcp', canManage: false }
  const m = await mount(<Page i={custom} />)
  try {
    expect(m.get('connector-address').textContent).toContain(custom.url)
    expect(m.get('integration-error').textContent).toBe(`${translate('en', 'connectors.err.slow')} ${translate('en', 'connectors.step.later')}`)
    expect(m.find('connection-menu')).toBeNull()
  } finally { await m.unmount() }
})

test('the one next step fits the reader and the reason; a reason the page does not know keeps the server\'s words', () => {
  const line = (reason: string | null, auth: Integration['auth'], who: Partial<Parameters<typeof errorLine>[2]>) =>
    errorLine(t, { lastError: 'Server words.', lastErrorReason: reason, auth, hasSecret: true }, { manage: true, elsewhere: false, phone: false, signIn: true, ...who })
  const say = (kind: string, step: string) => `${translate('en', `connectors.err.${kind}` as Parameters<typeof translate>[1])} ${translate('en', `connectors.step.${step}` as Parameters<typeof translate>[1])}`
  expect(line('refused', 'bearer', {})).toBe(say('key', 'editKey'))
  expect(line('refused', 'oauth', {})).toBe(say('key', 'signIn'))
  expect(line('unreachable', 'none', {})).toBe(say('address', 'editAddress'))
  expect(line('unreachable', 'none', { phone: true })).toBe(say('address', 'onComputer'))
  // QA TC-2939: an address that answered, but not as a connector, or by sending us elsewhere, says so (not "couldn't reach")
  expect(line('not_mcp', 'none', {})).toBe(say('notMcp', 'editAddress'))
  expect(line('redirect', 'bearer', {})).toBe(say('redirect', 'editAddress'))
  expect(line('not_mcp', 'none', { phone: true })).toBe(say('notMcp', 'onComputer'))
  expect(line('redirect', 'none', { manage: false })).toBe(say('redirect', 'askAdmin'))
  expect(line('not_mcp', 'none', {})).not.toContain(translate('en', 'connectors.err.address'))
  expect(line('http_status', 'none', { phone: true })).toBe(say('service', 'checkAgain'))
  expect(line('refused', 'bearer', { manage: false })).toBe(say('key', 'askAdmin'))
  // an admin reading a team connection in Settings: it is managed in Admin
  expect(line('refused', 'bearer', { manage: false, elsewhere: true })).toBe(say('key', 'inAdmin'))
  expect(line('key_unsafe', 'bearer', {})).toBe('Server words.')
  expect(line('oauth_no_registration', 'oauth', {})).toBe('Server words.')
  expect(line('oauth_failed', 'oauth', {})).toBe(say('key', 'signIn'))
  expect(line(null, 'bearer', {})).toBe('Server words.')
  // a 403 insufficient_scope: sign in again and allow the access; any other 403 (no_access): the server's words, which
  // carry what the service said and that its owner turns it on (signing in again cannot fix it)
  expect(line('scope', 'oauth', {})).toBe(say('scope', 'signInAllow'))
  expect(line('scope', 'bearer', {})).toBe(say('scope', 'editKey'))
  expect(line('scope', 'oauth', { manage: false })).toBe(say('scope', 'askAdmin'))
  expect(line('no_access', 'oauth', {})).toBe('Server words.')
  // QA TC-3859: a sign-in stopped before it finished (no sign-in saved) is not "the service didn't accept its sign-in";
  // one the service stopped taking (a sign-in is saved) still is
  const waiting = (who: Partial<Parameters<typeof errorLine>[2]>) =>
    errorLine(t, { lastError: 'Server words.', lastErrorReason: 'sign_in', auth: 'oauth', hasSecret: false }, { manage: true, elsewhere: false, phone: false, signIn: true, ...who })
  expect(waiting({})).toBe('The sign-in was not finished, so this is not connected yet. Choose Sign in to try again.')
  expect(waiting({})).not.toContain(translate('en', 'connectors.err.key'))
  expect(waiting({ manage: false })).toBe(say('notSignedIn', 'askAdmin'))
  expect(waiting({ phone: true })).toBe(say('notSignedIn', 'onComputer'))
  expect(line('sign_in', 'oauth', {})).toBe(say('key', 'signIn'))
})

test('Check again under way shows on the page until it answers', async () => {
  const realFetch = globalThis.fetch
  let answer: (r: Response) => void = () => {}
  globalThis.fetch = (() => new Promise<Response>((r) => { answer = r })) as unknown as typeof fetch
  const m = await mount(<Page i={failing} />)
  try {
    await m.click('connection-menu')
    await m.click('integration-refresh')
    await m.until(() => m.find('connection-status')?.getAttribute('data-state') === 'checking', 'checking shown')
    expect(m.get('connection-status').textContent).toBe(translate('en', 'connectors.page.checking'))
    answer(new Response(JSON.stringify({ ...failing, status: 'connected', lastError: null, lastErrorReason: null }), { status: 200, headers: { 'content-type': 'application/json' } }))
    await m.until(() => m.find('connection-status')?.getAttribute('data-state') !== 'checking', 'checking ends')
  } finally { await m.unmount(); globalThis.fetch = realFetch }
})

// QA TC-4794: a team Canva connection that only an app on the computer can sign in (oauth_desktop_only). Settings shows a
// team connection read-only; in the desktop app (the bridge with its one-time return address) its admin gets the same
// Sign in as Admin › Connected apps, and no "open the desktop app". The web keeps the server's words and no button; a
// member never gets Sign in (a team connection is signed in by an admin only).
const canva: Integration = {
  ...failing, id: '01900000-0000-7000-8000-0000000000c2', name: 'Canva', slug: 'canva', url: 'https://mcp.canva.com/mcp', auth: 'oauth', hasSecret: false,
  status: 'needs_auth', lastError: 'Canva only lets you sign in from an app on your computer. Open the Trina desktop app and connect it there.',
  lastErrorReason: 'oauth_desktop_only', tools: [], toolsTotal: undefined,
}

function SettingsPage({ i }: { i: Integration }) {
  const actions = useIntegrationActions({ add: () => {}, replace: () => {}, reload: () => {} })
  return <MemoryRouter><ConnectionPage inSettings i={i} actions={actions} readOnly={i.scope === 'team'} onEdit={() => {}} about="" /></MemoryRouter>
}

async function onDesktop<T>(run: () => Promise<T>, bridge: Record<string, unknown> = { bridgeVersion: 1, signInReturn: { open: async () => null, close: () => {} } }): Promise<T> {
  Object.assign(globalThis, { mycelDesktop: bridge })
  try { return await run() } finally { delete (globalThis as Record<string, unknown>).mycelDesktop }
}

test('TC-4794: in the desktop app, Settings offers Sign in on a team Canva connection to its admin, like Admin does', async () => {
  const notSignedIn = `${translate('en', 'connectors.err.notSignedIn')} ${translate('en', 'connectors.step.signInFirst')}`
  await onDesktop(async () => {
    for (const page of [<SettingsPage key="s" i={canva} />, <Page key="a" i={canva} />]) {
      const m = await mount(page)
      try {
        expect(m.find('integration-signin-start')).not.toBeNull()
        expect(m.get('integration-error').textContent).toBe(notSignedIn)
        expect(m.html()).not.toContain(canva.lastError!)
        // Settings still does not manage a team connection: edit and delete stay in Admin
        if (page.key === 's') expect(m.find('connection-menu')).toBeNull()
      } finally { await m.unmount() }
    }
    // a member: no Sign in (the server's words for them say to tell an admin)
    const member = { ...canva, canManage: false, lastError: 'The team\'s key or sign-in for this service is not working. Tell your admin.' }
    const m = await mount(<SettingsPage i={member} />)
    try {
      expect(m.find('integration-signin-start')).toBeNull()
      expect(m.get('integration-error').textContent).toBe(`${translate('en', 'connectors.err.notSignedIn')} ${translate('en', 'connectors.step.askAdmin')}`)
    } finally { await m.unmount() }
  })
  // a desktop app from before the return address cannot do it: Settings stays as on the web
  await onDesktop(async () => {
    const m = await mount(<SettingsPage i={canva} />)
    try {
      expect(m.find('integration-signin-start')).toBeNull()
      expect(m.get('integration-error').textContent).toBe(canva.lastError!)
    } finally { await m.unmount() }
  }, { bridgeVersion: 1 })
})

test('TC-4794: on the web, Settings keeps "open the desktop app" for a team Canva connection, with no Sign in', async () => {
  const m = await mount(<SettingsPage i={canva} />)
  try {
    expect(m.find('integration-signin-start')).toBeNull()
    expect(m.get('integration-error').textContent).toBe(canva.lastError!)
  } finally { await m.unmount() }
  // another team connection in Settings is still managed in Admin, in the desktop app too
  await onDesktop(async () => {
    const n = await mount(<SettingsPage i={{ ...canva, name: 'Notion', url: 'https://mcp.notion.com/mcp', lastErrorReason: 'sign_in', lastError: 'Sign in.' }} />)
    try {
      expect(n.find('integration-signin-start')).toBeNull()
      expect(n.get('integration-error').textContent).toBe(`${translate('en', 'connectors.err.notSignedIn')} ${translate('en', 'connectors.step.inAdmin')}`)
    } finally { await n.unmount() }
  })
})
