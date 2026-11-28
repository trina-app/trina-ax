// Google Drive not set up on this server (QA TC-196): who reads what, and where it leads. In 연결한 서비스 a member
// reads that an admin must turn it on; an owner or admin is the one to set it up, so they read "not set up yet" with a
// button to its page in Admin, never "your admin must turn this on". On that page, without a public address, the owner
// is told what it is for, who turns it on and where to see it (a link to System); an admin is told to ask the owner.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import type { DriveAdminStatus, GoogleAppAdminStatus, Me } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { DriveCard } from '../../src/components/integrations/DriveConnector'
import { DiscoverCard } from '../../src/components/integrations/ConnectorsView'
import { DriveAdminPage, GOOGLE_APPS_GUIDE, GoogleAppAdminPage } from '../../src/components/integrations/GoogleAdminPage'
import type { DriveConnectionState } from '../../src/components/settings/DriveConnection'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'

const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
beforeAll(() => installDom())
afterAll(() => { removeDom(); useLocaleStore.setState({ locale }); useSession.setState({ status }) })
const as = (role: 'owner' | 'admin' | 'member', deployment?: 'hosted') => {
  useLocaleStore.setState({ locale: 'ko' })
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: role, username: role, name: role, role, prefs: {} }, team: { name: 'Acme', defaultLocale: 'ko' }, groups: [], session: { id: 's', client: 'web' }, server: { version: '0', dev: true, ...(deployment ? { deployment } : {}) } } as unknown as Me } })
}
const ko = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate('ko', key, params)
const drive = { name: 'Google Drive' }
const notSetUp = {
  connection: { configured: false, status: 'disabled', account: null, scopes: [], expiresAt: null }, loadFailed: false, load: () => {}, revokeWarning: null, start: () => {}, disconnect: async () => {},
  d: { inProgress: false, flow: null, busy: false, error: false, authorizationUrl: null, cancel: () => {}, complete: async () => {}, setError: () => {} },
} as unknown as DriveConnectionState
/** what the page shows (rendered in the DOM host, where the stores' state is the test's), as text and markup */
async function shown(ui: ReactNode) {
  const m = await mount(<MemoryRouter>{ui}</MemoryRouter>)
  try { return { text: m.container.textContent ?? '', html: m.html() } } finally { await m.unmount() }
}
const card = () => shown(<DriveCard s={notSetUp} />)
const admin: DriveAdminStatus = { configured: false, source: 'none', canSetUp: false, blocked: 'public_host', redirectUri: null, connectedMembers: 0 }
const page = (s: DriveAdminStatus = admin) => shown(<DriveAdminPage status={s} onSetUp={() => {}} onStatus={() => {}} />)

describe('연결한 서비스: Google Drive not set up', () => {
  test('a member reads that an admin must turn it on, with Connect off', async () => {
    as('member')
    const { text, html } = await card()
    expect(text).toContain(ko('connectors.adminNeeded'))
    expect(html).toMatch(/disabled=""[^>]*data-testid="drive-connect"|data-testid="drive-connect"[^>]*disabled=""/)
    expect(html).not.toContain('data-testid="drive-set-up"')
  })
  for (const role of ['owner', 'admin'] as const) {
    test(`the ${role} is told it is not set up yet and gets a button to set it up, never "your admin must turn this on"`, async () => {
      as(role)
      const { text, html } = await card()
      expect(text).toContain(ko('drive.setUpFirst'))
      expect(text).not.toContain(ko('connectors.adminNeeded'))
      expect(html).toContain('data-testid="drive-set-up"')
      expect(html).not.toContain('data-testid="drive-connect"')
    })
  }
})

// fix/hosted-drive-broker-default: a hosted team has nothing to set up (the hosting service turns Drive on), so no one
// is sent to Admin for it; the plain line says it turns on by itself
describe('a hosted team: Google Drive not ready yet', () => {
  for (const role of ['owner', 'admin', 'member'] as const) {
    test(`the ${role} reads that it turns on by itself, with Connect off and no Set up`, async () => {
      as(role, 'hosted')
      const { text, html } = await card()
      expect(text).toContain(ko('drive.notReadyHosted'))
      expect(text).not.toContain(ko('drive.setUpFirst'))
      expect(html).not.toContain('data-testid="drive-set-up"')
      expect(html).toMatch(/disabled=""[^>]*data-testid="drive-connect"|data-testid="drive-connect"[^>]*disabled=""/)
    })
  }
  // Windows QA 2026-11-28: a disconnect through the hosting service keeps the grant at Google (the person's other Trina
  // servers use it); the line says so and links to Google's own page to remove it everywhere
  test('after a disconnect that kept the grant: only this server let go, with Google’s third-party connections page', async () => {
    as('member', 'hosted')
    const kept = { ...notSetUp, connection: { configured: true, status: 'disconnected', account: null, scopes: [], expiresAt: null, hostedApp: true }, revokeWarning: 'kept' } as unknown as DriveConnectionState
    const { text, html } = await shown(<DriveCard s={kept} />)
    expect(text).toContain(ko('drive.keptAtGoogle'))
    expect(html).toContain('data-testid="drive-remove-at-google"')
    expect(html).toContain('href="https://myaccount.google.com/connections"')
    expect(text).not.toContain(ko('drive.revokeWarning'))
  })
  test('Discover\'s card: "not ready yet" for an owner too, never a Set up link to Admin (Drive and the Google apps)', async () => {
    as('owner', 'hosted')
    const c = { id: 'google-drive', name: 'Google Drive', line: 'x', logo: '/x.svg', state: 'off' as const, setUp: true, onOpen: () => {}, onAdd: () => {} }
    const hosted = await shown(<ul><DiscoverCard c={{ ...c, noSetUp: true }} admin /></ul>)
    expect(hosted.html).toContain('data-testid="connector-off"')
    // the card says what its page says: not ready yet (it turns on by itself), not "not set up"
    expect(hosted.text).toContain(ko('drive.notReadyShort'))
    expect(hosted.text).not.toContain(ko('gapps.off.notSetUp'))
    // a Google app (Gmail) on a hosted team: the same
    const gmail = await shown(<ul><DiscoverCard c={{ ...c, id: 'gmail', name: 'Gmail', noSetUp: true }} admin /></ul>)
    expect(gmail.html).not.toContain('data-testid="connector-set-up"')
    expect(gmail.text).toContain(ko('drive.notReadyShort'))
    expect(hosted.html).not.toContain('data-testid="connector-set-up"')
    // a self-installed server's owner still gets Set up
    const own = await shown(<ul><DiscoverCard c={c} admin /></ul>)
    expect(own.html).toContain('data-testid="connector-set-up"')
  })
})

describe('관리자 › 연결한 서비스 › Google Drive without a public address', () => {
  test('the owner: what it is for, who turns it on and a link to System', async () => {
    as('owner')
    const { text, html } = await page()
    expect(html).toContain('data-testid="drive-public-host"')
    expect(text).toContain(ko('googleAdmin.publicHost.why', drive))
    expect(text).toContain(ko('googleAdmin.publicHost.owner', drive))
    expect(html).toContain('href="/admin/system/connection"')
    expect(html).toContain(`href="${GOOGLE_APPS_GUIDE}"`)
  })
  test('an admin: the same reason, and to ask the owner (no link to a page they do not see)', async () => {
    as('admin')
    const { text, html } = await page()
    expect(text).toContain(ko('googleAdmin.publicHost.why', drive))
    expect(text).toContain(ko('googleAdmin.publicHost.admin', drive))
    expect(text).not.toContain(ko('googleAdmin.publicHost.owner', drive))
    expect(html).not.toContain('href="/admin/system')
  })
  test('set up, or blocked for another reason: no such paragraph', async () => {
    as('owner')
    expect((await page({ ...admin, blocked: 'hosted' })).html).not.toContain('data-testid="drive-public-host"')
    expect((await page({ ...admin, configured: true, blocked: null, canSetUp: true, source: 'app' })).html).not.toContain('data-testid="drive-public-host"')
  })
})

// QA TC-2314: the four Google apps said only "Needs this server's public address first." with no hint where it is set
describe('관리자 › 연결한 서비스 › Gmail without a public address', () => {
  const gmail: GoogleAppAdminStatus = { id: 'gmail', configured: false, source: 'none', canSetUp: false, blocked: 'public_host', redirectUri: null, driveAppAvailable: false, apis: [], membersCanConnect: false, connectedMembers: 0 }
  const gpage = (s: GoogleAppAdminStatus = gmail) => shown(<GoogleAppAdminPage status={s} onSetUp={() => {}} onStatus={() => {}} />)
  test('the owner: where it is set (the installer, System › Connection type) and the guide', async () => {
    as('owner')
    const { text, html } = await gpage()
    expect(html).toContain('data-testid="gapp-public-host"')
    expect(text).toContain(ko('appConnectors.blocked.publicHost'))
    expect(text).toContain(ko('googleAdmin.publicHost.why', { name: 'Gmail' }))
    expect(text).toContain(ko('googleAdmin.publicHost.owner', { name: 'Gmail' }))
    expect(html).toContain('href="/admin/system/connection"')
    expect(html).toContain(`href="${GOOGLE_APPS_GUIDE}"`)
  })
  test('an admin: ask the owner, with the guide and no link to System', async () => {
    as('admin')
    const { text, html } = await gpage()
    expect(text).toContain(ko('googleAdmin.publicHost.admin', { name: 'Gmail' }))
    expect(html).toContain(`href="${GOOGLE_APPS_GUIDE}"`)
    expect(html).not.toContain('href="/admin/system')
  })
  test('blocked for another reason or set up: no such paragraph', async () => {
    as('owner')
    expect((await gpage({ ...gmail, blocked: 'hosted' })).html).not.toContain('data-testid="gapp-public-host"')
    expect((await gpage({ ...gmail, configured: true, blocked: null, canSetUp: true, source: 'app' })).html).not.toContain('data-testid="gapp-public-host"')
  })
  test('the guide is the docs page for admins of a server they run', () => {
    expect(GOOGLE_APPS_GUIDE).toBe('https://ax.trina.app/docs/use/google-apps/#set-up-the-google-apps-admins-of-a-server-you-run-yourself')
  })
})

// QA TC-204: the tools read as the steps under an answer do, never as code names
test('Admin › Google Drive lists its tools in words, not drive_search / drive_list / drive_read', async () => {
  as('owner')
  const { text, html } = await page()
  for (const k of ['drive_search', 'drive_list', 'drive_read'] as const) expect(text).toContain(ko(`gapps.drive.tool.${k}`))
  for (const code of ['drive_search', 'drive_list', 'drive_read']) expect(text).not.toContain(code)
  expect(html).not.toContain('font-mono')
})

// The owner's decision (11-12): a server whose Google sign-in comes from the hosting service says so plainly, needs no
// setup, and still has the team settings
describe('관리자 › 연결한 서비스 › Google Drive from the hosting service', () => {
  test('the hosting service line, no Set up and no ⋯; Team settings with who can use it once it is set up (no members\' switch)', async () => {
    as('owner')
    for (const [s, set] of [[{ ...admin, configured: true, source: 'service' as const, blocked: 'hosted' as const }, true], [{ ...admin, configured: false, source: 'none' as const, blocked: 'hosted' as const }, false]] as const) {
      const { text, html } = await page(s)
      expect(html).toContain('data-testid="drive-by-service"')
      expect(text).toContain(ko('appConnectors.byService'))
      expect(html).not.toContain('data-testid="drive-setup"')
      expect(html).not.toContain('data-testid="drive-setup-menu"')
      expect(html.includes('data-testid="team-settings"')).toBe(set)
      expect(html.includes('data-testid="team-who"')).toBe(set)
      expect(html).not.toContain('switch')
    }
  })
  test('its own setup: Set up while not set up, Change setup in ⋯ once it is', async () => {
    as('owner')
    const fresh = await page({ ...admin, blocked: null, canSetUp: true, redirectUri: 'https://team.example.test/cb' })
    expect(fresh.html).toContain('data-testid="drive-setup"')
    expect(fresh.html).not.toContain('data-testid="team-settings"')
    const done = await page({ ...admin, configured: true, source: 'app', blocked: null, canSetUp: true, redirectUri: 'https://team.example.test/cb' })
    expect(done.html).toContain('data-testid="drive-setup-menu"')
    expect(done.html).toContain('data-testid="team-settings"')
    expect(done.html).not.toContain('data-testid="drive-by-service"')
  })
})
