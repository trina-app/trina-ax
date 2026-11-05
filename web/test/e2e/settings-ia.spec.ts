// Admin and Settings, reorganised (pages/admin/AdminLayout.tsx, pages/settingsTabs.ts, components/settings/SettingsDialog.tsx):
// Admin's groups People · AI · Connections · Activity · Team, one "AI providers" page instead of AI engines plus AI
// connections (each provider with its own accounts and Add account), the old addresses leading there, Settings' named
// groups Account · AI · Connections · App, and every page saying whether it is for the whole team or just for you.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { DICTS, type MessageKey } from '../../src/i18n'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const t = DICTS.en
const ADMIN: [MessageKey, MessageKey[]][] = [
  ['admin.group.people', ['admin.members', 'admin.groups', 'admin.folders']],
  ['admin.group.ai', ['admin.providers']],
  ['admin.group.connections', ['admin.integrations', 'connectors.title', 'aiApps.title', 'admin.plugins']],
  ['admin.group.activity', ['admin.usage', 'admin.audit']],
  ['admin.group.team', ['admin.settings', 'admin.system']],
]
const SETTINGS: [string, MessageKey[]][] = [
  ['account', ['settings.profile', 'settings.security', 'settings.usage']],
  ['ai', ['settings.providers', 'settings.memory']],
  ['connections', ['integrations.title', 'connectors.title', 'aiApps.title']],
  ['app', ['notifications.title', 'settings.apps', 'settings.about']],
]

async function start(page: Page) {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
}

test('Admin: the five groups, one AI providers item and no AI connections; every page says it is for the whole team', async ({ page }) => {
  const errors = watchConsole(page)
  await start(page)
  await page.goto('/admin')
  const menu = page.getByTestId('admin-menu')
  for (const [group, items] of ADMIN) {
    const g = menu.getByRole('group', { name: t[group] })
    await expect(g.getByRole('link')).toHaveText(items.map((k) => t[k]))
  }
  await expect(menu.getByRole('link', { name: 'AI connections' })).toHaveCount(0)
  await expect(menu.getByRole('link', { name: 'AI engines' })).toHaveCount(0)
  for (const path of ['/admin/members', '/admin/providers', '/admin/integrations', '/admin/app-connectors', '/admin/settings']) {
    await page.goto(path)
    await expect(page.getByTestId('admin-content').getByTestId('page-scope').first()).toHaveText(t['scope.team'])
  }
  expect(realErrors(errors)).toEqual([])
})

test('AI providers: each engine row lists its own accounts with Add account for just its kinds', async ({ page }) => {
  await start(page)
  await page.goto('/admin/providers')
  await expect(page.getByTestId('engines-header')).toContainText(t['admin.providers'])
  const claude = page.locator('[data-engine="claude-code"]')
  await expect(claude.getByTestId('provider-accounts-claude')).toBeVisible()
  await claude.getByTestId('provider-add-claude').click()
  const kinds = await page.getByRole('dialog').locator('input[name="kind"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
  expect(kinds).toEqual(['kind-anthropic-api-key', 'kind-anthropic-oauth'])
  await page.getByRole('dialog').getByRole('button', { name: t['common.cancel'] }).click()
  const codex = page.locator('[data-engine="codex"]')
  await codex.getByTestId('provider-add-codex').click()
  const codexKinds = await page.getByRole('dialog').locator('input[name="kind"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
  expect(codexKinds).toEqual(['kind-openai-api-key', 'kind-chatgpt'])
  await page.getByRole('dialog').getByRole('button', { name: t['common.cancel'] }).click()
  // the API engine has its own form, no account list
  await expect(page.locator('[data-engine="api"]').getByTestId('provider-accounts-claude')).toHaveCount(0)
  // members' own accounts: in Team provider settings
  await page.getByRole('tab', { name: t['engines.tab.team'] }).click()
  await expect(page.getByTestId('member-accounts')).toContainText(t['providers.memberAccounts'])
})

test('old addresses: AI engines and AI connections open AI providers (with the provider open), Settings › AI connections opens AI providers', async ({ page }) => {
  await start(page)
  await page.goto('/admin/engines?tab=team')
  await expect(page).toHaveURL(/\/admin\/providers\?tab=team$/)
  await expect(page.getByTestId('engine-choice')).toBeVisible()
  await page.goto('/admin/credentials')
  await expect(page).toHaveURL(/\/admin\/providers\?engine=claude-code$/)
  await expect(page.locator('[data-engine="claude-code"]').getByTestId('engine-details')).toBeVisible()
  await page.goto('/settings/credentials')
  await expect(page).toHaveURL(/\/settings\/providers$/)
  await expect(page.getByTestId('my-providers')).toBeVisible()
})

test('Settings: named groups Account, AI, Connections, App; every section says it is just for you', async ({ page }) => {
  await start(page)
  await page.goto('/settings/profile')
  const list = page.getByTestId('settings-menu')
  for (const [group, items] of SETTINGS) {
    const g = list.getByTestId(`settings-group-${group}`)
    await expect(g.getByText(t[`settings.group.${group}` as MessageKey], { exact: true })).toBeVisible()
    await expect(g.getByRole('link')).toHaveText(items.map((k) => t[k]))
  }
  for (const path of ['/settings/profile', '/settings/providers', '/settings/integrations', '/settings/connectors']) {
    await page.goto(path)
    await expect(page.getByTestId('settings-content').getByTestId('page-scope')).toHaveText(t['scope.you'])
  }
})

test('phone width: the Admin strip and the Settings list keep every item without sideways page scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await start(page)
  await page.goto('/admin/providers')
  await expect(page.getByTestId('admin-menu').getByRole('link', { name: t['admin.providers'] })).toBeAttached()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.goto('/settings')
  await expect(page.getByTestId('settings-group-connections')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

for (const scheme of ['light', 'dark'] as const) {
  test(`AI providers, the Admin menu and the Settings groups have no serious accessibility problems (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await start(page)
    const audit = async () => {
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
      return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)
    }
    await page.goto('/admin/providers')
    await expect(page.getByTestId('provider-accounts-claude')).toBeVisible()
    expect(await audit()).toEqual([])
    await page.goto('/admin/providers?tab=team')
    await expect(page.getByTestId('member-accounts')).toBeVisible()
    expect(await audit()).toEqual([])
    await page.goto('/settings/providers')
    await expect(page.getByTestId('my-providers')).toBeVisible()
    expect(await audit()).toEqual([])
  })
}
