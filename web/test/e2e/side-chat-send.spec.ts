// One click from the Trina side chat (components/rooms/SendHere.tsx, docs/DECISIONS.md "Trina side chat: send here"):
// an answer to a question about a room message goes to that message's thread ("스레드에 보내기"; a follow-up keeps it),
// ▾ sends it to the room; then "✓ … 보냈어요 · 보기", the focus on 보기, and 보기 opens the thread (in the right column;
// ✦ brings the same side chat back, still saying it was sent) or the room at the message. The server's confirm shows only
// the confirm step with the target; 취소 gives the focus back. An older side chat (a quote without a thread) sends to the
// room only. A phone: the thread takes the whole screen, its back arrow returns to the room, ✦ to the side chat; 보기 of
// a room send closes the side chat so the room shows. The room through page.route (rooms-mock.ts), the share endpoint
// here (contract-shaped: it puts the message into the room or the thread), the chats and answers by the mock server.
// SHOTS_DIR=<folder>: the control, ▾'s menu, the sent line and the confirm step, at 1440 and 390, light and dark.
import fs from 'node:fs'
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom, type MockRoom } from './rooms-mock'

// the room's answers come through page.route, which does not see what the app's service worker fetches
test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } })

const BEN = { id: 'ben', name: '벤' }
const OLGA = { id: 'olga', name: 'Olga' }
const MSG = '019a5f00-0000-7000-8000-000000000001'
const ASKED = '로고 시안 언제까지 받을 수 있을까요? 금요일 회의 전에 보고 싶어요.'
// the mock's answer to a question with "한 줄로" (test/mock/server.ts)
const ANSWER = '로고 시안은 수요일까지 2개 받기로 했어요. 피드백은 금요일 회의 전에 이 스레드에 모아요.'

async function shot(page: Page, name: string) {
  if (!process.env.SHOTS_DIR) return
  fs.mkdirSync(process.env.SHOTS_DIR, { recursive: true })
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(250)
    await page.screenshot({ path: path.join(process.env.SHOTS_DIR, `after-${name}-${page.viewportSize()!.width}-${scheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

/** No serious accessibility problem where the control is. */
async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

const CONFIRM = { status: 'confirm', people: 2, places: [], otherPlaces: false, files: [{ name: 'logo-v2.png', path: 'users/olga/logo-v2.png', missing: false, attach: 'yes', unable: 2 }], provenance: null, confirmKey: 'k1' }

/** The share endpoint as the server answers it: `plan` says what each request gets ('confirm' first, else sent); a sent
 * message goes into the room or the thread; the same clientMessageId again is the first message. */
async function routeShare(page: Page, room: MockRoom, plan: ('confirm' | 'sent')[] = []) {
  const bodies: Record<string, unknown>[] = []
  const known = new Map<string, unknown>()
  await page.route(/\/api\/chats\/[^/]+\/messages\/[^/]+\/share-to-room$/, async (route) => {
    const b = route.request().postDataJSON() as { clientMessageId: string; threadRootId?: string }
    bodies.push(b)
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    const first = known.get(b.clientMessageId)
    if (first) return json({ status: 'sent', message: first, cut: false })
    if (plan.shift() === 'confirm') return json(CONFIRM)
    const m = room.add({ author: OLGA, body: ANSWER, ...(b.threadRootId ? { threadRootId: b.threadRootId } : {}), extra: { sharedAnswer: { at: 0, cut: false } } })
    known.set(b.clientMessageId, m)
    return json({ status: 'sent', message: m, cut: false })
  })
  return bodies
}

/** The room with ben's message; ✦ by asking about it (or bare), the question typed and answered. */
async function open(page: Page, o: { plan?: ('confirm' | 'sent')[]; ask?: boolean; question?: string; phone?: boolean } = {}) {
  await reset(page)
  await signIn(page)
  const room = await routeRoom(page, { members: [BEN, { id: 'cy', name: '씨와이' }], messages: [{ id: MSG, author: BEN, body: ASKED }] })
  const shares = await routeShare(page, room, o.plan)
  await page.goto(`/rooms/${ROOM_ID}`)
  if (o.ask ?? true) {
    const msg = page.getByTestId('room-message').first()
    await msg.hover()
    await msg.getByTestId('message-ask-trina').click()
  } else await page.getByTestId('room-side-chat-button').click()
  // a phone: the same side chat at 390 (the hover bar that asks is a computer's; a phone's is the long-press sheet)
  if (o.phone) await page.setViewportSize({ width: 390, height: 844 })
  const side = page.getByTestId('room-side-chat')
  const [q] = await Promise.all([question(page), ask(side, o.question ?? '한 줄로 정리해 줘')])
  await expect(side.locator('[data-testid="assistant-message"][data-status="done"]')).toHaveCount(1, { timeout: 20_000 })
  return { room, shares, side, content: (q.postDataJSON() as { content: string }).content }
}
const question = (page: Page) => page.waitForRequest((r) => r.method() === 'POST' && /^\/api\/chats\/[^/]+\/messages$/.test(new URL(r.url()).pathname))
async function ask(side: Locator, text: string) {
  await side.getByTestId('side-chat-input').fill(text)
  await side.getByTestId('side-chat-send').click()
}
const lastAnswer = (side: Locator) => side.locator('[data-testid="assistant-message"]').last()
/** the question's bubble: ben's message as a quote (who, when, its text), then the question; no Markdown, no token */
async function quotedBubble(side: Locator, question = '한 줄로 정리해 줘') {
  const bubble = side.getByTestId('user-text').first()
  await expect(bubble.getByTestId('user-quote-head')).toHaveText(/^벤 \d{4}\. \d{1,2}\. \d{1,2}\. (오전|오후) \d{1,2}:\d{2}$/)
  await expect(bubble.getByTestId('user-quote-text')).toHaveText(ASKED)
  await expect(bubble).toContainText(question)
  await expect(bubble).not.toContainText('>')
  await expect(bubble).not.toContainText('thread_id')
  // inside the bubble, the question under the quote
  const [q, b] = [await bubble.getByTestId('user-quote').boundingBox(), await bubble.boundingBox()]
  expect(q!.x).toBeGreaterThanOrEqual(b!.x)
  expect(q!.x + q!.width).toBeLessThanOrEqual(b!.x + b!.width + 0.5)
}
/** 🕘: the room's side chats by their titles */
async function historyTitles(side: Locator) {
  await side.getByTestId('side-chat-history').click()
  const items = side.getByTestId('side-chat-history-item')
  await expect(items.first()).toBeVisible()
  return items
}

test('an answer about a message goes to its thread with one click; 보기 opens the thread; ✦ brings the side chat back, still sent', async ({ page }) => {
  const { shares, side, content } = await open(page)
  // the question carries the thread (hidden in its bubble); the answer's control names it
  const [head, quoted, blank, asked] = content.split('\n')
  expect(head).toMatch(new RegExp(`^> 벤 · .+ \\(thread_id ${MSG} in this room\\)$`))
  expect([quoted, blank, asked]).toEqual([`> ${ASKED}`, '', '한 줄로 정리해 줘'])
  await quotedBubble(side)
  // (the first answer: a follow-up comes below it)
  const answer = side.locator('[data-testid="assistant-message"]').first()
  await expect(answer.getByTestId('send-here-thread')).toHaveText('스레드에 보내기')
  await expect(answer.getByTestId('send-here-more')).toHaveAccessibleName('다른 곳에 보내기')
  await expect(answer.getByTestId('share-to-room')).toHaveCount(0)
  await shot(page, 'control')
  await audit(page, 'the control')
  // ▾: one item, the room
  await answer.getByTestId('send-here-more').click()
  await expect(page.getByRole('menuitem')).toHaveText(['대화방에 보내기'])
  await shot(page, 'menu')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menuitem')).toHaveCount(0)
  // one click: sent at once, no dialog, no toast
  await answer.getByTestId('send-here-thread').click()
  await expect(answer.getByTestId('send-here-sent')).toHaveText('스레드에 보냈어요·보기')
  expect(shares).toEqual([{ roomId: ROOM_ID, threadRootId: MSG, clientMessageId: expect.any(String) }])
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByTestId('toast')).toHaveCount(0)
  await expect(answer.getByTestId('send-here-view')).toBeFocused()
  await expect(answer.getByTestId('send-here-status')).toHaveText('스레드에 보냈어요')
  await shot(page, 'sent')
  await audit(page, 'the sent line')
  // a follow-up without a quote keeps the thread
  await ask(side, '더 짧게 한 줄로')
  await expect(side.locator('[data-testid="assistant-message"][data-status="done"]')).toHaveCount(2, { timeout: 20_000 })
  await expect(lastAnswer(side).getByTestId('send-here-thread')).toBeVisible()
  // 보기: the thread in the right column at the reply; the side chat is gone from there
  await answer.getByTestId('send-here-view').click()
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}/t/${MSG}\\?m=`))
  const thread = page.getByTestId('room-thread')
  await expect(thread.locator('[data-highlight]')).toContainText(ANSWER)
  await expect(page.getByTestId('room-side-chat')).toHaveCount(0)
  // ✦: the same side chat again, the answer still sent
  await page.getByTestId('room-side-chat-button').click()
  await expect(page.getByTestId('room-thread')).toHaveCount(0)
  const again = page.getByTestId('room-side-chat')
  await expect(again.locator('[data-testid="assistant-message"]').first().getByTestId('send-here-sent')).toHaveText('스레드에 보냈어요·보기')
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}$`))
})

test('▾ sends to the room instead; 보기 marks the message in the room and the side chat stays beside it', async ({ page }) => {
  const { shares, side } = await open(page)
  const answer = lastAnswer(side)
  await answer.getByTestId('send-here-more').click()
  await page.getByTestId('send-here-room-item').click()
  await expect(answer.getByTestId('send-here-sent')).toHaveText('대화방에 보냈어요·보기')
  expect(shares).toEqual([{ roomId: ROOM_ID, clientMessageId: expect.any(String) }])
  await expect(answer.getByTestId('send-here-view')).toBeFocused()
  await answer.getByTestId('send-here-view').click()
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}\\?m=`))
  await expect(page.getByTestId('room').locator('[data-highlight]')).toContainText(ANSWER)
  await expect(page.getByTestId('room-side-chat')).toBeVisible()
})

test('the server asks first: only the confirm step, with the thread\'s message; 취소 gives the focus back; yes sends it there', async ({ page }) => {
  const { shares, side } = await open(page, { plan: ['confirm', 'confirm', 'sent'] })
  const answer = lastAnswer(side)
  await answer.getByTestId('send-here-thread').click()
  const dialog = page.getByRole('dialog', { name: '스레드에 보내기' })
  await expect(dialog.getByTestId('share-room-confirm')).toBeVisible()
  await expect(dialog.getByTestId('share-room-search')).toHaveCount(0)
  await expect(dialog.getByTestId('share-room-note')).toHaveCount(0)
  await expect(dialog.getByTestId('share-room-to')).toContainText('디자인 리뷰')
  await expect(dialog.getByTestId('share-room-thread')).toContainText(ASKED)
  await expect(dialog.getByTestId('share-room-attach')).toBeChecked()
  await expect(dialog.getByTestId('share-room-confirm-send')).toBeFocused()
  await shot(page, 'confirm')
  await audit(page, 'the confirm step')
  await dialog.getByTestId('share-room-back').click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(answer.getByTestId('send-here-thread')).toBeFocused()
  // a new click (a new id); yes: the same id with the key and the file
  await answer.getByTestId('send-here-thread').click()
  await page.getByRole('dialog', { name: '스레드에 보내기' }).getByTestId('share-room-confirm-send').click()
  await expect(answer.getByTestId('send-here-sent')).toHaveText('스레드에 보냈어요·보기')
  expect(shares).toHaveLength(3)
  expect(shares[1]!.clientMessageId).not.toBe(shares[0]!.clientMessageId)
  expect(shares[2]).toEqual({ roomId: ROOM_ID, threadRootId: MSG, confirmKey: 'k1', attach: ['users/olga/logo-v2.png'], clientMessageId: shares[1]!.clientMessageId })
  await expect(answer.getByTestId('send-here-view')).toBeFocused()
})

test('an older side chat (a quote without its thread): the room only', async ({ page }) => {
  // what an older app sent: the message quoted, no thread in its header
  const { shares, side } = await open(page, { ask: false, question: `> 벤 · 2026. 11. 5. 오후 6:01\n> ${ASKED}\n\n한 줄로 정리해 줘` })
  const answer = lastAnswer(side)
  await expect(answer.getByTestId('send-here-room')).toHaveText('대화방에 보내기')
  await expect(answer.getByTestId('send-here-thread')).toHaveCount(0)
  await expect(answer.getByTestId('send-here-more')).toHaveCount(0)
  await answer.getByTestId('send-here-room').click()
  await expect(answer.getByTestId('send-here-sent')).toHaveText('대화방에 보냈어요·보기')
  expect(shares).toEqual([{ roomId: ROOM_ID, clientMessageId: expect.any(String) }])
})

test.describe('a phone (390 px)', () => {
  test('the thread takes the whole screen from 보기; back to the room, ✦ to the same side chat; the confirm and ▾ are sheets', async ({ page }) => {
    const { side } = await open(page, { phone: true, plan: ['confirm', 'sent'] })
    const answer = lastAnswer(side)
    await expect(page.getByTestId('room')).toBeHidden()
    await quotedBubble(side)
    await expect(answer.getByTestId('send-here-thread')).toBeVisible()
    await shot(page, 'control')
    await answer.getByTestId('send-here-more').click()
    await expect(page.getByRole('menuitem')).toHaveText(['대화방에 보내기'])
    await shot(page, 'menu')
    await page.keyboard.press('Escape')
    await answer.getByTestId('send-here-thread').click()
    const dialog = page.getByRole('dialog', { name: '스레드에 보내기' })
    await expect(dialog.getByTestId('share-room-thread')).toContainText(ASKED)
    await shot(page, 'confirm')
    await dialog.getByTestId('share-room-confirm-send').click()
    await expect(answer.getByTestId('send-here-sent')).toHaveText('스레드에 보냈어요·보기')
    await shot(page, 'sent')
    await answer.getByTestId('send-here-view').click()
    const thread = page.getByTestId('room-thread')
    await expect(thread.locator('[data-highlight]')).toContainText(ANSWER)
    await expect(page.getByTestId('room')).toBeHidden()
    await expect(page.getByTestId('room-side-chat')).toHaveCount(0)
    // back to the room, ✦ to the same side chat
    await thread.getByTestId('thread-back').click()
    await expect(page.getByTestId('room')).toBeVisible()
    await page.getByTestId('room-side-chat-button').click()
    await expect(page.getByTestId('room-side-chat').locator('[data-testid="assistant-message"]').first().getByTestId('send-here-sent')).toHaveText('스레드에 보냈어요·보기')
  })

  test('보기 of a room send closes the side chat so the room shows, at the message', async ({ page }) => {
    const { side } = await open(page, { phone: true })
    const answer = lastAnswer(side)
    await answer.getByTestId('send-here-more').click()
    await page.getByTestId('send-here-room-item').click()
    await expect(answer.getByTestId('send-here-sent')).toHaveText('대화방에 보냈어요·보기')
    await answer.getByTestId('send-here-view').click()
    await expect(page.getByTestId('room-side-chat')).toHaveCount(0)
    await expect(page.getByTestId('room')).toBeVisible()
    await expect(page.getByTestId('room').locator('[data-highlight]')).toContainText(ANSWER)
    // ✦: the same side chat, still sent
    await page.getByTestId('room-side-chat-button').click()
    await expect(page.getByTestId('room-side-chat').getByTestId('send-here-sent')).toHaveText('대화방에 보냈어요·보기')
  })
})

test('a side chat is named after its question, never the quote; a quick question after the quote ("요약: …")', async ({ page }) => {
  const { side } = await open(page)
  await expect(await historyTitles(side)).toHaveText([/^한 줄로 정리해 줘/])
  // a new chat, asked with a quick question about the same message
  await side.getByTestId('side-chat-history').click()
  await side.getByTestId('side-chat-new').click()
  const msg = page.getByTestId('room-message').first()
  await msg.hover()
  await msg.getByTestId('message-ask-trina').click()
  await side.getByTestId('side-chat-quick-summarize').click()
  await expect(side.locator('[data-testid="assistant-message"][data-status="done"]')).toHaveCount(1, { timeout: 20_000 })
  await quotedBubble(side, '이 메시지를 요약해 줘.')
  const items = await historyTitles(side)
  await expect(items).toHaveCount(2)
  await expect(items.first()).toContainText('요약: 로고 시안 언제까지 받을 수 있을까요?')
  await expect(items.nth(1)).toContainText('한 줄로 정리해 줘')
  for (const t of await items.allTextContents()) expect(t).not.toMatch(/^벤 · /)
})
