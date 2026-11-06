// Admin › Team settings › Knowledge graph (pages/admin/KnowledgeGraph.tsx; server/src/knowledge-graph/): the switch, the
// indexed folders with their counts and state, personal folders only as a total, added folders, disk use and Rebuild,
// the hint to install CodeGraph when it is missing, in both themes, on a phone, with no serious accessibility problem.
// The mock's folders are made up (test/mock/server.ts mockKnowledgeGraph).
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { DICTS } from '../../src/i18n'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const t = DICTS.en

async function open(page: Page, o: { available?: boolean } = {}) {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  if (o.available === false) expect((await page.request.post('/__test/knowledge-graph', { data: { available: false } })).ok()).toBeTruthy()
  await signIn(page)
  await page.goto('/admin/settings#knowledge-graph')
  await expect(page.getByTestId('knowledge-graph')).toBeVisible()
}

async function audit(page: Page, where: string) {
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => {}))))
  const r = await new AxeBuilder({ page }).include('[data-testid="knowledge-graph"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

test('the indexed folders with their counts and state; personal folders only as a total', async ({ page }) => {
  const errors = watchConsole(page)
  await open(page)
  const kg = page.getByTestId('knowledge-graph')
  await expect(kg.getByRole('heading', { level: 2 })).toHaveText(t['kg.title'])
  await expect(page.getByRole('checkbox', { name: t['kg.enable'] })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: t['kg.enable'] })).toHaveAccessibleDescription(t['kg.enableDesc'])
  const rows = kg.getByTestId('kg-root')
  await expect(rows).toHaveCount(3)
  const web = rows.filter({ hasText: 'projects/web-app' })
  await expect(web).toHaveAttribute('data-status', 'ready')
  await expect(web).toContainText('128 files')
  await expect(web).toContainText('symbols')
  await expect(web).toContainText(t['kg.status.ready'])
  await expect(rows.filter({ hasText: 'projects/data-pipeline' })).toContainText(t['kg.status.indexing'])
  await expect(kg.getByTestId('kg-personal')).toContainText('2 personal folders')
  await expect(kg).not.toContainText('users/')
  await expect(kg.getByTestId('kg-disk')).toContainText('used on the server')
  await expect(kg.getByTestId('kg-disk')).toContainText('CodeGraph 1.5.0')
  expect(realErrors(errors)).toEqual([])
})

test('added folders: added, refused with the reason, removed', async ({ page }) => {
  await open(page)
  const input = page.getByLabel(t['kg.addTitle'], { exact: true })
  await input.fill('tools/scripts')
  await input.press('Enter')
  await expect(page.getByTestId('kg-added-item')).toHaveText('tools/scripts')
  await expect(input).toHaveValue('')
  await input.fill('users/someone')
  await page.getByTestId('kg-add-button').click()
  await expect(page.getByTestId('kg-add-error')).toHaveText(t['kg.added.personal'])
  await expect(input).toHaveAttribute('aria-invalid', 'true')
  await input.fill('nope/missing')
  await page.getByTestId('kg-add-button').click()
  await expect(page.getByTestId('kg-add-error')).toHaveText(t['kg.added.notFound'])
  await page.getByRole('button', { name: t['kg.removeAdded'].replace('{path}', 'tools/scripts') }).click()
  await expect(page.getByTestId('kg-added-item')).toHaveCount(0)
})

test('rebuild asks first, then the folders wait and come back', async ({ page }) => {
  await open(page)
  await page.getByTestId('kg-rebuild').click()
  await expect(page.getByRole('dialog')).toContainText(t['kg.rebuildTitle'])
  await page.getByTestId('dialog-confirm').click()
  await expect(page.getByText(t['kg.rebuildStarted'])).toBeVisible()
  await expect(page.getByTestId('kg-root').first()).toHaveAttribute('data-status', 'pending')
  // the page looks again while folders wait
  await expect(page.getByTestId('kg-root').filter({ hasText: 'projects/web-app' })).toHaveAttribute('data-status', 'ready', { timeout: 12_000 })
})

test('turning it off asks first and hides the folders; on again brings them back', async ({ page }) => {
  await open(page)
  const sw = page.getByRole('checkbox', { name: t['kg.enable'] })
  await sw.click({ force: true })
  await expect(page.getByRole('dialog')).toContainText(t['kg.offBody'])
  await page.getByTestId('dialog-confirm').click()
  await expect(sw).not.toBeChecked()
  await expect(page.getByTestId('kg-roots')).toHaveCount(0)
  await expect(page.getByTestId('kg-rebuild')).toHaveCount(0)
  await sw.click({ force: true })
  await expect(sw).toBeChecked()
  await expect(page.getByTestId('kg-root')).toHaveCount(3)
})

test('without CodeGraph: off, the switch cannot be turned on, and the hint says what to install', async ({ page }) => {
  await open(page, { available: false })
  const sw = page.getByRole('checkbox', { name: t['kg.enable'] })
  await expect(sw).not.toBeChecked()
  await expect(sw).toBeDisabled()
  await expect(page.getByTestId('kg-unavailable')).toHaveText(t['kg.unavailable'])
  await page.getByTestId('kg-enabled-row-more').click()
  await expect(page.getByTestId('knowledge-graph')).toContainText('npm install -g @colbymchenry/codegraph')
  await expect(page.getByTestId('kg-roots')).toHaveCount(0)
})

test('a phone: the rows stack and nothing scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page)
  await page.getByTestId('knowledge-graph').scrollIntoViewIfNeeded()
  await expect(page.getByTestId('kg-root').first()).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  const box = await page.getByTestId('knowledge-graph').boundingBox()
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
})

for (const scheme of ['light', 'dark'] as const) {
  test(`no serious accessibility problems (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await open(page)
    await audit(page, `knowledge graph (${scheme})`)
    await page.getByTestId('kg-enabled-row-more').click()
    await page.getByLabel(t['kg.addTitle'], { exact: true }).fill('users/x')
    await page.getByTestId('kg-add-button').click()
    await expect(page.getByTestId('kg-add-error')).toBeVisible()
    await audit(page, `knowledge graph with Learn more and an error (${scheme})`)
  })
}
