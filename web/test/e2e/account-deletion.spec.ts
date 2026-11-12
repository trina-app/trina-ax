// Settings › Profile › Request account deletion (/settings/account/delete; contract: shared/src/api/account-deletion.ts):
// a member asks, sees when they asked and can take it back; the owner's Members list marks the person while it is open;
// the owner cannot ask and is sent to Members & invites. A phone reaches the page from the profile's own row.
import { expect, test, type Page } from '@playwright/test'
import { DICTS } from '../../src/i18n'
import { reset, signIn } from './helpers'

const t = DICTS.en
const BOB = { username: 'bob', password: 'bob password 1' }

async function openPage(page: Page) {
  await page.goto('/settings/profile')
  await page.getByTestId('account-deletion-link').click()
  await expect(page).toHaveURL(/\/settings\/account\/delete$/)
  await expect(page.getByRole('heading', { name: t['accountDeletion.title'] })).toBeVisible()
}

test('a member asks, the owner sees it in Members, the member takes it back', async ({ page, browser }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page, BOB)
  await openPage(page)
  await expect(page.getByTestId('account-deletion-none')).toContainText('the team owner and the admins are told')
  await page.getByTestId('account-deletion-request').click()
  await expect(page.getByText(t['accountDeletion.sent'])).toBeVisible()
  await expect(page.getByTestId('account-deletion-pending')).toContainText('You asked on')
  // asked again after a reload: still pending (the server keeps it)
  await page.reload()
  await expect(page.getByTestId('account-deletion-pending')).toBeVisible()

  // the owner's Members list marks Bob while the request is open
  const owner = await browser.newContext()
  const op = await owner.newPage()
  await signIn(op)
  await op.goto('/admin/members')
  const row = op.getByTestId('members-table').getByRole('row').filter({ hasText: 'Bob' })
  await expect(row.getByTestId('member-deletion-requested')).toHaveText(t['accountDeletion.badge'])

  await page.getByTestId('account-deletion-cancel').click()
  await expect(page.getByText(t['accountDeletion.cancelled'])).toBeVisible()
  await expect(page.getByTestId('account-deletion-none')).toBeVisible()
  await op.reload()
  await expect(op.getByTestId('members-table')).toContainText('Bob')
  await expect(op.getByTestId('member-deletion-requested')).toHaveCount(0)
  await owner.close()
})

test('the owner cannot ask: the page sends them to Members & invites', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await openPage(page)
  await expect(page.getByTestId('account-deletion-owner')).toContainText('cannot be deleted by request')
  await expect(page.getByTestId('account-deletion-request')).toHaveCount(0)
  await page.getByTestId('account-deletion-transfer').click()
  await expect(page).toHaveURL(/\/admin\/members$/)
})

test('a phone: the profile\'s row opens the page full width; asking and cancelling work the same', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await page.setViewportSize({ width: 390, height: 760 })
  await signIn(page, BOB)
  await openPage(page)
  const request = page.getByTestId('account-deletion-request')
  await expect(request).toBeInViewport()
  const box = (await page.getByTestId('account-deletion').boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  expect(box.width).toBeGreaterThanOrEqual(340)
  await request.click()
  await expect(page.getByTestId('account-deletion-pending')).toBeVisible()
  await page.getByTestId('account-deletion-cancel').click()
  await expect(page.getByTestId('account-deletion-none')).toBeVisible()
})
