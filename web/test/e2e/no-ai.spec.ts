// No AI answers the person (docs/DECISIONS.md "W2 — AI connection first"): Home shows one quiet line under the greeting
// (QA TC-5447) instead of its top row, the suggestions and the line above the box, and "Claude 연결하기" opens the simple
// dialog in place (the whole team,
// no name, the terms in one line, no password). The mock team server always answers AI, so GET
// /api/me/ai-access is answered here as a team with no connection.
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn, watchConsole, realErrors } from './helpers'

const BOB = { username: 'bob', password: 'bob password 1' }
const noAi = (page: Page, action: 'connect_team' | 'ask_owner' | 'connect_own') =>
  page.route('**/api/me/ai-access', (r) => r.fulfill({ json: { usable: false, action, requested: false } }))
/** the team allows a shared Claude subscription (the mock's team does not): Claude is the one primary way */
const sharedClaude = (page: Page) => page.route('**/api/admin/credentials', async (r) => {
  const res = await r.fetch()
  r.fulfill({ response: res, json: { ...(await res.json()), sharedSubscriptions: true } })
})

test.use({ viewport: { width: 390, height: 844 } })

test('the owner\'s Home without AI: one line under the greeting, one button; "Claude 연결하기" opens the simple dialog, the whole team', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  await noAi(page, 'connect_team')
  await sharedClaude(page)
  await signIn(page)
  const card = page.getByTestId('no-ai-card')
  await expect(page.getByTestId('no-ai-line')).toHaveText('AI를 연결하면 바로 시작할 수 있어요.')
  await expect(page.getByTestId('ai-access-banner')).toHaveCount(0)
  await expect(page.getByTestId('welcome-resume')).toHaveCount(0)
  await expect(page.getByTestId('often-asked')).toHaveCount(0)
  await expect(page.getByTestId('composer-input')).toBeVisible()
  // one line, one main button, the rest under "다른 방법": under the greeting, over the box, nothing on top of the page
  await expect(card.getByRole('button')).toHaveText(['Claude 연결하기', '다른 방법'])
  await expect(page.getByTestId('home-top').getByTestId('no-ai-card')).toHaveCount(0)
  const y = async (id: string) => (await page.getByTestId(id).first().boundingBox())!.y
  const h1 = (await page.locator('h1').boundingBox())!.y
  expect(h1).toBeLessThan(await y('no-ai-card'))
  expect(await y('no-ai-card')).toBeLessThan(await y('composer-input'))
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  // typed anyway: not sent, a line under the box says why, the text stays
  await page.getByTestId('composer-input').fill('이번 주 회의록 정리해 줘')
  await expect(page.getByTestId('composer-blocked')).toHaveText('AI를 연결해야 보낼 수 있어요. 쓴 글은 그대로 둘게요.')
  await expect(page.getByTestId('send')).toBeDisabled()
  await page.getByTestId('send').click({ force: true })
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId('composer-input')).toHaveValue('이번 주 회의록 정리해 줘')
  await page.getByTestId('composer-input').fill('')
  // "다른 방법" › "API 키로 연결": the same dialog with only the two keys to pick from
  await page.getByTestId('no-ai-other').click()
  await page.getByRole('menuitem', { name: 'API 키로 연결' }).click()
  await expect(page.getByRole('dialog').getByTestId('kind-anthropic-api-key')).toBeVisible()
  await expect(page.getByRole('dialog').getByTestId('kind-openai-api-key')).toBeVisible()
  await expect(page.getByRole('dialog').getByTestId('kind-chatgpt')).toHaveCount(0)
  await page.getByRole('dialog').getByRole('button', { name: '취소' }).click()
  await card.getByTestId('welcome-ai-claude').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('claude-login-how')).toBeVisible()
  await expect(dialog.getByTestId('credential-label')).toHaveCount(0)
  await expect(dialog.getByText('부서·사람 고르기')).toHaveCount(0)
  await expect(dialog.getByTestId('plan-notice')).toHaveText('이 계정·요금제를 이렇게 써도 되는지 제공사 약관을 확인했어요. Trina AX에서 그 허가를 줄 수는 없어요.')
  await expect(dialog.getByTestId('credential-password')).toHaveCount(0)
  await expect(dialog.getByTestId('credential-submit')).toBeDisabled()
  await dialog.getByTestId('plan-notice-ack').check()
  await expect(dialog.getByTestId('credential-submit')).toBeEnabled()
  // the bottom sheet on a phone: the button is reachable without leaving the dialog
  await dialog.getByTestId('credential-submit').scrollIntoViewIfNeeded()
  await expect(dialog.getByTestId('credential-submit')).toBeInViewport()
  expect(realErrors(errors)).toEqual([])
})

test('a member\'s Home without team AI: "아직 쓸 수 있는 AI가 없어요", one ask, their own connection beside it', async ({ page }) => {
  await reset(page)
  await noAi(page, 'connect_own')
  await signIn(page, BOB)
  const card = page.getByTestId('no-ai-card')
  await expect(card.getByTestId('no-ai-line')).toHaveText('아직 쓸 수 있는 AI가 없어요.')
  await expect(card.getByTestId('ai-access-button')).toHaveText('팀장·관리자에게 연결 요청하기')
  await page.getByTestId('composer-input').fill('견적서 만들어 줘')
  await expect(page.getByTestId('composer-blocked')).toHaveText('AI가 연결되면 보낼 수 있어요. 쓴 글은 그대로 둘게요.')
  await page.getByTestId('composer-input').fill('')
  // nothing prepared and no AI: no block (its question would need the AI)
  await expect(page.getByTestId('team-prepared')).toHaveCount(0)
  await card.getByTestId('no-ai-own').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('kind-anthropic-oauth')).toBeVisible()
  await expect(dialog.getByTestId('credential-password')).toHaveCount(0)
})
