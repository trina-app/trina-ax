// Threads on AI answers in shared chats (docs/decisions/20261116-chat-answer-threads.md), against the mock (test/mock/
// server.ts "threads on AI answers": a chat counts as shared once POST /__test/people-chat marked it). A finished answer
// of a shared chat has "Reply in thread"; a private chat's answer has none. The thread opens beside the chat at 1440 (its
// own address, /c/:chatId/t/:messageId) and over it at 390 with ‹ back; Esc and ✕ close it, the browser's back too. A
// reply shows at once and under the answer as "1 reply"; another person's window sees it come without a reload. Delete
// asks first and removes the reply for everyone. There is no "Send to Trina" row under the box. axe on the panel.
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
  await expect(panel.getByTestId('chat-thread-input')).toBeFocused()
  await audit(page, 'thread, empty')
  await panel.getByTestId('chat-thread-input').fill('Use the corporate seal.')
  await page.keyboard.press('Enter')
  await expect(panel.getByTestId('chat-thread-reply')).toHaveCount(1)
  await expect(panel.getByTestId('chat-thread-reply-text')).toHaveText('Use the corporate seal.')
  await expect(answer.getByTestId('chat-thread-line')).toBeVisible()
  await expect(panel.getByTestId('chat-thread-send-to-ai')).toHaveCount(0)
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

/** a shared chat with `turns` questions and answers, each question long enough that the first answer is far up */
async function longSharedChat(page: Page, turns: number) {
  const chat = (await (await page.request.post('/api/chats', { headers: H, data: {} })).json()) as { id: string }
  for (let i = 0; i < turns; i++) {
    const content = `Question ${i + 1}: ` + Array.from({ length: 12 }, (_, l) => `line ${l + 1} of the brief for the Hanbit quote.`).join('\n')
    expect((await page.request.post(`/api/chats/${chat.id}/messages`, { headers: H, data: { content, clientMessageId: uuidv7() } })).status()).toBe(202)
    await expect.poll(async () => ((await (await page.request.get(`/api/chats/${chat.id}`)).json()) as { runState: string }).runState).toBe('idle')
  }
  expect((await page.request.post('/__test/people-chat', { data: { chatId: chat.id, by: 'olga', audience: 3 } })).ok()).toBeTruthy()
  const msgs = (await (await page.request.get(`/api/chats/${chat.id}/messages`)).json()) as { items: { id: string; role: string }[] }
  const answers = msgs.items.filter((m) => m.role === 'assistant').map((m) => m.id)
  return { chatId: chat.id, first: answers[0]!, middle: answers[3]!, last: answers.at(-1)! }
}

// a notice, a push tap or a link opens a thread from outside the chat: the chat goes to the answer the thread is under
// and lights it (docs/decisions/20261120-notif-open-parent-message.md); a thread opened in the chat leaves it as it was
for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`${size.width}: a thread opened from outside the chat shows its answer in the chat, lit; one opened in the chat does not move it`, async ({ page }) => {
    await page.setViewportSize(size)
    await signIn(page)
    const { chatId, first, middle, last } = await longSharedChat(page, 6)
    // the address alone (a push tap's path, a link): the chat at the first answer, lit, not at the bottom
    await page.goto(`/c/${chatId}/t/${first}`)
    await expect(page.getByTestId('chat-thread')).toBeVisible()
    // a phone: the thread over the chat; its ‹ shows the chat at that answer
    if (size.width < 768) await page.getByTestId('chat-thread-back').click()
    const answer = page.locator(`[data-message-id="${first}"]`)
    await expect(answer).toHaveAttribute('data-focused', '')
    await expect(answer).toBeInViewport()
    // only the place: no box, outline or tint around the answer (owner 2026-11-21)
    expect(await answer.evaluate((el) => { const s = getComputedStyle(el); return [s.backgroundColor, s.boxShadow, s.outlineStyle] })).toEqual(['rgba(0, 0, 0, 0)', 'none', 'none'])
    await expect(page.locator(`[data-message-id="${last}"]`)).not.toBeInViewport()
    // the chat open at its newest, then a phone's tap (the app's mycel:open: the router, no reload): the same
    await page.goto(`/c/${chatId}`)
    await expect(page.locator(`[data-message-id="${last}"]`)).toBeInViewport()
    await page.evaluate((path) => window.dispatchEvent(new CustomEvent('mycel:open', { detail: { path }, cancelable: true })), `/c/${chatId}/t/${first}`)
    await expect(page).toHaveURL(new RegExp(`/c/${chatId}/t/${first}$`))
    if (size.width >= 768) {
      await expect(answer).toHaveAttribute('data-focused', '')
      await expect(answer).toBeInViewport()
      // Reply in thread on another answer part way up: the thread changes, the chat stays put and lights nothing
      const other = page.locator(`[data-message-id="${middle}"]`)
      await expect(answer).not.toHaveAttribute('data-focused', '', { timeout: 5000 })
      // (its button first in sight: Playwright scrolls to what it clicks)
      await other.getByTestId('reply-in-thread').scrollIntoViewIfNeeded()
      await other.hover()
      await page.waitForTimeout(300)
      const before = (await other.boundingBox())!.y
      await other.getByTestId('reply-in-thread').click()
      await expect(page).toHaveURL(new RegExp(`/c/${chatId}/t/${middle}$`))
      await page.waitForTimeout(300)
      // the answer stays where it is on the screen (the browser's anchoring may change the list's scrollTop as rows above
      // settle; what the reader sees does not move)
      expect(Math.abs((await other.boundingBox())!.y - before)).toBeLessThan(4)
      await expect(page.locator('[data-message-id][data-focused]')).toHaveCount(0)
    }
  })
}

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
  await panel.getByTestId('chat-thread-reply').getByTestId('message-more').click()
  await page.getByTestId('chat-thread-delete').click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByTestId('dialog-confirm').click()
  await expect(panel.getByTestId('chat-thread-reply')).toHaveCount(0)
  await expect(bobAnswer.getByTestId('chat-thread-line')).toHaveCount(0)
  await other.close()
})

test('390: the thread is the whole screen with ‹ back, which goes to the chat', async ({ page }) => {
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
  // ‹ from a thread opened by its address goes to the chat
  await page.goto(`/c/${chatId}/t/${answerId}`)
  await page.getByTestId('chat-thread-back').click()
  await expect(page).toHaveURL(new RegExp(`/c/${chatId}$`))
})

test('closing the thread puts the focus back on what opened it, never on the page (QA TC-3888)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await signIn(page)
  const { chatId, answerId } = await chatWithAnswer(page, true)
  expect((await page.request.post(`/api/chats/${chatId}/messages/${answerId}/thread`, { headers: H, data: { text: 'One reply.', clientId: `cid-${uuidv7()}` } })).status()).toBe(201)
  await page.goto(`/c/${chatId}`)
  const answer = page.locator(`[data-message-id="${answerId}"]`)
  // the keyboard: "Reply in thread", Enter, then Esc
  await answer.getByTestId('reply-in-thread').focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('chat-thread')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('chat-thread')).toHaveCount(0)
  await expect(answer.getByTestId('reply-in-thread')).toBeFocused()
  // the line under the answer, then ✕
  await answer.getByTestId('chat-thread-line').click()
  await expect(page.getByTestId('chat-thread')).toBeVisible()
  await page.getByTestId('chat-thread-close').click()
  await expect(answer.getByTestId('chat-thread-line')).toBeFocused()
  // opened from its address (a link): back to its answer's line
  await page.goto(`/c/${chatId}/t/${answerId}`)
  await expect(page.getByTestId('chat-thread')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(answer.getByTestId('chat-thread-line')).toBeFocused()
})

// QA TC-3886: while the server is updating (a 503 that says so; /api/health not OK yet) a reply waits faintly and the
// thread says why in the one line under the box; once health answers OK the line goes and the reply posts by itself.
// SHOTS_DIR=<folder>: the line at 1440 and 390, light and dark, English and Korean.
for (const vp of [{ name: '1440', size: { width: 1440, height: 900 } }, { name: '390', size: { width: 390, height: 844 } }]) {
  test(`${vp.name}: while the server is updating the thread says the reply goes when it is back`, async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize(vp.size)
    for (const loc of process.env.SHOTS_DIR ? (['en', 'ko'] as const) : (['en'] as const)) {
      await reset(page, { teamLocale: loc, usersFollowTeam: true })
      await signIn(page)
      const { chatId, answerId } = await chatWithAnswer(page, true)
      await page.goto(`/c/${chatId}/t/${answerId}`)
      const panel = page.getByTestId('chat-thread')
      await expect(panel.getByTestId('chat-thread-count')).toBeVisible()
      const updating = { on: true }
      await page.route(/\/api\/chats\/[^/]+\/messages\/[^/]+\/thread$/, (route) => (updating.on && route.request().method() === 'POST'
        ? route.fulfill({ status: 503, headers: { 'x-mycel-updating': '1', 'content-type': 'application/json' }, body: JSON.stringify({ error: { code: 'unavailable', message: 'updating' } }) })
        : route.fallback()))
      await page.route(/\/api\/health$/, (route) => (updating.on ? route.fulfill({ status: 503, body: '' }) : route.fallback()))
      await expect(panel.getByTestId('chat-thread-updating')).toHaveCount(0)
      await panel.getByTestId('chat-thread-input').fill('Use the corporate seal.')
      await page.keyboard.press('Enter')
      const line = panel.getByTestId('chat-thread-updating')
      await expect(line).toBeVisible()
      if (loc === 'en') await expect(line).toHaveText("Trina is updating. Your reply will be sent when it's back.")
      // one line, inside the panel's width
      const b = (await line.boundingBox())!
      expect(b.x + b.width).toBeLessThanOrEqual(vp.size.width)
      if (process.env.SHOTS_DIR) {
        for (const scheme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
          await page.waitForTimeout(250)
          await page.screenshot({ path: `${process.env.SHOTS_DIR}/thread-updating-${vp.name}-${loc}-${scheme}.png` })
        }
        await page.emulateMedia({ colorScheme: 'light' })
      }
      // back: the line goes and the reply is posted by itself
      updating.on = false
      await expect(panel.getByTestId('chat-thread-reply')).toHaveCount(1, { timeout: 15_000 })
      await expect(line).toHaveCount(0)
      await page.unrouteAll({ behavior: 'ignoreErrors' })
    }
  })
}

// @mentions (docs/decisions/20261118-chat-thread-mentions.md): "@" in the thread's box lists the people who see the
// thread (the page's people, never me), Enter picks, the reply shows the name in the mention look and goes with the id
for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`${size.width}: "@" in the thread's box lists the chat's people; the reply shows the mention`, async ({ page }) => {
    await page.setViewportSize(size)
    await signIn(page)
    const { chatId, answerId } = await chatWithAnswer(page, true)
    await page.goto(`/c/${chatId}/t/${answerId}`)
    const panel = page.getByTestId('chat-thread')
    const box = panel.getByTestId('chat-thread-input')
    await expect(box).toBeVisible()
    const thread = (await (await page.request.get(`/api/chats/${chatId}/messages/${answerId}/thread`)).json()) as { people: { id: string; name: string }[] }
    expect(thread.people.length).toBeGreaterThan(0)
    const first = thread.people[0]!
    await box.click()
    await page.keyboard.type('@')
    const menu = panel.getByTestId('mention-menu')
    await expect(menu).toBeVisible()
    await expect(menu.getByTestId('mention-option')).toHaveCount(Math.min(8, thread.people.length))
    // never "@everyone" in a thread
    await expect(menu.locator('[data-all]')).toHaveCount(0)
    await page.keyboard.type(first.name.slice(0, 2))
    await expect(menu.getByTestId('mention-option').first()).toContainText(first.name)
    await page.keyboard.press('Enter')
    await expect(box).toHaveValue(`@${first.name} `)
    await expect(menu).toHaveCount(0)
    await page.keyboard.type('can you check the seal?')
    const sent = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/messages/${answerId}/thread`))
    await panel.getByTestId('chat-thread-send').click()
    expect((await sent).postDataJSON()).toMatchObject({ text: `@${first.name} can you check the seal?`, mentions: [first.id] })
    const text = panel.getByTestId('chat-thread-reply-text')
    await expect(text).toHaveText(`@${first.name} can you check the seal?`)
    await expect(text.locator('.text-accent-text').first()).toHaveText(`@${first.name}`)
    // (not with the list open: the rooms' shared "@" list has a button inside each option, axe's nested-interactive)
    await audit(page, `thread, a reply with a mention ${size.width}`)
  })
}
