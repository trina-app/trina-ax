// The team's disk filling (docs/decisions/20261116-storage-full-notices.md): the owner and admins find a notice in
// Activity that says how full and how much the files in conversations take, and opens the storage card; a member gets
// none.
import { expect, test } from '@playwright/test'
import { reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'

const en = DICTS.en

for (const width of [1440, 390]) {
  test(`storage filling at ${width}: the owner's Activity notice opens the storage card; a member has none`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    expect((await page.request.post('/__test/storage-notice', { data: { percent: 82, roomsBytes: 6.4 * 1024 ** 3 } })).ok()).toBeTruthy()
    await signIn(page)
    await page.goto('/activity')
    const words = 'Storage is 82% full. Files in conversations take 6.4 GB. See what uses the space.'
    // the row opens the storage card (a phone's System › Storage; a computer lands on the card)
    await page.getByText(words).first().click()
    await expect(page).toHaveURL(width < 600 ? /\/admin\/system\/storage$/ : /\/admin\/system#system-storage$/)
    await expect(page.getByTestId('storage-part-rooms')).toContainText('6.4 GB')

    // a member: nothing in Activity
    await page.context().clearCookies()
    await signIn(page, { username: 'bob', password: 'bob password 1' })
    await page.goto('/activity')
    await expect(page.getByText(en['notifications.event.storage.filling'])).toHaveCount(0)
    await expect(page.getByText('Storage is 82% full')).toHaveCount(0)
  })
}
