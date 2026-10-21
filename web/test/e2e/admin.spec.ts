import { expect, test } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'
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
  await temp.fill('exampleteam2026')
  await expect(page.getByTestId('temp-password-error')).toHaveCount(0)
  // another refusal (username taken) shows at the bottom of the dialog
  await page.getByRole('dialog').getByLabel('아이디').fill('bob')
  await page.getByTestId('add-member-submit').click()
  await expect(page.getByTestId('dialog-error')).toContainText('이미 쓰고 있는 아이디')
  await page.getByRole('dialog').getByLabel('아이디').fill('carol')
  await page.getByTestId('add-member-submit').click()
  // hand-over: the address, username and password (large) and the date it stops working
  await expect(page.getByTestId('handover-url')).toHaveText('https://exampleteam.example.com')
  await expect(page.getByTestId('handover-username')).toHaveText('carol')
  await expect(page.getByTestId('handover-password')).toHaveText('exampleteam2026')
  await expect(page.getByTestId('handover-password')).toHaveClass(/text-xl/)
  await expect(page.getByTestId('handover-note')).toContainText('까지')
  await expect(page.getByTestId('dialog-error')).toHaveCount(0)
  await page.getByRole('button', { name: '주소·아이디·비밀번호 복사' }).click()
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  expect(copied).toMatch(/^주소: https:\/\/exampleteam\.dentist-almanac\.com\n아이디: carol\n임시 비밀번호: exampleteam2026\n.+까지 로그인해서 새 비밀번호로 바꿔 주세요\.$/)
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
