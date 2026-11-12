// 트리나's list in the rail's panel (docs/DECISIONS.md "The Trina list: pinned, folders, projects, other chats"; the
// navigation plan §2.3, phase P2; the server's `navRail` switch on). Order 고정 · 프로젝트 · 모든 프로젝트 · 기타 기록,
// the heads from GET /api/chats/groups (not from the loaded pages): at most 8 project groups, three rows each and "N개 더
// 보기", a project's own icon, its name opens it, + asks Trina there; no "모두 보기"; with no project group the history
// is "기록" and "+ 새 프로젝트" is a quiet row; the filter in the panel's header shows the filtered history and comes
// back; a folded group keeps the "?" of a chat inside; with the switch off the old sidebar is unchanged.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER, PRODUCT_NAMED_AFTER_AI } from '@mycel/shared/api'
import { PRODUCT } from '@mycel/shared'
import { navRail, reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'

const t = DICTS.ko
const ai = PRODUCT_NAMED_AFTER_AI ? t['rooms.aiName'] : PRODUCT.shortName
const MEMBER = { username: 'bob', password: 'bob password 1' }
const post = (page: Page, url: string, data: unknown = {}) => page.request.post(url, { headers: { [CSRF_HEADER]: '1' }, data })

async function project(page: Page, name: string, scope: 'team' | 'personal' = 'team'): Promise<string> {
  const r = await post(page, '/api/projects', { name, scope, instructions: '', ...(scope === 'personal' ? { participants: [] } : {}) })
  expect(r.status()).toBe(201)
  return ((await r.json()) as { id: string }).id
}
async function chat(page: Page, title: string, projectId: string | null = null): Promise<string> {
  const r = await post(page, '/api/chats', { title, ...(projectId ? { projectId } : {}) })
  expect(r.ok()).toBeTruthy()
  return ((await r.json()) as { id: string }).id
}
async function start(page: Page, who?: typeof MEMBER, width = 1440) {
  await page.setViewportSize({ width, height: 900 })
  await reset(page)
  await navRail(page)
  await signIn(page, who)
  await expect(page.getByTestId('trina-panel')).toBeVisible()
}
const panel = (page: Page) => page.getByTestId('trina-panel')
const labels = (page: Page) => panel(page).getByTestId('trina-label')
const groupNamed = (page: Page, name: string) => panel(page).getByTestId('trina-group').filter({ has: page.getByTestId('trina-group-name').getByText(name, { exact: true }) })
const rowTitles = (scope: ReturnType<Page['locator']>) => scope.locator('li a[href^="/c/"] .truncate')

test('order 고정 · 프로젝트 · 모든 프로젝트 · 기타 기록; three rows and "N개 더 보기"; the name opens the project, + asks Trina there', async ({ page }) => {
  await start(page)
  const launch = await project(page, 'Acme launch')
  const budget = await project(page, 'Acme budget')
  const pinned = await chat(page, 'Pinned plan')
  await post(page, `/api/chats/${pinned}/pin`)
  await chat(page, 'QA notes')
  for (const n of [1, 2, 3, 4]) await chat(page, `Launch plan ${n}`, launch)
  await chat(page, 'Budget draft', budget)
  await chat(page, 'Weekly notes')
  await page.reload()
  await expect(labels(page)).toHaveText([t['chat.pinned'], t['sidebar.projects'], t['history.other']])
  const p = panel(page)
  await expect(rowTitles(p.getByTestId('trina-pinned'))).toHaveText(['Pinned plan'])
  await expect(p.getByTestId('trina-group-name')).toHaveText(['Acme budget', 'Acme launch'])
  const g = groupNamed(page, 'Acme launch')
  await expect(rowTitles(g)).toHaveText(['Launch plan 4', 'Launch plan 3', 'Launch plan 2'])
  await g.getByTestId('trina-group-more').click()
  await expect(rowTitles(g)).toHaveText(['Launch plan 4', 'Launch plan 3', 'Launch plan 2', 'Launch plan 1'])
  await expect(g.getByTestId('trina-group-more')).toHaveCount(0)
  await expect(rowTitles(p.getByTestId('trina-other'))).toHaveText(['Weekly notes', 'QA notes'])
  // the old list's cap and "모두 보기" are gone; projects have their own icon, not a folder's
  await expect(p.getByTestId('ai-chats-all')).toHaveCount(0)
  await expect(g.getByTestId('trina-group-head').locator('svg.lucide-square-kanban')).toHaveCount(1)
  await expect(p.getByTestId('trina-all-projects')).toContainText(t['trinaList.allProjects'])
  await expect(p.getByTestId('trina-all-projects')).toContainText('2')
  // + asks Trina in the project: its page with the box saying so
  await g.getByTestId('trina-group-head').hover()
  await expect(g.getByTestId('trina-group-ask')).toHaveAccessibleName(t['history.group.newChat'].replace('{name}', 'Acme launch').replace('{ai}', ai))
  await g.getByTestId('trina-group-ask').click()
  await expect(page).toHaveURL(new RegExp(`/projects/${launch}$`))
  await expect(page.getByTestId('composer-input')).toHaveAttribute('placeholder', t['projects.askHere'].replace('{name}', ai))
  // the name opens the project, 트리나 stays lit
  await groupNamed(page, 'Acme budget').getByTestId('trina-group-name').click()
  await expect(page).toHaveURL(new RegExp(`/projects/${budget}$`))
  await expect(page.getByTestId('rail-ai')).toHaveAttribute('aria-current', 'page')
  // all projects
  await p.getByTestId('trina-all-projects').click()
  await expect(page).toHaveURL(/\/projects$/)
})

test('at most 8 project groups, the rest behind 모든 프로젝트; a group folded by hand stays folded after a reload', async ({ page }) => {
  await start(page)
  for (let i = 1; i <= 10; i++) await chat(page, `Chat ${i}`, await project(page, `Project ${String(i).padStart(2, '0')}`))
  await page.reload()
  await expect(panel(page).getByTestId('trina-group')).toHaveCount(8)
  await expect(panel(page).getByTestId('trina-group-name').first()).toHaveText('Project 10')
  await expect(panel(page).getByTestId('trina-all-projects')).toContainText('10')
  const g = groupNamed(page, 'Project 10')
  await g.getByTestId('trina-group-fold').click()
  await expect(g).toHaveAttribute('data-folded', '')
  await page.reload()
  await expect(groupNamed(page, 'Project 10')).toHaveAttribute('data-folded', '')
  await expect(rowTitles(groupNamed(page, 'Project 10'))).toHaveCount(0)
})

test('a folded group keeps the "?" of a chat that waits inside', async ({ page }) => {
  await start(page)
  const p = await project(page, 'Acme waits')
  await chat(page, 'Waiting one', p)
  await page.route('**/api/chats/groups', async (route) => {
    const r = await route.fetch()
    const body = (await r.json()) as { projects: { top: { id: string; waiting?: true }[]; marked: unknown[] }[] }
    for (const g of body.projects) { g.top = g.top.map((c) => ({ ...c, waiting: true as const })); g.marked = g.top.map((c) => ({ id: c.id, runState: 'idle', waiting: true })) }
    await route.fulfill({ json: body })
  })
  // the chats store's copy is the live one: it waits too
  await page.route('**/api/chats?*', async (route) => {
    const r = await route.fetch()
    const body = (await r.json()) as { items: { title: string }[] }
    body.items = body.items.map((c) => (c.title === 'Waiting one' ? { ...c, waiting: true } : c))
    await route.fulfill({ json: body })
  })
  await page.reload()
  const g = groupNamed(page, 'Acme waits')
  await g.getByTestId('trina-group-fold').click()
  await expect(g.getByTestId('trina-group-mark')).toBeVisible()
})

test('a member with no projects: no 프로젝트 label, the history is "기록", "+ 새 프로젝트" is a quiet row', async ({ page }) => {
  await start(page, MEMBER)
  await chat(page, 'My first question')
  await page.reload()
  await expect(labels(page)).toHaveText([t['trinaList.history']])
  await expect(panel(page).getByTestId('trina-new-project')).toContainText(t['projects.new'])
  await expect(panel(page).getByTestId('trina-all-projects')).toHaveCount(0)
  await panel(page).getByTestId('trina-new-project').click()
  await expect(page).toHaveURL(/\/projects\?new=1$/)
})

test('the filter in the header shows the filtered history, and Reset brings the groups back', async ({ page }) => {
  await start(page)
  const p = await project(page, 'Acme filter')
  await chat(page, 'In project', p)
  await chat(page, 'Outside')
  await page.reload()
  await panel(page).getByTestId('recents-filter').click()
  await page.getByTestId('recents-view-status').click()
  await page.getByTestId('recents-status-noProject').click()
  await page.keyboard.press('Escape')
  await expect(panel(page).getByTestId('recents-filter-label')).toContainText(t['sidebar.filter.noProject'])
  await expect(panel(page).getByTestId('trina-list')).toHaveCount(0)
  await expect(panel(page).getByText('Outside')).toBeVisible()
  await expect(panel(page).getByText('In project')).toHaveCount(0)
  await panel(page).getByTestId('recents-filter-clear').click()
  await expect(panel(page).getByTestId('trina-list')).toBeVisible()
  await expect(panel(page).getByText('In project')).toBeVisible()
})

test('with the switch off the old sidebar shows its capped history, unchanged', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await reset(page)
  await signIn(page)
  await chat(page, 'Old one')
  await page.reload()
  await expect(page.getByTestId('trina-panel')).toHaveCount(0)
  await expect(page.getByTestId('trina-list')).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: t['sidebar.label'] }).getByTestId('ai-chats-all')).toBeVisible()
})
