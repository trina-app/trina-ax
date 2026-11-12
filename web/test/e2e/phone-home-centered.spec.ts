// Home on a phone like an AI app (QA TC-391) in Chromium, Android's engine; the cases are in
// phone-home-centered.cases.ts (WebKit: phone-home-centered.webkit.spec.ts). A computer keeps its Home: the box under
// the greeting with its row under it, no mark (SHOTS_DIR=<folder>: the 1440 screen).
import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { reset, signIn } from './helpers'
import { homeCenteredCases } from './phone-home-centered.cases'

homeCenteredCases()

test('a computer keeps its Home: no mark, the box under the greeting, its row (+ and the engine) under the box', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light' })
  await reset(page)
  await signIn(page)
  await expect(page.getByTestId('composer-input')).toBeVisible()
  await expect(page.getByTestId('home-mark')).toBeHidden()
  await expect(page.getByTestId('composer-tools')).toHaveCount(0)
  const controls = page.getByTestId('composer-controls')
  await expect(controls.getByTestId('attach-button')).toBeVisible()
  await expect(controls.getByTestId('engine-picker')).toBeVisible()
  const greeting = (await page.getByRole('heading', { level: 1 }).boundingBox())!
  const card = (await page.getByTestId('composer').boundingBox())!
  expect(greeting.y + greeting.height).toBeLessThanOrEqual(card.y)
  expect((await controls.boundingBox())!.y).toBeGreaterThanOrEqual(card.y + card.height - 1)
  // the box's text and its buttons share one line
  const input = (await page.getByTestId('composer-input').boundingBox())!, send = (await page.getByTestId('send').boundingBox())!
  expect(send.y).toBeLessThan(input.y + input.height)
  if (process.env.SHOTS_DIR) {
    fs.mkdirSync(process.env.SHOTS_DIR, { recursive: true })
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(process.env.SHOTS_DIR, 'after-1440-owner.png') })
  }
})
