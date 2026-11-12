// Admin › System on a phone (390×844, touch; pages/admin/systemGroups.ts), the QA rows' steps as they say them:
// - TC-269 step 1: "Admin › System" → "A list of pages like Team settings (not one 2,500px page)": storage, version and
//   updates, health, connection, connected folders, backups and export, each a page under "‹ System"; ‹ and Back return
//   to the list. An admin has the storage (and the automatic updates in office mode).
// - TC-270 step 1: "Admin › System (connected folders, backups)" → "A status row plus '컴퓨터에서 설정해요' instead of the
//   forms": the folder path form, the connection mode change and the update's server command.
// The restore result line and the wrong-password dialog (TC-208, TC-221) work the same in the backups page. A computer
// keeps the one page. Each test runs in WebKit (the iPhone app's engine: phone-admin-system.webkit.spec.ts) and Chromium
// (Android's: phone-admin-system.spec.ts).
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { DICTS, translate } from '../../src/i18n'

const t = DICTS.en
const OWNER_GROUPS = ['storage', 'updates', 'health', 'connection', 'connected', 'backups', 'export'] as const
const LABEL: Record<(typeof OWNER_GROUPS)[number], keyof typeof t> = {
  storage: 'storage.title', updates: 'system.updates', health: 'system.health', connection: 'system.connection',
  connected: 'connected.title', backups: 'system.backups', export: 'system.export',
}
/** what shows on each group's page, and only there */
const CONTENT: Record<(typeof OWNER_GROUPS)[number], string> = {
  storage: 'storage', updates: 'system-update', health: 'system-health', connection: 'connection-mode-name',
  connected: 'connected-on-computer', backups: 'backup-now', export: 'system-group-export',
}
const historyLength = (page: Page) => page.evaluate(() => history.length)
const bar = (page: Page) => page.getByTestId('admin-bar-title')
const backLabel = (page: Page) => page.getByTestId('admin-back-label')

/** 나 › Admin › System, as a person taps it */
async function openSystem(page: Page) {
  await page.getByTestId('tab-me').click()
  await page.getByTestId('settings-admin').click()
  await expect(page.getByTestId('admin-phone-root')).toBeVisible()
  await page.getByTestId('admin-row-system').click()
  await expect(page).toHaveURL(/\/admin\/system$/)
  await expect(page.getByTestId('system-list')).toBeVisible()
}

const FOLDER = { id: 'c1', name: 'nas', path: 'connected/nas', source: '/Volumes/공유', lastSyncAt: '2026-11-12T01:00:00.000Z', lastStatus: 'ok', lastError: null, files: 12, bytes: 34567, syncing: false }
const officeStatus = { current: '0.2.20', channel: 'stable', paused: false, time: '22:30', window: '22:30-00:30', windowSource: 'legacy', timeZone: 'Asia/Jakarta', nextWindowAt: '2026-11-02T15:30:00.000Z', lastCheckAt: '2026-11-02T09:00:00.000Z', last: null, available: null, lastUpdate: null, running: null, requested: false, agentInstalled: true, desktop: null }

export function systemCases() {
  // the app's service worker (WebKit) would answer the API itself, past page.route
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'en-US', serviceWorkers: 'block' })

  test.beforeEach(async ({ page }) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true, withAdmin: true })
  })

  test('TC-269 step 1: Admin › System is a list of its parts with their state; nothing of the parts on it', async ({ page }) => {
    await signIn(page)
    await openSystem(page)
    await expect(bar(page)).toHaveText(t['admin.system'])
    await expect(backLabel(page)).toHaveText(t['admin.title'])
    for (const id of OWNER_GROUPS) {
      const row = page.getByTestId(`system-row-${id}`)
      await expect(row).toContainText(t[LABEL[id]])
      expect(Math.round((await row.boundingBox())!.height), id).toBeGreaterThanOrEqual(48)
      // the list only: no part of any page is on it
      await expect(page.getByTestId(CONTENT[id])).toBeHidden()
    }
    // each row's state on its right: the disk 82% full as a warning, the version, the relay check, the connection
    await expect(page.getByTestId('system-row-storage')).toContainText('82%')
    await expect(page.getByTestId('system-row-updates')).toContainText('0.1.0')
    await expect(page.getByTestId('system-row-health')).toContainText(translate('en', 'adminHome.toFix', { count: 1 }))
    await expect(page.getByTestId('system-row-connection')).toContainText(t['system.conn.connecting'])
    // the whole list fits on the first screen (it was a 2,500 px page)
    expect((await page.getByTestId('system-row-export').boundingBox())!.y).toBeLessThan(844 - 60)
    expect(await page.getByTestId('admin-content').evaluate((el) => el.scrollHeight)).toBeLessThan(844)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  })

  test('TC-269 step 1: a row opens its page under "‹ System"; ‹ and Back return to the list', async ({ page }) => {
    await signIn(page)
    await openSystem(page)
    // a push each time; Back leaves it as the entry ahead, which the next push takes the place of
    const length = await historyLength(page)
    for (const [i, id] of OWNER_GROUPS.entries()) {
      await page.getByTestId(`system-row-${id}`).click()
      await expect(page).toHaveURL(new RegExp(`/admin/system/${id}$`))
      expect(await historyLength(page)).toBe(length + 1)
      await expect(bar(page)).toHaveText(t[LABEL[id]])
      await expect(backLabel(page)).toHaveText(t['admin.system'])
      await expect(page.getByTestId('admin-back')).toHaveAccessibleName(t['tabs.backTo'].replace('{page}', t['admin.system']))
      // that part only, its name said once (the bar)
      await expect(page.getByTestId(CONTENT[id])).toBeVisible()
      for (const other of OWNER_GROUPS) if (other !== id) await expect(page.getByTestId(`system-group-${other}`)).toBeHidden()
      await expect(page.getByTestId('system-list')).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth), id).toBeLessThanOrEqual(390)
      // ‹ (back in the history, no new entry) or the phone's Back (the iPhone's swipe), in turn
      if (i % 2) await page.goBack()
      else await page.getByTestId('admin-back').click()
      await expect(page).toHaveURL(/\/admin\/system$/)
      await expect(page.getByTestId('system-list')).toBeVisible()
      expect(await historyLength(page)).toBe(length + 1)
    }
    // and from the list, Back goes to Admin's list
    await page.getByTestId('admin-back').click()
    await expect(page).toHaveURL(/\/admin$/)
    await expect(page.getByTestId('admin-phone-root')).toBeVisible()
  })

  test('TC-269 step 1: a part\'s address opened from outside has System and Admin under it; Admin\'s storage row opens the storage page', async ({ page }) => {
    await signIn(page)
    await page.goto('/admin/system/backups')
    await expect(page.getByTestId('backup-now')).toBeVisible()
    await expect(bar(page)).toHaveText(t['system.backups'])
    await expect(backLabel(page)).toHaveText(t['admin.system'])
    await page.goBack()
    await expect(page).toHaveURL(/\/admin\/system$/)
    await expect(page.getByTestId('system-list')).toBeVisible()
    await page.goBack()
    await expect(page).toHaveURL(/\/admin$/)
    // the Admin list's "Storage is 82% full" opens the storage page; ‹ names the Admin list it came from and goes there
    await page.getByTestId('attention-storage').click()
    await expect(page).toHaveURL(/\/admin\/system\/storage$/)
    await expect(page.getByTestId('storage')).toBeVisible()
    await expect(bar(page)).toHaveText(t['storage.title'])
    await expect(backLabel(page)).toHaveText(t['admin.title'])
    await page.getByTestId('admin-back').click()
    await expect(page).toHaveURL(/\/admin$/)
    // an unknown part: the list
    await page.goto('/admin/system/nope')
    await expect(page).toHaveURL(/\/admin\/system$/)
    await expect(page.getByTestId('system-list')).toBeVisible()
  })

  test('TC-269 step 1, an admin: the storage (and the automatic updates in office mode); the owner\'s parts lead to the list', async ({ page }) => {
    await signIn(page, { username: 'dana', password: 'dana password 1' })
    await openSystem(page)
    await expect(page.getByTestId('system-row-storage')).toContainText('82%')
    for (const id of OWNER_GROUPS.slice(1)) await expect(page.getByTestId(`system-row-${id}`)).toHaveCount(0)
    await page.getByTestId('system-row-storage').click()
    await expect(page).toHaveURL(/\/admin\/system\/storage$/)
    await expect(page.getByTestId('storage')).toBeVisible()
    await page.goBack()
    await expect(page.getByTestId('system-list')).toBeVisible()
    for (const id of ['backups', 'updates']) {
      await page.goto(`/admin/system/${id}`)
      await expect(page).toHaveURL(/\/admin\/system$/)
      await expect(page.getByTestId('system-list')).toBeVisible()
    }
    // office mode: the automatic updates are a page of their own
    await page.route('**/api/admin/office-update', (route) => route.fulfill({ json: officeStatus }))
    await page.goto('/admin/system')
    await page.getByTestId('system-row-updates').click()
    await expect(page).toHaveURL(/\/admin\/system\/updates$/)
    await expect(page.getByTestId('office-update')).toBeVisible()
    await expect(page.getByTestId('storage')).toBeHidden()
  })

  test('TC-270 step 1: connected folders: the folders\' state stays, the path form is "Set this up on a computer"', async ({ page }) => {
    await page.route('**/api/admin/connected', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: { items: [FOLDER] } }) : route.fallback()))
    await signIn(page)
    await openSystem(page)
    await expect(page.getByTestId('system-row-connected')).toContainText('1')
    await page.getByTestId('system-row-connected').click()
    // the folder's row: its name, where it comes from and its last sync
    const list = page.getByTestId('connected-list')
    await expect(list).toContainText('connected/nas')
    await expect(list).toContainText('/Volumes/공유')
    // no path field, no Finder hint, no Connect button
    await expect(page.getByTestId('connected-source')).toHaveCount(0)
    await expect(page.getByTestId('connected-name')).toHaveCount(0)
    await expect(page.getByText(t['connected.sourceHint'])).toHaveCount(0)
    await expect(page.getByRole('button', { name: t['connected.add'], exact: true })).toHaveCount(0)
    const onComputer = page.getByTestId('connected-on-computer')
    await expect(onComputer).toContainText(t['admin.onComputer'])
    await expect(onComputer).toContainText(t['admin.onComputerFolder'])
  })

  test('TC-270 step 1: connection: its state stays, changing the mode is "Set this up on a computer"', async ({ page }) => {
    await signIn(page)
    await page.goto('/admin/system/connection')
    await expect(page.getByTestId('connection-mode-name')).toHaveText(t['system.mode.self-relay'])
    await expect(page.getByTestId('system-group-connection')).toContainText(t['system.conn.connecting'])
    await expect(page.getByRole('button', { name: t['system.changeMode'] })).toHaveCount(0)
    await expect(page.getByTestId('connection-on-computer')).toContainText(t['admin.onComputerConnection'])
  })

  test('TC-270 step 1: an update the server installs by its own command, or with no feed: no command, "Set this up on a computer"', async ({ page }) => {
    let status: Record<string, unknown> = { current: '0.1.0', channel: 'stable', available: { version: '0.2.0', notes: 'Fixes', publishedAt: '2026-11-11T00:00:00.000Z', needsBackupRestoreToRollBack: false }, needsRoot: true, lastCheckedAt: null, previous: null, managed: false }
    await page.route('**/api/admin/update', (route) => route.fulfill({ json: status }))
    await signIn(page)
    await openSystem(page)
    await expect(page.getByTestId('system-row-updates')).toContainText(t['system.available'].replace('{version}', '0.2.0'))
    await page.getByTestId('system-row-updates').click()
    await expect(page.getByTestId('system-update')).toContainText(t['system.available'].replace('{version}', '0.2.0'))
    await expect(page.getByTestId('update-on-computer')).toContainText(t['admin.onComputerUpdate'])
    await expect(page.getByTestId('update-needs-root')).toHaveCount(0)
    await expect(page.getByText('sudo', { exact: false })).toHaveCount(0)
    status = { ...status, available: null, needsRoot: false, feed: false }
    await page.reload()
    await expect(page.getByTestId('system-update')).toContainText(t['system.noFeedShort'])
    await expect(page.getByTestId('update-on-computer')).toContainText(t['admin.onComputerNoFeed'])
    await expect(page.getByText(t['system.noFeed'])).toHaveCount(0)
  })

  test('backups: the last restore\'s line and a wrong password that stays in the dialog, as on a computer (TC-208, TC-221)', async ({ page }) => {
    await signIn(page)
    const last = { backupId: '20261110T030000Z-daily', backupCreatedAt: '2026-11-10T03:00:00.000Z', at: '2026-11-11T05:20:00.000Z', by: { id: 'olga', name: 'Olga' }, ok: true }
    await page.request.post('/__test/last-restore', { data: { last } })
    await page.goto('/admin/system/backups')
    await expect(page.getByTestId('last-restore')).toContainText('Olga')
    await page.getByTestId('backup-list').getByRole('button', { name: t['system.restore'] }).click()
    const dialog = page.getByRole('dialog', { name: t['system.restoreTitle'] })
    await dialog.getByTestId('reauth-password').fill('not my password')
    await dialog.getByTestId('reauth-confirm').click()
    await expect(dialog.getByRole('alert')).toBeVisible()
    await expect(dialog.getByTestId('reauth-password')).toHaveAttribute('aria-invalid', 'true')
    // the phone's Back closes the dialog first, then leaves the page
    await page.goBack()
    await expect(dialog).toHaveCount(0)
    await expect(page).toHaveURL(/\/admin\/system\/backups$/)
  })

  test.describe('a computer', () => {
    test.use({ viewport: { width: 1440, height: 900 }, hasTouch: false, isMobile: false })
    test('the one page as before, with its forms; a part\'s address opens the page', async ({ page }) => {
      await signIn(page)
      await page.goto('/admin/system/backups')
      await expect(page).toHaveURL(/\/admin\/system$/)
      await expect(page.getByTestId('backup-now')).toBeVisible()
      await expect(page.getByTestId('system-list')).toHaveCount(0)
      const titles = await page.getByTestId('system-page').locator(':scope > section > header h2').allInnerTexts()
      expect(titles).toEqual(OWNER_GROUPS.map((id) => t[LABEL[id]]))
      await expect(page.getByTestId('connected-source')).toBeVisible()
      await expect(page.getByRole('button', { name: t['system.changeMode'] })).toBeVisible()
      await expect(page.getByTestId('connected-on-computer')).toHaveCount(0)
      await expect(page.getByTestId('connection-on-computer')).toHaveCount(0)
    })
  })
}
