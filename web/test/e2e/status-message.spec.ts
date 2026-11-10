// Status messages in the browser (docs/DECISIONS.md "상태 메시지"; components/StatusMessage.tsx): set one from a
// suggestion in "Set your status" (the account menu), see its emoji after my name in the sidebar and on my messages, its
// words on hover, clear it; someone's status that ends disappears by the page's own clock; the DM's line above the box;
// leave with chosen days (a later first day shows nothing to the team yet); the member list and the @ list; the phone's
// drawer row and sheet. The mock (test/mock/server.ts) works statuses out by the server's own rules
// (server/src/auth/status-plan.ts), whose audience and validation tests/unit/b-status-message.test.ts checks. With
// SHOTS_DIR set, the last tests save the screens for review (1440 and 390, light and dark).
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { routeRoom, routeRooms, type MockRoomSpec } from './rooms-mock'

test.use({ serviceWorkers: 'block' })

const BOB = { id: 'bob', name: 'Bob' }
const DANA = { id: 'dana', name: 'Dana' }
const EVE = { id: 'eve', name: 'Eve' }
const rid = (n: number) => `019a5f00-0000-7000-8000-0000000e${String(n).padStart(4, '0')}`
const DM = rid(1)
const ROOMS: MockRoomSpec[] = [
  { id: DM, kind: 'dm', name: null, peers: [BOB], ago: 2, last: 'Is the review at 10 tomorrow?' },
  { id: rid(2), kind: 'group', name: null, peers: [DANA, EVE], ago: 6, last: 'Sent the draft' },
]
/** "YYYY-MM-DD", `n` days from today in Seoul (the mock team's zone) */
const seoulDay = (n = 0) => new Date(Date.now() + 9 * 3600_000 + n * 86_400_000).toISOString().slice(0, 10)

async function status(page: Page, user: string, body: Record<string, unknown> | null, raw?: Record<string, unknown>) {
  const r = await page.request.post('/__test/status', { data: { user, status: body, ...(raw ? { raw } : {}) } })
  expect(r.ok()).toBeTruthy()
}
const sidebarRow = (page: Page, name: string) => page.getByTestId('sidebar-room-row').filter({ hasText: name })
async function openDialog(page: Page) {
  await page.getByTestId('account-menu').click()
  await page.getByTestId('account-status').click()
  await expect(page.getByTestId('status-dialog')).toBeVisible()
}

test('a suggestion: my emoji in the sidebar and on my messages, the words on hover, then cleared', async ({ page }) => {
  await reset(page, { withAdmin: true })
  await routeRoom(page, { kind: 'all', members: [BOB, DANA], messages: [
    { id: '019a5f00-0000-7000-8000-00000000b001', author: { id: 'olga', name: 'Olga' }, body: '오늘 리뷰는 3시에 해요' },
    { id: '019a5f00-0000-7000-8000-00000000b002', author: BOB, body: '좋아요' },
  ] })
  await signIn(page)
  await expect(page.getByTestId('account-menu').getByTestId('status-emoji')).toHaveCount(0)
  await openDialog(page)
  const dialog = page.getByRole('dialog', { name: '상태 설정' })
  // five suggestions, each with when it clears
  await expect(dialog.getByTestId('status-suggestion')).toHaveText(['📅회의 중 — 1시간', '🎧집중하는 중 — 2시간', '🍽️점심 식사 중 — 1시간', '🤒병가 — 오늘', '🏖️휴가 중 — 날짜 고르기'])
  await expect(dialog.getByTestId('status-save')).toBeDisabled()
  await dialog.getByTestId('status-suggestion').first().click()
  await expect(dialog.getByTestId('status-text')).toHaveValue('회의 중')
  await expect(dialog.getByTestId('status-emoji-button')).toHaveText('📅')
  // the suggestions give way to "지우는 때", the suggestion's choice picked
  await expect(dialog.getByTestId('status-suggestions')).toHaveCount(0)
  await expect(dialog.getByTestId('status-clear-1h')).toHaveAttribute('aria-checked', 'true')
  await dialog.getByTestId('status-save').click()
  await expect(dialog).toHaveCount(0)

  // my account row: the emoji after my name; my menu's item says it
  const mine = page.getByTestId('account-menu').getByTestId('status-emoji')
  await expect(mine).toHaveText('📅')
  // the room: my author line has it, Bob's has none
  await page.goto(`/rooms/019a5f00-0000-7000-8000-00000000a001`)
  const runs = page.getByTestId('room-run')
  await expect(runs).toHaveCount(2)
  await expect(runs.nth(0).getByTestId('status-emoji')).toHaveText('📅')
  await expect(runs.nth(1).getByTestId('status-emoji')).toHaveCount(0)
  // a mouse on it: the words and when it ends
  await runs.nth(0).getByTestId('status-emoji').hover()
  await expect(page.getByRole('tooltip')).toHaveText(/^회의 중 · (오전|오후) \d{1,2}:\d\d까지$/)
  await page.mouse.move(700, 500)
  // others see it after a reload too (the directory)
  await page.reload()
  await expect(page.getByTestId('room-run').nth(0).getByTestId('status-emoji')).toHaveText('📅')

  // a click on my own emoji opens the dialog with it; "상태 지우기" takes it away everywhere
  await page.getByTestId('account-menu').getByTestId('status-emoji').click()
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId('status-text')).toHaveValue('회의 중')
  await expect(dialog.getByTestId('status-clear-keep')).toHaveAttribute('aria-checked', 'true')
  await dialog.getByTestId('status-clear').click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('account-menu').getByTestId('status-emoji')).toHaveCount(0)
  await expect(page.getByTestId('room-run').nth(0).getByTestId('status-emoji')).toHaveCount(0)
})

test('my own words, an emoji from the grid; Esc closes the dialog without saving', async ({ page }) => {
  await reset(page)
  await routeRooms(page, ROOMS)
  await signIn(page)
  await openDialog(page)
  const dialog = page.getByTestId('status-dialog')
  await dialog.getByTestId('status-text').fill('Reviewing designs')
  await dialog.getByTestId('status-emoji-button').click()
  await dialog.getByTestId('status-emoji-grid').getByRole('button', { name: '🎤' }).click()
  await expect(dialog.getByTestId('status-emoji-button')).toHaveText('🎤')
  // "오늘" until changed
  await expect(page.getByTestId('status-clear-today')).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('account-menu').getByTestId('status-emoji')).toHaveCount(0)
  // again, saved with "지우지 않음"
  await openDialog(page)
  await page.getByTestId('status-text').fill('<b>Reviewing</b>')
  await page.getByTestId('status-clear-never').click()
  await page.getByTestId('status-save').click()
  // no emoji picked: 💬; the words are text, never markup
  await expect(page.getByTestId('account-menu').getByTestId('status-emoji')).toHaveText('💬')
  await page.getByTestId('account-menu').getByTestId('status-emoji').hover()
  await expect(page.getByRole('tooltip')).toHaveText('<b>Reviewing</b>')
})

test('someone\'s status that ends goes away by the page\'s own clock; the DM\'s line; the member list and the @ list', async ({ page }) => {
  await reset(page)
  await routeRooms(page, ROOMS)
  await signIn(page)
  const row = sidebarRow(page, 'Bob')
  await status(page, 'bob', null, { emoji: '📅', text: '회의 중', clear: '30m', starts_at: null, clears_at: new Date(Date.now() + 4000).toISOString(), until_day: null })
  await expect(row.getByTestId('status-emoji')).toHaveText('📅')
  // the row reads "Bob, 상태: 회의 중 · …까지"
  await expect(row.getByTestId('sidebar-room')).toHaveAccessibleName(/Bob ?, 상태: 회의 중 · .+까지/)
  // no notice comes: the page hides it when it ends
  await expect(row.getByTestId('status-emoji')).toHaveCount(0, { timeout: 8000 })

  // leave with chosen days: the DM's line above the box
  await status(page, 'bob', { emoji: '🏖️', text: '휴가 중', clear: 'dates', to: seoulDay(4) })
  await expect(row.getByTestId('status-emoji')).toHaveText('🏖️')
  await row.getByTestId('sidebar-room').click()
  const line = page.getByTestId('room-status-line')
  await expect(line).toHaveText(/^🏖️Bob 님: 휴가 중 · \d{1,2}월 \d{1,2}일까지$/)
  // cleared: the line goes
  await status(page, 'bob', null)
  await expect(line).toHaveCount(0)
})

test('the member list (a tap shows the words) and the @ list', async ({ page }) => {
  await reset(page)
  await routeRoom(page, { members: [BOB], messages: [{ id: '019a5f00-0000-7000-8000-00000000b011', author: BOB, body: 'Hi' }] })
  await signIn(page)
  await status(page, 'bob', { emoji: '🤒', text: '병가', clear: 'today' })
  await page.goto('/rooms/019a5f00-0000-7000-8000-00000000a001')
  await page.getByTestId('room-members-button').click()
  const member = page.getByTestId('room-member').filter({ hasText: 'Bob' })
  await member.getByTestId('status-emoji').click()
  await expect(page.getByTestId('status-tip')).toHaveText('병가 · 오늘까지')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  const box = page.getByTestId('room-composer').locator('textarea')
  await box.fill('@Bo')
  await expect(page.getByTestId('mention-option').filter({ hasText: 'Bob' }).getByTestId('status-emoji')).toHaveText('🤒')
})

test('leave with chosen days: a later first day shows nothing yet; the dates come back in the dialog', async ({ page }) => {
  await reset(page)
  await routeRooms(page, ROOMS)
  await signIn(page)
  await openDialog(page)
  await page.getByTestId('status-suggestion').filter({ hasText: '휴가 중' }).click()
  await expect(page.getByTestId('status-clear-dates')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('status-dates')).toBeVisible()
  await page.getByTestId('status-from').fill(seoulDay(2))
  await page.getByTestId('status-to').fill(seoulDay(5))
  await expect(page.getByTestId('status-later')).toHaveText(/부터 팀에 보여요/)
  await page.getByTestId('status-save').click()
  await expect(page.getByTestId('status-dialog')).toHaveCount(0)
  // not yet: no emoji after my name
  await expect(page.getByTestId('account-menu').getByTestId('status-emoji')).toHaveCount(0)
  // the menu's item says when it starts; the dialog has the days
  await page.getByTestId('account-menu').click()
  await expect(page.getByTestId('account-status')).toHaveText(/휴가 중/)
  await page.getByTestId('account-status').click()
  await expect(page.getByTestId('status-from')).toHaveValue(seoulDay(2))
  await expect(page.getByTestId('status-to')).toHaveValue(seoulDay(5))
  await expect(page.getByTestId('status-clear-dates')).toHaveAttribute('aria-checked', 'true')
})

test.describe('a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('the drawer\'s row opens the sheet; my status shows there', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await page.getByTestId('menu-open').click()
    const row = page.locator('[data-drawer]').getByTestId('my-status-row')
    await expect(row).toHaveText('상태 설정')
    await row.click()
    await page.getByTestId('status-suggestion').filter({ hasText: '집중하는 중' }).click()
    await page.getByTestId('status-save').click()
    await expect(page.getByTestId('status-dialog')).toHaveCount(0)
    await page.getByTestId('menu-open').click()
    await expect(page.locator('[data-drawer]').getByTestId('my-status-row')).toHaveText(/^🎧집중하는 중 · (오전|오후) \d{1,2}:\d\d까지$/)
  })
})

// ---------------- screenshots for review (SHOTS_DIR) ----------------
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(process.env.SHOTS_DIR!, name) })

test.describe('screens for review', () => {
  test.skip(!process.env.SHOTS_DIR, 'SHOTS_DIR not set')
  test('1440: the dialog (light), leave dates (dark), a room with authors\' emoji and a hover, a DM with its line', async ({ page }) => {
    fs.mkdirSync(process.env.SHOTS_DIR!, { recursive: true })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
    await reset(page, { withAdmin: true, teamLocale: 'en', usersFollowTeam: true })
    await routeRooms(page, ROOMS)
    await signIn(page)
    await openDialog(page)
    await shot(page, 'status-1440-light-dialog.png')
    await page.getByTestId('status-suggestion').filter({ hasText: 'On leave' }).click()
    await page.getByTestId('status-from').fill(seoulDay(3))
    await page.getByTestId('status-to').fill(seoulDay(7))
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    await shot(page, 'status-1440-dark-dialog-dates.png')
    await page.keyboard.press('Escape')
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })

    // the DM with Bob on leave
    await status(page, 'bob', { emoji: '🏖️', text: 'On leave', clear: 'dates', to: seoulDay(4) })
    await sidebarRow(page, 'Bob').getByTestId('sidebar-room').click()
    await expect(page.getByTestId('room-status-line')).toBeVisible()
    await shot(page, 'status-1440-light-dm-line.png')
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    await shot(page, 'status-1440-dark-dm-line.png')
    // the emoji is as large as the name it follows; the DM line is the size of the notes around the box
    const size = async (sel: string) => page.locator(sel).first().evaluate((e) => getComputedStyle(e).fontSize)
    const sizes = {
      sidebarName: await size('[data-testid="sidebar-room-row"] .truncate'),
      sidebarEmoji: await size('[data-testid="sidebar-room-row"] [data-testid="status-emoji"]'),
      authorName: await size('[data-testid="room-run"] p > span.truncate'),
      authorEmoji: await size('[data-testid="room-run"] [data-testid="status-emoji"]'),
      dmLine: await size('[data-testid="room-status-line"]'),
      composer: await size('[data-testid="room-composer"] textarea'),
    }
    fs.writeFileSync(path.join(process.env.SHOTS_DIR!, 'status-sizes-1440.json'), JSON.stringify(sizes, null, 2))
    expect(sizes.sidebarEmoji).toBe(sizes.sidebarName)
    expect(sizes.authorEmoji).toBe(sizes.authorName)
  })

  test('1440: a room where authors show their emoji, and a hover', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
    await reset(page, { withAdmin: true, teamLocale: 'en', usersFollowTeam: true })
    await routeRoom(page, { kind: 'all', members: [BOB, DANA, EVE], messages: [
      { id: '019a5f00-0000-7000-8000-00000000b021', author: DANA, body: 'The launch deck is in the team folder.' },
      { id: '019a5f00-0000-7000-8000-00000000b022', author: BOB, body: 'Thanks! I will look at it next week.' },
      { id: '019a5f00-0000-7000-8000-00000000b023', author: EVE, body: 'Can we move the review to 4 PM?' },
      { id: '019a5f00-0000-7000-8000-00000000b024', author: { id: 'olga', name: 'Olga' }, body: 'Sure, 4 PM works.' },
    ] })
    await signIn(page)
    await status(page, 'bob', { emoji: '🏖️', text: 'On leave', clear: 'dates', to: seoulDay(4) })
    await status(page, 'dana', { emoji: '📅', text: 'In a meeting', clear: '1h' })
    await status(page, 'olga', { emoji: '🎧', text: 'Focusing', clear: '2h' })
    await page.goto('/rooms/019a5f00-0000-7000-8000-00000000a001')
    await expect(page.getByTestId('room-run')).toHaveCount(4)
    await page.getByTestId('room-run').nth(1).getByTestId('status-emoji').hover()
    await expect(page.getByRole('tooltip')).toBeVisible()
    await shot(page, 'status-1440-light-room-hover.png')
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    await shot(page, 'status-1440-dark-room-hover.png')
    await page.getByTestId('room-members-button').click()
    await shot(page, 'status-1440-dark-members.png')
  })

  test.describe('390', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    test('the sheet and the drawer with my status', async ({ page }) => {
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await signIn(page)
      await page.getByTestId('menu-open').click()
      await page.locator('[data-drawer]').getByTestId('my-status-row').click()
      await expect(page.getByTestId('status-dialog')).toBeVisible()
      await shot(page, 'status-390-light-dialog.png')
      await page.getByTestId('status-suggestion').filter({ hasText: 'Out sick' }).click()
      await shot(page, 'status-390-light-dialog-filled.png')
      await page.getByTestId('status-save').click()
      await expect(page.getByTestId('status-dialog')).toHaveCount(0)
      await page.getByTestId('menu-open').click()
      await expect(page.locator('[data-drawer]').getByTestId('my-status-row')).toContainText('Out sick')
      await shot(page, 'status-390-light-drawer.png')
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
      await shot(page, 'status-390-dark-drawer.png')
      await page.locator('[data-drawer]').getByTestId('my-status-row').click()
      await shot(page, 'status-390-dark-dialog-filled.png')
    })
  })
})
