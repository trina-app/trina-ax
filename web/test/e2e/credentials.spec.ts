// Admin > AI connections against the mock server (docs/DECISIONS.md "AI 연결" 3.13): a Claude subscription signed in
// from the browser (one button, the approval link in a new tab, the code pasted back; the plan notice that must be
// confirmed, no password) with the terminal paste folded underneath, an API key, a ChatGPT sign-in with its
// address and code, the order, a member's own connections in Settings (a Claude token pasted through the terminal
// fallback), and the https-only note where the browser cannot seal.
// The mock opens the sealed values with the server's real sealing code, so a value sealed wrongly fails here.
import { expect, request, test } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { DICTS } from '../../src/i18n'
import { OWNER, realErrors, reset, signIn, watchConsole } from './helpers'

const TOKEN = 'sk-ant-oat01-' + 'e2e'.repeat(15)
const KEY = 'sk-ant-api03-' + 'k'.repeat(40) + 'WXYZ'

test('owner adds a Claude subscription, an API key and a ChatGPT plan; orders them', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  // the old address opens AI providers, at Claude Code: each provider row lists its own accounts (none yet)
  await page.goto('/admin/credentials')
  await expect(page).toHaveURL(/\/admin\/providers\?engine=claude-code$/)
  await expect(page.getByRole('heading', { level: 2, name: 'AI 제공사', exact: true })).toBeVisible()
  await expect(page.getByTestId('credentials-claude')).toHaveCount(0)
  await expect(page.getByTestId('provider-none-claude')).toBeVisible()
  await expect(page.getByTestId('provider-none-codex')).toBeVisible()
  // the API engine (OpenRouter, Gemini, local models) is a provider in the same list, with its own form
  await expect(page.locator('[data-engine="api"]')).toBeVisible()
  await expect(page.getByTestId('provider-accounts-claude')).toBeVisible()

  // Sharing (Team settings › Members' own accounts) is off until the owner reads and confirms the warning.
  // Cancelling does not opt in.
  await page.getByTestId('provider-add-claude').click()
  await expect(page.getByTestId('kind-anthropic-oauth')).toBeDisabled()
  await page.getByRole('dialog').getByRole('button', { name: '취소' }).click()
  await page.getByTestId('provider-add-codex').click()
  await expect(page.getByTestId('kind-chatgpt')).toBeDisabled()
  await page.getByRole('dialog').getByRole('button', { name: '취소' }).click()
  await page.goto('/admin/settings#ai')
  const sharing = page.getByTestId('shared-subscriptions-setting').getByRole('checkbox')
  await expect(sharing).not.toBeChecked()
  await sharing.press('Space')
  await expect(page.getByRole('dialog')).toContainText('공유')
  await page.getByRole('dialog').getByRole('button', { name: '취소' }).click()
  await expect(sharing).not.toBeChecked()
  const optIn = page.waitForRequest((r) => r.url().endsWith('/api/admin/credential-settings') && r.method() === 'PATCH')
  await sharing.press('Space')
  await page.getByRole('dialog').getByRole('button').last().click()
  expect((await optIn).postDataJSON()).toEqual({ sharedSubscriptions: true, acknowledgedSharedSubscriptionRisk: true })
  await expect(sharing).toBeChecked()
  await page.goto('/admin/providers')

  // Claude subscription: one button signs in from the browser; the plan notice must be ticked, no password field
  await page.getByTestId('provider-add-claude').click()
  const dialog = page.getByRole('dialog')
  // Claude Code's Add account offers only Claude's kinds, API key first
  const kinds = await dialog.locator('input[name="kind"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
  expect(kinds).toEqual(['kind-anthropic-api-key', 'kind-anthropic-oauth'])
  await page.getByTestId('kind-anthropic-oauth').check()
  await expect(page.getByTestId('claude-login-how')).toContainText('Claude가 보여 주는 코드')
  // the terminal way is there, folded (not a second card, not a second button)
  await expect(page.getByTestId('claude-manual')).not.toHaveAttribute('open', '')
  await expect(page.getByTestId('setup-token-steps')).toBeHidden()
  await expect(page.getByTestId('credential-secret')).toBeHidden()
  await page.getByTestId('credential-label').fill('대표 Max')
  await expect(page.getByTestId('credential-password')).toHaveCount(0)
  await expect(page.getByTestId('credential-submit')).toHaveText('Claude 구독 연결')
  await expect(page.getByTestId('credential-submit')).toBeDisabled()
  await expect(page.getByTestId('plan-notice')).toContainText('제공사 약관에 따라 목적에 맞는 사용을 허용하는지 확인하세요. 트리나가 그 허가를 줄 수는 없어요.')
  await page.getByTestId('plan-notice-ack').check()
  const started = page.waitForRequest((r) => r.url().endsWith('/api/admin/credential-logins') && r.method() === 'POST')
  await page.getByTestId('credential-submit').click()
  expect((await started).postDataJSON()).toMatchObject({ kind: 'anthropic-oauth', label: '대표 Max', acknowledgedPlanNotice: true })
  // the approval link opens Claude in a new tab; the code field waits for what Claude shows after approval
  const open = page.getByTestId('claude-open')
  await expect(open).toHaveText('Claude 열어서 승인하기')
  await expect(open).toHaveAttribute('target', '_blank')
  expect(new URL((await open.getAttribute('href'))!).host).toBe('claude.com')
  // or the same link copied, for another browser (the one signed in to Claude)
  await dialog.getByRole('button', { name: '링크 복사' }).click()
  await expect(dialog.getByRole('button', { name: '복사했어요' })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await open.getAttribute('href'))
  await expect(page.getByTestId('claude-code-submit')).toBeDisabled()
  await page.getByTestId('claude-code-input').fill('not a code')
  await expect(dialog).toContainText('중간에 #가 있어요')
  await page.getByTestId('claude-code-input').fill('good-code#good-state')
  const codeRequests: string[] = []
  page.on('request', (r) => { if (/\/api\/admin\/credential-logins\/[^/]+\/code$/.test(r.url())) codeRequests.push(r.postData() ?? '') })
  // Enter twice in a row: one request, no "not waiting for a code" error
  await page.getByTestId('claude-code-input').press('Enter')
  await page.getByTestId('claude-code-input').press('Enter')
  await expect(page.getByTestId('claude-code-submit')).toHaveText('확인 중…')
  expect(codeRequests).toHaveLength(1)
  // sealed in the browser: the request carries no plain code
  expect(codeRequests[0]).not.toContain('good-code')
  expect(JSON.parse(codeRequests[0]!)).toHaveProperty('sealed.ct')
  // cancelling while the new token is saved: the dialog stays, says so, and then shows the result
  await dialog.getByRole('button', { name: '취소' }).click()
  await expect(dialog).toContainText('저장하는 중')
  await expect(page.getByTestId('claude-done')).toHaveText('연결했어요 · Claude 구독')
  expect(codeRequests).toHaveLength(1)
  await expect(dialog.getByTestId('dialog-error')).toHaveCount(0)
  await dialog.getByRole('button', { name: '완료' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('credentials-claude')).toContainText('대표 Max')
  await expect(page.getByTestId('credentials-claude')).toContainText('정상')

  // an API key: no plan notice, the last four characters as a hint
  await page.getByTestId('provider-add-claude').click()
  await page.getByTestId('kind-anthropic-api-key').check()
  await expect(page.getByTestId('plan-notice')).toHaveCount(0)
  await page.getByTestId('credential-label').fill('회사 키')
  await page.getByTestId('credential-secret').fill(KEY)
  await expect(page.getByTestId('credential-password')).toHaveCount(0)
  await page.getByTestId('credential-submit').click()
  await expect(page.getByTestId('credentials-claude').getByTestId('credential-row')).toHaveCount(2)
  await expect(page.getByTestId('credentials-claude')).toContainText('…WXYZ')

  // order: the key moves above the subscription
  const labels = () => page.getByTestId('credentials-claude').getByTestId('credential-row').evaluateAll((rows) => rows.map((r) => r.querySelector('.font-medium')?.textContent))
  expect(await labels()).toEqual(['대표 Max', '회사 키'])
  // move up is in the account's ⋯ menu
  await page.getByTestId('credentials-claude').getByTestId('credential-row').nth(1).getByTestId('credential-menu').click()
  await page.getByTestId('credentials-claude').getByRole('menuitem', { name: '위로' }).click()
  await expect.poll(labels).toEqual(['회사 키', '대표 Max'])
  // the plain line under a list of two or more says how the order is used (no "How order works" link any more)
  await expect(page.getByTestId('credentials-order')).toContainText('위에 있는 계정부터 써요. 거절되거나 한도에 닿으면 다음 계정으로 넘어가요.')
  await expect(page.getByTestId('how-order-works')).toHaveCount(0)

  // or drag a row by its handle (QA TC-4836): the subscription goes back on top, saved through the same PATCH
  const handles = page.getByTestId('credentials-claude').getByTestId('credential-drag')
  await expect(handles).toHaveCount(2)
  await expect(handles.first()).toHaveAccessibleName('회사 키 순서 바꾸기')
  const box = (await handles.nth(1).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y - 80, { steps: 8 })
  await expect(page.getByTestId('credentials-claude').locator('[data-moving]')).toContainText('대표 Max')
  const reordered = page.waitForRequest((r) => /\/api\/admin\/credentials\/[^/]+$/.test(r.url()) && r.method() === 'PATCH')
  await page.mouse.up()
  expect((await reordered).postDataJSON()).toEqual({ priority: 10 })
  await expect.poll(labels).toEqual(['대표 Max', '회사 키'])
  await expect(page.getByTestId('credentials-claude').locator('[data-moving]')).toHaveCount(0)

  // the keyboard: Space picks the row up, ArrowDown moves it, Space drops it; a screen reader hears each step, and the
  // focus stays on the moved row's handle
  const said = page.locator('[role="status"][aria-live="polite"]')
  await handles.first().focus()
  await page.keyboard.press('Space')
  await expect(said.filter({ hasText: '집었어요: 대표 Max' })).toHaveCount(1)
  await expect(handles.first()).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(said.filter({ hasText: '대표 Max: 2개 중 2번째' })).toHaveCount(1)
  await page.keyboard.press('Space')
  await expect.poll(labels).toEqual(['회사 키', '대표 Max'])
  await expect(said.filter({ hasText: '2번째로 옮겼어요' })).toHaveCount(1)
  await expect(handles.nth(1)).toBeFocused()
  // the handles wait while the new order is saved, then take the keyboard again
  await expect(handles.nth(1)).not.toHaveAttribute('aria-disabled', 'true')
  // Escape puts a picked-up row back: nothing is sent
  let sent = 0
  const count = (r: import('@playwright/test').Request) => { if (r.method() === 'PATCH' && /\/api\/admin\/credentials\//.test(r.url())) sent++ }
  page.on('request', count)
  await page.keyboard.press('Space')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Escape')
  await expect(said.filter({ hasText: '순서를 바꾸지 않았어요' })).toHaveCount(1)
  expect(await labels()).toEqual(['회사 키', '대표 Max'])
  page.off('request', count)
  expect(sent).toBe(0)

  // ChatGPT: Codex's Add account; the address and the one-time code, then connected
  await page.getByTestId('provider-add-codex').click()
  await page.getByTestId('kind-chatgpt').check()
  await page.getByTestId('credential-label').fill('팀 ChatGPT')
  await page.getByTestId('plan-notice-ack').check()
  await expect(page.getByTestId('credential-password')).toHaveCount(0)
  await page.getByTestId('credential-submit').click()
  await expect(page.getByTestId('chatgpt-user-code')).toHaveText('WXYZ-12AB3')
  // the sign-in page is a button (a new tab), with Copy link beside it
  await expect(page.getByTestId('chatgpt-open')).toHaveAttribute('href', 'https://auth.openai.com/codex/device')
  await expect(page.getByTestId('chatgpt-open')).toHaveAttribute('target', '_blank')
  await expect(page.getByTestId('chatgpt-done')).toContainText('ChatGPT pro')
  await page.getByRole('dialog').getByRole('button', { name: '완료' }).click()
  await expect(page.getByTestId('credentials-codex')).toContainText('팀 ChatGPT')
  await page.goto('/admin/settings#ai')
  await sharing.press('Space')
  await expect(sharing).not.toBeChecked()
  await page.goto('/admin/providers')
  await expect(page.getByTestId('credentials-claude')).toContainText('공유 꺼짐')
  await expect(page.getByTestId('credentials-codex')).toContainText('공유 꺼짐')
  // the one 409 is the cancel while the token was saved (above), which the dialog shows
  expect(realErrors(errors).filter((e) => !/status of 409/.test(e))).toEqual([])
})

// The sign-in's own Done button reloaded the list; closing the dialog any other way did not, so the new account only
// showed after a page reload and nothing said it worked. Now the finished sign-in counts as Done however it is closed,
// and one toast says the account was added and that accounts are used in list order.
test('a finished sign-in shows the new account when the dialog is closed with Esc or the x, with a toast', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/admin/settings#ai')
  const sharing = page.getByTestId('shared-subscriptions-setting').getByRole('checkbox')
  await sharing.press('Space')
  await page.getByRole('dialog').getByRole('button').last().click()
  await expect(sharing).toBeChecked()
  await page.goto('/admin/providers')

  const finishSignIn = async (testid: string, label: string) => {
    await page.getByTestId(testid).click()
    await page.getByTestId('kind-anthropic-oauth').check()
    await page.getByTestId('credential-label').fill(label)
    await page.getByTestId('plan-notice-ack').check()
    await page.getByTestId('credential-submit').click()
    await page.getByTestId('claude-code-input').fill('good-code#good-state')
    await page.getByTestId('claude-code-submit').click()
    await expect(page.getByTestId('claude-done')).toHaveText('연결했어요 · Claude 구독')
  }
  const added = page.getByTestId('toast').filter({ hasText: '계정을 추가했어요. 목록 순서대로 써요.' })

  // the team's list, closed with Esc
  await finishSignIn('provider-add-claude', '대표 Max')
  await expect(added).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByTestId('credentials-claude')).toContainText('대표 Max')

  // a member's own list in Settings, closed with the x
  await page.goto('/settings/providers')
  await finishSignIn('my-credential-add-claude', '내 Claude')
  const addDialog = page.getByRole('dialog', { name: '계정 추가' })
  await addDialog.getByRole('button', { name: '닫기' }).click()
  await expect(addDialog).toHaveCount(0)
  await expect(page.getByTestId('my-credentials')).toContainText('내 Claude')
})

test('personal connections are available by default, prefer subscriptions, and preserve an owner opt-out', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/admin/settings#ai')
  await expect(page.getByRole('checkbox', { name: '팀원이 자기 AI 연결을 추가할 수 있게 하기' })).toBeChecked()
  await page.goto('/settings')
  // Settings › Connections: Connectors first (everyone has it), then AI providers (one's own accounts, by provider)
  await expect(page.getByTestId('settings-group-connections').getByRole('link').first()).toContainText('커넥터')
  await expect(page.getByTestId('settings-group-connections').getByRole('link').nth(1)).toHaveText('AI 제공사')
  await page.getByTestId('settings-group-connections').getByRole('link', { name: 'AI 제공사', exact: true }).click()
  await page.getByTestId('my-credential-add-codex').click()
  await expect(page.getByTestId('kind-chatgpt')).toBeEnabled()
  await page.getByRole('dialog').getByRole('button', { name: '취소' }).click()
  await page.getByTestId('my-credential-add-claude').click()
  const kinds = await page.getByRole('dialog').locator('input[name="kind"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
  expect(kinds).toEqual(['kind-anthropic-oauth', 'kind-anthropic-api-key'])
  await expect(page.getByTestId('kind-anthropic-oauth')).toBeEnabled()
  await page.getByTestId('kind-anthropic-api-key').check()
  await expect(page.getByTestId('credential-password')).toHaveCount(0) // no password field for anyone
  await page.getByTestId('credential-label').fill('내 키')
  await page.getByTestId('credential-secret').fill(KEY.replace('WXYZ', 'MINE'))
  await page.getByTestId('credential-submit').click()
  await expect(page.getByTestId('my-credentials')).toContainText('내 키')
  await page.getByTestId('my-credential-delete').click()
  await page.getByRole('dialog').getByRole('button', { name: '삭제' }).click()
  await expect(page.getByTestId('my-credentials')).toHaveCount(0)
  // a sign-in whose result the server could not read: said in words, with the way out
  await page.getByTestId('my-credential-add-claude').click()
  await page.getByTestId('kind-anthropic-oauth').check()
  await page.getByTestId('credential-label').fill('내 Claude')
  await page.getByTestId('plan-notice-ack').check()
  await page.getByTestId('credential-submit').click()
  await page.getByTestId('claude-code-input').fill('odd-code#good-state')
  await page.getByTestId('claude-code-submit').click()
  await expect(page.getByTestId('claude-failed')).toHaveText('Claude가 보여 준 결과를 트리나가 읽지 못했어요(새 토큰이 만들어졌을 수 있어요). 다시 시작하거나 터미널로 직접 만들어 주세요.')
  await page.getByRole('dialog', { name: '계정 추가' }).getByRole('button', { name: '닫기' }).click()
  await expect(page.getByRole('dialog', { name: '계정 추가' })).toHaveCount(0)
  // a Claude token made in a terminal: the folded fallback (steps with copyable commands, the token field), then the
  // same button connects the pasted token instead of starting a sign-in
  await page.getByTestId('my-credential-add-claude').click()
  await page.getByTestId('kind-anthropic-oauth').check()
  await page.getByTestId('credential-label').fill('내 Max')
  await page.getByTestId('plan-notice-ack').check()
  await page.getByTestId('claude-manual').locator('summary').click()
  await expect(page.getByTestId('setup-token-steps')).toContainText('claude setup-token')
  await expect(page.getByTestId('claude-login-how')).toHaveCount(0)
  await page.getByTestId('credential-secret').fill('not-a-token')
  await expect(page.getByRole('dialog')).toContainText('sk-ant-oat01-로 시작하는 토큰 전체')
  await expect(page.getByTestId('credential-submit')).toHaveText('연결')
  await expect(page.getByTestId('credential-submit')).toBeDisabled()
  await page.getByTestId('credential-secret').fill(TOKEN)
  await page.getByTestId('credential-submit').click()
  await expect(page.getByTestId('my-credentials')).toContainText('내 Max')
  // the token is never shown again
  await expect(page.locator('body')).not.toContainText(TOKEN)
  await page.getByTestId('my-credential-delete').click()
  await page.getByRole('dialog').getByRole('button', { name: '삭제' }).click()
  await expect(page.getByTestId('my-credentials')).toHaveCount(0)
  await page.goto('/admin/settings#ai')
  await page.getByRole('checkbox', { name: '팀원이 자기 AI 연결을 추가할 수 있게 하기' }).press('Space')
  await page.reload()
  await expect(page.getByRole('checkbox', { name: '팀원이 자기 AI 연결을 추가할 수 있게 하기' })).not.toBeChecked()
  await page.goto('/settings')
  await expect(page.getByTestId('settings-menu').getByRole('link', { name: 'AI 제공사', exact: true })).toHaveCount(0)
  // the old address goes to the profile, like any section not shown
  await page.goto('/settings/credentials')
  await expect(page).toHaveURL(/\/settings$/)
})

// "Chosen groups and people" with none ticked would be sent as an empty list, which the API reads as the whole team:
// neither the add nor the edit dialog saves it, and the line under the list says why.
test('the target picker: "chosen groups and people" with none ticked does not save, in the add and the edit dialog', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  const t = DICTS.ko
  await page.goto('/admin/providers')
  await page.getByTestId('provider-add-claude').click()
  await page.getByTestId('kind-anthropic-api-key').check()
  await page.getByTestId('credential-label').fill('재무 키')
  await page.getByTestId('credential-secret').fill(KEY)
  const dialog = page.getByRole('dialog')
  const submit = page.getByTestId('credential-submit')
  await expect(submit).toBeEnabled()
  await dialog.getByRole('radio', { name: t['credentials.target.pick'] }).check()
  await expect(dialog.getByTestId('target-pick-none')).toHaveText(t['credentials.target.pickNone'])
  await expect(submit).toBeDisabled()
  await dialog.getByRole('checkbox', { name: '재무팀' }).check()
  await expect(dialog.getByTestId('target-pick-none')).toHaveCount(0)
  const added = page.waitForRequest((r) => r.url().endsWith('/api/admin/credentials') && r.method() === 'POST')
  await submit.click()
  expect((await added).postDataJSON().assignments).toHaveLength(1)
  const rows = page.getByTestId('credentials-claude').getByTestId('credential-row')
  await expect(rows).toHaveCount(1)

  // the edit dialog opens on the chosen group; unticking it leaves nothing: no save until one is ticked or 팀 전체
  await rows.first().getByTestId('credential-menu').click()
  await page.getByRole('menuitem', { name: new RegExp(t['credentials.changeTarget']) }).click()
  const edit = page.getByRole('dialog')
  const save = edit.getByRole('button', { name: t['common.save'], exact: true })
  await edit.getByRole('checkbox', { name: '재무팀' }).uncheck()
  await expect(edit.getByTestId('target-pick-none')).toBeVisible()
  await expect(save).toBeDisabled()
  await edit.getByRole('radio', { name: t['credentials.target.team'] }).check()
  await expect(edit.getByTestId('target-pick-none')).toHaveCount(0)
  await expect(save).toBeEnabled()
  expect(realErrors(errors)).toEqual([])
})

test('where the browser cannot seal (no crypto.subtle: http on a LAN address), adding says to use https', async ({ page }) => {
  await reset(page)
  await page.addInitScript(() => { Object.defineProperty(window.crypto, 'subtle', { value: undefined, configurable: true }) })
  await signIn(page)
  await page.goto('/admin/providers')
  await page.getByTestId('provider-add-claude').click()
  await expect(page.getByTestId('credential-https-only')).toContainText('https')
  await expect(page.getByTestId('credential-submit')).toBeDisabled()
})

// An admin who is not the owner connects the team's AI like the owner does (docs/DECISIONS.md "Admins connect the team's
// AI too"): the same Add account, the menu (switch off, remove) and the API engine form, (the API engine form still asks for their own password).
test('an admin sees and uses the AI providers buttons: adds a key with no password, switches it off, removes it, saves the API engine with their password', async ({ page }) => {
  await reset(page)
  await signIn(page)
  expect((await page.request.patch('/api/admin/users/bob', { headers: { [CSRF_HEADER]: '1' }, data: { role: 'admin' } })).ok()).toBe(true)
  await page.evaluate(() => localStorage.clear())
  await page.context().clearCookies()
  const BOB = { username: 'bob', password: 'bob password 1' }
  await signIn(page, BOB)
  await page.goto('/admin/providers')
  await expect(page.getByTestId('provider-add-claude')).toBeVisible()
  await expect(page.getByTestId('provider-add-codex')).toBeVisible()

  // no password field: the key is added at once
  await page.getByTestId('provider-add-claude').click()
  await page.getByTestId('kind-anthropic-api-key').check()
  await page.getByTestId('credential-label').fill('관리자 키')
  await page.getByTestId('credential-secret').fill(KEY)
  await expect(page.getByTestId('credential-password')).toHaveCount(0)
  const added = page.waitForRequest((r) => r.url().endsWith('/api/admin/credentials') && r.method() === 'POST')
  await page.getByTestId('credential-submit').click()
  const sent = (await added).postDataJSON()
  expect(sent).toMatchObject({ label: '관리자 키' })
  expect(sent).not.toHaveProperty('password')
  const rows = page.getByTestId('credentials-claude').getByTestId('credential-row')
  await expect(rows).toHaveCount(1)
  await expect(page.getByTestId('credentials-claude')).toContainText('…WXYZ')

  // the row's menu: switch off, then remove
  await rows.first().getByTestId('credential-menu').click()
  const off = page.waitForRequest((r) => /\/api\/admin\/credentials\/[^/]+$/.test(r.url()) && r.method() === 'PATCH')
  await page.getByRole('menuitem', { name: '끄기' }).click()
  expect((await off).postDataJSON()).toEqual({ disabled: true })
  await rows.first().getByTestId('credential-menu').click()
  await page.getByRole('menuitem', { name: '삭제' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '삭제' }).click()
  await expect(page.getByTestId('credentials-claude')).toHaveCount(0)

  // the API engine form is theirs too
  await page.goto('/admin/providers?engine=api')
  const form = page.locator('[data-engine="api"]').getByTestId('api-engine-form')
  await expect(form).toBeVisible()
  await form.getByLabel(DICTS.ko['engines.api.preset']).selectOption('openrouter')
  await form.getByTestId('api-engine-password').fill(BOB.password)
  const saved = page.waitForRequest((r) => r.method() === 'PUT' && /\/api\/admin\/engines\/api-config$/.test(r.url()))
  await form.getByRole('button', { name: '저장', exact: true }).click()
  expect((await saved).postDataJSON()).toMatchObject({ baseUrl: 'https://openrouter.ai/api/v1' })

  // and the switches of the team's AI settings
  await page.goto('/admin/settings#ai')
  await expect(page.getByTestId('shared-subscriptions-setting').getByRole('checkbox')).toBeEnabled()
})

// Only one AI sign-in runs at a time. When the one in the way is the person's own (started elsewhere, a tab they closed),
// the dialog says so and "Stop it and start again" ends it and starts the new one in one press (QA TC-2581). Whose it is,
// for the owner and admins when it is someone else's, is covered in tests/unit/a-credentials-claude-login.test.ts.
test('my own sign-in in the way: the dialog says so, and Stop it and start again goes through in one press', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const call = (method: 'patch' | 'post', url: string, data: object) => page.request[method](url, { headers: { [CSRF_HEADER]: '1' }, data })
  expect((await call('patch', '/api/admin/credential-settings', { sharedSubscriptions: true, acknowledgedSharedSubscriptionRisk: true })).ok()).toBe(true)
  // someone's sign-in is running (here the owner's own, started elsewhere)
  const running = await call('post', '/api/admin/credential-logins', { kind: 'anthropic-oauth', label: 'Elsewhere', assignments: [], priority: 100, acknowledgedPlanNotice: true })
  expect(running.status()).toBe(202)
  await page.goto('/admin/providers')
  await page.getByTestId('provider-add-claude').click()
  await page.getByTestId('kind-anthropic-oauth').check()
  await page.getByTestId('credential-label').fill('Mine')
  await page.getByTestId('plan-notice-ack').check()
  await page.getByTestId('credential-submit').click()
  const busy = page.getByTestId('login-busy')
  await expect(busy).toContainText(DICTS.ko['credentials.loginBusyMine'])
  await expect(page.getByTestId('dialog-error')).toHaveCount(0)
  await busy.getByTestId('login-busy-stop').click()
  await expect(page.getByTestId('login-busy')).toHaveCount(0)
  await expect(page.getByTestId('claude-open')).toBeVisible()
})

// QA TC-2581: one sign-in slot for the whole server. A member blocked by someone else's reads a plain wait with the real
// minutes (never the raw error, never whose); their own left over from a closed tab says so and is stopped and started
// again in one press; a tab that closes while its sign-in runs stops it (the slot is free for everyone at once).
test('the one sign-in slot: a member reads a true wait, stops their own leftover, and a closed tab frees it', async ({ page, context }) => {
  await reset(page)
  await signIn(page)
  const call = (method: 'patch' | 'post', url: string, data: object) => page.request[method](url, { headers: { [CSRF_HEADER]: '1' }, data })
  expect((await call('patch', '/api/admin/credential-settings', { sharedSubscriptions: true, acknowledgedSharedSubscriptionRisk: true })).ok()).toBe(true)
  const running = await call('post', '/api/admin/credential-logins', { kind: 'anthropic-oauth', label: 'Elsewhere', assignments: [], priority: 100, acknowledgedPlanNotice: true })
  expect(running.status()).toBe(202)
  const ownerLogin = (await running.json()) as { loginId: string }
  await context.clearCookies()
  await signIn(page, { username: 'bob', password: 'bob password 1' })
  // Claude's sign-in waits for the pasted code, so it keeps running (the test server's ChatGPT one ends by itself)
  const openOwn = async (p = page) => {
    await p.goto('/settings/providers')
    await p.getByTestId('my-credential-add-claude').click()
    await p.getByTestId('kind-anthropic-oauth').check()
    await p.getByTestId('credential-label').fill('Bob Claude')
    await p.getByTestId('plan-notice-ack').check()
    await p.getByTestId('credential-submit').click()
  }
  await openOwn()
  const busy = page.getByTestId('login-busy')
  await expect(busy).toContainText(DICTS.ko['credentials.loginBusyMember'])
  await expect(busy.getByTestId('login-busy-left')).toHaveText(/(15|16)분/)
  await expect(busy).not.toContainText('Olga')
  await expect(busy.getByTestId('login-busy-stop')).toHaveCount(0)
  await expect(page.getByTestId('dialog-error')).toHaveCount(0)
  // nothing to start while it is taken: Start is off, and turns on by itself once the slot is free (no reload)
  await expect(page.getByTestId('credential-submit')).toBeDisabled()
  // the owner's ends (stopped by the owner from another browser)
  const owner = await request.newContext({ baseURL: new URL(page.url()).origin })
  expect((await owner.post('/api/auth/login', { headers: { [CSRF_HEADER]: '1' }, data: { username: OWNER.username, password: OWNER.password, client: 'web', tokenMode: 'cookie' } })).ok()).toBe(true)
  expect((await owner.delete(`/api/admin/credential-logins/${ownerLogin.loginId}`, { headers: { [CSRF_HEADER]: '1' } })).status()).toBe(204)
  await owner.dispose()
  await expect(page.getByTestId('login-busy')).toHaveCount(0, { timeout: 15_000 })
  await expect(page.getByTestId('credential-submit')).toBeEnabled()
  await page.getByTestId('credential-submit').click()
  await expect(page.getByTestId('claude-open')).toBeVisible()
  // a second tab of bob's: his own leftover, stopped and started again in one press
  const tab2 = await context.newPage()
  await openOwn(tab2)
  await expect(tab2.getByTestId('login-busy')).toContainText(DICTS.ko['credentials.loginBusyMine'])
  const restarted = tab2.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/api/me/credential-logins') && r.status() === 202)
  await tab2.getByTestId('login-busy-stop').click()
  const second = (await (await restarted).json()) as { loginId: string }
  await expect(tab2.getByTestId('claude-open')).toBeVisible()
  // closing that tab while it runs stops it (its goodbye on pagehide): the first tab can start at once
  await tab2.close({ runBeforeUnload: true })
  await expect.poll(async () => ((await (await page.request.get(`/api/me/credential-logins/${second.loginId}`)).json()) as { state: string }).state).toBe('cancelled')
  await openOwn()
  await expect(page.getByTestId('claude-open')).toBeVisible()
})

// A member's own ChatGPT sign-in (Settings › AI providers) asked them to sign in "with the account the team will use":
// it is their own account, so the step says so; the team's sign-in in Admin keeps the team wording (test above).
test('my own ChatGPT sign-in asks for my own account, not the team\'s', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/settings/providers')
  await page.getByTestId('my-credential-add-codex').click()
  await page.getByTestId('kind-chatgpt').check()
  await page.getByTestId('credential-label').fill('내 ChatGPT')
  await page.getByTestId('plan-notice-ack').check()
  await page.getByTestId('credential-submit').click()
  await expect(page.getByTestId('chatgpt-code')).toContainText(DICTS.ko['credentials.chatgpt.step3Own'])
  await expect(page.getByTestId('chatgpt-code')).not.toContainText(DICTS.ko['credentials.chatgpt.step3'])
})

// A member's own API key (Settings › AI providers; QA TC-519): the advice is about their own key, not "a key just for
// this team in the company's console"; a key the provider refused, then edited, shows only the new key's problem.
test('my own API key: advice for my own key; the provider\'s refusal goes when I change the key', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/settings/providers')
  await page.getByTestId('my-credential-add-claude').click()
  await page.getByTestId('kind-anthropic-api-key').check()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText(DICTS.ko['credentials.apiKey.hintOwn'])
  await expect(dialog).not.toContainText(DICTS.ko['credentials.apiKey.hint'])
  // the provider refuses the key (as the server answers when the provider says 401)
  await page.route('**/api/me/credentials', (route) => route.request().method() === 'POST'
    ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 'validation', message: '공급자가 이 키를 받지 않았어요. 키를 다시 확인해 주세요.' } }) })
    : route.fallback())
  await page.getByTestId('credential-label').fill('내 키')
  await page.getByTestId('credential-secret').fill(KEY)
  await page.getByTestId('credential-submit').click()
  await expect(dialog.getByTestId('dialog-error')).toHaveText('공급자가 이 키를 받지 않았어요. 키를 다시 확인해 주세요.')
  await page.getByTestId('credential-secret').fill('not-a-key')
  await expect(dialog).toContainText(DICTS.ko['credentials.apiKey.invalidFormat'])
  await expect(dialog.getByTestId('dialog-error')).toHaveCount(0)
  // the team's own dialog keeps the team advice
  await page.goto('/admin/providers')
  await page.getByTestId('provider-accounts-claude').getByRole('button', { name: '계정 추가' }).click()
  await page.getByTestId('kind-anthropic-api-key').check()
  await expect(page.getByRole('dialog')).toContainText(DICTS.ko['credentials.apiKey.hint'])
})
