import { expect, test } from '@playwright/test'
import fs from 'node:fs/promises'
import { reset, signIn } from './helpers'

test('administrator exports the selected person, model and skill report as CSV with matching dates', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/admin/usage')
  await expect(page.getByTestId('usage-table')).toContainText('Olga')
  for (const [group, label] of [['user', 'Olga'], ['model', 'model-test'], ['skill', '주간 보고서']]) {
    await page.locator('select').selectOption(group!)
    await expect(page.getByTestId('usage-table')).toContainText(label!)
    if (group === 'skill') await expect(page.getByTestId('usage-skill-note')).toContainText('중복')
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('usage-csv').click()])
    expect(download.suggestedFilename()).toMatch(new RegExp(`^usage-${group}-\\d{4}-\\d{2}-\\d{2}-\\d{4}-\\d{2}-\\d{2}\\.csv$`))
    const content = await fs.readFile((await download.path())!, 'utf8')
    expect(content).toContain(label!)
    expect(content.startsWith('\uFEFFgroup_by,from,to,key,label')).toBe(true)
    expect(content).toContain(`\r\n${group},`)
    if (group === 'skill') expect(content).toContain('whole turn; skill rows may overlap')
  }
  const dates = page.locator('input[type="date"]')
  await dates.nth(0).fill('2026-10-01')
  // Pick a different end date even when the test runs on the original fixture date.
  const selectedTo = (await dates.nth(1).inputValue()) === '2026-10-26' ? '2026-10-25' : '2026-10-26'
  const expectedTo = await page.evaluate((date) => { const end = new Date(`${date}T00:00:00`); end.setDate(end.getDate() + 1); return end.toISOString() }, selectedTo)
  const report = page.waitForResponse((r) => r.url().includes('/api/admin/usage?') && new URL(r.url()).searchParams.get('to') === expectedTo)
  await dates.nth(1).fill(selectedTo)
  // Date changes update immediately; use the final API request as evidence that CSV uses this same selection.
  await report
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('usage-csv').click()])
  expect(download.suggestedFilename()).toBe(`usage-skill-2026-10-01-${selectedTo}.csv`)
  const content = await fs.readFile((await download.path())!, 'utf8')
  expect(content).toContain('2026-10-01T')
  expect(content).toContain(expectedTo)
})

test('CSV never labels a stale response as a newly selected report', async ({ page }) => {
  await reset(page); await signIn(page); await page.goto('/admin/usage')
  await expect(page.getByTestId('usage-table')).toContainText('Olga')
  let release!: () => void
  const delayed = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/admin/usage?**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('groupBy') === 'model') await delayed
    await route.continue()
  })
  await page.locator('select').selectOption('model')
  await expect(page.getByTestId('usage-csv')).toBeDisabled()
  await page.locator('select').selectOption('skill')
  await expect(page.getByTestId('usage-table')).toContainText('주간 보고서')
  const oldResponse = page.waitForResponse((r) => new URL(r.url()).searchParams.get('groupBy') === 'model')
  release(); await oldResponse
  await expect(page.getByTestId('usage-table')).toContainText('주간 보고서')
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('usage-csv').click()])
  expect(await fs.readFile((await download.path())!, 'utf8')).toContain('skills/report.md')
})
