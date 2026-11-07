// "@전체" in a room's message box, in the browser (docs/DECISIONS.md "@전체"; components/rooms/useMentionMenu.tsx,
// RoomComposer.tsx): the row right under the AI with how many it notifies, picked it is a token in the accent colour and
// the message goes with mentionsAll, the sent message shows it as a mention; a room of 10 or more asks first in one line
// inside the box; the everyone room offers it to owners and admins only. The room is answered through page.route
// (rooms-mock.ts).
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

// the room's answers come through page.route, which does not see what the app's service worker fetches
test.use({ serviceWorkers: 'block' })

const few = [{ id: 'minjae', name: 'Minjaelee' }, { id: 'sora', name: '소라님' }, { id: 'bart', name: 'Bartholomew' }]
const many = Array.from({ length: 11 }, (_, i) => ({ id: `p${i + 1}`, name: `사람${i + 1}` }))

async function openRoom(page: Page, o: Parameters<typeof routeRoom>[1], who?: Parameters<typeof signIn>[1]) {
  await reset(page)
  const room = await routeRoom(page, o)
  await signIn(page, who)
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-input')).toBeVisible()
  return room
}
const rows = (page: Page) => page.getByTestId('mention-option')

test('the row under the AI, a token once picked, sent with mentionsAll and shown as a mention', async ({ page }) => {
  const room = await openRoom(page, { members: few })
  const box = page.getByTestId('room-input')
  await box.click()
  await page.keyboard.type('@')
  await expect(rows(page)).toHaveCount(5)
  await expect(rows(page).nth(0)).toHaveAttribute('data-ai', '')
  await expect(rows(page).nth(1)).toHaveAttribute('data-all', '')
  await expect(rows(page).nth(1)).toContainText('전체')
  await expect(rows(page).nth(1)).toContainText('이 방의 3명에게 알림')
  // Slack's word finds it too
  await page.keyboard.type('chan')
  await expect(rows(page)).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(box).toHaveValue('@전체 ')
  await expect(page.getByTestId('room-composer').getByTestId('token-layer').locator('[data-token="all"]')).toHaveText('@전체')
  await page.keyboard.type('3시에 회의해요')
  await page.keyboard.press('Enter')
  await expect.poll(() => room.sent.length).toBe(1)
  expect(room.sent[0]).toMatchObject({ body: '@전체 3시에 회의해요', mentions: [], mentionsAll: true })
  await expect(page.getByTestId('room-message').last().locator('[data-mention="all"]')).toHaveText('@전체')
  // pasted, it is text: no flag
  await page.evaluate(() => navigator.clipboard.writeText('@전체 붙여 넣은 글'))
  await page.keyboard.press('ControlOrMeta+V')
  await expect(page.getByTestId('room-composer').getByTestId('token-layer').locator('[data-token]')).toHaveCount(0)
  await page.keyboard.press('Enter')
  await expect.poll(() => room.sent.length).toBe(2)
  expect(room.sent[1]!.mentionsAll).toBeUndefined()
})

test('10 people or more: one line in the box asks first; 취소 keeps the text, 보내기 sends', async ({ page }) => {
  const room = await openRoom(page, { members: many })
  const box = page.getByTestId('room-input')
  await box.click()
  await page.keyboard.type('@전체')
  await expect(rows(page).first()).toHaveAttribute('data-all', '')
  await page.keyboard.press('Enter')
  await page.keyboard.type('공지')
  await page.keyboard.press('Enter')
  const ask = page.getByTestId('room-mention-all-confirm')
  await expect(ask).toContainText('11명에게 알림이 가요. 보낼까요?')
  expect(room.sent).toEqual([])
  await page.getByTestId('room-mention-all-cancel').click()
  await expect(ask).toHaveCount(0)
  await expect(box).toHaveValue('@전체 공지')
  await page.getByTestId('room-send').click()
  await page.getByTestId('room-mention-all-send').click()
  await expect.poll(() => room.sent.length).toBe(1)
  expect(room.sent[0]).toMatchObject({ body: '@전체 공지', mentionsAll: true })
  await expect(ask).toHaveCount(0)
})

test('the everyone room: the owner gets the row, a member does not', async ({ page }) => {
  await openRoom(page, { members: few, kind: 'all' })
  await page.getByTestId('room-input').click()
  await page.keyboard.type('@')
  await expect(rows(page).nth(1)).toHaveAttribute('data-all', '')
  await page.context().clearCookies()
  await openRoom(page, { members: few, kind: 'all' }, { username: 'bob', password: 'bob password 1' })
  await page.getByTestId('room-input').click()
  await page.keyboard.type('@')
  await expect(rows(page).first()).toHaveAttribute('data-ai', '')
  await expect(page.locator('[data-testid="mention-option"][data-all]')).toHaveCount(0)
})
