import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { ja } from '../../src/i18n/ja'
import { es } from '../../src/i18n/es'
import { reset, signIn } from './helpers'

async function screenshot(page: Page, info: TestInfo, name: string) {
  const dir = process.env.I18N_SCREENSHOT_DIR
  if (dir) await mkdir(dir, { recursive: true })
  await page.screenshot({ path: dir ? path.join(dir, name) : info.outputPath(name), fullPage: true })
}

for (const [locale, label, dict] of [['ja', '日本語', ja], ['es', 'Español', es]] as const) {
  test(`${label}: account picker persists across settings, chat, files, skills and trash`, async ({ page }, info) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page)
    await page.goto('/settings')
    await page.getByRole('radio', { name: label, exact: true }).click()
    await expect(page.getByTestId(`locale-${locale}`)).toHaveAttribute('aria-checked', 'true')
    await expect(page.locator('html')).toHaveAttribute('lang', locale)
    await expect(page.getByRole('heading', { name: dict['settings.title'], exact: true })).toBeVisible()
    expect((await (await page.request.get('/api/me')).json()).user.localeChoice).toBe(locale)
    await screenshot(page, info, `${locale}-settings.png`)
    await page.reload()
    await expect(page.getByTestId(`locale-${locale}`)).toHaveAttribute('aria-checked', 'true')
    await page.goto('/')
    await expect(page.getByTestId('composer-input')).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', locale)
    await screenshot(page, info, `${locale}-chat.png`)
    await page.goto('/files')
    await expect(page.getByPlaceholder(dict['files.search.placeholder'])).toBeVisible()
    await screenshot(page, info, `${locale}-files.png`)
    for (const [route, key] of [['skills', 'skills.title'], ['trash', 'trash.title']] as const) {
      await page.goto(`/${route}`)
      await expect(page.getByRole('heading', { name: dict[key], exact: true })).toBeVisible()
      await screenshot(page, info, `${locale}-${route}.png`)
    }
  })
}

for (const [browser, expected] of [['ja-JP', 'ja'], ['es-MX', 'es'], ['fr-FR', 'en']] as const) {
  test.describe(`first-run browser ${browser}`, () => {
    test.use({ locale: browser })
    test(`detects ${expected}, with English for unsupported languages`, async ({ page }) => {
      await reset(page, { setup: true, teamLocale: 'en' })
      await page.goto('/')
      await expect(page).toHaveURL(/\/setup/)
      await expect(page.getByTestId('setup-locale')).toHaveValue(expected)
      await expect(page.locator('html')).toHaveAttribute('lang', expected)
    })
  })
}
