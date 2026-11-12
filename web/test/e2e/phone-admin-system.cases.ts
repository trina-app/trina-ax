// Admin › System on a phone (390×844, touch; pages/admin/systemGroups.ts), the QA rows' steps as they say them:
// - TC-269 step 1: "Admin › System" → "A list of pages like Team settings (not one 2,500px page)": storage, version and
//   updates, health, connection, connected folders, backups and export, each a page under "‹ System"; ‹ and Back return
//   to the list. An admin has the storage (and the automatic updates in office mode).
// - TC-270 step 1: "Admin › System (connected folders, backups)" → "A status row plus '컴퓨터에서 설정해요' instead of the
//   forms": the folder path form, the connection mode change and the update's server command.
// The restore result line and the wrong-password dialog (TC-208, TC-221) work the same in the backups page. A computer
// keeps the one page. Each test runs in WebKit (the iPhone app's engine: phone-admin-system.webkit.spec.ts) and Chromium
// (Android's: phone-admin-system.spec.ts).
// Follow-ups found on a real server at 390×844 (systemFollowUps below):
// - TC-269 step 1: a backup row is a tidy list row: the date and size on one line, the kind under it, Restore on the
//   right (the badges and Restore left the date one word per line).
// - TC-270 step 3 (ADM-15): Admin › AI apps with the connector off: the Off status and "Set this up on a computer", no
//   installer flag, server.json line or environment variable to copy; the app rows stay.
// - Every page pushed under Admin (/admin/<section>/<sub>: an item's page, a group of Team settings or System) names the
//   page ‹ returns to, shown whole beside its title (an engine's page, and Team settings' "Members and AI" and "Company
//   profile", QA TC-381, showed ‹ alone: the name did not fit beside a centred title).
// - TC-269 step 2: a plugin's page is the plugin alone: no plugin search and no upload button above it.
import { expect, test, type Page } from '@playwright/test'
import { HWP_PLUGIN_ID } from '@mycel/shared/hwp'
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

/** Backups with the longest names (the real server's 'Before schema change' · 'Database only' row) */
const BACKUPS = {
  items: [
    { id: '20261112T093000Z-pre-migrate', kind: 'pre-migrate', createdAt: '2026-11-12T09:30:00.000Z', size: 2_400_000, scope: 'db' },
    { id: '20261111T030000Z-daily', kind: 'daily', createdAt: '2026-11-11T03:00:00.000Z', size: 123_456_789, scope: 'full' },
    { id: '20261110T030000Z-pre-update', kind: 'pre-update', createdAt: '2026-11-10T03:00:00.000Z', size: 45_678, scope: 'incremental' },
  ],
  lastRestore: null,
}
const remoteOff = { configured: false, resource: null, items: [] }
/** Team settings' groups (teamSettingsGroups.ts; the dev environment's is off on the mock server) */
const TEAM_SETTINGS_IDS = ['general', 'data', 'members', 'voice', 'ai', 'limits', 'file-list', 'company'] as const

/** ‹'s label is shown whole (not hidden for want of room), left of the title, and the title is not cut */
async function expectBackNamed(page: Page, name: string, where: string) {
  const label = backLabel(page)
  await expect(label, where).toHaveText(name)
  await expect(label, where).toBeVisible()
  await expect(page.getByTestId('admin-back')).toHaveAccessibleName(t['tabs.backTo'].replace('{page}', name))
  const l = (await label.boundingBox())!
  // the title's text (its box is the bar's middle column)
  const title = await bar(page).evaluate((el) => {
    const r = document.createRange()
    r.selectNodeContents(el)
    return { x: r.getBoundingClientRect().x }
  })
  expect(l.x + l.width, where).toBeLessThanOrEqual(title.x + 1)
  expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), where).toBe(true)
  expect(await bar(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1), where).toBe(true)
}

export function systemFollowUps() {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'en-US', serviceWorkers: 'block' })

  test.beforeEach(async ({ page }) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  })

  test('TC-269 step 1: Backups: each row has its date and size on one line, its kind under it and Restore on the right', async ({ page }) => {
    await page.route('**/api/admin/backups', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: BACKUPS }) : route.fallback()))
    await signIn(page)
    await openSystem(page)
    await page.getByTestId('system-row-backups').click()
    await expect(page).toHaveURL(/\/admin\/system\/backups$/)
    const rows = page.getByTestId('backup-row')
    await expect(rows).toHaveCount(3)
    for (const row of await rows.all()) {
      const when = row.getByTestId('backup-when')
      const box = (await when.boundingBox())!
      const lineHeight = await when.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight))
      // one line (two at most), as wide as the row allows: not one word per line
      expect(box.height).toBeLessThanOrEqual(2 * lineHeight + 1)
      expect(box.width).toBeGreaterThan(200)
      // the kind under the date
      const badges = (await row.getByTestId('backup-badges').boundingBox())!
      expect(badges.y).toBeGreaterThanOrEqual(box.y + box.height - 1)
      // Restore on the right, a 44 px target
      const restore = (await row.getByRole('button', { name: t['system.restore'] }).boundingBox())!
      expect(restore.x).toBeGreaterThanOrEqual(box.x + box.width)
      expect(Math.round(restore.height)).toBeGreaterThanOrEqual(44)
      expect(Math.round(restore.x + restore.width)).toBeLessThanOrEqual(390)
    }
    // the 'Before schema change' · 'Database only' row in full
    await expect(rows.first()).toContainText(t['system.backupKind.pre-migrate'])
    await expect(rows.first()).toContainText(t['system.backupScope.db'])
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    // Restore still asks for the password (TC-208, TC-221: the same dialog)
    await rows.first().getByRole('button', { name: t['system.restore'] }).click()
    await expect(page.getByRole('dialog', { name: t['system.restoreTitle'] })).toBeVisible()
  })

  test('TC-270 step 3: AI apps with the connector off: the Off status and "Set this up on a computer", no setup commands; the app rows stay', async ({ page }) => {
    await page.route('**/api/connectors/remote', (route) => route.fulfill({ json: remoteOff }))
    await signIn(page)
    await page.getByTestId('tab-me').click()
    await page.getByTestId('settings-admin').click()
    await page.getByTestId('admin-row-ai-apps').click()
    await expect(page).toHaveURL(/\/admin\/ai-apps$/)
    const pageEl = page.getByTestId('admin-ai-apps')
    await expect(pageEl).toHaveAttribute('data-on', 'false')
    await expect(pageEl).toContainText(t['appConnectors.off'])
    const onComputer = page.getByTestId('ai-apps-on-computer')
    await expect(onComputer).toContainText(t['admin.onComputer'])
    await expect(onComputer).toContainText(t['admin.onComputerAiApps'])
    // no server setup to copy on a phone
    await expect(page.getByTestId('ai-apps-setup')).toHaveCount(0)
    for (const id of ['ai-apps-setup-installer', 'ai-apps-setup-json', 'ai-apps-setup-env']) await expect(page.getByTestId(id)).toHaveCount(0)
    await expect(page.getByText(t['aiApps.offAdmin'])).toHaveCount(0)
    for (const text of ['--app-connectors', 'appConnectors', 'REMOTE_MCP_ORIGIN', 'server.json']) await expect(pageEl).not.toContainText(text)
    // the app rows: Claude, Claude Code and Codex ('Set this up on a computer'), other apps
    const list = page.getByTestId('admin-ai-app-list')
    for (const id of ['claude', 'claude-code', 'codex', 'other']) await expect(list.getByTestId(`ai-app-${id}`)).toBeVisible()
    for (const id of ['claude-code', 'codex']) await expect(list.getByTestId(`ai-app-${id}`)).toContainText(t['admin.onComputer'])
  })

  test('every item\'s page and group names the page ‹ returns to, whole: an engine\'s page under "‹ Team AI accounts" (TC-381)', async ({ page }) => {
    await signIn(page)
    // the row's steps: Team AI accounts › Claude Code
    await page.getByTestId('tab-me').click()
    await page.getByTestId('settings-admin').click()
    await page.getByTestId('admin-row-providers').click()
    await page.locator('[data-testid="engine-row"][data-engine="claude-code"]').click()
    await expect(page).toHaveURL(/\/admin\/providers\/claude-code$/)
    await expect(bar(page)).toHaveText('Claude Code')
    await expectBackNamed(page, t['admin.team.providers'], 'claude-code, tapped')
    await page.getByTestId('admin-back').click()
    await expect(page).toHaveURL(/\/admin\/providers$/)
    // each kind of item's page, opened from outside (the pages above it put under it)
    const pages: [string, string][] = [
      ['/admin/providers/claude-code', t['admin.team.providers']],
      ['/admin/providers/codex', t['admin.team.providers']],
      ['/admin/connectors/google-drive', t['admin.team.integrations']],
      ['/admin/connectors/calendar', t['admin.team.integrations']],
      [`/admin/plugins/${HWP_PLUGIN_ID}`, t['admin.plugins']],
      ['/admin/members/bob', t['admin.members']],
      // every group of Team settings ("Members and AI" and "Company profile" showed ‹ alone: QA TC-381) and of System
      ...TEAM_SETTINGS_IDS.map((id): [string, string] => [`/admin/settings/${id}`, t['admin.settings']]),
      ...OWNER_GROUPS.map((id): [string, string] => [`/admin/system/${id}`, t['admin.system']]),
    ]
    for (const [url, name] of pages) {
      await page.goto(url)
      await expect(page).toHaveURL(new RegExp(`${url.replace(/[.]/g, '\\.')}$`))
      await expect(bar(page)).not.toHaveText('')
      await expectBackNamed(page, name, url)
    }
    // a group's page and an Activity log record's, from their lists
    await page.goto('/admin/groups')
    await page.getByTestId('group-row').first().getByTestId('row-open').click()
    await expect(page).toHaveURL(/\/admin\/groups\/[^/]+$/)
    await expect(bar(page)).not.toHaveText('')
    await expectBackNamed(page, t['admin.groups'], 'a group')
    await page.goto('/admin/audit')
    await page.getByTestId('activity-row').first().getByRole('button').click()
    await expect(page).toHaveURL(/\/admin\/audit\/[^/?]+/)
    await expectBackNamed(page, t['admin.audit'], 'an Activity log record')
  })

  test('TC-269 step 2: a plugin\'s page is the plugin alone: no plugin search, no upload button; the list keeps them', async ({ page }) => {
    await signIn(page)
    await page.goto('/admin/plugins')
    await expect(page.getByTestId('plugin-search')).toBeVisible()
    const card = page.getByTestId('plugin-catalog').first()
    await card.getByTestId('plugin-open').click()
    await expect(page).toHaveURL(/\/admin\/plugins\/[^/]+$/)
    const detail = page.getByTestId('plugin-detail')
    await expect(detail).toBeVisible()
    await expect(page.getByTestId('plugin-search')).toHaveCount(0)
    await expect(page.getByTestId('plugin-install-file')).toHaveCount(0)
    await expect(page.getByTestId('plugins-header')).toHaveCount(0)
    // the plugin's card is the first thing under the bar
    const barBottom = (await page.getByTestId('phone-page-bar').boundingBox())!
    expect((await detail.boundingBox())!.y).toBeLessThan(barBottom.y + barBottom.height + 40)
    await page.getByTestId('admin-back').click()
    await expect(page).toHaveURL(/\/admin\/plugins$/)
    await expect(page.getByTestId('plugin-search')).toBeVisible()
  })

  test.describe('a computer', () => {
    test.use({ viewport: { width: 1440, height: 900 }, hasTouch: false, isMobile: false })
    test('backups as one line each, the AI apps setup lines, and a plugin\'s page with the search row, as before', async ({ page }) => {
      await page.route('**/api/admin/backups', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: BACKUPS }) : route.fallback()))
      await page.route('**/api/connectors/remote', (route) => route.fulfill({ json: remoteOff }))
      await signIn(page)
      await page.goto('/admin/system')
      await expect(page.getByTestId('backup-list').locator('li')).toHaveCount(3)
      await expect(page.getByTestId('backup-row')).toHaveCount(0)
      await page.goto('/admin/ai-apps')
      await expect(page.getByTestId('ai-apps-setup-installer')).toBeVisible()
      await expect(page.getByTestId('ai-apps-on-computer')).toHaveCount(0)
      await page.goto(`/admin/plugins/${HWP_PLUGIN_ID}`)
      await expect(page.getByTestId('plugin-detail')).toBeVisible()
      await expect(page.getByTestId('plugin-search')).toBeVisible()
    })
  })
}
