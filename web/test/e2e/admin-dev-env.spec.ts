// Team settings › Dev environment (pages/admin/DevEnvTeam.tsx): the team setting devEnv.team (PUT /api/admin/dev-env).
// A team with no projects turns it on here; the warning must be accepted first; a save sends only what changed (a
// change of network or limits stops every run); a server without the feature has no section.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'

const putBody = (page: Page) => page.waitForRequest((r) => r.url().endsWith('/api/admin/dev-env') && r.method() === 'PUT').then((r) => r.postDataJSON() as Record<string, unknown>)

test('srt: a team with no projects turns the dev environment on after the warning', async ({ page }) => {
  await reset(page)
  await page.request.post('/__test/dev-env', { data: { srt: true } })
  await signIn(page)
  await page.goto('/admin/settings')
  const card = page.getByTestId('dev-env-team')
  await expect(card).toHaveAttribute('data-on', 'false')
  await expect(card.getByTestId('dev-env-team-plan')).toContainText('3072')
  await expect(card.getByTestId('dev-env-team-save')).toBeDisabled()
  await card.locator('label', { has: page.getByTestId('dev-env-team-enabled') }).click()
  // the warning names the uploads through allowed sites; Save waits for the accept
  const warning = card.getByTestId('dev-env-team-warning')
  await expect(warning).toContainText('GitHub, npm, PyPI')
  await expect(card.getByTestId('dev-env-team-save')).toBeDisabled()
  const axe = await new AxeBuilder({ page }).include('[data-testid="dev-env-team"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([])
  await warning.getByTestId('dev-env-team-accept').check()
  const body = putBody(page)
  await card.getByTestId('dev-env-team-save').click()
  expect(await body).toEqual({ enabled: true, acceptWarning: 2 })
  await expect(card).toHaveAttribute('data-on', 'true')
  await expect(card.getByTestId('dev-env-team-warning')).toHaveCount(0)
  // after a reload it is still on, and the warning is not asked again
  await page.reload()
  await expect(page.getByTestId('dev-env-team')).toHaveAttribute('data-on', 'true')
  await expect(page.getByTestId('dev-env-team-warning')).toHaveCount(0)
})

test('srt: who, network, limits and sites; only the changed fields are sent; a limit is cut to the plan', async ({ page }) => {
  await reset(page)
  await page.request.post('/__test/dev-env', { data: { srt: true } })
  await signIn(page)
  await page.goto('/admin/settings')
  const card = page.getByTestId('dev-env-team')
  await card.getByTestId('dev-env-team-sites').fill('api.example.com\n*.example.org\napi.example.com')
  let body = putBody(page)
  // wait for the answer too: the form takes the saved setting from it, which would undo an edit made before it came
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/admin/dev-env') && r.request().method() === 'PUT')
  await card.getByTestId('dev-env-team-save').click()
  expect(await body).toEqual({ extraDomains: ['api.example.com', '*.example.org'] })
  await saved
  await expect(card.getByTestId('dev-env-team-save')).toBeDisabled()
  // memory above the plan (3072 MB) is cut to it; network offline
  await card.getByTestId('dev-env-team-memoryMiB').fill('8000')
  await card.getByTestId('dev-env-team-memoryMiB').blur()
  await expect(card.getByTestId('dev-env-team-memoryMiB')).toHaveValue('3072')
  await card.getByTestId('dev-env-team-network').selectOption('offline')
  await card.getByTestId('dev-env-team-selected').check()
  body = putBody(page)
  await card.getByTestId('dev-env-team-save').click()
  expect(await body).toEqual({ scope: { mode: 'selected', groupIds: [], userIds: [] }, network: 'offline', limits: { memoryMiB: 3072 } })
})

test('the box runner: only the extra sites; no switch for the team', async ({ page }) => {
  await reset(page)
  await page.request.post('/__test/dev-env', { data: {} })
  await signIn(page)
  await page.goto('/admin/settings')
  const card = page.getByTestId('dev-env-team')
  await expect(card.getByTestId('dev-env-team-sites')).toBeVisible()
  await expect(card.getByTestId('dev-env-team-enabled')).toHaveCount(0)
  await expect(card.getByTestId('dev-env-team-network')).toHaveCount(0)
})

test('a server without the dev environment has no section', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/admin/settings')
  await expect(page.getByTestId('team-ai-vision')).toBeVisible()
  await expect(page.getByTestId('dev-env-team')).toHaveCount(0)
})
