// Five small QA findings (TC-3839..TC-3843): the picked "Everyone on the team" row is read whole; owners and admins get no
// "Try again" (or ⓘ) under an engine_start_failed answer while members keep it; an app sender's name shows no focus ring
// after a mouse close but does after Tab; Admin › System puts a held version's reason in view and asks before a retry.
// QA_1116_SHOTS names a folder: screenshots at 1440 and 390, light and dark.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER, FILE_SHARE_EVERYONE } from '@mycel/shared/api'
import { DICTS } from '../../src/i18n'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'
import { appMessage, mockApp, routeRoomApps } from './room-apps-mock'

const SHOTS = process.env.QA_1116_SHOTS
const t = DICTS.en
const OLGA = { username: 'olga', password: 'correct horse battery' }
const BOB = { username: 'bob', password: 'bob password 1' }
const SIZES = [[1440, 900], [390, 844]] as const

test.use({ serviceWorkers: 'block', locale: 'en-US' })
test.describe.configure({ timeout: SHOTS ? 180_000 : 60_000 })

async function shots(page: Page, name: string) {
  if (!SHOTS) return
  await page.mouse.move(0, 0)
  const keep = page.viewportSize()!
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h })
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme })
      await page.waitForTimeout(250)
      await page.screenshot({ path: `${SHOTS}/${name}-${w}-${theme}.png` })
    }
  }
  await page.setViewportSize(keep)
  await page.emulateMedia({ colorScheme: 'light' })
}

test('TC-3839: the picked "Everyone on the team" row shows its whole description at 1440 and 390', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true, withAdmin: true })
  expect((await page.request.post('/__test/file-shares', { headers: { [CSRF_HEADER]: '1' }, data: {} })).ok()).toBeTruthy()
  expect((await page.request.post('/__test/file', { headers: { [CSRF_HEADER]: '1' }, data: { path: 'users/olga/a.md', text: '# a' } })).ok()).toBeTruthy()
  await signIn(page, OLGA)
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h })
    await page.goto(`/files?path=${encodeURIComponent('users/olga')}`)
    const row = page.getByTestId('file-row').filter({ hasText: 'a.md' })
    await row.hover()
    await row.getByTestId('file-menu').click()
    await page.getByRole('menuitem', { name: t['folderAccess.menu'], exact: true }).click()
    await page.getByTestId('file-share-picker-search').click()
    await page.getByTestId(`participant-add-group-${FILE_SHARE_EVERYONE}`).click()
    const picked = page.getByTestId(`participant-group-${FILE_SHARE_EVERYONE}`)
    await expect(picked).toContainText(t['fileShare.everyoneKind'])
    const cut = await picked.evaluate((li) => [...li.querySelectorAll('*')].filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== 'visible').map((e) => e.textContent))
    expect(cut, `cut text at ${w}`).toEqual([])
    await shots(page, `3839-picked-${w}`)
  }
})

for (const who of [OLGA, BOB]) {
  test(`TC-3840/3841: engine_start_failed as ${who.username}`, async ({ page }) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page, who)
    await page.getByTestId('composer-input').fill('error:engine_start_failed\nwhy')
    await page.getByTestId('send').click()
    const a = page.getByTestId('assistant-message').last()
    await expect(a).toHaveAttribute('data-status', 'error')
    const box = a.getByTestId('answer-error')
    await expect(box).toBeVisible()
    await expect(a.getByTestId('answer-model')).toHaveCount(0)
    if (who === OLGA) {
      await expect(box).toContainText("Trying again won't help")
      await expect(box.getByTestId('retry')).toHaveCount(0)
      await expect(box.getByTestId('retry-other-model')).toHaveCount(0)
    } else {
      await expect(box.getByTestId('retry')).toBeVisible()
    }
    await shots(page, `3840-${who.username}`)
  })
}

test('TC-3842: an app sender shows no focus ring after a mouse close, and does after Tab', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  const MINA = { id: 'mina', name: 'Mina' }
  const app = mockApp('sentry')
  await routeRoom(page, { kind: 'team', members: [MINA], messages: [{ id: '019a5f00-0000-7000-8000-00000000c001', author: MINA, body: '', extra: appMessage(app, { title: 'Happened again' }) }], room: { name: 'dev' } })
  await routeRoomApps(page, { apps: [{ ...app }] })
  await signIn(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/rooms/${ROOM_ID}`)
  const sender = page.getByTestId('app-sender-button').first()
  await sender.click()
  await page.getByTestId('app-sender-manage').click()
  await expect(page.getByTestId('apps-settings')).toBeVisible()
  // closed with the mouse: the dialog's own close button
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: /close/i }).first().click()
  await expect(page.getByTestId('apps-settings')).toHaveCount(0)
  const outline = () => sender.evaluate((el) => getComputedStyle(el).outlineStyle + ' ' + getComputedStyle(el).outlineWidth)
  expect(await outline()).toMatch(/^none/)
  await shots(page, '3842-after-mouse-close')
  // the keyboard: Tab to it shows the ring
  await page.mouse.click(700, 500)
  await sender.focus()
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  await expect(sender).toBeFocused()
  expect(await outline()).toMatch(/^solid 2px/)
})

const HELD = { current: '0.5.7', channel: 'stable', available: { version: '0.5.8', notes: '', publishedAt: new Date().toISOString(), needsBackupRestoreToRollBack: false }, lastCheckedAt: new Date().toISOString(), previous: '0.5.6', feed: true, needsRoot: false, auto: true, managed: false, hold: 'failed', holdReason: 'verify failed: /api/health did not answer in 60 s' }
test('TC-3843: a held version says why, has no Install update, and "Try this version again" asks first', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await page.route('**/api/admin/update', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: HELD }) : r.fallback()))
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h })
    await page.goto('/admin/system/updates')
    // a phone opens the list first
    if (w < 500) await page.getByText(t['system.updates'], { exact: true }).first().click()
    await expect(page.getByTestId('update-held')).toContainText('tried again by itself later')
    await expect(page.getByTestId('update-held-why')).toContainText('verify failed')
    await expect(page.getByRole('button', { name: t['system.installUpdate'] })).toHaveCount(0)
    await expect(page.getByTestId('update-retry')).toHaveText(t['system.retryShort'])
    if (SHOTS && w < 500) {
      // the phone's card: a screenshot here, not shots(), which would resize the window and show the list again
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme })
        await page.getByTestId('update-held').scrollIntoViewIfNeeded()
        await page.screenshot({ path: `${SHOTS}/3843-held-card-390-${theme}.png` })
      }
      await page.emulateMedia({ colorScheme: 'light' })
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByTestId('update-retry').click()
  await expect(page.getByRole('dialog')).toContainText('0.5.8')
  await expect(page.getByRole('dialog')).toContainText('failed')
  await shots(page, '3843-retry-confirm')
  // Admin Home offers the same retry, with the same confirm
  await page.goto('/admin')
  await expect(page.getByTestId('home-update-install')).toHaveText(t['system.retryShort'])
  await page.getByTestId('home-update-install').click()
  await expect(page.getByRole('dialog')).toContainText('Try version 0.5.8 again?')
  await page.keyboard.press('Escape')
  // an unheld version still offers Install update
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.unroute('**/api/admin/update')
  await page.route('**/api/admin/update', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: { ...HELD, hold: null, holdReason: null } }) : r.fallback()))
  await page.goto('/admin/system/updates')
  await expect(page.getByRole('button', { name: t['system.installUpdate'] })).toBeVisible()
})
