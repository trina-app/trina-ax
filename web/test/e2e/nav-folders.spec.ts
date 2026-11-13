// My room folders on screen (docs/DECISIONS.md "List folders on screen"; the navigation plan's phase P4b): room folders in
// 대화 (made, a room moved in with its row's "⋯" or dragged in, the pill a folded one keeps), and nobody else ever sees
// them. The Trina list's own folders are gone (docs/DECISIONS.md "Projects: a place of their own…"): their tests went
// with them.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { CSRF_HEADER, PRODUCT_NAMED_AFTER_AI, uuidv7 } from '@mycel/shared/api'
import { PRODUCT } from '@mycel/shared'
import { navRail, reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'

const t = DICTS.ko
const ai = PRODUCT_NAMED_AFTER_AI ? t['rooms.aiName'] : PRODUCT.shortName
const MEMBER = { username: 'bob', password: 'bob password 1' }
const post = (page: Page, url: string, data: unknown = {}) => page.request.post(url, { headers: { [CSRF_HEADER]: '1' }, data })

async function start(page: Page, width = 1440) {
  await page.setViewportSize({ width, height: 900 })
  await reset(page)
  await navRail(page)
  await signIn(page)
  await expect(page.getByTestId('trina-panel')).toBeVisible()
}
const panel = (page: Page) => page.getByTestId('trina-panel')

/** "새 폴더" (the quiet row, or the + on the folders' label), its name typed in the dialog */
async function newFolder(page: Page, name: string, from: Locator) {
  await from.click()
  const field = page.getByRole('dialog').getByRole('textbox')
  await field.fill(name)
  await field.press('Enter')
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const room = (name: string, o: Record<string, unknown> = {}) => ({
  id: uuidv7(), kind: 'team', name, groupId: uuidv7(), memberCount: 3, peers: [{ id: 'bob', name: 'Bob' }], createdAt: ago(600), activityAt: ago(5),
  canRename: false, managerId: null, unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false, lastReadSeq: 0, lastSeq: 0, lastMessage: null, muted: false, ...o,
})

test('room folders in 대화: made, a room moved in and dragged in, a folded one keeps the strongest pill', async ({ page }) => {
  await start(page)
  const rooms = [room('디자인', { activityAt: ago(1) }), room('개발', { activityAt: ago(2), unreadCount: 3, mentioned: true, lastSeq: 3 }), room('영업', { activityAt: ago(3), unreadCount: 1, lastSeq: 1 })]
  expect((await page.request.post('/__test/rooms', { data: { rooms } })).ok()).toBeTruthy()
  // a Trina folder made first is not a 대화 folder: a room's picker says so instead of a bare "새 폴더" (UX review M3)
  expect((await post(page, '/api/nav-folders', { kind: 'chats', name: '주간 보고' })).ok()).toBeTruthy()
  await page.getByTestId('rail-chats').click()
  const cp = page.getByTestId('chats-panel')
  await expect(cp.getByTestId('sidebar-room-row')).toHaveCount(3)
  const first = cp.getByTestId('sidebar-room-row').filter({ hasText: '디자인' })
  await first.hover()
  await first.getByTestId('sidebar-room-menu').click()
  await page.getByTestId('row-folder-move').click()
  const picker = page.getByRole('menu', { name: t['navFolders.kindRooms'] })
  await expect(picker).toBeVisible()
  await expect(picker.getByRole('menuitemradio')).toHaveCount(0)
  await expect(page.getByTestId('row-folder-separate')).toHaveText(t['navFolders.separateRooms'].replace('{name}', ai))
  await expect(page.getByTestId('row-folder-pick-new')).toHaveAccessibleDescription(t['navFolders.separateRooms'].replace('{name}', ai))
  await page.keyboard.press('Escape')
  await newFolder(page, '우리 팀', cp.getByTestId('rooms-folder-new'))
  await expect(cp.getByTestId('chats-panel-label').filter({ hasText: t['navFolders.kindRooms'] })).toHaveText(`${t['navFolders.kindRooms']} · ${t['trinaList.onlyYou']}`)
  const f = cp.getByTestId('room-folder')
  await expect(f.getByTestId('room-folder-name')).toHaveText('우리 팀')
  await expect(f.getByTestId('room-folder-empty')).toHaveText(t['navFolders.empty'])
  // ⋯ › 폴더로 옮기기 › 우리 팀
  const row = cp.getByTestId('sidebar-room-row').filter({ hasText: '영업' })
  await row.hover()
  await row.getByTestId('sidebar-room-menu').click()
  await page.getByTestId('row-folder-move').click()
  await page.getByRole('menuitemradio', { name: '우리 팀' }).click()
  await expect(f.getByTestId('sidebar-room-row').locator('span[title]')).toHaveText(['영업'])
  // dragged in
  await cp.getByTestId('sidebar-room-row').filter({ hasText: '개발' }).locator('a').dragTo(f.getByTestId('room-folder-head'))
  await expect(f.getByTestId('sidebar-room-row')).toHaveCount(2)
  // only in the folder, not also under 팀 대화방
  await expect(cp.locator('[data-testid="sidebar-room-row"][data-section="team"] span[title]')).toHaveText(['디자인'])
  // folded: one pill, the strongest ("@" over a count)
  await f.getByTestId('room-folder-fold').click()
  await expect(f.getByTestId('room-folder-fold')).toHaveAttribute('aria-expanded', 'false')
  await expect(f.getByTestId('room-folder-pill')).toHaveAttribute('data-kind', 'mention')
  await expect(f.getByTestId('room-folder-pill')).toHaveText(`@${t['rooms.mentionedYou']}`)
  // after a reload it is the server's: still in the folder
  await page.reload()
  await expect(cp.getByTestId('room-folder').getByTestId('room-folder-pill')).toHaveAttribute('data-kind', 'mention')
  await cp.getByTestId('room-folder-fold').click()
  await expect(cp.getByTestId('room-folder').getByTestId('sidebar-room-row')).toHaveCount(2)
})

test("another person never sees my room folders (switching accounts in the same window)", async ({ page }) => {
  await start(page)
  expect((await page.request.post('/__test/rooms', { data: { rooms: [room('디자인')] } })).ok()).toBeTruthy()
  await page.getByTestId('rail-chats').click()
  await newFolder(page, '비밀 대화', page.getByTestId('chats-panel').getByTestId('rooms-folder-new'))
  await expect(page.getByTestId('room-folder-name')).toHaveText('비밀 대화')
  await page.getByTestId('rail-ai').click()
  // sign out, and the next person signs in in this window
  await page.getByTestId('account-menu').click()
  await page.getByTestId('logout').click()
  await expect(page.getByTestId('login-username')).toBeVisible()
  await page.getByTestId('login-username').fill(MEMBER.username)
  await page.getByTestId('login-password').fill(MEMBER.password)
  await page.getByTestId('login-submit').click()
  await expect(panel(page)).toBeVisible()
  const mine = (await page.request.get('/api/nav-folders').then((r) => r.json())) as { items: unknown[] }
  expect(mine.items).toEqual([])
  await page.getByTestId('rail-chats').click()
  await expect(page.getByText('비밀 대화')).toHaveCount(0)
  await expect(page.getByTestId('room-folder')).toHaveCount(0)
})
