// The phone's Back walks the screen hierarchy (QA TC-244; lib/screens.ts, lib/screenHistory.ts), at 390×844 with touch,
// in Chromium and WebKit (the iPhone app's engine: its edge swipe is the browser's Back here). The owner: "뒤로가기가 그냥
// 쌓이는 듯. 다른 폴더 갔다가 뒤로 가기 하면 이전 폴더로 감".
// - Files: a folder's Back is the folder above it; its bar's ‹ goes back, not forward (phones have no breadcrumbs:
//   pages/Files.tsx); the Trash is a place under the team folder (its row there): a step down, Back to the team folder.
//   The team folder is a screen of the 프로젝트 tab, under its list (QA TC-255: 프로젝트 › 팀 폴더).
// - Tabs: a tap adds no entry, each tab's root is the first entry (Back never walks into another tab), a tab keeps its
//   own stack, the tab on show goes back to its root.
// - A chat's project link and the chat again: back, not a ping-pong. 나 › 연결한 서비스 stays in 나 and returns to it.
// - ‹ names where it goes. A page opened from outside gets its parents under it.
import { expect, test, type Page } from '@playwright/test'
import { folderLabel, PRODUCT } from '@mycel/shared'
import { CSRF_HEADER, PRODUCT_NAMED_AFTER_AI } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { oldNav } from './nav'
import { DICTS } from '../../src/i18n'

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

const t = DICTS.ko
const ai = PRODUCT_NAMED_AFTER_AI ? t['rooms.aiName'] : PRODUCT.shortName
const H = { [CSRF_HEADER]: '1' }
const groups = folderLabel('groups', 'ko', 'olga') ?? 'groups'

/** where the entry on show is in the document's history (React Router's index: 0 is the first) */
const idx = (page: Page) => page.evaluate(() => (history.state as { idx?: number } | null)?.idx ?? null)
const len = (page: Page) => page.evaluate(() => history.length)
const row = (page: Page, name: string) => page.getByTestId('file-row').filter({ hasText: name }).getByRole('button').first()
/** a tab of the bar on show (the 나 list draws its own over the page's) */
const tab = (page: Page, id: string) => page.getByTestId(id).last()
const path = (page: Page) => page.evaluate(() => new URLSearchParams(location.search).get('path') ?? '')

/** 프로젝트 › 팀 폴더: the team folder, a step above the tab's root (QA TC-255) */
async function teamFolder(page: Page) {
  await tab(page, 'tab-projects').click()
  await expect(page).toHaveURL(/\/projects$/)
  await page.getByTestId('projects-team-folder-row').click()
  await expect(page).toHaveURL(/\/files$/)
}

async function folders(page: Page) {
  for (const p of ['groups/leads/회사/a.txt', 'groups/team korea/b.txt']) {
    expect((await page.request.post('/__test/file', { headers: H, data: { path: p, text: 'x' } })).ok()).toBeTruthy()
  }
}

test('Files: Back is always the folder above; ‹ goes back; the Trash is a step under the team folder', async ({ page }) => {
  await reset(page)
  await oldNav(page)
  await signIn(page)
  await folders(page)
  await teamFolder(page)
  expect(await idx(page)).toBe(1)
  await row(page, groups).click()
  await expect.poll(() => path(page)).toBe('groups')
  await row(page, 'leads').click()
  await expect.poll(() => path(page)).toBe('groups/leads')
  await row(page, '회사').click()
  await expect.poll(() => path(page)).toBe('groups/leads/회사')
  expect(await idx(page)).toBe(4)
  // the bar's ‹ (the folder above, named): back to it, the folders after it gone from Back's way
  await expect(page.getByTestId('files-back-label')).toHaveText('leads')
  await page.getByTestId('files-back').click()
  await expect.poll(() => path(page)).toBe('groups/leads')
  expect(await idx(page)).toBe(3)
  await page.getByTestId('files-back').click()
  await expect.poll(() => path(page)).toBe('groups')
  expect(await idx(page)).toBe(2)
  await row(page, 'team korea').click()
  await expect.poll(() => path(page)).toBe('groups/team korea')
  expect(await idx(page)).toBe(3)
  // Back: the folder above each time, then the team folder, then 프로젝트, the tab's first entry
  await page.goBack()
  await expect.poll(() => path(page)).toBe('groups')
  await page.goBack()
  await expect(page).toHaveURL(/\/files$/)
  expect(await idx(page)).toBe(1)
  // the Trash (a row at the team folder): a step down; its ‹ goes back to the team folder
  await page.getByTestId('files-open-trash').click()
  await expect(page).toHaveURL(/view=trash/)
  expect(await idx(page)).toBe(2)
  await page.getByTestId('files-back').click()
  await expect(page).not.toHaveURL(/view=trash/)
  expect(await idx(page)).toBe(1)
  // the team folder's ‹ says 프로젝트 and goes back to the list, the tab's first entry
  await expect(page.getByTestId('files-back-label')).toHaveText(t['projects.title'])
  await page.getByTestId('files-back').click()
  await expect(page).toHaveURL(/\/projects$/)
  expect(await idx(page)).toBe(0)
  await expect(tab(page, 'tab-projects')).toHaveAttribute('aria-current', 'page')
})

test('Files: a folder opened deep (search, a link) still has the folders above it under it', async ({ page }) => {
  await reset(page)
  await oldNav(page)
  await signIn(page)
  await folders(page)
  await page.goto('/files?path=groups%2Fleads%2F%ED%9A%8C%EC%82%AC')
  await expect(page.getByTestId('file-row').filter({ hasText: 'a.txt' })).toBeVisible()
  // opened from outside: the tab's root (프로젝트), the team folder and the folders above put under it
  await expect.poll(() => idx(page)).toBe(4)
  await expect(tab(page, 'tab-projects')).toHaveAttribute('aria-current', 'page')
  await page.goBack()
  await expect.poll(() => path(page)).toBe('groups/leads')
  await page.goBack()
  await expect.poll(() => path(page)).toBe('groups')
  await page.goBack()
  await expect(page).toHaveURL(/\/files$/)
  await page.goBack()
  await expect(page).toHaveURL(/\/projects$/)
})

test('tabs: a tap adds no entry, Back never walks into another tab, each tab keeps its stack, the tab on show goes to its root', async ({ page }) => {
  await reset(page)
  await oldNav(page)
  await signIn(page)
  await folders(page)
  const start = await len(page)
  for (const id of ['tab-projects', 'tab-chats', 'tab-me', 'tab-chats']) {
    await tab(page, id).click()
    await expect(tab(page, id)).toHaveAttribute('aria-current', 'page')
  }
  await expect(page).toHaveURL(/\/rooms$/)
  expect(await len(page)).toBe(start)
  expect(await idx(page)).toBe(0)

  // 프로젝트 keeps where it was left (in the team folder)
  await teamFolder(page)
  await row(page, groups).click()
  await row(page, 'leads').click()
  await expect.poll(() => path(page)).toBe('groups/leads')
  await tab(page, 'tab-chats').click()
  await expect(page).toHaveURL(/\/rooms$/)
  expect(await idx(page)).toBe(0)
  // Forward onto what 프로젝트's stack left behind: skipped, 대화 stays
  await page.goForward()
  await page.waitForTimeout(300)
  await expect(page).toHaveURL(/\/rooms$/)
  await expect(tab(page, 'tab-chats')).toHaveAttribute('aria-current', 'page')
  await tab(page, 'tab-projects').click()
  await expect.poll(() => path(page)).toBe('groups/leads')
  expect(await idx(page)).toBe(3)
  // a reload (or the app's WebView coming back) keeps the stack
  await page.reload()
  await expect(page.getByTestId('file-row').first()).toBeVisible()
  await page.goBack()
  await expect.poll(() => path(page)).toBe('groups')
  // the tab on show again: its root (the projects list), without a new entry
  await tab(page, 'tab-projects').click()
  await expect(page).toHaveURL(/\/projects$/)
  expect(await idx(page)).toBe(0)

  // 나 inside 메모리: back to the 나 list
  await tab(page, 'tab-me').click()
  const dialog = page.getByRole('dialog', { name: t['settings.title'] })
  await dialog.getByTestId('settings-row-memory').click()
  await expect(page).toHaveURL(/\/settings\/memory$/)
  expect(await idx(page)).toBe(1)
  await tab(page, 'tab-me').click()
  await expect(page).toHaveURL(/\/settings$/)
  expect(await idx(page)).toBe(0)
})

test('나 › 커넥터 stays in the 나 tab, ‹ says so and Back returns to the list; pages name where ‹ goes', async ({ page }) => {
  await reset(page)
  await oldNav(page)
  await signIn(page)
  // Connectors is a row of 나's list (Settings › Connectors, QA TC-400), not an item of the drawer
  await page.getByTestId('menu-open').click()
  await expect(page.getByRole('dialog', { name: t['sidebar.label'] }).getByRole('link', { name: t['integrations.title'] })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await tab(page, 'tab-me').click()
  await page.getByTestId('settings-row-connectors').click()
  await expect(page).toHaveURL(/\/settings\/connectors$/)
  await expect(tab(page, 'tab-me')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('settings-back')).toContainText(t['settings.title'])
  // a connector's page and ‹: back to the list, not a new entry on top
  const atList = await idx(page)
  await page.getByTestId('connector-open').first().click()
  await expect(page).toHaveURL(/\/settings\/connectors\/.+/)
  await expect(page.getByTestId('settings-back')).toContainText(t['integrations.title'])
  await page.getByTestId('settings-back').click()
  await expect(page).toHaveURL(/\/settings\/connectors$/)
  expect(await idx(page)).toBe(atList)
  await page.goBack()
  await expect(page).toHaveURL(/\/settings$/)

  // 활동 from 나: "‹ 설정"; 팀 스킬 from the drawer: "‹ 트리나"
  await tab(page, 'tab-me').click()
  const dialog = page.getByRole('dialog', { name: t['settings.title'] })
  await dialog.getByTestId('settings-inbox').click()
  await expect(page).toHaveURL(/\/activity$/)
  await expect(page.getByTestId('topbar-back-label')).toHaveText(t['settings.title'])
  await tab(page, 'tab-ai').click()
  await expect(page).toHaveURL(/\/$/)
  await page.getByTestId('menu-open').click()
  await page.getByRole('dialog', { name: t['sidebar.label'] }).getByRole('link', { name: t['skills.title'] }).click()
  await expect(page).toHaveURL(/\/skills$/)
  await expect(page.getByTestId('topbar-back-label')).toHaveText(ai)
  await expect(tab(page, 'tab-ai')).toHaveAttribute('aria-current', 'page')
})

test('a chat\'s project link and the chat again: back, never a ping-pong', async ({ page }) => {
  await reset(page)
  await oldNav(page)
  await signIn(page)
  const post = (url: string, data: unknown) => page.request.post(url, { headers: H, data })
  const project = ((await (await post('/api/projects', { name: 'Launch', scope: 'team', folderPath: 'launch', instructions: '' })).json()) as { id: string }).id
  const chat = ((await (await post('/api/chats', { projectId: project, title: 'Plan the launch' })).json()) as { id: string }).id
  // 프로젝트 → Launch → its chat (QA TC-255: the tab, no longer ☰ › 프로젝트)
  await tab(page, 'tab-projects').click()
  await expect(page).toHaveURL(/\/projects$/)
  await page.getByRole('link', { name: /Launch/ }).first().click()
  await expect(page).toHaveURL(new RegExp(`/projects/${project}$`))
  const atProject = await idx(page)
  await page.getByTestId('project-chat').first().click()
  await expect(page).toHaveURL(new RegExp(`/c/${chat}$`))
  // the header's project link: back to the project it was opened from
  await page.getByTestId('chat-project').click()
  await expect(page).toHaveURL(new RegExp(`/projects/${project}$`))
  expect(await idx(page)).toBe(atProject)
  // the chat again from the project, then the project link again: still one step apart
  await page.getByTestId('project-chat').first().click()
  await expect(page).toHaveURL(new RegExp(`/c/${chat}$`))
  expect(await idx(page)).toBe(atProject! + 1)
  await page.getByTestId('chat-project').click()
  await expect(page).toHaveURL(new RegExp(`/projects/${project}$`))
  // ‹ on the project: the projects list, the tab's root (no ‹ there)
  await expect(page.getByTestId('topbar-back-label')).toHaveText(t['projects.title'])
  await page.getByTestId('topbar-back').click()
  await expect(page).toHaveURL(/\/projects$/)
  await expect(page.getByTestId('topbar-back')).toHaveCount(0)
  expect(await idx(page)).toBe(0)
  await expect(tab(page, 'tab-projects')).toHaveAttribute('aria-current', 'page')
})

test('Folder permissions opened from a folder\'s "who can open it": ‹ names the folder and Back returns to it', async ({ page }) => {
  await reset(page)
  await oldNav(page)
  await signIn(page)
  await teamFolder(page)
  await row(page, 'marketing').click()
  await expect.poll(() => path(page)).toBe('marketing')
  const at = await idx(page)
  await page.getByTestId('folder-access-chip').click()
  await page.getByTestId('sharing-open-admin').click()
  await expect(page).toHaveURL(/\/admin\/folders\?folder=marketing/)
  // a detour: no Admin list put under it
  await page.waitForTimeout(300)
  expect(await idx(page)).toBe(at! + 1)
  await expect(page.getByTestId('admin-back-label')).toHaveText('marketing')
  await page.goBack()
  await expect.poll(() => path(page)).toBe('marketing')
  await expect(tab(page, 'tab-projects')).toHaveAttribute('aria-current', 'page')
})

test('a stack deeper than an entry keeps: a tab tap still goes back to its first entry, and Back never lands in the old one', async ({ page }) => {
  test.setTimeout(120_000)
  await reset(page)
  await oldNav(page)
  await signIn(page)
  const deep = Array.from({ length: 33 }, (_, i) => `n${i + 1}`)
  expect((await page.request.post('/__test/file', { headers: H, data: { path: `${deep.join('/')}/x.txt`, text: 'x' } })).ok()).toBeTruthy()
  await teamFolder(page)
  for (const [i, name] of deep.entries()) {
    await row(page, name).click()
    await expect.poll(() => path(page)).toBe(deep.slice(0, i + 1).join('/'))
  }
  expect(await idx(page)).toBe(34)
  await tab(page, 'tab-chats').click()
  await expect(page).toHaveURL(/\/rooms$/)
  expect(await idx(page)).toBe(0)
  // Back from 대화's root leaves the app; it never comes back to Files
  await page.goBack()
  await page.waitForTimeout(400)
  expect(page.url()).not.toMatch(/\/files/)
  await page.goForward()
  await expect(page).toHaveURL(/\/rooms$/)
  // 프로젝트 again: its first entry, then the last screens it was on
  await tab(page, 'tab-projects').click()
  await expect.poll(() => path(page)).toBe(deep.join('/'))
  await tab(page, 'tab-projects').click()
  await expect(page).toHaveURL(/\/projects$/)
  expect(await idx(page)).toBe(0)
})

test('a sheet\'s item that opens a screen already in the stack (예약 작업 ＋ › 채팅으로 설명하기): one step back to it, still in the app', async ({ page }) => {
  await reset(page)
  await oldNav(page)
  await signIn(page)
  await page.getByTestId('menu-open').click()
  await page.getByRole('dialog', { name: t['sidebar.label'] }).getByRole('link', { name: t['sidebar.scheduled'] }).click()
  await expect(page).toHaveURL(/\/scheduled$/)
  expect(await idx(page)).toBe(1)
  // the phone's ＋ (a bottom sheet, with #453) or the page's own menu
  await page.getByTestId('new-task-phone').or(page.getByTestId('new-task')).filter({ visible: true }).first().click()
  await page.getByTestId('new-task-chat').filter({ visible: true }).first().click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId('composer-input')).toBeVisible()
  await page.waitForTimeout(500)
  await expect(page).toHaveURL(/\/$/)
  expect(await idx(page)).toBe(0)
})
