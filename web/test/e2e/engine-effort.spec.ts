// The depth row of the AI picker (docs/decisions/20261126-model-effort-choice.md): 빠르게 · 보통 · 꼼꼼하게 under the
// models, on a computer (1440, the small list) and a phone (390, the bottom sheet), light and dark. A pick shows on the
// button ("· 꼼꼼하게"), is sent with the new chat, and the chat remembers it (the picker in that chat has it ticked).
// SHOTS_DIR=<folder>: the open picker in each case.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { OWNER, reset, signIn } from './helpers'

const engineRequests = async (page: Page) => (await (await page.request.post('/__test/engine-requests')).json()) as { name: string; effort?: string }[]

async function shot(page: Page, name: string) {
  if (!process.env.SHOTS_DIR) return
  fs.mkdirSync(process.env.SHOTS_DIR, { recursive: true })
  await page.screenshot({ path: path.join(process.env.SHOTS_DIR, name) })
}

for (const width of [1440, 390] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    test.describe(`${width} ${scheme}`, () => {
      test.use({ serviceWorkers: 'block', viewport: { width, height: width === 390 ? 844 : 900 }, ...(width === 390 ? { hasTouch: true, isMobile: true } : {}) })

      test('pick 꼼꼼하게: on the button, sent with the new chat, kept by the chat', async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme })
        await reset(page)
        await signIn(page, OWNER)
        const picker = page.getByTestId('engine-picker')
        await picker.click()
        const row = page.getByTestId('effort-row')
        await expect(row).toBeVisible()
        await expect(row.getByTestId('effort-normal')).toHaveAttribute(width === 390 ? 'aria-checked' : 'aria-selected', 'true')
        // the three words fit in the row, inside the window
        for (const e of ['quick', 'normal', 'thorough']) {
          const b = (await row.getByTestId(`effort-${e}`).boundingBox())!
          expect(b.x).toBeGreaterThanOrEqual(0)
          expect(b.x + b.width).toBeLessThanOrEqual(width)
        }
        await shot(page, `effort-${width}-${scheme}.png`)
        await row.getByTestId('effort-thorough').click()
        await expect(row.getByTestId('effort-thorough')).toHaveAttribute(width === 390 ? 'aria-checked' : 'aria-selected', 'true')
        await page.keyboard.press('Escape')
        await expect(row).toHaveCount(0)
        await expect(picker).toContainText('꼼꼼하게')
        // a model pick keeps the depth
        await picker.click()
        await (width === 390 ? page.getByRole('menuitemradio', { name: /Opus/ }) : page.getByRole('option', { name: /Opus/ })).click()
        await expect(picker).toContainText('Opus')
        await expect(picker).toContainText('꼼꼼하게')
        // sent with the new chat
        await page.getByTestId('composer-input').fill('hello')
        await page.getByTestId('send').click()
        await expect(page).toHaveURL(/\/c\//)
        await expect.poll(async () => (await engineRequests(page)).filter((r) => r.name === 'createChat').map((r) => r.effort ?? null)).toContain('thorough')
        // the chat keeps it
        await expect(page.getByTestId('engine-picker')).toContainText('꼼꼼하게')
        await page.getByTestId('engine-picker').click()
        await expect(page.getByTestId('effort-thorough')).toHaveAttribute(width === 390 ? 'aria-checked' : 'aria-selected', 'true')
      })
    })
  }
}
