// Admin screens: a delete that the server answers with 204 (no body) refreshes the list at once, a failed one keeps the
// row, and the keyboard focus goes on instead of falling back to the page: to the next row's delete only where a
// confirm dialog comes first, else to the next row's Edit or the list's title, so a held Enter deletes one row. Folder
// permissions: the delete dialog shows the server's "who sees what" for no rules, and rows the server keeps say why.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { DICTS, translate } from '../../src/i18n'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const t = DICTS.ko
const deleteNamed = (name: string) => translate('ko', 'common.deleteNamed', { name })
const post = async (page: Page, url: string, data: unknown) => {
  const r = await page.request.post(url, { headers: { [CSRF_HEADER]: '1' }, data })
  expect(r.status(), url).toBe(201)
  return r.json()
}
const everyone = (access: 'none' | 'read' | 'write') => ({ subjectType: 'everyone', subjectId: null, access })
/** a key held down: the keydowns after the first carry repeat = true */
async function holdEnter(page: Page, presses = 25) {
  for (let i = 0; i < presses; i++) {
    await page.keyboard.down('Enter')
    await page.waitForTimeout(40)
  }
  await page.keyboard.up('Enter')
  await page.waitForTimeout(800)
}

test('folder permissions: delete refreshes the list, focus moves on, the dialog shows who gains or loses what', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  for (const p of ['docs', 'finance/2026', 'marketing']) await post(page, '/api/admin/folders', { path: p, create: true, rules: [everyone('read')] })
  await page.goto('/admin/folders')
  const list = page.getByTestId('folder-list')
  const row = (p: string) => list.locator(`[data-path="${p}"]`)
  const del = (p: string) => row(p).getByRole('button', { name: deleteNamed(p), exact: true })
  await expect(list.locator('li')).toHaveCount(4) // docs, finance, finance/2026, marketing

  // the edit dialog: the owner and admins write everywhere, but never see other people's personal folders
  await row('docs').getByRole('button', { name: t['common.edit'], exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText(t['rules.editHint'])
  await page.getByRole('dialog').getByRole('button', { name: t['common.cancel'], exact: true }).click()

  // the dialog asks the server what "no rules here" does, person by person: Bob is in no group that finance names, and
  // the team root lets everyone read, so he gains read (the nearest folder above is not the answer for him)
  let loads = 0
  page.on('load', () => loads++)
  const asked: unknown[] = []
  await page.route('**/api/admin/folder-rules/preview', async (r) => {
    asked.push(r.request().postDataJSON())
    await r.fulfill({ json: { folders: [{ path: 'finance/2026', users: [
      { user: { id: 'olga', name: 'Olga' }, role: 'owner', before: 'write', after: 'write' },
      { user: { id: 'bob', name: 'Bob' }, role: 'member', before: 'none', after: 'read' },
    ] }], losing: [] } })
  })
  await del('finance/2026').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('rules-remove-preview')).toContainText(t['rules.removeKeeps'])
  await expect(dialog).toContainText(translate('ko', 'rules.removeAt', { path: 'finance/2026' }))
  const bob = dialog.getByRole('listitem').filter({ hasText: 'Bob' })
  await expect(bob).toContainText(t['access.none'])
  await expect(bob).toContainText(t['access.read'])
  await expect(dialog.getByRole('listitem').filter({ hasText: 'Olga' })).toHaveCount(0) // unchanged people are left out
  expect(asked).toEqual([{ changes: [{ path: 'finance/2026', rules: [] }] }])
  const gone = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes('/api/admin/folders/'))
  await page.getByTestId('dialog-confirm').click()
  expect((await gone).status()).toBe(204)
  await expect(row('finance/2026')).toHaveCount(0)
  await expect(del('marketing')).toBeFocused() // a confirm dialog comes before each delete here

  // a slow answer: the button says it is busy, and after 5 seconds the dialog opens with the general text
  await page.unroute('**/api/admin/folder-rules/preview')
  await page.route('**/api/admin/folder-rules/preview', async (r) => {
    await new Promise((done) => setTimeout(done, 8000))
    await r.fulfill({ json: { folders: [], losing: [] } }).catch(() => {}) // the page gave up on it
  })
  const asking = Date.now()
  await del('docs').click()
  await expect(del('docs')).toHaveAttribute('aria-busy', 'true')
  await expect(dialog).toContainText(t['rules.removeBody'], { timeout: 7000 })
  expect(Date.now() - asking).toBeGreaterThanOrEqual(4500)
  await dialog.getByRole('button', { name: t['common.cancel'], exact: true }).click()
  await expect(del('docs')).not.toHaveAttribute('aria-busy', 'true')

  // no preview (the server could not answer): the general text, which does not promise more than the server does
  await page.unroute('**/api/admin/folder-rules/preview')
  await page.route('**/api/admin/folder-rules/preview', (r) => r.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'x' } } }))
  await del('docs').click()
  await expect(dialog).toContainText(t['rules.removeBody'])
  await expect(dialog.getByTestId('rules-remove-preview')).toHaveCount(0)
  await page.getByTestId('dialog-confirm').click()
  await expect(row('docs')).toHaveCount(0)
  await expect(del('finance')).toBeFocused()
  await page.unroute('**/api/admin/folder-rules/preview')

  // nothing changes for anyone: it says so
  await page.route('**/api/admin/folder-rules/preview', (r) => r.fulfill({ json: { folders: [{ path: 'marketing', users: [{ user: { id: 'olga', name: 'Olga' }, role: 'owner', before: 'write', after: 'write' }] }], losing: [] } }))
  await del('marketing').click()
  await expect(dialog).toContainText(t['rules.removeNoChange'])
  await dialog.getByRole('button', { name: t['common.cancel'], exact: true }).click()
  await expect(del('marketing')).toBeFocused()

  // a refused delete keeps the row and says why
  await page.route('**/api/admin/folders/*', (r) => r.request().method() === 'DELETE' ? r.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'REFUSED-BY-SERVER' } } }) : r.fallback())
  await del('marketing').click()
  await page.getByTestId('dialog-confirm').click()
  await expect(page.getByText('REFUSED-BY-SERVER')).toBeVisible()
  await expect(row('marketing')).toHaveCount(1)
  await page.unroute('**/api/admin/folders/*')
  await page.unroute('**/api/admin/folder-rules/preview')

  // the last rows: focus ends on "Add folder"
  for (const p of ['marketing', 'finance']) {
    await del(p).click()
    await page.getByTestId('dialog-confirm').click()
    await expect(row(p)).toHaveCount(0)
  }
  await expect(page.getByText(t['rules.none'], { exact: true })).toBeVisible()
  await expect(page.getByTestId('folder-rule-new')).toBeFocused()
  expect(loads).toBe(0)
  expect(realErrors(errors).filter((e) => !/status of (409|503)/.test(e))).toEqual([])
})

test('groups: delete (after a confirm) refreshes the list and focus moves to the next delete', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  for (const name of ['영업팀', '운영팀']) await post(page, '/api/admin/groups', { name, memberIds: [] })
  await page.goto('/admin/groups')
  const groups = page.getByTestId('group-list').locator('li')
  await expect(groups).toHaveCount(3) // 재무팀 and the two above
  await groups.filter({ hasText: '영업팀' }).getByRole('button', { name: deleteNamed('영업팀'), exact: true }).click()
  await page.getByTestId('dialog-confirm').click()
  await expect(groups).toHaveCount(2)
  await expect(groups.filter({ hasText: '영업팀' })).toHaveCount(0)
  await expect(groups.nth(1).getByRole('button', { name: deleteNamed('운영팀'), exact: true })).toBeFocused()
  expect(realErrors(errors)).toEqual([])
})

test('usage limits go at once: a held Enter deletes one, focus goes to the next Edit, then to the title', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  for (const period of ['day', 'month', 'day', 'month']) await post(page, '/api/admin/budgets', { subjectType: 'team', subjectId: null, period, limitUsd: 0, limitTokens: 1000, action: 'warn' })
  await page.goto('/admin/engines')
  const limits = page.locator('section').filter({ has: page.getByTestId('budget-new') }).locator('li')
  await expect(limits).toHaveCount(4)
  const team = t['budgets.team']
  const delFirst = () => limits.first().getByRole('button', { name: deleteNamed(`${team} · ${t['budgets.perDay']}`), exact: true })
  await delFirst().focus()
  await holdEnter(page)
  await expect(limits).toHaveCount(3)
  expect((await (await page.request.get('/api/admin/budgets')).json()).items).toHaveLength(3)
  await expect(limits.first().getByRole('button', { name: t['common.edit'], exact: true })).toBeFocused()
  await expect(page.getByRole('dialog')).toHaveCount(0) // the held key did not open Edit either

  // with the mouse too, one at a time; the last one leaves the focus on the list's title
  for (let n = 3; n > 0; n--) {
    await limits.first().getByRole('button', { name: new RegExp(`^${team} · `) }).click()
    await expect(limits).toHaveCount(n - 1)
  }
  await expect(page.getByText(t['budgets.none'], { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: t['budgets.title'], exact: true })).toBeFocused()
  expect(realErrors(errors)).toEqual([])
})

test('invites are revoked at once: a held Enter revokes one, focus goes to the list\'s title', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  for (let i = 0; i < 3; i++) await post(page, '/api/admin/invites', { role: 'member', groupIds: [] })
  await page.goto('/admin/members')
  const invites = page.getByTestId('invite-list').locator('li')
  await expect(invites).toHaveCount(3)
  await invites.first().getByRole('button', { name: t['members.revoke'], exact: true }).focus()
  await holdEnter(page)
  await expect(invites).toHaveCount(2)
  expect((await (await page.request.get('/api/admin/invites')).json()).items).toHaveLength(2)
  await expect(page.getByRole('heading', { name: t['members.invites'], exact: true })).toBeFocused()
  expect(realErrors(errors)).toEqual([])
})

test('folder permissions: shared, skills and a group\'s folder say why they stay; no rule left cannot be saved', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await post(page, '/api/admin/folders', { path: 'shared', create: true, rules: [everyone('write')] })
  await post(page, '/api/admin/folders', { path: 'skills', create: true, rules: [everyone('read'), { subjectType: 'role', subjectId: 'admin', access: 'write' }] })
  const group = await post(page, '/api/admin/groups', { name: '영업팀', memberIds: [] })
  await page.goto('/admin/folders')
  const row = (p: string) => page.getByTestId('folder-list').locator(`[data-path="${p}"]`)
  const del = (p: string) => row(p).getByRole('button', { name: deleteNamed(p), exact: true })
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

  // no rule left on shared: said in the editor before saving, and Save waits for a rule
  await row('shared').getByRole('button', { name: t['common.edit'], exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: t['rules.removeRule'], exact: true }).click()
  await expect(page.getByTestId('rules-keep-one')).toHaveText(t['rules.keepTeam'])
  await expect(page.getByTestId('rules-save')).toBeDisabled()
  await expect(page.getByTestId('rules-save')).toHaveAccessibleDescription(t['rules.keepTeam'])
  // what it says to do instead works: Everyone, No access
  await page.getByTestId('rule-add').click()
  await expect(page.getByTestId('rules-keep-one')).toHaveCount(0)
  await dialog.getByLabel(t['rules.who'], { exact: true }).selectOption('everyone')
  await dialog.getByLabel(t['rules.access'], { exact: true }).selectOption('none')
  await page.getByTestId('rules-save').click()
  await expect(dialog).toHaveCount(0)
  await expect(row('shared')).toContainText(`${t['rules.everyone']}: ${t['access.none']}`)

  // a save the server refuses shows its reason in the dialog, which stays open
  await page.route('**/api/admin/folders/*/rules', (r) => r.fulfill({ status: 400, json: { error: { code: 'validation', message: 'REFUSED-BY-SERVER', fields: { 'body.rules': 'x' } } } }))
  await row('groups/영업팀').getByRole('button', { name: t['common.edit'], exact: true }).click()
  await page.getByTestId('rules-save').click()
  await expect(page.getByTestId('rules-refused').getByRole('alert')).toHaveText('REFUSED-BY-SERVER')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: t['common.cancel'], exact: true }).click()
  await page.unroute('**/api/admin/folders/*/rules')

  // once the group is deleted, its folder is an ordinary row
  const gone = await page.request.delete(`/api/admin/groups/${group.id}`, { headers: { [CSRF_HEADER]: '1' } })
  expect(gone.status()).toBe(204)
  await page.reload()
  await expect(del('groups/영업팀')).toHaveCount(1)
  await expect(row('groups/영업팀').getByTestId('folder-keep-reason')).toHaveCount(0)
  expect(realErrors(errors).filter((e) => !/status of 400/.test(e))).toEqual([])
})
