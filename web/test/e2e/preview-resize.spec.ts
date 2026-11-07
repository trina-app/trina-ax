// The divider between the chat and the right-hand panel (components/SidePanelFrame.tsx): drag, limits, remembered
// per device, double-click reset, arrow keys, and no divider on a phone.
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'

async function ask(page: Page, text: string) {
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('send').click()
}

/** Ask for files and open one of them from the answer's summary: the preview panel shows on the right. */
async function openPreview(page: Page) {
  await ask(page, 'write the files please')
  const answer = page.getByTestId('assistant-message').last()
  await expect(answer).toHaveAttribute('data-status', 'done')
  const summary = answer.getByTestId('file-summary')
  await summary.getByRole('button').first().click()
  await summary.getByRole('button', { name: 'marketing/report.md' }).click()
  await expect(page.getByTestId('file-panel')).toContainText('Report')
}

const panelWidth = async (page: Page) => Math.round((await page.getByTestId('side-panel').boundingBox())!.width)
const chatWidth = async (page: Page) => Math.round((await page.locator('main#main').boundingBox())!.width)

async function dragTo(page: Page, x: number) {
  const box = (await page.getByTestId('panel-divider').boundingBox())!
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(x, y, { steps: 6 })
  await expect(page.getByTestId('panel-drag-overlay')).toBeVisible()
  await page.mouse.up()
  await expect(page.getByTestId('panel-drag-overlay')).toHaveCount(0)
}

test('drag, limits, remembered after reload, double-click reset, arrow keys', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await openPreview(page)
  const divider = page.getByTestId('panel-divider')
  await expect(divider).toHaveAttribute('role', 'separator')
  await expect(divider).toHaveAttribute('aria-orientation', 'vertical')
  await expect(divider).toHaveAttribute('aria-label', DICTS.ko['preview.resize'])
  const first = await panelWidth(page)

  // drag left: wider, and the chat keeps its minimum
  await dragTo(page, 660)
  await expect.poll(() => panelWidth(page)).toBeGreaterThan(first + 30)
  const dragged = await panelWidth(page)
  expect(await chatWidth(page)).toBeGreaterThanOrEqual(360)
  await expect(divider).toHaveAttribute('aria-valuenow', String(dragged))

  // limits: far left keeps the chat at 360, far right keeps the panel at 320
  await dragTo(page, 5)
  await expect.poll(() => chatWidth(page)).toBeGreaterThanOrEqual(359)
  expect(await chatWidth(page)).toBeLessThanOrEqual(362)
  await dragTo(page, 1355)
  await expect.poll(() => panelWidth(page)).toBe(320)

  // remembered per device (the panel itself closes with the reload; its width does not)
  await dragTo(page, 800)
  const kept = await panelWidth(page)
  await page.reload()
  await openPreview(page)
  await expect.poll(async () => Math.abs((await panelWidth(page)) - kept)).toBeLessThanOrEqual(3)

  // double-click: back to the default, and forgotten
  await page.getByTestId('panel-divider').dblclick()
  await expect.poll(() => panelWidth(page)).toBe(first)
  expect(await page.evaluate(() => localStorage.getItem('mycel.sidePanel.widthFraction'))).toBeNull()

  // keyboard: Left widens by 24, Right narrows, Shift 96, Home and End
  await divider.focus()
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => panelWidth(page)).toBe(first + 24)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => panelWidth(page)).toBe(first - 24)
  await page.keyboard.press('Shift+ArrowLeft')
  await expect.poll(() => panelWidth(page)).toBe(first - 24 + 96)
  await page.keyboard.press('Home')
  await expect.poll(() => panelWidth(page)).toBe(320)
  await page.keyboard.press('End')
  await expect.poll(() => chatWidth(page)).toBeGreaterThanOrEqual(359)
  expect(await chatWidth(page)).toBeLessThanOrEqual(362)
})

test('a phone gets the full-screen sheet and no divider', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  await signIn(page)
  await openPreview(page)
  await expect(page.getByTestId('panel-divider')).toBeHidden()
  expect(await panelWidth(page)).toBe(390)
})
