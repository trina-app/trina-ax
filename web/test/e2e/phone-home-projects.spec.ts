// Home and the project screens on a phone (390×844, touch), QA rows from the owner's phone audit (11-11), each test
// following its row's Steps and Expected:
// - TC-253 (Home): "1. Open the Trina tab 2. Scroll" → the greeting and the box docked at the bottom (like the ChatGPT
//   and Claude apps); no "트리나 기록" list on Home (it is in ☰); the suggestions one compact row without usage counts;
//   whole rows tappable (44 px). The owner: "이거 UI가 최적이 맞나?", "트리나 히스토리가 드로어에서도 보이고 여기서도
//   보이네". A computer keeps the box under the greeting and the block under the box.
// - TC-254 (projects): "1. Projects 2. Open a project 3. Open its files row" → "+" in the bar, no intro or orange button
//   in the page; one bar with the project name and "···", the name once; the files open within the 프로젝트 tab's stack
//   (QA TC-255; Back returns to the project).
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { openDrawer, openTab, tabBar } from './nav'
import { DICTS } from '../../src/i18n'

const t = DICTS.ko
const H = { [CSRF_HEADER]: '1' }
const BOB = { username: 'bob', password: 'bob password 1' }
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }

async function call(page: Page, method: 'POST' | 'PATCH', path: string, data: unknown = {}) {
  const r = await page.request.fetch(path, { method, headers: H, data })
  expect(r.ok(), `${method} ${path}: ${r.status()}`).toBeTruthy()
  return r.json().catch(() => null)
}

/** As the owner: the team's start with bob in its group, the four kept skills and two team files; signed out after. */
async function teamWithSkills(page: Page) {
  await signIn(page)
  const team = await call(page, 'POST', '/api/onboarding/welcome/team')
  await call(page, 'PATCH', '/api/onboarding/welcome', { finish: true })
  await call(page, 'PATCH', `/api/admin/groups/${team.progress.teamGroup.id}`, { memberIds: ['olga', 'bob'] })
  await call(page, 'POST', '/api/onboarding/packs/general/install', { skills: ['intro-deck', 'card-news', 'promo-video'] })
  await call(page, 'POST', '/api/onboarding/packs/work/install', { skills: ['humanizer'] })
  for (const name of ['견적서.md', '2026/매출.csv']) await call(page, 'POST', '/__test/file', { path: `shared/회사 자료/${name}`, text: 'x' })
  await page.context().clearCookies()
}

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

/** SHOTS=1: screenshots of each screen into $SHOTS_DIR (default test-results/phone-home-projects) */
const shot = (page: Page, name: string) => (process.env.SHOTS ? page.screenshot({ path: `${process.env.SHOTS_DIR ?? 'test-results/phone-home-projects'}/${name}.png` }).then(() => {}) : Promise.resolve())
const box = async (page: Page, testId: string) => (await page.getByTestId(testId).first().boundingBox())!
const scrollHome = (page: Page, to: 'top' | 'bottom') => page.getByTestId('home-scroll').evaluate((el, end) => { el.scrollTop = end === 'top' ? 0 : el.scrollHeight }, to)

test.describe('TC-253: Home on a phone', () => {
  test.use(PHONE)

  test('the box and the greeting at the bottom, no chat list (it is in ☰), the suggestions one row of 44 px chips', async ({ page }) => {
    await reset(page)
    await teamWithSkills(page)
    await signIn(page, BOB)
    // 1. Open the Trina tab
    await openTab(page, 'ai')
    await expect(page).toHaveURL(/\/$/)
    const block = page.getByTestId('team-prepared')
    await expect(block).toBeVisible()

    // the box at the bottom, right above the tab bar; the greeting and the one row of suggestions right above it
    const dock = await box(page, 'home-dock')
    const tabs = await box(page, 'bottom-tabs')
    expect(Math.abs(dock.y + dock.height - tabs.y)).toBeLessThanOrEqual(1)
    const greeting = page.getByRole('heading', { level: 1 })
    await expect(greeting).toHaveText('Bob님, 무엇을 도와드릴까요?')
    const g = (await greeting.boundingBox())!
    const row = await box(page, 'team-prepared-rows')
    expect(g.y + g.height).toBeLessThanOrEqual(row.y)
    expect(row.y + row.height).toBeLessThanOrEqual(dock.y + 1)
    // read and reached in the order seen: the suggestions come before the box (focus, screen readers)
    expect(await page.getByTestId('team-prepared').evaluate((el) => !!(el.compareDocumentPosition(document.querySelector('[data-testid="composer-input"]')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true)
    // nothing taller than the screen: no scrolling needed (it was 977 px), the box never under the top bar
    expect(await page.getByTestId('home-scroll').evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true)
    await shot(page, 'home-prepared')
    await audit(page, 'Home (phone)')

    // the suggestions: one row (side by side), no usage counts, each chip a whole 44 px target
    const chips = block.getByTestId('team-prepared-skill')
    await expect(chips).toHaveCount(3)
    const ys = await chips.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().y)))
    expect(new Set(ys).size).toBe(1)
    await expect(block).not.toContainText(/\d+회|\d+명/)
    for (const id of ['team-prepared-try', 'team-prepared-example', 'team-prepared-ask', 'team-prepared-more']) expect((await box(page, id)).height, id).toBeGreaterThanOrEqual(44)
    // no underlined text links in the row
    expect(await block.locator('a, button').evaluateAll((els) => els.filter((e) => getComputedStyle(e).textDecorationLine.includes('underline')).length)).toBe(0)
    // the whole chip is the tap: 자연스러운 글 puts its request in the box
    const first = (await chips.first().getByTestId('team-prepared-try').boundingBox())!
    await page.touchscreen.tap(first.x + 12, first.y + first.height - 8)
    await expect(page.getByTestId('composer-input')).toHaveValue('/humanizer 아래 글을 자연스럽게 다듬어 줘:\n')

    // a chat: in ☰, not on Home
    await page.getByTestId('composer-input').fill('Weekly numbers')
    await page.getByTestId('send').click()
    await expect(page).toHaveURL(/\/c\//)
    await expect(page.locator('[data-testid="assistant-message"][data-status="done"]')).toHaveCount(1, { timeout: 20_000 })
    await page.getByTestId('chat-back').click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByTestId('composer-input')).toBeVisible()
    await expect(page.getByTestId('home-recents')).toHaveCount(0)
    await expect(page.getByTestId('home-scroll')).not.toContainText('Weekly numbers')
    await openDrawer(page)
    await expect(page.locator('[data-drawer]').getByTestId('recents-list')).toContainText('Weekly numbers')
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-drawer]')).toBeHidden()

    // 2. Scroll: on a short screen (a small phone, the keyboard up) what is above the box scrolls; the box stays at the
    // bottom, never under the top bar
    await page.setViewportSize({ width: 390, height: 300 })
    await expect.poll(() => page.getByTestId('home-scroll').evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
    await scrollHome(page, 'top')
    const atTop = await box(page, 'home-dock')
    await scrollHome(page, 'bottom')
    const atBottom = await box(page, 'home-dock')
    expect(Math.round(atBottom.y)).toBe(Math.round(atTop.y))
    const bar = await box(page, 'phone-topbar')
    expect(atTop.y).toBeGreaterThanOrEqual(bar.y + bar.height)
    const floor = (await tabBar(page).isVisible()) ? (await box(page, 'bottom-tabs')).y : 300
    expect(Math.abs(atTop.y + atTop.height - floor)).toBeLessThanOrEqual(1)
  })

  test('an invited person: the welcome card is the one thing at the top, the box still docked at the bottom', async ({ page }) => {
    await reset(page)
    await page.request.post('/__test/member-welcome', { data: { welcome: {
      team: 'Acme', inviter: { id: 'olga', name: 'Olga' }, people: 3, rooms: [{ id: '01900000-0000-7000-8000-0000000000a1', kind: 'all', name: null }],
      owner: { id: 'olga', name: 'Olga' }, steps: { rooms: true, hi: false, photo: false, asked: false }, allSet: false,
    } } })
    await signIn(page, BOB)
    await openTab(page, 'ai')
    const card = page.getByTestId('member-welcome')
    await expect(card).toBeVisible()
    await expect(page.getByTestId('home-top').getByTestId('member-welcome')).toBeVisible()
    const c = (await card.boundingBox())!
    const greeting = (await page.getByRole('heading', { level: 1 }).boundingBox())!
    expect(c.y + c.height).toBeLessThanOrEqual(greeting.y)
    const dock = await box(page, 'home-dock')
    expect(Math.abs(dock.y + dock.height - (await box(page, 'bottom-tabs')).y)).toBeLessThanOrEqual(1)
    // the card's rows are 44 px targets
    expect((await card.getByTestId('member-welcome-hi-button').boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await shot(page, 'home-welcome')
  })

  test('what my group often asks: the same one row above the box; an owner\'s empty team: two chips, not text links', async ({ page }) => {
    await reset(page)
    await page.request.post('/__test/often-asked', { data: { team: ['회의록을 요약해 줘', '주간 보고서 초안 써 줘', '고객 메일 답장 써 줘', '발표 자료 목차 만들어 줘'] } })
    await signIn(page)
    // the owner's empty team: 스킬 넣기 · 팀 파일 넣기 as two chips
    const team = await call(page, 'POST', '/api/onboarding/welcome/team')
    await call(page, 'PATCH', '/api/onboarding/welcome', { finish: true })
    expect(team).toBeTruthy()
    await page.goto('/')
    const add = page.getByTestId('team-prepared-add')
    await expect(add).toBeVisible()
    for (const id of ['team-prepared-add-skills', 'team-prepared-add-files']) {
      const link = add.getByTestId(id)
      expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      await expect(link).not.toHaveCSS('text-decoration-line', 'underline')
    }
    // with a chat, what the team often asks takes the place: three chips in one row, More the last one
    for (const title of ['a', 'b', 'c', 'd', 'e']) await call(page, 'POST', '/api/chats', { title })
    await page.goto('/')
    const list = page.getByTestId('often-asked')
    await expect(list).toBeVisible()
    const items = list.getByTestId('often-asked-item')
    await expect(items).toHaveCount(3)
    const ys = await items.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().y)))
    expect(new Set(ys).size).toBe(1)
    expect((await items.first().boundingBox())!.height).toBeGreaterThanOrEqual(44)
    expect((await items.first().boundingBox())!.y).toBeLessThan((await box(page, 'composer-input')).y)
    await expect(list).not.toContainText(/\d/)
    await shot(page, 'home-often-asked')
    await audit(page, 'Home, often asked (phone)')
    await items.nth(1).click()
    await expect(page.getByTestId('composer-input')).toHaveValue('주간 보고서 초안 써 줘')
    await expect(page.getByTestId('home-recents')).toHaveCount(0)
  })
})

test('TC-253: a computer keeps its Home: the box under the greeting, the block under the box', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await reset(page)
  await teamWithSkills(page)
  await signIn(page, BOB)
  const block = page.getByTestId('team-prepared')
  await expect(block).toBeVisible()
  const greeting = (await page.getByRole('heading', { level: 1 }).boundingBox())!
  const input = await box(page, 'composer-input')
  expect(greeting.y).toBeLessThan(input.y)
  expect((await block.boundingBox())!.y).toBeGreaterThan(input.y)
  // and in that order in the page: the box before the block
  expect(await block.evaluate((el) => !!(el.compareDocumentPosition(document.querySelector('[data-testid="composer-input"]')!) & Node.DOCUMENT_POSITION_PRECEDING))).toBe(true)
  // its rows one under another, with their buttons
  const ys = await block.getByTestId('team-prepared-skill').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().y)))
  expect(new Set(ys).size).toBe(3)
  await expect(page.getByTestId('home-scroll')).toContainText(t['chat.footer'])
})

test.describe('TC-254: project screens on a phone', () => {
  test.use(PHONE)

  test('"+" in the bar; one bar "‹ name ···"; the files row opens the files in the 프로젝트 tab and Back returns to the project', async ({ page }) => {
    await reset(page)
    await signIn(page)
    const r = await page.request.post('/api/projects', { headers: H, data: { name: 'Launch', scope: 'team', folderPath: 'marketing', instructions: '# Launch\n\nAnswer in **short** bullet points.' } })
    const id = ((await r.json()) as { id: string }).id
    for (const title of ['Weekly numbers', 'Launch plan review']) await call(page, 'POST', '/api/chats', { projectId: id, title })
    await call(page, 'POST', '/__test/file', { path: 'marketing/sub/notes.md', text: '# Notes' })

    // 1. Projects (the 프로젝트 tab, QA TC-255): "+" in the bar, no intro paragraph or orange button in the page
    await page.getByTestId('tab-projects').click()
    await expect(page).toHaveURL(/\/projects$/)
    const bar = page.getByTestId('phone-page-bar')
    await expect(bar.getByTestId('topbar-title')).toHaveText(t['projects.title'])
    const plus = bar.getByTestId('project-new')
    await expect(plus).toHaveAccessibleName(t['projects.new'])
    expect((await plus.boundingBox())!).toMatchObject({ width: 44, height: 44 })
    await expect(page.getByText(t['projects.desc'])).toHaveCount(0)
    await expect(page.locator('button.bg-accent')).toHaveCount(0)
    await expect(page.getByTestId('project-new')).toHaveCount(1)
    await shot(page, 'projects')
    await audit(page, 'Projects (phone)')
    // a row, not a card (QA TC-380, phone-member-pages.cases.ts); its ···: 44 px
    const launchRow = page.getByTestId('project-row').filter({ hasText: 'Launch' })
    await expect(page.getByTestId('project-card')).toHaveCount(0)
    expect((await launchRow.getByTestId('project-card-menu').boundingBox())!).toMatchObject({ width: 44, height: 44 })
    // "+" opens the form: 44 px radio rows, no resize grip
    await plus.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByTestId('project-name')).toBeVisible()
    for (const kind of ['team', 'personal']) {
      const radio = dialog.getByTestId(`project-kind-${kind}`)
      expect((await radio.boundingBox())!.width).toBeGreaterThanOrEqual(20)
      expect((await radio.locator('xpath=..').boundingBox())!.height).toBeGreaterThanOrEqual(44)
    }
    await expect(dialog.locator('textarea')).toHaveCSS('resize', 'none')
    await shot(page, 'project-form')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // 2. Open a project: one bar with the name and "···"; the name once
    await launchRow.click()
    await expect(page).toHaveURL(new RegExp(`/projects/${id}$`))
    await expect(page.getByTestId('phone-page-bar')).toHaveCount(1)
    await expect(bar.getByTestId('topbar-title')).toHaveText('Launch')
    await expect(bar.getByTestId('topbar-back-label')).toHaveText(t['projects.title'])
    await expect(page.getByTestId('project-topline')).toHaveCount(0)
    // the name is shown once: the page's heading is for screen readers, no row with the name's menu
    await expect(page.getByRole('heading', { level: 1, name: 'Launch' })).toHaveClass(/sr-only/)
    const menu = bar.getByTestId('project-menu')
    expect((await menu.boundingBox())!).toMatchObject({ width: 44, height: 44 })
    await shot(page, 'project')
    await audit(page, 'a project (phone)')
    await menu.click()
    const sheet = page.getByRole('menu')
    await expect(sheet.getByTestId('menu-sheet-title')).toHaveText('Launch')
    await expect(sheet.getByRole('menuitem')).toHaveText([t['common.edit'], t['common.delete']])
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)

    // 3. Open its files row: a screen of the 프로젝트 tab (not the team folder), Back returns to the project
    const filesRow = page.getByTestId('project-files-open')
    expect((await filesRow.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await expect(page.getByRole('link', { name: t['projects.open'], exact: true })).toHaveCount(0)
    await filesRow.click()
    await expect(page).toHaveURL(new RegExp(`/projects/${id}/files$`))
    await expect(page.getByTestId('tab-projects')).toHaveAttribute('aria-current', 'page')
    await expect(bar.getByTestId('topbar-title')).toHaveText(t['files.title'])
    await expect(bar.getByTestId('topbar-back-label')).toHaveText('Launch')
    const files = page.getByTestId('project-file')
    await expect(files.filter({ hasText: 'sub' })).toHaveAttribute('data-type', 'folder')
    await shot(page, 'project-files')
    await audit(page, 'a project\'s files (phone)')
    // a folder goes down here; Back goes up to the project's files
    await files.filter({ hasText: 'sub' }).click()
    await expect(page).toHaveURL(new RegExp(`/projects/${id}/files\\?dir=sub$`))
    await expect(bar.getByTestId('topbar-title')).toHaveText('sub')
    await expect(page.getByTestId('tab-projects')).toHaveAttribute('aria-current', 'page')
    // a file opens in the file sheet over it; Back closes the sheet, not the screen
    await files.filter({ hasText: 'notes.md' }).click()
    await expect(page.getByTestId('file-panel')).toBeVisible()
    await page.goBack()
    await expect(page.getByTestId('file-panel')).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`/projects/${id}/files\\?dir=sub$`))
    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`/projects/${id}/files$`))
    // the bar's ‹ returns to the project
    await bar.getByTestId('topbar-back').click()
    await expect(page).toHaveURL(new RegExp(`/projects/${id}$`))
    await expect(bar.getByTestId('topbar-title')).toHaveText('Launch')

    // opened from outside (a link to a subfolder): its parents are under it, Back walks up to the project
    await page.goto(`/projects/${id}/files?dir=sub`)
    await expect(bar.getByTestId('topbar-title')).toHaveText('sub')
    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`/projects/${id}/files$`))
    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`/projects/${id}$`))

    // the bar's folder button: the same folder on the 파일 screen, to change things there
    await page.goto(`/projects/${id}/files`)
    await bar.getByTestId('project-files-in-files').click()
    await expect(page).toHaveURL(/\/files\?path=marketing$/)
  })

  test('the owner on a team project she is not in: the files screen says only members see them, no way to the 파일 screen', async ({ page }) => {
    await reset(page)
    await signIn(page)
    const made = await page.request.post('/__test/project', { data: { name: 'Falcon', by: 'bob', files: { 'plan.md': 'plan' } } })
    const { id } = (await made.json()) as { id: string }
    await page.goto(`/projects/${id}/files`)
    await expect(page.getByTestId('project-files-members-only')).toHaveText(t['projects.membersOnly'])
    await expect(page.getByTestId('project-file')).toHaveCount(0)
    await expect(page.getByTestId('project-files-in-files')).toHaveCount(0)
  })

  test('a computer opening a project\'s files address goes to that folder on the Files screen', async ({ browser }) => {
    const ctx = await browser.newContext({ locale: 'ko-KR', viewport: { width: 1440, height: 900 } })
    const page = await ctx.newPage()
    await reset(page)
    await signIn(page)
    const r = await page.request.post('/api/projects', { headers: H, data: { name: 'Launch', scope: 'team', folderPath: 'marketing', instructions: '' } })
    const id = ((await r.json()) as { id: string }).id
    await call(page, 'POST', '/__test/file', { path: 'marketing/sub/notes.md', text: '# Notes' })
    await page.goto(`/projects/${id}/files?dir=sub`)
    await expect(page).toHaveURL(/\/files\?path=marketing%2Fsub$/)
    await ctx.close()
  })
})
