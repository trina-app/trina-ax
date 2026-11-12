// Slack is one row of Admin › Connected apps (the owner's only), not an Admin menu item of its own (owner 2026-11-12;
// pages/admin/Integrations.tsx, Slack.tsx). Its old address /admin/slack, with the outcome "Add to Slack" came back
// with, opens its page there with Connected apps marked in the menu (AdminLayout.tsx).
import { expect, test } from '@playwright/test'
import { DICTS } from '../../src/i18n'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const t = DICTS.en
const slackRow = (page: import('@playwright/test').Page, kind = 'connected-app') => page.locator(`[data-testid="${kind}"][data-id="slack"]`)

test('the owner: Slack is a row of Connected apps that opens its page; the old address opens it there', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await page.goto('/admin/connectors')
  const menu = page.getByTestId('admin-menu')
  await expect(menu.getByRole('link', { name: 'Slack', exact: true })).toHaveCount(0)
  // the mock's Slack: an own app, connected
  await expect(slackRow(page).getByTestId('connector-row-status')).toHaveText(t['appConnectors.on'])
  await slackRow(page).getByTestId('connector-row-open').click()
  await expect(page).toHaveURL(/\/admin\/connectors\/slack$/)
  await expect(page.getByTestId('slack-status')).toContainText(t['slack.state.connected'])
  await expect(menu.getByRole('link', { name: t['admin.integrations'], exact: true })).toHaveAttribute('aria-current', 'page')
  await page.getByTestId('app-breadcrumb-connectors').click()
  await expect(page).toHaveURL(/\/admin\/connectors$/)
  await expect(slackRow(page)).toBeVisible()

  // the old address, as "Add to Slack" came back to it: the page in Connected apps says how it went, once
  await page.goto('/admin/slack?slack=installed')
  await expect(page.getByTestId('slack-outcome')).toHaveText(t['slack.install.done'])
  await expect(page).toHaveURL(/\/admin\/connectors\/slack$/)
  await expect(menu.getByRole('link', { name: t['admin.integrations'], exact: true })).toHaveAttribute('aria-current', 'page')
  expect(realErrors(errors)).toEqual([])
})

test('Slack on the row: Off, Reconnect after it was removed in Slack, and a Discover card before it is added', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  const slack = async (admin: Record<string, unknown>) => expect((await page.request.post('/__test/slack', { data: { admin } })).ok()).toBeTruthy()
  await slack({ enabled: false, state: 'off' })
  await page.goto('/admin/connectors')
  await expect(slackRow(page).getByTestId('connector-row-status')).toHaveText(t['appConnectors.off'])
  await slack({ mode: 'official', official: true, tokens: false, botName: null, state: 'off', lastError: 'removed' })
  await page.goto('/admin/connectors')
  await expect(slackRow(page).getByTestId('connector-row-status')).toHaveText(t['drive.reconnect'])
  await slackRow(page).getByTestId('connector-row-status').click()
  await expect(page.getByTestId('slack-removed')).toHaveText(t['slack.err.removed'])
  await expect(page.getByTestId('slack-add')).toBeVisible()
  await slack({ mode: 'own', official: true, tokens: false, enabled: false, workspace: null, botName: null, state: 'off', lastError: null })
  await page.goto('/admin/connectors')
  await expect(slackRow(page)).toHaveCount(0)
  const card = slackRow(page, 'connector-card')
  await expect(card).toBeVisible()
  await card.getByTestId('connector-add').click()
  await expect(page).toHaveURL(/\/admin\/connectors\/slack$/)
  await expect(page.getByTestId('slack-official')).toBeVisible()
})

test('an admin who is not the owner: no Slack in Connected apps; its page and old address lead away', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true, withAdmin: true })
  await signIn(page, { username: 'dana', password: 'dana password 1' })
  await page.goto('/admin/connectors')
  await expect(page.getByTestId('connector-discover')).toBeVisible()
  await expect(slackRow(page)).toHaveCount(0)
  await expect(slackRow(page, 'connector-card')).toHaveCount(0)
  await page.goto('/admin/connectors/slack')
  await expect(page).toHaveURL(/\/admin\/connectors$/)
  await page.goto('/admin/slack')
  await expect(page).toHaveURL(/\/admin$/)
})
