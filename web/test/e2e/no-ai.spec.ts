// No AI answers the person (docs/DECISIONS.md "W2 — AI connection first"): Home shows one card instead of its top row,
// the suggestions and the line above the box, and "Claude 구독 연결" opens the simple dialog in place (the whole team,
// no name, the terms in one line, the password again). The mock team server always answers AI, so GET
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

test('the owner\'s Home without AI: one card; "Claude 구독 연결" opens the simple dialog, the whole team', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  await noAi(page, 'connect_team')
  await sharedClaude(page)
  await signIn(page)
  const card = page.getByTestId('no-ai-card')
  await expect(card).toContainText('AI를 먼저 연결해 주세요')
  await expect(page.getByTestId('ai-access-banner')).toHaveCount(0)
  await expect(page.getByTestId('welcome-resume')).toHaveCount(0)
  await expect(page.getByTestId('frequent-questions')).toHaveCount(0)
  await expect(page.getByTestId('composer-input')).toBeVisible()
  await card.getByTestId('welcome-ai-claude').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('claude-login-how')).toBeVisible()
  await expect(dialog.getByTestId('credential-label')).toHaveCount(0)
  await expect(dialog.getByText('그룹·사람 고르기')).toHaveCount(0)
  await expect(dialog.getByTestId('plan-notice')).toHaveText('이 계정·요금제를 이렇게 써도 되는지 제공사 약관을 확인했어요. Trina AX에서 그 허가를 줄 수는 없어요.')
  await expect(dialog.getByTestId('credential-password')).toBeVisible()
  await expect(dialog.getByTestId('credential-submit')).toBeDisabled()
  await dialog.getByTestId('plan-notice-ack').check()
  await dialog.getByTestId('credential-password').fill('correct horse battery')
  await expect(dialog.getByTestId('credential-submit')).toBeEnabled()
  // the bottom sheet on a phone: the button is reachable without leaving the dialog
  await dialog.getByTestId('credential-submit').scrollIntoViewIfNeeded()
  await expect(dialog.getByTestId('credential-submit')).toBeInViewport()
  expect(realErrors(errors)).toEqual([])
})

test('a member\'s Home without team AI: "팀장이 AI를 연결하면 바로 쓸 수 있어요", one ask, their own connection folded under it', async ({ page }) => {
  await reset(page)
  await noAi(page, 'connect_own')
  await signIn(page, BOB)
  const card = page.getByTestId('no-ai-card')
  await expect(card).toContainText('팀장이 AI를 연결하면 바로 쓸 수 있어요')
  await expect(card.getByTestId('ai-access-button')).toHaveText('팀장에게 알리기')
  await expect(page.getByTestId('first-time-folders')).toHaveCount(0)
  await card.getByTestId('no-ai-own').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('kind-anthropic-oauth')).toBeVisible()
  await expect(dialog.getByTestId('credential-password')).toHaveCount(0)
})
