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

test('folder permissions: shared, skills and a group\'s folder say why they stay; the server\'s refusal shows in the dialog', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await post(page, '/api/admin/folders', { path: 'shared', create: true, rules: [everyone('write')] })
  await post(page, '/api/admin/folders', { path: 'skills', create: true, rules: [everyone('read'), { subjectType: 'role', subjectId: 'admin', access: 'write' }] })
  const group = await post(page, '/api/admin/groups', { name: '영업팀', memberIds: [] })
  await page.goto('/admin/folders')
  const row = (p: string) => page.getByTestId('folder-list').locator(`[data-path="${p}"]`)
  const del = (p: string) => row(p).getByRole('button', { name: t['common.delete'], exact: true })
  await expect(page.getByTestId('folder-list').locator('li')).toHaveCount(4) // finance, groups/영업팀, shared, skills
  for (const p of ['shared', 'skills']) {
    await expect(del(p)).toHaveCount(0)
    await expect(row(p).getByTestId('folder-keep-reason')).toHaveText(t['rules.keepTeam'])
  }
  await expect(del('groups/영업팀')).toHaveCount(0)
  await expect(row('groups/영업팀').getByTestId('folder-keep-reason')).toHaveText(translate('ko', 'rules.keepGroup', { name: '영업팀' }))
  await expect(row('finance').getByTestId('folder-keep-reason')).toHaveCount(0)
  if (process.env.FOLDER_SHOTS) {
    for (const size of [{ width: 1360, height: 860 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size)
      await page.screenshot({ path: `${process.env.FOLDER_SHOTS}/folders-${size.width}.png`, fullPage: true })
    }
    await page.setViewportSize({ width: 1360, height: 860 })
  }

  // the row after a deleted one cannot go: focus lands on its Edit
  await del('finance').click()
  await page.getByTestId('dialog-confirm').click()
  await expect(row('finance')).toHaveCount(0)
  await expect(row('groups/영업팀').getByRole('button', { name: t['common.edit'], exact: true })).toBeFocused()

  // no rule left on shared: the server says no, in the dialog, and nothing changes
  await row('shared').getByRole('button', { name: t['common.edit'], exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: t['rules.removeRule'], exact: true }).click()
  await page.getByTestId('rules-save').click()
  const refused = page.getByTestId('rules-refused')
  await expect(refused).toContainText(`"${t['rules.everyone']}: ${t['access.none']}"`)
  await expect(refused.getByRole('alert')).toBeVisible()
  await expect(dialog).toBeVisible()
  // what the message says to do instead works: Everyone, No access
  await page.getByTestId('rule-add').click()
  await expect(refused).toHaveCount(0)
  await dialog.getByLabel(t['rules.who'], { exact: true }).selectOption('everyone')
  await dialog.getByLabel(t['rules.access'], { exact: true }).selectOption('none')
  await page.getByTestId('rules-save').click()
  await expect(dialog).toHaveCount(0)
  await expect(row('shared')).toContainText(`${t['rules.everyone']}: ${t['access.none']}`)

  // once the group is deleted, its folder is an ordinary row
  const gone = await page.request.delete(`/api/admin/groups/${group.id}`, { headers: { [CSRF_HEADER]: '1' } })
  expect(gone.status()).toBe(204)
  await page.reload()
  await expect(del('groups/영업팀')).toHaveCount(1)
  await expect(row('groups/영업팀').getByTestId('folder-keep-reason')).toHaveCount(0)
  expect(realErrors(errors).filter((e) => !/status of 400/.test(e))).toEqual([])
})
