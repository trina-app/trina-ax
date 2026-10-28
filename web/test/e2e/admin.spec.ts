import { expect, test } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'
import { DICTS } from '../../src/i18n'
import { PRODUCT } from '@mycel/shared'

test('admin screens: members, groups, folder rules with "who sees what", engines, usage, audit, system', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.getByRole('link', { name: '관리자' }).click()
  await expect(page.getByTestId('members-table')).toContainText('Bob')

  // add a member: the temporary password field comes pre-filled with an easy one (word + digits), ↻ makes another,
  // the admin may type their own (8+ characters); after creating, the username and password are shown once
  await page.getByRole('button', { name: '직접 추가' }).click()
  await page.getByRole('dialog').getByLabel('이름', { exact: true }).fill('Carol')
  await page.getByRole('dialog').getByLabel('아이디').fill('carol')
  const temp = page.getByTestId('temp-password')
  const first = await temp.inputValue()
  expect(first).toMatch(/^[a-z]{4,7}[0-9]{4}$/)
  expect(first.length).toBeGreaterThanOrEqual(8)
  let other = first
  for (let i = 0; i < 5 && other === first; i++) {
    await page.getByTestId('temp-password-new').click()
    other = await temp.inputValue()
  }
  expect(other).not.toBe(first)
  expect(other).toMatch(/^[a-z]{4,7}[0-9]{4}$/)
  // the field is the input's own label (not the ↻ / copy buttons), and its hint is attached to the input
  await expect(page.getByRole('dialog').getByLabel('임시 비밀번호', { exact: true })).toHaveAttribute('data-testid', 'temp-password')
  // too short: the create button waits until it has 8 characters
  await temp.fill('short1')
  await expect(page.getByTestId('add-member-submit')).toBeDisabled()
  await expect(page.getByTestId('temp-password-error')).toHaveText('비밀번호는 8자 이상이어야 해요.')
  await expect(temp).toHaveAttribute('aria-invalid', 'true')
  // empty: says what to do instead of only greying out the button
  await temp.fill('')
  await expect(page.getByTestId('temp-password-error')).toContainText('↻')
  // spaces are dropped as typed (they would be invisible on the hand-over screen)
  await temp.fill('  tiger427 ')
  await expect(temp).toHaveValue('tiger427')
  // Hangul from a 한/영 key left on is refused with a hint
  await temp.fill('노ㅑㅜㄷ1234')
  await expect(page.getByTestId('temp-password-error')).toContainText('한/영')
  await expect(page.getByTestId('add-member-submit')).toBeDisabled()
  // the server's reason shows under the field, not as a toast, and goes away on the next try
  await temp.fill('12345678')
  await page.getByTestId('add-member-submit').click()
  await expect(page.getByTestId('temp-password-error')).toContainText('너무 흔한 비밀번호')
  await expect(page.getByRole('status').filter({ hasText: '너무 흔한' })).toHaveCount(0)
  await temp.fill('maple2026')
  await expect(page.getByTestId('temp-password-error')).toHaveCount(0)
  // another refusal (username taken) shows at the bottom of the dialog
  await page.getByRole('dialog').getByLabel('아이디').fill('bob')
  await page.getByTestId('add-member-submit').click()
  await expect(page.getByTestId('dialog-error')).toContainText('이미 쓰고 있는 아이디')
  await page.getByRole('dialog').getByLabel('아이디').fill('carol')
  await page.getByTestId('add-member-submit').click()
  // hand-over: the address, username and password (large) and the date it stops working
  await expect(page.getByTestId('handover-url')).toHaveText('https://team.example.com')
  await expect(page.getByTestId('handover-username')).toHaveText('carol')
  await expect(page.getByTestId('handover-password')).toHaveText('maple2026')
  await expect(page.getByTestId('handover-password')).toHaveClass(/text-xl/)
  await expect(page.getByTestId('handover-note')).toContainText('까지')
  await expect(page.getByTestId('dialog-error')).toHaveCount(0)
  await page.getByRole('button', { name: '주소·아이디·비밀번호 복사' }).click()
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  expect(copied).toMatch(/^주소: https:\/\/team\.example\.com\n아이디: carol\n임시 비밀번호: maple2026\n.+까지 로그인해서 새 비밀번호로 바꿔 주세요\.$/)
  await page.getByRole('dialog').getByRole('button', { name: '완료' }).click()
  await expect(page.getByTestId('members-table')).toContainText('비밀번호 변경 필요')
  // reset is a labelled button in the row, not an icon only
  await expect(page.getByTestId('reset-password-carol')).toHaveText(/비밀번호 재설정/)

  // invite link with QR
  await page.getByTestId('invite-new').click()
  await page.getByTestId('invite-create').click()
  await page.getByRole('button', { name: 'QR 코드' }).click()
  await expect(page.getByRole('img', { name: 'QR 코드' })).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: '완료' }).click()
  await expect(page.getByTestId('invite-list')).toContainText('팀원')

  // groups
  await page.getByRole('link', { name: '그룹' }).click()
  await page.getByTestId('group-new').click()
  await page.getByTestId('group-name').fill('영업팀')
  await page.getByRole('dialog').getByLabel('Bob').check()
  await page.getByTestId('group-save').click()
  await expect(page.getByTestId('group-list')).toContainText('영업팀')

  // folder rules: preview before saving
  await page.getByRole('link', { name: '폴더 권한' }).click()
  await expect(page.getByTestId('folder-list')).toContainText('finance')
  await page.getByTestId('folder-list').getByRole('button', { name: '수정' }).click()
  await page.getByTestId('rule-add').click()
  await page.getByRole('dialog').getByLabel('대상').last().selectOption('everyone')
  await page.getByTestId('rules-preview').click()
  const preview = page.getByTestId('rules-preview-result')
  await expect(preview).toContainText('Bob')
  await expect(preview).toContainText('권한을 잃는 사람')
  await page.getByTestId('rules-save').click()
  await expect(page.getByTestId('folder-list')).toContainText('모두: 읽기')

  // engines: what is missing, in plain words
  await page.getByRole('link', { name: 'AI 엔진' }).click()
  await expect(page.getByTestId('engine-card').first()).toContainText('연결됨')
  await expect(page.getByTestId('engine-detail')).toContainText('codex login --device-auth')

  await page.getByRole('link', { name: '사용량' }).click()
  await expect(page.getByTestId('usage-table')).toContainText('Olga')
  await page.getByRole('link', { name: '기록' }).click()
  // actions in words; the id stays in the tooltip
  await expect(page.getByTestId('audit-list')).toContainText('초대 링크 만듦')
  await expect(page.getByTestId('audit-list').locator('[title="invite.create"]').first()).toBeVisible()

  // owner only: diagnostics and backups with job progress
  await page.getByRole('link', { name: '시스템' }).click()
  await expect(page.getByTestId('diagnostics')).toContainText('Relay connection')
  await page.getByTestId('backup-now').click()
  await expect(page.getByText('백업을 만들었어요.')).toBeVisible()
  // the refusals asked for above (a common temporary password, a taken username) are the only failed requests
  expect(realErrors(errors).filter((e) => !/status of (400|409)/.test(e))).toEqual([])
  expect(realErrors(errors).filter((e) => /status of (400|409)/.test(e)).length).toBe(2)
})

test('members: a one-time password reset link to copy (no email); the owner has none', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/admin/members')
  await expect(page.getByTestId('members-table')).toContainText('Bob')
  // the owner's own row has no reset buttons (the owner resets only on the server Mac)
  await expect(page.getByTestId('reset-link-olga')).toHaveCount(0)
  await page.getByTestId('reset-link-bob').click()
  await expect(page.getByRole('dialog')).toContainText('24시간')
  await page.getByTestId('dialog-confirm').click()
  const value = page.getByTestId('secret-value')
  await expect(value).toHaveText(/^http:\/\/127\.0\.0\.1:\d+\/reset-password\/rst[0-9a-f]+$/)
  await expect(page.getByRole('dialog')).toContainText('한 번만')
  await page.getByRole('dialog').getByRole('button', { name: '링크 복사' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await value.textContent())
  await page.getByRole('dialog').getByRole('button', { name: '완료' }).click()
  expect(realErrors(errors)).toEqual([])
})

test('system: the relay connection asks for the team name; the official relay is not offered while it does not run', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/admin/system')
  await page.getByRole('button', { name: '연결 방식 바꾸기' }).click()
  const mode = page.getByTestId('connection-mode')
  await expect(mode.locator('option')).toHaveText(['직접 운영하는 중계 서버', '사무실 안 직접 연결만'])
  await expect(mode.locator('option', { hasText: PRODUCT.displayName })).toHaveCount(0)
  const name = page.getByTestId('relay-team-name')
  await expect(name).toHaveValue('acme')
  await page.getByRole('dialog').getByRole('textbox', { name: '중계 서버 주소' }).fill('wss://relay.example.org/connect')
  await name.fill('Bad_Name')
  await expect(page.getByRole('dialog').getByRole('button', { name: '계속' })).toBeDisabled()
  await name.fill('acme-sales')
  await page.getByRole('dialog').getByRole('button', { name: '계속' }).click()
  await page.getByRole('dialog').getByLabel('비밀번호 다시 입력').fill('correct horse battery')
  await page.getByRole('dialog').getByRole('button', { name: '저장' }).click()
  await expect(page.getByText('저장했어요.')).toBeVisible()
  await expect(page.getByText('acme-sales')).toBeVisible()
  // office network only needs no team name
  await page.getByRole('button', { name: '연결 방식 바꾸기' }).click()
  await mode.selectOption('direct-only')
  await expect(page.getByTestId('relay-team-name')).toHaveCount(0)
  expect(realErrors(errors)).toEqual([])
})

test('members cannot open admin screens', async ({ page }) => {
  await reset(page)
  await signIn(page, { username: 'bob', password: 'bob password 1' })
  await expect(page.getByRole('link', { name: '관리자' })).toHaveCount(0)
  await page.goto('/admin/members')
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/)
  // and the API itself refuses (the hidden screens are only a convenience)
  expect((await page.request.get('/api/admin/users')).status()).toBe(403)
})

test('system: storage use with what uses it; Team AX Cloud shows the plan and leaves out what TreeSoop manages', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/admin/system')
  const storage = page.getByTestId('storage')
  await expect(storage).toContainText('82%')
  await expect(storage).toContainText('80% 넘음')
  await expect(page.getByTestId('storage-bar')).toHaveAttribute('style', /width: 82%/)
  await expect(page.getByTestId('storage-breakdown')).toContainText('휴지통')
  await expect(storage).toContainText('휴지통 비우기')
  await expect(page.getByTestId('plan-card')).toHaveCount(0)
  await expect(page.getByTestId('managed-notices')).toHaveCount(0)
  // a self-hosted server: connection change and connected folders are there
  await expect(page.getByRole('button', { name: '연결 방식 바꾸기' })).toBeVisible()

  expect((await page.request.post('/__test/cloud', { data: { on: true } })).ok()).toBeTruthy()
  await page.reload()
  const plan = page.getByTestId('plan-card')
  await expect(plan).toContainText('팀')
  await expect(plan).toContainText('12명 중')
  await expect(plan).toContainText('동시 답변 최대 3')
  await expect(plan.getByRole('link', { name: '요금제 관리' })).toHaveAttribute('href', 'https://app.teamax.example/billing')
  await expect(plan.getByRole('link', { name: '지원' })).toHaveAttribute('href', 'mailto:support@teamax.example')
  // the operator's notices: the owner's critical one cannot be closed, the info one can (and stays closed)
  const notices = page.getByTestId('managed-notices')
  await expect(notices.locator('[data-notice="grant-1"]')).toBeVisible()
  await expect(notices.locator('[data-notice="grant-1"]').getByRole('button')).toHaveCount(0)
  await notices.locator('[data-notice="maint-1"]').getByRole('button', { name: '닫기' }).click()
  await expect(notices.locator('[data-notice="maint-1"]')).toHaveCount(0)
  await page.reload()
  await expect(notices.locator('[data-notice="grant-1"]')).toBeVisible()
  await expect(notices.locator('[data-notice="maint-1"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '연결 방식 바꾸기' })).toHaveCount(0)
  await expect(page.getByTestId('update-managed')).toBeVisible()
  await expect(page.getByTestId('connected-list')).toHaveCount(0)
  // the plan's maximum for answers at the same time
  await page.goto('/admin/engines')
  await expect(page.getByTestId('engines-concurrency')).toHaveAttribute('max', '3')
  expect(realErrors(errors)).toEqual([])
})

test('settings: the team time zone', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/admin/settings')
  const tz = page.getByTestId('team-time-zone')
  await expect(tz).toHaveValue('Asia/Seoul')
  await tz.selectOption('Asia/Jakarta')
  await page.getByRole('button', { name: '저장', exact: true }).click()
  await expect(page.getByText('저장했어요.')).toBeVisible()
  await page.reload()
  await expect(page.getByTestId('team-time-zone')).toHaveValue('Asia/Jakarta')
})

for (const locale of ['ko', 'en', 'id'] as const) {
  test(`settings: update window validates while typing and after blur, then recovers (${locale})`, async ({ page }) => {
    await reset(page, { teamLocale: locale, usersFollowTeam: true })
    await signIn(page)
    await page.goto('/admin/settings')
    const t = DICTS[locale]
    const window = page.getByLabel(t['teamSettings.updateWindow'], { exact: true })
    const save = page.getByRole('button', { name: t['common.save'], exact: true })
    const error = page.getByRole('alert').filter({ hasText: t['teamSettings.updateWindowBad'] })
    const patches: unknown[] = []
    page.on('request', (r) => {
      if (r.method() === 'PATCH' && new URL(r.url()).pathname === '/api/admin/settings') patches.push(r.postDataJSON())
    })
    await expect(window).toHaveValue('')
    await expect(page.getByText(t['teamSettings.updateWindowHint'], { exact: true })).toBeVisible()
    for (const invalid of ['25:00-26:00', '25:00-01:00', '00:00-25:00', '23:60-01:00', '00:00-23:60']) {
      await window.fill(invalid)
      await expect(error).toBeVisible()
      await expect(window).toHaveAttribute('aria-invalid', 'true')
      await expect(save).toBeDisabled()
      await window.press('Enter')
      await window.blur()
      await expect(error).toBeVisible()
      await expect(save).toBeDisabled()
    }
    expect(patches).toEqual([])
    for (const valid of ['00:00-23:59', '23:59-00:00', '23:00-01:00', '00:00-00:00', '']) {
      await window.fill(valid)
      await expect(error).toHaveCount(0)
      await expect(window).not.toHaveAttribute('aria-invalid', 'true')
      await expect(save).toBeEnabled()
      const response = page.waitForResponse((r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname === '/api/admin/settings')
      await save.click()
      expect((await response).ok()).toBe(true)
      expect(patches.at(-1)).toEqual({ updateWindow: valid || null })
      await page.reload()
      await expect(window).toHaveValue(valid)
    }
  })
}
