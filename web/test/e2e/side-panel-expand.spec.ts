// "크게 보기" on the right-hand panel (components/SidePanelFrame.tsx PanelExpandButton, components/Layout.tsx): the panel
// takes the area beside the sidebar and the page behind it (the AI chat, the Files list) is hidden; Esc or the button
// brings it back side by side at the divider's width; a second Esc closes it; closing ends it (not remembered); no
// button on a phone, where the panel is full screen already. SHOTS_DIR=<dir> saves 1440 light screenshots of both.
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'
import { DICTS } from '../../src/i18n'

const ko = DICTS.ko
const panel = (page: Page) => page.getByTestId('side-panel')
const main = (page: Page) => page.locator('main#main')
const expandButton = (page: Page) => page.getByRole('button', { name: ko['preview.expand'], exact: true })
const sideBySideButton = (page: Page) => page.getByRole('button', { name: ko['preview.sideBySide'], exact: true })
const width = async (page: Page) => Math.round((await panel(page).boundingBox())!.width)
/** the area right of the sidebar (the row's first column): what a big panel fills */
const pageArea = (page: Page) =>
  page.evaluate(() => {
    const row = document.querySelector('[data-testid="side-panel"]')!.parentElement!
    return Math.round(row.getBoundingClientRect().right - row.firstElementChild!.getBoundingClientRect().right)
  })

async function shot(page: Page, name: string) {
  if (!process.env.SHOTS_DIR) return
  await page.emulateMedia({ colorScheme: 'light' })
  await page.mouse.move(0, 0)
  await page.waitForTimeout(1000)
  await page.screenshot({ path: path.join(process.env.SHOTS_DIR, `${name}.png`) })
}

/** An answer with sources in the AI chat; its PDF page opens in the panel beside the chat. */
async function openPdfFromChat(page: Page) {
  await page.getByTestId('composer-input').fill('sources: 3분기 매출 정리해 줘')
  await page.getByTestId('send').click()
  const answer = page.getByTestId('assistant-message').last()
  await expect(answer).toHaveAttribute('data-status', 'done', { timeout: 20_000 })
  const box = answer.getByTestId('answer-sources')
  await box.getByRole('button', { name: /참고한 파일/ }).click()
  await box.getByTestId('answer-source').nth(0).getByTestId('answer-source-loc').nth(0).click()
  const file = page.getByTestId('file-panel')
  await expect(file.getByTestId('file-panel-title')).toHaveText('report.pdf')
  await expect(file.locator('[data-page="4"] canvas')).toBeVisible({ timeout: 15_000 })
  return file
}

test('from the AI chat: big, Esc and the button back side by side at the divider width, Esc again closes', async ({ page }) => {
  if (process.env.SHOTS_DIR) await page.setViewportSize({ width: 1440, height: 900 })
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  const file = await openPdfFromChat(page)
  // a width of the person's own (the divider, remembered), to come back to
  const first = await width(page)
  await page.getByTestId('panel-divider').focus()
  await page.keyboard.press('Shift+ArrowLeft')
  await expect.poll(() => width(page)).toBeGreaterThan(first)
  const side = await width(page)
  const near = async (want: number) => expect.poll(async () => Math.abs((await width(page)) - want)).toBeLessThanOrEqual(2)
  // the page being read (page 4, where the source opened it) stays at the top when the pages grow and shrink with the panel
  const readingPage4 = () =>
    expect.poll(async () => {
      const [p, bar] = await Promise.all([file.locator('[data-page="4"]').boundingBox(), file.getByTestId('pdf-toolbar').boundingBox()])
      return Math.abs(p!.y - (bar!.y + bar!.height)) < 80
    }).toBe(true)
  await readingPage4()
  await expect(main(page)).toBeVisible()
  await expect(page.getByTestId('composer-input')).toBeVisible()
  await shot(page, 'side-by-side-1440-light')

  // ⤢ 크게 보기: the chat is hidden, the panel fills the area beside the sidebar, no divider
  await expect(sideBySideButton(page)).toHaveCount(0)
  await expandButton(page).click()
  await expect(panel(page)).toHaveAttribute('data-expanded', 'true')
  await expect(main(page)).toBeHidden()
  await expect(page.getByTestId('composer-input')).toBeHidden()
  await expect(page.getByTestId('panel-divider')).toHaveCount(0)
  const area = await pageArea(page)
  await expect.poll(() => width(page)).toBe(area)
  expect(area).toBeGreaterThan(side + 200)
  // the PDF follows the new width (fitted to the panel), and the panel's own actions are still there
  await expect.poll(async () => Math.round((await file.locator('[data-page="4"] canvas').boundingBox())!.width)).toBeGreaterThan(side)
  await expect(file.getByRole('button', { name: ko['common.download'], exact: true })).toBeVisible()
  await expect(file.getByTestId('file-ask-ai')).toBeVisible()
  await expect(sideBySideButton(page)).toBeFocused()
  await readingPage4()
  await shot(page, 'expanded-pdf-1440-light')

  // Esc: side by side first, at the width the divider had; the chat is back
  await page.keyboard.press('Escape')
  await expect(main(page)).toBeVisible()
  await expect(panel(page)).not.toHaveAttribute('data-expanded')
  await expect(page.getByTestId('panel-divider')).toBeVisible()
  await near(side)
  await readingPage4()
  await expect(page.getByTestId('composer-input')).toBeVisible()

  // the button both ways
  await expandButton(page).click()
  await expect(main(page)).toBeHidden()
  await sideBySideButton(page).click()
  await expect(main(page)).toBeVisible()
  await near(side)

  // big, then Esc twice: side by side, then closed
  await expandButton(page).click()
  await expect(main(page)).toBeHidden()
  await page.keyboard.press('Escape')
  await expect(main(page)).toBeVisible()
  await expect(panel(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panel(page)).toHaveCount(0)

  // closed while big (✕): opened again, it starts side by side
  await openSourceAgain(page)
  await expandButton(page).click()
  await expect(main(page)).toBeHidden()
  await page.getByTestId('file-panel').getByRole('button', { name: ko['common.close'], exact: true }).click()
  await expect(panel(page)).toHaveCount(0)
  await expect(main(page)).toBeVisible()
  await openSourceAgain(page)
  await expect(main(page)).toBeVisible()
  await expect(panel(page)).not.toHaveAttribute('data-expanded')
  await expect(expandButton(page)).toBeVisible()
  await near(side)
  expect(realErrors(errors)).toEqual([])
})

async function openSourceAgain(page: Page) {
  const answer = page.getByTestId('assistant-message').last()
  await answer.getByTestId('answer-source').nth(0).getByTestId('answer-source-loc').nth(0).click()
  await expect(page.getByTestId('file-panel').getByTestId('file-panel-title')).toHaveText('report.pdf')
}

test('"add to chat" from a big panel goes back side by side, so the chat with its new chip shows', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await openPdfFromChat(page)
  await expandButton(page).click()
  await expect(main(page)).toBeHidden()
  await page.getByTestId('file-add-to-chat').click()
  await expect(main(page)).toBeVisible()
  await expect(page.getByTestId('attachment-chip').filter({ hasText: 'report.pdf' })).toBeVisible()
})

test('a file opened from a link inside a big panel keeps it big; the edit and its save work there', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/files?path=marketing')
  await page.getByTestId('files-input').setInputFiles({ name: 'links.md', mimeType: 'text/markdown', buffer: Buffer.from('# Links\n\n[핸드북](/files/view?path=docs%2Fhandbook.pdf)\n') })
  const row = page.getByTestId('file-row').filter({ hasText: 'links.md' })
  await row.getByRole('button').first().click()
  const file = page.getByTestId('file-panel')
  await expect(file.getByRole('heading', { name: 'Links', exact: true })).toBeVisible()
  await expandButton(page).click()
  await expect(main(page)).toBeHidden()
  // fix the text in place while big
  await file.getByTestId('file-edit').click()
  await file.getByTestId('file-editor').fill('# Links\n\nSaved big. [핸드북](/files/view?path=docs%2Fhandbook.pdf)\n')
  await file.getByTestId('file-save').click()
  await expect(file).toContainText('Saved big.')
  await expect(main(page)).toBeHidden()
  // the link opens the PDF in the same panel, still big
  await file.getByRole('button', { name: '핸드북' }).click()
  await expect(file.getByTestId('file-panel-title')).toHaveText('handbook.pdf')
  await expect(file.locator('.react-pdf__Page canvas').first()).toBeVisible({ timeout: 15_000 })
  await expect(panel(page)).toHaveAttribute('data-expanded', 'true')
  await expect(main(page)).toBeHidden()
})

test('from Files: the list is hidden; Esc goes side by side before it clears a selection; "open in Files" goes back side by side', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/files?path=docs')
  const row = (name: string) => page.getByTestId('file-row').filter({ hasText: name })
  await row('handbook.pdf').getByRole('button').first().click()
  const file = page.getByTestId('file-panel')
  await expect(file.locator('.react-pdf__Page canvas').first()).toBeVisible({ timeout: 15_000 })
  const side = await width(page)
  await row('handbook.pdf').getByTestId('file-check').click()
  await expect(page.getByTestId('bulk-bar')).toBeVisible()

  await expandButton(page).click()
  await expect(page.getByTestId('file-row').first()).toBeHidden()
  await expect.poll(() => width(page)).toBe(await pageArea(page))
  // first Esc: side by side, the selection kept; second: the selection cleared; third: the panel closed
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('file-row').first()).toBeVisible()
  await expect(page.getByTestId('bulk-bar')).toBeVisible()
  await expect.poll(async () => Math.abs((await width(page)) - side)).toBeLessThanOrEqual(2)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('bulk-bar')).toHaveCount(0)
  await expect(panel(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panel(page)).toHaveCount(0)

  // "파일 화면에서 열기" from a big panel: the folder shows beside it
  await row('handbook.pdf').getByRole('button').first().click()
  await expandButton(page).click()
  await expect(page.getByTestId('file-row').first()).toBeHidden()
  await file.getByRole('button', { name: ko['preview.openInFiles'], exact: true }).click()
  await expect(page.getByTestId('file-row').first()).toBeVisible()
  await expect(panel(page)).not.toHaveAttribute('data-expanded')
  await expect(page).toHaveURL(/\/files\?path=docs&select=handbook\.pdf/)
})

test('a phone: the panel is full screen, and there is no 크게 보기 button', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  await signIn(page)
  await page.goto('/files?path=docs')
  await page.getByTestId('file-row').filter({ hasText: 'handbook.pdf' }).getByRole('button').first().click()
  await expect(page.getByTestId('file-panel')).toBeVisible()
  expect(await width(page)).toBe(390)
  await expect(page.getByTestId('panel-expand')).toBeHidden()
  await expect(expandButton(page)).toBeHidden()
})
