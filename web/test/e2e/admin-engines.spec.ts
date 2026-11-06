// Admin › Providers (pages/admin/Engines.tsx): one quiet row per engine that opens in place, no tabs; ?engine=<id> opens
// a row. The team's AI settings it used to have in a second tab are in Team settings (TeamAiSettings.tsx), groups whose
// Save shows only once something in them changed; the old ?tab=team address opens them at #ai (focus=limits:
// #ai-limits).
import { expect, test, type Page } from '@playwright/test'
import { DICTS } from '../../src/i18n'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const t = DICTS.en

async function start(page: Page) {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
}

test('Providers: one row per engine with its state, what is missing, check again and the switch; a row opens in place', async ({ page }) => {
  const errors = watchConsole(page)
  await start(page)
  await page.goto('/admin/providers')
  await expect(page.getByRole('heading', { level: 2, name: t['admin.providers'], exact: true })).toBeVisible()
  // one list, no tabs: the team's AI settings are in Team settings
  await expect(page.getByTestId('engines-header').getByRole('tablist')).toHaveCount(0)
  await expect(page.getByTestId('engine-defaults')).toHaveCount(0)
  const rows = page.getByTestId('engine-card')
  await expect(rows).toHaveCount(3)
  const claude = page.locator('[data-engine="claude-code"]')
  const codex = page.locator('[data-engine="codex"]')
  await expect(claude).toContainText(t['engines.status.ok'])
  await expect(claude).toContainText('Sonnet, Opus')
  // what is missing stays on the row, in one line
  await expect(codex).toContainText(t['engines.status.not_logged_in'])
  await expect(codex.getByTestId('engine-detail')).toContainText('codex login --device-auth')
  // the details are closed until the name opens them
  await expect(page.getByTestId('engine-details')).toHaveCount(0)
  const open = claude.getByTestId('engine-open')
  await expect(open).toHaveAttribute('aria-expanded', 'false')
  await open.click()
  await expect(open).toHaveAttribute('aria-expanded', 'true')
  await expect(claude.getByTestId('engine-details')).toContainText('v2.1.305')
  await expect(claude.getByTestId('engine-details')).toContainText(t['engines.localHelp'].slice(0, 30))
  await open.click()
  await expect(claude.getByTestId('engine-details')).toHaveCount(0)

  // check again asks the server about this engine only
  const checked = page.waitForRequest((r) => r.method() === 'POST' && /\/api\/admin\/engines\/codex\/check$/.test(r.url()))
  await codex.getByRole('button', { name: t['engines.check'], exact: true }).click()
  await checked

  // the switch is named after its engine and is kept on the server
  const sw = page.getByRole('checkbox', { name: 'Use Codex', exact: true })
  await expect(sw).toBeChecked()
  await codex.locator('label').filter({ has: page.getByTestId('engine-switch-codex') }).click()
  await expect(sw).not.toBeChecked()
  await page.reload()
  await expect(page.getByRole('checkbox', { name: 'Use Codex', exact: true })).not.toBeChecked()
  expect(realErrors(errors)).toEqual([])
})

test('the owner sets up the API engine from its row; ?engine=api opens it', async ({ page }) => {
  await start(page)
  await page.goto('/admin/providers?engine=api')
  const api = page.locator('[data-engine="api"]')
  await expect(api.getByTestId('engine-open')).toHaveAttribute('aria-expanded', 'true')
  await expect(api.getByTestId('engine-experimental')).toBeVisible()
  const form = api.getByTestId('api-engine-form')
  await expect(form).toBeVisible()
  await form.getByLabel(t['engines.api.preset']).selectOption('openrouter')
  await expect(form.getByLabel(t['engines.api.baseUrl'])).toHaveValue('https://openrouter.ai/api/v1')
  const saved = page.waitForRequest((r) => r.method() === 'PUT' && /\/api\/admin\/engines\/api-config$/.test(r.url()))
  await form.getByRole('button', { name: t['engines.api.save'], exact: true }).click()
  expect((await saved).postDataJSON()).toMatchObject({ baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4.1' })
})

test('the old Team provider settings address opens Team settings at #ai; a group shows Save only once something changed', async ({ page }) => {
  const errors = watchConsole(page)
  await start(page)
  await page.goto('/admin/providers?tab=team')
  await expect(page).toHaveURL(/\/admin\/settings#ai$/)
  // the AI groups are part of Team settings, under its own groups, and the first one's title has the focus
  await expect(page.getByTestId('team-settings')).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: t['teamAi.defaults'] })).toBeFocused()
  await expect(page.getByTestId('admin-menu').getByRole('link', { name: t['admin.settings'], exact: true })).toHaveAttribute('aria-current', 'page')

  const defaults = page.getByTestId('engine-defaults')
  const choice = page.getByTestId('engine-choice')
  await expect(page.getByTestId('engine-budgets')).toBeVisible()
  await expect(page.getByTestId('member-accounts')).toBeVisible()
  // nothing changed: no Save anywhere
  await expect(page.getByTestId('engine-defaults-save')).toHaveCount(0)
  await expect(page.getByTestId('engine-choice-save')).toHaveCount(0)

  // a change shows Save and Cancel in its own group; Cancel puts it back. The team form's save bar stays away: these
  // save on their own
  const concurrency = defaults.getByLabel(t['engines.concurrency'])
  await expect(concurrency).toHaveValue('2')
  await concurrency.fill('4')
  await expect(page.getByTestId('engine-defaults-save')).toBeVisible()
  await expect(page.getByTestId('team-settings-savebar')).toHaveCount(0)
  await defaults.getByRole('button', { name: t['common.cancel'], exact: true }).click()
  await expect(concurrency).toHaveValue('2')
  await expect(page.getByTestId('engine-defaults-save')).toHaveCount(0)

  // Save keeps it; Save goes away again
  const saved = page.waitForRequest((r) => r.method() === 'PATCH' && /\/api\/admin\/engines$/.test(r.url()))
  await concurrency.fill('4')
  await page.getByTestId('engine-defaults-save').click()
  expect((await saved).postDataJSON()).toMatchObject({ concurrency: 4 })
  await expect(page.getByTestId('engine-defaults-save')).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('engine-defaults').getByLabel(t['engines.concurrency'])).toHaveValue('4')

  // who picks the engine: the same
  await choice.getByTestId('engine-choice-everyone').click()
  await expect(page.getByTestId('engine-choice-save')).toBeVisible()
  await page.getByTestId('engine-choice-save').click()
  await expect(page.getByTestId('engine-choice-save')).toHaveCount(0)
  await expect(choice.getByTestId('engine-choice-everyone')).toHaveAttribute('aria-checked', 'true')
  expect(realErrors(errors)).toEqual([])
})

test('a usage-limits link opens Team settings at Usage limits, with the focus on its title', async ({ page }) => {
  await start(page)
  await page.goto('/admin/providers?tab=team&focus=limits')
  await expect(page).toHaveURL(/\/admin\/settings#ai-limits$/)
  await expect(page.getByRole('heading', { level: 2, name: t['budgets.title'] })).toBeFocused()
  await expect(page.getByTestId('budget-new')).toBeInViewport()
  // the same from Admin › Usage
  await page.goto('/admin/usage')
  await page.getByTestId('usage-limits-link').click()
  await expect(page).toHaveURL(/\/admin\/settings#ai-limits$/)
  await expect(page.getByRole('heading', { level: 2, name: t['budgets.title'] })).toBeFocused()
})

test('Providers and the AI groups of Team settings fit a phone: nothing runs off the side, the switches stay in reach', async ({ page }) => {
  await start(page)
  await page.setViewportSize({ width: 390, height: 800 })
  for (const [url, id] of [['/admin/providers?engine=api', 'engines-header'], ['/admin/settings#ai', 'team-ai-settings']]) {
    await page.goto(url)
    await expect(page.getByTestId(id)).toBeVisible()
    const content = page.getByTestId('admin-content')
    await expect.poll(() => content.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  }
  await page.goto('/admin/providers')
  for (const id of ['claude-code', 'codex', 'api']) await expect(page.locator(`[data-engine="${id}"] label`).filter({ has: page.getByTestId(`engine-switch-${id}`) })).toBeInViewport()
})
