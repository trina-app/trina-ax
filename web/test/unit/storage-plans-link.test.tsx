// A storage-full upload refusal (507 storage_full, server/src/system/storage.ts assertStorageRoom) links "Choose a plan"
// for the owner and admins when the server names a plan page; a member keeps the plain line (QA TC-1969).
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { ApiError, type Me } from '@mycel/shared/api'
import FileUploads from '../../src/components/FileUploads'
import { StoragePlansLink, storagePlansAction, storagePlansUrl } from '../../src/components/StoragePlansLink'
import { useLocaleStore } from '../../src/i18n'
import { addFileUpload, patchFileUpload, useFileUploads } from '../../src/lib/fileUploads'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'

const PLANS = 'https://trina.app/account/plans'
const full = (params: Record<string, string | number> = { reason: 'storage_full', freeBytes: 0, manageUrl: PLANS }) =>
  new ApiError(507, { code: 'storage_full', message: 'The storage is full. Empty the trash or clean up files.', params })
const me = (role: 'owner' | 'admin' | 'member'): Me => ({
  user: { id: 'olga', username: 'olga', name: 'Olga', email: null, role, locale: 'en', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'en' }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'self' },
} as unknown as Me)
const as = (role: 'owner' | 'admin' | 'member') => useSession.setState({ status: { kind: 'signed-in', me: me(role) } })

const localeBefore = useLocaleStore.getState().locale
const sessionBefore = useSession.getState().status
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
})
afterAll(() => {
  removeDom()
  useLocaleStore.setState({ locale: localeBefore })
  useSession.setState({ status: sessionBefore })
})
afterEach(() => useFileUploads.setState({ items: [] }))

test('the plan page comes only from a storage-full refusal that names a web page, and never in a store app', () => {
  expect(storagePlansUrl(full(), false)).toBe(PLANS)
  expect(storagePlansUrl(full({ reason: 'storage_full', freeBytes: 0 }), false)).toBeUndefined()
  expect(storagePlansUrl(full({ reason: 'storage_full', manageUrl: 'javascript:alert(1)' }), false)).toBeUndefined()
  expect(storagePlansUrl(new ApiError(409, { code: 'plan_limit', message: 'x', params: { manageUrl: PLANS } }), false)).toBeUndefined()
  expect(storagePlansUrl(new TypeError('Failed to fetch'), false)).toBeUndefined()
  expect(storagePlansUrl(full(), true)).toBeUndefined()
})

for (const role of ['owner', 'admin'] as const)
  test(`the file screen's failed row: the ${role} gets "Choose a plan" to the plan page`, async () => {
    as(role)
    const a = addFileUpload('report.pdf', 'shared')
    patchFileUpload(a.id, { status: 'failed', error: 'The storage is full. Empty the trash or clean up files.', plans: storagePlansUrl(full(), false) })
    const m = await mount(<FileUploads here="shared" />)
    try {
      const link = m.container.querySelector('[data-testid="storage-plans"]')
      expect(link?.textContent).toBe('Choose a plan')
      expect(link?.getAttribute('href')).toBe(PLANS)
      expect(link?.getAttribute('target')).toBe('_blank')
      // the row wraps, and on a phone the link, Try again and ✕ start their own line (390 px: they ran past the screen)
      expect(link?.closest('li')?.className).toContain('flex-wrap')
      const brk = m.container.querySelector('[data-testid="storage-plans-break"]')
      expect(brk?.className).toContain('basis-full sm:hidden')
      expect(brk?.closest('li')).toBe(link?.closest('li') ?? null)
    } finally {
      await m.unmount()
    }
  })

test("the file screen's failed row: a member keeps the plain line, no link", async () => {
  as('member')
  const a = addFileUpload('report.pdf', 'shared')
  patchFileUpload(a.id, { status: 'failed', error: 'The storage is full. Empty the trash or clean up files.', plans: storagePlansUrl(full(), false) })
  const m = await mount(<FileUploads here="shared" />)
  try {
    expect(m.container.textContent).toContain('The storage is full.')
    expect(m.container.querySelector('[data-testid="storage-plans"]')).toBeNull()
    expect(m.container.querySelector('[data-testid="storage-plans-break"]')).toBeNull()
  } finally {
    await m.unmount()
  }
})

test('no plan page from the server: the owner gets the plain line too', async () => {
  as('owner')
  const m = await mount(<StoragePlansLink url={storagePlansUrl(full({ reason: 'storage_full', freeBytes: 0 }), false)} />)
  try {
    expect(m.container.querySelector('[data-testid="storage-plans"]')).toBeNull()
  } finally {
    await m.unmount()
  }
})

test('a folder upload that stopped: its toast has "Choose a plan" for the owner and admins only', () => {
  // the browser test host is no store app (lib/desktop.ts noPurchaseLinks: no desktop bridge, no phone app)
  as('owner')
  expect(storagePlansAction(full()).action?.label).toBe('Choose a plan')
  as('admin')
  expect(storagePlansAction(full()).action?.label).toBe('Choose a plan')
  as('member')
  expect(storagePlansAction(full())).toEqual({})
  as('owner')
  expect(storagePlansAction(full({ reason: 'storage_full', freeBytes: 0 }))).toEqual({})
})
