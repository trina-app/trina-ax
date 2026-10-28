// WCAG 2.2 AA checks with axe-core on the main screens (tab 5 "접근성"), in light and dark themes.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

for (const scheme of ['light', 'dark'] as const) {
  test(`no serious accessibility problems (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await reset(page)
    await page.goto('/login')
    await expect(page.getByTestId('login-username')).toBeVisible()
    await audit(page, 'login')
    await signIn(page)
    await audit(page, 'home')
    await page.getByTestId('composer-input').fill('files and search please')
    await page.getByTestId('send').click()
    await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done')
    await audit(page, 'chat')
    await page.goto('/files?path=marketing')
    await expect(page.getByTestId('file-table')).toBeVisible()
    await audit(page, 'files')
    // checked rows and the selection bar
    await page.getByTestId('file-check').first().click()
    await expect(page.getByTestId('bulk-bar')).toBeVisible()
    await audit(page, 'files (selection)')
    await page.goto('/admin/members')
    await expect(page.getByTestId('members-table')).toBeVisible()
    await audit(page, 'admin')
    await page.goto('/settings/profile')
    await audit(page, 'settings')
  })
}

// Phone width (PWA): labels that collapse to icons must keep their accessible names, dimmed rows their contrast.
test('no serious accessibility problems at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  await signIn(page)
  await audit(page, 'home (phone)')
  await page.goto('/files')
  await expect(page.getByTestId('file-table')).toBeVisible()
  await expect(page.getByRole('button', { name: '새 폴더' })).toBeVisible()
  await audit(page, 'files (phone)')
  await page.getByTestId('select-all').click()
  await expect(page.getByTestId('bulk-bar')).toBeVisible()
  await audit(page, 'files selection (phone)')
  await page.goto('/admin/members')
  await expect(page.getByTestId('members-table')).toBeVisible()
  await audit(page, 'admin (phone)')
})

// Every admin section, the other settings tabs, projects, trash, an ask card and the file preview panel, in both
// themes: the screens an owner configures the team on are as readable as the chat.
for (const scheme of ['light', 'dark'] as const) {
  test(`the remaining screens have no serious accessibility problems (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await reset(page)
    await signIn(page)
    for (const s of ['groups', 'folders', 'engines', 'usage', 'audit', 'settings', 'system']) {
      await page.goto(`/admin/${s}`)
      await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible()
      await page.waitForTimeout(300)
      await audit(page, `admin/${s}`)
    }
    for (const s of ['security', 'memory', 'apps']) {
      await page.goto(`/settings/${s}`)
      await page.waitForTimeout(300)
      await audit(page, `settings/${s}`)
    }
    await page.goto('/projects')
    await page.waitForTimeout(300)
    await audit(page, 'projects')
    await page.goto('/trash')
    await page.waitForTimeout(300)
    await audit(page, 'trash')
    await page.goto('/files?path=marketing')
    await page.getByTestId('file-row').filter({ hasText: 'plan.md' }).first().getByRole('button').first().click()
    await page.waitForTimeout(500)
    await audit(page, 'file preview')
    await page.goto('/')
    await page.getByTestId('composer-input').fill('please ask me something')
    await page.getByTestId('send').click()
    await expect(page.getByTestId('ask-card')).toBeVisible()
    await audit(page, 'ask card')
  })
}
