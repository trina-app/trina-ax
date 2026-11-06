// A Google Drive an admin shares with the team (components/integrations/DriveShares.tsx, DriveConnector.tsx
// DriveTeamShares; server/src/integrations/google-drive/shares.ts). Admin › Connectors › Google Drive: "Share a Google
// Drive with the team" signs in with Google (mocked here: the test server answers the flow, Google's page is a
// synthetic one), one line confirms the account, then the name, folders (with search; the whole Drive only with a
// warning) and who may use it. A row then shows the account, its folders and how many people use it, with ⋯. A member
// it is for sees "Shared by your team" with only the chosen folders, with nothing to connect. The server's folder
// limit itself is tested in tests/unit/c-drive-shares.test.ts.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const card = (page: Page) => page.getByTestId('drive-admin-detail')
const openDrive = async (page: Page) => { await page.goto('/admin/connectors?drive=1'); await expect(card(page)).toBeVisible() }

async function setUpClient(page: Page) {
  await openDrive(page)
  await card(page).getByTestId('drive-setup').click()
  const dialog = page.getByRole('dialog', { name: 'Google Drive 설정' })
  await dialog.getByTestId('drive-setup-id').fill('synthetic.apps.googleusercontent.com')
  await dialog.getByTestId('drive-setup-secret').fill('synthetic-secret')
  await dialog.getByTestId('drive-setup-save').click()
  await expect(dialog).toHaveCount(0)
}

/** The admin shares Finance with everyone: Google sign-in (mocked), confirm, folders, people, Save. */
async function shareFinance(page: Page) {
  await page.context().route('https://accounts.google.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>Synthetic Google consent</p>' }))
  await card(page).getByTestId('drive-share-add').click()
  const dialog = page.getByRole('dialog', { name: 'Google Drive 공유' })
  await expect(dialog.getByTestId('drive-share-name')).toHaveValue('회사 Drive')
  const popup = page.waitForEvent('popup')
  await dialog.getByTestId('drive-share-google').click()
  await popup
  await expect(dialog.getByTestId('drive-share-account')).toContainText('drive-admin@example.test')
  await dialog.getByTestId('drive-share-confirm').click()
  await expect(dialog.getByTestId('drive-share-dialog')).toHaveAttribute('data-step', 'settings')
  await expect(dialog.getByTestId('drive-share-signed-in')).toContainText('drive-admin@example.test')
  // top-level folders and shared drives; search finds folders below them
  await expect(dialog.getByTestId('drive-share-folder')).toHaveCount(4)
  await dialog.getByTestId('drive-share-folder-search').fill('Q3')
  await expect(dialog.getByTestId('drive-share-folder')).toHaveCount(1)
  await dialog.getByTestId('drive-share-folder-search').fill('')
  await dialog.locator('[data-testid="drive-share-folder"][data-id="folder-finance"]').check()
  await expect(dialog.getByTestId('drive-share-chosen')).toContainText('Finance')
  // the whole Drive only with its warning
  await dialog.getByTestId('drive-share-whole').check()
  await expect(dialog.getByTestId('drive-share-whole-warning')).toBeVisible()
  await dialog.getByTestId('drive-share-whole').uncheck()
  await dialog.getByTestId('integration-access-everyone').check()
  const saved = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().includes('/api/admin/google-drive/shares/'))
  await dialog.getByTestId('drive-share-save').click()
  expect((await saved).postDataJSON()).toMatchObject({ name: '회사 Drive', folders: ['folder-finance'], wholeDrive: false, access: { everyone: true } })
  await expect(dialog).toHaveCount(0)
}

test('an admin shares a Drive: sign in with Google, confirm, choose folders and people; the row and the state say so', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await setUpClient(page)
  await expect(card(page).getByTestId('drive-admin-state')).toHaveText('설정 대기')
  await expect(card(page).getByTestId('drive-shares-empty')).toBeVisible()
  const errors = watchConsole(page)
  await shareFinance(page)
  const row = card(page).getByTestId('drive-share-row')
  await expect(row).toHaveCount(1)
  await expect(row.getByTestId('drive-share-row-line')).toContainText('drive-admin@example.test')
  await expect(row.getByTestId('drive-share-detail')).toContainText('Finance')
  await expect(row.getByTestId('drive-share-detail')).toContainText('명이 사용')
  await expect(card(page).getByTestId('drive-admin-state')).toHaveText('켜짐')
  // ⋯: change folders or people, reconnect, stop sharing
  await row.getByTestId('drive-share-menu').click()
  await expect(row.getByRole('menuitem', { name: '폴더나 사람 바꾸기' })).toBeVisible()
  await expect(row.getByRole('menuitem', { name: '다시 연결' })).toBeVisible()
  await row.getByRole('menuitem', { name: '공유 중지' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '공유 중지', exact: true }).click()
  await expect(card(page).getByTestId('drive-shares-empty')).toBeVisible()
  await expect(card(page).getByTestId('drive-admin-state')).toHaveText('설정 대기')
  expect(realErrors(errors)).toEqual([])
})

test('a member sees the shared Drive with only its folders, and their own Connect follows the switch', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await setUpClient(page)
  await shareFinance(page)
  await page.context().clearCookies()
  await signIn(page, { username: 'bob', password: 'bob password 1' })
  await page.goto('/settings/connectors')
  const shared = page.getByTestId('yours-drive').getByTestId('drive-team-share')
  await expect(shared).toContainText('팀이 공유한 Drive: 회사 Drive')
  await expect(shared).toContainText('폴더: Finance')
  await expect(shared).not.toContainText('HR')
  // the switch is off: no Connect for their own Drive
  await page.goto('/settings/drive')
  await expect(page.getByTestId('drive-detail').getByTestId('drive-team-share')).toContainText('회사 Drive')
  await expect(page.getByTestId('drive-detail').getByTestId('drive-connect')).toHaveCount(0)
  // on: both
  await page.context().clearCookies()
  await signIn(page)
  await openDrive(page)
  await card(page).getByTestId('drive-members-switch').check({ force: true })
  await page.context().clearCookies()
  await signIn(page, { username: 'bob', password: 'bob password 1' })
  await page.goto('/settings/drive')
  await expect(page.getByTestId('drive-detail').getByTestId('drive-connect')).toBeEnabled()
  await expect(page.getByTestId('drive-detail').getByTestId('drive-team-share')).toContainText('회사 Drive')
})

test('phone width and accessibility: the page with a share and the share dialog fit, with no serious problems in both themes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  await signIn(page)
  await setUpClient(page)
  await shareFinance(page)
  const row = await card(page).getByTestId('drive-share-row').boundingBox(), box0 = await card(page).boundingBox()
  expect(row!.x + row!.width).toBeLessThanOrEqual(box0!.x + box0!.width + 1)
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await card(page).getByTestId('drive-share-add').click()
    const box = await page.getByRole('dialog').boundingBox()
    expect(box!.width).toBeLessThanOrEqual(390)
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
    expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([])
    await page.getByRole('dialog').getByRole('button', { name: '취소' }).click()
  }
})
