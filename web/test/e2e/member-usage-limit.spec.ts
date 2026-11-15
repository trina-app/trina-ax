// A person's usage limit from Admin › Members (pages/admin/Members.tsx, pages/admin/BudgetForm.tsx; QA TC-2507..2511):
// the row's "…" › Usage limit… sets it, the row says it in one quiet line, Team settings › Usage limits lists the same
// one, and opening it again edits it. A phone: the person's page has a Usage limit row that opens the same dialog.
import { expect, test, type Page } from '@playwright/test'
import { DICTS } from '../../src/i18n'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const t = DICTS.en
// the mock answers every new limit with 1,234 tokens used (test/mock/server.ts createBudget)

async function start(page: Page) {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
}

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } })
  test('set a member\'s limit from their row, see it there and in Team settings, then edit it', async ({ page }) => {
    const errors = watchConsole(page)
    await start(page)
    await page.goto('/admin/members')
    const bob = page.getByTestId('members-table').getByRole('row').filter({ has: page.getByTestId('member-role-bob') })
    await expect(bob.getByTestId('member-limit-bob')).toHaveCount(0)
    await bob.getByTestId('member-more').click()
    await page.getByTestId('member-usage-limit-bob').click()
    const dialog = page.getByRole('dialog', { name: 'Usage limit for Bob' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText(t['budgets.for'])).toHaveCount(0)
    await expect(dialog.getByTestId('budget-remove')).toHaveCount(0)
    await dialog.getByTestId('budget-tokens').fill('50000')
    await dialog.getByTestId('budget-action').selectOption('block')
    await dialog.getByTestId('budget-save').click()
    await expect(dialog).toHaveCount(0)
    await expect(bob.getByTestId('member-limit-bob')).toHaveText('50,000 tokens a month')

    // the same limit in Team settings › Usage limits
    await page.goto('/admin/settings#ai-limits')
    await expect(page.getByTestId('engine-budgets')).toContainText('Bob')
    await expect(page.getByTestId('engine-budgets')).toContainText(t['budgets.block'])

    // opened again: it edits that limit (no second one)
    await page.goto('/admin/members')
    await bob.getByTestId('member-more').click()
    await page.getByTestId('member-usage-limit-bob').click()
    await expect(dialog.getByTestId('budget-tokens')).toHaveValue('50000')
    await expect(dialog.getByTestId('budget-used')).toHaveText('1,234 of 50,000 tokens this month')
    await dialog.getByTestId('budget-tokens').fill('1000')
    await dialog.getByTestId('budget-save').click()
    await expect(bob.getByTestId('member-limit-bob')).toHaveText(`1,000 tokens a month · ${t['budgets.over']}`)
    const listed = await page.evaluate(async () => (await (await fetch('/api/admin/budgets')).json()) as { items: unknown[] })
    expect(listed.items).toHaveLength(1)

    // Remove limit takes it away
    await bob.getByTestId('member-more').click()
    await page.getByTestId('member-usage-limit-bob').click()
    await dialog.getByTestId('budget-remove').click()
    await expect(dialog).toHaveCount(0)
    await expect(bob.getByTestId('member-limit-bob')).toHaveCount(0)
    expect(realErrors(errors)).toEqual([])
  })
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('the person\'s page: a Usage limit row that opens the same dialog; it fits the screen', async ({ page }) => {
    await start(page)
    await page.goto('/admin/members')
    await page.getByTestId('member-card-bob').click()
    const row = page.getByTestId('member-page-limit')
    await expect(page.getByTestId('member-page-limit-value')).toHaveText(t['budgets.noLimit'])
    await row.click()
    const dialog = page.getByRole('dialog', { name: 'Usage limit for Bob' })
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('budget-tokens').fill('200000')
    await dialog.getByTestId('budget-save').click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId('member-page-limit-value')).toHaveText('1,234 of 200,000 tokens this month')
    // nothing runs off the side
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  })
})
