// Pinned chats in a real browser (docs/DECISIONS.md "Pinned chats"): a chat row's "···" pins it ("상단에 고정"), its row
// goes to the 트리나 list's 고정 section with a pin before the title, and stays there after a reload;
// "고정 해제" puts it back. A right-click on the row opens the same menu, and on a phone the "···" opens it as a sheet.
// A project's page lists my pins there first, with the same pin.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { chatList, pinnedChats, showChats } from './nav'
import { DICTS } from '../../src/i18n'

const t = DICTS.ko
const title = (row: Locator) => row.locator('a[href^="/c/"] .truncate')
const post = (page: Page, url: string, data: unknown = {}) => page.request.post(url, { headers: { [CSRF_HEADER]: '1' }, data })

async function someChats(page: Page, n: number) {
  for (let i = 1; i <= n; i++) expect((await post(page, '/api/chats', { title: `채팅 ${i}` })).ok()).toBeTruthy()
}

test('"상단에 고정" moves the row to the 트리나 list\'s 고정 with a pin, after a reload too; "고정 해제" puts it back', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await someChats(page, 8)
  await page.reload()
  const list = await chatList(page)
  await expect(pinnedChats(page)).toHaveCount(0)
  const row = list.locator('li', { hasText: '채팅 2' }).first()
  await row.hover()
  await row.getByTestId('chat-row-menu').click()
  await expect(page.getByTestId('chat-row-pin')).toHaveText(t['chat.pin'])
  await page.getByTestId('chat-row-pin').click()
  await expect(pinnedChats(page)).toHaveCount(1)
  await expect(title(pinnedChats(page).first())).toHaveText('채팅 2')
  await expect(pinnedChats(page).first().getByTestId('chat-pin-icon')).toHaveAccessibleName(t['chat.pinned'])
  // the server keeps it
  await page.reload()
  await showChats(page)
  await expect(title(pinnedChats(page).first())).toHaveText('채팅 2')
  // "고정 해제"
  const pinned = pinnedChats(page).first()
  await pinned.hover()
  await pinned.getByTestId('chat-row-menu').click()
  await expect(page.getByTestId('chat-row-pin')).toHaveCount(0)
  await page.getByTestId('chat-row-unpin').click()
  await expect(pinnedChats(page)).toHaveCount(0)
})

test('a right-click on the row opens the same menu; two pins, the most recent first', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await someChats(page, 6)
  await page.reload()
  const list = await chatList(page)
  for (const name of ['채팅 3', '채팅 5']) {
    await list.locator('li', { hasText: name }).first().locator('a').first().click({ button: 'right' })
    await page.getByTestId('chat-row-pin').click()
    await expect(pinnedChats(page).filter({ hasText: name }).getByTestId('chat-pin-icon')).toBeVisible()
  }
  await expect(pinnedChats(page).locator('a[href^="/c/"] .truncate')).toHaveText(['채팅 5', '채팅 3'])
})

test.describe('a phone (390 px)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('the 트리나 tab: the "···" sheet pins the chat, and its row goes to 고정', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await someChats(page, 4)
    await page.reload()
    const list = await chatList(page)
    await expect(list.locator('li a[href^="/c/"]')).toHaveCount(4)
    await list.locator('li', { hasText: '채팅 1' }).first().getByTestId('chat-row-menu').click()
    await expect(page.getByTestId('menu-sheet-title')).toHaveText('채팅 1')
    await page.getByTestId('chat-row-pin').click()
    await expect(pinnedChats(page)).toHaveCount(1)
    await expect(title(pinnedChats(page).first())).toHaveText('채팅 1')
  })
})

test('the chat\'s own title menu pins and unpins it, the row menu\'s item (QA TC-422)', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await someChats(page, 6)
  const id = ((await (await post(page, '/api/chats', { title: '제목 메뉴로 고정' })).json()) as { id: string }).id
  await someChats(page, 6)
  await page.goto(`/c/${id}`)
  const s = await chatList(page)
  await expect(s.getByTestId('chat-pin-icon')).toHaveCount(0)
  await page.getByTestId('chat-menu').click()
  const first = page.getByRole('menuitem').first()
  await expect(first).toHaveText(t['chat.pin'])
  await expect(first.locator('svg.lucide-pin')).toHaveCount(1)
  await first.click()
  // to the top of the list with the pin, above the five latest (as from the row's "···"), or in the 트리나 panel's 고정
  const pinned = pinnedChats(page)
  // the first row of the list in today's sidebar; the first of the 고정 section in the 트리나 panel
  await expect(pinned.first().locator('a[href^="/c/"] .truncate')).toHaveText('제목 메뉴로 고정')
  await expect(pinned.first().getByTestId('chat-pin-icon')).toBeVisible()
  // after a reload too; then 고정 해제 from the same menu
  await page.reload()
  await showChats(page)
  await expect(pinned.first().locator('a[href^="/c/"] .truncate')).toHaveText('제목 메뉴로 고정')
  await page.getByTestId('chat-menu').click()
  await expect(page.getByTestId('chat-unpin')).toHaveText(t['chat.unpin'])
  await expect(page.getByTestId('chat-unpin').locator('svg.lucide-pin-off')).toHaveCount(1)
  await page.getByTestId('chat-unpin').click()
  await expect(s.getByTestId('chat-pin-icon')).toHaveCount(0)
  await page.getByTestId('chat-menu').click()
  await expect(page.getByTestId('chat-pin')).toBeVisible()
})

test("a project's page lists my pins there first, with the pin", async ({ page }) => {
  await reset(page)
  await signIn(page)
  const p = await post(page, '/api/projects', { name: 'Launch', scope: 'team', folderPath: 'marketing', instructions: '' })
  expect(p.status()).toBe(201)
  const projectId = ((await p.json()) as { id: string }).id
  const ids: string[] = []
  for (const title of ['오래된 기록', '중간 기록', '새 기록']) ids.push(((await (await post(page, '/api/chats', { title, projectId })).json()) as { id: string }).id)
  expect((await post(page, `/api/chats/${ids[0]}/pin`)).ok()).toBeTruthy()
  await page.goto(`/projects/${projectId}`)
  const list = page.getByTestId('project-chats').getByTestId('project-chat')
  await expect(list).toHaveText([/오래된 기록/, /새 기록/, /중간 기록/])
  await expect(list.first().getByTestId('chat-pin-icon')).toHaveAccessibleName(t['chat.pinned'])
  await expect(list.nth(1).getByTestId('chat-pin-icon')).toHaveCount(0)
})
