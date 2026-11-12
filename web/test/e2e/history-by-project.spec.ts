// Trina history by project in a real browser (docs/DECISIONS.md "Trina history by project", QA TC-424): one group per
// project by its newest activity and the chats in no project last; beside the rooms three rows a group with "N more";
// the project's name opens its page and + opens it with its box ready; ▾ folds a group, after a reload too, and a
// folded group keeps the "?" of a chat that waits inside; "모두 보기" every project and row, by date one choice away;
// "프로젝트로 옮기기…" moves the row to its group at once; no project chats: the five latest as before; the phone's drawer
// groups the same, + always there.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { CSRF_HEADER, PRODUCT_NAMED_AFTER_AI } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'
import { PRODUCT } from '@mycel/shared'

const t = DICTS.ko
const ai = PRODUCT_NAMED_AFTER_AI ? t['rooms.aiName'] : PRODUCT.shortName
const side = (page: Page) => page.getByRole('navigation', { name: t['sidebar.label'] })
const post = (page: Page, url: string, data: unknown = {}) => page.request.post(url, { headers: { [CSRF_HEADER]: '1' }, data })
const headings = (scope: Locator) => scope.getByTestId('history-group-head').getByRole('heading', { level: 3 })
const group = (scope: Locator, name: string) => scope.getByTestId('history-group').filter({ has: scope.page().getByRole('heading', { level: 3, name, exact: true }) })
/** a group's rows' titles (the links in its list), an auto-retrying check */
const rows = (g: Locator) => g.getByTestId('history-group-rows').locator('li a[href^="/c/"] .truncate')

async function project(page: Page, name: string): Promise<string> {
  const r = await post(page, '/api/projects', { name, scope: 'team', instructions: '' })
  expect(r.status()).toBe(201)
  return ((await r.json()) as { id: string }).id
}
async function chat(page: Page, title: string, projectId: string | null = null): Promise<string> {
  const r = await post(page, '/api/chats', { title, ...(projectId ? { projectId } : {}) })
  expect(r.ok()).toBeTruthy()
  return ((await r.json()) as { id: string }).id
}
/** two projects and some chats outside them, the newest last: Acme budget has the newest project chat */
async function someWork(page: Page) {
  const launch = await project(page, 'Acme launch')
  const budget = await project(page, 'Acme budget')
  await chat(page, 'QA notes')
  for (const n of [1, 2, 3, 4]) await chat(page, `Launch plan ${n}`, launch)
  await chat(page, 'Budget draft', budget)
  await chat(page, 'Weekly notes')
  return { launch, budget }
}

test('a computer: groups by project, the other chats last; three rows and "N more"; the name opens the project, + opens its box ready', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const { launch } = await someWork(page)
  await page.reload()
  const s = side(page)
  await expect(headings(s)).toHaveText(['Acme budget', 'Acme launch', t['history.other']])
  await expect(s.getByTestId('ai-chats-latest')).toHaveCount(0)
  const g = group(s, 'Acme launch')
  await expect(rows(g)).toHaveText(['Launch plan 4', 'Launch plan 3', 'Launch plan 2'])
  await expect(g.getByTestId('history-group-more')).toHaveText(t['history.group.more'].replace('{n}', '1'))
  await g.getByTestId('history-group-more').click()
  await expect(rows(g)).toHaveText(['Launch plan 4', 'Launch plan 3', 'Launch plan 2', 'Launch plan 1'])
  await expect(rows(group(s, t['history.other']))).toHaveText(['Weekly notes', 'QA notes'])
  // the header is small and grey, the rows as before
  const head = g.getByTestId('history-group-head')
  await expect(head).toHaveCSS('font-size', '12px')
  // + shows on hover (it is there for the keyboard too), and opens the project with its box ready to type in
  const plus = g.getByTestId('history-group-new')
  await expect(plus).toHaveCSS('opacity', '0')
  await head.hover()
  await expect(plus).toHaveCSS('opacity', '1')
  await expect(plus).toHaveAccessibleName(t['history.group.newChat'].replace('{name}', 'Acme launch').replace('{ai}', ai))
  await plus.click()
  await expect(page).toHaveURL(new RegExp(`/projects/${launch}$`))
  await expect(page.getByTestId('composer-input')).toBeFocused()
  // the name opens the project's page too
  await page.goto('/')
  await group(side(page), 'Acme budget').getByTestId('history-group-name').click()
  await expect(page).toHaveURL(/\/projects\/[^/]+$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Acme budget' })).toBeVisible()
})

test('▾ folds a group, after a reload too; a folded group keeps the "?" of a chat that waits inside', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const { launch } = await someWork(page)
  // a chat in Acme launch whose AI asks me something
  await page.goto(`/projects/${launch}`)
  await page.getByTestId('composer-input').fill('please ask me something')
  await page.getByTestId('send').click()
  await expect(page.getByTestId('ask-card')).toBeVisible()
  await page.getByTestId('new-chat').click()
  await expect(page).toHaveURL(/\/$/)
  const s = side(page)
  const g = group(s, 'Acme launch')
  await expect(g.getByTestId('marker-ask')).toHaveCount(1)
  // open: no mark on the header (the row has it)
  await expect(g.getByTestId('history-group-mark')).toHaveCount(0)
  const fold = g.getByTestId('history-group-fold')
  await expect(fold).toHaveAttribute('aria-expanded', 'true')
  await fold.click()
  await expect(fold).toHaveAttribute('aria-expanded', 'false')
  await expect(g.getByTestId('history-group-rows')).toBeHidden()
  await expect(g.getByTestId('history-group-mark').getByTestId('marker-ask')).toBeVisible()
  await page.reload()
  await expect(group(side(page), 'Acme launch').getByTestId('history-group-fold')).toHaveAttribute('aria-expanded', 'false')
  await expect(group(side(page), 'Acme launch').getByTestId('history-group-mark').getByTestId('marker-ask')).toBeVisible()
  // the others stay open
  await expect(rows(group(side(page), 'Acme budget'))).toHaveText(['Budget draft'])
})

test('"모두 보기": every project and every row by project; by date one choice away', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await someWork(page)
  await page.reload()
  const s = side(page)
  await s.getByTestId('ai-chats-all').click()
  await expect(headings(s)).toHaveText(['Acme budget', 'Acme launch', t['history.other']])
  await expect(rows(group(s, 'Acme launch'))).toHaveCount(4)
  await expect(s.getByTestId('history-group-more')).toHaveCount(0)
  await s.getByTestId('recents-head').hover()
  await s.getByTestId('recents-filter').click()
  await page.getByTestId('recents-view-group').click()
  await page.getByTestId('recents-group-date').click()
  await expect(s.getByTestId('history-groups')).toHaveCount(0)
  await expect(s.getByTestId('recents-list').getByRole('heading', { level: 3 })).toHaveText([t['sidebar.today']])
})

test('"프로젝트로 옮기기…" moves the row to its project\'s group at once', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await someWork(page)
  await page.reload()
  const s = side(page)
  const row = group(s, t['history.other']).locator('li', { hasText: 'Weekly notes' })
  await row.hover()
  await row.getByTestId('chat-row-menu').click()
  await page.getByTestId('chat-row-move').click()
  await page.getByTestId('chat-project-choices').getByText('Acme budget', { exact: true }).click()
  await page.getByTestId('chat-project-save').click()
  await expect(rows(group(s, 'Acme budget'))).toHaveText(['Weekly notes', 'Budget draft'])
  await expect(rows(group(s, t['history.other']))).toHaveText(['QA notes'])
})

test('no chat in a project: the five latest as before, no headers', async ({ page }) => {
  await reset(page)
  await signIn(page)
  for (const n of [1, 2, 3, 4, 5, 6]) await chat(page, `채팅 ${n}`)
  await page.reload()
  const s = side(page)
  await expect(s.getByTestId('ai-chats-latest').locator('li')).toHaveCount(5)
  await expect(s.getByTestId('history-groups')).toHaveCount(0)
  await expect(s.getByTestId('recents-list').getByRole('heading')).toHaveCount(0)
})

test.describe('a phone (390 px)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('the drawer groups the same, every row; + is there without hover and opens the project', async ({ page }) => {
    await reset(page)
    await signIn(page)
    const { budget } = await someWork(page)
    await page.reload()
    await page.getByTestId('menu-open').click()
    const s = side(page)
    await expect(headings(s)).toHaveText(['Acme budget', 'Acme launch', t['history.other']])
    await expect(rows(group(s, 'Acme launch'))).toHaveCount(4)
    const plus = group(s, 'Acme budget').getByTestId('history-group-new')
    await expect(plus).toHaveCSS('opacity', '1')
    // a 44 px target
    expect(Math.round((await plus.boundingBox())!.height)).toBe(44)
    await plus.click()
    await expect(page).toHaveURL(new RegExp(`/projects/${budget}$`))
  })
})
