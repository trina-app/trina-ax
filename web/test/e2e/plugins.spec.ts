// Admin > Plugins against the mock server (web/test/mock/plugins.ts): the Korean workspace sees HWP Preview recommended
// and installable from the official list, nothing installed until an admin approves the permission prompt (the optional
// page-image permission starts ticked and the prompt says so); a skill pack installs only through the prompt, then turns
// off, on and is removed; a file upload shows its trust and can be cancelled; a refused package says why. Core adds,
// by the HWP plugin's id, that it also turns on writing and filling Hangul documents (its package text is pinned).
// The page is laid out like Connected apps: cards under "Installed" (not shown while nothing is installed) and
// "Discover", and a plugin's page (what it will do, platforms, licences) in place of both.
// PLUGIN_SHOTS=<folder> also saves screenshots.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const shots = process.env.PLUGIN_SHOTS
const shot = async (page: Page, name: string) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, name), fullPage: true }) } }
const catalogRow = (page: Page, id: string) => page.locator(`[data-testid="plugin-catalog"][data-plugin="${id}"]`)
const installedRow = (page: Page, id: string) => page.locator(`[data-testid="plugin-installed"][data-plugin="${id}"]`)
/** a card opens the plugin's page; back returns to the lists with the keyboard on that card */
const openPage = async (card: ReturnType<typeof catalogRow>) => { await card.getByTestId('plugin-open').click(); return card.page().getByTestId('plugin-detail') }
const backToList = async (page: Page, card: ReturnType<typeof catalogRow>) => { await page.getByTestId('plugin-back').click(); await expect(card.getByTestId('plugin-open')).toBeFocused() }
const nothingInstalled = (page: Page) => expect(page.getByTestId('plugins-installed')).toHaveCount(0)

test('Korean workspace: HWP is recommended and installs through the permission prompt; so does a skill pack', async ({ page }) => {
  await reset(page, { teamLocale: 'ko', usersFollowTeam: true })
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/admin/plugins')
  await expect(page.getByRole('link', { name: '플러그인' })).toBeVisible()
  // nothing is installed by the recommendation: no "Installed" section, Discover leads under the title row
  await nothingInstalled(page)
  await expect(page.getByTestId('plugins-header').getByRole('heading', { name: '플러그인' })).toBeVisible()
  await expect(page.getByTestId('plugin-count')).toHaveText('2')
  const hwp = catalogRow(page, 'app.trina.hwp-preview')
  await expect(hwp).toContainText('한글 문서 미리보기')
  await expect(hwp.getByTestId('plugin-recommended')).toHaveText('추천')
  await shot(page, 'plugins-ko-catalog.png')
  // the search narrows the cards; nothing matching says so once
  await page.getByTestId('plugin-search').fill('회의록')
  await expect(page.getByTestId('plugin-catalog')).toHaveCount(1)
  await expect(catalogRow(page, 'app.trina.office-starter')).toBeVisible()
  await page.getByTestId('plugin-search').fill('zzzz')
  await expect(page.getByText('"zzzz"에 맞는 항목이 없어요.')).toBeVisible()
  await page.getByTestId('plugin-search').fill('')
  // the plugin's page: what it will do, where it runs
  const hwpPage = await openPage(hwp)
  await expect(hwpPage.getByRole('heading', { name: '한글 문서 미리보기' })).toBeVisible()
  await expect(hwpPage.getByTestId('plugin-recommended')).toHaveText('추천')
  await expect(hwpPage.getByTestId('plugin-not-yet')).toHaveCount(0)
  await expect(hwpPage).toContainText('이 서버의 격리된 프로세스에서 프로그램을 실행해요')
  await expect(hwpPage).toContainText('Linux x64 (glibc 2.39 이상)')
  await expect(hwpPage.getByTestId('plugin-hwp-writing')).toHaveText('켜 두면 AI가 한글 문서(HWPX)를 새로 만들고, 이미 있는 HWP·HWPX 양식도 채울 수 있어요. 끄면 만들기와 채우기도 꺼져요. 한글 문서의 글자 읽기와 원본 다운로드는 플러그인 없이도 돼요.')
  await expect(hwpPage.getByTestId('plugin-detail-install')).toBeVisible()
  await shot(page, 'plugins-ko-page.png')
  await backToList(page, hwp)
  // a plugin that is not HWP says nothing about Hangul documents
  const starter = catalogRow(page, 'app.trina.office-starter')
  await expect((await openPage(starter)).getByTestId('plugin-hwp-writing')).toHaveCount(0)
  await backToList(page, starter)
  // the prompt: official (matches the list in this release), the page-image permission ticked and said so plainly
  await hwp.getByTestId('plugin-catalog-install').click()
  const hwpPrompt = page.getByRole('dialog')
  await expect(hwpPrompt.getByTestId('plugin-plan-release')).toContainText('공식 빌드예요.')
  await expect(hwpPrompt.getByTestId('plugin-optional-model.send.preview-pixels')).toBeChecked()
  await expect(hwpPrompt).toContainText('요청하면 AI가 페이지 이미지를 볼 수 있어요. 이때 이미지가 설정된 AI 제공사로 전송돼요.')
  await expect(hwpPrompt.getByTestId('plugin-optional-on')).toHaveText('선택 권한도 미리 체크해 두었어요. 원하지 않는 항목은 체크를 해제하세요.')
  await expect(hwpPrompt.getByTestId('plugin-hwp-writing')).toHaveText('켜 두면 AI가 한글 문서(HWPX)를 새로 만들고, 이미 있는 HWP·HWPX 양식도 채울 수 있어요. 끄면 만들기와 채우기도 꺼져요. 한글 문서의 글자 읽기와 원본 다운로드는 플러그인 없이도 돼요.')
  await shot(page, 'plugins-ko-hwp-prompt.png')
  await hwpPrompt.getByRole('button', { name: '취소' }).click()
  await expect(hwpPrompt).toHaveCount(0)
  await nothingInstalled(page)

  await catalogRow(page, 'app.trina.office-starter').getByTestId('plugin-catalog-install').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: '회사에 업무 시작 스킬을(를) 설치할까요?' })).toBeVisible()
  await expect(dialog.getByTestId('plugin-permissions')).toContainText('회사 스킬 폴더를 읽을 수 있는 모든 사람에게 AI 지침(스킬)을 더해요')
  // official without a plugin key: the package matches the list that came with this release
  await expect(dialog.getByTestId('plugin-plan-release')).toContainText('공식 빌드예요.')
  await expect(dialog).toContainText('더해지는 회사 스킬: meeting-minutes, weekly-report')
  await expect(dialog).toContainText('사용 대상: 회사 전체')
  await expect(dialog.getByTestId('plugin-hwp-writing')).toHaveCount(0)
  await shot(page, 'plugins-ko-prompt.png')
  await dialog.getByTestId('plugin-install-enable').click()
  await expect(dialog).toHaveCount(0)
  const row = installedRow(page, 'app.trina.office-starter')
  await expect(row.getByTestId('plugin-line')).toHaveText('회사 전체에 켜짐')
  // in Discover it is now a check, not a +
  await expect(starter.getByTestId('plugin-added')).toBeVisible()
  await expect(starter.getByTestId('plugin-catalog-install')).toHaveCount(0)
  await shot(page, 'plugins-ko-installed.png')
  const starterPage = await openPage(row)
  await expect(starterPage.getByTestId('plugin-detail-state')).toContainText('회사 전체에 켜짐')
  await expect(starterPage.getByTestId('plugin-detail-state')).toContainText('공식')
  await expect(starterPage.getByTestId('plugin-verified-release')).toContainText('공식 목록과 일치')
  await expect(starterPage).toContainText('스킬: meeting-minutes, weekly-report')
  await expect(starterPage.getByTestId('plugin-detail-install')).toHaveCount(0)
  await starterPage.getByTestId('plugin-disable').click()
  await expect(starterPage.getByTestId('plugin-detail-state')).toContainText('꺼짐')
  await backToList(page, row)

  await expect(row.getByTestId('plugin-line')).toHaveText('꺼짐')
  await row.getByTestId('plugin-enable').click()
  await expect(row.getByTestId('plugin-line')).toHaveText('회사 전체에 켜짐')
  await row.getByTestId('plugin-disable').click()
  await expect(row.getByTestId('plugin-line')).toHaveText('꺼짐')
  await row.getByTestId('plugin-more').click()
  await page.getByTestId('plugin-remove').click()
  await page.getByRole('dialog').getByRole('button', { name: '제거' }).click()
  await expect(row).toHaveCount(0)
  await nothingInstalled(page)
  await expect(starter.getByTestId('plugin-catalog-install')).toBeVisible()
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
  await expect(hwp.getByTestId('plugin-catalog-install')).toBeVisible()
  await expect(page.getByTestId('plugins-note')).toContainText('Only owners and admins install them')
  await shot(page, 'plugins-en-catalog.png')
  await expect((await openPage(hwp)).getByTestId('plugin-hwp-writing')).toContainText('While it is on, the AI can also make new Hangul documents (HWPX) and fill in existing HWP and HWPX forms.')
  await shot(page, 'plugins-en-page.png')
  await backToList(page, hwp)

  await page.getByTestId('plugin-file-input').setInputFiles({ name: 'sample.trinaplugin', mimeType: 'application/octet-stream', buffer: Buffer.from('package') })
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Install Sample skills for your company?' })).toBeVisible()
  await expect(dialog).toContainText('Signed with a test key. Use test builds only on development or test servers.')
  await expect(dialog).toContainText('Test build')
  await shot(page, 'plugins-en-test-build.png')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await nothingInstalled(page)

  await page.getByTestId('plugin-file-input').setInputFiles({ name: 'bad.trinaplugin', mimeType: 'application/octet-stream', buffer: Buffer.from('package') })
  await expect(page.getByText("This package is not in this version's official list and has no valid signature.")).toBeVisible()
})

test('the ⋯ menu offers a rollback only to a version this server still trusts', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await page.goto('/admin/plugins')
  await catalogRow(page, 'app.trina.office-starter').getByTestId('plugin-catalog-install').click()
  await page.getByRole('dialog').getByTestId('plugin-install-enable').click()
  const row = installedRow(page, 'app.trina.office-starter')
  await expect(row.getByTestId('plugin-line')).toHaveText('On for the whole company')
  const menu = async (o: { version: string; trusted: boolean; untrusted?: boolean }) => {
    expect((await page.request.post('/__test/plugin-previous', { data: { id: 'app.trina.office-starter', ...o } })).ok()).toBeTruthy()
    await page.reload()
    await row.getByTestId('plugin-more').click()
    await expect(page.getByTestId('plugin-remove')).toBeVisible()
  }
  await menu({ version: '0.9.0', trusted: true })
  await expect(page.getByTestId('plugin-rollback')).toHaveText('Roll back to 0.9.0')
  // the server no longer trusts the pack (a test setting was turned off): a rollback would only be refused
  await menu({ version: '0.9.0', trusted: false, untrusted: true })
  await expect(page.getByTestId('plugin-rollback')).toHaveCount(0)
})

test('members do not see the Plugins page', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page, { username: 'bob', password: 'bob password 1' })
  await page.goto('/admin/plugins')
  // TC-272: the admin-only notice in place of the page
  await expect(page.getByTestId('admin-only')).toBeVisible()
  await expect(page.getByTestId('plugins-header')).toHaveCount(0)
})

test('HWP Preview installed but turned off: an admin is told to turn it on, not to add it', async ({ page }) => {
  await reset(page, { teamLocale: 'ko', usersFollowTeam: true })
  await signIn(page)
  await page.goto('/admin/plugins')
  await catalogRow(page, 'app.trina.hwp-preview').getByTestId('plugin-catalog-install').click()
  await page.getByRole('dialog').getByTestId('plugin-install-only').click()
  await expect(installedRow(page, 'app.trina.hwp-preview').getByTestId('plugin-line')).toHaveText('꺼짐')
  await expect((await openPage(installedRow(page, 'app.trina.hwp-preview'))).getByTestId('plugin-hwp-writing')).toHaveText('켜 두면 AI가 한글 문서(HWPX)를 새로 만들고, 이미 있는 HWP·HWPX 양식도 채울 수 있어요. 끄면 만들기와 채우기도 꺼져요. 한글 문서의 글자 읽기와 원본 다운로드는 플러그인 없이도 돼요.')
  await page.goto('/files?path=marketing')
  await page.getByTestId('files-input').setInputFiles(path.resolve(import.meta.dirname, '../../../tests/fixtures/hwp/two-pages.hwp'))
  await page.getByTestId('file-row').filter({ hasText: 'two-pages.hwp' }).getByRole('button').first().click()
  await expect(page.getByTestId('preview-unsupported')).toContainText('이 팀에서는 한글 미리보기가 켜져 있지 않아요.')
  await expect(page.getByTestId('hwp-plugins-link')).toHaveText('관리자 › 플러그인에서 한글 문서 미리보기를 켤 수 있어요.')
  await shot(page, 'plugins-ko-hwp-off.png')
})

test('narrow screen', async ({ page }) => {
  await reset(page, { teamLocale: 'ko', usersFollowTeam: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await signIn(page)
  await page.goto('/admin/plugins')
  const hwp = catalogRow(page, 'app.trina.hwp-preview')
  // a phone's row is one line (TC-269): "Recommended" is on the plugin's page
  await expect(hwp.getByTestId('plugin-recommended')).toBeHidden()
  // nothing is wider than the phone
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await shot(page, 'plugins-ko-mobile.png')
  await openPage(hwp)
  await expect(page.getByTestId('plugin-detail').getByTestId('plugin-recommended')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await shot(page, 'plugins-ko-mobile-page.png')
})
