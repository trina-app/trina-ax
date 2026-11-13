// My list folders on screen (docs/DECISIONS.md "List folders on screen"; the navigation plan's phase P4b; the server's
// `navRail` switch on): "새 폴더" in the Trina list, rename, move up and down, delete (a confirm only when something is
// in it); a chat into a folder with its row's "⋯" (the keyboard's way) or dragged onto it, and out again; a project's
// chat says why it stays in its project; a folder's + asks Trina into it; room folders in 대화 with the pill a folded one
// keeps; and nobody else ever sees my folders.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { CSRF_HEADER, PRODUCT_NAMED_AFTER_AI, uuidv7 } from '@mycel/shared/api'
import { PRODUCT } from '@mycel/shared'
import { navRail, reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'

const t = DICTS.ko
const ai = PRODUCT_NAMED_AFTER_AI ? t['rooms.aiName'] : PRODUCT.shortName
const MEMBER = { username: 'bob', password: 'bob password 1' }
const post = (page: Page, url: string, data: unknown = {}) => page.request.post(url, { headers: { [CSRF_HEADER]: '1' }, data })

async function chat(page: Page, title: string, projectId: string | null = null): Promise<string> {
  const r = await post(page, '/api/chats', { title, ...(projectId ? { projectId } : {}) })
  expect(r.ok()).toBeTruthy()
  return ((await r.json()) as { id: string }).id
}
async function start(page: Page, width = 1440) {
  await page.setViewportSize({ width, height: 900 })
  await reset(page)
  await navRail(page)
  await signIn(page)
  await expect(page.getByTestId('trina-panel')).toBeVisible()
}
const panel = (page: Page) => page.getByTestId('trina-panel')
const folderNames = (page: Page) => panel(page).locator('[data-testid="trina-group"][data-kind="folder"] [data-testid="trina-group-name"]')
const folder = (page: Page, name: string) => panel(page).locator('[data-testid="trina-group"][data-kind="folder"]').filter({ has: page.getByTestId('trina-group-name').getByText(name, { exact: true }) })
const rowTitles = (scope: Locator) => scope.locator('li a[href^="/c/"] .truncate')
const chatRow = (page: Page, title: string) => panel(page).locator('li').filter({ has: page.locator('a[href^="/c/"]').getByText(title, { exact: true }) })

/** "새 폴더" (the quiet row, or the + on the folders' label), its name typed in the dialog */
async function newFolder(page: Page, name: string, from: Locator) {
  await from.click()
  const field = page.getByRole('dialog').getByRole('textbox')
  await field.fill(name)
  await field.press('Enter')
  await expect(page.getByRole('dialog')).toHaveCount(0)
}
async function folderMenu(page: Page, name: string, item: string) {
  const f = folder(page, name)
  await f.getByTestId('trina-group-head').hover()
  await f.getByTestId('folder-menu').click()
  await page.getByTestId(item).click()
}

test('a folder is made, renamed, moved down and up, and deleted (asked first only when something is in it)', async ({ page }) => {
  await start(page)
  await chat(page, 'Weekly notes')
  await page.reload()
  // no folder yet: one quiet row "새 폴더"
  await expect(panel(page).getByTestId('trina-folders')).toHaveCount(0)
  await newFolder(page, '주간 보고', panel(page).getByTestId('chats-folder-new'))
  await expect(panel(page).getByTestId('trina-folders')).toContainText(`${t['trinaList.folders']} · ${t['trinaList.onlyYou']}`)
  await expect(folder(page, '주간 보고').getByTestId('trina-group-empty')).toHaveText(t['navFolders.empty'])
  // the empty line is one line
  const box = await folder(page, '주간 보고').getByTestId('trina-group-empty').boundingBox()
  expect(box!.height).toBeLessThan(30)
  // the second from the label's +
  await newFolder(page, '아이디어', panel(page).getByTestId('trina-folders').getByTestId('chats-folder-new'))
  await expect(folderNames(page)).toHaveText(['주간 보고', '아이디어'])
  // a name already used is refused in the dialog
  await panel(page).getByTestId('trina-folders').getByTestId('chats-folder-new').click()
  await page.getByRole('dialog').getByRole('textbox').fill('아이디어')
  await expect(page.getByRole('dialog')).toContainText(t['navFolders.nameTaken'])
  await page.keyboard.press('Escape')

  await folderMenu(page, '주간 보고', 'folder-menu-down')
  await expect(folderNames(page)).toHaveText(['아이디어', '주간 보고'])
  await folderMenu(page, '주간 보고', 'folder-menu-up')
  await expect(folderNames(page)).toHaveText(['주간 보고', '아이디어'])
  // the first has no "위로", the last no "아래로"
  await folder(page, '주간 보고').getByTestId('trina-group-head').hover()
  await folder(page, '주간 보고').getByTestId('folder-menu').click()
  await expect(page.getByTestId('folder-menu-up')).toHaveCount(0)
  await page.keyboard.press('Escape')

  await folderMenu(page, '아이디어', 'folder-menu-rename')
  const field = page.getByRole('dialog').getByRole('textbox')
  await expect(field).toHaveValue('아이디어')
  await field.fill('나중에 볼 것')
  await field.press('Enter')
  await expect(folderNames(page)).toHaveText(['주간 보고', '나중에 볼 것'])
  // the order and names hold after a reload (the server's)
  await page.reload()
  await expect(folderNames(page)).toHaveText(['주간 보고', '나중에 볼 것'])

  // empty: deleted at once
  await folderMenu(page, '나중에 볼 것', 'folder-menu-delete')
  await expect(folderNames(page)).toHaveText(['주간 보고'])
  // with a chat in it: asked first; the chat goes back to the other chats
  const id = (await page.request.get('/api/chats').then((r) => r.json()) as { items: { id: string; title: string }[] }).items.find((c) => c.title === 'Weekly notes')!.id
  const folders = (await page.request.get('/api/nav-folders').then((r) => r.json())) as { items: { id: string; name: string }[] }
  await page.request.put(`/api/chats/${id}/folder`, { headers: { [CSRF_HEADER]: '1' }, data: { folderId: folders.items[0]!.id } })
  await page.reload()
  await expect(rowTitles(folder(page, '주간 보고'))).toHaveText(['Weekly notes'])
  await folderMenu(page, '주간 보고', 'folder-menu-delete')
  await expect(page.getByRole('dialog')).toContainText(t['navFolders.deleteBodyChats'])
  await page.getByRole('dialog').getByRole('button', { name: t['navFolders.delete'] }).click()
  await expect(panel(page).getByTestId('trina-folders')).toHaveCount(0)
  await expect(rowTitles(panel(page).getByTestId('trina-other'))).toContainText(['Weekly notes'])
})

test('the keyboard moves a chat into a folder and out again; a project chat says why it stays; a mouse drags one in', async ({ page }) => {
  await start(page)
  const r = await post(page, '/api/projects', { name: 'Acme launch', scope: 'team', instructions: '' })
  const projectId = ((await r.json()) as { id: string }).id
  await chat(page, 'Launch plan', projectId)
  await chat(page, 'QA notes')
  await chat(page, 'Weekly notes')
  await page.reload()
  await newFolder(page, '주간 보고', panel(page).getByTestId('chats-folder-new'))

  // the keyboard: the row's "⋯", "폴더로 옮기기", the folder
  const row = chatRow(page, 'Weekly notes')
  await row.locator('a').focus()
  await page.keyboard.press('Tab')
  await expect(row.getByTestId('chat-row-menu')).toBeFocused()
  await page.keyboard.press('Enter')
  // the menu has the keyboard (its first item); arrows reach "폴더로 옮기기"
  await expect(page.getByTestId('chat-row-pin')).toBeFocused()
  for (let i = 0; i < 6 && !(await page.getByTestId('row-folder-move').evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('ArrowDown')
  await expect(page.getByTestId('row-folder-move')).toBeFocused()
  await page.keyboard.press('Enter')
  const pick = page.getByRole('menu', { name: t['navFolders.moveTo'] })
  await expect(pick).toBeVisible()
  await expect(pick.getByRole('menuitemradio', { name: '주간 보고' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(rowTitles(folder(page, '주간 보고'))).toHaveText(['Weekly notes'])
  await expect(rowTitles(panel(page).getByTestId('trina-other'))).not.toContainText(['Weekly notes'])

  // out again: "폴더에서 빼기"
  const inFolder = folder(page, '주간 보고').locator('li').filter({ hasText: 'Weekly notes' })
  await inFolder.hover()
  await inFolder.getByTestId('chat-row-menu').click()
  await page.getByTestId('row-folder-out').click()
  await expect(folder(page, '주간 보고').getByTestId('trina-group-empty')).toBeVisible()
  await expect(rowTitles(panel(page).getByTestId('trina-other'))).toContainText(['Weekly notes'])

  // a project's chat: the item is off and the menu says why
  const p = chatRow(page, 'Launch plan')
  await p.hover()
  await p.getByTestId('chat-row-menu').click()
  await expect(page.getByTestId('row-folder-move')).toBeDisabled()
  await expect(page.getByTestId('row-folder-why')).toHaveText(t['navFolders.projectStays'])
  await expect(page.getByTestId('row-folder-move')).toHaveAccessibleDescription(t['navFolders.projectStays'])
  await page.keyboard.press('Escape')

  // a mouse: drag the row onto the folder
  await chatRow(page, 'QA notes').locator('a').dragTo(folder(page, '주간 보고').getByTestId('trina-group-head'))
  await expect(rowTitles(folder(page, '주간 보고'))).toHaveText(['QA notes'])
  // "새 폴더 만들어 넣기" from the picker
  const w = chatRow(page, 'Weekly notes')
  await w.hover()
  await w.getByTestId('chat-row-menu').click()
  await page.getByTestId('row-folder-move').click()
  await page.getByTestId('row-folder-pick-new').click()
  const field = page.getByRole('dialog').getByRole('textbox')
  await field.fill('아이디어')
  await field.press('Enter')
  await expect(rowTitles(folder(page, '아이디어'))).toHaveText(['Weekly notes'])
})

test("a folder's + asks Trina, and the new chat lands in the folder", async ({ page }) => {
  await start(page)
  await page.reload()
  await newFolder(page, '주간 보고', panel(page).getByTestId('chats-folder-new'))
  const f = folder(page, '주간 보고')
  await f.getByTestId('trina-group-head').hover()
  await expect(f.getByTestId('trina-group-ask')).toHaveAccessibleName(t['history.group.newChat'].replace('{name}', '주간 보고').replace('{ai}', ai))
  await f.getByTestId('trina-group-ask').click()
  await expect(page).toHaveURL(/\/\?folder=/)
  await expect(page.getByTestId('home-folder')).toContainText(t['navFolders.goesInto'].replace('{name}', '주간 보고'))
  await page.getByTestId('composer-input').fill('이번 주 보고 정리해 줘')
  await page.getByTestId('composer-input').press('Enter')
  await expect(page).toHaveURL(/\/c\//)
  await expect(f.locator('li a[href^="/c/"]')).toHaveCount(1)
})

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const room = (name: string, o: Record<string, unknown> = {}) => ({
  id: uuidv7(), kind: 'team', name, groupId: uuidv7(), memberCount: 3, peers: [{ id: 'bob', name: 'Bob' }], createdAt: ago(600), activityAt: ago(5),
  canRename: false, managerId: null, unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false, lastReadSeq: 0, lastSeq: 0, lastMessage: null, muted: false, ...o,
})

test('room folders in 대화: made, a room moved in and dragged in, a folded one keeps the strongest pill', async ({ page }) => {
  await start(page)
  const rooms = [room('디자인', { activityAt: ago(1) }), room('개발', { activityAt: ago(2), unreadCount: 3, mentioned: true, lastSeq: 3 }), room('영업', { activityAt: ago(3), unreadCount: 1, lastSeq: 1 })]
  expect((await page.request.post('/__test/rooms', { data: { rooms } })).ok()).toBeTruthy()
  await page.getByTestId('rail-chats').click()
  const cp = page.getByTestId('chats-panel')
  await expect(cp.getByTestId('sidebar-room-row')).toHaveCount(3)
  await newFolder(page, '우리 팀', cp.getByTestId('rooms-folder-new'))
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

test("another person never sees my folders (switching accounts in the same window)", async ({ page }) => {
  await start(page)
  await chat(page, 'Owner plans')
  await page.reload()
  await newFolder(page, '비밀 폴더', panel(page).getByTestId('chats-folder-new'))
  await chatRow(page, 'Owner plans').locator('a').dragTo(folder(page, '비밀 폴더').getByTestId('trina-group-head'))
  await expect(rowTitles(folder(page, '비밀 폴더'))).toHaveText(['Owner plans'])
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
  await expect(panel(page).getByTestId('trina-list')).toBeVisible()
  await expect(page.getByText('비밀 폴더')).toHaveCount(0)
  await expect(panel(page).getByTestId('trina-folders')).toHaveCount(0)
  const mine = (await page.request.get('/api/nav-folders').then((r) => r.json())) as { items: unknown[] }
  expect(mine.items).toEqual([])
  await page.getByTestId('rail-chats').click()
  await expect(page.getByText('비밀 대화')).toHaveCount(0)
  await expect(page.getByTestId('room-folder')).toHaveCount(0)
})

test("on a phone: the same folders in 트리나's list, the long-press menu files a chat, the folder's + opens the box at /new", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  await navRail(page)
  await page.goto('/login')
  await page.getByTestId('login-username').fill('olga')
  await page.getByTestId('login-password').fill('correct horse battery')
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('phone-trina-home').or(page.getByTestId('welcome'))).toBeVisible()
  const weekly = (await (await post(page, '/api/nav-folders', { kind: 'chats', name: '주간 보고' })).json()) as { id: string }
  await chat(page, 'Weekly notes')
  await page.goto('/')
  const list = page.getByTestId('phone-trina-list')
  const f = list.locator('[data-testid="trina-group"][data-kind="folder"]')
  await expect(f.getByTestId('trina-group-name')).toHaveText('주간 보고')
  // a touch screen shows the header's + and "⋯" without hover
  await expect(f.getByTestId('folder-menu')).toBeVisible()
  // the row's "⋯" (always shown on a phone) › 폴더로 옮기기 › 주간 보고, as sheets
  const row = list.locator('li').filter({ has: page.locator('a[href^="/c/"]').getByText('Weekly notes', { exact: true }) })
  await row.getByTestId('chat-row-menu').click()
  await page.getByTestId('row-folder-move').click()
  await page.getByRole('menuitemradio', { name: '주간 보고' }).click()
  await expect(rowTitles(f)).toHaveText(['Weekly notes'])
  await page.screenshot({ path: process.env.SHOTS ? `${process.env.SHOTS}/phone-trina-390-light.png` : test.info().outputPath('phone.png') })
  await f.getByTestId('trina-group-ask').click()
  await expect(page).toHaveURL(new RegExp(`/new\\?folder=${weekly.id}$`))
  await expect(page.getByTestId('home-folder')).toContainText('주간 보고')
})
