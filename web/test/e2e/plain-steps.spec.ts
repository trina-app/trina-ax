// The steps list under an answer in plain words (shared/src/step-labels.ts, docs/DECISIONS.md "Plain words in errors,
// cards and steps"): an AI switch without engine names or model ids, a connection's step by its tool's title without
// the AI's arguments, a tool without words of its own as its id in words, no raw ids. The mock writes the steps with
// the server's own helpers.
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'

async function ask(page: Page, text: string) {
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('send').click()
}

test('the steps list reads in plain words, in Korean and after a switch to English', async ({ page }) => {
  await reset(page)
  await signIn(page, { username: 'bob', password: 'bob password 1' })
  await ask(page, 'plainsteps please')
  const answer = page.getByTestId('assistant-message').last()
  await expect(answer).toHaveAttribute('data-status', 'done')
  const steps = answer.getByTestId('steps')
  await steps.getByRole('button').first().click()
  for (const line of [
    '고른 AI를 지금 쓸 수 없어 팀 기본 AI로 답해요',
    'AI가 답하지 않아 다른 AI로 다시 답해요',
    '자료 지도에서 찾기 "견적"',
    'Tasks · 할 일 만들기',
    'Tasks · 보내기',
    'Todo write',
    '화면 만들기 · 매출 차트',
    '예약 작업 지우기',
  ]) await expect(steps).toContainText(line)
  for (const raw of ['Claude Code', 'Codex', 'claude-opus', 'create_task', 'TodoWrite', 'POST', '/v1/', '0193a1b2', '엔진', '아티팩트', '지식 그래프']) await expect(steps).not.toContainText(raw)
  // the same steps follow the language on screen
  const chat = page.url()
  await page.goto('/settings/profile')
  await page.getByTestId('locale-en').click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await page.goto(chat)
  const again = page.getByTestId('assistant-message').last().getByTestId('steps')
  await again.getByRole('button').first().click()
  await expect(again).toContainText("The chosen AI is off; answering with the team's default AI")
  await expect(again).toContainText('The AI declined; trying again with another AI')
  await expect(again).toContainText('Make a page · 매출 차트')
})
