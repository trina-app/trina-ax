// 트리나's list in the rail's panel (docs/DECISIONS.md "The Trina list: pinned, recent", "Trina history by project",
// "Trina history: the default view is grouped by project", "Panels: three levels…"). A fixed top (트리나에게 묻기 · 검색 ·
// 예약 작업 · 팀 스킬), then 고정 · 트리나 기록, grouped by project as the filter's default says (at most five projects and
// three rows each, "N more", "Show all", the other chats last; no headers without a project chat); no folders; 삭제한
// 기록 is in 트리나 기록's "⋯"; a section folded by hand stays folded; the filter in the panel's header shows the
// filtered history and comes back, "Group by: None" its flat list.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { navRail, reset, signIn } from './helpers'
import { DICTS, translate } from '../../src/i18n'
import { aiName } from '../../src/lib/tabs'

const t = DICTS.ko
/** the history's one name on every screen (QA TC-1085) */
const HISTORY = translate('ko', 'sidebar.aiChats', { name: aiName((k) => translate('ko', k)) })
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

test('order 고정 · 트리나 기록; by default the history is grouped by project, as the filter\'s "Group by: Project" says (QA TC-1080)', async ({ page }) => {
  await start(page)
  const launch = await project(page, 'Acme launch')
  const pinned = await chat(page, 'Pinned plan')
  await post(page, `/api/chats/${pinned}/pin`)
  await chat(page, 'QA notes')
  await chat(page, 'Launch plan', launch)
  await chat(page, 'Weekly notes')
  await page.reload()
  await expect(labels(page)).toHaveText([t['chat.pinned'], HISTORY])
  const p = panel(page)
  // the fixed top: ask, search, scheduled, team skills
  for (const id of ['new-chat', 'nav-search', 'nav-scheduled', 'nav-skills']) await expect(p.getByTestId(id)).toBeVisible()
  await expect(rowTitles(p.getByTestId('trina-pinned'))).toHaveText(['Pinned plan'])
  // the project's group first (its newest activity), then the other chats; no project tag on the rows (the header says it)
  const other = p.getByTestId('trina-other')
  await expect(other.getByTestId('history-group-name')).toHaveText(['Acme launch'])
  const groups = other.getByTestId('history-group')
  await expect(groups).toHaveCount(2)
  await expect(rowTitles(groups.nth(0))).toHaveText(['Launch plan'])
  await expect(groups.nth(1)).toHaveAttribute('data-group', 'other')
  await expect(rowTitles(groups.nth(1))).toHaveText(['Weekly notes', 'QA notes'])
  await expect(other.getByTestId('chat-row-project')).toHaveCount(0)
  // the filter's menu says the same: Group by Project, nothing changed (no dot)
  await expect(p.getByTestId('recents-filter-dot')).toHaveCount(0)
  await p.getByTestId('recents-filter').click()
  await expect(page.getByTestId('recents-view-group')).toContainText(t['sidebar.group.project'])
  await page.keyboard.press('Escape')
  // no folders, no bottom block
  for (const id of ['trina-all-projects', 'trina-new-project', 'trina-folders', 'trina-panel-more', 'ai-chats-all']) await expect(p.getByTestId(id)).toHaveCount(0)
  // 삭제한 기록 is in 트리나 기록's "⋯"
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

test('at most five projects and three rows each: "N more" opens a group in place, "Show all" the projects past five; "Group by: None" is the flat list', async ({ page }) => {
  await start(page)
  for (const n of [1, 2, 3, 4, 5, 6]) await chat(page, `Plan ${n}`, await project(page, `Acme ${n}`))
  const big = await project(page, 'Acme big')
  for (const n of [1, 2, 3, 4, 5]) await chat(page, `Big ${n}`, big)
  await chat(page, 'Loose one')
  await page.reload()
  const p = panel(page).getByTestId('trina-other')
  // the five projects with the newest activity: Acme big, then Acme 6 … 3; Acme 2 and 1 behind "Show all"
  await expect(p.getByTestId('history-group-name')).toHaveText(['Acme big', 'Acme 6', 'Acme 5', 'Acme 4', 'Acme 3'])
  const bigGroup = p.getByTestId('history-group').first()
  await expect(rowTitles(bigGroup)).toHaveText(['Big 5', 'Big 4', 'Big 3'])
  await expect(bigGroup.getByTestId('history-group-more')).toHaveText(translate('ko', 'history.group.more', { n: 2 }))
  await bigGroup.getByTestId('history-group-more').click()
  await expect(rowTitles(bigGroup)).toHaveText(['Big 5', 'Big 4', 'Big 3', 'Big 2', 'Big 1'])
  await expect(p.getByTestId('history-show-all')).toHaveText(translate('ko', 'history.showAll', { n: 2 }))
  await p.getByTestId('history-show-all').click()
  await expect(p.getByTestId('history-group-name')).toHaveText(['Acme big', 'Acme 6', 'Acme 5', 'Acme 4', 'Acme 3', 'Acme 2', 'Acme 1'])
  // the other chats stay last
  await expect(p.getByTestId('history-group').last()).toHaveAttribute('data-group', 'other')
  // Group by: None, the flat list with each project chat's tag
  await panel(page).getByTestId('recents-filter').click()
  await page.getByTestId('recents-view-group').click()
  await page.getByTestId('recents-group-none').click()
  await page.keyboard.press('Escape')
  await expect(panel(page).getByTestId('trina-list')).toHaveCount(0)
  await expect(panel(page).getByTestId('history-group')).toHaveCount(0)
  await expect(panel(page).getByTestId('recents-filter-label')).toContainText(t['sidebar.group.none'])
})

test('a folded project keeps the "?" of a chat that waits in it', async ({ page }) => {
  await start(page)
  const acme = await project(page, 'Acme waits')
  await chat(page, 'Which template?', acme)
  await chat(page, 'Loose one')
  await page.route('**/api/chats?*', async (route) => {
    const r = await route.fetch()
    const body = (await r.json()) as { items: { title: string }[] }
    body.items = body.items.map((c) => (c.title === 'Which template?' ? { ...c, waiting: true } : c))
    await route.fulfill({ json: body })
  })
  await page.reload()
  const group = panel(page).getByTestId('history-group').first()
  await group.getByTestId('history-group-fold').click()
  await expect(group).toHaveAttribute('data-folded', '')
  await expect(group.getByTestId('history-group-mark').getByTestId('marker-ask')).toBeVisible()
})

test('a member with no projects: the history is 트리나 기록 without project headers', async ({ page }) => {
  await start(page, MEMBER)
  await chat(page, 'My first question')
  await page.reload()
  await expect(labels(page)).toHaveText([HISTORY])
  await expect(panel(page).getByTestId('history-group')).toHaveCount(0)
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

// QA TC-1030 / TC-1031: the filter's Status submenu at 1440 in English and Korean. Its rows (the app's menu box and row,
// rooms/MenuButton.tsx) never run into each other, and each choice is one line where the window has room; "Confidential"
// is there only while Safe operations 1A is on (or a chat in the list is confidential).
for (const lang of ['en', 'ko'] as const) {
  test(`${lang}: the Status submenu's rows do not overlap and stay on one line; "Confidential" only with 1A on`, async ({ page }) => {
    const tt = DICTS[lang]
    await page.setViewportSize({ width: 1440, height: 900 })
    await reset(page, { teamLocale: lang, usersFollowTeam: true })
    await navRail(page)
    await signIn(page)
    await chat(page, 'Quarterly report')
    const openStatus = async () => {
      await page.reload()
      await panel(page).getByTestId('recents-filter').click()
      await page.getByTestId('recents-view-status').click()
      const sub = page.getByTestId('recents-submenu')
      await expect(sub).toBeVisible()
      return sub
    }
    let sub = await openStatus()
    await expect(sub.getByTestId('recents-status-waiting')).toHaveText(tt['sidebar.filter.active'])
    // 1A off and no confidential chat: no "Confidential"
    await expect(sub.getByTestId('recents-status-confidential')).toHaveCount(0)
    await expect(sub.getByRole('menuitemradio')).toHaveCount(4)

    expect((await post(page, '/__test/confidential', { all: true })).ok()).toBeTruthy()
    sub = await openStatus()
    await expect(sub.getByTestId('recents-status-confidential')).toHaveText(tt['sidebar.filter.confidential'])
    const rows = await sub.getByRole('menuitemradio').evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect()
        const label = el.querySelector('span')!
        const lines = Math.round(label.getBoundingClientRect().height / parseFloat(getComputedStyle(label).lineHeight))
        return { top: r.top, bottom: r.bottom, lines, text: el.textContent }
      }),
    )
    expect(rows).toHaveLength(5)
    for (let i = 0; i + 1 < rows.length; i++) expect(rows[i]!.bottom, `${rows[i]!.text} / ${rows[i + 1]!.text}`).toBeLessThanOrEqual(rows[i + 1]!.top + 0.5)
    for (const r of rows) expect(r.lines, r.text ?? '').toBe(1)
    // the submenu stays inside the window, beside the menu
    const box = (await sub.boundingBox())!
    const menuBox = (await page.getByTestId('recents-filter-menu').boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(menuBox.x + menuBox.width)
    expect(box.x + box.width).toBeLessThanOrEqual(1440 - 8)
  })
}
