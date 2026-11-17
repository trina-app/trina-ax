// "Ask people to clean up" on the storage card (docs/decisions/20261116-room-files-cleanup.md): the owner asks after a
// confirm that says they won't see who; then "Asked today", also after a reload; Cancel sends nothing.
import { expect, test } from '@playwright/test'
import { reset, signIn } from './helpers'

for (const width of [1440, 390]) {
  test(`ask people to clean up at ${width}: confirm, Cancel, Ask, Asked today`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page)
    await page.goto(width < 600 ? '/admin/system/storage' : '/admin/system')
    const button = page.getByTestId('storage-ask-cleanup')
    await expect(button).toHaveText('Ask people to clean up')
    await button.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText("You won't see who.")
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(button).toHaveText('Ask people to clean up')
    await button.click()
    await page.getByRole('dialog').getByRole('button', { name: 'Ask', exact: true }).click()
    await expect(button).toHaveText('Asked today')
    await expect(button).toBeDisabled()
    await page.reload()
    await expect(page.getByTestId('storage-ask-cleanup')).toHaveText('Asked today')
  })
}
