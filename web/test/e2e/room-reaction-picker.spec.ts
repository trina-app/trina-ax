// Any emoji as a reaction in the browser (docs/DECISIONS.md "Any emoji as a reaction"; components/rooms/Reactions.tsx,
// components/EmojiPicker.tsx): 😭 from the hover row's strip in one more click; "More emoji" opens the picker, a search
// for "cry" (or "울음") finds 😭, a pick reacts and closes it, and the next picker has it first under "Recently used";
// the keyboard (Enter picks the first match, Esc closes and gives the keyboard back); a message with the most different
// emoji refuses a new one before asking the server; the phone's long-press sheet has six and "More emoji", which opens
// the picker as a sheet; the status dialog's emoji button opens the same picker with its 32 first. The room is answered
// through page.route (rooms-mock.ts). With SHOTS_DIR set, the last tests save the screens for review.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom, type MockMessage } from './rooms-mock'

test.use({ serviceWorkers: 'block' })

const SORA = { id: 'sora', name: '소라님' }
const DAN = { id: 'dan', name: 'Dan' }
const OLGA = { id: 'olga', name: 'Olga' }
const id = (n: number) => `019a5f00-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`
const r = (emoji: string, count: number, mine = false) => ({ emoji, count, mine, users: [...(mine ? [OLGA] : []), SORA, DAN].slice(0, count) })
const MESSAGES: MockMessage[] = [
  { id: id(1), author: SORA, body: 'Shipping the new onboarding today' },
  { id: id(2), author: DAN, body: 'The demo crashed in front of the client 😅', extra: { reactions: [r('😭', 3, true), r('👀', 2), r('🫠', 1), r('🙏', 2), r('🫶', 1)] } },
  { id: id(3), author: SORA, body: 'Can someone look at the release notes?' },
]

async function openRoom(page: Page, messages = MESSAGES) {
  await reset(page)
  const room = await routeRoom(page, { members: [SORA, DAN], messages })
  await signIn(page)
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-message')).toHaveCount(messages.length)
  return room
}
/** the hover row's smile button of a message: the strip */
async function strip(msg: Locator) {
  await msg.hover()
  await msg.getByTestId('message-react').click()
  const s = msg.getByTestId('reaction-strip')
  await expect(s).toBeVisible()
  return s
}

test('😭 is in the strip: one click puts it on the message', async ({ page }) => {
  const room = await openRoom(page)
  const msg = page.getByTestId('room-message').nth(0)
  const s = await strip(msg)
  // the row has ✅ 👀 👍; the strip six more and "More emoji"
  await expect(s.getByTestId('reaction-pick')).toHaveText(['❤️', '😂', '😭', '🙏', '🎉', '🔥'])
  await expect(s.getByTestId('reaction-more')).toHaveAccessibleName('이모지 더 보기')
  await s.locator('[data-emoji="😭"]').click()
  await expect(msg.getByTestId('reaction-chip')).toHaveText(['😭1'])
  expect(room.reacted).toEqual([{ messageId: id(1), emoji: '😭', on: true }])
  await expect(msg.getByTestId('reaction-strip')).toHaveCount(0)
})

test('More emoji: search "cry", pick 😭; the next picker has it first under Recently used', async ({ page }) => {
  const room = await openRoom(page)
  const msg = page.getByTestId('room-message').nth(0)
  await (await strip(msg)).getByTestId('reaction-more').click()
  const pop = page.getByTestId('emoji-popover')
  await expect(pop).toBeVisible()
  await expect(pop).toHaveAccessibleName('반응 추가')
  // the search has the keyboard; nothing used yet, so no "Recently used"; the groups under their headings
  const search = pop.getByTestId('emoji-search')
  await expect(search).toBeFocused()
  await expect(pop.getByTestId('emoji-recent')).toHaveCount(0)
  await expect(pop.getByRole('heading', { name: '표정과 감정' })).toBeVisible()
  // the popover stays inside the window, by the button
  const box = (await pop.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(860)
  await search.fill('cry')
  const results = pop.getByTestId('emoji-results').getByTestId('emoji-pick')
  await expect(results.first()).toBeVisible()
  const found = await results.evaluateAll((bs) => bs.map((b) => b.textContent))
  expect(found).toContain('😭')
  expect(found).toContain('😢')
  expect(found.length).toBeLessThan(20)
  await pop.locator('[data-emoji="😭"]').click()
  await expect(pop).toHaveCount(0)
  await expect(msg.getByTestId('reaction-chip')).toHaveText(['😭1'])
  expect(room.reacted).toEqual([{ messageId: id(1), emoji: '😭', on: true }])

  // another message: 😭 first under Recently used
  const other = page.getByTestId('room-message').nth(2)
  await (await strip(other)).getByTestId('reaction-more').click()
  const recent = page.getByTestId('emoji-popover').getByTestId('emoji-recent').getByTestId('emoji-pick')
  await expect(recent.first()).toHaveText('😭')
  // nothing found: said so
  await page.getByTestId('emoji-search').fill('zzzzqx')
  await expect(page.getByTestId('emoji-none')).toHaveText('찾는 이모지가 없어요')
  // a search in Hangul looks in the Korean names
  await page.getByTestId('emoji-search').fill('울음')
  await expect(page.getByTestId('emoji-results').locator('[data-emoji="😭"]')).toBeVisible()
  // an emoji pasted into the search is offered as it is (a skin tone the grid does not show)
  await page.getByTestId('emoji-search').fill('👍🏽')
  await expect(page.getByTestId('emoji-results').getByTestId('emoji-pick')).toHaveText(['👍🏽'])
  // Enter picks the first match
  await page.getByTestId('emoji-search').press('Enter')
  await expect(page.getByTestId('emoji-popover')).toHaveCount(0)
  expect(room.reacted.at(-1)).toEqual({ messageId: id(3), emoji: '👍🏽', on: true })
})

test('the keyboard: ↓ into the grid, arrows move; Esc closes and gives the keyboard back, Tab leaves', async ({ page }) => {
  const room = await openRoom(page)
  const msg = page.getByTestId('room-message').nth(0)
  await (await strip(msg)).getByTestId('reaction-more').click()
  const pop = page.getByTestId('emoji-popover')
  await expect(pop.getByTestId('emoji-search')).toBeFocused()
  await expect(pop.getByTestId('emoji-pick').first()).toBeVisible()
  await page.keyboard.press('ArrowDown')
  const first = pop.getByTestId('emoji-pick').nth(0)
  await expect(first).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(pop.getByTestId('emoji-pick').nth(1)).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(pop.getByTestId('emoji-pick').nth(9)).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await expect(pop.getByTestId('emoji-search')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(pop).toHaveCount(0)
  await expect(msg.getByTestId('message-react')).toBeFocused()
  expect(room.reacted).toEqual([])
  // Tab leaves it as it leaves a menu: on from the smile button, in the page's order
  await msg.getByTestId('message-react').click()
  await msg.getByTestId('reaction-more').click()
  await expect(pop.getByTestId('emoji-search')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(pop).toHaveCount(0)
  await expect(msg.getByTestId('message-thread')).toBeFocused()
  // a click outside closes it too
  await msg.getByTestId('message-react').click()
  await msg.getByTestId('reaction-more').click()
  await expect(pop).toBeVisible()
  await page.mouse.click(700, 300)
  await expect(pop).toHaveCount(0)
})

test(`a message with 20 different emoji: a new one is refused before asking the server; one that is there still works`, async ({ page }) => {
  const twenty = ['😀', '😁', '😂', '🤣', '😃', '😄', '😅', '😆', '😉', '😊', '😋', '😎', '😍', '😘', '🥰', '😗', '😙', '🥲', '😚', '🙂']
  const room = await openRoom(page, [{ id: id(1), author: SORA, body: 'react away', extra: { reactions: twenty.map((e) => r(e, 1)) } }])
  const msg = page.getByTestId('room-message').nth(0)
  await expect(msg.getByTestId('reaction-chip')).toHaveCount(20)
  await (await strip(msg)).locator('[data-emoji="😭"]').click()
  await expect(page.getByText('한 메시지에는 반응을 20가지까지 남길 수 있어요. 이미 있는 반응을 눌러 주세요.')).toBeVisible()
  expect(room.reacted).toEqual([])
  await msg.getByTestId('reaction-chip').first().click()
  await expect.poll(() => room.reacted).toEqual([{ messageId: id(1), emoji: '😀', on: true }])
})

test('the status dialog opens the same picker, its 32 first; a search finds any emoji', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.getByTestId('account-menu').click()
  await page.getByTestId('account-status').click()
  await page.getByTestId('status-emoji-button').click()
  const grid = page.getByTestId('status-emoji-grid')
  await expect(grid.getByTestId('status-emoji-pick')).toHaveCount(32)
  await expect(page.getByTestId('status-dialog').getByTestId('emoji-recent')).toHaveCount(0)
  await page.getByTestId('emoji-search').fill('cry')
  await page.getByTestId('emoji-results').locator('[data-emoji="😭"]').click()
  await expect(page.getByTestId('status-emoji-button')).toHaveText('😭')
  // Enter in the picker's search picks; it does not save the dialog
  await page.getByTestId('status-emoji-button').click()
  await page.getByTestId('emoji-search').fill('rocket')
  await page.getByTestId('emoji-search').press('Enter')
  await expect(page.getByTestId('status-emoji-button')).toHaveText('🚀')
  await expect(page.getByTestId('status-dialog')).toBeVisible()
})

/** A long press with a finger on a message: its sheet. */
async function longPress(page: Page, target: Locator) {
  await target.dispatchEvent('pointerdown', { button: 0, pointerType: 'touch', isPrimary: true, clientX: 100, clientY: 100 })
  await page.waitForTimeout(650)
  await target.dispatchEvent('pointerup', { button: 0, pointerType: 'touch', isPrimary: true, clientX: 100, clientY: 100 })
  await expect(page.getByRole('menu')).toBeVisible()
  // (the finger lifting after the long press is no pick)
  await page.waitForTimeout(450)
}

test.describe('a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('the long-press sheet: six and More emoji, which opens the picker as a sheet', async ({ page }) => {
    const room = await openRoom(page)
    const msg = page.getByTestId('room-message').nth(0)
    await longPress(page, msg)
    const s = page.getByRole('menu').getByTestId('reaction-strip')
    await expect(s.getByTestId('reaction-pick')).toHaveText(['👍', '✅', '👀', '❤️', '😂', '😭'])
    // the strip fits the sheet
    const sb = (await s.boundingBox())!
    expect(sb.x).toBeGreaterThanOrEqual(0)
    expect(sb.x + sb.width).toBeLessThanOrEqual(390)
    await s.getByTestId('reaction-more').click()
    await expect(page.getByRole('menu')).toHaveCount(0)
    const sheet = page.getByTestId('emoji-sheet')
    await expect(sheet).toBeVisible()
    await expect(page.getByRole('dialog', { name: '반응 추가' })).toBeVisible()
    // a sheet from the bottom, as wide as the screen
    const dialog = (await page.getByRole('dialog', { name: '반응 추가' }).boundingBox())!
    expect(Math.round(dialog.x)).toBe(0)
    expect(Math.round(dialog.width)).toBe(390)
    expect(Math.round(dialog.y + dialog.height)).toBe(844)
    await sheet.getByTestId('emoji-search').fill('cry')
    await sheet.getByTestId('emoji-results').locator('[data-emoji="😭"]').click()
    await expect(sheet).toHaveCount(0)
    await expect(msg.getByTestId('reaction-chip')).toHaveText(['😭1'])
    expect(room.reacted).toEqual([{ messageId: id(1), emoji: '😭', on: true }])
  })
})

// ---------------- screenshots for review (SHOTS_DIR) ----------------
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(process.env.SHOTS_DIR!, name) })

test.describe('screens for review', () => {
  test.skip(!process.env.SHOTS_DIR, 'SHOTS_DIR not set')
  test('1440: the strip with 😭, the picker with a search (light), the picker (dark), a message with several reactions', async ({ page }) => {
    fs.mkdirSync(process.env.SHOTS_DIR!, { recursive: true })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await routeRoom(page, { members: [SORA, DAN], messages: MESSAGES })
    await signIn(page)
    await page.goto(`/rooms/${ROOM_ID}`)
    const msg = page.getByTestId('room-message').nth(2)
    await strip(msg)
    await shot(page, '1440-light-strip.png')
    await msg.getByTestId('reaction-more').click()
    await page.getByTestId('emoji-search').fill('cry')
    await expect(page.getByTestId('emoji-results')).toBeVisible()
    await shot(page, '1440-light-picker-search.png')
    await page.getByTestId('emoji-search').fill('')
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    await expect(page.getByRole('heading', { name: 'Smileys & emotion' })).toBeVisible()
    await shot(page, '1440-dark-picker.png')
    await page.keyboard.press('Escape')
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
    await page.mouse.move(700, 120)
    await page.getByTestId('room-message').nth(1).getByTestId('reaction-chip').nth(1).hover()
    await shot(page, '1440-light-several-reactions.png')
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    await shot(page, '1440-dark-several-reactions.png')
    // the status dialog's picker
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
    await page.getByTestId('account-menu').click()
    await page.getByTestId('account-status').click()
    await page.getByTestId('status-emoji-button').click()
    await expect(page.getByTestId('status-emoji-grid')).toBeVisible()
    await shot(page, '1440-light-status-picker.png')
  })
  test.describe('390', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    test('390: the long-press strip and the picker sheet (light, dark)', async ({ page }) => {
      fs.mkdirSync(process.env.SHOTS_DIR!, { recursive: true })
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await routeRoom(page, { members: [SORA, DAN], messages: MESSAGES })
      await signIn(page)
      await page.goto(`/rooms/${ROOM_ID}`)
      await longPress(page, page.getByTestId('room-message').nth(0))
      await shot(page, '390-light-strip.png')
      await page.getByRole('menu').getByTestId('reaction-more').click()
      await expect(page.getByTestId('emoji-sheet')).toBeVisible()
      await shot(page, '390-light-sheet.png')
      await page.getByTestId('emoji-search').fill('cry')
      await shot(page, '390-light-sheet-search.png')
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
      await page.getByTestId('emoji-search').fill('')
      await shot(page, '390-dark-sheet.png')
      // the status dialog's picker, from the drawer's row
      await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
      await page.goto('/')
      await page.getByTestId('menu-open').click()
      await page.locator('[data-drawer]').getByTestId('my-status-row').click()
      await page.getByTestId('status-emoji-button').click()
      await expect(page.getByTestId('status-emoji-grid')).toBeVisible()
      await shot(page, '390-light-status-picker.png')
    })
  })
})
