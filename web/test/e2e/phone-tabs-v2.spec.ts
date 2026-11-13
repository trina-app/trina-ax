// A phone's tabs (docs/DECISIONS.md "Phone tabs: 트리나 · 대화 · 파일 · 나", "Projects: a place of their own…", "Phones:
// the 트리나 tab as before the redesign"): 트리나 · 대화 · 프로젝트 · 파일 · 나. 트리나 opens on Home's message box with ☰,
// which opens the history drawer (검색, 예약 작업, 팀 스킬, the history, my status, 삭제한 기록); `/new` comes back to `/`;
// every "new chat with something ready" lands on that box with it (a file asked about, a scheduled task's start
// sentence, /?prompt= and /?project= links); 프로젝트 is every project and its page; 파일 is the team folder's places; 나
// is headed 나 with the team's row, 활동, the status and away; Back stays in each tab. Screenshots of each tab at 390,
// light and dark, go to SHOTS when it is set.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER, PRODUCT_NAMED_AFTER_AI } from '@mycel/shared/api'
import { PRODUCT } from '@mycel/shared'
import { navRail, OWNER, reset } from './helpers'
import { DICTS } from '../../src/i18n'

const t = DICTS.ko
const ai = PRODUCT_NAMED_AFTER_AI ? t['rooms.aiName'] : PRODUCT.shortName
const H = { [CSRF_HEADER]: '1' }
const MEMBER = { username: 'bob', password: 'bob password 1' }
const SHOTS = process.env.SHOTS ?? ''

async function start(page: Page, who?: typeof MEMBER) {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  await navRail(page)
  await page.goto('/login')
  await page.getByTestId('login-username').fill((who ?? OWNER).username)
  await page.getByTestId('login-password').fill((who ?? OWNER).password)
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('composer-input').or(page.getByTestId('welcome'))).toBeVisible()
}
async function chat(page: Page, title: string, projectId: string | null = null): Promise<string> {
  const r = await page.request.post('/api/chats', { headers: H, data: { title, ...(projectId ? { projectId } : {}) } })
  expect(r.ok()).toBeTruthy()
  return ((await r.json()) as { id: string }).id
}
async function project(page: Page, name: string): Promise<string> {
  const r = await page.request.post('/api/projects', { headers: H, data: { name, scope: 'team', instructions: '' } })
  expect(r.status()).toBe(201)
  return ((await r.json()) as { id: string }).id
}
const tabs = (page: Page) => page.getByTestId('bottom-tabs').last()
async function shot(page: Page, name: string) {
  if (!SHOTS) return
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(150)
    await page.screenshot({ path: `${SHOTS}/${name}-390-${scheme}.png` })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

test('트리나 · 대화 · 프로젝트 · 파일 · 나; 트리나 is Home\'s box with ☰, the drawer holds the history and its rows', async ({ page }) => {
  await start(page)
  const launch = await project(page, 'Acme launch')
  for (const n of [1, 2]) await chat(page, `Launch plan ${n}`, launch)
  for (const n of [1, 2, 3]) await chat(page, `Weekly notes ${n}`)
  await page.goto('/')
  await expect(tabs(page).getByTestId('bottom-tab-label')).toHaveText([ai, t['tabs.chats'], t['projects.title'], t['sidebar.files'], t['tabs.me']])
  await expect(tabs(page).getByTestId('tab-ai')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('composer-input')).toBeVisible()
  await expect(page.getByTestId('topbar-title')).toHaveText(ai)
  await expect(page.getByTestId('phone-trina-home')).toHaveCount(0)
  // ☰: the drawer, with the history and its rows
  await page.getByTestId('menu-open').click()
  const drawer = page.getByTestId('trina-drawer')
  await expect(drawer).toBeVisible()
  for (const id of ['drawer-search', 'nav-scheduled', 'nav-skills', 'recents-toggle', 'my-status-row', 'nav-trash']) await expect(drawer.getByTestId(id)).toBeVisible()
  await expect(drawer.getByTestId('trina-group')).toHaveCount(0)
  await expect(drawer.getByTestId('trina-all-projects')).toHaveCount(0)
  const rows = drawer.locator('li a[href^="/c/"]')
  await expect(rows.filter({ hasText: 'Weekly notes 3' })).toBeVisible()
  // nothing sideways
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await shot(page, 'trina-drawer')
  // a chat from the drawer (it closes), and Back to Home
  await rows.filter({ hasText: 'Weekly notes 3' }).click()
  await expect(page).toHaveURL(/\/c\//)
  await expect(drawer).toHaveCount(0)
  await page.goBack()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId('menu-open')).toBeVisible()
  await expect(page.getByTestId('composer-input')).toBeVisible()
})

test('/new comes back to Home\'s box (its question kept), the tab bar shows; the chat\'s ✦ opens Home too', async ({ page }) => {
  await start(page)
  await page.goto('/new')
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId('composer-input')).toBeVisible()
  await expect(page.getByTestId('bottom-tabs')).toBeVisible()
  await page.goto('/new?prompt=hello%20acme')
  await expect(page).toHaveURL(/\/\?prompt=hello/)
  await expect(page.getByTestId('composer-input')).toHaveValue('hello acme')
  // the ✦ of a chat
  const id = await chat(page, 'Plan')
  await page.goto(`/c/${id}`)
  await page.getByTestId('chat-new').click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId('composer-input')).toBeVisible()
})

test('a new chat with something ready lands on the box with it: a file, a scheduled task\'s start, ?prompt= and ?project=', async ({ page }) => {
  await start(page)
  // "트리나에게 이 파일 물어보기" on a file: the file attached on Home
  await page.goto('/files?path=marketing')
  const row = page.getByTestId('file-row').filter({ hasText: 'notes.txt' })
  await row.getByTestId('file-menu').click()
  await page.getByTestId('chat-with-file').click()
  await expect(page).toHaveURL(/\/$/)
  const chip = page.locator('[data-testid="attachment-chip"][data-source="team"]')
  await expect(chip).toContainText('notes.txt')
  await shot(page, 'new-chat-attachment')
  // a scheduled task's "describe it in a chat"
  await page.goto('/scheduled')
  await page.getByTestId('scheduled-empty-chat').click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId('composer-input')).toHaveValue(/평일 오전 9시마다/)
  // links that carry a question or a project (a skill, a bookmark, a notification)
  await page.goto('/?prompt=hello%20acme')
  await expect(page).toHaveURL(/\/\?prompt=hello/)
  await expect(page.getByTestId('composer-input')).toHaveValue('hello acme')
  const p = await project(page, 'Acme launch')
  await page.goto(`/?project=${p}`)
  await expect(page).toHaveURL(new RegExp(`/\\?project=${p}`))
  await expect(page.getByText(t['home.inProject'], { exact: false })).toBeVisible()
  // ‹ goes to the project (not the history drawer)
  await expect(page.getByTestId('menu-open')).toHaveCount(0)
  await page.getByTestId('topbar-back').click()
  await expect(page).toHaveURL(new RegExp(`/projects/${p}$`))
})

test('파일 is the team folder\'s places; a project\'s folder goes back to 파일; the team folder\'s top is its label', async ({ page }) => {
  await start(page)
  await project(page, 'Acme launch')
  await page.goto('/')
  await tabs(page).getByTestId('tab-files').click()
  await expect(page).toHaveURL(/\/files$/)
  await expect(page.getByTestId('phone-files-home')).toBeVisible()
  await expect(page.getByTestId('files-title')).toHaveText(t['sidebar.files'])
  await expect(page.getByTestId('files-panel-recent')).toBeVisible()
  await expect(page.getByTestId('files-panel-mine')).toBeVisible()
  await expect(page.getByTestId('files-panel-trash')).toBeVisible()
  await shot(page, 'files-tab')
  await page.getByTestId('files-panel-project').filter({ hasText: 'Acme launch' }).click()
  await expect(page).toHaveURL(/path=projects/)
  await expect(page.getByTestId('files-back')).toContainText(t['sidebar.files'])
  await page.getByTestId('files-back').click()
  await expect(page.getByTestId('phone-files-home')).toBeVisible()
  await page.getByTestId('files-panel-root').click()
  await expect(page).toHaveURL(/\/files\?team=1$/)
  // a top folder from there: ‹ goes back to the team folder's top, then to 파일
  await page.getByTestId('file-row').filter({ hasText: 'marketing' }).first().click()
  await expect(page).toHaveURL(/path=marketing/)
  await expect(page.getByTestId('files-back')).toContainText(t['files.root'])
  await page.getByTestId('files-back').click()
  await expect(page).toHaveURL(/\/files\?team=1$/)
  await page.getByTestId('files-back').click()
  await expect(page.getByTestId('phone-files-home')).toBeVisible()
  await page.getByTestId('files-panel-recent').click()
  await expect(page.getByTestId('recent-files')).toBeVisible()
  await page.getByTestId('files-back').click()
  await expect(page.getByTestId('phone-files-home')).toBeVisible()
})

test('프로젝트 is every project and its page; Back stays in each tab', async ({ page }) => {
  await start(page)
  const p = await project(page, 'Acme launch')
  await chat(page, 'Launch plan', p)
  await page.goto('/')
  await tabs(page).getByTestId('tab-projects').click()
  await expect(page).toHaveURL(/\/projects$/)
  await expect(tabs(page).getByTestId('tab-projects')).toHaveAttribute('aria-current', 'page')
  await shot(page, 'projects-tab')
  await page.getByTestId('projects-panel-row').filter({ hasText: 'Acme launch' }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${p}$`))
  await expect(tabs(page).getByTestId('tab-projects')).toHaveAttribute('aria-current', 'page')
  // another tab, then back to 프로젝트: the project again
  await tabs(page).getByTestId('tab-files').click()
  await expect(page.getByTestId('phone-files-home')).toBeVisible()
  await tabs(page).getByTestId('tab-projects').click()
  await expect(page).toHaveURL(new RegExp(`/projects/${p}$`))
  // ‹: the list (never another tab)
  await page.getByTestId('topbar-back').click()
  await expect(page).toHaveURL(/\/projects$/)
  await expect(page.getByTestId('projects-panel-row')).toHaveCount(1)
  await expect(page.getByTestId('projects-team-folder-row')).toHaveCount(0)
  // a project's address opened from outside lights 프로젝트
  await page.goto(`/projects/${p}`)
  await expect(tabs(page).getByTestId('tab-projects')).toHaveAttribute('aria-current', 'page')
})

test('나: headed 나, the team with 팀원 초대 and 관리자 (owner), 활동, status and away; a member sees no invite or Admin', async ({ page }) => {
  await start(page)
  await page.goto('/')
  await tabs(page).getByTestId('tab-me').click()
  await expect(page.getByTestId('settings-title')).toHaveText(t['tabs.me'])
  await expect(page.getByTestId('settings-team')).toBeVisible()
  await expect(page.getByTestId('settings-invite')).toBeVisible()
  await expect(page.getByTestId('settings-admin')).toBeVisible()
  await expect(page.getByTestId('settings-inbox')).toBeVisible()
  await expect(page.getByTestId('settings-status')).toHaveText(new RegExp(t['status.set']))
  await expect(page.getByTestId('settings-away')).toHaveText(t['presence.setAway'])
  await shot(page, 'me-tab')
  await page.getByTestId('settings-away').click()
  await expect(page.getByTestId('settings-away')).toHaveText(t['presence.setActive'])
  await page.getByTestId('settings-away').click()
  await expect(page.getByTestId('settings-away')).toHaveText(t['presence.setAway'])
  await page.getByTestId('settings-invite').click()
  await expect(page.getByRole('dialog', { name: t['teamMenu.invite'] })).toBeVisible()
})

test('a member\'s 나 has no 팀원 초대 or 관리자; 대화 is unchanged', async ({ page }) => {
  await start(page, MEMBER)
  await page.goto('/settings')
  await expect(page.getByTestId('settings-team')).toBeVisible()
  await expect(page.getByTestId('settings-invite')).toHaveCount(0)
  await expect(page.getByTestId('settings-admin')).toHaveCount(0)
  await tabs(page).getByTestId('tab-chats').click()
  await expect(page).toHaveURL(/\/rooms$/)
  await shot(page, 'chats-tab')
})
