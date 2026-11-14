// Message links in the browser (docs/DECISIONS.md "Message links and their previews"): Copy link in a message's ⋮ menu
// and the phone's long-press sheet copies the message's address on the team address; a link the server gave a preview
// for is a chip with the place's name and a card under the words, and a click opens the message in the app, marked; a
// link without one stays the plain link; the sender removes a card with its ✕; the box asks about a link some people
// here cannot see, Only show link chosen, and Show message shows the card first and goes with the send. The room is
// answered through page.route (rooms-mock.ts), the previews as the server would decide them.
// SHOTS_DIR=<folder>: the room with a chip and cards, and the box's choice, 1440 and 390, light and dark.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

test.use({ serviceWorkers: 'block' })

const SORA = { id: 'sora', name: '소라님' }
const OLGA = { id: 'olga', name: 'Olga' }
const TEAM = 'https://acme.example'
const OTHER_ROOM = '019a5f00-0000-7000-8000-00000000b001'
const id = (n: number) => `019a5f00-0000-7000-8000-0000000002${String(n).padStart(2, '0')}`
const T = '2026-11-05T09:00:00.000Z'
const preview = (messageId: string, o: Record<string, unknown> = {}) => ({
  roomId: OTHER_ROOM, messageId, rootId: null, place: { kind: 'team', name: 'design', peers: [] }, author: SORA, authorKind: 'user',
  mentions: [], createdAt: T, editedAt: null, deleted: false, body: '브리프 초안 올렸어요. **금요일**까지 봐 주세요.', files: { count: 2, first: { name: 'brief.pdf', kind: 'pdf' } }, ...o,
})
const link = (messageId: string, room = OTHER_ROOM) => `${TEAM}/rooms/${room}?m=${messageId}`
const shots = process.env.SHOTS_DIR

async function openRoom(page: Page, o: { audience?: Record<string, unknown>[] } = {}) {
  await reset(page)
  await page.request.post('/__test/team-address', { headers: { [CSRF_HEADER]: '1' }, data: { address: TEAM } })
  const room = await routeRoom(page, {
    members: [SORA],
    audience: o.audience,
    messages: [
      { id: id(1), author: SORA, body: '여기 원본 메시지예요' },
      // mine, with two cards: a live one and a snapshot shown to me ("Show message")
      { id: id(2), author: OLGA, body: `이거 봐 주세요 ${link(id(91))}\n그리고 ${link(id(92))}`, extra: { linkPreviews: [preview(id(91)), preview(id(92), { place: { kind: 'dm', name: null, peers: [] }, body: '1:1에서 한 얘기', files: { count: 0 }, sharedBy: SORA })] } },
      // someone else's link I may not see: no preview from the server, a plain link
      { id: id(3), author: SORA, body: `몰래 ${link(id(93))}` },
      // a link to a message of this room
      { id: id(4), author: SORA, body: `위 메시지 ${link(id(1), ROOM_ID)}`, extra: { linkPreviews: [preview(id(1), { roomId: ROOM_ID, place: { kind: 'group', name: '디자인 리뷰', peers: [OLGA] }, body: '여기 원본 메시지예요', files: { count: 0 } })] } },
    ],
  })
  await signIn(page)
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-message')).toHaveCount(4)
  return room
}

async function shoot(page: Page, name: string) {
  if (!shots) return
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.screenshot({ path: `${shots}/${name}-${scheme}.png` })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

test('chips and cards from the server; a plain link without a preview; a click opens the message, marked', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openRoom(page)
  const mine = page.getByTestId('room-message').nth(1)
  await expect(mine.getByTestId('message-link-chip')).toHaveCount(2)
  await expect(mine.getByTestId('message-link-chip').first()).toHaveText('#design')
  await expect(mine.getByTestId('message-link-card')).toHaveCount(2)
  await expect(mine.getByTestId('message-link-card').first()).toContainText('브리프 초안 올렸어요.')
  await expect(mine.getByTestId('message-link-card-files').first()).toContainText('brief.pdf')
  // the snapshot: the DM by its kind only, who shared it
  await expect(mine.getByTestId('message-link-chip').nth(1)).not.toHaveText(/소라/)
  await expect(mine.getByTestId('message-link-card-shared-by')).toHaveCount(1)
  // no preview: the address as it was
  const other = page.getByTestId('room-message').nth(2)
  await expect(other.getByTestId('message-link-chip')).toHaveCount(0)
  await expect(other.getByTestId('message-link-card')).toHaveCount(0)
  await expect(other.getByTestId('room-link')).toHaveText(link(id(93)))
  // no horizontal scroll at 1440; the card is no wider than its maximum
  const w = await mine.getByTestId('message-link-card').first().evaluate((e) => e.getBoundingClientRect().width)
  expect(w).toBeLessThanOrEqual(577)
  await shoot(page, 'message-links-1440')
  // a click on the card of a message of this room: the room at it, marked
  await page.getByTestId('room-message').nth(3).getByTestId('message-link-card-open').click()
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}\\?m=${id(1)}$`))
  await expect(page.getByTestId('room-message').first()).toHaveAttribute('data-highlight', '')
  // the chip opens the app's path of a link on the team address (this page runs elsewhere)
  await expect(mine.getByTestId('message-link-chip').first()).toHaveAttribute('href', `/rooms/${OTHER_ROOM}?m=${id(91)}`)
})

test('Copy link copies the message on the team address; the sender removes a card for everyone', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.setViewportSize({ width: 1440, height: 900 })
  const room = await openRoom(page)
  const first = page.getByTestId('room-message').first()
  await first.hover()
  await first.getByTestId('message-more').click()
  await page.getByTestId('message-copy-link').click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${TEAM}/rooms/${ROOM_ID}?m=${id(1)}`)
  // remove: the hover ✕ on my own message's card
  const mine = page.getByTestId('room-message').nth(1)
  await mine.getByTestId('message-link-card').first().hover()
  await mine.getByTestId('message-link-card-remove').first().click()
  await expect(mine.getByTestId('message-link-card')).toHaveCount(1)
  expect(room.hidden).toEqual([{ messageId: id(2), linkedMessageId: id(91) }])
  // the chip stays; no "(edited)"
  await expect(mine.getByTestId('message-link-chip')).toHaveCount(2)
  await expect(mine.getByText('(수정됨)')).toHaveCount(0)
  // someone else's card has no ✕
  await page.getByTestId('room-message').nth(3).getByTestId('message-link-card').hover()
  await expect(page.getByTestId('room-message').nth(3).getByTestId('message-link-card-remove')).toHaveCount(0)
})

test('the box asks about a link some here cannot see: Only show link by default, Show message shows the card and goes with the send', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const target = id(95)
  const room = await openRoom(page, { audience: [{ messageId: target, someoneCannotSee: true, snapshotAllowed: true, preview: preview(target, { place: { kind: 'dm', name: null, peers: [] }, body: '우리끼리 얘기', files: { count: 0 }, sharedBy: OLGA }) }] })
  const box = page.getByTestId('room-input')
  await box.fill(`이거요 ${link(target)}`)
  await expect(page.getByTestId('message-link-choice-line')).toBeVisible()
  expect(room.asked.at(-1)).toEqual({ links: [{ roomId: OTHER_ROOM, messageId: target }] })
  await expect(page.getByTestId('message-link-only')).toHaveAttribute('aria-pressed', 'true')
  await shoot(page, 'message-links-choice-1440')
  // send without touching it: only the link goes
  await box.press('Enter')
  await expect.poll(() => room.sent.length).toBe(1)
  expect(room.sent[0]!.showMessages).toBeUndefined()
  // again, with Show message: the card shows first (as it will be stored), and the send asks for it
  await box.fill(`다시 ${link(target)}`)
  await page.getByTestId('message-link-show').click()
  await expect(page.getByTestId('message-link-choice-card')).toContainText('우리끼리 얘기')
  await shoot(page, 'message-links-show-1440')
  await box.press('Enter')
  await expect.poll(() => room.sent.length).toBe(2)
  expect(room.sent[1]!.showMessages).toEqual([target])
  // a link into this room asks nothing
  const before = room.asked.length
  await box.fill(`여기 ${link(id(1), ROOM_ID)}`)
  await page.waitForTimeout(700)
  expect(room.asked.length).toBe(before)
  await expect(page.getByTestId('message-link-choice')).toHaveCount(0)
})

test.describe('a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('Copy link in the long-press sheet; the card fits the message without a sideways scroll', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await openRoom(page)
    const mine = page.getByTestId('room-message').nth(1)
    await expect(mine.getByTestId('message-link-card').first()).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const box = await mine.getByTestId('message-link-card').first().boundingBox()
    expect(box!.x + box!.width).toBeLessThanOrEqual(390)
    // the place line drops the conversation's name first on a phone
    await expect(mine.getByTestId('message-link-card-place').first()).toBeHidden()
    await shoot(page, 'message-links-390')
    // the long-press sheet's Copy link
    const first = page.getByTestId('room-message').first()
    await first.dispatchEvent('pointerdown', { button: 0, pointerType: 'touch', isPrimary: true, clientX: 100, clientY: 100 })
    await page.waitForTimeout(650)
    await first.dispatchEvent('pointerup', { button: 0, pointerType: 'touch', isPrimary: true, clientX: 100, clientY: 100 })
    await expect(page.getByRole('menu')).toBeVisible()
    await page.waitForTimeout(450)
    await page.getByRole('menu').getByTestId('message-copy-link').click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${TEAM}/rooms/${ROOM_ID}?m=${id(1)}`)
  })
})
