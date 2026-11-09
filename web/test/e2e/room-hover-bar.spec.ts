// A message's hover bar in the browser (components/rooms/MessageHoverBar.tsx): it floats over the top-right edge of the
// message under the mouse (under the first one), moves nothing, names each button in a tooltip
// (components/Tooltip.tsx), toggles a quick reaction, opens the thread, and is reached with the keyboard too (Tab shows
// it, Esc closes its menu). Its buttons in order: ✅ 👀 👍, 반응 추가, 스레드에서 답장, ✦ 트리나에게 이 메시지 묻기, ⋮ 더 보기.
// The ✦ is Trina's mark without a circle (rooms/AiFace.tsx AiMark), as in the room header.
// The room is answered through page.route (rooms-mock.ts).
import { expect, test, type Locator, type Page } from '@playwright/test'
import { PRODUCT_NAMED_AFTER_AI } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

test.use({ serviceWorkers: 'block' })

const SORA = { id: 'sora', name: '소라님' }
const OLGA = { id: 'olga', name: 'Olga' }
const id = (n: number) => `019a5f00-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`
const MESSAGES = [
  { id: id(1), author: SORA, body: '이번 주 시안 공유드려요' },
  { id: id(2), author: SORA, body: '피드백 부탁드려요' },
  { id: id(3), author: OLGA, body: '확인했어요' },
]

async function openRoom(page: Page) {
  await reset(page)
  const room = await routeRoom(page, { members: [SORA], messages: MESSAGES })
  await signIn(page)
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-message')).toHaveCount(3)
  return room
}
const opacity = (l: Locator) => l.evaluate((e) => getComputedStyle(e).opacity)
const box = async (l: Locator) => (await l.boundingBox())!

test('hover: the bar floats over the top-right edge, moves nothing, and every button says what it does', async ({ page }) => {
  const room = await openRoom(page)
  const msg = page.getByTestId('room-message').nth(1)
  const bar = msg.getByTestId('message-hover-bar')
  expect(await opacity(bar)).toBe('0')
  // the long-press sheet's own button never shows on a computer (only the bar does)
  await expect(page.getByTestId('message-menu')).toHaveCount(3)
  for (const b of await page.getByTestId('message-menu').all()) await expect(b).toBeHidden()
  const before = await box(msg)
  await msg.hover()
  await expect.poll(() => opacity(bar)).toBe('1')
  // nothing moved; the bar is inside the message's right edge and over its top edge
  expect(await box(msg)).toEqual(before)
  const b = await box(bar)
  expect(b.x + b.width).toBeLessThanOrEqual(before.x + before.width)
  expect(b.y).toBeLessThan(before.y)
  expect(b.y + b.height).toBeGreaterThan(before.y)
  // the row is marked while the mouse is on it
  expect(await msg.evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')

  // a tooltip on each button: reply in thread says exactly that
  await bar.getByTestId('message-thread').hover()
  await expect(page.getByRole('tooltip')).toHaveText('스레드에서 답장')
  await bar.getByTestId('message-react').hover()
  await expect(page.getByRole('tooltip')).toHaveText('반응 추가')

  // ✅ in one click; the chip shows under the message
  await bar.locator('[data-emoji="✅"]').click()
  await expect(msg.getByTestId('reaction-chip')).toHaveCount(1)
  expect(room.reacted).toEqual([{ messageId: id(2), emoji: '✅', on: true }])
  await expect(bar.locator('[data-emoji="✅"]')).toHaveAttribute('aria-pressed', 'true')
  // the clicked button keeps the focus, but a click is no keyboard: the bar goes with the mouse
  await page.mouse.move(5, 5)
  await expect.poll(() => opacity(bar)).toBe('0')

  // reply in thread opens the thread beside the room, its box ready
  await msg.hover()
  await bar.getByTestId('message-thread').click()
  await expect(page.getByTestId('room-thread')).toBeVisible()
  await expect(page.getByTestId('room-thread').getByTestId('room-input')).toBeFocused()
})

test('✦ is Trina\'s mark with no circle, drawn larger than the icons beside it; the header\'s too, its button the same size', async ({ page }) => {
  await openRoom(page)
  const msg = page.getByTestId('room-message').nth(1)
  await msg.hover()
  const bar = msg.getByTestId('message-hover-bar')
  await expect.poll(() => opacity(bar)).toBe('1')
  const ask = bar.getByTestId('message-ask-trina')
  // no grey circle (the face of the AI as someone in the room): the mark itself, 22 px in the 28 px button (the
  // sparkle 18 where the product is not named after its AI)
  await expect(ask.getByTestId('ai-face')).toHaveCount(0)
  const size = PRODUCT_NAMED_AFTER_AI ? 22 : 18
  expect(await box(ask.locator('svg'))).toMatchObject({ width: size, height: size })
  expect(await box(ask)).toMatchObject({ width: 28, height: 28 })
  // the icons beside it are 16; the bar keeps its height
  expect(await box(bar.getByTestId('message-thread').locator('svg'))).toMatchObject({ width: 16, height: 16 })
  expect((await box(bar)).height).toBe(34)
  // the room header's ✦: drawn 24 beside the 16 px bell, its button the 32 px it was (the sparkle 18, its button 28)
  const head = page.getByTestId('room-side-chat-button')
  const [drawn, button] = PRODUCT_NAMED_AFTER_AI ? [24, 32] : [18, 28]
  expect(await box(head.locator('svg'))).toMatchObject({ width: drawn, height: drawn })
  expect(await box(head)).toMatchObject({ width: button, height: button })
  expect(await box(page.getByTestId('room-notify').locator('svg'))).toMatchObject({ width: 16, height: 16 })
})

test('the first message has its bar under it, where the header cannot cut it', async ({ page }) => {
  await openRoom(page)
  const first = page.getByTestId('room-message').first()
  await first.hover()
  const bar = first.getByTestId('message-hover-bar')
  await expect.poll(() => opacity(bar)).toBe('1')
  const m = await box(first), b = await box(bar)
  expect(b.y + b.height).toBeGreaterThan(m.y + m.height)
  const header = await box(page.getByTestId('room').locator('h1'))
  expect(b.y).toBeGreaterThan(header.y + header.height)
})

test('keyboard: Tab reaches the bar and shows it, each button is named, Esc closes its menu and gives the focus back', async ({ page }) => {
  await openRoom(page)
  await page.getByTestId('room-input').first().click()
  // backwards from the message box: past its own buttons into the last message's bar (my own message: ⋮ last)
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Shift+Tab')
    if ((await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'message-more') break
  }
  const mine = page.getByTestId('room-message').last()
  const more = mine.getByTestId('message-more')
  await expect(more).toBeFocused()
  await expect.poll(() => opacity(mine.getByTestId('message-hover-bar'))).toBe('1')
  await expect(page.getByRole('tooltip')).toHaveText('더 보기')
  // my own message: copy, edit, delete
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu')).toBeVisible()
  await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(['복사', '수정', '삭제'])
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(more).toBeFocused()
  // Shift+Tab walks the bar's buttons, each with a name
  for (const name of ['트리나에게 이 메시지 묻기', '스레드에서 답장', '반응 추가', '👍 반응 남기기', '👀 반응 남기기', '✅ 반응 남기기']) {
    await page.keyboard.press('Shift+Tab')
    await expect(page.locator(':focus')).toHaveAttribute('aria-label', name)
  }
  // someone else's message: copy only
  const theirs = page.getByTestId('room-message').nth(1)
  await theirs.hover()
  await theirs.getByTestId('message-more').click()
  await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(['복사'])
})
