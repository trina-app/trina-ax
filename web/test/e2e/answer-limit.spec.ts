// An answer that reached the per-answer limit (tool calls or time) is not an error: it says it paused, and
// "이어서 하기" sends a continuation in the same chat (the mock scripts the limit with "cap-tools" / "cap-time").
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const lastAnswer = (page: Page) => page.getByTestId('assistant-message').last()
const shot = async (page: Page, name: string) => {
  if (process.env.SHOTS_DIR) await page.screenshot({ path: path.join(process.env.SHOTS_DIR, name) })
}
async function ask(page: Page, text: string) {
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('send').click()
}

test('tool-call limit: the answer says it paused, and "이어서 하기" continues in the same chat', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await ask(page, 'cap-tools sort these 40 applications')
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
  const paused = lastAnswer(page).getByTestId('answer-paused')
  await expect(paused).toHaveAttribute('data-reason', 'tool_limit')
  await expect(paused).toHaveAttribute('role', 'status')
  await expect(paused).toContainText('작업이 길어서 여기서 멈췄어요.')
  await expect(paused).toContainText('한 번의 답변에서 쓸 수 있는 작업 단계를 다 썼어요.')
  // told apart from an error and from a stop by the person
  await expect(lastAnswer(page).getByTestId('answer-error')).toHaveCount(0)
  await expect(lastAnswer(page)).not.toContainText('중지됨')
  await expect(page.getByTestId('continue')).toHaveText('이어서 하기')
  await shot(page, '2-paused-at-limit-continue.png')
  const sent = page.waitForRequest((r) => r.method() === 'POST' && /\/api\/chats\/[^/]+\/messages$/.test(new URL(r.url()).pathname))
  await page.getByTestId('continue').click()
  expect((await sent).postDataJSON()).toMatchObject({ content: '이어서 해 주세요.', attachmentIds: [] })
  await expect(page.getByTestId('composer-input')).toBeFocused()
  await expect(page.getByTestId('user-text').last()).toHaveText('이어서 해 주세요.')
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
  await expect(lastAnswer(page).getByTestId('answer-paused')).toHaveCount(0)
  // the paused answer keeps its note (history), without the button
  await expect(page.getByTestId('answer-paused')).toHaveCount(1)
  await expect(page.getByTestId('continue')).toHaveCount(0)
  // after a reload the note comes back from the server's stored answer
  await page.reload()
  await expect(page.getByTestId('answer-paused')).toHaveAttribute('data-reason', 'tool_limit')
  expect(realErrors(errors)).toEqual([])
})

test('time limit: its own words; a waiting message still goes when the paused answer ends', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await ask(page, 'slow cap-time go through the whole folder, slow slow slow slow slow')
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'streaming')
  await page.getByTestId('composer-input').fill('then email me the summary')
  await page.getByTestId('composer-input').press('Enter')
  await expect(page.getByTestId('outbox-item')).toHaveCount(1)
  await expect(page.getByTestId('user-text').last()).toHaveText('then email me the summary', { timeout: 20_000 })
  const paused = page.getByTestId('answer-paused')
  await expect(paused).toHaveAttribute('data-reason', 'time_limit')
  await expect(paused).toContainText('한 번의 답변에 쓸 수 있는 시간을 다 썼어요.')
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
  await expect(page.getByTestId('continue')).toHaveCount(0)
})
