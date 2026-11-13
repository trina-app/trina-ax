// 프로젝트, a place of its own (docs/DECISIONS.md "Projects: a place of their own…", "Making a project…"): the rail's
// 프로젝트 opens its list beside the rail, 팀 프로젝트 and 내 프로젝트; "+ 새 프로젝트" asks the name only and opens the new
// project's page; a phone's 프로젝트 tab shows the same list.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { openRail, reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'

const t = DICTS.ko
const H = { [CSRF_HEADER]: '1' }

async function project(page: Page, name: string, scope: 'team' | 'personal'): Promise<string> {
  const r = await page.request.post('/api/projects', { headers: H, data: { name, scope, instructions: '', ...(scope === 'personal' ? { participants: [] } : {}) } })
  expect(r.status()).toBe(201)
  return ((await r.json()) as { id: string }).id
}

test('a computer: the rail\'s 프로젝트 opens the list with 팀 and 내 sections; a row opens its page', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await reset(page)
  await signIn(page)
  const team = await project(page, 'Acme launch', 'team')
  await project(page, 'Acme notes', 'personal')
  // made over the API: a reload reads the list again
  await page.reload()
  await openRail(page, 'projects')
  await expect(page).toHaveURL(/\/projects$/)
  const panel = page.getByTestId('projects-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByTestId('projects-panel-new')).toContainText(t['projects.new'])
  await expect(panel.getByTestId('projects-team').getByTestId('projects-panel-label')).toContainText(t['projectsPanel.team'])
  await expect(panel.getByTestId('projects-mine').getByTestId('projects-panel-label')).toContainText(t['projectsPanel.mine'])
  await expect(panel.getByTestId('projects-team').getByTestId('projects-panel-name')).toContainText(['Acme launch'])
  await expect(panel.getByTestId('projects-mine').getByTestId('projects-panel-name')).toContainText(['Acme notes'])
  await expect(panel.getByTestId('projects-panel-row').first().getByTestId('projects-panel-meta')).not.toBeEmpty()
  // the 트리나 list holds no projects
  await expect(page.getByTestId('trina-panel')).toHaveCount(0)
  await panel.getByTestId('projects-panel-row').filter({ hasText: 'Acme launch' }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${team}$`))
  await expect(page.getByTestId('rail-projects')).toHaveAttribute('aria-current', 'page')
  await expect(panel.getByTestId('projects-panel-row').filter({ hasText: 'Acme launch' })).toHaveAttribute('aria-current', 'page')
})

test('a computer: + 새 프로젝트 makes a project by its name and opens its page', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await reset(page)
  await signIn(page)
  await openRail(page, 'projects')
  const panel = page.getByTestId('projects-panel')
  await panel.getByTestId('projects-panel-new').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId('project-who')).toBeVisible()
  await expect(dialog.getByTestId('project-create')).toBeDisabled()
  await dialog.getByTestId('project-name').fill('Acme kickoff')
  await dialog.getByTestId('project-create').click()
  await expect(dialog).toHaveCount(0)
  await expect(page).toHaveURL(/\/projects\/[^/?]+$/)
  await expect(page.getByRole('heading', { name: 'Acme kickoff' }).first()).toBeVisible()
  await expect(panel.getByTestId('projects-panel-name').filter({ hasText: 'Acme kickoff' })).toHaveCount(1)
})

test('a phone: the 프로젝트 tab shows the list', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  await signIn(page)
  await project(page, 'Acme launch', 'team')
  await page.reload()
  await page.getByTestId('tab-projects').click()
  await expect(page).toHaveURL(/\/projects$/)
  await expect(page.getByTestId('tab-projects')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('topbar-title')).toHaveText(t['projects.title'])
  const list = page.getByTestId('phone-projects-list')
  await expect(list.getByTestId('projects-panel-new')).toBeVisible()
  await expect(list.getByTestId('projects-team').getByTestId('projects-panel-name')).toContainText(['Acme launch'])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
