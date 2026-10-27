import { expect, test } from '@playwright/test'
import { reset, signIn, watchConsole, realErrors } from './helpers'

test('estimated queue rank survives reload and another window, then updates and disappears when running', async ({ page, context }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.getByTestId('composer-input').fill('queue-hold synthetic question')
  await page.getByTestId('send').click()
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/)
  const chatUrl = page.url(), chatId = chatUrl.split('/').at(-1)!
  await expect(page.getByTestId('queue-position')).toContainText('현재 예상 순서 3')
  await expect(page.getByTestId('queue-position')).toContainText('순서가 바뀔 수 있어요')
  await page.reload()
  await expect(page.getByTestId('queue-position')).toContainText('현재 예상 순서 3')
  const second = await context.newPage()
  await second.goto(chatUrl)
  await expect(second.getByTestId('queue-position')).toContainText('현재 예상 순서 3')
  await page.request.post('/__test/queue', { data: { chatId, position: 2 } })
  await expect(page.getByTestId('queue-position')).toContainText('현재 예상 순서 2')
  await expect(second.getByTestId('queue-position')).toContainText('현재 예상 순서 2')
  await page.request.post('/__test/queue', { data: { chatId, position: 0 } })
  await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done')
  await expect(page.getByTestId('queue-position')).toHaveCount(0)
  await expect(second.getByTestId('queue-position')).toHaveCount(0)
  expect(realErrors(errors)).toEqual([])
  await second.close()
})
