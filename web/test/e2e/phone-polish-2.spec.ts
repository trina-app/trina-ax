// Phone polish 2 (QA TC-265), at 390×844 with touch:
// TRINA-24: the AI's question card has no text box of its own while the message box answers it: one place to type,
// one "no passwords" line, and the typed answer from the message box reaches the AI.
// CHATS-17: in a room's side chat a long press on a message opens its actions as a sheet, as in the room; no icons under
// the answer, the send-here button stays.
// SHOTS_DIR=<folder>: a screenshot of each.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' })

async function shot(page: Page, name: string) {
  if (!process.env.SHOTS_DIR) return
  fs.mkdirSync(process.env.SHOTS_DIR, { recursive: true })
  await page.screenshot({ path: path.join(process.env.SHOTS_DIR, name) })
}
/** a finger held on it for 600 ms */
async function longPress(page: Page, el: Locator) {
  const box = (await el.boundingBox())!
  const at = { pointerType: 'touch', isPrimary: true, clientX: box.x + 20, clientY: box.y + Math.min(10, box.height / 2), bubbles: true }
  await el.dispatchEvent('pointerdown', at)
  await page.waitForTimeout(650)
  await el.dispatchEvent('pointerup', at)
  await page.waitForTimeout(450)
}

test('TRINA-24: the ask card leaves typing to the message box; the typed answer reaches the AI', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.getByTestId('composer-input').fill('please ask me something')
  await page.getByTestId('send').click()
  const card = page.getByTestId('ask-card')
  await expect(card).toContainText('어느 분기를 볼까요?')
  await expect(card.getByTestId('ask-text')).toHaveCount(0)
  await expect(card.getByTestId('ask-in-box')).toHaveText('직접 답하려면 아래 메시지 칸에 입력하세요.')
  await expect(page.getByTestId('composer-answering')).toContainText('어느 분기를 볼까요?')
  // one secrets line on the page, the message box's
  await expect(page.getByText('비밀번호·인증 코드는 AI에게 알려 주지 마세요.')).toHaveCount(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await shot(page, 'trina24-ask-card-390.png')
  await page.getByTestId('composer-input').fill('작년 4분기')
  await page.getByTestId('send-answer').click()
  await expect(card).toHaveCount(0)
  await expect(page.getByTestId('assistant-message').last()).toContainText('You chose "작년 4분기"')
  await shot(page, 'trina24-answered-390.png')
})

test('CHATS-17: a side chat message opens its actions with a long press, as a room message does', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await routeRoom(page, { members: [{ id: 'ben', name: '벤' }], messages: [{ id: '019a5f00-0000-7000-8000-000000000001', author: { id: 'ben', name: '벤' }, body: '로고 시안 언제까지 받을 수 있을까요?' }] })
  await page.goto(`/rooms/${ROOM_ID}`)
  await page.getByTestId('room-side-chat-button').click()
  const side = page.getByTestId('room-side-chat')
  await side.getByTestId('side-chat-input').fill('한 줄로 정리해 줘')
  await side.getByTestId('side-chat-send').click()
  const answer = side.locator('[data-testid="assistant-message"][data-status="done"]')
  await expect(answer).toHaveCount(1, { timeout: 20_000 })
  // no icon row under the answer: copy, retry and the model wait for the long press; the send button is in sight
  for (const id of ['regenerate', 'answer-model']) {
    const b = answer.getByTestId(id)
    if (await b.count()) expect(await b.evaluate((e) => getComputedStyle(e.closest('[data-testid^="answer-actions-tap"], [data-testid="answer-model"]')!).clipPath)).toBe('inset(50%)')
  }
  await expect(answer.getByTestId('send-here-room')).toBeVisible()
  // a tap brings no icons
  await answer.locator('p').first().tap()
  expect(await answer.getByTestId('answer-actions-tap').evaluate((e) => getComputedStyle(e).clipPath)).toBe('inset(50%)')
  await shot(page, 'chats17-side-chat-390.png')
  await longPress(page, answer.locator('p').first())
  const sheet = page.getByRole('menu', { name: '메시지 메뉴' })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByRole('menuitem')).toHaveText(['답변 복사', '다시 생성'])
  const box = (await sheet.boundingBox())!
  expect(Math.round(box.width)).toBe(390)
  expect(Math.round(box.y + box.height)).toBe(844)
  await shot(page, 'chats17-answer-sheet-390.png')
  await sheet.getByRole('menuitem', { name: '답변 복사' }).click()
  await expect(sheet).toHaveCount(0)
  // my question: copy and edit
  await longPress(page, side.getByTestId('user-text').first())
  await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(['복사', '메시지 수정'])
  await shot(page, 'chats17-question-sheet-390.png')
  await page.getByRole('menuitem', { name: '메시지 수정' }).click()
  await expect(side.getByTestId('edit-input')).toBeVisible()
})

test('TRINA-24 in the side chat: the card leaves typing to the side chat box, which says not to type secrets and holds a key', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await routeRoom(page, { members: [{ id: 'ben', name: '벤' }], messages: [] })
  await page.goto(`/rooms/${ROOM_ID}`)
  await page.getByTestId('room-side-chat-button').click()
  const side = page.getByTestId('room-side-chat')
  await side.getByTestId('side-chat-input').fill('please ask me something')
  await side.getByTestId('side-chat-send').click()
  const card = side.getByTestId('ask-card')
  await expect(card).toContainText('어느 분기를 볼까요?', { timeout: 20_000 })
  await expect(card.getByTestId('ask-text')).toHaveCount(0)
  await expect(card.getByTestId('ask-in-box')).toBeVisible()
  await expect(side.getByTestId('side-chat-no-secrets')).toHaveText('비밀번호·인증 코드는 AI에게 알려 주지 마세요.')
  await expect(page.getByText('비밀번호·인증 코드는 AI에게 알려 주지 마세요.')).toHaveCount(1)
  await shot(page, 'trina24-side-chat-390.png')
  // a key-looking answer waits for "Send anyway"
  await side.getByTestId('side-chat-input').fill('ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8')
  await side.getByTestId('side-chat-send').click()
  await expect(side.getByTestId('secret-warning')).toBeVisible()
  await expect(card).toBeVisible()
  await side.getByTestId('side-chat-input').fill('4분기')
  await side.getByTestId('side-chat-send').click()
  await expect(card).toHaveCount(0)
  await expect(side.getByTestId('side-chat-no-secrets')).toHaveCount(0)
})
