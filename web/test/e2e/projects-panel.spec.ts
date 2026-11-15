// 프로젝트, a place of its own (docs/DECISIONS.md "Projects: a place of their own…", "Making a project…"): the rail's
// 프로젝트 opens its list beside the rail, 팀 프로젝트 and 내 프로젝트; "+ 새 프로젝트" asks the name only and opens the new
// project's page; a phone's 프로젝트 tab shows the same list.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { openRail, reset, signIn } from './helpers'
import { DICTS, translate } from '../../src/i18n'

const t = DICTS.ko
const H = { [CSRF_HEADER]: '1' }

/** a team project with Bob in it (one only I see goes under 내 프로젝트, docs/DECISIONS.md "Projects: a place of their
 * own"), or a personal one */
async function project(page: Page, name: string, scope: 'team' | 'personal'): Promise<string> {
  const participants = scope === 'team' ? [{ subjectType: 'user', subjectId: 'bob' }] : []
  const r = await page.request.post('/api/projects', { headers: H, data: { name, scope, instructions: '', participants } })
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

// QA TC-1089: the mock's GET /api/chats/groups had no projectActivity, so every row said "No chats yet"; the server
// counts my chats and the project's shared ones (also those of others I never wrote in), never another person's private one
test('each row counts the chats I can open there: mine and the shared ones, never someone else\'s private one', async ({ page, browser }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await reset(page)
  await signIn(page)
  const team = await project(page, 'Acme launch', 'team')
  await project(page, 'Acme quiet', 'team')
  for (const title of ['Launch email', 'Launch plan']) expect((await page.request.post('/api/chats', { headers: H, data: { title, projectId: team } })).ok()).toBeTruthy()
  expect((await page.request.post('/api/chats', { headers: H, data: { title: 'Pricing notes', projectId: team, private: true } })).ok()).toBeTruthy()
  // Bob, who never wrote there: Olga's two shared chats count for him, her private one does not
  const ctx = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: { width: 1440, height: 900 } })
  const bob = await ctx.newPage()
  try {
    await signIn(bob, { username: 'bob', password: 'bob password 1' })
    await bob.goto('/projects')
    const row = bob.getByTestId('projects-panel-row').filter({ hasText: 'Acme launch' })
    await expect(row.getByTestId('projects-panel-meta')).toContainText(translate('ko', 'projectsPanel.chats', { n: 2 }))
  } finally { await ctx.close() }
  await page.goto('/projects')
  const panel = page.getByTestId('projects-panel')
  await expect(panel.getByTestId('projects-panel-row').filter({ hasText: 'Acme launch' }).getByTestId('projects-panel-meta')).toContainText(translate('ko', 'projectsPanel.chats', { n: 3 }))
  await expect(panel.getByTestId('projects-panel-row').filter({ hasText: 'Acme quiet' }).getByTestId('projects-panel-meta')).toContainText(t['projectsPanel.noChats'])
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

test('a team project in the trash says only that: its row (a trash icon, no members line) and its card, at 390 and 1440 (QA TC-1012)', async ({ page }) => {
  for (const [width, height] of [[390, 844], [1440, 900]] as const) {
    await page.setViewportSize({ width, height })
    await reset(page)
    await signIn(page)
    const id = await project(page, 'Acme binned', 'team')
    expect((await page.request.delete(`/api/projects/${id}`, { headers: H })).status()).toBe(204)
    await page.reload()
    if (width < 768) {
      // a phone's list holds the projects the owner manages too (a computer's panel leaves them to the page's cards)
      await page.getByTestId('tab-projects').click()
      // she made it, so she is one of its members: it stays under 팀 프로젝트, in the trash (QA TC-1060; one she only
      // manages would not be listed at all: Files › Trash has it, QA TC-1061)
      const row = page.getByTestId('phone-projects-list').getByTestId('projects-team').getByTestId('projects-panel-row').filter({ hasText: 'Acme binned' })
      await expect(page.getByTestId('phone-projects-list').getByTestId('projects-other')).toHaveCount(0)
      await expect(row.getByTestId('projects-panel-meta')).toContainText(t['chat.project.inTrash'])
      await expect(row.getByTestId('projects-panel-meta')).not.toContainText(t['projects.noMembers'])
      await expect(row.getByTestId('projects-panel-in-trash')).toBeVisible()
      if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/tc1012-list-${width}.png` })
    } else {
      await openRail(page, 'projects')
      // the Projects page's card: "휴지통에 있음" alone
      const card = page.getByTestId('project-card-who').filter({ hasText: t['chat.project.inTrash'] })
      await expect(card).toHaveText(t['chat.project.inTrash'])
      if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/tc1012-card-${width}.png` })
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
})
