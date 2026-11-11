// The AI picker on a phone (QA TC-247): the message box's "AI ⌄" and "다른 모델로 다시 시도" open MenuButton's bottom
// sheet (components/chat/EngineSheet.tsx) over a scrim. A tap outside or Escape closes it, and the message box takes the
// next tap; nothing of it stays over the box. The choices are the computer's (each engine's default model, its models);
// the chosen one is ticked. Which choices show is not this spec's (TC-182). SHOTS_DIR=<folder>: the sheet at 390.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'

test.use({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

const engineRequests = async (page: Page) => (await (await page.request.post('/__test/engine-requests')).json()) as { name: string; user: string; engine?: string; model?: string }[]

async function shot(page: Page, name: string) {
  if (!process.env.SHOTS_DIR) return
  fs.mkdirSync(process.env.SHOTS_DIR, { recursive: true })
  await page.screenshot({ path: path.join(process.env.SHOTS_DIR, name) })
}

test('the picker is a sheet: a tap outside and Escape close it, the box takes the tap, a pick shows on the button', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await reset(page)
  await signIn(page)
  const picker = page.getByTestId('engine-picker')
  await picker.click()
  const sheet = page.getByRole('menu', { name: 'AI 고르기' })
  await expect(sheet).toBeVisible()
  // at the bottom, the whole width, a radio row per choice (the team's default AI: none ticked yet)
  const b = (await sheet.boundingBox())!
  expect(Math.round(b.y + b.height)).toBeGreaterThanOrEqual(840)
  expect(b.width).toBe(390)
  await expect(sheet.getByRole('menuitemradio', { name: /ChatGPT/ }).first()).toBeVisible()
  await expect(sheet.getByRole('menuitemradio', { checked: true })).toHaveCount(0)
  await shot(page, 'engine-sheet-390.png')
  // a tap outside (on the scrim): closed; the message box takes the next tap
  await page.mouse.click(195, 120)
  await expect(sheet).toHaveCount(0)
  const input = page.getByTestId('composer-input')
  await input.click()
  await expect(input).toBeFocused()
  // Escape closes it too
  await picker.click()
  await expect(sheet).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  // a pick: the button says it, the sheet is gone
  await picker.click()
  await sheet.getByRole('menuitemradio', { name: 'Opus' }).click()
  await expect(sheet).toHaveCount(0)
  await expect(picker).toContainText('Claude · Opus')
  await picker.click()
  await expect(sheet.getByRole('menuitemradio', { checked: true })).toHaveText('Opus')
  await page.mouse.click(195, 120)
  await expect(sheet).toHaveCount(0)
})

test('"다른 모델로 다시 시도" under a failed answer: the same sheet; a pick answers again with that AI', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.getByTestId('composer-input').fill('cause an error')
  await page.getByTestId('send').click()
  const last = page.getByTestId('assistant-message').last()
  await expect(last).toHaveAttribute('data-status', 'error')
  await last.getByTestId('retry-other-model').click()
  const sheet = page.getByRole('menu', { name: '다른 모델로 다시 시도' })
  await expect(sheet).toBeVisible()
  await page.mouse.click(195, 120)
  await expect(sheet).toHaveCount(0)
  await last.getByTestId('retry-other-model').click()
  await sheet.getByRole('menuitemradio', { name: /ChatGPT/ }).first().click()
  await expect(sheet).toHaveCount(0)
  await expect.poll(async () => (await engineRequests(page)).map((r) => [r.name, r.engine ?? null])).toContainEqual(['regenerate', 'codex'])
})
