// Home on a phone like an AI app (QA TC-391) in Chromium, Android's engine; the cases are in
// phone-home-centered.cases.ts (WebKit: phone-home-centered.webkit.spec.ts). A computer keeps its Home: the box under
// the greeting with its row under it, no mark (SHOTS_DIR=<folder>: the 1440 screen).
import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { reset, signIn } from './helpers'
import { homeCenteredCases } from './phone-home-centered.cases'

homeCenteredCases()

test('a computer keeps its Home: no mark, the box under the greeting, + and the engine in its row inside the box (QA TC-1400)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light' })
  await reset(page)
  await signIn(page)
  await expect(page.getByTestId('composer-input')).toBeVisible()
  await expect(page.getByTestId('home-mark')).toBeHidden()
  const tools = page.getByTestId('composer').getByTestId('composer-tools')
  await expect(tools.getByTestId('attach-button')).toBeVisible()
  await expect(tools.getByTestId('engine-picker')).toBeVisible()
  // nothing under the box (Home has no note)
  await expect(page.getByTestId('composer-controls')).toHaveCount(0)
  const greeting = (await page.getByRole('heading', { level: 1 }).boundingBox())!
  const card = (await page.getByTestId('composer').boundingBox())!
  expect(greeting.y + greeting.height).toBeLessThanOrEqual(card.y)
  // the text on top, the row under it inside the box
  const input = (await page.getByTestId('composer-input').boundingBox())!, row = (await tools.boundingBox())!
  expect(row.y).toBeGreaterThanOrEqual(input.y + input.height - 1)
  expect(row.y + row.height).toBeLessThanOrEqual(card.y + card.height)
  if (process.env.SHOTS_DIR) {
    fs.mkdirSync(process.env.SHOTS_DIR, { recursive: true })
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(process.env.SHOTS_DIR, 'after-1440-owner.png') })
  }
})
