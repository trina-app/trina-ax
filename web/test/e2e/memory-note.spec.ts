// A long conversation: when the AI got only the recent part of it (the history a fresh session gets is cut at 40,000
// characters), the newest answer says so in a small note. The mock computes it like the server's fresh sessions.
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const lastAnswer = (page: Page) => page.getByTestId('assistant-message').last()
const NOTES = '회의록: 채용 기준은 경력 3년 이상, 포트폴리오 필수, 면접은 두 번. 다음 주까지 지원서 40개를 정리한다.\n'

test('a long conversation: the newest answer notes that only the recent part is remembered', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  const input = page.getByTestId('composer-input')
  await input.fill(NOTES.repeat(Math.ceil(41_000 / NOTES.length)))
  await page.getByTestId('send').click()
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/)
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done', { timeout: 20_000 })
  // the first answer got all of it (it was the message itself, not history)
  await expect(page.getByTestId('memory-note')).toHaveCount(0)
  await input.fill('아까 정한 채용 기준대로 정리해 줘')
  await page.getByTestId('send').click()
  await expect(page.getByTestId('assistant-message')).toHaveCount(2)
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done', { timeout: 20_000 })
  const note = lastAnswer(page).getByTestId('memory-note')
  await expect(note).toHaveText('대화가 길어 앞부분 일부만 기억하고 있어요. 중요한 내용은 다시 알려 주거나, 요약해서 새 채팅에서 이어 가세요.')
  await expect(note).toHaveAttribute('role', 'note')
  // small and calm: not an alert, not an error
  await expect(lastAnswer(page).getByRole('alert')).toHaveCount(0)
  if (process.env.SHOTS_DIR) {
    await note.scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(process.env.SHOTS_DIR, '3-long-conversation-memory-note.png') })
  }
  // only the newest answer carries it: after the next one, it moved there
  await input.fill('고마워요')
  await page.getByTestId('send').click()
  await expect(page.getByTestId('assistant-message')).toHaveCount(3)
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done', { timeout: 20_000 })
  await expect(page.getByTestId('memory-note')).toHaveCount(1)
  await expect(lastAnswer(page).getByTestId('memory-note')).toBeVisible()
  await page.reload()
  await expect(lastAnswer(page).getByTestId('memory-note')).toBeVisible()
  expect(realErrors(errors)).toEqual([])
})
