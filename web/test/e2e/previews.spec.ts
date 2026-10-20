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

test('links inside Word and Excel previews: javascript: is not a link, web links ask first, altChunk HTML is not drawn', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  const popups: string[] = []
  page.on('popup', (p) => popups.push(p.url()))
  await signIn(page)
  await page.goto('/files?path=docs')
  await expect(page.getByTestId('file-row').filter({ hasText: 'handbook.pdf' })).toBeVisible()
  test.skip(!(await page.getByTestId('file-row').filter({ hasText: 'links.docx' }).count()), 'needs pandoc, unzip and zip')
  const title = await page.title()
  let panel = await open(page, 'links.docx')
  await expect(panel.locator('.docx-wrapper')).toContainText('evil link', { timeout: 15_000 })
  // the altChunk (an HTML part) would be an unsandboxed same-origin iframe: not drawn at all
  await expect(panel.locator('iframe')).toHaveCount(0)
  const evil = panel.locator('a', { hasText: 'evil link' })
  await expect(evil).not.toHaveAttribute('href', /.*/)
  await evil.click()
  const appLink = panel.locator('a', { hasText: 'app link' })
  await expect(appLink).not.toHaveAttribute('href', /.*/)
  const web = panel.locator('a', { hasText: 'web link' })
  await expect(web).toHaveAttribute('href', 'https://example.com/doc')
  await expect(web).toHaveAttribute('rel', 'noopener noreferrer nofollow')
  // a web link asks first; saying no opens nothing
  const asked: string[] = []
  page.once('dialog', (d) => {
    asked.push(d.message())
    void d.dismiss()
  })
  await web.click()
  await expect.poll(() => asked.length).toBe(1)
  expect(asked[0]).toContain('https://example.com/doc')

  panel = await open(page, 'links.xlsx')
  await expect(panel.locator('table')).toContainText('evil cell')
  await expect(panel.locator('a', { hasText: 'evil cell' })).not.toHaveAttribute('href', /.*/)
  await panel.locator('a', { hasText: 'evil cell' }).click()
  await expect(panel.locator('a', { hasText: 'web cell' })).toHaveAttribute('href', 'https://example.com/sheet')

  await page.waitForTimeout(300)
  expect(await page.title()).toBe(title)
  expect(popups).toEqual([])
  expect(realErrors(errors).filter((e) => !e.includes('Content Security Policy'))).toEqual([])
})
