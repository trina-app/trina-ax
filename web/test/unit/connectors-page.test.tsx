// The Connectors page (pages/Connectors.tsx) and a Google app's page (components/integrations/GoogleAppConnector.tsx):
// what each card says and offers in each state (lib/googleApps.ts), that every built-in card has its words in every
// language, that the mock server answers in the contract's shapes (test/mock/googleApps.ts), and the page itself
// rendered for a connected app, one to connect and one that is not available.
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { GoogleAppAdminStatus, GoogleAppFlow, GoogleAppView, type DriveConnection, type GoogleAppId } from '@mycel/shared/api'
import { DICTS } from '../../src/i18n'
import { aboutKey, BUILT_IN_ORDER, canChange, categoryKey, driveCardState, exampleKeys, fits, googleAppCardState, isBuiltIn, isGoogleApp, lineKey, unavailableKeys } from '../../src/lib/googleApps'
import { GoogleAppDetail, type GoogleAppsState } from '../../src/components/integrations/GoogleAppConnector'
import { GOOGLE_APP_IDS, MockGoogleApps, MOCK_GOOGLE_TOOLS } from '../mock/googleApps'

const view = (over: Partial<GoogleAppView> = {}): GoogleAppView => ({
  id: 'gmail', available: true, reason: null, status: 'disconnected', account: null, writePolicy: 'ask', serviceDown: false, tools: MOCK_GOOGLE_TOOLS.gmail, ...over,
})

describe('card states', () => {
  test('a Google app: connected ✓, needs a new sign-in, can be connected, or not now', () => {
    expect(googleAppCardState(view({ status: 'connected' }))).toBe('added')
    expect(googleAppCardState(view({ status: 'needs_reconnect' }))).toBe('reconnect')
    expect(googleAppCardState(view())).toBe('available')
    expect(googleAppCardState(view({ available: false, reason: 'not_set_up' }))).toBe('off')
    // turned off by the team after it was connected: still listed as connected (its page says why it is not used)
    expect(googleAppCardState(view({ available: false, reason: 'members_off', status: 'connected' }))).toBe('added')
    expect(googleAppCardState(view({ available: false, reason: 'members_off', status: 'needs_reconnect' }))).toBe('off')
  })

  test('why not now, in words: an admin is told it is not set up on the team, a member to ask the admin', () => {
    expect(unavailableKeys(null, false)).toBeNull()
    expect(unavailableKeys('not_set_up', false)!.long).toBe('gapps.off.notSetUpMember')
    expect(unavailableKeys('not_set_up', true)!.long).toBe('gapps.off.notSetUpAdmin')
    expect(unavailableKeys('members_off', false)!.short).toBe('gapps.off.membersOff')
    expect(unavailableKeys('unsupported', true)!.long).toBe('gapps.off.unsupportedLong')
    expect(unavailableKeys('service_limited', false)!.short).toBe('gapps.off.serviceLimited')
  })

  test('Google Drive: linked, shared by the team, available, or not set up; an admin may connect while members may not', () => {
    const c = (over: Partial<DriveConnection>): DriveConnection => ({ configured: true, status: 'disconnected', account: null, scopes: [], expiresAt: null, ...over })
    expect(driveCardState(null, false)).toBe('available')
    expect(driveCardState(c({ status: 'connected' }), false)).toBe('added')
    expect(driveCardState(c({ status: 'needs_reconnect' }), false)).toBe('reconnect')
    expect(driveCardState(c({ configured: false, status: 'disabled' }), true)).toBe('off')
    expect(driveCardState(c({ personalAllowed: false }), false)).toBe('off')
    expect(driveCardState(c({ personalAllowed: false }), true)).toBe('available')
    expect(driveCardState(c({ personalAllowed: false, teamShares: [{ id: 's', name: 'Acme', folders: [], wholeDrive: true }] }), false)).toBe('added')
  })

  test('the search fits by name or line, ignoring case and spaces around it', () => {
    expect(fits('', 'Gmail')).toBe(true)
    expect(fits('  gMa ', 'Gmail', 'Read and manage Gmail')).toBe(true)
    expect(fits('calendar', 'Gmail', 'Read and manage Gmail')).toBe(false)
  })

  test('the built-in cards are Drive first, then the four apps; ids are the server\'s', () => {
    expect([...BUILT_IN_ORDER]).toEqual(['google-drive', 'gmail', 'calendar', 'docs', 'sheets'])
    for (const id of GOOGLE_APP_IDS) expect(isGoogleApp(id)).toBe(true)
    expect(isGoogleApp('google-drive')).toBe(false)
    expect(isBuiltIn('notion')).toBe(false)
    expect(canChange(MOCK_GOOGLE_TOOLS.gmail)).toBe(true)
    expect(canChange([{ changes: false }])).toBe(false)
  })
})

describe('words', () => {
  test('every built-in card has its line, category, About and three things to try in every language', () => {
    for (const [locale, dict] of Object.entries(DICTS)) {
      for (const id of BUILT_IN_ORDER) {
        for (const k of [lineKey(id), categoryKey(id), aboutKey(id), ...exampleKeys(id)]) expect({ locale, k, text: !!(dict as Record<string, string>)[k]?.trim() }).toEqual({ locale, k, text: true })
      }
    }
  })

  test('the person never reads how it is wired', () => {
    for (const [locale, dict] of Object.entries(DICTS)) {
      for (const [k, v] of Object.entries(dict as Record<string, string>)) {
        if (!k.startsWith('gapps.') && !k.startsWith('connectorsPage.')) continue
        expect({ locale, k, jargon: /\b(MCP|OAuth|scope|token|sidecar)\b/i.test(v) }).toEqual({ locale, k, jargon: false })
      }
    }
  })
})

describe('the mock server keeps the contract', () => {
  test('views, a sign-in, settings, disconnect and the admin status parse as the API says', () => {
    const m = new MockGoogleApps()
    const list = m.list('u1').apps
    expect(list.map((x) => GoogleAppView.parse(x).reason)).toEqual(['not_set_up', 'not_set_up', 'not_set_up', 'not_set_up'])
    expect(m.authorize('gmail', 'u1', { name: 'A', email: 'a@example.test' })).toBeNull()
    m.control({ app: 'gmail', client: 'drive' })
    expect(GoogleAppAdminStatus.parse(m.adminStatus('gmail', true)).source).toBe('drive')
    const a = m.authorize('gmail', 'u1', { name: 'A', email: 'a@example.test' })!
    expect(GoogleAppFlow.parse(m.poll('gmail', a.flowId, 'u1')).state).toBe('pending')
    expect(GoogleAppFlow.parse(m.poll('gmail', a.flowId, 'u1'))).toMatchObject({ state: 'ready', account: { email: 'a@example.test' } })
    // another person cannot see or finish it
    expect(m.poll('gmail', a.flowId, 'u2')).toBeNull()
    expect(GoogleAppView.parse(m.complete('gmail', a.flowId, 'u1')).status).toBe('connected')
    expect(m.adminStatus('gmail', true).connectedMembers).toBe(1)
    m.control({ app: 'gmail', members: false })
    expect(m.view('gmail', 'u2')).toMatchObject({ available: false, reason: 'members_off' })
    expect(m.disconnect('gmail', 'u1').revocation).toBe('revoked')
  })
})

describe('a Google app\'s page', () => {
  const flow = { flow: null, inProgress: false, busy: false, error: false, authorizationUrl: null, start: async () => {}, cancel: async () => {}, complete: async () => {}, setError: () => {} }
  const g = (apps: GoogleAppView[]) => ({ apps, load: async () => {}, busy: null, setPolicy: async () => {}, disconnect: async () => {}, flows: Object.fromEntries(GOOGLE_APP_IDS.map((id) => [id, flow])) as unknown as Record<GoogleAppId, GoogleAppsState['flows']['gmail']> }) as unknown as GoogleAppsState
  const page = (v: GoogleAppView) => renderToStaticMarkup(<MemoryRouter><GoogleAppDetail v={v} g={g([v])} onChat={() => {}} /></MemoryRouter>)

  test('not connected: Connect, three things to try, About, what it can do, Information and the tools behind Show all', () => {
    const html = page(view())
    expect(html).toContain('data-testid="gapp-connect"')
    expect(html).not.toContain('disabled=""')
    expect((html.match(/data-testid="app-example"/g) ?? []).length).toBe(3)
    expect(html).toContain('data-testid="app-about"')
    expect(html).toContain('data-can-change="yes"')
    expect(html).toContain('data-testid="app-info"')
    expect(html).toContain('href="https://policies.google.com/privacy"')
    expect((html.match(/data-testid="app-tool"/g) ?? []).length).toBe(MOCK_GOOGLE_TOOLS.gmail.length)
    expect(html).toMatch(/id="[^"]+" hidden=""[^>]*data-testid="app-tools"/)
  })

  test('connected: Try in chat, Settings and ⋯, the account; no Connect', () => {
    const html = page(view({ status: 'connected', account: { name: 'Fixture', email: 'fixture@example.test' } }))
    for (const id of ['gapp-try', 'gapp-settings', 'gapp-menu', 'gapp-account-line']) expect(html).toContain(`data-testid="${id}"`)
    expect(html).not.toContain('data-testid="gapp-connect"')
    expect(html).toContain('fixture@example.test')
  })

  test('not set up: Connect is off and the reason is in words; needs a new sign-in: Reconnect; the service down: a calm note', () => {
    const off = page(view({ available: false, reason: 'not_set_up' }))
    expect(off).toMatch(/data-testid="gapp-connect" disabled=""/)
    expect(off).toContain('data-reason="not_set_up"')
    expect(page(view({ status: 'needs_reconnect' }))).toContain('data-testid="gapp-reconnect"')
    expect(page(view({ status: 'connected', serviceDown: true }))).toContain('data-testid="gapp-service-down"')
  })
})
