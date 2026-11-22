// The two folder cards' own "Always allow" (docs/decisions/20261116-sharing-all-integration.md, Rule A; the mock scripts
// them with "sharecard folder always", "folderaccess" and "folderaccess links"): share_folder offers "Always allow" with
// its own risk words under the three buttons, and once chosen the next folder share has no card; the admin's
// change_folder_access card shows the folder, who gains and loses access and the counts, with Change / Always allow /
// Cancel and its own risk words, and turns into the team folder card (TeamFolderCard: no button); the narrowing card that
// also asks about file shares has four choices, its file shares line in the card's lines and the always words under the
// choices; with Always allow on, the narrowing has no card and the result says the file shares stay. Both kinds are listed
// in Settings › Allowed for Trina in plain words. No path on a card. SHOTS_DIR=<folder>: each state at 1440 and 390,
// light and dark.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const lastAnswer = (page: Page) => page.getByTestId('assistant-message').last()
async function ask(page: Page, text: string) {
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('send').click()
}
async function newChat(page: Page) {
  await page.goto('/')
  await page.getByTestId('composer-input').waitFor()
}
async function shot(page: Page, name: string, at: Locator) {
  if (!process.env.SHOTS_DIR) return
  fs.mkdirSync(process.env.SHOTS_DIR, { recursive: true })
  await at.scrollIntoViewIfNeeded()
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(250)
    await page.screenshot({ path: path.join(process.env.SHOTS_DIR, `folder-cards-${name}-${page.viewportSize()!.width}-${scheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}
/** nothing on the card wider than the screen (a phone) */
async function fits(page: Page, card: Locator) {
  const box = (await card.boundingBox())!
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1)
}
const start = async (page: Page) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  const errors = watchConsole(page)
  await signIn(page)
  return errors
}

for (const width of [1440, 390]) {
  test.describe(`${width} px`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 900 } })

    test('share_folder: the card offers Always allow with the folder words; chosen, the folder is shared and the next folder share has no card; Settings lists it', async ({ page }) => {
      const errors = await start(page)
      await ask(page, 'sharecard folder always share QA-test with Bob')
      const card = page.getByTestId('ask-card')
      await expect(card).toHaveAttribute('data-kind', 'buttons')
      await expect(card.getByTestId('share-ask-title')).toHaveText('Share QA-test with Bob?')
      await expect(card.getByTestId('share-card-folder')).toBeVisible()
      await expect(card.getByTestId('ask-choice')).toHaveText(['Share', 'Always allow', "Don't share"])
      await expect(card.getByTestId('ask-note')).toHaveText('From now on Trina shares your folders without asking, even when a file or message tells it to. Undo it in Settings › Allowed for Trina.')
      await expect(card).not.toContainText('users/')
      await fits(page, card)
      await shot(page, 'share-folder-always-offered', card)
      await card.getByRole('button', { name: 'Always allow', exact: true }).click()
      await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
      await expect(page.getByTestId('ask-card')).toHaveCount(0)
      await expect(lastAnswer(page).getByTestId('share-card').getByTestId('action-card-title')).toHaveText('Shared QA-test with Bob')
      // the next folder share: no card, straight to the result
      await newChat(page)
      await ask(page, 'sharecard folder always share QA-test with Bob again')
      await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
      await expect(page.getByTestId('ask-card')).toHaveCount(0)
      const result = lastAnswer(page).getByTestId('share-card')
      await expect(result.getByTestId('action-card-title')).toHaveText('Shared QA-test with Bob')
      await shot(page, 'share-folder-always-no-card', result)
      await page.goto('/settings/allowances')
      const rows = page.getByTestId('allowance-row')
      await expect(rows).toHaveCount(1)
      await expect(rows.first()).toContainText('Sharing my folders with people')
      expect(realErrors(errors)).toEqual([])
    })

    test('change_folder_access: the card (who gains and loses, Change / Always allow / Cancel, its own words) turns into the team folder card; Cancel changes nothing', async ({ page }) => {
      const errors = await start(page)
      await ask(page, 'folderaccess give the Sales group view on Reports')
      const card = page.getByTestId('ask-card')
      await expect(card).toHaveAttribute('data-kind', 'buttons')
      await expect(card).toContainText('Give the Sales group view access to Company-wide › Reports?')
      await expect(card.getByTestId('ask-details')).toContainText('Gets access: Bob, Mina, Jun')
      await expect(card.getByTestId('ask-choice')).toHaveText(['Change', 'Always allow', 'Cancel'])
      await expect(card.getByTestId('ask-note')).toContainText('From now on Trina changes who can open team folders without asking')
      await expect(card).not.toContainText('shared/')
      await fits(page, card)
      await shot(page, 'folder-access-card', card)
      await card.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
      await expect(lastAnswer(page).getByTestId('team-folder-card')).toHaveCount(0)
      await newChat(page)
      await ask(page, 'folderaccess give the Sales group view on Reports')
      await page.getByTestId('ask-card').getByRole('button', { name: 'Change', exact: true }).click()
      await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
      const result = lastAnswer(page).getByTestId('team-folder-card')
      await expect(result.getByTestId('action-card-title')).toHaveText(/^The Sales group( \(3 people\))? can now view Reports$/)
      await expect(result.getByTestId('team-folder-card-folder')).toContainText('Company-wide › Reports')
      await expect(result.getByTestId('team-folder-card-note').first()).toHaveText('4 people could open it before, 7 now.')
      await expect(result.getByRole('button')).toHaveCount(0)
      await shot(page, 'folder-access-result', result)
      expect(realErrors(errors)).toEqual([])
    })

    test('a narrowing that also asks about file shares: four choices, the file shares line in the card, the always words under it; Always allow then means no card and the file shares stay', async ({ page }) => {
      const errors = await start(page)
      await ask(page, 'folderaccess links take Sales off Reports')
      const card = page.getByTestId('ask-card')
      await expect(card).toContainText('Take the Sales group off Company-wide › Reports?')
      await expect(card.getByTestId('ask-details')).toContainText('Files inside are shared one by one with 1 person.')
      for (const l of ['Change and remove file shares', 'Change, keep file shares', 'Always allow', 'Cancel']) await expect(card.getByText(l, { exact: true })).toBeVisible()
      await expect(card.getByTestId('ask-note')).toContainText('Files inside that were shared one by one stay shared.')
      await fits(page, card)
      await shot(page, 'folder-access-links-card', card)
      await card.getByRole('button', { name: 'Always allow', exact: true }).click()
      await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
      const result = lastAnswer(page).getByTestId('team-folder-card')
      await expect(result.getByTestId('action-card-title')).toHaveText(/^Took the Sales group( \(3 people\))? off Reports$/)
      await expect(result.getByTestId('team-folder-card-note').last()).toHaveText('Files inside that were shared one by one stay shared.')
      // Always allow on: the next narrowing has no card; the file shares stay
      await newChat(page)
      await ask(page, 'folderaccess links take Sales off Reports again')
      await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
      await expect(page.getByTestId('ask-card')).toHaveCount(0)
      const again = lastAnswer(page).getByTestId('team-folder-card')
      await expect(again.getByTestId('team-folder-card-note').last()).toHaveText('Files inside that were shared one by one stay shared.')
      await shot(page, 'folder-access-always-no-card', again)
      await page.goto('/settings/allowances')
      await expect(page.getByTestId('allowance-row').first()).toContainText('Changing who can open team folders')
      expect(realErrors(errors)).toEqual([])
    })
  })
}
