// Admin > Plugins against the mock server (web/test/mock/plugins.ts): the Korean workspace sees HWP Preview recommended
// but "not yet available" with no install button and nothing installed; a skill pack installs only through the
// permission prompt, then turns off, on and is removed; a file upload shows its trust and can be cancelled; a refused
// package says why. PLUGIN_SHOTS=<folder> also saves screenshots.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const shots = process.env.PLUGIN_SHOTS
const shot = async (page: Page, name: string) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, name), fullPage: true }) } }
const catalogRow = (page: Page, id: string) => page.locator(`[data-testid="plugin-catalog"][data-plugin="${id}"]`)
const installedRow = (page: Page, id: string) => page.locator(`[data-testid="plugin-installed"][data-plugin="${id}"]`)

test('Korean workspace: HWP is recommended but not installable yet; a skill pack installs through the permission prompt', async ({ page }) => {
  await reset(page, { teamLocale: 'ko', usersFollowTeam: true })
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/admin/plugins')
  await expect(page.getByRole('link', { name: '플러그인' })).toBeVisible()
  // nothing is installed by the recommendation
  await expect(page.getByText('아직 설치한 플러그인이 없습니다.')).toBeVisible()
  const hwp = catalogRow(page, 'app.trina.hwp-preview')
  await expect(hwp).toContainText('한글 문서 미리보기')
  await expect(hwp.getByTestId('plugin-recommended')).toHaveText('추천')
  await expect(hwp.getByTestId('plugin-not-yet')).toHaveText('아직 설치할 수 없습니다. 배포 요건과 지원 환경을 검토 중입니다.')
  await expect(hwp.getByTestId('plugin-catalog-install')).toHaveCount(0)
  await expect(hwp).toContainText('이 서버의 격리된 프로세스에서 프로그램을 실행합니다')
  await expect(hwp).toContainText('Linux x64 (glibc 2.39 이상)')
  await shot(page, 'plugins-ko-catalog.png')

  await catalogRow(page, 'app.trina.office-starter').getByTestId('plugin-catalog-install').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: '회사에 업무 시작 스킬을(를) 설치할까요?' })).toBeVisible()
  await expect(dialog.getByTestId('plugin-permissions')).toContainText('회사 스킬 폴더를 읽을 수 있는 모든 사람에게 AI 지침(스킬)을 더합니다')
  await expect(dialog).toContainText('더해지는 회사 스킬: meeting-minutes, weekly-report')
  await expect(dialog).toContainText('사용 대상: 회사 전체')
  await shot(page, 'plugins-ko-prompt.png')
  await dialog.getByTestId('plugin-install-enable').click()
  await expect(dialog).toHaveCount(0)
  const row = installedRow(page, 'app.trina.office-starter')
  await expect(row).toContainText('회사 전체에 켜짐')
  await expect(row).toContainText('공식')
  await expect(row).toContainText('스킬: meeting-minutes, weekly-report')
  await shot(page, 'plugins-ko-installed.png')

  await row.getByTestId('plugin-disable').click()
  await expect(row).toContainText('꺼짐')
  await row.getByTestId('plugin-enable').click()
  await expect(row).toContainText('회사 전체에 켜짐')
  await row.getByTestId('plugin-remove').click()
  await page.getByRole('dialog').getByRole('button', { name: '제거' }).click()
  await expect(row).toHaveCount(0)
  await expect(page.getByText('아직 설치한 플러그인이 없습니다.')).toBeVisible()
  // the mock has no /api/skills list (home page), unrelated to this page
  expect(realErrors(errors).filter((e) => !/status of 404/.test(e))).toEqual([])
})

test('English workspace: no recommendation; an uploaded test build shows its warning; a refused package says why', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await page.goto('/admin/plugins')
  const hwp = catalogRow(page, 'app.trina.hwp-preview')
  await expect(hwp).toContainText('HWP Preview')
  await expect(hwp.getByTestId('plugin-recommended')).toHaveCount(0)
  await expect(hwp.getByTestId('plugin-not-yet')).toBeVisible()
  await shot(page, 'plugins-en-catalog.png')

  await page.getByTestId('plugin-file-input').setInputFiles({ name: 'sample.trinaplugin', mimeType: 'application/octet-stream', buffer: Buffer.from('package') })
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Install Sample skills for your company?' })).toBeVisible()
  await expect(dialog).toContainText('Signed with a test key. Use test builds only on development or test servers.')
  await expect(dialog).toContainText('Test build')
  await shot(page, 'plugins-en-test-build.png')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByText('No plugins are installed yet.')).toBeVisible()

  await page.getByTestId('plugin-file-input').setInputFiles({ name: 'bad.trinaplugin', mimeType: 'application/octet-stream', buffer: Buffer.from('package') })
  await expect(page.getByText('The package is not signed, or its signature does not match.')).toBeVisible()
})

test('members do not see the Plugins page', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page, { username: 'bob', password: 'bob password 1' })
  await page.goto('/admin/plugins')
  await expect(page).not.toHaveURL(/\/admin\/plugins/)
})

test('narrow screen', async ({ page }) => {
  await reset(page, { teamLocale: 'ko', usersFollowTeam: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await signIn(page)
  await page.goto('/admin/plugins')
  await expect(catalogRow(page, 'app.trina.hwp-preview').getByTestId('plugin-recommended')).toBeVisible()
  await shot(page, 'plugins-ko-mobile.png')
})
