// Auto mode in the web app (docs/decisions/20261125-auto-mode.md): the composer's pill (hidden while the team value is
// off; the first turn-on shows one sheet; later taps change it at once), Settings › 트리나에게 허용한 것 (the switch and
// the cards it approved), and Admin › Team settings (the three values, saved with the form).
import { expect, test } from '@playwright/test'
import { reset, signIn } from './helpers'

test.use({ serviceWorkers: 'block' })

test('the pill: hidden while the team value is off; allowed: Ask, the first turn-on asks once, then it changes at once', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await expect(page.getByTestId('composer-input')).toBeVisible()
  await expect(page.getByTestId('auto-mode-pill')).toHaveCount(0)

  await page.request.post('/__test/auto-mode', { data: { team: 'allowed' } })
  await page.reload()
  const pill = page.getByTestId('auto-mode-pill')
  await expect(pill).toHaveText('묻기')
  await expect(pill).toHaveAttribute('aria-pressed', 'false')
  await pill.click()
  await expect(page.getByTestId('auto-mode-intro')).toContainText('항상 물어봐요')
  await page.getByRole('button', { name: '자동 모드 켜기' }).click()
  await expect(pill).toHaveText('자동')
  await expect(pill).toHaveAttribute('aria-pressed', 'true')
  // off: no sheet
  await pill.click()
  await expect(pill).toHaveText('묻기')
  await expect(page.getByTestId('auto-mode-intro')).toHaveCount(0)
  // on again: the sheet was shown once in this browser
  await pill.click()
  await expect(pill).toHaveText('자동')
  await expect(page.getByTestId('auto-mode-intro')).toHaveCount(0)
})

test('Settings › 트리나에게 허용한 것: the switch and the cards auto mode approved; nothing while the team value is off', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/settings/allowances')
  await expect(page.getByTestId('ai-allowances')).toBeVisible()
  await expect(page.getByTestId('auto-mode-settings')).toHaveCount(0)

  await page.request.post('/__test/auto-mode', { data: { team: 'default', recent: [{ kind: 'move_files', chatId: '019a5f00-0000-7000-8000-000000000b01', chatTitle: '견적 정리', at: '2026-11-25T03:00:00.000Z' }] } })
  await page.reload()
  const box = page.getByTestId('auto-mode-settings')
  await expect(box).toBeVisible()
  await expect(page.getByTestId('auto-mode-switch')).toBeChecked()
  await expect(page.getByTestId('auto-mode-recent-row')).toHaveCount(1)
  await expect(page.getByTestId('auto-mode-recent-row')).toContainText('견적 정리')
  const saved = page.waitForRequest((r) => r.url().endsWith('/api/ai-allowances/auto-mode') && r.method() === 'PUT')
  await box.locator('label').click()
  expect((await saved).postDataJSON()).toEqual({ on: false, via: 'settings' })
  await expect(page.getByTestId('auto-mode-switch')).not.toBeChecked()
})

test('Admin › Team settings: auto mode, off by default, saved with the form', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/admin/settings')
  const select = page.locator('#ts-auto-mode')
  await expect(select).toHaveValue('off')
  const saved = page.waitForRequest((r) => r.url().endsWith('/api/admin/settings') && r.method() === 'PATCH')
  await select.selectOption('allowed')
  await page.getByRole('button', { name: '저장', exact: true }).click()
  expect((await saved).postDataJSON()).toEqual({ autoMode: 'allowed' })
  await page.reload()
  await expect(page.locator('#ts-auto-mode')).toHaveValue('allowed')
})
