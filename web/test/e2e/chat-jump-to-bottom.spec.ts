// QA AP-043: in an AI chat, a reader who scrolled up far from the newest message gets a round down-arrow button above
// the message box (like claude.ai). It takes them to the bottom, the list follows again and the button goes away. At
// the bottom it never shows.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const post = (page: Page, p: string, data: object) => page.request.post(p, { headers: { [CSRF_HEADER]: '1' }, data })
const gap = (list: ReturnType<Page['getByTestId']>) => list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)

test('a chat scrolled up shows the jump-to-bottom button; it goes to the newest answer and hides', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const chat = (await (await post(page, '/api/chats', {})).json()) as { id: string }
  // "long list": an answer of 400 lines, much taller than the screen
  expect((await post(page, `/api/chats/${chat.id}/messages`, { content: 'long list', clientMessageId: uuidv7() })).status()).toBe(202)
  await expect.poll(async () => ((await (await page.request.get(`/api/chats/${chat.id}`)).json()) as { runState: string }).runState).toBe('idle')
  await page.goto(`/c/${chat.id}`)
  const list = page.getByTestId('messages'), jump = page.getByTestId('chat-to-bottom')
  await expect(page.getByTestId('assistant-message')).toHaveCount(1)
  await expect.poll(() => gap(list)).toBeLessThanOrEqual(1)
  await expect(jump).toBeHidden()
  await list.evaluate((el) => { el.scrollTop = 0 })
  await expect(jump).toBeVisible()
  await expect(jump).toHaveAccessibleName(/최신 메시지로 이동/)
  await jump.click()
  await expect.poll(() => gap(list)).toBeLessThanOrEqual(1)
  await expect(jump).toBeHidden()
})
