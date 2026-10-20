import { expect, test } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

test('admin screens: members, groups, folder rules with "who sees what", engines, usage, audit, system', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.getByRole('link', { name: '관리자' }).click()
  await expect(page.getByTestId('members-table')).toContainText('Bob')

  // add a member: the temporary password is shown once
  await page.getByRole('button', { name: '직접 추가' }).click()
  await page.getByRole('dialog').getByLabel('이름', { exact: true }).fill('Carol')
  await page.getByRole('dialog').getByLabel('아이디').fill('carol')
  await page.getByRole('dialog').getByRole('button', { name: '만들기' }).click()
  await expect(page.getByTestId('secret-value')).toHaveText('temp-password-1')
  await page.getByRole('dialog').getByRole('button', { name: '완료' }).click()
  await expect(page.getByTestId('members-table')).toContainText('비밀번호 변경 필요')

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
  await expect(page.getByTestId('audit-list')).toContainText('invite.create')

  // owner only: diagnostics and backups with job progress
  await page.getByRole('link', { name: '시스템' }).click()
  await expect(page.getByTestId('diagnostics')).toContainText('Relay connection')
  await page.getByTestId('backup-now').click()
  await expect(page.getByText('백업을 만들었어요.')).toBeVisible()
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
