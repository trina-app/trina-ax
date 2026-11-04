// Admin > Activity log (pages/admin/Audit.tsx, lib/activity.ts): the title and the filters stay at the top while the list
// scrolls; the filters are one compact row kept in the address; the list is grouped by day, reads as sentences, folds
// repeats into one row that opens, and shows each row's details on a click. The mock's rows: test/mock/server.ts auditRows.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { DICTS } from '../../src/i18n'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const t = DICTS.en
const WIDE = { width: 1360, height: 560 }
const PHONE = { width: 390, height: 640 }

async function open(page: Page, query = '') {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await page.goto(`/admin/audit${query}`)
  await expect(page.getByTestId('audit-list')).toBeVisible()
}
const rows = (page: Page) => page.getByTestId('activity-row')
const chip = (page: Page, name: string) => page.getByTestId('activity-kinds').getByRole('button', { name, exact: true })

for (const [name, size] of [['wide', WIDE], ['phone', PHONE]] as const) {
  test(`the title and the filters stay at the top while the list scrolls (${name})`, async ({ page }) => {
    await page.setViewportSize(size)
    await open(page)
    const header = page.getByTestId('activity-header')
    const box = page.getByTestId('admin-content')
    expect(await box.evaluate((el) => el.scrollHeight > el.clientHeight + 200)).toBe(true)
    await box.evaluate((el) => el.scrollTo(0, el.scrollHeight))
    await expect.poll(() => box.evaluate((el) => el.scrollTop)).toBeGreaterThan(200)
    await expect.poll(async () => Math.abs((await header.boundingBox())!.y - (await box.boundingBox())!.y)).toBeLessThanOrEqual(1)
    await expect(header.getByRole('heading', { name: t['admin.audit'] })).toBeInViewport()
    await expect(page.getByTestId('activity-kinds')).toBeInViewport()
    // the page itself never scrolls, and the row is filled with the page's own colour (nothing shows through)
    expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0)
    expect(await header.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor))
    // the day's label sticks just under the row
    const label = page.getByTestId('activity-day').last().getByRole('heading')
    await expect(label).toBeInViewport()
    if (name === 'phone') {
      // the kind stays in view; the person, the time and the search are behind "Filters"
      await expect(page.getByTestId('activity-who')).toBeHidden()
      await page.getByTestId('activity-more').click()
      await expect(page.getByTestId('activity-who')).toBeVisible()
      await expect(page.getByTestId('activity-search')).toBeVisible()
      expect(await page.evaluate(() => document.scrollingElement!.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
    } else {
      await expect(page.getByTestId('activity-more')).toBeHidden()
      await expect(page.getByTestId('activity-search')).toBeInViewport()
    }
  })
}

test('kind, person, time and search are kept in the address, and Clear resets them', async ({ page }) => {
  const errors = watchConsole(page)
  await open(page)
  await expect(chip(page, t['audit.all'])).toHaveAttribute('aria-pressed', 'true')
  await chip(page, t['activity.chip.auth']).click()
  await expect(page).toHaveURL(/[?&]kind=auth\b/)
  await expect(chip(page, t['activity.chip.auth'])).toHaveAttribute('aria-pressed', 'true')
  await expect(rows(page).first()).toHaveAttribute('data-kind', 'auth')
  await expect.poll(() => rows(page).evaluateAll((els) => els.every((e) => e.getAttribute('data-kind') === 'auth'))).toBe(true)

  await page.getByTestId('activity-who').selectOption('bob')
  await expect(page).toHaveURL(/[?&]who=bob\b/)
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page).first()).toContainText('Bob signed in')

  await page.getByTestId('activity-range').selectOption('today')
  await expect(page).toHaveURL(/[?&]range=today\b/)
  // a reload keeps the view
  await page.reload()
  await expect(chip(page, t['activity.chip.auth'])).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('activity-who')).toHaveValue('bob')
  await expect(page.getByTestId('activity-range')).toHaveValue('today')
  await expect(rows(page)).toHaveCount(1)

  await page.getByTestId('activity-clear').click()
  await expect(page).toHaveURL(/\/admin\/audit$/)
  await expect(chip(page, t['audit.all'])).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('activity-clear')).toHaveCount(0)

  // words search the loaded rows; a folder path asks the server for file events under it
  await page.getByTestId('activity-search').fill('salaries')
  await expect(page).toHaveURL(/[?&]q=salaries\b/)
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page).first()).toContainText(t['audit.denied'])
  await page.getByTestId('activity-search').fill('finance/2026')
  await expect(page).toHaveURL(/[?&]q=finance%2F2026\b/)
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page).first()).toHaveAttribute('data-kind', 'file')
  await expect(rows(page).first()).toContainText('finance/2026/plan.md')
  await page.getByTestId('activity-search').fill('nobody-did-this')
  await expect(page.getByTestId('activity-empty')).toContainText(t['audit.none'])

  // a custom range shows its two days
  await page.getByTestId('activity-clear').first().click()
  await page.getByTestId('activity-range').selectOption('custom')
  await expect(page.getByTestId('audit-from')).toBeVisible()
  await expect(page.getByTestId('audit-to')).toBeVisible()
  expect(realErrors(errors)).toEqual([])
})

test('grouped by day, repeats folded into one row that opens, and each row has its details', async ({ page }) => {
  await open(page)
  const days = page.getByTestId('activity-day')
  await expect(days.nth(0).getByRole('heading')).toHaveText(t['sidebar.today'])
  await expect(days.nth(1).getByRole('heading')).toHaveText(t['sidebar.yesterday'])
  // a sentence, with the action id in the tooltip
  await expect(rows(page).first()).toContainText('Olga created an invite link')
  await expect(page.getByTestId('audit-list').locator('[title="invite.create"]').first()).toBeVisible()
  await expect(days.nth(1)).toContainText('Olga team skill changed · skills/weekly-team-report/SKILL.md')

  // Bob's five sign-ins: one row, "5 times", the IP once; it opens to each one
  const run = rows(page).filter({ has: page.getByTestId('activity-times') })
  await expect(run).toHaveCount(1)
  await expect(run).toContainText('Bob signed in · 5 times')
  await expect(run.getByTestId('audit-ip')).toHaveText('10.0.0.7')
  await run.getByRole('button').click()
  await expect(run.getByRole('button')).toHaveAttribute('aria-expanded', 'true')
  await expect(run.getByTestId('activity-times-list').locator('li')).toHaveCount(5)
  await expect(run.getByTestId('activity-detail')).toContainText('Bob (bob)')

  // one event: its details, and they close again
  const first = rows(page).first()
  await first.getByRole('button').click()
  const detail = first.getByTestId('activity-detail')
  await expect(detail).toContainText('invite.create')
  await expect(detail).toContainText('Olga (olga)')
  await expect(detail).toContainText('role')
  await first.getByRole('button').click()
  await expect(detail).toHaveCount(0)

  // an AI tool call: who, the tool, and that it was refused
  const tool = rows(page).filter({ hasText: 'salaries' })
  await expect(tool).toContainText('Bob · AI used read')
  await expect(tool).toContainText(t['audit.denied'])

  // older rows page in
  const before = await rows(page).count()
  await page.getByTestId('activity-load-more').click()
  await expect.poll(() => rows(page).count()).toBeGreaterThan(before)
})

for (const scheme of ['light', 'dark'] as const) {
  test(`the activity log has no serious accessibility problems (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await open(page)
    await rows(page).filter({ has: page.getByTestId('activity-times') }).getByRole('button').click()
    await page.getByTestId('activity-range').selectOption('custom')
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
    const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    expect(serious.map((v) => `${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
  })
}
