// 트리나's list in the rail's panel (docs/DECISIONS.md "The Trina list: pinned, recent", "Projects: a place of their
// own…", "Panels: three levels…"). A fixed top (트리나에게 묻기 · 검색 · 예약 작업 · 팀 스킬), then 고정 · 최근 기록 (one
// flat list: a project's chat carries its project's name, small, at the row's end); no project groups, no 모든 프로젝트,
// no folders; 삭제한 기록 is in 최근 기록's "⋯"; a section folded by hand stays folded; the filter in the panel's header
// shows the filtered history and comes back.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { navRail, reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'

const t = DICTS.ko
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
// a row's title (not its project's tag, chat-row-project, which is also cut with "…")
const rowTitles = (scope: ReturnType<Page['locator']>) => scope.locator('li a[href^="/c/"] .truncate:not([data-testid])')

test('order 고정 · 최근 기록; a project\'s chat in 최근 기록 with its project\'s name; no project groups, no 모든 프로젝트', async ({ page }) => {
  await start(page)
  const launch = await project(page, 'Acme launch')
  const pinned = await chat(page, 'Pinned plan')
  await post(page, `/api/chats/${pinned}/pin`)
  await chat(page, 'QA notes')
  await chat(page, 'Launch plan', launch)
  await chat(page, 'Weekly notes')
  await page.reload()
  await expect(labels(page)).toHaveText([t['chat.pinned'], t['trinaList.recent']])
  const p = panel(page)
  // the fixed top: ask, search, scheduled, team skills
  for (const id of ['new-chat', 'nav-search', 'nav-scheduled', 'nav-skills']) await expect(p.getByTestId(id)).toBeVisible()
  await expect(rowTitles(p.getByTestId('trina-pinned'))).toHaveText(['Pinned plan'])
  await expect(rowTitles(p.getByTestId('trina-other'))).toHaveText(['Weekly notes', 'Launch plan', 'QA notes'])
  // the project's chat says which project it is in; the others carry no tag
  const other = p.getByTestId('trina-other')
  await expect(other.getByTestId('chat-row-project')).toHaveText(['Acme launch'])
  await expect(other.locator('li').filter({ hasText: 'Launch plan' }).getByTestId('chat-row-project')).toHaveText('Acme launch')
  // no project groups, no 모든 프로젝트, no folders, no bottom block
  for (const id of ['trina-group', 'trina-all-projects', 'trina-new-project', 'trina-folders', 'trina-panel-more', 'ai-chats-all']) await expect(p.getByTestId(id)).toHaveCount(0)
  // 삭제한 기록 is in 최근 기록's "⋯"
  await expect(p.getByTestId('nav-trash')).toHaveCount(0)
  await p.getByTestId('trina-recent-menu').click()
  await page.getByTestId('nav-trash').click()
  await expect(page).toHaveURL(/\/trash$/)
  await expect(page.getByTestId('rail-ai')).toHaveAttribute('aria-current', 'page')
})

test('a section folded by hand stays folded after a reload, its count beside its name', async ({ page }) => {
  await start(page)
  for (const n of [1, 2]) await post(page, `/api/chats/${await chat(page, `Pinned ${n}`)}/pin`)
  await chat(page, 'Loose one')
  await page.reload()
  const pinned = panel(page).getByTestId('trina-pinned')
  await pinned.getByTestId('panel-section-fold').click()
  await expect(pinned).toHaveAttribute('data-folded', '')
  await expect(pinned.getByTestId('panel-section-count')).toHaveText('2')
  await page.reload()
  await expect(panel(page).getByTestId('trina-pinned')).toHaveAttribute('data-folded', '')
  await expect(rowTitles(panel(page).getByTestId('trina-pinned'))).toHaveCount(0)
  await expect(rowTitles(panel(page).getByTestId('trina-other'))).toHaveText(['Loose one'])
})

test('a member with no projects: the history is 최근 기록, no project rows in the 트리나 list', async ({ page }) => {
  await start(page, MEMBER)
  await chat(page, 'My first question')
  await page.reload()
  await expect(labels(page)).toHaveText([t['trinaList.recent']])
  await expect(panel(page).getByTestId('trina-new-project')).toHaveCount(0)
  await expect(panel(page).getByTestId('trina-all-projects')).toHaveCount(0)
})

test('the filter in the header shows the filtered history, and Reset brings the list back', async ({ page }) => {
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

test('opened on 대화 or 파일 first, 트리나 already shows its mark for unseen answers (QA: it waited for a visit to 트리나)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await reset(page)
  await navRail(page)
  await signIn(page)
  for (const n of [1, 2, 3]) await chat(page, `Answered ${n}`)
  // the answers ended while nobody looked
  await page.route('**/api/chats?*', async (route) => {
    const r = await route.fetch()
    const body = (await r.json()) as { items: { title: string }[] }
    body.items = body.items.map((c) => (c.title.startsWith('Answered') ? { ...c, unseen: true } : c))
    await route.fulfill({ json: body })
  })
  for (const start of ['/rooms', '/files']) {
    await page.goto(start)
    await expect(page.getByTestId('trina-panel')).toHaveCount(0)
    await expect(page.getByTestId('rail-ai').locator('[data-mark="dot"]')).toBeVisible()
  }
})

// UX review S2: the waiting chat sat under six project groups, out of sight
test('a waiting chat: "답을 기다려요 N" on top of the list and the rail\'s "?" open it; 예약 작업 · 팀 스킬 stay in sight on top', async ({ page }) => {
  await start(page)
  for (const n of [1, 2, 3, 4, 5, 6]) await chat(page, `Plan ${n}`, await project(page, `Acme ${n}`))
  const waits = await chat(page, 'Which template?')
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) await chat(page, `Note ${n}`)
  await page.route('**/api/chats?*', async (route) => {
    const r = await route.fetch()
    const body = (await r.json()) as { items: { title: string }[] }
    body.items = body.items.map((c) => (c.title === 'Which template?' ? { ...c, waiting: true } : c))
    await route.fulfill({ json: body })
  })
  await page.goto('/rooms')
  await expect(page.getByTestId('rail-ai').locator('[data-mark="ask"]')).toBeVisible()
  // the rail's 트리나 with "?" opens the waiting chat, and its row is in sight in the list
  await page.getByTestId('rail-ai').click()
  await expect(page).toHaveURL(new RegExp(`/c/${waits}$`))
  await expect(panel(page).locator(`li[data-chat-id="${waits}"]`)).toBeInViewport()
  // the one row on top says how many wait and opens the first
  await page.goto('/')
  const row = panel(page).getByTestId('trina-waiting')
  await expect(row).toBeInViewport()
  await expect(row).toContainText(t['marker.card'])
  await expect(row.getByTestId('trina-waiting-count')).toHaveText('1')
  await row.click()
  await expect(page).toHaveURL(new RegExp(`/c/${waits}$`))
  // 예약 작업 · 팀 스킬 in the fixed top, without a scroll
  for (const id of ['nav-scheduled', 'nav-skills']) await expect(panel(page).getByTestId(id)).toBeInViewport()
  // nothing waits: no row
  await page.unroute('**/api/chats?*')
  await page.goto('/')
  await expect(panel(page).getByTestId('trina-list')).toBeVisible()
  await expect(panel(page).getByTestId('trina-waiting')).toHaveCount(0)
})

test('트리나에게 묻기 while Home is already on show puts the focus in its box, as from another page; ⇧⌘O too', async ({ page }) => {
  await start(page)
  await page.goto('/')
  const box = page.getByTestId('composer-input')
  await expect(box).toBeVisible()
  // the focus elsewhere first (a document load leaves it out of the box)
  await page.getByTestId('nav-search').focus()
  await panel(page).getByTestId('new-chat').click()
  await expect(box).toBeFocused()
  // from another page, as before
  await page.getByTestId('nav-scheduled').click()
  await expect(page).toHaveURL(/\/scheduled$/)
  await panel(page).getByTestId('new-chat').click()
  await expect(box).toBeFocused()
  // the shortcut on Home itself
  await page.getByTestId('nav-search').focus()
  await page.keyboard.press('Control+Shift+O')
  await expect(box).toBeFocused()
})
