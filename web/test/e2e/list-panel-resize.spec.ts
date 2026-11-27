// The list panel beside the rail can be resized (components/panels/PanelFrame.tsx with components/PanelDivider.tsx,
// lib/panelWidth.ts LIST_PANEL; docs/decisions/20261127-list-panel-resize.md): today's width until it is dragged, 240 to
// 400 px with 740 px kept for the main area, one width for every place, remembered in this browser in px, a double-click
// gives the default back, the keyboard (Right widens, Left narrows, Shift a bigger step, Home, End), a narrower window
// clamps it for the time being, and the fold rule for a room with its thread and side chat uses the panel's real width.
// The room is answered through page.route (rooms-mock.ts).
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'
import { DICTS } from '../../src/i18n'

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } })

const SORA = { id: 'sora', name: '소라님' }
const id = (n: number) => `019a5f00-0000-7000-8000-0000000004${String(n).padStart(2, '0')}`
const ROOT = id(1)
const KEY = 'mycel.listPanel.width'

async function open(page: Page, thread = false) {
  await reset(page)
  await routeRoom(page, {
    members: [SORA],
    messages: [
      { id: ROOT, author: SORA, body: '이번 주 시안 검토 일정 공유드려요.', extra: { thread: { replyCount: 1, lastReplyAt: '2026-11-05T09:03:00.000Z', repliers: [SORA], newReplies: false } } },
      { id: id(2), author: SORA, body: '확인 부탁드려요.', threadRootId: ROOT },
    ],
  })
  await signIn(page)
  await page.goto(thread ? `/rooms/${ROOM_ID}/t/${ROOT}` : `/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-message').first()).toBeVisible()
}

const panel = (page: Page) => page.locator('#rail-panel')
const panelWidth = async (page: Page) => Math.round((await panel(page).boundingBox())!.width)
const mainWidth = async (page: Page) => Math.round((await page.locator('main#main').boundingBox())!.width)

async function dragTo(page: Page, x: number) {
  const box = (await page.getByTestId('list-panel-divider').boundingBox())!
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(x, y, { steps: 6 })
  await expect(page.getByTestId('list-panel-drag-overlay')).toBeVisible()
  await page.mouse.up()
  await expect(page.getByTestId('list-panel-drag-overlay')).toHaveCount(0)
}

test('1440: drag, limits, remembered after reload and in every place, double-click reset, keyboard', async ({ page }) => {
  await open(page)
  const divider = page.getByTestId('list-panel-divider')
  await expect(divider).toHaveAttribute('role', 'separator')
  await expect(divider).toHaveAttribute('aria-orientation', 'vertical')
  await expect(divider).toHaveAttribute('aria-label', DICTS.ko['rail.resizeList'])
  // today's width until it is dragged
  expect(await panelWidth(page)).toBe(288)
  await expect(divider).toHaveAttribute('aria-valuenow', '288')
  await expect(divider).toHaveAttribute('aria-valuemin', '240')
  await expect(divider).toHaveAttribute('aria-valuemax', '400')
  const left = (await panel(page).boundingBox())!.x

  await dragTo(page, left + 350)
  await expect.poll(() => panelWidth(page)).toBe(350)
  await expect(divider).toHaveAttribute('aria-valuenow', '350')
  expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBe('350')
  // limits: 400 at most, 240 at least
  await dragTo(page, left + 900)
  await expect.poll(() => panelWidth(page)).toBe(400)
  await dragTo(page, left + 50)
  await expect.poll(() => panelWidth(page)).toBe(240)
  await dragTo(page, left + 330)
  await expect.poll(() => panelWidth(page)).toBe(330)
  expect(await mainWidth(page)).toBeGreaterThanOrEqual(740)

  // kept after a reload, and the same width in another place (활동)
  await page.reload()
  await expect(page.getByTestId('room-message').first()).toBeVisible()
  expect(await panelWidth(page)).toBe(330)
  await page.goto('/activity')
  await expect(page.getByTestId('activity-panel')).toBeVisible()
  expect(await panelWidth(page)).toBe(330)

  // the keyboard: Right widens, Left narrows, Shift takes 96 px, Home and End
  await divider.focus()
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => panelWidth(page)).toBe(354)
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => panelWidth(page)).toBe(330)
  await page.keyboard.press('Shift+ArrowLeft')
  await expect.poll(() => panelWidth(page)).toBe(240)
  await page.keyboard.press('End')
  await expect.poll(() => panelWidth(page)).toBe(400)
  await page.keyboard.press('Home')
  await expect.poll(() => panelWidth(page)).toBe(240)
  expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBe('240')

  // a double-click: today's width again, nothing remembered
  await divider.dblclick()
  await expect.poll(() => panelWidth(page)).toBe(288)
  expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBeNull()
})

test('a 1052 px window clamps a remembered width to 240 for now and gives it back when wider', async ({ page }) => {
  await open(page)
  await page.evaluate((k) => localStorage.setItem(k, '400'), KEY)
  await page.reload()
  await expect(page.getByTestId('room-message').first()).toBeVisible()
  expect(await panelWidth(page)).toBe(400)
  await page.setViewportSize({ width: 1052, height: 800 })
  await expect.poll(() => panelWidth(page)).toBe(240)
  await expect(page.getByTestId('list-panel-divider')).toHaveAttribute('aria-valuemax', '240')
  expect(await mainWidth(page)).toBeGreaterThanOrEqual(740)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1052)
  expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBe('400')
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect.poll(() => panelWidth(page)).toBe(400)
})

test('1460: with the thread and the side chat open, the default list stays; a list dragged wide folds away', async ({ page }) => {
  await page.setViewportSize({ width: 1460, height: 900 })
  await open(page, true)
  await expect(page.getByTestId('chats-panel')).toBeVisible()
  await page.getByTestId('room-side-chat-button').click()
  await expect(page.getByTestId('room-page')).toHaveAttribute('data-columns', 'three')
  // 1460 ≥ 88 + 300 + 1060: the default list fits beside the three columns
  await expect(page.getByTestId('chats-panel')).toBeVisible()
  // dragged to 400 (88 + 400 + 1060 = 1548 > 1460): it folds, and the three columns still fit
  await page.getByTestId('list-panel-divider').focus()
  await page.keyboard.press('End')
  await expect(page.getByTestId('chats-panel')).toHaveCount(0)
  await expect(page.getByTestId('room-page')).toHaveAttribute('data-columns', 'three')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1460)
  // the side chat closes: the list is back at its 400 px
  await page.getByTestId('room-side-chat').getByTestId('side-chat-close').click()
  await expect(page.getByTestId('chats-panel')).toBeVisible()
  expect(await panelWidth(page)).toBe(400)
})

test('the right-hand panel fits again when the list widens: the chat beside it keeps its room', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await open(page, true)
  const room = page.getByTestId('room')
  await expect(page.getByTestId('room-thread')).toBeVisible()
  const divider = page.getByTestId('list-panel-divider')
  await divider.focus()
  await page.keyboard.press('End')
  await expect.poll(() => panelWidth(page)).toBe(400)
  // the room keeps its 420 px beside the thread
  await expect.poll(async () => Math.round((await room.boundingBox())!.width)).toBeGreaterThanOrEqual(420)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280)
})

test('a phone has no divider', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page)
  await expect(page.getByTestId('list-panel-divider')).toHaveCount(0)
})
