// Threads on AI answers in shared chats (docs/decisions/20261116-chat-answer-threads.md), against the mock (test/mock/
// server.ts "threads on AI answers": a chat counts as shared once POST /__test/people-chat marked it). A finished answer
// of a shared chat has "Reply in thread"; a private chat's answer has none. The thread opens beside the chat at 1440 (its
// own address, /c/:chatId/t/:messageId) and over it at 390 with ‹ back; Esc and ✕ close it, the browser's back too. A
// reply shows at once and under the answer as "1 reply"; another person's window sees it come without a reload. "Send to
// Trina" puts the thread in the chat's box as a quote (every line "> "), below what was typed there, and sends nothing;
// on a phone it goes back to the chat. Delete asks first and removes the reply for everyone. A thread with no replies has
// no Send to Trina. axe on the panel.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const H = { [CSRF_HEADER]: '1' }

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

/** a chat of the signed-in person with one finished answer; `shared`: marked shared with people (the mock's switch) */
async function chatWithAnswer(page: Page, shared: boolean) {
  const chat = (await (await page.request.post('/api/chats', { headers: H, data: {} })).json()) as { id: string }
  expect((await page.request.post(`/api/chats/${chat.id}/messages`, { headers: H, data: { content: 'Which seal goes on the quote?', clientMessageId: uuidv7() } })).status()).toBe(202)
  await expect.poll(async () => ((await (await page.request.get(`/api/chats/${chat.id}`)).json()) as { runState: string }).runState).toBe('idle')
  expect((await page.request.patch(`/api/chats/${chat.id}`, { headers: H, data: { title: 'Quote for Hanbit' } })).ok()).toBeTruthy()
  if (shared) expect((await page.request.post('/__test/people-chat', { data: { chatId: chat.id, by: 'olga', audience: 3 } })).ok()).toBeTruthy()
  const msgs = (await (await page.request.get(`/api/chats/${chat.id}/messages`)).json()) as { items: { id: string; role: string }[] }
  return { chatId: chat.id, answerId: msgs.items.find((m) => m.role === 'assistant')!.id }
}

test.beforeEach(async ({ page }) => {
  await reset(page, { teamLocale: 'en' })
})

test('1440: Reply in thread opens the thread beside the chat; a reply shows under the answer; Esc closes it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await signIn(page)
  const { chatId, answerId } = await chatWithAnswer(page, true)
  await page.goto(`/c/${chatId}`)
  const answer = page.locator(`[data-message-id="${answerId}"]`)
  await answer.hover()
  await answer.getByTestId('reply-in-thread').click()
  await expect(page).toHaveURL(new RegExp(`/c/${chatId}/t/${answerId}$`))
  const panel = page.getByTestId('chat-thread')
  await expect(panel).toBeVisible()
  // the chat stays beside it
  await expect(page.getByTestId('chat-drop')).toBeVisible()
  await expect(panel.getByTestId('chat-thread-count')).toBeVisible()
  await expect(panel.getByTestId('chat-thread-people-only')).toBeVisible()
  // no replies yet: no Send to Trina
  await expect(panel.getByTestId('chat-thread-send-to-ai')).toHaveCount(0)
  await expect(panel.getByTestId('chat-thread-input')).toBeFocused()
  await audit(page, 'thread, empty')
  await panel.getByTestId('chat-thread-input').fill('Use the corporate seal.')
  await page.keyboard.press('Enter')
  await expect(panel.getByTestId('chat-thread-reply')).toHaveCount(1)
  await expect(panel.getByTestId('chat-thread-reply-text')).toHaveText('Use the corporate seal.')
  await expect(answer.getByTestId('chat-thread-line')).toBeVisible()
  await expect(panel.getByTestId('chat-thread-send-to-ai')).toBeVisible()
  await audit(page, 'thread, one reply')
  // Esc: back to the chat, one step back (the chat opened it)
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(new RegExp(`/c/${chatId}$`))
  await expect(panel).toHaveCount(0)
  // the line under the answer opens it again
  await answer.getByTestId('chat-thread-line').click()
  await expect(page.getByTestId('chat-thread')).toBeVisible()
  await page.getByTestId('chat-thread-close').click()
  await expect(page).toHaveURL(new RegExp(`/c/${chatId}$`))
})

test('a private chat\'s answer has no Reply in thread, and its thread address is not found', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await signIn(page)
  const { chatId, answerId } = await chatWithAnswer(page, false)
  await page.goto(`/c/${chatId}`)
  const answer = page.locator(`[data-message-id="${answerId}"]`)
  await answer.hover()
  await expect(answer.getByTestId('copy-button').or(answer.getByTestId('answer-actions')).first()).toBeVisible()
  await expect(answer.getByTestId('reply-in-thread')).toHaveCount(0)
  expect((await page.request.get(`/api/chats/${chatId}/messages/${answerId}/thread`)).status()).toBe(404)
})

test('Send to Trina: the thread goes into the chat\'s box as a quote, below what was typed, and nothing is sent', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await signIn(page)
  const { chatId, answerId } = await chatWithAnswer(page, true)
  for (const text of ['Corporate seal, or the CEO line?', 'Seal. Legal said so last time.'])
    expect((await page.request.post(`/api/chats/${chatId}/messages/${answerId}/thread`, { headers: H, data: { text, clientId: `cid-${uuidv7()}` } })).status()).toBe(201)
  const before = ((await (await page.request.get(`/api/chats/${chatId}/messages`)).json()) as { items: unknown[] }).items.length
  await page.goto(`/c/${chatId}`)
  await page.getByTestId('composer-input').fill('My own note first.')
  await page.goto(`/c/${chatId}/t/${answerId}`)
  const panel = page.getByTestId('chat-thread')
  await expect(panel.getByTestId('chat-thread-reply')).toHaveCount(2)
  await panel.getByTestId('chat-thread-send-to-ai').click()
  const box = page.getByTestId('composer-input')
  await expect(box).toHaveValue(/^My own note first\.\n\n> /)
  const value = await box.inputValue()
  const quote = value.slice('My own note first.\n\n'.length).trimEnd().split('\n')
  expect(quote.every((l) => l.startsWith('>'))).toBe(true)
  expect(quote.some((l) => l.includes('Corporate seal, or the CEO line?'))).toBe(true)
  expect(quote.some((l) => l.includes('Seal. Legal said so last time.'))).toBe(true)
  // the answer's own text is not quoted
  expect(value).not.toContain('Which seal goes on the quote?')
  // nothing was sent
  expect(((await (await page.request.get(`/api/chats/${chatId}/messages`)).json()) as { items: unknown[] }).items.length).toBe(before)
})

test('delete asks first and removes the reply; another window of the chat sees replies come and go without a reload', async ({ page, browser }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await signIn(page)
  const { chatId, answerId } = await chatWithAnswer(page, true)
  await page.goto(`/c/${chatId}/t/${answerId}`)
  const panel = page.getByTestId('chat-thread')
  await expect(panel.getByTestId('chat-thread-count')).toBeVisible()
  // another window on another device (the mock's realtime goes to every window)
  const other = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' })
  const bob = await other.newPage()
  await signIn(bob)
  await bob.goto(`/c/${chatId}`)
  const bobAnswer = bob.locator(`[data-message-id="${answerId}"]`)
  await expect(bobAnswer).toBeVisible()
  await panel.getByTestId('chat-thread-input').fill('First thought.')
  await panel.getByTestId('chat-thread-send').click()
  await expect(bobAnswer.getByTestId('chat-thread-line')).toBeVisible()
  await panel.getByTestId('chat-thread-reply').hover()
  await panel.getByTestId('chat-thread-reply-menu').click()
  await page.getByTestId('chat-thread-delete').click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByTestId('dialog-confirm').click()
  await expect(panel.getByTestId('chat-thread-reply')).toHaveCount(0)
  await expect(bobAnswer.getByTestId('chat-thread-line')).toHaveCount(0)
  await other.close()
})

test('390: the thread is the whole screen with ‹ back; Send to Trina goes back to the chat with the quote in the box', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await signIn(page)
  const { chatId, answerId } = await chatWithAnswer(page, true)
  expect((await page.request.post(`/api/chats/${chatId}/messages/${answerId}/thread`, { headers: H, data: { text: 'Seal, please.', clientId: `cid-${uuidv7()}` } })).status()).toBe(201)
  await page.goto(`/c/${chatId}`)
  const answer = page.locator(`[data-message-id="${answerId}"]`)
  // the line under the answer is always in sight on a phone
  await answer.getByTestId('chat-thread-line').click()
  const panel = page.getByTestId('chat-thread')
  await expect(panel).toBeVisible()
  await expect(page.getByTestId('chat-drop')).toBeHidden()
  await expect(panel.getByTestId('chat-thread-back')).toBeVisible()
  const back = await panel.getByTestId('chat-thread-back').boundingBox()
  expect(back!.height).toBeGreaterThanOrEqual(44)
  // nothing wider than the screen
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await audit(page, 'thread, phone')
  await panel.getByTestId('chat-thread-send-to-ai').click()
  await expect(page).toHaveURL(new RegExp(`/c/${chatId}$`))
  await expect(page.getByTestId('composer-input')).toHaveValue(/> .*Seal, please\./s)
  // ‹ from a thread opened by its address goes to the chat
  await page.goto(`/c/${chatId}/t/${answerId}`)
  await page.getByTestId('chat-thread-back').click()
  await expect(page).toHaveURL(new RegExp(`/c/${chatId}$`))
})
