// Editing my own message in a room (components/rooms/RoomMessages.tsx, RoomComposer.tsx). On a phone the edit moves
// into the box at the bottom: the message being edited is marked in the list, the box says "Editing message" and has the
// whole text (it grows, then scrolls), ✕ and ✓ in the send button's place, no clip, mic or "Also send to the room"; ✕
// or Esc brings back the reply that was being written. On a computer the edit stays in the message: the field grows with
// the text and its buttons sit in their own row under it. The room is answered through page.route (rooms-mock.ts).
// SHOTS_DIR=<folder>: the edit at 1440 and 390, light and dark, goes there.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

test.use({ serviceWorkers: 'block' })

const SORA = { id: 'sora', name: '소라님' }
const OLGA = { id: 'olga', name: 'Olga' }
const id = (n: number) => `019a5f00-0000-7000-8000-0000000002${String(n).padStart(2, '0')}`
const LONG = [
  '내일 회의 전에 정리해 둘게요.',
  '1. 지난주 매출 보고서는 공유 폴더에 올려 두었어요.',
  '2. 견적서 양식이 바뀌어서 새 양식으로 다시 만들어야 해요.',
  '3. 고객사 미팅은 목요일 오후 3시로 옮겼습니다.',
  '확인 부탁드려요!',
].join('\n')

async function openRoom(page: Page, o: { thread?: boolean } = {}) {
  await reset(page)
  const room = await routeRoom(page, {
    members: [SORA],
    messages: [
      { id: id(1), author: SORA, body: '이번 주 일정 정리 부탁드려요', extra: o.thread ? { thread: { replyCount: 1, lastReplyAt: '2026-11-05T09:05:00.000Z', repliers: [OLGA], newReplies: false, following: true } } : {} },
      { id: id(2), author: OLGA, body: LONG, ...(o.thread ? { threadRootId: id(1) } : {}) },
      ...(o.thread ? [] : [{ id: id(3), author: SORA, body: '네 좋아요' }]),
    ],
  })
  await signIn(page)
  await page.goto(o.thread ? `/rooms/${ROOM_ID}/t/${id(1)}` : `/rooms/${ROOM_ID}`)
  await expect(page.locator('[data-testid="room-message"]:visible', { hasText: '확인 부탁드려요!' })).toBeVisible()
  return room
}

/** A long press with a finger on a message: its sheet. */
async function longPress(page: Page, target: Locator) {
  await target.dispatchEvent('pointerdown', { button: 0, pointerType: 'touch', isPrimary: true, clientX: 100, clientY: 100 })
  await page.waitForTimeout(650)
  await target.dispatchEvent('pointerup', { button: 0, pointerType: 'touch', isPrimary: true, clientX: 100, clientY: 100 })
  await expect(page.getByRole('menu')).toBeVisible()
  await page.waitForTimeout(450)
}

const mineIn = (scope: Page | Locator) => scope.getByTestId('room-message').filter({ hasText: '확인 부탁드려요!' }).last()

/** every line of the field is inside its box, and no button covers it */
async function noClipping(field: Locator, buttons: Locator[]) {
  const f = (await field.boundingBox())!
  // the field shows all of the text (it grew) or scrolls inside itself: never a line under something else
  for (const b of buttons) {
    const r = (await b.boundingBox())!
    const overlaps = r.y < f.y + f.height && r.y + r.height > f.y && r.x < f.x + f.width && r.x + r.width > f.x
    expect(overlaps, 'a button over the text').toBe(false)
  }
}

test.describe('a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('the edit moves into the box; ✕ brings the reply being written back', async ({ page }) => {
    await openRoom(page)
    const box = page.getByTestId('room-input')
    await box.fill('쓰던 답장')
    await longPress(page, mineIn(page))
    await page.getByRole('menu').getByTestId('message-edit').click()
    const composer = page.getByTestId('room-composer')
    await expect(composer).toHaveAttribute('data-editing', '')
    await expect(page.getByTestId('room-editing-label')).toBeVisible()
    await expect(box).toHaveValue(LONG)
    await expect(box).toBeFocused()
    // the caret at the end
    expect(await box.evaluate((e: HTMLTextAreaElement) => [e.selectionStart, e.selectionEnd])).toEqual([LONG.length, LONG.length])
    // the message is marked in the list and has no edit form of its own
    await expect(mineIn(page)).toHaveAttribute('data-editing', '')
    await expect(page.getByTestId('room-edit-input')).toHaveCount(0)
    // only the controls that apply: no clip, no mic, no send; ✕ and ✓ with their names
    await expect(page.getByTestId('room-attach')).toHaveCount(0)
    await expect(page.getByTestId('room-send')).toHaveCount(0)
    await expect(page.getByTestId('room-edit-cancel')).toHaveAccessibleName(/.+/)
    await expect(page.getByTestId('room-edit-save')).toHaveAccessibleName(/.+/)
    // unchanged: nothing to save
    await expect(page.getByTestId('room-edit-save')).toBeDisabled()
    // the box grew with the text up to its most (then it scrolls), the buttons beside the text, never over it
    const lines = await box.evaluate((e: HTMLTextAreaElement) => ({ scroll: e.scrollHeight, client: e.clientHeight, max: parseFloat(getComputedStyle(e).maxHeight) }))
    expect(lines.client).toBeGreaterThan(150)
    expect(lines.client).toBeGreaterThanOrEqual(Math.min(lines.scroll, lines.max) - 1)
    await noClipping(box, [page.getByTestId('room-edit-cancel'), page.getByTestId('room-edit-save')])
    // Return makes a new line on a phone
    await box.press('Enter')
    await expect(box).toHaveValue(`${LONG}\n`)
    await expect(composer).toHaveAttribute('data-editing', '')
    await page.getByTestId('room-edit-cancel').click()
    await expect(composer).not.toHaveAttribute('data-editing', '')
    await expect(box).toHaveValue('쓰던 답장')
    await expect(page.getByTestId('room-send')).toBeVisible()
    await expect(mineIn(page)).not.toHaveAttribute('data-editing', '')
    await expect(mineIn(page)).not.toContainText('(수정됨)')
  })

  test('✓ saves: the message changes and says (edited); an empty text cannot be saved', async ({ page }) => {
    await openRoom(page)
    await longPress(page, mineIn(page))
    await page.getByRole('menu').getByTestId('message-edit').click()
    const box = page.getByTestId('room-input')
    await box.fill('')
    await expect(page.getByTestId('room-edit-save')).toBeDisabled()
    await box.fill(`${LONG}\n추가로 한 줄 더`)
    await expect(page.getByTestId('room-edit-save')).toBeEnabled()
    await page.getByTestId('room-edit-save').click()
    await expect(page.getByTestId('room-composer')).not.toHaveAttribute('data-editing', '')
    await expect(box).toHaveValue('')
    const msg = page.getByTestId('room-message').filter({ hasText: '추가로 한 줄 더' })
    await expect(msg).toBeVisible()
    await expect(msg).toContainText('(수정됨)')
  })

  test('in a thread: no "Also send to the room" while editing; Esc cancels', async ({ page }) => {
    await openRoom(page, { thread: true })
    const thread = page.getByTestId('room-thread')
    await expect(mineIn(thread)).toBeVisible()
    await expect(thread.getByTestId('room-also-in-room')).toBeVisible()
    await longPress(page, mineIn(thread))
    await page.getByRole('menu').getByTestId('message-edit').click()
    await expect(thread.getByTestId('room-composer')).toHaveAttribute('data-editing', '')
    await expect(thread.getByTestId('room-input')).toHaveValue(LONG)
    await expect(thread.getByTestId('room-also-in-room')).toHaveCount(0)
    await thread.getByTestId('room-input').press('Escape')
    await expect(thread.getByTestId('room-composer')).not.toHaveAttribute('data-editing', '')
    await expect(thread.getByTestId('room-also-in-room')).toBeVisible()
  })
})

test.describe('a computer', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('the edit stays in the message: the field grows, the buttons sit under it', async ({ page }) => {
    await openRoom(page)
    await page.getByTestId('room-input').fill('쓰던 답장')
    const mine = mineIn(page)
    await mine.hover()
    await mine.getByTestId('message-more').click()
    await page.getByTestId('message-edit').click()
    const field = page.getByTestId('room-edit-input')
    await expect(field).toHaveValue(LONG)
    await expect(field).toBeFocused()
    // the bottom box keeps the reply being written
    await expect(page.getByTestId('room-input')).toHaveValue('쓰던 답장')
    const lines = await field.evaluate((e: HTMLTextAreaElement) => ({ scroll: e.scrollHeight, client: e.clientHeight }))
    expect(lines.scroll).toBeLessThanOrEqual(lines.client + 1)
    await noClipping(field, [page.getByTestId('room-edit-cancel'), page.getByTestId('room-edit-save')])
    const f = (await field.boundingBox())!
    const s = (await page.getByTestId('room-edit-save').boundingBox())!
    expect(s.y).toBeGreaterThanOrEqual(f.y + f.height)
    // Shift+Enter: a new line; the field grows with it
    await field.press('Shift+Enter')
    await field.pressSequentially('하나 더')
    const grown = (await field.boundingBox())!
    expect(grown.height).toBeGreaterThan(f.height)
    // Enter saves
    await field.press('Enter')
    await expect(page.getByTestId('room-edit-input')).toHaveCount(0)
    await expect(page.getByTestId('room-message').filter({ hasText: '하나 더' })).toContainText('(수정됨)')
    await expect(page.getByTestId('room-input')).toHaveValue('쓰던 답장')
  })

  test('Cancel and Esc leave the message as it was', async ({ page }) => {
    await openRoom(page)
    const mine = mineIn(page)
    await mine.hover()
    await mine.getByTestId('message-more').click()
    await page.getByTestId('message-edit').click()
    await page.getByTestId('room-edit-input').fill('바뀐 글')
    await page.getByTestId('room-edit-cancel').click()
    await expect(page.getByTestId('room-edit-input')).toHaveCount(0)
    await expect(mineIn(page)).not.toContainText('(수정됨)')
  })
})

test('screenshots of an edit (SHOTS_DIR)', async ({ browser }) => {
  const dir = process.env.SHOTS_DIR
  test.skip(!dir, 'only with SHOTS_DIR')
  for (const [width, height, phone] of [[1440, 900, false], [390, 844, true]] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      const ctx = await browser.newContext({ viewport: { width, height }, locale: 'ko-KR', colorScheme: scheme, serviceWorkers: 'block', ...(phone ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) })
      const page = await ctx.newPage()
      await openRoom(page, { thread: phone })
      const scope = phone ? page.getByTestId('room-thread') : page
      await scope.getByTestId('room-input').fill('쓰던 답장')
      const mine = mineIn(scope)
      if (phone) await longPress(page, mine)
      else {
        await mine.hover()
        await mine.getByTestId('message-more').click()
      }
      await page.getByRole('menu').getByTestId('message-edit').or(page.getByTestId('message-edit')).first().click()
      await page.waitForTimeout(400)
      await page.screenshot({ path: `${dir}/room-edit-${width}-${scheme}.png` })
      await ctx.close()
    }
  }
})
