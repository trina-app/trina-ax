// While the AI waits for the answer to its question (an ask_user card), the message box answers that question — the
// typed text is the person's own answer, like "Other" in Claude Code's AskUserQuestion — instead of waiting until the
// answer is done (which itself waits for the card). The server's safety checks are never answered from the box.
import path from 'node:path'
import { expect, test, type Page, type Request } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const lastAnswer = (page: Page) => page.getByTestId('assistant-message').last()
const shot = async (page: Page, name: string) => {
  if (process.env.SHOTS_DIR) await page.screenshot({ path: path.join(process.env.SHOTS_DIR, name) })
}
async function ask(page: Page, text: string) {
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('send').click()
}
const isAnswer = (r: Request) => r.method() === 'POST' && /^\/api\/turns\/[^/]+\/answer$/.test(new URL(r.url()).pathname)

test('the message box answers the open question with the typed text; files attached meanwhile stay', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await ask(page, 'please ask me something')
  const card = page.getByTestId('ask-card')
  await expect(card).toContainText('어느 분기를 볼까요?')
  const input = page.getByTestId('composer-input')
  // the box says that sending answers the question, and which one
  await expect(input).toHaveAttribute('placeholder', 'AI의 질문에 대한 답을 입력하세요')
  await expect(page.getByTestId('composer-answering')).toHaveText('보내면 이 질문에 대한 답이 돼요: 어느 분기를 볼까요?')
  await expect(input).toHaveAccessibleDescription('보내면 이 질문에 대한 답이 돼요: 어느 분기를 볼까요?')
  await page.getByTestId('file-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('q3 numbers') })
  await expect(page.getByTestId('attachment-chip')).toContainText('notes.txt')
  await expect(page.getByTestId('send-answer')).toHaveCount(0)
  await input.fill('3분기와 4분기 둘 다요')
  await expect(page.getByTestId('send-answer')).toHaveAttribute('aria-label', '답 보내기')
  await expect(page.getByTestId('send-later')).toHaveCount(0)
  await shot(page, 'ask-1-answer-from-message-box.png')
  const answered = page.waitForRequest(isAnswer)
  await input.press('Enter')
  expect((await answered).postDataJSON()).toEqual({ kind: 'ask_user', requestId: 'q1', answer: '3분기와 4분기 둘 다요' })
  await expect(card).toHaveCount(0)
  await expect(input).toHaveValue('')
  await expect(lastAnswer(page)).toContainText('You chose "3분기와 4분기 둘 다요"')
  // an answer, not a new message: nothing waits and the conversation still has one question
  await expect(page.getByTestId('outbox')).toHaveCount(0)
  await expect(page.getByTestId('user-message')).toHaveCount(1)
  await expect(page.getByTestId('composer-answering')).toHaveCount(0)
  // the attached file was not part of the answer: it is still in the box for the next message
  await expect(page.getByTestId('attachment-chip')).toContainText('notes.txt')
  await expect(input).toHaveAttribute('placeholder', '무엇이든 물어보세요')
  expect(realErrors(errors)).toEqual([])
})

test('a question that takes several answers: what is ticked on the card goes along with the typed text', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await ask(page, 'ask me with multi choice')
  const card = page.getByTestId('ask-card')
  await expect(card).toContainText('보고서에 어느 분기를 넣을까요?')
  await card.getByLabel('3분기').check()
  await page.getByTestId('composer-input').fill('연간 합계도요')
  const answered = page.waitForRequest(isAnswer)
  // phones make a new line with Enter: the button answers there
  await page.getByTestId('send-answer').click()
  expect((await answered).postDataJSON()).toEqual({ kind: 'ask_user', requestId: 'q1', answer: ['q3', '연간 합계도요'] })
  await expect(card).toHaveCount(0)
  await expect(lastAnswer(page)).toContainText('You chose ["q3","연간 합계도요"]')
})

test('a server safety check is never answered from the box: the message waits and the box says to choose first', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await ask(page, 'ask me a safety question')
  const card = page.getByTestId('ask-card')
  await expect(card).toHaveAttribute('data-origin', 'server')
  const input = page.getByTestId('composer-input')
  await expect(input).toHaveAttribute('placeholder', '먼저 위에서 골라 주세요. 지금 입력한 메시지는 답이 끝나면 보내요')
  await expect(page.getByTestId('composer-answering')).toHaveCount(0)
  let answers = 0
  page.on('request', (r) => {
    if (isAnswer(r)) answers++
  })
  await input.fill('allow')
  await input.press('Enter')
  await expect(page.getByTestId('outbox-item')).toHaveCount(1)
  await expect(card).toBeVisible()
  expect(answers).toBe(0)
  // the card's own buttons decide; then the waiting message goes
  await card.getByLabel('열지 않기').check()
  await card.getByRole('button', { name: '답하기' }).click()
  await expect(card).toHaveCount(0)
  await expect(page.getByTestId('user-text').last()).toHaveText('allow', { timeout: 20_000 })
  await expect(page.getByTestId('assistant-message').first()).toContainText('You chose "deny"')
})

test('answered in another window: the card and the answering box close here too, and the typed text stays', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await ask(page, 'please ask me something')
  await expect(page.getByTestId('ask-card')).toBeVisible()
  const other = await page.context().newPage()
  await other.goto(page.url())
  await expect(other.getByTestId('ask-card')).toContainText('어느 분기를 볼까요?')
  await expect(other.getByTestId('composer-answering')).toBeVisible()
  await other.getByTestId('composer-input').fill('나중에 쓸 메모')
  await page.getByTestId('composer-input').fill('4분기요')
  await page.getByTestId('composer-input').press('Enter')
  await expect(page.getByTestId('ask-card')).toHaveCount(0)
  await expect(other.getByTestId('ask-card')).toHaveCount(0)
  await expect(other.getByTestId('composer-answering')).toHaveCount(0)
  await expect(other.getByTestId('composer-input')).toHaveValue('나중에 쓸 메모')
  await expect(lastAnswer(page)).toContainText('You chose "4분기요"')
  await other.close()
})

test('an answer the server no longer takes (closed meanwhile) keeps the text and says why', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await ask(page, 'please ask me something')
  await expect(page.getByTestId('ask-card')).toBeVisible()
  // like server/src/routes/chats.ts when another window answered first or the card timed out
  await page.route('**/api/turns/*/answer', (route) => route.fulfill({ status: 409, json: { error: { code: 'conflict', message: '이미 답했거나 시간이 지난 질문입니다.' } } }))
  const input = page.getByTestId('composer-input')
  await input.fill('3분기요')
  await input.press('Enter')
  await expect(page.getByRole('alert').filter({ hasText: '이미 답했거나 시간이 지난 질문입니다.' })).toBeVisible()
  await expect(input).toHaveValue('3분기요')
  await expect(page.getByTestId('outbox')).toHaveCount(0)
  // still open here: answering again goes through
  await page.unroute('**/api/turns/*/answer')
  await input.press('Enter')
  await expect(page.getByTestId('ask-card')).toHaveCount(0)
  await expect(lastAnswer(page)).toContainText('You chose "3분기요"')
})
