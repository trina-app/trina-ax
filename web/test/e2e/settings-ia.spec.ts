// Admin and Settings, reorganised (pages/admin/AdminLayout.tsx, pages/settingsTabs.ts, components/settings/SettingsDialog.tsx):
// Admin's groups People · Connections · Activity · Team, one "Providers" page (first in Connections) instead of AI
// engines plus AI connections (each provider with its own accounts and Add account), the old addresses leading there,
// the team's AI settings in Team settings (#ai), Settings' named groups Account · Connections · App, and every page
// saying whether it is for the whole team or just for you.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { DICTS, type MessageKey } from '../../src/i18n'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const t = DICTS.en
const ADMIN: [MessageKey, MessageKey[]][] = [
  ['admin.group.people', ['admin.members', 'admin.groups', 'admin.folders']],
  // the owner (this test signs in as the owner) also has Slack, owner-only (AdminLayout MENU)
  ['admin.group.connections', ['admin.providers', 'admin.integrations', 'aiApps.title', 'admin.plugins', 'slack.admin.title']],
  ['admin.group.activity', ['admin.usage', 'admin.audit']],
  ['admin.group.team', ['admin.settings', 'admin.system']],
]
const SETTINGS: [string, MessageKey[]][] = [
  ['account', ['settings.profile', 'settings.security', 'settings.usage', 'settings.memory', 'settings.allowances']],
  ['connections', ['settings.providers', 'integrations.title', 'aiApps.title']],
  ['app', ['notifications.title', 'settings.apps', 'settings.about']],
]

async function start(page: Page) {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
}

test('Admin: four groups, Providers first in Connections, no AI group and no AI connections; every page says it is for the whole team', async ({ page }) => {
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
  await expect(menu.getByRole('link', { name: 'AI providers' })).toHaveCount(0)
  await expect(menu.getByRole('group')).toHaveCount(ADMIN.length)
  // the shell says whose it is: the menu's title is the team's, and one line above every page says it applies to everyone
  // in the team; the page titles are the same nouns as Settings' (Connectors is "Connectors" in both)
  const team = 'Acme'
  await expect(page.getByTestId('admin-title')).toHaveText(t['admin.teamTitle'].replace('{team}', team))
  await expect(page.getByTestId('admin-team-logo')).toBeAttached()
  for (const path of ['/admin/members', '/admin/providers', '/admin/connectors', '/admin/ai-apps', '/admin/plugins', '/admin/audit', '/admin/settings']) {
    await page.goto(path)
    await expect(page.getByTestId('admin-content').getByTestId('page-scope')).toHaveText(t['scope.teamName'].replace('{team}', team))
  }
  await page.goto('/admin/connectors')
  await expect(page.getByTestId('connectors-header').getByRole('heading', { name: t['admin.integrations'], exact: true })).toBeVisible()
  expect(realErrors(errors)).toEqual([])
})

test('Providers: each engine row lists its own accounts with Add account for just its kinds', async ({ page }) => {
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
  // members' own accounts: in Team settings, with the team's other AI settings
  await expect(page.getByTestId('member-accounts')).toHaveCount(0)
  await page.goto('/admin/settings')
  await expect(page.getByTestId('team-ai-settings').getByTestId('member-accounts')).toContainText(t['providers.memberAccounts'])
})

test('old addresses: AI engines and AI connections open Providers (with the provider open), their team tab opens Team settings, Settings › AI connections opens Providers', async ({ page }) => {
  await start(page)
  await page.goto('/admin/engines?tab=team')
  await expect(page).toHaveURL(/\/admin\/settings#ai$/)
  await expect(page.getByTestId('engine-choice')).toBeVisible()
  await page.goto('/admin/engines')
  await expect(page).toHaveURL(/\/admin\/providers$/)
  await page.goto('/admin/credentials')
  await expect(page).toHaveURL(/\/admin\/providers\?engine=claude-code$/)
  await expect(page.locator('[data-engine="claude-code"]').getByTestId('engine-details')).toBeVisible()
  await page.goto('/settings/credentials')
  await expect(page).toHaveURL(/\/settings\/providers$/)
  await expect(page.getByTestId('my-providers')).toBeVisible()
})

test('Settings: named groups Account, Connections, App (Providers first in Connections); every section says it is just for you', async ({ page }) => {
  await start(page)
  await page.goto('/settings/profile')
  const list = page.getByTestId('settings-menu')
  for (const [group, items] of SETTINGS) {
    const g = list.getByTestId(`settings-group-${group}`)
    await expect(g.getByText(t[`settings.group.${group}` as MessageKey], { exact: true })).toBeVisible()
    await expect(g.getByRole('link')).toHaveText(items.map((k) => t[k]))
  }
  // no AI group any more: Providers is under Connections, Memory under Account
  await expect(list.getByTestId('settings-group-ai')).toHaveCount(0)
  for (const path of ['/settings/profile', '/settings/providers']) {
    await page.goto(path)
    await expect(page.getByTestId('settings-content').getByTestId('page-scope')).toHaveText(t['scope.you'])
  }
  // Connectors is its own page in the sidebar: its section and the older addresses lead there
  for (const path of ['/settings/integrations', '/settings/connectors']) {
    await page.goto(path)
    await expect(page).toHaveURL(/\/connectors$/)
  }
  await expect(page.getByTestId('connectors-header').getByRole('heading', { name: t['integrations.title'], exact: true })).toBeAttached()
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
  test(`Providers, the AI groups of Team settings, the Admin menu and the Settings groups have no serious accessibility problems (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await start(page)
    const audit = async () => {
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
      return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)
    }
    await page.goto('/admin/providers')
    await expect(page.getByTestId('provider-accounts-claude')).toBeVisible()
    expect(await audit()).toEqual([])
    await page.goto('/admin/settings#ai')
    await expect(page.getByTestId('member-accounts')).toBeVisible()
    await expect(page.getByTestId('engine-budgets')).toBeVisible()
    expect(await audit()).toEqual([])
    await page.goto('/settings/providers')
    await expect(page.getByTestId('my-providers')).toBeVisible()
    expect(await audit()).toEqual([])
  })
}
