// "참고한 파일" under an answer (docs/DECISIONS.md "Sources under each answer"): collapsed by default; open, each file
// with its places; a place opens the preview there (a PDF page, a sheet tab and its rows, a slide); a file the person
// can no longer open shows only as "볼 수 없는 파일 N개", checked again each time the list opens; the AI's own links
// to a place open there too. SHOTS_DIR=<dir> also saves light and dark screenshots.
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const lastAnswer = (page: Page) => page.getByTestId('assistant-message').last()

async function ask(page: Page) {
  await page.getByTestId('composer-input').fill('sources: 3분기 매출 정리해 줘')
  await page.getByTestId('send').click()
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done', { timeout: 20_000 })
  return lastAnswer(page).getByTestId('answer-sources')
}

/** the element is inside the visible part of its scrolling panel */
async function inView(el: Locator, scroller: Locator) {
  await expect.poll(async () => {
    const [a, b] = await Promise.all([el.boundingBox(), scroller.boundingBox()])
    return !!a && !!b && a.y >= b.y - 2 && a.y < b.y + b.height - 10
  }, { timeout: 15_000 }).toBe(true)
}

test('the list under an answer: collapsed, open, a page / sheet / slide opens the preview there', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  const box = await ask(page)
  await expect(box.getByRole('button', { name: '참고한 파일 5개' })).toHaveAttribute('aria-expanded', 'false')
  await expect(box.getByTestId('answer-sources-list')).toHaveCount(0)
  if (process.env.SHOTS_DIR) await shots(page, box, 'sources-collapsed')
  await box.getByRole('button', { name: '참고한 파일 5개' }).click()
  const list = box.getByTestId('answer-sources-list')
  await expect(list).toContainText('AI가 이 답변을 쓰며 열어 본 파일이에요.')
  const rows = list.getByTestId('answer-source')
  await expect(rows).toHaveCount(4)
  await expect(rows.nth(0)).toContainText('report.pdf')
  await expect(rows.nth(0).getByTestId('answer-source-loc')).toHaveText(['4쪽', '5쪽'])
  await expect(rows.nth(1)).toContainText("시트 '매출' A40:C44")
  await expect(rows.nth(1)).toContainText('검색 결과로만 봄')
  await expect(rows.nth(2)).toContainText('슬라이드 5')
  await expect(rows.nth(2)).toContainText('하위 작업이 읽음')
  // secret/ is nobody's: counted, never named
  await expect(list.getByTestId('answer-sources-unavailable')).toHaveText('볼 수 없는 파일 1개')
  await expect(list).not.toContainText('payroll')
  if (process.env.SHOTS_DIR) await shots(page, box, 'sources-list')

  // a PDF page
  await rows.nth(0).getByTestId('answer-source-loc').nth(1).click()
  const panel = page.getByTestId('file-panel')
  await expect(panel.getByTestId('file-panel-title')).toHaveText('report.pdf')
  const pdfPage = panel.locator('[data-page="5"]')
  await expect(pdfPage.locator('canvas')).toBeVisible({ timeout: 15_000 })
  await inView(pdfPage, panel.locator('[data-start-page]').locator('xpath=ancestor::div[contains(@class,"overflow-auto")][1]'))
  await expect(panel.locator('[data-start-page]')).toHaveAttribute('data-start-page', '5')
  if (process.env.SHOTS_DIR) await shots(page, panel, 'sources-pdf-page')

  // a sheet tab and its rows
  await rows.nth(1).getByTestId('answer-source-loc').click()
  await expect(panel.getByTestId('file-panel-title')).toHaveText('budget.xlsx')
  await expect(panel.getByRole('tab', { name: '매출' })).toHaveAttribute('aria-selected', 'true')
  const cell = panel.locator('#sjs-A40')
  await expect(cell).toHaveAttribute('data-source-cell', '')
  await expect(panel.locator('[data-source-cell]')).toHaveCount(15)
  await inView(cell, panel.locator('[data-sheet]'))
  if (process.env.SHOTS_DIR) await shots(page, panel, 'sources-sheet-range')

  // a slide (the deck needs pandoc to be made; the mock leaves it out without)
  if (await page.request.get('/api/files/download?path=docs%2Fsources%2Fdeck.pptx').then((r) => r.ok())) {
    await rows.nth(2).getByTestId('answer-source-loc').click()
    await expect(panel.getByTestId('file-panel-title')).toHaveText('deck.pptx')
    await expect(panel.locator('[data-start-slide="5"]')).toHaveCount(1, { timeout: 15_000 })
    await expect(panel).toContainText('Deck slide 5', { timeout: 15_000 })
    if (process.env.SHOTS_DIR) { await page.waitForTimeout(800); await shots(page, panel, 'sources-pptx-slide') }
  }
  expect(realErrors(errors)).toEqual([])
})

test('opened again after the person lost access: those files only count; the AI\'s links open at their place', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const box = await ask(page)
  // the answer's own link to a page
  await lastAnswer(page).getByRole('button', { name: /report\.pdf · p\.4/ }).click()
  const panel = page.getByTestId('file-panel')
  await expect(panel.locator('[data-start-page]')).toHaveAttribute('data-start-page', '4', { timeout: 15_000 })
  await expect(panel.locator('[data-page="4"] canvas')).toBeVisible({ timeout: 15_000 })
  // the sheet link: the tab and its range
  await lastAnswer(page).getByRole('button', { name: /budget\.xlsx/ }).click()
  await expect(panel.getByRole('tab', { name: '매출' })).toHaveAttribute('aria-selected', 'true')

  await box.getByRole('button', { name: '참고한 파일 5개' }).click()
  await expect(box.getByTestId('answer-source')).toHaveCount(4)
  // an admin takes docs/sources away
  await page.request.post('/__test/revoke', { data: { path: 'docs/sources' } })
  await box.getByRole('button', { name: '참고한 파일 5개' }).click()
  await box.getByRole('button', { name: '참고한 파일 5개' }).click()
  await expect(box.getByTestId('answer-source')).toHaveCount(1)
  await expect(box.getByTestId('answer-source')).toContainText('plan.md')
  await expect(box.getByTestId('answer-sources-unavailable')).toHaveText('볼 수 없는 파일 4개')
  for (const name of ['report.pdf', 'budget.xlsx', 'deck.pptx']) await expect(box.getByTestId('answer-sources-list')).not.toContainText(name)
  if (process.env.SHOTS_DIR) await shots(page, box, 'sources-unavailable')
})

/** light and dark screenshots of `el` (with some room around it) */
async function shots(page: Page, el: Locator, name: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(150)
    await page.screenshot({ path: path.join(process.env.SHOTS_DIR!, `${name}-${scheme}.png`) })
    void el
  }
  await page.emulateMedia({ colorScheme: 'light' })
}
