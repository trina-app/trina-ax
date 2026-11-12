// Admin > Usage in the Claude Console style (pages/admin/Usage.tsx): the title with "Data as of", filter pills (Range,
// Person, Engine, Model, Group by), stat cards, the "Token usage" chart with its tooltip and keyboard, the breakdown
// table, the empty state, a phone layout and accessibility in both themes. Made-up numbers from the mock server.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { DICTS } from '../../src/i18n'
import { reset, signIn } from './helpers'

const t = DICTS.en

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

async function open(page: Page) {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await page.goto('/admin/usage')
  // a phone's breakdown is list rows (TC-269), a computer's the table
  await expect(page.getByTestId('usage-table').or(page.getByTestId('usage-rows'))).toContainText('Olga')
}

test('the Console layout: one dim line, pills, stat cards, a chart and the breakdown, all from one report', async ({ page }) => {
  const asked: URLSearchParams[] = []
  page.on('request', (r) => { if (r.url().includes('/api/admin/usage?')) asked.push(new URL(r.url()).searchParams) })
  await open(page)
  await expect(page.getByTestId('usage-header')).toContainText('Data as of')
  // one request carries the chart and the filter choices too
  expect(asked.at(-1)!.get('series')).toBe('1')
  expect(asked.at(-1)!.get('facets')).toBe('1')
  // stat cards: the totals of the report (14,000 in, 4,100 out, 15 answers)
  await expect(page.getByTestId('usage-stat-in')).toContainText('14,000')
  await expect(page.getByTestId('usage-stat-out')).toContainText('4,100')
  await expect(page.getByTestId('usage-stat-turns')).toContainText('15')
  // the chart has a legend for the two people and the same numbers in a hidden table
  const chart = page.getByTestId('usage-chart')
  await expect(chart.getByRole('heading', { name: t['usage.chart.title'] })).toBeVisible()
  await expect(page.getByTestId('usage-chart-legend')).toContainText('Olga')
  await expect(page.getByTestId('usage-chart-legend')).toContainText('Bob')
  await expect(page.getByTestId('usage-chart-table').locator('tbody tr')).toHaveCount(3)
  // the breakdown keeps the shares and totals
  await expect(page.getByTestId('usage-table').locator('tfoot')).toContainText('18,100')
})

test('the chart tooltip follows the pointer and the arrow keys', async ({ page }) => {
  await open(page)
  const plot = page.getByTestId('usage-chart-plot')
  // the last day of the mock series has half of every row
  await plot.focus()
  const tip = page.getByTestId('usage-chart-tooltip')
  await expect(tip).toBeVisible()
  await page.keyboard.press('ArrowLeft')
  await expect(tip).toContainText(t['usage.total'])
  // the busiest day (half of every row: Olga 6,000 + 1,700) is one of the last two, depending on the time zone
  await page.keyboard.press('End')
  await expect(tip).toContainText('Olga')
  if (!(await tip.textContent())!.includes('7,700')) await page.keyboard.press('ArrowLeft')
  await expect(tip).toContainText('7,700')
  await page.keyboard.press('Tab')
  await expect(tip).toHaveCount(0)
  // hovering a day shows it too
  const box = (await plot.boundingBox())!
  await page.mouse.move(box.x + box.width - 10, box.y + box.height / 2)
  await expect(tip).toBeVisible()
})

test('filters and Group by ask the server again and the page follows; Clear filters resets them', async ({ page }) => {
  await open(page)
  const person = page.waitForRequest((r) => r.url().includes('/api/admin/usage?') && new URL(r.url()).searchParams.get('user') === 'bob')
  await page.getByTestId('usage-filter-user').selectOption('bob')
  await person
  await expect(page.getByTestId('usage-table')).not.toContainText('Olga')
  await expect(page.getByTestId('usage-stat-turns')).toContainText('3')
  await expect(page.getByTestId('usage-filter-user-pill')).toHaveClass(/border-line-strong/)
  await page.getByTestId('usage-filters-clear').click()
  await expect(page.getByTestId('usage-table')).toContainText('Olga')
  await expect(page.getByTestId('usage-filters-clear')).toHaveCount(0)
  // Group by changes the chart's split and the table's first column
  await page.getByTestId('usage-groupby').selectOption('model')
  await expect(page.getByTestId('usage-table').locator('thead th').first()).toHaveText(t['usage.by.model'])
  await expect(page.getByTestId('usage-chart')).toContainText(t['usage.chart.desc'].replace('{by}', t['usage.by.model']))
  // a range preset asks for that range
  const week = page.waitForRequest((r) => {
    if (!r.url().includes('/api/admin/usage?')) return false
    const q = new URL(r.url()).searchParams
    return (new Date(q.get('to')!).getTime() - new Date(q.get('from')!).getTime()) / 86_400_000 > 6.5
      && (new Date(q.get('to')!).getTime() - new Date(q.get('from')!).getTime()) / 86_400_000 < 7.5
  })
  await page.getByTestId('usage-range').selectOption('7d')
  await week
})

test('an empty range shows a calm empty chart and still exports', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await page.route('**/api/admin/usage?**', (route) => {
    const q = new URL(route.request().url()).searchParams
    return route.fulfill({ json: { from: q.get('from'), to: q.get('to'), rows: [], totals: { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, series: [], facets: { users: [], engines: [], models: [], credentials: [], groups: [] } } })
  })
  await page.goto('/admin/usage')
  await expect(page.getByTestId('usage-chart-empty')).toHaveText(t['usage.chart.empty'])
  await expect(page.getByTestId('usage-none')).toBeVisible()
  await expect(page.getByTestId('usage-csv')).toBeEnabled()
})

test('phone width: pills wrap, cards two by two, no sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page)
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  expect(sideways).toBe(false)
  const a = (await page.getByTestId('usage-stat-in').boundingBox())!
  const b = (await page.getByTestId('usage-stat-out').boundingBox())!
  expect(Math.abs(a.y - b.y)).toBeLessThan(2)
  await expect(page.getByTestId('usage-chart')).toBeVisible()
  await audit(page, 'admin usage, phone')
})

for (const scheme of ['light', 'dark'] as const) {
  test(`no serious accessibility problems on the Console-style usage page (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await open(page)
    await page.getByTestId('usage-chart-plot').focus()
    await audit(page, `admin usage, ${scheme}`)
  })
}
