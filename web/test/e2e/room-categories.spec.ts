// Team conversation categories on screen (docs/decisions/20261120-shared-chat-categories.md): the owner makes one from
// the Channels header, moves a channel in with its row's "⋯", a folded one keeps the strongest pill; a member sees the
// same category with no way to change it. The personal room folders ("대화 폴더 · 나만 보여요") are no longer shown.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { navRail, reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'

const t = DICTS.ko
const MEMBER = { username: 'bob', password: 'bob password 1' }

async function start(page: Page, who?: typeof MEMBER) {
  await page.setViewportSize({ width: 1440, height: 900 })
  await reset(page)
  await navRail(page)
  await signIn(page, who)
}

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const room = (name: string, o: Record<string, unknown> = {}) => ({
  id: uuidv7(), kind: 'team', name, groupId: uuidv7(), memberCount: 3, peers: [{ id: 'bob', name: 'Bob' }], createdAt: ago(600), activityAt: ago(5),
  canRename: false, managerId: null, unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false, lastReadSeq: 0, lastSeq: 0, lastMessage: null, muted: false, ...o,
})
const category = (page: Page) => page.getByTestId('chats-panel').locator('[data-testid="chats-panel-section"][data-section="category"]')

test('the owner makes a category, moves channels in, and a folded one keeps the strongest pill', async ({ page }) => {
  await start(page)
  const rooms = [room('디자인', { activityAt: ago(1) }), room('개발', { activityAt: ago(2), unreadCount: 3, mentioned: true, lastSeq: 3 }), room('영업', { activityAt: ago(3), unreadCount: 1, lastSeq: 1 })]
  expect((await page.request.post('/__test/rooms', { data: { rooms } })).ok()).toBeTruthy()
  await page.getByTestId('rail-chats').click()
  const cp = page.getByTestId('chats-panel')
  await expect(cp.getByTestId('sidebar-room-row')).toHaveCount(3)
  // no personal folders any more
  await expect(cp.getByText(t['navFolders.kindRooms'])).toHaveCount(0)
  // "새 카테고리" beside the Channels header's +
  await cp.getByTestId('room-category-new').first().click()
  const field = page.getByRole('dialog').getByRole('textbox')
  await field.fill('모니터링')
  await field.press('Enter')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const c = category(page)
  await expect(c.getByTestId('panel-section-name')).toHaveText('모니터링')
  await expect(c.getByTestId('room-category-empty')).toHaveText(t['roomCategories.empty'])
  // ⋯ › 카테고리로 옮기기 › 모니터링, for two channels
  for (const name of ['영업', '개발']) {
    const row = cp.getByTestId('sidebar-room-row').filter({ hasText: name })
    await row.hover()
    await row.getByTestId('sidebar-room-menu').click()
    await page.getByTestId('row-category-move').click()
    await page.getByRole('menuitemradio', { name: '모니터링' }).click()
  }
  await expect(c.getByTestId('sidebar-room-row')).toHaveCount(2)
  // only in the category, not also under Channels
  await expect(cp.locator('[data-testid="sidebar-room-row"][data-section="team"] span[title]')).toHaveText(['디자인'])
  // folded: one pill, the strongest ("@" over a count)
  await c.getByTestId('panel-section-fold').click()
  await expect(c.getByTestId('chats-panel-section-pill')).toHaveAttribute('data-kind', 'mention')
  // after a reload it is the server's
  await page.reload()
  await expect(category(page).getByTestId('chats-panel-section-pill')).toHaveAttribute('data-kind', 'mention')
})

test('a member sees the team category and has no way to change it', async ({ page }) => {
  await start(page, MEMBER)
  // the owner made it
  const made = await page.request.post('/__test/room-category', { data: { name: '공지' } })
  expect(made.ok()).toBeTruthy()
  const { id } = (await made.json()) as { id: string }
  const rooms = [room('전체 공지', { categoryId: id }), room('잡담')]
  expect((await page.request.post('/__test/rooms', { data: { rooms } })).ok()).toBeTruthy()
  await page.getByTestId('rail-chats').click()
  const c = category(page)
  await expect(c.getByTestId('panel-section-name')).toHaveText('공지')
  await expect(c.getByTestId('sidebar-room-row')).toHaveCount(1)
  await expect(page.getByTestId('category-menu')).toHaveCount(0)
  await expect(page.getByTestId('room-category-new')).toHaveCount(0)
  const row = c.getByTestId('sidebar-room-row')
  await row.hover()
  await row.getByTestId('sidebar-room-menu').click()
  await expect(page.getByTestId('row-category-move')).toHaveCount(0)
  // and the server refuses it
  expect((await page.request.post('/api/room-categories', { headers: { [CSRF_HEADER]: '1' }, data: { name: 'x' } })).status()).toBe(403)
})
