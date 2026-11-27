// One way to act on a message (components/messages/MessageActions.tsx; docs/decisions/20261126-shared-message-actions.md),
// in the browser at 1440 and at 390 with touch (and a touch tablet at 820):
// - a long press opens the one sheet on an AI chat answer, my question, a room message, a shared chat thread's answer
//   and a reply in it; a tap shows nothing; on a picture or a link it opens nothing of ours (the phone's own menu);
// - a computer has the same thread icon in the AI chat and in a room, and copy says "복사했어요" (✓ on the row, a toast
//   from a menu);
// - a document an AI made, sent to a room, opens in the right panel there as in the chat.
// SHOTS_DIR=<folder>: a screenshot of each.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

const H = { [CSRF_HEADER]: '1' }
const BEN = { id: 'ben', name: '벤' }
const rid = (n: number) => `019a5f00-0000-7000-8000-${String(n).padStart(12, '0')}`

async function shot(page: Page, name: string) {
  if (!process.env.SHOTS_DIR) return
  fs.mkdirSync(process.env.SHOTS_DIR, { recursive: true })
  await page.screenshot({ path: path.join(process.env.SHOTS_DIR, name) })
}
/** a finger held on it for 650 ms */
async function longPress(page: Page, el: Locator) {
  const box = (await el.boundingBox())!
  const at = { pointerType: 'touch', isPrimary: true, clientX: box.x + 12, clientY: box.y + Math.min(10, box.height / 2), bubbles: true }
  await el.dispatchEvent('pointerdown', at)
  await page.waitForTimeout(650)
  await el.dispatchEvent('pointerup', at)
  await page.waitForTimeout(450)
}
const sheet = (page: Page) => page.getByRole('menu', { name: '메시지 메뉴' })

/** a chat of the signed-in person with one finished answer; `shared`: marked shared with people (the mock's switch) */
async function chatWithAnswer(page: Page, shared = false) {
  const chat = (await (await page.request.post('/api/chats', { headers: H, data: {} })).json()) as { id: string }
  expect((await page.request.post(`/api/chats/${chat.id}/messages`, { headers: H, data: { content: 'Which seal goes on the quote?', clientMessageId: uuidv7() } })).status()).toBe(202)
  await expect.poll(async () => ((await (await page.request.get(`/api/chats/${chat.id}`)).json()) as { runState: string }).runState).toBe('idle')
  if (shared) expect((await page.request.post('/__test/people-chat', { data: { chatId: chat.id, by: 'olga', audience: 3 } })).ok()).toBeTruthy()
  const msgs = (await (await page.request.get(`/api/chats/${chat.id}/messages`)).json()) as { items: { id: string; role: string }[] }
  return { chatId: chat.id, answerId: msgs.items.find((m) => m.role === 'assistant')!.id }
}

test.describe('390, touch', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' })

  test('AI chat: a long press opens the sheet on an answer and on my question; a tap shows nothing', async ({ page }) => {
    await reset(page)
    await signIn(page)
    const { chatId, answerId } = await chatWithAnswer(page)
    await page.goto(`/c/${chatId}`)
    const answer = page.locator(`[data-message-id="${answerId}"]`)
    await expect(answer).toHaveAttribute('data-status', 'done')
    // a tap on my question brings no icons: they wait in its sheet
    const question = page.getByTestId('user-message').first()
    await question.getByTestId('user-text').tap()
    expect(await question.getByTestId('message-actions-tap').evaluate((e) => getComputedStyle(e).clipPath)).toBe('inset(50%)')
    await longPress(page, answer.locator('p').first())
    await expect(sheet(page)).toBeVisible()
    await expect(sheet(page).getByRole('menuitem').first()).toHaveText('답변 복사')
    await expect(sheet(page).getByRole('menuitem', { name: '텍스트 선택' })).toBeVisible()
    const box = (await sheet(page).boundingBox())!
    expect(Math.round(box.width)).toBe(390)
    await shot(page, 'msgact-chat-answer-sheet-390.png')
    // copy from the sheet: the shared words as a toast
    await sheet(page).getByRole('menuitem', { name: '답변 복사' }).click()
    await expect(page.getByText('복사했어요')).toBeVisible()
    // a picture in an answer: the phone's own menu (save image), not the sheet
    await answer.evaluate((el) => {
      const img = document.createElement('img')
      img.setAttribute('data-testid', 'probe-img')
      img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='
      img.style.width = '40px'; img.style.height = '40px'
      el.querySelector('p')!.after(img)
    })
    await longPress(page, answer.getByTestId('probe-img'))
    await expect(sheet(page)).toHaveCount(0)
    // Select text: the long press steps aside on that answer
    await longPress(page, answer.locator('p').first())
    await sheet(page).getByRole('menuitem', { name: '텍스트 선택' }).click()
    await expect(answer).toHaveAttribute('data-selecting', '')
    // my question: copy, edit, select text
    await longPress(page, question.getByTestId('user-text'))
    await expect(sheet(page).getByRole('menuitem')).toHaveText(['복사', '메시지 수정', '텍스트 선택'])
    await shot(page, 'msgact-chat-question-sheet-390.png')
    await sheet(page).getByRole('menuitem', { name: '메시지 수정' }).click()
    await expect(page.getByTestId('edit-input')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  })

  test('room: the same sheet, with its reactions, from the words and from a link', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await routeRoom(page, { members: [BEN], messages: [
      { id: rid(1), author: BEN, body: '로고 시안 언제까지 받을 수 있을까요?' },
      { id: rid(2), author: BEN, body: '참고: https://example.com/brief 여기 있어요' },
    ] })
    await page.goto(`/rooms/${ROOM_ID}`)
    const first = page.getByTestId('room-message').first()
    await longPress(page, first.locator('p').first())
    await expect(sheet(page)).toBeVisible()
    await expect(sheet(page).getByRole('menuitem', { name: '스레드에서 답장' })).toBeVisible()
    await expect(sheet(page).getByRole('menuitem', { name: '복사', exact: true })).toBeVisible()
    await shot(page, 'msgact-room-sheet-390.png')
    await sheet(page).getByRole('menuitem', { name: '복사', exact: true }).click()
    await expect(page.getByText('복사했어요')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(sheet(page)).toHaveCount(0)
    // a long press on a link gets the phone's own menu (open, copy the link), never the message's sheet
    const link = page.getByTestId('room-message').nth(1).locator('a[href]').first()
    await longPress(page, link)
    await expect(sheet(page)).toHaveCount(0)
    expect(await link.evaluate((e) => getComputedStyle(e).getPropertyValue('-webkit-touch-callout') || 'default')).not.toBe('none')
  })

  test('shared chat thread: its answer on top and a reply open the same sheet', async ({ page }) => {
    await reset(page)
    await signIn(page)
    const { chatId, answerId } = await chatWithAnswer(page, true)
    expect((await page.request.post(`/api/chats/${chatId}/messages/${answerId}/thread`, { headers: H, data: { text: 'Seal, please.', clientId: `cid-${uuidv7()}` } })).status()).toBe(201)
    await page.goto(`/c/${chatId}/t/${answerId}`)
    const panel = page.getByTestId('chat-thread')
    await expect(panel.getByTestId('chat-thread-reply')).toHaveCount(1)
    await longPress(page, panel.getByTestId('chat-thread-reply-text'))
    await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(['복사', '삭제'])
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await longPress(page, panel.getByTestId('chat-thread-answer').locator('p').first())
    await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(['답변 복사', '텍스트 선택'])
    await shot(page, 'msgact-thread-answer-sheet-390.png')
  })
})

test.describe('820 touch tablet', () => {
  test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' })

  test('AI chat: the icons stay in sight and a long press opens the menu', async ({ page }) => {
    await reset(page)
    await signIn(page)
    const { chatId, answerId } = await chatWithAnswer(page)
    await page.goto(`/c/${chatId}`)
    const answer = page.locator(`[data-message-id="${answerId}"]`)
    await expect(answer.getByTestId('answer-actions-tap')).toBeVisible()
    expect(await answer.getByTestId('answer-actions-tap').evaluate((e) => getComputedStyle(e).clipPath)).not.toBe('inset(50%)')
    await longPress(page, answer.locator('p').first())
    await expect(page.getByRole('menu', { name: '메시지 메뉴' })).toBeVisible()
  })
})

test.describe('1440', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('the same thread icon in the AI chat and in a room; copy says the same words', async ({ page }) => {
    await reset(page)
    await signIn(page)
    const { chatId, answerId } = await chatWithAnswer(page, true)
    await page.goto(`/c/${chatId}`)
    const answer = page.locator(`[data-message-id="${answerId}"]`)
    await answer.hover()
    const chatIcon = await answer.getByTestId('reply-in-thread').locator('svg').getAttribute('class')
    // copy on the row: ✓ and the shared words
    const copy = answer.getByRole('button', { name: '답변 복사' })
    await copy.click()
    await expect(answer.getByRole('button', { name: '복사했어요' })).toBeVisible()
    await shot(page, 'msgact-chat-row-1440.png')
    // the thread's answer on top has copy too (it had none) and its steps
    await answer.getByTestId('reply-in-thread').click()
    const thread = page.getByTestId('chat-thread')
    await thread.getByTestId('chat-thread-answer').hover()
    await thread.getByTestId('chat-thread-answer').getByTestId('message-more').click()
    await page.getByRole('menuitem', { name: '답변 복사' }).click()
    await expect(page.getByText('복사했어요')).toBeVisible()

    await routeRoom(page, { members: [BEN], messages: [{ id: rid(1), author: BEN, body: '로고 시안 언제까지 받을 수 있을까요?' }] })
    await page.goto(`/rooms/${ROOM_ID}`)
    const m = page.getByTestId('room-message').first()
    await m.hover()
    const roomIcon = await m.getByTestId('message-thread').locator('svg').getAttribute('class')
    expect(roomIcon?.match(/lucide-[a-z0-9-]+/g)).toEqual(chatIcon?.match(/lucide-[a-z0-9-]+/g))
    expect(roomIcon).toContain('lucide-message-square-text')
    await m.getByTestId('message-more').click()
    await page.getByTestId('message-copy').click()
    await expect(page.getByText('복사했어요')).toBeVisible()
    await shot(page, 'msgact-room-bar-1440.png')
  })

  test('a document an AI made, sent to a room, opens in the right panel; a person\'s own file in the viewer', async ({ page }) => {
    await reset(page)
    await signIn(page)
    const pdf = Buffer.from(await (await page.request.get('/api/files/download?path=docs%2Fhandbook.pdf&disposition=attachment&preview=true')).body())
    const file = (n: number, name: string) => ({ id: rid(n), name, size: pdf.length, mime: 'application/pdf', kind: 'pdf', thumb: false })
    await routeRoom(page, { members: [BEN], kind: 'team', messages: [
      { id: rid(1), author: BEN, body: '제 메모예요', extra: { files: [file(501, 'ben-notes.pdf')] } },
      { id: rid(2), author: BEN, body: '보고서 정리했어요\n\nQ4 보고서를 만들었어요.', extra: { sharedAnswer: { at: 11, cut: false }, files: [file(502, 'q4-report.pdf')] } },
    ] })
    await page.route(/\/api\/rooms\/[^/]+\/files\/[^/?]+/, (route) => route.fulfill({ status: 200, body: pdf, headers: { 'content-type': 'application/pdf', 'content-disposition': 'inline; filename="x.pdf"' } }))
    await page.goto(`/rooms/${ROOM_ID}`)
    await expect(page.getByTestId('room-message')).toHaveCount(2)
    // a person's own file keeps the room's viewer
    await page.getByTestId('room-message').first().getByTestId('room-file-open').click()
    await expect(page.getByTestId('image-viewer')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('image-viewer')).toHaveCount(0)
    // the AI's document: the right panel, not the viewer, with the side chat open beside the room too
    await page.getByTestId('room-side-chat-button').click()
    await expect(page.getByTestId('room-side-chat')).toBeVisible()
    await page.getByTestId('room-message').nth(1).getByTestId('room-file-open').click()
    await expect(page.getByTestId('file-panel')).toBeVisible()
    await expect(page.getByTestId('file-panel-title')).toContainText('q4-report.pdf')
    await expect(page.getByTestId('image-viewer')).toHaveCount(0)
    await shot(page, 'msgact-ai-doc-panel-1440.png')
  })
})
