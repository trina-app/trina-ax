// Admin > AI connections against the mock server (docs/DECISIONS.md "AI 연결" 3.13): a Claude subscription token (the
// steps, the plan notice that must be confirmed, the password again), an API key, a ChatGPT sign-in with its address
// and code, the order, a member's own connections in Settings, and the https-only note where the browser cannot seal.
// The mock opens the sealed values with the server's real sealing code, so a value sealed wrongly fails here.
import { expect, test } from '@playwright/test'
import { OWNER, realErrors, reset, signIn, watchConsole } from './helpers'

const TOKEN = 'sk-ant-oat01-' + 'e2e'.repeat(15)
const KEY = 'sk-ant-api03-' + 'k'.repeat(40) + 'WXYZ'

test('owner adds a Claude subscription, an API key and a ChatGPT plan; orders them', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/admin/credentials')
  await expect(page.getByRole('heading', { name: 'AI 연결' }).first()).toBeVisible()
  await expect(page.getByTestId('credentials-claude')).toHaveCount(0)

  // Sharing is off until the owner reads and confirms the warning. Cancelling does not opt in.
  const sharing = page.getByTestId('shared-subscriptions-setting').getByRole('checkbox')
  await expect(sharing).not.toBeChecked()
  await page.getByTestId('credential-add').click()
  await expect(page.getByTestId('kind-anthropic-oauth')).toBeDisabled()
  await expect(page.getByTestId('kind-chatgpt')).toBeDisabled()
  await page.getByRole('dialog').getByRole('button', { name: '취소' }).click()
  await sharing.press('Space')
  await expect(page.getByRole('dialog')).toContainText('공유')
  await page.getByRole('dialog').getByRole('button', { name: '취소' }).click()
  await expect(sharing).not.toBeChecked()
  const optIn = page.waitForRequest((r) => r.url().endsWith('/api/admin/credential-settings') && r.method() === 'PATCH')
  await sharing.press('Space')
  await page.getByRole('dialog').getByRole('button').last().click()
  expect((await optIn).postDataJSON()).toEqual({ sharedSubscriptions: true, acknowledgedSharedSubscriptionRisk: true })
  await expect(sharing).toBeChecked()

  // Claude subscription: steps with copyable commands, the plan notice must be ticked, the password again
  await page.getByTestId('credential-add').click()
  const dialog = page.getByRole('dialog')
  // API keys come first for each engine
  const kinds = await dialog.locator('input[name="kind"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
  expect(kinds).toEqual(['kind-anthropic-api-key', 'kind-anthropic-oauth', 'kind-openai-api-key', 'kind-chatgpt'])
  await page.getByTestId('kind-anthropic-oauth').check()
  await expect(page.getByTestId('setup-token-steps')).toContainText('claude setup-token')
  await page.getByTestId('credential-label').fill('대표 Max')
  await page.getByTestId('credential-secret').fill('not-a-token')
  await expect(dialog).toContainText('sk-ant-oat01-로 시작하는 토큰 전체')
  await page.getByTestId('credential-secret').fill(TOKEN)
  await page.getByTestId('credential-password').fill(OWNER.password)
  await expect(page.getByTestId('credential-submit')).toBeDisabled()
  await expect(page.getByTestId('plan-notice')).toContainText('제공사 약관에 따라 목적에 맞는 사용을 허용하는지 확인하세요. 트리나가 그 허가를 줄 수는 없어요.')
  await page.getByTestId('plan-notice-ack').check()
  await page.getByTestId('credential-submit').click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('credentials-claude')).toContainText('대표 Max')
  await expect(page.getByTestId('credentials-claude')).toContainText('정상')
  // the token is never shown again
  await expect(page.locator('body')).not.toContainText(TOKEN)

  // an API key: no plan notice, the last four characters as a hint
  await page.getByTestId('credential-add').click()
  await page.getByTestId('kind-anthropic-api-key').check()
  await expect(page.getByTestId('plan-notice')).toHaveCount(0)
  await page.getByTestId('credential-label').fill('회사 키')
  await page.getByTestId('credential-secret').fill(KEY)
  await page.getByTestId('credential-password').fill(OWNER.password)
  await page.getByTestId('credential-submit').click()
  await expect(page.getByTestId('credentials-claude').getByTestId('credential-row')).toHaveCount(2)
  await expect(page.getByTestId('credentials-claude')).toContainText('…WXYZ')

  // order: the key moves above the subscription
  const labels = () => page.getByTestId('credentials-claude').getByTestId('credential-row').evaluateAll((rows) => rows.map((r) => r.querySelector('.font-medium')?.textContent))
  expect(await labels()).toEqual(['대표 Max', '회사 키'])
  await page.getByTestId('credentials-claude').getByRole('button', { name: '위로' }).click()
  await expect.poll(labels).toEqual(['회사 키', '대표 Max'])

  // ChatGPT: the address and the one-time code, then connected
  await page.getByTestId('credential-add').click()
  await page.getByTestId('kind-chatgpt').check()
  await page.getByTestId('credential-label').fill('팀 ChatGPT')
  await page.getByTestId('plan-notice-ack').check()
  await page.getByTestId('credential-password').fill(OWNER.password)
  await page.getByTestId('credential-submit').click()
  await expect(page.getByTestId('chatgpt-user-code')).toHaveText('WXYZ-12AB3')
  await expect(page.getByTestId('chatgpt-code')).toContainText('https://auth.openai.com/codex/device')
  await expect(page.getByTestId('chatgpt-done')).toContainText('ChatGPT pro')
  await page.getByRole('dialog').getByRole('button', { name: '완료' }).click()
  await expect(page.getByTestId('credentials-codex')).toContainText('팀 ChatGPT')
  await sharing.press('Space')
  await expect(sharing).not.toBeChecked()
  await expect(page.getByTestId('credentials-claude')).toContainText('공유 꺼짐')
  await expect(page.getByTestId('credentials-codex')).toContainText('공유 꺼짐')
  expect(realErrors(errors)).toEqual([])
})

test('personal connections are available by default, prefer subscriptions, and preserve an owner opt-out', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/admin/credentials')
  await expect(page.getByRole('checkbox', { name: '팀원이 자기 AI 연결을 추가할 수 있게 하기' })).toBeChecked()
  await page.goto('/settings')
  await page.getByRole('link', { name: 'AI 연결' }).click()
  await page.getByTestId('my-credential-add').click()
  const kinds = await page.getByRole('dialog').locator('input[name="kind"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
  expect(kinds).toEqual(['kind-anthropic-oauth', 'kind-anthropic-api-key', 'kind-chatgpt', 'kind-openai-api-key'])
  await expect(page.getByTestId('kind-anthropic-oauth')).toBeEnabled()
  await expect(page.getByTestId('kind-chatgpt')).toBeEnabled()
  await page.getByTestId('kind-anthropic-api-key').check()
  await expect(page.getByTestId('credential-password')).toHaveCount(0) // one's own: no password again
  await page.getByTestId('credential-label').fill('내 키')
  await page.getByTestId('credential-secret').fill(KEY.replace('WXYZ', 'MINE'))
  await page.getByTestId('credential-submit').click()
  await expect(page.getByTestId('my-credentials')).toContainText('내 키')
  await page.getByTestId('my-credential-delete').click()
  await page.getByRole('dialog').getByRole('button', { name: '삭제' }).click()
  await expect(page.getByTestId('my-credentials')).toHaveCount(0)
  await page.goto('/admin/credentials')
  await page.getByRole('checkbox', { name: '팀원이 자기 AI 연결을 추가할 수 있게 하기' }).press('Space')
  await page.reload()
  await expect(page.getByRole('checkbox', { name: '팀원이 자기 AI 연결을 추가할 수 있게 하기' })).not.toBeChecked()
  await page.goto('/settings')
  await expect(page.getByRole('link', { name: 'AI 연결' })).toHaveCount(0)
})

test('where the browser cannot seal (no crypto.subtle: http on a LAN address), adding says to use https', async ({ page }) => {
  await reset(page)
  await page.addInitScript(() => { Object.defineProperty(window.crypto, 'subtle', { value: undefined, configurable: true }) })
  await signIn(page)
  await page.goto('/admin/credentials')
  await page.getByTestId('credential-add').click()
  await expect(page.getByTestId('credential-https-only')).toContainText('https')
  await expect(page.getByTestId('credential-submit')).toBeDisabled()
})
