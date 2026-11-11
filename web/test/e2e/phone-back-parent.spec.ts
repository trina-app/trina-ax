// The phone's Back walks the screen hierarchy (QA TC-244; lib/screens.ts, lib/screenHistory.ts), at 390×844 with touch,
// in Chromium and WebKit (the iPhone app's engine: its edge swipe is the browser's Back here). The owner: "뒤로가기가 그냥
// 쌓이는 듯. 다른 폴더 갔다가 뒤로 가기 하면 이전 폴더로 감".
// - Files: a folder's Back is the folder above it; a breadcrumb goes back, not forward; Team folder ↔ Trash adds nothing.
// - Tabs: a tap adds no entry, each tab's root is the first entry (Back never walks into another tab), a tab keeps its
//   own stack, the tab on show goes back to its root.
// - A chat's project link and the chat again: back, not a ping-pong. 나 › 연결한 서비스 stays in 나 and returns to it.
// - ‹ names where it goes. A page opened from outside gets its parents under it.
import { expect, test, type Page } from '@playwright/test'
import { folderLabel, PRODUCT } from '@mycel/shared'
import { CSRF_HEADER, PRODUCT_NAMED_AFTER_AI } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
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

async function folders(page: Page) {
  for (const p of ['groups/leads/회사/a.txt', 'groups/team korea/b.txt']) {
    expect((await page.request.post('/__test/file', { headers: H, data: { path: p, text: 'x' } })).ok()).toBeTruthy()
  }
}

test('Files: Back is always the folder above; a breadcrumb goes back; Team folder ↔ Trash adds nothing', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await folders(page)
  await tab(page, 'tab-files').click()
  await expect(page).toHaveURL(/\/files$/)
  expect(await idx(page)).toBe(0)
  await row(page, groups).click()
  await expect.poll(() => path(page)).toBe('groups')
  await row(page, 'leads').click()
  await expect.poll(() => path(page)).toBe('groups/leads')
  await row(page, '회사').click()
  await expect.poll(() => path(page)).toBe('groups/leads/회사')
  expect(await idx(page)).toBe(3)
  // the breadcrumb of a folder above: back to it, the folders after it gone from Back's way
  await page.getByTestId('crumb').nth(1).click()
  await expect.poll(() => path(page)).toBe('groups')
  expect(await idx(page)).toBe(1)
  await row(page, 'team korea').click()
  await expect.poll(() => path(page)).toBe('groups/team korea')
  expect(await idx(page)).toBe(2)
  // Trash and back: no entry of its own
  const before = await len(page)
  await page.getByRole('tab', { name: t['files.trash'] }).click()
  await expect(page).toHaveURL(/view=trash/)
  await page.getByRole('tab', { name: t['files.all'] }).click()
  await expect(page).not.toHaveURL(/view=trash/)
  expect(await len(page)).toBe(before)
  expect(await idx(page)).toBe(2)
  // Back: the folder above each time, then the team folder, which is the tab's first entry
  await page.goBack()
  await expect.poll(() => path(page)).toBe('groups')
  await page.goBack()
  await expect(page).toHaveURL(/\/files$/)
  expect(await idx(page)).toBe(0)
})

test('Files: a folder opened deep (search, a link) still has the folders above it under it', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await folders(page)
  await page.goto('/files?path=groups%2Fleads%2F%ED%9A%8C%EC%82%AC')
  await expect(page.getByTestId('file-row').filter({ hasText: 'a.txt' })).toBeVisible()
  // opened from outside: the tab's root and the folders above put under it
  await expect.poll(() => idx(page)).toBe(3)
  await page.goBack()
  await expect.poll(() => path(page)).toBe('groups/leads')
  await page.goBack()
  await expect.poll(() => path(page)).toBe('groups')
  await page.goBack()
  await expect(page).toHaveURL(/\/files$/)
})

test('tabs: a tap adds no entry, Back never walks into another tab, each tab keeps its stack, the tab on show goes to its root', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await folders(page)
  const start = await len(page)
  for (const id of ['tab-files', 'tab-chats', 'tab-me', 'tab-chats']) {
    await tab(page, id).click()
    await expect(tab(page, id)).toHaveAttribute('aria-current', 'page')
  }
  await expect(page).toHaveURL(/\/rooms$/)
  expect(await len(page)).toBe(start)
  expect(await idx(page)).toBe(0)

  // 파일 keeps where it was left
  await tab(page, 'tab-files').click()
  await row(page, groups).click()
  await row(page, 'leads').click()
  await expect.poll(() => path(page)).toBe('groups/leads')
  await tab(page, 'tab-chats').click()
  await expect(page).toHaveURL(/\/rooms$/)
  expect(await idx(page)).toBe(0)
  // Forward onto what 파일's stack left behind: skipped, 대화 stays
  await page.goForward()
  await page.waitForTimeout(300)
  await expect(page).toHaveURL(/\/rooms$/)
  await expect(tab(page, 'tab-chats')).toHaveAttribute('aria-current', 'page')
  await tab(page, 'tab-files').click()
  await expect.poll(() => path(page)).toBe('groups/leads')
  expect(await idx(page)).toBe(2)
  // a reload (or the app's WebView coming back) keeps the stack
  await page.reload()
  await expect(page.getByTestId('file-row').first()).toBeVisible()
  await page.goBack()
  await expect.poll(() => path(page)).toBe('groups')
  // the tab on show again: its root, without a new entry
  await tab(page, 'tab-files').click()
  await expect(page).toHaveURL(/\/files$/)
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

test('나 › 연결한 서비스 stays in 나, ‹ says so and Back returns to the list; pages name where ‹ goes', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await tab(page, 'tab-me').click()
  const dialog = page.getByRole('dialog', { name: t['settings.title'] })
  await dialog.getByTestId('settings-row-connectors').click()
  await expect(page).toHaveURL(/\/connectors$/)
  await expect(tab(page, 'tab-me')).toHaveAttribute('aria-current', 'page')
  await expect(tab(page, 'tab-ai')).not.toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('topbar-back-label')).toHaveText(t['settings.title'])
  // a connector's page and ‹: back to the list, not a new entry on top
  const atList = await idx(page)
  await page.getByTestId('connector-open').first().click()
  await expect(page).toHaveURL(/\/connectors\/.+/)
  await expect(page.getByTestId('topbar-back-label')).toHaveText(t['integrations.title'])
  await page.getByTestId('topbar-back').click()
  await expect(page).toHaveURL(/\/connectors$/)
  expect(await idx(page)).toBe(atList)
  await page.goBack()
  await expect(page).toHaveURL(/\/settings$/)

  // 활동 from 나: "‹ 설정"; 팀 스킬 from the drawer: "‹ 트리나"
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
  await signIn(page)
  const post = (url: string, data: unknown) => page.request.post(url, { headers: H, data })
  const project = ((await (await post('/api/projects', { name: 'Launch', scope: 'team', folderPath: 'launch', instructions: '' })).json()) as { id: string }).id
  const chat = ((await (await post('/api/chats', { projectId: project, title: 'Plan the launch' })).json()) as { id: string }).id
  // Home → ☰ → 프로젝트 → Launch → its chat
  await page.getByTestId('menu-open').click()
  await page.getByRole('dialog', { name: t['sidebar.label'] }).getByRole('link', { name: t['projects.title'] }).click()
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
  // ‹ on the project: the projects list, then Home
  await expect(page.getByTestId('topbar-back-label')).toHaveText(t['projects.title'])
  await page.getByTestId('topbar-back').click()
  await expect(page).toHaveURL(/\/projects$/)
  await expect(page.getByTestId('topbar-back-label')).toHaveText(ai)
  await page.getByTestId('topbar-back').click()
  await expect(page).toHaveURL(/\/$/)
  expect(await idx(page)).toBe(0)
})

test('Folder permissions opened from a folder\'s "who can see it": ‹ names the folder and Back returns to it', async ({ page }) => {
  await reset(page)
  await signIn(page)
  expect((await page.request.post('/__test/file', { headers: H, data: { path: 'projects/misc/a.txt', text: 'x' } })).ok()).toBeTruthy()
  await tab(page, 'tab-files').click()
  await row(page, folderLabel('projects', 'ko', 'olga') ?? 'projects').click()
  await row(page, 'misc').click()
  await expect.poll(() => path(page)).toBe('projects/misc')
  const at = await idx(page)
  await page.getByTestId('folder-access-chip').click()
  await page.getByTestId('folder-access-open-admin').click()
  await expect(page).toHaveURL(/\/admin\/folders\?folder=projects/)
  // a detour: no Admin list put under it
  expect(await idx(page)).toBe(at! + 1)
  await expect(page.getByTestId('admin-back-label')).toHaveText('misc')
  await page.goBack()
  await expect.poll(() => path(page)).toBe('projects/misc')
  await expect(tab(page, 'tab-files')).toHaveAttribute('aria-current', 'page')
})
