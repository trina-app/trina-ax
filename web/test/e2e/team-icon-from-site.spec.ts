// The team logo from the company website (docs/decisions/20261128-team-icon-from-site.md) against the mock: 회사 소개's
// 저장하고 계속 sets the website's square icon as the team logo when the team has none, with one toast and 되돌리기 (which
// brings the product's mark back); Admin › 팀 로고 › "홈페이지에서 가져오기" shows only with a saved website, replaces the
// logo, and says in one line when nothing usable was found. Desktop and phone width, light and dark.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { makePng } from '../../../tests/lib/images'
import { realErrors, reset, signIn, watchConsole, noSlack } from './helpers'
import { teamLogo } from './nav'

/** the icon the reading staged (the mock's stand-in for server/src/onboarding/site-icon.ts) */
const stageIcon = async (page: Page, png: Uint8Array | null) =>
  expect((await page.request.post('/__test/site-icon', { data: { png: png ? Buffer.from(png).toString('base64') : null } })).ok()).toBeTruthy()
const saveProfile = async (page: Page, website: string) =>
  expect((await page.request.put('/api/onboarding/profile', { headers: { [CSRF_HEADER]: '1' }, data: { website, name: 'Acme', oneLine: 'Acme는 조용한 책상 선풍기를 만들어요', products: '선풍기', audience: '', tone: [], avoid: '', sources: [] } })).ok()).toBeTruthy()

test('회사 소개: 저장하고 계속 sets the website icon as the team logo (none before), one toast, 되돌리기 brings the product\'s mark back', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  await noSlack(page)
  await signIn(page)
  await page.goto('/welcome')
  await page.getByLabel('홈페이지 주소').fill('acme.example')
  await page.getByRole('button', { name: '읽어 오기' }).click()
  await expect(page.getByTestId('welcome-profile-line')).toHaveText('이렇게 이해했어요: Acme는 조용한 책상 선풍기를 만들어요 · 고치기', { timeout: 15_000 })
  // nothing new on the screen while reading or saved: no card, no extra button
  await expect(page.locator('[data-step="profile"]')).not.toContainText('로고')
  await expect(teamLogo(page)).toHaveAttribute('src', '/favicon.svg')
  await stageIcon(page, makePng(256, 256, [14, 94, 78]))
  await page.getByTestId('welcome-profile-continue').click()
  await expect(page.locator('[data-step="skills"]')).toBeVisible()
  const toast = page.getByRole('status').filter({ hasText: '찾은 로고를 팀 로고로 썼어요' })
  await expect(toast).toBeVisible()
  await expect(teamLogo(page)).toHaveAttribute('src', /^\/team-icon\?v=[0-9a-f]{16}$/)
  await toast.getByRole('button', { name: '되돌리기' }).click()
  await expect(page.getByText('기본 아이콘으로 되돌렸어요.')).toBeVisible()
  await expect(teamLogo(page)).toHaveAttribute('src', '/favicon.svg')
  // the staged icon was used once: going back and saving again leaves the product's mark
  await page.getByTestId('welcome-back').click()
  await page.getByTestId('welcome-profile-continue').click()
  await expect(page.locator('[data-step="skills"]')).toBeVisible()
  await expect(teamLogo(page)).toHaveAttribute('src', '/favicon.svg')
  expect(realErrors(errors)).toEqual([])
})

test('회사 소개: a logo already there is never replaced, and nothing is said', async ({ page }) => {
  await reset(page)
  await noSlack(page)
  await signIn(page)
  await page.goto('/admin/settings')
  await page.getByTestId('team-icon-input').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from(makePng(64, 64)) })
  await expect(page.getByTestId('team-icon')).toHaveAttribute('data-version', /^[0-9a-f]{16}$/)
  const v = await page.getByTestId('team-icon').getAttribute('data-version')
  await page.goto('/welcome')
  await page.getByLabel('홈페이지 주소').fill('acme.example')
  await page.getByRole('button', { name: '읽어 오기' }).click()
  await expect(page.getByTestId('welcome-profile-line')).toBeVisible({ timeout: 15_000 })
  await stageIcon(page, makePng(256, 256, [14, 94, 78]))
  await page.getByTestId('welcome-profile-continue').click()
  await expect(page.locator('[data-step="skills"]')).toBeVisible()
  await expect(teamLogo(page)).toHaveAttribute('src', `/team-icon?v=${v}`)
  await expect(page.getByText('찾은 로고를 팀 로고로 썼어요')).toHaveCount(0)
})

for (const [width, scheme] of [[1440, 'light'], [390, 'dark']] as const) {
  test(`Admin › 팀 로고 › 홈페이지에서 가져오기 (${width} px, ${scheme}): only with a saved website; replaces the logo; "not found" in one line`, async ({ page }) => {
    const errors = watchConsole(page)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.emulateMedia({ colorScheme: scheme })
    await reset(page)
    await signIn(page)
    // a phone opens the settings group first (일반)
    await page.goto(width === 390 ? '/admin/settings/general' : '/admin/settings')
    await expect(page.getByTestId('team-icon')).toBeVisible()
    await expect(page.getByTestId('team-icon-from-site')).toHaveCount(0)
    await saveProfile(page, 'https://acme.example/')
    await page.reload()
    const button = page.getByTestId('team-icon-from-site')
    await expect(button).toContainText('홈페이지에서 가져오기')
    // nothing usable on the website: one line, pointing to the upload
    await button.click()
    await expect(page.getByTestId('team-icon-error')).toHaveText('홈페이지에서 쓸 만한 아이콘을 찾지 못했어요. 로고 파일을 올려 주세요.')
    await expect(page.getByTestId('team-icon')).toHaveAttribute('data-version', '')
    // found: the logo, and the toast
    await stageIcon(page, makePng(192, 192, [200, 40, 40]))
    await button.click()
    await expect(page.getByText('찾은 로고로 팀 로고를 바꿨어요.')).toBeVisible()
    await expect(page.getByTestId('team-icon-error')).toHaveCount(0)
    await expect(page.getByTestId('team-icon')).toHaveAttribute('data-version', /^[0-9a-f]{16}$/)
    if (width === 1440) await expect(teamLogo(page)).toHaveAttribute('src', /^\/team-icon\?v=[0-9a-f]{16}$/)
    // the "not found" answer is a 404 in the console, nothing else
    expect(realErrors(errors).filter((e) => !/status of 404/.test(e))).toEqual([])
  })
}

// With the team's AI (docs/decisions/20261128-team-icon-ai-assist.md): the press answers at once and the logo lands a
// moment later, with the same toast (and 되돌리기 on 회사 소개); Admin shows one line while the AI checks
const stageAiIcon = async (page: Page, png: Uint8Array | null, aiMs: number) =>
  expect((await page.request.post('/__test/site-icon', { data: { png: png ? Buffer.from(png).toString('base64') : null, aiMs } })).ok()).toBeTruthy()

test('회사 소개 with the team\'s AI: the steps go on at once; the logo and the same toast with 되돌리기 come a moment later', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  await noSlack(page)
  await signIn(page)
  await page.goto('/welcome')
  await page.getByLabel('홈페이지 주소').fill('acme.example')
  await page.getByRole('button', { name: '읽어 오기' }).click()
  await expect(page.getByTestId('welcome-profile-line')).toBeVisible({ timeout: 15_000 })
  await stageAiIcon(page, makePng(256, 256, [14, 94, 78]), 2500)
  await page.getByTestId('welcome-profile-continue').click()
  // not held on the step while the AI works
  await expect(page.locator('[data-step="skills"]')).toBeVisible()
  await expect(teamLogo(page)).toHaveAttribute('src', '/favicon.svg')
  const toast = page.getByRole('status').filter({ hasText: '찾은 로고를 팀 로고로 썼어요' })
  await expect(toast).toBeVisible({ timeout: 10_000 })
  await expect(teamLogo(page)).toHaveAttribute('src', /^\/team-icon\?v=[0-9a-f]{16}$/)
  await toast.getByRole('button', { name: '되돌리기' }).click()
  await expect(teamLogo(page)).toHaveAttribute('src', '/favicon.svg')
  expect(realErrors(errors)).toEqual([])
})

test('Admin › 팀 로고 with the team\'s AI: one line while it checks, then the logo and the toast; nothing found says so', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  await signIn(page)
  await saveProfile(page, 'https://acme.example/')
  await page.goto('/admin/settings')
  const button = page.getByTestId('team-icon-from-site')
  await stageAiIcon(page, makePng(192, 192, [200, 40, 40]), 1500)
  await button.click()
  await expect(page.getByTestId('team-icon-checking')).toHaveText('AI가 홈페이지 로고를 확인하고 있어요…')
  await expect(page.getByText('찾은 로고로 팀 로고를 바꿨어요.')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('team-icon-checking')).toHaveCount(0)
  await expect(page.getByTestId('team-icon')).toHaveAttribute('data-version', /^[0-9a-f]{16}$/)
  // the AI found nothing it would use: the same plain line as without AI
  await stageAiIcon(page, null, 800)
  await button.click()
  await expect(page.getByTestId('team-icon-error')).toHaveText('홈페이지에서 쓸 만한 아이콘을 찾지 못했어요. 로고 파일을 올려 주세요.', { timeout: 10_000 })
  await expect(button).toBeEnabled()
  expect(realErrors(errors)).toEqual([])
})
