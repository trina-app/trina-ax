// While Trina updates (QA TC-2260): the update's stand-in answers every call with 503 + x-mycel-updating
// (server/src/system/migrate-start.ts), played here with page.route. The window knows it (lib/serverUpdating.ts), asks
// /api/health until it answers, and then:
// - a message sent meanwhile waits on screen with "Trina is updating…" (never "not sent") and goes once, by itself;
// - the Share dialog says Trina is updating, keeps the picks and saves by itself.
// (The page a browser gets for a link meanwhile is the server's: tests/unit/updating-page.test.ts,
// tests/unit/p1-migrate-start.test.ts.)
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { ko } from '../../src/i18n/ko'

const H = { [CSRF_HEADER]: '1' }
const UPDATING = {
  status: 503,
  headers: { 'content-type': 'application/json', 'x-mycel-updating': '1', 'retry-after': '30', 'cache-control': 'no-store' },
  body: JSON.stringify({ error: { code: 'unavailable', message: 'Trina is updating. It will be back in a few minutes.', params: { reason: 'updating' } } }),
}
const HEALTH_UPDATING = { ...UPDATING, headers: { ...UPDATING.headers, 'retry-after': '10' }, body: JSON.stringify({ ok: false, status: 'migrating', time: new Date().toISOString() }) }

/** an update starts: these calls (and /api/health) answer "updating" until `done` */
async function updateWindow(page: Page, url: string, method: string) {
  const handler = (r: Parameters<Parameters<Page['route']>[1]>[0]) => (r.request().method() === method ? r.fulfill(UPDATING) : r.fallback())
  const health = (r: Parameters<Parameters<Page['route']>[1]>[0]) => r.fulfill(HEALTH_UPDATING)
  await page.route(url, handler)
  await page.route('**/api/health', health)
  return { done: async () => { await page.unroute(url, handler); await page.unroute('**/api/health', health) } }
}

async function chatWithAnswer(page: Page) {
  const chat = (await (await page.request.post('/api/chats', { headers: H, data: {} })).json()) as { id: string }
  expect((await page.request.post(`/api/chats/${chat.id}/messages`, { headers: H, data: { content: '예산 요약해 줘', clientMessageId: uuidv7() } })).status()).toBe(202)
  await expect.poll(async () => ((await (await page.request.get(`/api/chats/${chat.id}`)).json()) as { runState: string }).runState).toBe('idle')
  await page.goto(`/c/${chat.id}`)
  await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'done')
  return chat.id
}

test('a message sent while Trina updates waits with a note and is sent once, by itself, when it is back', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const chatId = await chatWithAnswer(page)
  const update = await updateWindow(page, `**/api/chats/${chatId}/messages`, 'POST')
  await page.getByTestId('composer-input').fill('업데이트 중에 보낸 메시지')
  await page.getByTestId('send').click()
  const note = page.getByTestId('send-waiting-update')
  await expect(note).toBeVisible()
  await expect(note).toContainText(ko['conn.updatingUnsent'])
  await expect(page.getByTestId('send-failed')).toHaveCount(0)
  await expect(page.locator('main [role="alert"]')).toHaveCount(0)
  // the box is free: the text went with the message
  await expect(page.getByTestId('composer-input')).toHaveValue('')
  // the update is done: no click, the next health check (4 s) sends it
  await update.done()
  await expect(note).toHaveCount(0, { timeout: 15_000 })
  await expect.poll(async () => ((await (await page.request.get(`/api/chats/${chatId}`)).json()) as { runState: string }).runState, { timeout: 15_000 }).toBe('idle')
  const items = ((await (await page.request.get(`/api/chats/${chatId}/messages`)).json()) as { items: { role: string; content: string }[] }).items
  expect(items.filter((m) => m.role === 'user' && m.content === '업데이트 중에 보낸 메시지')).toHaveLength(1)
  await expect(page.getByTestId('user-text').filter({ hasText: '업데이트 중에 보낸 메시지' })).toHaveCount(1)
})

test('saving Share while Trina updates says so, keeps the picks and saves by itself when it is back', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const chatId = await chatWithAnswer(page)
  await page.getByTestId('chat-menu').click()
  await page.getByTestId('chat-share').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('chat-share-picker')).toBeVisible()
  await page.getByTestId('chat-share-picker-search').fill('Bob')
  await page.getByTestId('participant-add-user-bob').click()
  const update = await updateWindow(page, `**/api/chats/${chatId}/audience`, 'PUT')
  await dialog.getByTestId('chat-share-save').click()
  const line = dialog.getByTestId('chat-share-updating')
  await expect(line).toBeVisible()
  await expect(line).toContainText(ko['chat.share.updating'])
  await expect(dialog.getByTestId('chat-share-error')).toHaveCount(0)
  await expect(dialog.getByTestId('participant-user-bob')).toHaveAttribute('data-state', 'new')
  await update.done()
  await expect(page.getByTestId('toast').filter({ hasText: '1명과 공유했어요' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
