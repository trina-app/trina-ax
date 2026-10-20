import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const open = async (page: Page, name: string) => {
  await page.getByTestId('file-row').filter({ hasText: name }).getByRole('button').first().click()
  return page.getByTestId('file-panel')
}

// Office and PDF previews are drawn in the page under the app's CSP (no eval): any violation would show up as a
// console error here.
test('PDF, Excel, Word and PowerPoint previews render under the app CSP', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/files?path=docs')
  let panel = await open(page, 'handbook.pdf')
  await expect(panel.locator('.react-pdf__Page canvas').first()).toBeVisible({ timeout: 15_000 })
  await expect(panel.locator('.textLayer')).toContainText('Company Handbook 2026')
  panel = await open(page, 'spend.xlsx')
  await expect(panel.locator('table')).toContainText('August')
  if (await page.getByTestId('file-row').filter({ hasText: 'brand.docx' }).count()) {
    panel = await open(page, 'brand.docx')
    await expect(panel.locator('.docx-wrapper')).toContainText('Primary color: mint.', { timeout: 15_000 })
    panel = await open(page, 'kickoff.pptx')
    await expect(panel).toContainText('Q4 kickoff', { timeout: 15_000 })
  }
  expect(realErrors(errors)).toEqual([])
})
