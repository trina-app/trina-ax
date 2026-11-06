// Settings > Usage (components/settings/MyUsage.tsx): the person's own usage, like Claude's, opened from the account
// menu by everyone; Admin > Usage keeps everyone's. That the server answers with the caller's own turns only is
// tests/unit/a-my-usage.test.ts; here: what the page shows, the period, the refresh, phone width and accessibility.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { DICTS } from '../../src/i18n'
import { reset, signIn } from './helpers'

const t = DICTS.en
const BOB = { username: 'bob', password: 'bob password 1' }

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

async function openFromMenu(page: Page) {
  await page.getByTestId('account-menu').click()
  await page.getByTestId('account-usage').click()
  await expect(page).toHaveURL(/\/settings\/usage$/)
  const usage = page.getByTestId('my-usage')
  await expect(usage).toBeVisible()
  return usage
}

test('the owner sees their own limits, answers by model and totals, can change the period and refresh', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  const usage = await openFromMenu(page)
  await expect(usage.getByRole('heading', { name: t['myUsage.title'] })).toBeVisible()
  await expect(page.getByTestId('my-usage-headline')).toHaveText("You're within your limits. The fullest is at 42%.")
  const limits = page.getByTestId('my-usage-limit')
  await expect(limits).toHaveCount(2)
  await expect(limits.nth(0)).toContainText(t['myUsage.limit.you.month'])
  await expect(limits.nth(0)).toContainText('42% used')
  await expect(limits.nth(1)).toContainText('Design group · daily')
  await expect(page.getByTestId('my-usage-models').getByRole('listitem')).toHaveText([/Claude · sonnet\s*75%/, /Codex · Default model\s*25%/])
  await expect(page.getByTestId('my-usage-totals')).toContainText('12')
  await expect(page.getByTestId('my-usage-totals')).toContainText('15,400')
  await expect(page.getByTestId('my-usage-team-link')).toHaveAttribute('href', '/admin/usage')
  // the period asks the server again
  const week = page.waitForRequest((r) => r.url().includes('/api/me/usage') && new URL(r.url()).searchParams.get('period') === 'week')
  await page.getByTestId('my-usage-period').selectOption('week')
  await week
  const again = page.waitForRequest((r) => r.url().includes('/api/me/usage'))
  await page.getByTestId('my-usage-refresh').click()
  await again
  await expect(page.getByTestId('my-usage-updated')).toContainText('Last updated:')
})

test('a member gets Usage in the account menu too, with only their own numbers and no team link', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page, BOB)
  await openFromMenu(page)
  await expect(page.getByTestId('my-usage-nolimit')).toHaveText(t['myUsage.noLimit'])
  await expect(page.getByTestId('my-usage-models').getByRole('listitem')).toHaveCount(1)
  await expect(page.getByTestId('my-usage-team-link')).toHaveCount(0)
  // nothing of anyone else on the page
  await expect(page.getByTestId('my-usage')).not.toContainText('Olga')
})

test('a red bar only once a limit is passed, and the headline says when the AI works again', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await page.route('**/api/me/usage**', async (route) => {
    const at = new Date(Date.now() + 86400_000).toISOString()
    await route.fulfill({ json: { period: 'month', from: at, to: at, totals: { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, byModel: [],
      limits: [{ scope: 'team', name: null, period: 'day', usedPct: 104, action: 'block', exceeded: true, resetsAt: at }] } })
  })
  await openFromMenu(page)
  await expect(page.getByTestId('my-usage-headline')).toContainText('Limit reached. You can use the AI again from')
  await expect(page.getByTestId('my-usage-limit').locator('[data-testid="usage-bar"] > div')).toHaveClass(/bg-danger/)
  await expect(page.getByTestId('my-usage-none')).toHaveText(t['usage.none'])
})

test('at phone width the rows stack and nothing scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await page.goto('/settings/usage')
  await expect(page.getByTestId('my-usage-limit')).toHaveCount(2)
  const overflow = await page.getByTestId('my-usage').evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)
  await audit(page, 'my usage, phone')
})

test('Admin > Usage: a title row with Download CSV, compact controls, one-line notes that open with More', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await page.goto('/admin/usage')
  await expect(page.getByTestId('usage-table')).toContainText('Olga')
  const header = page.getByTestId('usage-header')
  await expect(header.getByRole('heading', { name: t['admin.usage'] })).toBeVisible()
  await expect(header.getByTestId('usage-csv')).toBeVisible()
  const controls = page.getByTestId('usage-controls')
  await expect(controls.getByLabel(t['usage.groupBy'])).toBeVisible()
  await expect(controls.getByLabel(t['usage.pill.range'])).toBeVisible()
  await controls.getByLabel(t['usage.pill.range']).selectOption('custom')
  await expect(controls.getByLabel(t['usage.from'])).toBeVisible()
  await expect(controls.getByLabel(t['usage.to'])).toBeVisible()
  // the long notes are one line each until "More"
  const note = page.getByTestId('usage-cost-note')
  const oneLine = (await note.boundingBox())!.height
  await note.getByRole('button', { name: t['common.more'] }).click()
  expect((await note.boundingBox())!.height).toBeGreaterThan(oneLine)
  await expect(page.getByTestId('usage-table').locator('tfoot')).toContainText(t['usage.total'])
})

for (const scheme of ['light', 'dark'] as const) {
  test(`no serious accessibility problems on both usage pages (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page)
    await openFromMenu(page)
    await expect(page.getByTestId('my-usage-limit')).toHaveCount(2)
    await audit(page, `my usage, ${scheme}`)
    await page.goto('/admin/usage')
    await expect(page.getByTestId('usage-table')).toContainText('Olga')
    await audit(page, `admin usage, ${scheme}`)
  })
}
