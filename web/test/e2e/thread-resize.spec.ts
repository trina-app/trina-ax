// The divider on a thread's left edge (components/PanelDivider.tsx, the same one as the preview panel's): drag, limits
// (the thread keeps 320 px, the room 420 px), remembered per browser, double-click reset, arrow keys, a smaller window
// clamps the remembered width, no divider on a phone, and the preview panel's divider still works on its own width.
// The room is answered through page.route (rooms-mock.ts).
// SHOTS_DIR=<folder>: screenshots at 1440 px (light and dark; the thread narrow and wide; the divider on hover and focus).
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'
import { DICTS } from '../../src/i18n'

test.use({ serviceWorkers: 'block' })

const SORA = { id: 'sora', name: '소라님' }
const OLGA = { id: 'olga', name: 'Olga' }
const id = (n: number) => `019a5f00-0000-7000-8000-0000000002${String(n).padStart(2, '0')}`
const KEY = 'mycel.threadPanel.widthFraction'
const SHOTS = process.env.SHOTS_DIR

async function openThread(page: Page) {
  await reset(page)
  await routeRoom(page, {
    members: [SORA],
    messages: [
      { id: id(1), author: SORA, body: '이번 주 시안 검토 일정 공유드려요. 금요일까지 피드백 부탁드립니다.', extra: { thread: { replyCount: 2, lastReplyAt: '2026-11-05T09:03:00.000Z', repliers: [SORA, OLGA], newReplies: false } } },
      { id: id(2), author: SORA, body: '확인했어요! 로고 버전 두 개 중에 어느 쪽이 나은지 의견 주세요.', threadRootId: id(1) },
      { id: id(3), author: OLGA, body: '두 번째 안이 좋아 보여요. 색 대비가 더 분명해요.', threadRootId: id(1) },
    ],
  })
  await signIn(page)
  await page.goto(`/rooms/${ROOM_ID}/t/${id(1)}`)
  await expect(page.getByTestId('room-thread').getByTestId('room-message')).toHaveCount(3)
}

const width = async (page: Page, testId: string) => Math.round((await page.getByTestId(testId).boundingBox())!.width)
const threadWidth = (page: Page) => width(page, 'room-thread')
const roomWidth = (page: Page) => width(page, 'room')

async function dragTo(page: Page, x: number, divider = 'thread-divider', overlay = 'thread-drag-overlay') {
  const box = (await page.getByTestId(divider).boundingBox())!
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(x, y, { steps: 6 })
  await expect(page.getByTestId(overlay)).toBeVisible()
  await page.mouse.up()
  await expect(page.getByTestId(overlay)).toHaveCount(0)
}

test('drag, limits, remembered after reload, double-click reset, arrow keys', async ({ page }) => {
  await openThread(page)
  const divider = page.getByTestId('thread-divider')
  await expect(divider).toHaveAttribute('role', 'separator')
  await expect(divider).toHaveAttribute('aria-orientation', 'vertical')
  await expect(divider).toHaveAttribute('aria-label', DICTS.ko['rooms.threadResize'])
  const vw = page.viewportSize()!.width
  // 1360 px: the room row is 1360 - 280 (sidebar); the thread starts at 440 px, the room keeps at least 420
  const row = (await threadWidth(page)) + (await roomWidth(page))
  const first = await threadWidth(page)
  expect(first).toBe(440)
  await expect(divider).toHaveAttribute('aria-valuenow', '440')
  await expect(divider).toHaveAttribute('aria-valuemin', '320')
  await expect(divider).toHaveAttribute('aria-valuemax', String(row - 420))

  // drag left: wider, the room narrower by as much
  await dragTo(page, vw - 600)
  await expect.poll(() => threadWidth(page)).toBe(600)
  expect(await roomWidth(page)).toBe(row - 600)
  await expect(divider).toHaveAttribute('aria-valuenow', '600')

  // limits: far left keeps the room at 420, far right keeps the thread at 320
  await dragTo(page, 5)
  await expect.poll(() => roomWidth(page)).toBe(420)
  await dragTo(page, vw - 5)
  await expect.poll(() => threadWidth(page)).toBe(320)

  // remembered in this browser (the thread is open again after the reload, at the same width)
  await dragTo(page, vw - 520)
  await expect.poll(() => threadWidth(page)).toBe(520)
  expect(Number(await page.evaluate((k) => localStorage.getItem(k), KEY))).toBeCloseTo(520 / row, 3)
  await page.reload()
  await expect(page.getByTestId('room-thread').getByTestId('room-message')).toHaveCount(3)
  await expect.poll(async () => Math.abs((await threadWidth(page)) - 520)).toBeLessThanOrEqual(1)

  // double-click: back to the default, and forgotten
  await page.getByTestId('thread-divider').dblclick()
  await expect.poll(() => threadWidth(page)).toBe(first)
  expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBeNull()

  // keyboard: Left widens by 24, Right narrows, Shift 96, Home and End; the focused divider shows the accent line
  await divider.focus()
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => threadWidth(page)).toBe(first + 24)
  const line = await divider.evaluate((e) => getComputedStyle(e, '::after').backgroundColor)
  expect(line).not.toBe('rgba(0, 0, 0, 0)')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => threadWidth(page)).toBe(first - 24)
  await page.keyboard.press('Shift+ArrowLeft')
  await expect.poll(() => threadWidth(page)).toBe(first - 24 + 96)
  await page.keyboard.press('Home')
  await expect.poll(() => threadWidth(page)).toBe(320)
  await page.keyboard.press('End')
  await expect.poll(() => roomWidth(page)).toBe(420)
  await expect(divider).toHaveAttribute('aria-valuenow', String(row - 420))
})

test('a smaller window keeps the room at 420 px; a click without a move saves nothing', async ({ page }) => {
  await openThread(page)
  const before = await threadWidth(page)
  const box = (await page.getByTestId('thread-divider').boundingBox())!
  await page.mouse.click(box.x + 1, box.y + box.height / 2)
  expect(await threadWidth(page)).toBe(before)
  expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBeNull()

  // a wide thread, then a narrower window: the remembered share is clamped so the room keeps 420
  await dragTo(page, 5)
  await expect.poll(() => roomWidth(page)).toBe(420)
  await page.setViewportSize({ width: 1100, height: 860 })
  await expect.poll(() => roomWidth(page)).toBe(420)
  expect(await threadWidth(page)).toBeGreaterThanOrEqual(320)
  // nothing sideways: the thread ends at the window's edge
  const t = (await page.getByTestId('room-thread').boundingBox())!
  expect(Math.round(t.x + t.width)).toBe(1100)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1100)
  // back to the wide window: the same share again
  await page.setViewportSize({ width: 1360, height: 860 })
  await expect.poll(() => roomWidth(page)).toBe(420)
})

test('a phone shows the thread full screen and no divider', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openThread(page)
  await expect(page.getByTestId('thread-divider')).toBeHidden()
  expect(await threadWidth(page)).toBe(390)
})

test('the preview panel still resizes, and the two panels keep their own widths', async ({ page }) => {
  await openThread(page)
  await dragTo(page, page.viewportSize()!.width - 560)
  await expect.poll(() => threadWidth(page)).toBe(560)
  const thread = await page.evaluate((k) => localStorage.getItem(k), KEY)

  // the AI chat's file preview (as preview-resize.spec.ts opens it)
  await page.goto('/')
  await page.getByTestId('composer-input').fill('write the files please')
  await page.getByTestId('send').click()
  const answer = page.getByTestId('assistant-message').last()
  await expect(answer).toHaveAttribute('data-status', 'done')
  const summary = answer.getByTestId('file-summary')
  await summary.getByRole('button').first().click()
  await summary.getByRole('button', { name: 'marketing/report.md' }).click()
  await expect(page.getByTestId('file-panel')).toContainText('Report')
  await expect(page.getByTestId('panel-divider')).toHaveAttribute('aria-label', DICTS.ko['preview.resize'])
  const panel = await width(page, 'side-panel')
  await dragTo(page, Math.round(page.viewportSize()!.width * 0.5), 'panel-divider', 'panel-drag-overlay')
  await expect.poll(() => width(page, 'side-panel')).toBeGreaterThan(panel + 30)
  expect(await page.evaluate(() => localStorage.getItem('mycel.sidePanel.widthFraction'))).not.toBeNull()
  // the thread's width is its own
  expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBe(thread)
  await page.getByTestId('panel-divider').dblclick()
  await expect.poll(() => width(page, 'side-panel')).toBe(panel)
  expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBe(thread)
})

test('screenshots at 1440 px', async ({ page }) => {
  test.skip(!SHOTS, 'SHOTS_DIR not set')
  await page.setViewportSize({ width: 1440, height: 900 })
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await openThread(page)
    await page.screenshot({ path: `${SHOTS}/thread-1440-${scheme}-default.png` })
    await dragTo(page, 1440 - 320)
    await expect.poll(() => threadWidth(page)).toBe(320)
    // away from the divider: its accent line fades (150 ms)
    await page.mouse.move(700, 450)
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${SHOTS}/thread-1440-${scheme}-narrow.png` })
    await dragTo(page, 5)
    await expect.poll(() => roomWidth(page)).toBe(420)
    await page.mouse.move(700, 450)
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${SHOTS}/thread-1440-${scheme}-wide.png` })
    await page.getByTestId('thread-divider').dblclick()
    await expect.poll(() => threadWidth(page)).toBe(440)
    // hover: the accent line on the edge
    const box = (await page.getByTestId('thread-divider').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + 300)
    await page.waitForTimeout(250)
    await page.screenshot({ path: `${SHOTS}/thread-1440-${scheme}-hover.png` })
    // keyboard focus
    await page.mouse.move(700, 450)
    await page.getByTestId('thread-divider').focus()
    await page.keyboard.press('ArrowLeft')
    await page.waitForTimeout(250)
    await page.screenshot({ path: `${SHOTS}/thread-1440-${scheme}-focus.png` })
  }
})
