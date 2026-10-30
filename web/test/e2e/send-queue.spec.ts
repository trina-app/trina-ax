// Messages typed while an answer runs: they wait under the conversation ("waiting to send"), can be edited or taken
// back, go out together when the answer is done, and stay (paused, with "Send now") when the person stops it.
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const SLOW = 'slow answer please, slow slow slow slow slow slow slow slow slow slow'
const lastAnswer = (page: Page) => page.getByTestId('assistant-message').last()
const shot = async (page: Page, name: string) => {
  if (process.env.SHOTS_DIR) await page.screenshot({ path: path.join(process.env.SHOTS_DIR, name) })
}

async function startSlow(page: Page) {
  await page.getByTestId('composer-input').fill(SLOW)
  await page.getByTestId('send').click()
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/)
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'streaming')
}

test('typing during a running answer: the message waits, then goes by itself when the answer is done', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await startSlow(page)
  const input = page.getByTestId('composer-input')
  // the box stays usable: Stop, and once there is text the "send when done" button next to it
  await expect(input).toBeEnabled()
  await expect(input).toHaveAttribute('placeholder', '다음 메시지를 입력하세요. 답이 끝나면 보내요')
  await expect(page.getByTestId('send-later')).toHaveCount(0)
  await input.fill('also add a short summary')
  await expect(page.getByTestId('send-later')).toBeVisible()
  await expect(page.getByTestId('stop')).toBeVisible()
  await input.press('Enter')
  await expect(input).toHaveValue('')
  const outbox = page.getByTestId('outbox')
  await expect(outbox.getByTestId('outbox-text')).toHaveText('also add a short summary')
  await expect(outbox.getByTestId('outbox-status')).toHaveText('답이 끝나면 보낼게요.')
  await expect(outbox.getByTestId('outbox-status')).toHaveAttribute('aria-live', 'polite')
  // nothing reached the server yet: still one question in the conversation
  await expect(page.getByTestId('user-message')).toHaveCount(1)
  await shot(page, '1-queued-while-answering.png')
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done', { timeout: 20_000 })
  await expect(page.getByTestId('user-text').last()).toHaveText('also add a short summary')
  await expect(outbox).toHaveCount(0)
  await expect(lastAnswer(page)).toContainText('Here is the answer for: also add a short summary')
  await expect(page.getByTestId('user-message')).toHaveCount(2)
  expect(realErrors(errors)).toEqual([])
})

test('waiting messages can be edited and taken back; the rest go together as one message', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await startSlow(page)
  const input = page.getByTestId('composer-input')
  for (const text of ['frist follow-up', 'not this one', 'third follow-up']) {
    await input.fill(text)
    await page.getByTestId('send-later').click()
  }
  const items = page.getByTestId('outbox-item')
  await expect(items).toHaveCount(3)
  await expect(page.getByTestId('outbox-status')).toHaveText('답이 끝나면 3개를 한 메시지로 함께 보낼게요.')
  // edit with the keyboard: Enter saves, focus goes back to the edit button
  await items.nth(0).getByTestId('outbox-edit').click()
  const edit = page.getByTestId('outbox-edit-input')
  await expect(edit).toBeFocused()
  await edit.fill('first follow-up')
  await edit.press('Enter')
  await expect(items.nth(0).getByTestId('outbox-text')).toHaveText('first follow-up')
  await expect(items.nth(0).getByTestId('outbox-edit')).toBeFocused()
  // Escape leaves an edit unchanged
  await items.nth(2).getByTestId('outbox-edit').click()
  await page.getByTestId('outbox-edit-input').fill('changed my mind')
  await page.getByTestId('outbox-edit-input').press('Escape')
  await expect(items.nth(2).getByTestId('outbox-text')).toHaveText('third follow-up')
  // take one back: focus moves to the next one's button
  await items.nth(1).getByTestId('outbox-remove').click()
  await expect(items).toHaveCount(2)
  await expect(items.nth(1).getByTestId('outbox-remove')).toBeFocused()
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done', { timeout: 20_000 })
  await expect(page.getByTestId('user-text').last()).toHaveText('first follow-up\n\nthird follow-up')
  await expect(page.getByTestId('outbox')).toHaveCount(0)
  await expect(page.getByText('not this one')).toHaveCount(0)
})

test('Stop keeps the waiting message, paused with "Send now"; it survives a reload', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await startSlow(page)
  await page.getByTestId('composer-input').fill('then do the next part')
  await page.getByTestId('composer-input').press('Enter')
  await expect(page.getByTestId('outbox-item')).toHaveCount(1)
  await page.getByTestId('stop').click()
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'stopped')
  const outbox = page.getByTestId('outbox')
  await expect(outbox).toHaveAttribute('data-paused', 'stopped')
  await expect(outbox.getByTestId('outbox-status')).toHaveText('답변을 멈춰서 아직 보내지 않았어요.')
  await expect(page.getByTestId('user-message')).toHaveCount(1)
  await shot(page, '1b-queued-paused-after-stop.png')
  await page.reload()
  await expect(page.getByTestId('outbox')).toHaveAttribute('data-paused', 'stopped')
  await page.getByTestId('outbox-send-now').click()
  await expect(page.getByTestId('composer-input')).toBeFocused()
  await expect(page.getByTestId('user-text').last()).toHaveText('then do the next part')
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done', { timeout: 20_000 })
  await expect(page.getByTestId('outbox')).toHaveCount(0)
})

test('a reload while the answer runs keeps the waiting message, and it still goes when the answer is done', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await startSlow(page)
  await page.getByTestId('composer-input').fill('kept across a reload')
  await page.getByTestId('composer-input').press('Enter')
  await expect(page.getByTestId('outbox-item')).toHaveCount(1)
  await page.reload()
  await expect(page.getByTestId('outbox-text')).toHaveText('kept across a reload')
  await expect(page.getByTestId('user-text').last()).toHaveText('kept across a reload', { timeout: 20_000 })
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done', { timeout: 20_000 })
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('Enter makes a new line; the clock button next to Stop makes the message wait', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await startSlow(page)
    const input = page.getByTestId('composer-input')
    await input.fill('from my phone')
    await input.press('Enter')
    await expect(input).toHaveValue('from my phone\n')
    await page.getByTestId('send-later').tap()
    await expect(page.getByTestId('outbox-text')).toHaveText('from my phone')
    await expect(page.getByTestId('user-text').last()).toHaveText('from my phone', { timeout: 20_000 })
  })
})
