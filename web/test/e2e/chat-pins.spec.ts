// Pinned chats in a real browser (docs/DECISIONS.md "Pinned chats"): a chat row's "···" pins it ("상단에 고정"), its row
// goes to the top of 트리나 기록 with a pin before the title, above the five latest, and stays there after a reload;
// "고정 해제" puts it back. A right-click on the row opens the same menu, and on a phone the "···" opens it as a sheet.
// A project's page lists my pins there first, with the same pin.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'

const t = DICTS.ko
const side = (page: Page) => page.getByRole('navigation', { name: t['sidebar.label'] })
const rows = (list: Locator) => list.locator('li')
/** the rows' titles, in order (an auto-retrying check: the list loads after the page) */
const titles = (list: Locator) => list.locator('li a[href^="/c/"] .truncate')
const post = (page: Page, url: string, data: unknown = {}) => page.request.post(url, { headers: { [CSRF_HEADER]: '1' }, data })

async function someChats(page: Page, n: number) {
  for (let i = 1; i <= n; i++) expect((await post(page, '/api/chats', { title: `채팅 ${i}` })).ok()).toBeTruthy()
}

test('"상단에 고정" moves the row to the top with a pin, above the five latest, after a reload too; "고정 해제" puts it back', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await someChats(page, 8)
  await page.reload()
  const s = side(page)
  const latest = s.getByTestId('ai-chats-latest')
  await expect(rows(latest)).toHaveCount(5)
  await expect(titles(latest)).toHaveText(['채팅 8', '채팅 7', '채팅 6', '채팅 5', '채팅 4'])
  // 채팅 2 is behind "모두 보기": its row's "···" there
  await s.getByTestId('ai-chats-all').click()
  const row = s.getByTestId('recents-list').locator('li', { hasText: '채팅 2' })
  await row.hover()
  await row.getByTestId('chat-row-menu').click()
  await expect(page.getByTestId('chat-row-pin')).toHaveText(t['chat.pin'])
  await page.getByTestId('chat-row-pin').click()
  await expect(s.getByTestId('ai-chats-pinned').locator('li')).toHaveCount(1)
  await expect(s.getByTestId('ai-chats-pinned').getByTestId('chat-pin-icon')).toHaveAccessibleName(t['chat.pinned'])
  await expect(titles(s.getByTestId('recents-list')).first()).toHaveText('채팅 2')
  // back to the short list: the pin first, then the five latest of the others
  await s.getByTestId('ai-chats-less').click()
  await expect(titles(latest)).toHaveText(['채팅 2', '채팅 8', '채팅 7', '채팅 6', '채팅 5', '채팅 4'])
  await expect(rows(latest).first().getByTestId('chat-pin-icon')).toBeVisible()
  await expect(rows(latest).nth(1).getByTestId('chat-pin-icon')).toHaveCount(0)
  // the server keeps it
  await page.reload()
  await expect(titles(latest)).toHaveText(['채팅 2', '채팅 8', '채팅 7', '채팅 6', '채팅 5', '채팅 4'])
  // "고정 해제": back behind "모두 보기"
  const pinned = rows(latest).first()
  await pinned.hover()
  await pinned.getByTestId('chat-row-menu').click()
  await expect(page.getByTestId('chat-row-pin')).toHaveCount(0)
  await page.getByTestId('chat-row-unpin').click()
  await expect(latest.getByTestId('chat-pin-icon')).toHaveCount(0)
  await expect(titles(latest)).toHaveText(['채팅 8', '채팅 7', '채팅 6', '채팅 5', '채팅 4'])
})

test('a right-click on the row opens the same menu; two pins, the most recent first', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await someChats(page, 6)
  await page.reload()
  const s = side(page)
  const latest = s.getByTestId('ai-chats-latest')
  await expect(rows(latest)).toHaveCount(5)
  for (const title of ['채팅 3', '채팅 5']) {
    await latest.locator('li', { hasText: title }).locator('a').click({ button: 'right' })
    await page.getByTestId('chat-row-pin').click()
    await expect(latest.locator('li', { hasText: title }).getByTestId('chat-pin-icon')).toBeVisible()
  }
  await expect(titles(latest)).toHaveText(['채팅 5', '채팅 3', '채팅 6', '채팅 4', '채팅 2', '채팅 1'])
  await expect(latest.locator('li[data-pinned]')).toHaveCount(2)
})

test.describe('a phone (390 px)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('the drawer: the "···" sheet pins the chat, and its row goes first', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await someChats(page, 4)
    await page.reload()
    await page.getByTestId('menu-open').click()
    const s = side(page)
    const list = s.getByTestId('recents-list')
    await expect(list.locator('li a[href^="/c/"]')).toHaveCount(4)
    await list.locator('li', { hasText: '채팅 1' }).getByTestId('chat-row-menu').click()
    await expect(page.getByTestId('menu-sheet-title')).toHaveText('채팅 1')
    await page.getByTestId('chat-row-pin').click()
    await expect(s.getByTestId('ai-chats-pinned').locator('li')).toHaveCount(1)
    await expect(titles(list).first()).toHaveText('채팅 1')
  })
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
