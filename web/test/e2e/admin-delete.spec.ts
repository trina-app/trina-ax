// Admin screens: a delete that the server answers with 204 (no body) refreshes the list at once, a failed one keeps the
// row, and the keyboard focus goes on instead of falling back to the page: to the next row's delete only where a
// confirm dialog comes first, else to the next row's Edit or the list's title, so a held Enter deletes one row. Folder
// permissions (two lists since docs/DECISIONS.md "Admin › Folder permissions as two lists, like Drive"): there is no
// delete of a folder's rules any more; all of a folder's sharing goes in its Share dialog, and the folder then leaves
// the list of folders with their own sharing.
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

// Folder permissions › Folders: only the folders with their own sharing, each with [Share] (admin-folders.spec.ts). Taking
// everyone off a folder is done in its Share dialog: Remove access in each row's role menu, then Save, which leaves the
// folder with nothing of its own (a PUT with no rules, never a delete), so it follows the folder it is in and leaves the
// list.
const folderRow = (page: Page, p: string) => page.getByTestId('folders-row').and(page.locator(`[data-path="${p}"]`))
const panel = (page: Page) => page.getByTestId('folder-access-panel')
/** Save, and Give access / Save anyway when it asks */
async function save(page: Page) {
  await page.getByTestId('sharing-save').click()
  const ok = page.getByTestId('dialog-confirm')
  await expect(page.getByTestId('sharing-done').or(ok).or(page.getByTestId('sharing-footer-bar').getByRole('alert'))).toBeVisible()
  if (await ok.isVisible()) await ok.click()
}

test('folder permissions: a folder\'s sharing is all removed in its Share dialog; it then leaves the list', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await post(page, '/api/admin/folders', { path: 'marketing', create: false, rules: [{ subjectType: 'user', subjectId: 'bob', access: 'write' }, everyone('read')] })
  await page.goto('/admin/folders')
  let loads = 0
  page.on('load', () => loads++)
  await expect(folderRow(page, 'marketing')).toBeVisible()
  await expect(folderRow(page, 'finance')).toBeVisible()
  // no delete of rules anywhere on the list: [Share] is the only way in
  await expect(page.getByTestId('folders-list').getByRole('button', { name: t['common.delete'] })).toHaveCount(0)
  await expect(folderRow(page, 'marketing').getByRole('button')).toHaveCount(1)

  // the dialog lists the owner and admins (they always open it), and closes without asking when nothing changed; the
  // focus goes back to the folder's [Share]
  await folderRow(page, 'marketing').getByTestId('folders-share').click()
  await expect(panel(page)).toHaveAttribute('data-path', 'marketing')
  await expect(page.getByTestId('sharing-staff')).toContainText(t['folderAccess.staffRow'])
  await page.getByTestId('sharing-done').click()
  await expect(panel(page)).toHaveCount(0)
  await expect(folderRow(page, 'marketing').getByTestId('folders-share')).toBeFocused()

  // Remove access for Bob, and the team back to Restricted (the folder above gives no one more)
  await folderRow(page, 'marketing').getByTestId('folders-share').click()
  await expect(panel(page).getByTestId('sharing-row').first()).toBeVisible()
  while (await panel(page).getByTestId('sharing-level').count()) {
    await panel(page).getByTestId('sharing-level').first().selectOption('remove')
    await page.getByTestId('dialog-confirm').click()
  }
  await panel(page).getByTestId('sharing-general-select').selectOption('restricted')
  await expect(page.getByTestId('sharing-outcome')).toBeVisible()
  const put = page.waitForRequest((r) => r.method() === 'PUT' && r.url().includes('/rules'))
  await save(page)
  expect((await put).postDataJSON()).toMatchObject({ rules: [] })
  await page.getByTestId('sharing-done').click()
  await expect(panel(page)).toHaveCount(0)
  // nothing of its own any more: it follows the folder it is in, and is not on the list; the other rows stay
  await expect(folderRow(page, 'marketing')).toHaveCount(0)
  await expect(folderRow(page, 'finance')).toBeVisible()
  const items = (await (await page.request.get('/api/admin/folders')).json()).items as { path: string; rules: unknown[] }[]
  expect(items.find((f) => f.path === 'marketing')?.rules ?? []).toEqual([])
  // and Bob can no longer open it (the team root gives members nothing)
  const bob = (await (await page.request.get('/api/admin/access/people/bob?limit=2000')).json()).folders as { path: string; access: string }[]
  expect(bob.find((f) => f.path === 'marketing')?.access ?? 'none').toBe('none')
  expect(loads).toBe(0)
  expect(realErrors(errors)).toEqual([])
})

test('groups: delete (after a confirm) refreshes the list and focus moves to the next row\'s "…"', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  for (const name of ['영업팀', '운영팀']) await post(page, '/api/admin/groups', { name, memberIds: [] })
  await page.goto('/admin/groups')
  const groups = page.getByTestId('group-list').locator('li')
  await expect(groups).toHaveCount(3) // 재무팀 and the two above
  await groups.filter({ hasText: '영업팀' }).getByTestId('member-more').click()
  await page.getByRole('menu').getByTestId('group-delete').click()
  await page.getByTestId('dialog-confirm').click()
  await expect(groups).toHaveCount(2)
  await expect(groups.filter({ hasText: '영업팀' })).toHaveCount(0)
  await expect(groups.nth(1).getByRole('button', { name: t['members.actionsFor'].replace('{name}', '운영팀'), exact: true })).toBeFocused()
  expect(realErrors(errors)).toEqual([])
})

// An AI connection only a group or a person may use is switched off when they are deleted, never given to the whole team
// (server/src/credentials/assignees.ts): the confirmation names it, in one line under the usual text.
test('group and member delete: the confirmation names the AI connections only they use; the connection is then off', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  const g = await post(page, '/api/admin/groups', { name: '영업팀', memberIds: [] })
  // two keys added through Admin › AI providers (sealed in the page), then given to the group and to bob
  await page.goto('/admin/providers')
  for (const [label, n] of [['영업 키', 'a'], ['밥 키', 'b']] as const) {
    await page.getByTestId('provider-add-claude').click()
    await page.getByTestId('kind-anthropic-api-key').check()
    await page.getByTestId('credential-label').fill(label)
    await page.getByTestId('credential-secret').fill('sk-ant-api03-' + n.repeat(40) + 'WXYZ')
    await page.getByTestId('credential-submit').click()
    await expect(page.getByTestId('credentials-claude')).toContainText(label)
  }
  const items = (await (await page.request.get('/api/admin/credentials')).json()).items as { id: string; label: string }[]
  const assign = async (label: string, a: { subjectType: 'group' | 'user'; subjectId: string }) => {
    const r = await page.request.patch(`/api/admin/credentials/${items.find((c) => c.label === label)!.id}`, { headers: { [CSRF_HEADER]: '1' }, data: { assignments: [a] } })
    expect(r.ok()).toBe(true)
  }
  await assign('영업 키', { subjectType: 'group', subjectId: g.id })
  await assign('밥 키', { subjectType: 'user', subjectId: 'bob' })

  await page.goto('/admin/groups')
  const groups = page.getByTestId('group-list').locator('li')
  await groups.filter({ hasText: '영업팀' }).getByTestId('member-more').click()
  await page.getByRole('menu').getByTestId('group-delete').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText(t['groups.deleteBody'])
  await expect(dialog.getByTestId('group-delete-ai-off')).toHaveText(translate('ko', 'groups.deleteAiOff', { names: '영업 키' }))
  await page.getByTestId('dialog-confirm').click()
  await expect(groups.filter({ hasText: '영업팀' })).toHaveCount(0)
  // a group nothing is assigned to only: no such line
  await groups.filter({ hasText: '재무팀' }).getByTestId('member-more').click()
  await page.getByRole('menu').getByTestId('group-delete').click()
  await expect(page.getByRole('dialog')).toContainText(t['groups.deleteBody'])
  await expect(page.getByTestId('group-delete-ai-off')).toHaveCount(0)
  await page.getByRole('dialog').getByRole('button', { name: t['common.cancel'], exact: true }).click()

  await page.goto('/admin/members')
  await page.getByTestId('members-table').getByRole('row').filter({ hasText: 'Bob' }).getByTestId('member-more').click()
  await page.getByTestId('delete-member-bob').click()
  await expect(page.getByRole('dialog').getByTestId('member-delete-ai-off')).toHaveText(translate('ko', 'members.removeAiOff', { names: '밥 키' }))
  await page.getByTestId('dialog-confirm').click()
  await expect(page.getByTestId('delete-member-bob')).toHaveCount(0)

  // both are off now and for nobody in particular
  const after = (await (await page.request.get('/api/admin/credentials')).json()).items as { label: string; disabled: boolean; assignments: unknown[] }[]
  for (const label of ['영업 키', '밥 키']) expect(after.find((c) => c.label === label)).toMatchObject({ disabled: true, assignments: [] })
  expect(realErrors(errors)).toEqual([])
})

test('usage limits go at once: a held Enter deletes one, focus goes to the next Edit, then to the title', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  for (const period of ['day', 'month', 'day', 'month']) await post(page, '/api/admin/budgets', { subjectType: 'team', subjectId: null, period, limitUsd: 0, limitTokens: 1000, action: 'warn' })
  await page.goto('/admin/settings#ai')
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

test('folder permissions: shared keeps a setting of its own (Restricted = Limited); a refused save stays open; a deleted group\'s rule goes', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await post(page, '/api/admin/folders', { path: 'shared', create: true, rules: [everyone('write')] })
  await post(page, '/api/admin/folders', { path: 'skills', create: true, rules: [everyone('read')] })
  const group = await post(page, '/api/admin/groups', { name: '영업팀', memberIds: [] })
  await page.goto('/admin/folders')
  const settled = () => expect(page.getByTestId('sharing-outcome')).toBeVisible()
  // a group's own folder as it was made is not listed (only its group, Editor)
  await expect(folderRow(page, 'shared')).toBeVisible()
  await expect(folderRow(page, 'skills')).toBeVisible()
  await expect(folderRow(page, 'groups/영업팀')).toHaveCount(0)
  if (process.env.FOLDER_SHOTS) {
    for (const size of [{ width: 1360, height: 860 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size)
      await page.screenshot({ path: `${process.env.FOLDER_SHOTS}/folders-${size.width}.png`, fullPage: true })
    }
    await page.setViewportSize({ width: 1360, height: 860 })
  }

  // shared keeps a setting of its own: General access is never "follows the folder above" there (nothing to inherit
  // from), and Restricted makes it Limited with nobody added: only the owner and admins
  await folderRow(page, 'shared').getByTestId('folders-share').click()
  await expect(panel(page).getByTestId('sharing-general-inherited')).toHaveCount(0)
  await panel(page).getByTestId('sharing-general-select').selectOption('restricted')
  await expect(panel(page).getByTestId('sharing-keep-one')).toHaveCount(0)
  await settled()
  await save(page)
  await page.getByTestId('sharing-done').click()
  await expect(panel(page)).toHaveCount(0)
  const shared = ((await (await page.request.get('/api/admin/folders')).json()).items as { path: string; limited?: boolean; rules: { subjectType: string; access: string }[] }[]).find((f) => f.path === 'shared')!
  expect(shared.limited).toBe(true)
  expect(shared.rules.filter((r) => r.access !== 'none')).toEqual([])
  await expect(folderRow(page, 'shared').getByTestId('folder-kind')).toHaveText(t['folders.kindLimited'])
  await expect(folderRow(page, 'shared').getByTestId('folders-row-who')).toHaveText(t['folders.whoStaff'])
  const bob = (await (await page.request.get('/api/admin/access/people/bob?limit=2000')).json()).folders as { path: string; access: string }[]
  expect(bob.find((f) => f.path === 'shared')?.access ?? 'none').toBe('none')

  // a save the server refuses shows its reason in the panel, which stays open (the group's folder, opened by its address)
  await page.route('**/api/admin/folders/*/rules', (r) => r.fulfill({ status: 400, json: { error: { code: 'validation', message: 'REFUSED-BY-SERVER', fields: { 'body.rules': 'x' } } } }))
  await page.goto(`/admin/folders?edit=${encodeURIComponent('groups/영업팀')}`)
  await expect(panel(page)).toHaveAttribute('data-path', 'groups/영업팀')
  await panel(page).getByTestId('sharing-general-select').selectOption('team')
  await settled()
  await save(page)
  await expect(page.getByTestId('sharing-footer-bar')).toContainText('REFUSED-BY-SERVER')
  await expect(panel(page)).toBeVisible()
  await page.getByTestId('sharing-cancel').click()
  await page.getByTestId('dialog-confirm').click()
  await page.getByTestId('sharing-done').click()
  await expect(panel(page)).toHaveCount(0)
  await page.unroute('**/api/admin/folders/*/rules')
  const groupRules = async () => ((await (await page.request.get('/api/admin/folders')).json()).items as { path: string; rules: { subjectType: string; subjectId: string | null }[] }[]).find((f) => f.path === 'groups/영업팀')?.rules ?? []
  expect((await groupRules()).filter((r) => r.subjectType === 'group' && r.subjectId === group.id)).toHaveLength(1)

  // once the group is deleted, its rule goes with it; the folder is an ordinary one, and still not on the list
  const gone = await page.request.delete(`/api/admin/groups/${group.id}`, { headers: { [CSRF_HEADER]: '1' } })
  expect(gone.status()).toBe(204)
  expect((await groupRules()).filter((r) => r.subjectType === 'group' && r.subjectId === group.id)).toEqual([])
  await page.reload()
  await expect(folderRow(page, 'shared')).toBeVisible()
  await expect(folderRow(page, 'groups/영업팀')).toHaveCount(0)
  expect(realErrors(errors).filter((e) => !/status of 400/.test(e))).toEqual([])
})
