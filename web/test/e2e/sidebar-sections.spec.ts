// My sidebar sections (docs/decisions/20261121-personal-sidebar-sections.md; nav/SidebarSections.tsx): each person sorts
// their own Chats list into sections, as Slack's. Made from the Channels "+" menu, filled right away (Add
// conversations), by a row's "⋯" › Move to section (second, under Pin), by dragging, and taken out by dragging onto the
// Channels header (with Undo); an empty one says how to fill it; a section's "⋯" deletes it. The same on a phone (its
// row menu is a sheet). Nobody else ever sees them. Never a "folder" on screen.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'

const t = DICTS.ko
const MEMBER = { username: 'bob', password: 'bob password 1' }

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const room = (name: string, o: Record<string, unknown> = {}) => ({
  id: uuidv7(), kind: 'team', name, groupId: uuidv7(), memberCount: 3, peers: [{ id: 'bob', name: 'Bob' }], createdAt: ago(600), activityAt: ago(5),
  canRename: false, managerId: null, unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false, lastReadSeq: 0, lastSeq: 0, lastMessage: null, muted: false, ...o,
})
const dm = (name: string, o: Record<string, unknown> = {}) => room(name, { kind: 'dm', name: null, groupId: null, memberCount: 2, peers: [{ id: 'bob', name }], ...o })

async function start(page: Page, width: number, rooms: unknown[]) {
  await page.setViewportSize({ width, height: width < 768 ? 844 : 900 })
  await reset(page)
  await signIn(page)
  expect((await page.request.post('/__test/rooms', { data: { rooms } })).ok()).toBeTruthy()
}

/** the computer's Chats panel and its sections */
const cp = (page: Page) => page.getByTestId('chats-panel')
const panelSection = (page: Page, key: string) => cp(page).locator(`[data-testid="chats-panel-section"][data-section="${key}"]`)
const phoneSection = (page: Page, key: string) => page.getByTestId('rooms-page').locator(`[data-testid="rooms-section"][data-section="${key}"]`)

/** Channels "+" › New section, its name typed; the Add conversations step opens next */
async function newSection(page: Page, from: Locator, name: string) {
  await from.getByTestId('rooms-channels-add').click()
  await page.getByTestId('rooms-new-section').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText(t['sidebarSections.onlyYou'])
  await dialog.getByRole('textbox').fill(name)
  await dialog.getByRole('textbox').press('Enter')
  await expect(page.getByTestId('add-conversations')).toBeVisible()
  await expect(page.getByRole('dialog')).toContainText(t['sidebarSections.addTitle'].replace('{name}', name))
}
const tick = (page: Page, name: string) => page.getByTestId('add-conversations-row').filter({ hasText: name }).getByRole('checkbox').check()
const names = (l: Locator) => l.locator('[data-testid="sidebar-room-row"] span[title]')

test('a computer (1440): create › add › move › drag in › drag out with Undo › empty hint › delete', async ({ page }) => {
  await start(page, 1440, [room('디자인', { activityAt: ago(1) }), room('개발', { activityAt: ago(2) }), room('영업', { activityAt: ago(3) }), dm('Bob', { activityAt: ago(4) })])
  await page.getByTestId('rail-chats').click()
  await expect(cp(page).getByTestId('sidebar-room-row')).toHaveCount(4)
  // no folder words or icons anywhere in the list
  await expect(cp(page)).not.toContainText('폴더')

  // create, then add a channel and a DM right away
  await newSection(page, panelSection(page, 'team'), 'Bots')
  await tick(page, '디자인')
  await tick(page, 'Bob')
  await page.getByTestId('add-conversations-add').click()
  const bots = panelSection(page, 'folder')
  await expect(bots.getByTestId('panel-section-name')).toHaveText('Bots')
  await expect(names(bots)).toHaveText(['디자인', 'Bob'])
  await expect(page.getByTestId('toast').last()).toContainText(t['sidebarSections.movedMany'].replace('{n}', '2').replace('{name}', 'Bots'))
  // a section sits above Channels, a top-level header like it
  const order = await cp(page).locator('[data-testid="chats-panel-section"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-section')))
  expect(order).toEqual(['folder', 'team', 'dm'])

  // row "⋯": Move to section is second, under Pin
  const sales = cp(page).getByTestId('sidebar-room-row').filter({ hasText: '영업' })
  await sales.hover()
  await sales.getByTestId('sidebar-room-menu').click()
  const items = page.getByRole('menu').last().getByRole('menuitem')
  await expect(items.nth(0)).toHaveAttribute('data-testid', /room-menu-(un)?pin/)
  await expect(items.nth(1)).toHaveText(t['sidebarSections.moveTo'])
  await items.nth(1).click()
  await page.getByRole('menuitemradio', { name: 'Bots' }).click()
  // (inside a section, by latest activity, as Direct messages)
  await expect(names(bots)).toHaveText(['디자인', '영업', 'Bob'])

  // dragged in
  await cp(page).getByTestId('sidebar-room-row').filter({ hasText: '개발' }).locator('a').dragTo(bots.getByTestId('chats-panel-label'))
  await expect(bots.getByTestId('sidebar-room-row')).toHaveCount(4)
  await expect(panelSection(page, 'team').getByTestId('sidebar-room-row')).toHaveCount(0)
  // Channels stays, empty, with its "+"
  await expect(panelSection(page, 'team').getByTestId('rooms-channels-add')).toBeVisible()

  // dragged out onto the Channels header, then Undo puts it back
  await bots.getByTestId('sidebar-room-row').filter({ hasText: '개발' }).locator('a').dragTo(panelSection(page, 'team').getByTestId('chats-panel-label'))
  await expect(names(panelSection(page, 'team'))).toHaveText(['개발'])
  const toast = page.getByTestId('toast').filter({ hasText: t['sidebarSections.removed'].replace('{name}', 'Bots') })
  await toast.getByTestId('toast-link').click()
  await expect(bots.getByTestId('sidebar-room-row').filter({ hasText: '개발' })).toHaveCount(1)

  // an empty section says how to fill it, and its button opens Add conversations
  await newSection(page, panelSection(page, 'team'), '비어 있음')
  await page.getByTestId('add-conversations-skip').click()
  const empty = panelSection(page, 'folder').filter({ hasText: '비어 있음' })
  await expect(empty.getByTestId('section-empty')).toContainText(t['sidebarSections.emptyComputer'])
  await empty.getByTestId('section-empty-add').click()
  await expect(page.getByTestId('add-conversations')).toBeVisible()
  await page.getByTestId('add-conversations-skip').click()

  // after a reload it is the server's
  await page.reload()
  await expect(panelSection(page, 'folder').filter({ hasText: 'Bots' }).getByTestId('sidebar-room-row')).toHaveCount(4)

  // delete: asked first (it holds 4), its conversations go back to Channels and Direct messages
  const b = panelSection(page, 'folder').filter({ hasText: 'Bots' })
  await b.getByTestId('chats-panel-label').hover()
  await b.getByTestId('section-menu').click()
  await page.getByTestId('section-menu-delete').click()
  await expect(page.getByRole('dialog')).toContainText(t['sidebarSections.deleteBody'].replace('{n}', '4'))
  await page.getByRole('dialog').getByRole('button', { name: t['sidebarSections.delete'] }).click()
  await expect(panelSection(page, 'folder')).toHaveCount(1)
  await expect(panelSection(page, 'team').getByTestId('sidebar-room-row')).toHaveCount(3)
  await expect(panelSection(page, 'dm').getByTestId('sidebar-room-row')).toHaveCount(1)
})

test('a phone (390): create › add › long press › Move to section › New section… › delete', async ({ page }) => {
  await start(page, 390, [room('디자인', { activityAt: ago(1) }), room('개발', { activityAt: ago(2) }), dm('Bob', { activityAt: ago(3) })])
  await page.goto('/rooms')
  await expect(page.getByTestId('rooms-row')).toHaveCount(3)
  await newSection(page, phoneSection(page, 'team'), 'Bots')
  await tick(page, '디자인')
  await page.getByTestId('add-conversations-add').click()
  const bots = phoneSection(page, 'folder')
  await expect(bots.getByTestId('rooms-row')).toHaveCount(1)
  // the row's sheet (a long press; a right-click opens the same): Move to section second, then New section…
  const bob = page.getByTestId('rooms-row').filter({ hasText: 'Bob' })
  await bob.click({ button: 'right' })
  const sheet = page.getByRole('menu').last()
  await expect(sheet.getByRole('menuitem').nth(1)).toHaveText(t['sidebarSections.moveTo'])
  await sheet.getByRole('menuitem').nth(1).click()
  await page.getByTestId('row-section-pick-new').click()
  await page.getByRole('dialog').getByRole('textbox').fill('사람')
  await page.getByRole('dialog').getByRole('textbox').press('Enter')
  const people = phoneSection(page, 'folder').filter({ hasText: '사람' })
  await expect(people.getByTestId('rooms-row')).toHaveCount(1)
  await expect(phoneSection(page, 'dm').getByTestId('rooms-row')).toHaveCount(0)
  // the section's "⋯" sheet: Add conversations first; delete it
  await people.getByTestId('section-menu').click()
  await expect(page.getByRole('menu').last().getByRole('menuitem').first()).toHaveText(t['sidebarSections.add'])
  await page.getByTestId('section-menu-delete').click()
  await page.getByRole('dialog').getByRole('button', { name: t['sidebarSections.delete'] }).click()
  await expect(phoneSection(page, 'dm').getByTestId('rooms-row')).toHaveCount(1)
  await expect(page.getByTestId('rooms-page')).not.toContainText('폴더')
})

test('another person never sees my sections (switching accounts in the same window)', async ({ page }) => {
  await start(page, 1440, [room('디자인')])
  await page.getByTestId('rail-chats').click()
  await newSection(page, panelSection(page, 'team'), '비밀 섹션')
  await page.getByTestId('add-conversations-skip').click()
  await expect(panelSection(page, 'folder').getByTestId('panel-section-name')).toHaveText('비밀 섹션')
  await page.getByTestId('account-menu').click()
  await page.getByTestId('logout').click()
  await expect(page.getByTestId('login-username')).toBeVisible()
  await page.getByTestId('login-username').fill(MEMBER.username)
  await page.getByTestId('login-password').fill(MEMBER.password)
  await page.getByTestId('login-submit').click()
  const mine = (await page.request.get('/api/nav-folders', { headers: { [CSRF_HEADER]: '1' } }).then((r) => r.json())) as { items: unknown[] }
  expect(mine.items).toEqual([])
  await page.getByTestId('rail-chats').click()
  await expect(page.getByText('비밀 섹션')).toHaveCount(0)
})

test('a computer (1440): Undo never undoes a later move; a pinned one says it stays pinned; the header "⋯" list opens under its button', async ({ page }) => {
  const design = room('디자인', { activityAt: ago(1) })
  await start(page, 1440, [design, room('개발', { activityAt: ago(2), pinnedAt: ago(1) }), room('영업', { activityAt: ago(3) })])
  await page.getByTestId('rail-chats').click()
  await newSection(page, panelSection(page, 'team'), 'A')
  await page.getByTestId('add-conversations-skip').click()
  await newSection(page, panelSection(page, 'team'), 'B')
  await page.getByTestId('add-conversations-skip').click()
  const sectionB = panelSection(page, 'folder').filter({ has: page.getByTestId('panel-section-name').getByText('B', { exact: true }) })
  // 디자인 › A (toast 1), then › B (toast 2): toast 1's Undo leaves it in B and says why
  const row = () => cp(page).getByTestId('sidebar-room-row').filter({ hasText: '디자인' })
  await row().locator('a').dragTo(panelSection(page, 'folder').first().getByTestId('chats-panel-label'))
  const first = page.getByTestId('toast').filter({ hasText: t['sidebarSections.moved'].replace('{name}', 'A') })
  await expect(first).toBeVisible()
  await row().locator('a').dragTo(sectionB.getByTestId('chats-panel-label'))
  await expect(sectionB.getByTestId('sidebar-room-row').filter({ hasText: '디자인' })).toHaveCount(1)
  await first.getByTestId('toast-link').click()
  await expect(page.getByTestId('toast').filter({ hasText: t['sidebarSections.undoStale'] })).toBeVisible()
  await expect(sectionB.getByTestId('sidebar-room-row').filter({ hasText: '디자인' })).toHaveCount(1)
  // a pinned conversation moved to a section stays under Pinned, and the toast says so
  await panelSection(page, 'pinned').getByTestId('sidebar-room-row').filter({ hasText: '개발' }).locator('a').dragTo(sectionB.getByTestId('chats-panel-label'))
  await expect(page.getByTestId('toast').filter({ hasText: t['sidebarSections.movedPinned'].replace('{name}', 'B') })).toBeVisible()
  await expect(panelSection(page, 'pinned').getByTestId('sidebar-room-row').filter({ hasText: '개발' })).toHaveCount(1)
  // the conversation's header "⋯" › Move to section: the list opens right under the button, not at the column's bottom
  await page.goto(`/rooms/${design.id}`)
  const more = page.getByTestId('room-menu')
  await more.click()
  await page.getByTestId('row-section-move').click()
  const list = page.getByRole('menu').filter({ has: page.getByTestId('row-section-pick-new') })
  await expect(list).toBeVisible()
  const [b, l] = [await more.boundingBox(), await list.boundingBox()]
  expect(l!.y - (b!.y + b!.height)).toBeLessThan(80)
  expect(l!.y).toBeGreaterThan(b!.y)
  await expect(list.getByRole('menuitemradio', { name: 'B' })).toHaveAttribute('aria-checked', 'true')
})

// docs/decisions/20261121-sidebar-projects-group.md (QA TC-6309, TC-6310): each team project's own chat room is under
// the built-in Projects group, between Channels and Direct messages, by name; a project room goes in a section of mine
// and back out onto the Projects header, as onto the other kind headers; the header stays while it is in a section.
const projectRoom = (name: string, o: Record<string, unknown> = {}) => room(name, {
  kind: 'group', groupId: null, projectRoom: true, project: { id: uuidv7(), name, folderPath: `projects/${name}`, canSave: true, room: true },
  lastMessage: { id: uuidv7(), seq: 1, author: { id: 'bob', name: 'Bob' }, excerpt: 'hi', fileCount: 0, deleted: false, createdAt: ago(5) }, ...o,
})
test('a computer (1440): Projects between Channels and Direct messages, by name; a project room into a section and back out onto the Projects header', async ({ page }) => {
  await start(page, 1440, [room('디자인', { activityAt: ago(1) }), projectRoom('Website 10', { activityAt: ago(2) }), projectRoom('Website 2', { activityAt: ago(3) }), dm('Bob', { activityAt: ago(4) })])
  await page.getByTestId('rail-chats').click()
  await expect.poll(() => cp(page).locator('[data-testid="chats-panel-section"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-section')))).toEqual(['team', 'project', 'dm'])
  const projects = panelSection(page, 'project')
  await expect(projects.getByTestId('panel-section-name')).toHaveText(t['rooms.section.project'])
  await expect(names(projects)).toHaveText(['Website 2', 'Website 10'])
  // no "+" on Projects
  await expect(projects.getByTestId('rooms-channels-add')).toHaveCount(0)
  await expect(projects.getByTestId('rooms-new-message')).toHaveCount(0)

  await newSection(page, panelSection(page, 'team'), 'Clients')
  await page.getByTestId('add-conversations-skip').click()
  const clients = panelSection(page, 'folder')
  await projects.getByTestId('sidebar-room-row').filter({ hasText: 'Website 2' }).locator('a').dragTo(clients.getByTestId('chats-panel-label'))
  await expect(names(clients)).toHaveText(['Website 2'])
  await expect(names(projects)).toHaveText(['Website 10'])
  // both in sections: the header stays, so it can be dropped back
  await projects.getByTestId('sidebar-room-row').filter({ hasText: 'Website 10' }).locator('a').dragTo(clients.getByTestId('chats-panel-label'))
  await expect(projects.getByTestId('sidebar-room-row')).toHaveCount(0)
  await expect(projects).toBeVisible()
  await clients.getByTestId('sidebar-room-row').filter({ hasText: 'Website 2' }).locator('a').dragTo(projects.getByTestId('chats-panel-label'))
  await expect(names(projects)).toHaveText(['Website 2'])
  await expect(page.getByTestId('toast').filter({ hasText: t['sidebarSections.removed'].replace('{name}', 'Clients') })).toBeVisible()
})

test('a phone (390): the Conversations tab has Projects too, in the same place', async ({ page }) => {
  await start(page, 390, [room('디자인', { activityAt: ago(1) }), projectRoom('Website', { activityAt: ago(2) }), dm('Bob', { activityAt: ago(3) })])
  await page.goto('/rooms')
  await expect.poll(() => page.getByTestId('rooms-page').locator('[data-testid="rooms-section"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-section')))).toEqual(['team', 'project', 'dm'])
  await expect(phoneSection(page, 'project').getByTestId('rooms-row')).toHaveCount(1)
  await expect(phoneSection(page, 'project')).toContainText(t['rooms.section.project'])
})

test("a computer (1440): a project in the trash takes its room out of Projects; Restore brings it back", async ({ page }) => {
  await start(page, 1440, [room('디자인', { activityAt: ago(1) })])
  const H = { [CSRF_HEADER]: '1' }
  const made = await page.request.post('/api/projects', { headers: H, data: { name: 'Atlas', scope: 'team', participants: [{ subjectType: 'user', subjectId: 'bob' }], instructions: '' } })
  expect(made.status()).toBe(201)
  const pid = ((await made.json()) as { id: string }).id
  const opened = await page.request.post(`/api/projects/${pid}/room`, { headers: H })
  expect(opened.ok()).toBeTruthy()
  const rid = ((await opened.json()) as { id: string }).id
  // it shows under Projects once someone writes in it
  expect((await page.request.post(`/api/rooms/${rid}/messages`, { headers: H, data: { body: 'kickoff', clientMessageId: `cm-${uuidv7()}`, mentions: [], fileIds: [] } })).ok()).toBeTruthy()
  await page.goto('/')
  await page.getByTestId('rail-chats').click()
  const projects = panelSection(page, 'project')
  await expect(names(projects)).toHaveText(['Atlas'])
  expect((await page.request.delete(`/api/projects/${pid}`, { headers: H })).ok()).toBeTruthy()
  await page.reload()
  await page.getByTestId('rail-chats').click()
  await expect(panelSection(page, 'team')).toBeVisible()
  await expect(cp(page).getByTestId('sidebar-room-row').filter({ hasText: 'Atlas' })).toHaveCount(0)
  await expect(projects).toHaveCount(0)
  expect((await page.request.post(`/api/projects/${pid}/restore`, { headers: H })).ok()).toBeTruthy()
  await page.reload()
  await page.getByTestId('rail-chats').click()
  await expect(names(panelSection(page, 'project'))).toHaveText(['Atlas'])
})
