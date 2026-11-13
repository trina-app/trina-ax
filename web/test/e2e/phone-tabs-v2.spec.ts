// A phone's tabs with the new navigation (the server's `navRail` switch on; docs/DECISIONS.md "Phone tabs: 트리나 · 대화 ·
// 파일 · 나", plan phase P5): 트리나 opens on its list (no ☰) with "트리나에게 묻기" at the bottom, which opens the new chat
// on its own page (/new, no tab bar, ‹ back to the list); every "new chat with something ready" lands on that box with
// it (a file asked about, a scheduled task's start sentence, /?prompt= and /?project= links); 파일 is the team folder's
// places; 나 is headed 나 with the team's row, 활동, the status and away; Back stays in each tab. With the switch off the
// tabs are as before (트리나 · 대화 · 프로젝트 · 나, ☰ on 트리나). Screenshots of each tab at 390, light and dark, go to
// SHOTS when it is set.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER, PRODUCT_NAMED_AFTER_AI } from '@mycel/shared/api'
import { PRODUCT } from '@mycel/shared'
import { navRail, OWNER, reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'

const t = DICTS.ko
const ai = PRODUCT_NAMED_AFTER_AI ? t['rooms.aiName'] : PRODUCT.shortName
const H = { [CSRF_HEADER]: '1' }
const MEMBER = { username: 'bob', password: 'bob password 1' }
const SHOTS = process.env.SHOTS ?? ''

async function start(page: Page, who?: typeof MEMBER, on = true) {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  if (!on) { await navRail(page, false); return signIn(page, who) }
  await navRail(page)
  // a phone with the new tabs lands on 트리나's list (no box there: helpers.ts signIn waits for the box)
  await page.goto('/login')
  await page.getByTestId('login-username').fill((who ?? OWNER).username)
  await page.getByTestId('login-password').fill((who ?? OWNER).password)
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('phone-trina-home').or(page.getByTestId('welcome'))).toBeVisible()
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

test('트리나 · 대화 · 파일 · 나; 트리나 is the list with "트리나에게 묻기", no ☰; at least 6 chats on the first screen', async ({ page }) => {
  await start(page)
  const launch = await project(page, 'Acme launch')
  for (const n of [1, 2]) await chat(page, `Launch plan ${n}`, launch)
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) await chat(page, `Weekly notes ${n}`)
  await page.goto('/')
  await expect(tabs(page).getByTestId('bottom-tab-label')).toHaveText([ai, t['tabs.chats'], t['sidebar.files'], t['tabs.me']])
  await expect(page.getByTestId('tab-projects')).toHaveCount(0)
  await expect(page.getByTestId('phone-trina-home')).toBeVisible()
  await expect(page.getByTestId('menu-open')).toHaveCount(0)
  await expect(page.getByTestId('topbar-title')).toHaveText(ai)
  await expect(page.getByTestId('trina-group-name')).toHaveText(['Acme launch'])
  await expect(page.getByTestId('trina-all-projects')).toBeVisible()
  // chat rows in sight above the button and the tab bar
  const button = (await page.getByTestId('new-chat').boundingBox())!
  const rows = page.locator('[data-testid="phone-trina-list"] li a[href^="/c/"]')
  const boxes = await rows.evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ top: r.top, bottom: r.bottom })))
  expect(boxes.filter((b) => b.bottom <= button.y + button.height && b.top >= 0).length).toBeGreaterThanOrEqual(6)
  // the quiet rows at the list's end
  await expect(page.getByTestId('phone-trina-list').getByTestId('nav-scheduled')).toHaveCount(1)
  await expect(page.getByTestId('phone-trina-list').getByTestId('nav-trash')).toHaveCount(1)
  // nothing sideways
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await shot(page, 'trina-list')
  // a chat from the list, and ‹ back to it
  await rows.filter({ hasText: 'Weekly notes 8' }).click()
  await expect(page).toHaveURL(/\/c\//)
  await page.goBack()
  await expect(page.getByTestId('phone-trina-home')).toBeVisible()
})

test('"트리나에게 묻기" opens /new: the box, no tab bar, ‹ back to the list; the chat\'s ✦ opens it too', async ({ page }) => {
  await start(page)
  await page.goto('/')
  await expect(page.getByTestId('new-chat')).toHaveText(t['sidebar.askAi'].replace('{name}', ai))
  await page.getByTestId('new-chat').click()
  await expect(page).toHaveURL(/\/new$/)
  await expect(page.getByTestId('composer-input')).toBeVisible()
  await expect(page.getByTestId('bottom-tabs')).toHaveCount(0)
  await page.getByTestId('topbar-back').click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId('phone-trina-home')).toBeVisible()
  // the ✦ of a chat
  const id = await chat(page, 'Plan')
  await page.goto(`/c/${id}`)
  await page.getByTestId('chat-new').click()
  await expect(page).toHaveURL(/\/new$/)
  await expect(page.getByTestId('composer-input')).toBeVisible()
})

test('a new chat with something ready lands on the box with it: a file, a scheduled task\'s start, ?prompt= and ?project=', async ({ page }) => {
  await start(page)
  // "트리나에게 이 파일 물어보기" on a file: the file attached in /new
  await page.goto('/files?path=marketing')
  const row = page.getByTestId('file-row').filter({ hasText: 'notes.txt' })
  await row.getByTestId('file-menu').click()
  await page.getByTestId('chat-with-file').click()
  await expect(page).toHaveURL(/\/new$/)
  const chip = page.locator('[data-testid="attachment-chip"][data-source="team"]')
  await expect(chip).toContainText('notes.txt')
  await shot(page, 'new-chat-attachment')
  // a scheduled task's "describe it in a chat"
  await page.goto('/scheduled')
  await page.getByTestId('scheduled-empty-chat').click()
  await expect(page).toHaveURL(/\/new$/)
  await expect(page.getByTestId('composer-input')).toHaveValue(/평일 오전 9시마다/)
  // links that carry a question or a project (a skill, a bookmark, a notification)
  await page.goto('/?prompt=hello%20acme')
  await expect(page).toHaveURL(/\/new\?prompt=hello/)
  await expect(page.getByTestId('composer-input')).toHaveValue('hello acme')
  const p = await project(page, 'Acme launch')
  await page.goto(`/?project=${p}`)
  await expect(page).toHaveURL(new RegExp(`/new\\?project=${p}`))
  await expect(page.getByText(t['home.inProject'], { exact: false })).toBeVisible()
  // ‹ goes to the project
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
  await page.getByTestId('files-panel-team-all').click()
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

test('모든 프로젝트 and a project are in 트리나; Back stays in each tab', async ({ page }) => {
  await start(page)
  const p = await project(page, 'Acme launch')
  await chat(page, 'Launch plan', p)
  await page.goto('/')
  await page.getByTestId('trina-group-name').filter({ hasText: 'Acme launch' }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${p}$`))
  await expect(tabs(page).getByTestId('tab-ai')).toHaveAttribute('aria-current', 'page')
  // another tab, then back to 트리나: the project again
  await tabs(page).getByTestId('tab-files').click()
  await expect(page.getByTestId('phone-files-home')).toBeVisible()
  await tabs(page).getByTestId('tab-ai').click()
  await expect(page).toHaveURL(new RegExp(`/projects/${p}$`))
  // Back: the list (never another tab)
  await page.goBack()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId('phone-trina-home')).toBeVisible()
  // 모든 프로젝트, ‹ back to the list
  await page.getByTestId('trina-all-projects').click()
  await expect(page).toHaveURL(/\/projects$/)
  await expect(page.getByTestId('projects-team-folder-row')).toHaveCount(0)
  await page.getByTestId('topbar-back').click()
  await expect(page.getByTestId('phone-trina-home')).toBeVisible()
  // an old 프로젝트 address opened from outside lands on 트리나
  await page.goto(`/projects/${p}`)
  await expect(tabs(page).getByTestId('tab-ai')).toHaveAttribute('aria-current', 'page')
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

test('with the switch off: 트리나 · 대화 · 프로젝트 · 나, Home is the box with ☰', async ({ page }) => {
  await start(page, undefined, false)
  await page.goto('/')
  await expect(tabs(page).getByTestId('bottom-tab-label')).toHaveText([ai, t['tabs.chats'], t['tabs.projects'], t['tabs.me']])
  await expect(page.getByTestId('menu-open')).toBeVisible()
  await expect(page.getByTestId('composer-input')).toBeVisible()
  await page.goto('/new?prompt=hi')
  await expect(page).toHaveURL(/\/\?prompt=hi$/)
})
