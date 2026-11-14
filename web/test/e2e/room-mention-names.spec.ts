// "@" and a name of two words in a room's message box (QA M7, guest UX audit; web/src/lib/rooms.ts mentionAt,
// components/rooms/useMentionMenu.tsx): the list stays open after the space while a name still fits, Enter picks the
// name and the message mentions them; a whole name and a space after it ends the list, so Enter sends. A guest's box
// works the same way (the server keeps only mentions of people in the room: their one place). The room is answered
// through page.route (rooms-mock.ts).
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

test.use({ serviceWorkers: 'block' })

const members = [{ id: 'qam', name: 'QA Member' }, { id: 'qam2', name: 'QA Member Two' }, { id: 'bob', name: 'Bob' }]
const rows = (page: Page) => page.getByTestId('mention-option')

async function typeAndSend(page: Page, room: Awaited<ReturnType<typeof routeRoom>>) {
  const box = page.getByTestId('room-input')
  await box.click()
  await page.keyboard.type('Hello from the guest, @QA Mem')
  // past the space: the list is still there, the closest name first
  await expect(rows(page).first()).toContainText('QA Member')
  await expect(rows(page)).toHaveCount(2)
  await page.keyboard.type('ber')
  await page.keyboard.press('Enter')
  await expect(box).toHaveValue('Hello from the guest, @QA Member ')
  await expect(page.getByTestId('room-composer').getByTestId('token-layer').locator('[data-token="person"]')).toHaveText('@QA Member')
  await page.keyboard.press('Enter')
  await expect.poll(() => room.sent.length).toBe(1)
  expect(room.sent[0]).toMatchObject({ body: 'Hello from the guest, @QA Member', mentions: ['qam'] })
  // the sent message keeps every word, the name as a mention
  await expect(page.getByTestId('room-message').last()).toContainText('Hello from the guest, @QA Member')
}

test('a member: "@QA Mem" keeps the list after the space; Enter picks, the message mentions them', async ({ page }) => {
  await reset(page)
  const room = await routeRoom(page, { members })
  await signIn(page)
  await page.goto(`/rooms/${ROOM_ID}`)
  await typeAndSend(page, room)
  // a whole name typed out and a space after it: no list, Enter sends it as words
  const box = page.getByTestId('room-input')
  await page.keyboard.type('@Bob ')
  await expect(rows(page)).toHaveCount(0)
  await page.keyboard.type('thanks')
  await page.keyboard.press('Enter')
  await expect.poll(() => room.sent.length).toBe(2)
  expect(room.sent[1]).toMatchObject({ body: '@Bob thanks', mentions: [] })
  await expect(box).toHaveValue('')
})

test('a guest in the room: the same list and the same mention', async ({ page }) => {
  await reset(page)
  expect((await page.request.post('/__test/guest', { data: { id: 'gina', name: 'Gina', place: { kind: 'room', id: ROOM_ID }, ai: { mode: 'none' } } })).ok()).toBeTruthy()
  const room = await routeRoom(page, { members })
  await page.goto('/login')
  await page.getByTestId('login-username').fill('gina')
  await page.getByTestId('login-password').fill('gina password 1')
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('login-submit')).toHaveCount(0)
  await page.goto(`/rooms/${ROOM_ID}`)
  await typeAndSend(page, room)
})
