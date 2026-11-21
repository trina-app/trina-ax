// QA TC-6923: a thread beside the room closes with Esc (it did not: Esc only worked where the thread covers the room),
// and closing it from a room opened at a message (?m=) puts the ?m= away, so a reload does not jump back to it. Back
// still works as before: the thread is one step forward from the room.
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } })

const SORA = { id: 'sora', name: '소라님' }
const BEN = { id: 'ben', name: '벤' }
const id = (n: number) => `019a5f00-0000-7000-8000-0000000004${String(n).padStart(2, '0')}`
const ROOT = id(1)

async function open(page: Page) {
  await reset(page)
  await routeRoom(page, {
    members: [SORA, BEN],
    messages: [
      { id: ROOT, author: SORA, body: '이번 주 시안 검토 일정 공유드려요.', extra: { thread: { replyCount: 1, lastReplyAt: '2026-11-05T09:03:00.000Z', repliers: [BEN], newReplies: false } } },
      { id: id(2), author: BEN, body: '두 번째 안이 좋아 보여요.', threadRootId: ROOT },
      { id: id(3), author: BEN, body: '다음 주 회의는 화요일 오전으로 옮길게요.' },
    ],
  })
  await signIn(page)
  await page.goto(`/rooms/${ROOM_ID}?m=${ROOT}`)
  const root = page.getByTestId('room-message').filter({ hasText: '이번 주 시안' })
  await root.getByTestId('room-thread-line').click()
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}/t/${ROOT}$`))
  await expect(page.getByTestId('room-thread').getByTestId('room-message').first()).toBeVisible()
}

test('Esc closes the thread beside the room, and the room address no longer names the message', async ({ page }) => {
  await open(page)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('room-thread')).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}$`))
  // Forward is still the thread
  await page.goForward()
  await expect(page.getByTestId('room-thread')).toBeVisible()
})

test('Esc pressed twice quickly closes the thread once: the room stays, no step past it', async ({ page }) => {
  await open(page)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('room-thread')).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}$`))
  await page.waitForTimeout(500)
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}$`))
})

test('Esc while typing in the room box leaves the thread open; in the thread box it closes it', async ({ page }) => {
  await open(page)
  await page.getByTestId('room-input').first().focus()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('room-thread')).toBeVisible()
  await page.getByTestId('room-thread').getByTestId('room-input').focus()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('room-thread')).toHaveCount(0)
})

test('✕ closes it the same way: no ?m= left behind', async ({ page }) => {
  await open(page)
  await page.getByTestId('room-thread').getByTestId('thread-close').click()
  await expect(page.getByTestId('room-thread')).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}$`))
})
