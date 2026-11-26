// Named group chats are private channels (docs/decisions/20261117-named-groups-private-channels.md): a group room with a
// name is under 채널 with a lock and no faces, one without a name under 다이렉트 메시지 with its people's faces; naming a
// group DM from its "⋯" (비공개 채널로 바꾸기) moves it to 채널 at once. Each section has its own "+": 채널 만들기 (the
// picker with a required name) and 새 메시지 (the picker with no name field). A guest gets neither.
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { routeRooms, type MockRoomSpec } from './rooms-mock'
import { DICTS } from '../../src/i18n'

const t = DICTS.ko
const kid = (n: number) => `019a5f00-0000-7000-8000-${String(1700 + n).padStart(12, '0')}`
const SAM = { id: 'sam', name: 'Sam' }, KIM = { id: 'kim', name: '김민지' }, EVE = { id: 'eve', name: 'Eve' }

const ROOMS: MockRoomSpec[] = [
  { id: kid(1), kind: 'all', name: null, peers: [SAM, KIM, EVE], ago: 6, last: '점심 같이 하실 분' },
  { id: kid(2), kind: 'team', name: '디자인', peers: [SAM], ago: 1, last: '시안 올렸어요' },
  { id: kid(3), kind: 'group', name: '출시 준비', peers: [SAM, KIM], ago: 3, last: '체크리스트 올렸어요' },
  { id: kid(4), kind: 'group', name: null, peers: [EVE, KIM], ago: 2, last: '12시에 봬요' },
  { id: kid(5), kind: 'dm', name: null, peers: [SAM], ago: 4, last: '내일 봬요' },
]

const panel = (page: Page) => page.getByTestId('chats-panel')
const row = (page: Page, section: string, name: string) => panel(page).locator(`[data-testid="sidebar-room-row"][data-section="${section}"]`).filter({ hasText: name })

async function start(page: Page) {
  await page.setViewportSize({ width: 1440, height: 860 })
  // admins Dana and Eve besides Bob: people to pick
  await reset(page, { withAdmin: true })
  await signIn(page)
  await page.getByTestId('rail-chats').click()
  await expect(panel(page)).toBeVisible()
}

test('a named group chat is a private channel under 채널 (a lock, no faces); an unnamed one is a group DM; naming it moves it live', async ({ page }) => {
  const state = await routeRooms(page, ROOMS)
  await start(page)
  await expect(row(page, 'team', '출시 준비').locator('svg.lucide-lock')).toHaveCount(1)
  await expect(row(page, 'team', '출시 준비').getByTestId('room-group-people')).toHaveCount(0)
  await expect(row(page, 'dm', 'Eve, 김민지').getByTestId('room-group-people')).toHaveCount(1)
  // its header shows the lock too
  await row(page, 'team', '출시 준비').getByTestId('sidebar-room').click()
  await expect(page.getByTestId('room-page').locator('svg.lucide-lock').first()).toBeVisible()

  // the group DM's "⋯": 비공개 채널로 바꾸기 in place of 이름 바꾸기, a name required
  const dm = row(page, 'dm', 'Eve, 김민지')
  await dm.hover()
  await dm.getByTestId('sidebar-room-menu').click()
  await expect(page.getByRole('menuitem', { name: t['chat.rename'] })).toHaveCount(0)
  await page.getByTestId('room-menu-rename').click()
  await expect(page.getByText(t['rooms.menu.makePrivateBody'])).toBeVisible()
  await expect(page.getByTestId('dialog-confirm')).toBeDisabled()
  await page.getByTestId('dialog-input').fill('점심 모임')
  await page.getByTestId('dialog-confirm').click()
  await expect(row(page, 'team', '점심 모임')).toHaveCount(1)
  await expect(row(page, 'team', '점심 모임').locator('svg.lucide-lock')).toHaveCount(1)
  await expect(panel(page).locator('[data-testid="sidebar-room-row"][data-section="dm"]').filter({ hasText: 'Eve' })).toHaveCount(0)
  expect(state.updated.at(-1)).toEqual({ roomId: kid(4), body: { name: '점심 모임' } })

  // a private channel's rename cannot clear the name: it stays a channel
  const ch = row(page, 'team', '점심 모임')
  await ch.hover()
  await ch.getByTestId('sidebar-room-menu').click()
  await page.getByTestId('room-menu-rename').click()
  await page.getByTestId('dialog-input').fill('')
  await expect(page.getByTestId('dialog-confirm')).toBeDisabled()
})

test('채널 만들기 asks for a name; 새 메시지 has no name field', async ({ page }) => {
  await routeRooms(page, ROOMS)
  const created: unknown[] = []
  await page.route(/\/api\/rooms$/, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    created.push(route.request().postDataJSON())
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ error: { code: 'validation', message: 'not in this mock' } }) })
  })
  await start(page)
  await panel(page).getByTestId('rooms-channels-add').click()
  await page.getByTestId('rooms-new-channel').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading')).toHaveText(t['rooms.section.newChannel'])
  // the name first, labelled, with the focus
  await expect(dialog.getByTestId('picker-name')).toBeFocused()
  await expect(dialog.getByText(t['rooms.info.nameLabelChannel'])).toBeVisible()
  await dialog.getByTestId('people-row').first().getByTestId('picker-tick').check()
  // one person and no name: nothing to create yet
  await expect(dialog.getByTestId('picker-go')).toBeDisabled()
  await expect(dialog.getByTestId('picker-go')).toHaveText(t['rooms.picker.createPrivate'])
  await dialog.getByTestId('picker-name').fill('출시 회의')
  await expect(dialog.getByTestId('picker-go')).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  await panel(page).getByTestId('rooms-new-message').click()
  await expect(page.getByRole('dialog').getByRole('heading')).toHaveText(t['rooms.newChat'])
  // the cursor starts in the people search, not on Close (TC-4461 follow-up)
  await expect(page.getByRole('dialog').getByTestId('people-search')).toBeFocused()
  const rows = page.getByRole('dialog').getByTestId('people-row')
  await rows.nth(0).getByTestId('picker-tick').check()
  await rows.nth(1).getByTestId('picker-tick').check()
  await expect(page.getByRole('dialog').getByTestId('picker-name')).toHaveCount(0)
  await expect(page.getByRole('dialog').getByTestId('picker-go')).toHaveText(t['rooms.picker.start'])
  expect(created).toEqual([])
})
