// Admin screens: a delete that the server answers with 204 (no body) refreshes the list at once, a failed one keeps the
// row, and the keyboard focus goes to the row that took the deleted row's place (else the screen's add button) instead
// of falling back to the page. Folder permissions: the delete dialog says what really happens next.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { DICTS, translate } from '../../src/i18n'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const t = DICTS.ko
const post = async (page: Page, url: string, data: unknown) => {
  const r = await page.request.post(url, { headers: { [CSRF_HEADER]: '1' }, data })
  expect(r.status(), url).toBe(201)
  return r.json()
}
const everyone = (access: 'none' | 'read' | 'write') => ({ subjectType: 'everyone', subjectId: null, access })

test('folder permissions: delete refreshes the list, focus moves on, the dialog says what follows', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  for (const p of ['docs', 'finance/2026', 'marketing']) await post(page, '/api/admin/folders', { path: p, create: true, rules: [everyone('read')] })
  await page.goto('/admin/folders')
  const list = page.getByTestId('folder-list')
  const row = (p: string) => list.locator('li').filter({ has: page.getByText(p, { exact: true }) })
  await expect(list.locator('li')).toHaveCount(4) // docs, finance, finance/2026, marketing

  // the edit dialog: the owner and admins write everywhere, but never see other people's personal folders
  await row('docs').getByRole('button', { name: t['common.edit'], exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText(t['rules.editHint'])
  await page.getByRole('dialog').getByRole('button', { name: t['common.cancel'], exact: true }).click()

  // finance/2026 then follows finance; the row goes without a reload and focus moves to the next row's delete
  let loads = 0
  page.on('load', () => loads++)
  await row('finance/2026').getByRole('button', { name: t['common.delete'], exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText(translate('ko', 'rules.removeBody', { path: 'finance' }))
  const gone = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes('/api/admin/folders/'))
  await page.getByTestId('dialog-confirm').click()
  expect((await gone).status()).toBe(204)
  await expect(row('finance/2026')).toHaveCount(0)
  await expect(row('marketing').getByRole('button', { name: t['common.delete'], exact: true })).toBeFocused()

  // docs has no folder above with rules: only the owner and admins see it then
  await row('docs').getByRole('button', { name: t['common.delete'], exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText(t['rules.removeBodyNone'])
  await expect(page.getByRole('dialog')).not.toContainText('{path}')
  await page.getByTestId('dialog-confirm').click()
  await expect(row('docs')).toHaveCount(0)
  await expect(row('finance').getByRole('button', { name: t['common.delete'], exact: true })).toBeFocused()

  // a refused delete keeps the row and says why
  await page.route('**/api/admin/folders/*', (r) => r.request().method() === 'DELETE' ? r.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'REFUSED-BY-SERVER' } } }) : r.fallback())
  await row('marketing').getByRole('button', { name: t['common.delete'], exact: true }).click()
  await page.getByTestId('dialog-confirm').click()
  await expect(page.getByText('REFUSED-BY-SERVER')).toBeVisible()
  await expect(row('marketing')).toHaveCount(1)
  await page.unroute('**/api/admin/folders/*')

  // the last rows: focus ends on "Add folder"
  for (const p of ['marketing', 'finance']) {
    await row(p).getByRole('button', { name: t['common.delete'], exact: true }).click()
    await page.getByTestId('dialog-confirm').click()
    await expect(row(p)).toHaveCount(0)
  }
  await expect(page.getByText(t['rules.none'], { exact: true })).toBeVisible()
  await expect(page.getByTestId('folder-rule-new')).toBeFocused()
  expect(loads).toBe(0)
  expect(realErrors(errors).filter((e) => !/status of 409/.test(e))).toEqual([])
})

test('groups and usage limits: delete refreshes the list and focus moves on', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  for (const name of ['영업팀', '운영팀']) await post(page, '/api/admin/groups', { name, memberIds: [] })
  for (const period of ['day', 'month']) await post(page, '/api/admin/budgets', { subjectType: 'team', subjectId: null, period, limitUsd: 0, limitTokens: 1000, action: 'warn' })

  await page.goto('/admin/groups')
  const groups = page.getByTestId('group-list').locator('li')
  await expect(groups).toHaveCount(3) // 재무팀 and the two above
  const third = await groups.nth(2).textContent()
  await groups.nth(1).getByRole('button', { name: t['common.delete'], exact: true }).click()
  await page.getByTestId('dialog-confirm').click()
  await expect(groups).toHaveCount(2)
  await expect(groups.nth(1)).toHaveText(third!)
  await expect(groups.nth(1).getByRole('button', { name: t['common.delete'], exact: true })).toBeFocused()

  await page.goto('/admin/engines')
  const limits = page.locator('section').filter({ has: page.getByTestId('budget-new') }).locator('li')
  await expect(limits).toHaveCount(2)
  await limits.first().getByRole('button', { name: t['common.delete'], exact: true }).click()
  await expect(limits).toHaveCount(1)
  await expect(limits.first().getByRole('button', { name: t['common.delete'], exact: true })).toBeFocused()
  await limits.first().getByRole('button', { name: t['common.delete'], exact: true }).click()
  await expect(page.getByText(t['budgets.none'], { exact: true })).toBeVisible()
  await expect(page.getByTestId('budget-new')).toBeFocused()
  expect(realErrors(errors)).toEqual([])
})
