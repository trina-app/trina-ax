// My sections in the Trina history (docs/decisions/20261122-trina-history-sections.md; nav/HistorySections.tsx): the
// Chats sidebar's sections over my AI chats. Made from the history's menu (New section, then Add chats), filled by a
// row's "⋯" › Move to section and by dragging, taken out by dragging onto 트리나 기록 (with Undo); a chat shows in one
// place; a project's chat can go in one too and keeps its project tag; a folded section keeps its marker; a section's "⋯" deletes it
// (its chats go back to 트리나 기록). The same on a phone's ☰ drawer, where the sections are headers above 트리나 기록.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { navRail, reset, signIn } from './helpers'
import { openPhoneDrawer } from './nav'
import { DICTS, translate } from '../../src/i18n'
import { aiName } from '../../src/lib/tabs'

const t = DICTS.ko
const HISTORY = translate('ko', 'sidebar.aiChats', { name: aiName((k) => translate('ko', k)) })
const post = (page: Page, url: string, data: unknown = {}) => page.request.post(url, { headers: { [CSRF_HEADER]: '1' }, data })

async function chat(page: Page, title: string, projectId: string | null = null): Promise<string> {
  const r = await post(page, '/api/chats', { title, ...(projectId ? { projectId } : {}) })
  expect(r.ok()).toBeTruthy()
  return ((await r.json()) as { id: string }).id
}
async function project(page: Page, name: string): Promise<string> {
  const r = await post(page, '/api/projects', { name, scope: 'team', instructions: '' })
  expect(r.status()).toBe(201)
  return ((await r.json()) as { id: string }).id
}
const panel = (page: Page) => page.getByTestId('trina-panel')
const titles = (scope: ReturnType<Page['locator']>) => scope.locator('li a[href^="/c/"] .truncate:not([data-testid])')
const section = (scope: ReturnType<Page['locator']>, name: string) => scope.getByTestId('history-section').filter({ has: scope.page().getByTestId('panel-section-name').getByText(name, { exact: true }) })

async function newSectionFromMenu(page: Page, name: string) {
  await page.getByTestId('recents-filter').first().click()
  await page.getByTestId('recents-new-section').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText(t['sidebarSections.onlyYou'])
  await dialog.getByRole('textbox').fill(name)
  await dialog.getByRole('textbox').press('Enter')
  await expect(page.getByTestId('add-conversations')).toBeVisible()
  await expect(page.getByRole('dialog')).toContainText(t['sidebarSections.chats.addTitle'].replace('{name}', name))
}
const tick = (page: Page, name: string) => page.getByTestId('add-conversations-row').filter({ hasText: name }).getByRole('checkbox').check()

test('a computer (1440): New section from the menu › Add chats › Move to section › drag in › drag out with Undo › delete', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await reset(page)
  await navRail(page)
  await signIn(page)
  const launch = await project(page, 'Acme launch')
  await chat(page, 'Launch plan', launch)
  await chat(page, 'QA notes')
  await chat(page, 'Budget')
  await chat(page, 'Weekly notes')
  await page.reload()
  const p = panel(page)
  await expect(titles(p.getByTestId('trina-other'))).toHaveText(['Weekly notes', 'Budget', 'QA notes', 'Launch plan'])
  // no sections yet: no block, no folder words
  await expect(p.getByTestId('history-sections')).toHaveCount(0)
  await expect(p).not.toContainText('폴더')

  // New section from the history's menu, then Add chats (a project's chat is offered too: every chat of my history)
  await newSectionFromMenu(page, 'Clients')
  await expect(page.getByTestId('add-conversations-row').filter({ hasText: 'Launch plan' })).toHaveCount(1)
  await tick(page, 'Budget')
  await page.getByTestId('add-conversations-add').click()
  const clients = section(p, 'Clients')
  await expect(titles(clients)).toHaveText(['Budget'])
  // one place per chat: not again in 트리나 기록
  await expect(titles(p.getByTestId('trina-other'))).toHaveText(['Weekly notes', 'QA notes', 'Launch plan'])
  // the sections sit above 트리나 기록
  await expect(p.getByTestId('trina-label')).toHaveText(['Clients', HISTORY])

  // a row's "⋯" › Move to section
  const qa = p.getByTestId('trina-other').locator('li').filter({ hasText: 'QA notes' })
  await qa.hover()
  await qa.getByTestId('chat-row-menu').click()
  await page.getByTestId('row-section-move').click()
  await page.getByRole('menuitemradio', { name: 'Clients' }).click()
  await expect(titles(clients)).toHaveText(['Budget', 'QA notes'])
  await expect(page.getByTestId('toast').last()).toContainText(t['sidebarSections.moved'].replace('{name}', 'Clients'))

  // a project's chat can be moved in too (owner 2026-11-22), and there it still names its project
  const lp = p.getByTestId('trina-other').locator('li').filter({ hasText: 'Launch plan' })
  await lp.hover()
  await lp.getByTestId('chat-row-menu').click()
  await page.getByTestId('row-section-move').click()
  await page.getByRole('menuitemradio', { name: 'Clients' }).click()
  await expect(titles(clients)).toHaveText(['Budget', 'QA notes', 'Launch plan'])
  await expect(clients.locator('li').filter({ hasText: 'Launch plan' }).getByTestId('chat-row-project')).toHaveText('Acme launch')
  await expect(titles(p.getByTestId('trina-other'))).toHaveText(['Weekly notes'])

  // dragged in, then dragged out onto 트리나 기록, then Undo puts it back
  await p.getByTestId('trina-other').locator('li').filter({ hasText: 'Weekly notes' }).locator('a').dragTo(clients.getByTestId('trina-label'))
  await expect(titles(clients)).toHaveText(['Weekly notes', 'Budget', 'QA notes', 'Launch plan'])
  await clients.locator('li').filter({ hasText: 'Budget' }).locator('a').dragTo(p.getByTestId('trina-other').getByTestId('trina-label'))
  await expect(titles(clients)).toHaveText(['Weekly notes', 'QA notes', 'Launch plan'])
  await expect(titles(p.getByTestId('trina-other'))).toContainText(['Budget'])
  await page.getByTestId('toast').last().getByRole('button', { name: t['common.undo'] }).click()
  await expect(titles(clients)).toHaveText(['Weekly notes', 'Budget', 'QA notes', 'Launch plan'])

  // folds, and stays folded after a reload (the account's folds)
  await clients.getByTestId('panel-section-fold').click()
  await expect(clients.locator('li')).toHaveCount(0)
  await page.reload()
  await expect(section(p, 'Clients')).toHaveAttribute('data-folded', '')
  await section(p, 'Clients').getByTestId('panel-section-fold').click()

  // delete: asks with how many it holds; its chats go back to 트리나 기록
  await section(p, 'Clients').getByTestId('section-menu').click()
  await page.getByTestId('section-menu-delete').click()
  await expect(page.getByRole('dialog')).toContainText(translate('ko', 'sidebarSections.chats.deleteBody', { n: 4 }))
  await page.getByRole('dialog').getByRole('button', { name: t['sidebarSections.delete'] }).click()
  await expect(p.getByTestId('history-sections')).toHaveCount(0)
  await expect(titles(p.getByTestId('trina-other'))).toHaveText(['Weekly notes', 'Budget', 'QA notes', 'Launch plan'])
})

test('an empty section says how to fill it; a filter hides it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await reset(page)
  await navRail(page)
  await signIn(page)
  await chat(page, 'QA notes')
  await page.reload()
  await newSectionFromMenu(page, 'Later')
  await page.getByTestId('add-conversations-skip').click()
  const p = panel(page)
  await expect(section(p, 'Later').getByTestId('section-empty')).toBeVisible()
  await section(p, 'Later').getByTestId('section-empty-add').click()
  await expect(page.getByRole('dialog')).toContainText(t['sidebarSections.chats.addTitle'].replace('{name}', 'Later'))
  await page.getByTestId('add-conversations-skip').click()
  // a filter on (Sort by: Title): the filtered list, and an empty section is not drawn
  await page.getByTestId('recents-filter').click()
  await page.getByTestId('recents-view-sort').click()
  await page.getByTestId('recents-sort-title').click()
  await expect(p.getByTestId('recents-list')).toBeVisible()
  await expect(p.getByTestId('history-section')).toHaveCount(0)
})

test('a phone (390): the drawer shows my sections above 트리나 기록; Move to section from the sheet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  await navRail(page)
  await signIn(page)
  await chat(page, 'QA notes')
  await chat(page, 'Budget')
  const r = await post(page, '/api/nav-folders', { kind: 'chats', name: 'Clients' })
  expect(r.status()).toBe(201)
  await page.goto('/')
  const drawer = await openPhoneDrawer(page)
  const clients = section(drawer, 'Clients')
  await expect(clients.getByTestId('section-empty')).toBeVisible()
  // the section is above the "트리나 기록" fold
  const box = async (l: ReturnType<Page['locator']>) => (await l.boundingBox())!.y
  expect(await box(clients)).toBeLessThan(await box(drawer.getByTestId('recents-head')))
  // the row's "⋯" is a sheet on a phone
  const qa = drawer.getByTestId('recents-list').locator('li').filter({ hasText: 'QA notes' })
  await qa.getByTestId('chat-row-menu').click()
  await page.getByTestId('row-section-move').click()
  await page.getByRole('menuitemradio', { name: 'Clients' }).click()
  await expect(titles(clients)).toHaveText(['QA notes'])
  await expect(titles(drawer.getByTestId('recents-list'))).toHaveText(['Budget'])
})
