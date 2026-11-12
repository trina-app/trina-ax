// Google Drive not set up on this server (QA TC-196): who reads what, and where it leads. In 연결한 서비스 a member
// reads that an admin must turn it on; an owner or admin is the one to set it up, so they read "not set up yet" with a
// button to its page in Admin, never "your admin must turn this on". On that page, without a public address, the owner
// is told what it is for, who turns it on and where to see it (a link to System); an admin is told to ask the owner.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import type { DriveAdminStatus, Me } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { DriveAdminDetail, DriveCard } from '../../src/components/integrations/DriveConnector'
import type { DriveConnectionState } from '../../src/components/settings/DriveConnection'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'

const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
beforeAll(() => installDom())
afterAll(() => { removeDom(); useLocaleStore.setState({ locale }); useSession.setState({ status }) })
const as = (role: 'owner' | 'admin' | 'member') => {
  useLocaleStore.setState({ locale: 'ko' })
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: role, username: role, name: role, role, prefs: {} }, team: { name: 'Acme', defaultLocale: 'ko' }, groups: [], session: { id: 's', client: 'web' }, server: { version: '0', dev: true } } as unknown as Me } })
}
const ko = (key: Parameters<typeof translate>[1]) => translate('ko', key)
const notSetUp = {
  connection: { configured: false, status: 'disabled', account: null, scopes: [], expiresAt: null }, loadFailed: false, load: () => {}, revokeWarning: false, start: () => {}, disconnect: async () => {},
  d: { inProgress: false, flow: null, busy: false, error: false, authorizationUrl: null, cancel: () => {}, complete: async () => {}, setError: () => {} },
} as unknown as DriveConnectionState
/** what the page shows (rendered in the DOM host, where the stores' state is the test's), as text and markup */
async function shown(ui: ReactNode) {
  const m = await mount(<MemoryRouter>{ui}</MemoryRouter>)
  try { return { text: m.container.textContent ?? '', html: m.html() } } finally { await m.unmount() }
}
const card = () => shown(<DriveCard s={notSetUp} />)
const admin: DriveAdminStatus = { configured: false, source: 'none', canSetUp: false, blocked: 'public_host', redirectUri: null, connectedMembers: 0 }
const page = (s: DriveAdminStatus = admin) => shown(<DriveAdminDetail status={s} onSetUp={() => {}} onBack={() => {}} />)

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

describe('관리자 › 연결한 서비스 › Google Drive without a public address', () => {
  test('the owner: what it is for, who turns it on and a link to System', async () => {
    as('owner')
    const { text, html } = await page()
    expect(html).toContain('data-testid="drive-public-host"')
    expect(text).toContain(ko('driveAdmin.publicHost.why'))
    expect(text).toContain(ko('driveAdmin.publicHost.owner'))
    expect(html).toContain('href="/admin/system"')
  })
  test('an admin: the same reason, and to ask the owner (no link to a page they do not see)', async () => {
    as('admin')
    const { text, html } = await page()
    expect(text).toContain(ko('driveAdmin.publicHost.why'))
    expect(text).toContain(ko('driveAdmin.publicHost.admin'))
    expect(text).not.toContain(ko('driveAdmin.publicHost.owner'))
    expect(html).not.toContain('href="/admin/system"')
  })
  test('set up, or blocked for another reason: no such paragraph', async () => {
    as('owner')
    expect((await page({ ...admin, blocked: 'hosted' })).html).not.toContain('data-testid="drive-public-host"')
    expect((await page({ ...admin, configured: true, blocked: null, canSetUp: true, source: 'app' })).html).not.toContain('data-testid="drive-public-host"')
  })
})
