// The AI engine and model are the admin's choice (Admin > AI 엔진): the composer's picker, "다른 모델로 다시 시도" and
// "내 기본 엔진/모델" only for the owner, admins and the people the admin allows; everyone else never sends a choice
// (the mock refuses it like the server). The admin screen sets who may pick and the Claude-limit fallback to Codex,
// with its OpenAI warning, unavailable while Codex is off.
import { expect, test, type Page } from '@playwright/test'
import { OWNER, realErrors, reset, signIn, watchConsole } from './helpers'

const BOB = { username: 'bob', password: 'bob password 1' }
async function ask(page: Page, text: string) {
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('send').click()
}
const lastAnswer = (page: Page) => page.getByTestId('assistant-message').last()
const engineRequests = async (page: Page) => (await (await page.request.post('/__test/engine-requests')).json()) as { name: string; user: string; engine?: string; model?: string }[]

test('a member who may not pick: no picker, plain retry only, no own default, and no engine is ever sent', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page, BOB)
  await expect(page.getByTestId('engine-picker')).toHaveCount(0)
  await ask(page, 'cause an error')
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'error')
  await expect(page.getByTestId('engine-picker')).toHaveCount(0)
  await expect(lastAnswer(page).getByTestId('retry')).toBeVisible()
  await expect(lastAnswer(page).getByTestId('retry-other-model')).toHaveCount(0)
  await lastAnswer(page).getByTestId('retry').click()
  await expect(page.getByTestId('assistant-message')).toHaveCount(1)
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'error')
  await page.goto('/settings/profile')
  await expect(page.getByRole('heading', { name: '테마' })).toBeVisible()
  await expect(page.getByTestId('my-engine')).toHaveCount(0)
  await expect(page.getByText('내 기본 엔진/모델')).toHaveCount(0)
  expect((await engineRequests(page)).filter((r) => r.user === 'bob')).toEqual([])
  // (the first-time folder card probes folders the member cannot see: those 404s are expected)
  expect(realErrors(errors).filter((e) => !/status of 404/.test(e))).toEqual([])
})

test('the owner picks: composer picker, "retry with another model", own default in Settings', async ({ page }) => {
  await reset(page)
  await signIn(page, OWNER)
  await expect(page.getByTestId('engine-picker')).toBeVisible()
  await page.getByTestId('engine-picker').click()
  await expect(page.getByRole('listbox', { name: 'AI 엔진' })).toContainText('Codex')
  await page.getByRole('option', { name: 'Opus' }).click()
  await expect(page.getByTestId('engine-picker')).toContainText('Claude · Opus')
  await ask(page, 'cause an error')
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'error')
  await expect(lastAnswer(page).getByTestId('retry')).toBeVisible()
  await lastAnswer(page).getByTestId('retry-other-model').click()
  await page.getByRole('listbox', { name: '다른 모델로 다시 시도' }).getByRole('option', { name: /Codex/ }).click()
  await expect.poll(async () => (await engineRequests(page)).map((r) => [r.name, r.engine ?? null])).toContainEqual(['regenerate', 'codex'])
  // own default for new chats
  await page.goto('/settings/profile')
  await expect(page.getByTestId('my-engine')).toBeVisible()
  await page.getByTestId('my-engine-select').selectOption('codex')
  await expect(page.getByTestId('my-engine-select')).toHaveValue('codex')
  await page.getByTestId('my-engine-select').selectOption('')
  await expect(page.getByTestId('my-model-select')).toHaveCount(0)
})

test('the admin lets a member pick; the member sees the picker without reloading; the fallback warns about OpenAI', async ({ page, browser }) => {
  await reset(page)
  await signIn(page, OWNER)
  // the member's window, signed in at the same time
  const ctx2 = await browser.newContext({ locale: 'ko-KR' })
  const bob = await ctx2.newPage()
  await signIn(bob, BOB)
  await expect(bob.getByTestId('engine-picker')).toHaveCount(0)

  await page.goto('/admin/engines')
  const card = page.getByTestId('engine-choice')
  await expect(card).toContainText('팀원이 엔진 고르기 허용')
  await expect(page.getByTestId('engine-choice-off')).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('engine-choice-selected').click()
  await card.getByLabel('Bob').check()
  // the fallback: off by default; turning it on shows the OpenAI warning before saving
  const fallback = card.getByLabel('Claude 한도에 닿으면 Codex로 넘기기')
  await expect(fallback).not.toBeChecked()
  await expect(page.getByTestId('fallback-warning')).toHaveCount(0)
  await card.getByText('Claude 한도에 닿으면 Codex로 넘기기').click()
  await expect(page.getByTestId('fallback-warning')).toContainText('OpenAI')
  await page.getByTestId('engine-choice-save').click()

  // bob's open window switches to showing the picker (realtime notice -> /api/me again)
  await expect(bob.getByTestId('engine-picker')).toBeVisible()
  await bob.goto('/settings/profile')
  await expect(bob.getByTestId('my-engine')).toBeVisible()

  // Codex off: the fallback is off and cannot be turned on
  await page.reload()
  await expect(card.getByLabel('Claude 한도에 닿으면 Codex로 넘기기')).toBeChecked()
  await page.getByTestId('engine-card').filter({ hasText: 'Codex' }).getByText('사용', { exact: true }).click()
  await expect(card.getByLabel('Claude 한도에 닿으면 Codex로 넘기기')).toBeDisabled()
  await expect(card.getByLabel('Claude 한도에 닿으면 Codex로 넘기기')).not.toBeChecked()
  await expect(card).toContainText('Codex가 꺼져 있어 켤 수 없어요')
  await ctx2.close()
})
