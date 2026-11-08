// Admin screens: a delete that the server answers with 204 (no body) refreshes the list at once, a failed one keeps the
// row, and the keyboard focus goes on instead of falling back to the page: to the next row's delete only where a
// confirm dialog comes first, else to the next row's Edit or the list's title, so a held Enter deletes one row. Folder
// permissions (the tree since stage 4): the delete dialog shows the server's "who sees what" for no rules, the focus
// goes to the folder's rules button, and rows the server keeps say why.
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

// Folder permissions › By folder (the tree): since stage 5 a folder's rules change in the edit panel ("follow the folder
// above" is no rules saved there, access-edit.spec.ts), and removing a rule row is for cleaning up only: a row left
// without rules that no project uses. The folder stays in the tree, the delete button goes with the row, and the focus
// goes to the folder's rules button instead of the page. Rows of folders that are not in the tree have their own list
// (access-tree.spec.ts: focus to the next row's delete, then "Add folder").
const tree = (page: Page) => page.getByTestId('folder-tree')
const treeRow = (page: Page, p: string) => tree(page).locator(`[role="treeitem"][data-path="${p}"]`)
const detail = (page: Page) => page.getByTestId('folder-detail')
async function choose(page: Page, p: string) {
  await treeRow(page, p).click()
  await expect(detail(page)).toHaveAttribute('data-path', p)
}

test('folder permissions: an empty rule row goes with the server\'s preview, the tree refreshes, focus moves on', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  // rule rows left without rules (a project's marker after the project went, rules emptied in the panel)
  for (const p of ['docs', 'finance/2026', 'marketing']) await post(page, '/api/admin/folders', { path: p, create: true, rules: [] })
  await page.goto('/admin/folders')
  const row = (p: string) => treeRow(page, p)
  // the chosen folder's "remove the empty rule entry" (it never removes the folder)
  const del = (p: string) => page.locator(`[data-testid="folder-detail"][data-path="${p}"]`).getByRole('button', { name: t['accessTree.removeMarker'], exact: true })
  const rulesButton = page.getByTestId('folder-detail-edit')
  await expect(row('finance')).toBeVisible()
  for (const p of ['docs', 'finance', 'marketing']) await expect(row(p)).toHaveAttribute('data-rules', p === 'finance' ? '1' : '0')

  // a folder with rules offers no delete: its rules change in the edit panel, which says the owner and admins always
  // see it, and closes without asking when nothing changed
  await choose(page, 'finance')
  await expect(page.getByTestId('folder-detail-delete')).toHaveCount(0)
  await rulesButton.click()
  await page.getByTestId('edit-how-toggle').click()
  await expect(page.getByTestId('edit-how')).toContainText(t['accessEdit.basicHint'], { useInnerText: true })
  await page.getByTestId('edit-cancel').click()
  await expect(page.getByTestId('edit-panel')).toHaveCount(0)
  await expect(rulesButton).toBeFocused()
  // an empty row says what it does and what removing it does
  await choose(page, 'docs')
  await expect(page.getByTestId('folder-marker-hint')).toHaveText(t['accessTree.markerHint'])
  await expect(del('docs')).toHaveAccessibleDescription(t['accessTree.markerHint'])

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
  await row('finance').getByTestId('tree-toggle').click()
  await choose(page, 'finance/2026')
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
  // the folder stays in the tree, inherited; the delete button is gone, and the rules button has the focus (not the
  // page)
  await expect(row('finance/2026')).toHaveAttribute('data-rules', '0')
  await expect(detail(page)).toContainText(t['accessTree.noOwnRules'])
  await expect(page.getByTestId('folder-marker-hint')).toHaveCount(0)
  await expect(del('finance/2026')).toHaveCount(0)
  await expect(rulesButton).toBeFocused()
  await expect(rulesButton).toHaveText(t['accessTree.addRules'])

  // a slow answer: the button says it is busy, and after 5 seconds the dialog opens with the general text
  await page.unroute('**/api/admin/folder-rules/preview')
  await page.route('**/api/admin/folder-rules/preview', async (r) => {
    await new Promise((done) => setTimeout(done, 8000))
    await r.fulfill({ json: { folders: [], losing: [] } }).catch(() => {}) // the page gave up on it
  })
  await choose(page, 'docs')
  const asking = Date.now()
  await del('docs').click()
  await expect(del('docs')).toHaveAttribute('aria-busy', 'true')
  await expect(dialog).toContainText(t['rules.removeBody'], { timeout: 7000 })
  expect(Date.now() - asking).toBeGreaterThanOrEqual(4500)
  await dialog.getByRole('button', { name: t['common.cancel'], exact: true }).click()
  await expect(del('docs')).not.toHaveAttribute('aria-busy', 'true')
  await expect(del('docs')).toBeFocused()

  // no preview (the server could not answer): the general text, which does not promise more than the server does
  await page.unroute('**/api/admin/folder-rules/preview')
  await page.route('**/api/admin/folder-rules/preview', (r) => r.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'x' } } }))
  await del('docs').click()
  await expect(dialog).toContainText(t['rules.removeBody'])
  await expect(dialog.getByTestId('rules-remove-preview')).toHaveCount(0)
  await page.getByTestId('dialog-confirm').click()
  await expect(row('docs')).toHaveAttribute('data-rules', '0')
  await expect(rulesButton).toBeFocused()
  await page.unroute('**/api/admin/folder-rules/preview')

  // nothing changes for anyone: it says so
  await page.route('**/api/admin/folder-rules/preview', (r) => r.fulfill({ json: { folders: [{ path: 'marketing', users: [{ user: { id: 'olga', name: 'Olga' }, role: 'owner', before: 'write', after: 'write' }] }], losing: [] } }))
  await choose(page, 'marketing')
  await del('marketing').click()
  await expect(dialog).toContainText(t['rules.removeNoChange'])
  await dialog.getByRole('button', { name: t['common.cancel'], exact: true }).click()
  await expect(del('marketing')).toBeFocused()

  // a refused delete keeps the row and says why
  await page.route('**/api/admin/folders/*', (r) => r.request().method() === 'DELETE' ? r.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'REFUSED-BY-SERVER' } } }) : r.fallback())
  await del('marketing').click()
  await page.getByTestId('dialog-confirm').click()
  await expect(page.getByText('REFUSED-BY-SERVER')).toBeVisible()
  await expect(del('marketing')).toBeVisible()
  await page.unroute('**/api/admin/folders/*')
  await page.unroute('**/api/admin/folder-rules/preview')

  // the last one: the folder stays, and the focus stays on its rules button
  await del('marketing').click()
  await page.getByTestId('dialog-confirm').click()
  await expect(del('marketing')).toHaveCount(0)
  await expect(row('marketing')).toHaveAttribute('data-rules', '0')
  await expect(rulesButton).toBeFocused()
  expect(loads).toBe(0)
  expect(realErrors(errors).filter((e) => !/status of (409|503)/.test(e))).toEqual([])
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

test('folder permissions: shared, skills and a group\'s folder say why they stay; no rule left cannot be saved', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await post(page, '/api/admin/folders', { path: 'shared', create: true, rules: [everyone('write')] })
  await post(page, '/api/admin/folders', { path: 'skills', create: true, rules: [everyone('read'), { subjectType: 'role', subjectId: 'admin', access: 'write' }] })
  const group = await post(page, '/api/admin/groups', { name: '영업팀', memberIds: [] })
  await page.goto('/admin/folders')
  // the chosen folder's delete (an empty rule row only; it never removes the folder)
  const del = (p: string) => page.locator(`[data-testid="folder-detail"][data-path="${p}"]`).getByTestId('folder-detail-delete')
  const panel = page.getByTestId('edit-panel')
  const settled = () => expect(panel.getByTestId('edit-result')).toHaveAttribute('data-ready', 'true')
  const why = () => detail(page).getByTestId('folder-keep-reason')
  for (const p of ['shared', 'skills']) {
    await choose(page, p)
    await expect(del(p)).toHaveCount(0)
    await expect(why()).toHaveText(t['rules.keepTeam'])
  }
  await choose(page, 'groups/영업팀')
  await expect(del('groups/영업팀')).toHaveCount(0)
  await expect(why()).toHaveText(translate('ko', 'rules.keepGroup', { name: '영업팀' }))
  await choose(page, 'finance')
  await expect(why()).toHaveCount(0)
  if (process.env.FOLDER_SHOTS) {
    for (const size of [{ width: 1360, height: 860 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size)
      await page.screenshot({ path: `${process.env.FOLDER_SHOTS}/folders-${size.width}.png`, fullPage: true })
    }
    await page.setViewportSize({ width: 1360, height: 860 })
  }

  // finance follows the folder above: no rules saved there (PUT, the row stays, never a delete), then the empty row can
  // go, and the focus lands on its rules button
  await page.getByTestId('folder-detail-edit').click()
  for (const x of await panel.getByTestId('edit-named-remove').all()) await x.click()
  await panel.getByTestId('edit-basic-follow').click()
  await settled()
  const put = page.waitForRequest((r) => r.method() === 'PUT' && r.url().includes('/rules'))
  await panel.getByTestId('edit-save').click()
  expect((await put).postDataJSON()).toMatchObject({ rules: [] })
  await expect(panel).toHaveCount(0)
  await expect(treeRow(page, 'finance')).toHaveAttribute('data-rules', '0')
  await del('finance').click()
  await page.getByTestId('dialog-confirm').click()
  await expect(del('finance')).toHaveCount(0)
  await expect(page.getByTestId('folder-detail-edit')).toBeFocused()

  // no rule left on shared: said in the panel before saving, and Save waits for a rule
  await choose(page, 'shared')
  await page.getByTestId('folder-detail-edit').click()
  await panel.getByTestId('edit-basic-follow').click()
  await expect(panel.getByTestId('edit-keep-one')).toHaveText(t['accessEdit.keepTeam'])
  await expect(panel.getByTestId('edit-save')).toBeDisabled()
  await expect(panel.getByTestId('edit-save')).toHaveAccessibleDescription(t['accessEdit.keepTeam'])
  // what it says to do instead works: only the people named (everyone: no access)
  await panel.getByTestId('edit-basic-named').click()
  await expect(panel.getByTestId('edit-keep-one')).toHaveCount(0)
  await settled()
  await panel.getByTestId('edit-save').click()
  await expect(panel).toHaveCount(0)
  await expect(detail(page).getByTestId('folder-rules')).toContainText(`${t['rules.everyone']}: ${t['access.none']}`)
  await expect(treeRow(page, 'shared').getByTestId('tree-who')).toHaveText(t['accessTree.who.adminsOnly'])

  // a save the server refuses shows its reason in the panel, which stays open
  await page.route('**/api/admin/folders/*/rules', (r) => r.fulfill({ status: 400, json: { error: { code: 'validation', message: 'REFUSED-BY-SERVER', fields: { 'body.rules': 'x' } } } }))
  await choose(page, 'groups/영업팀')
  await page.getByTestId('folder-detail-edit').click()
  await panel.getByTestId('edit-basic-read').click()
  await settled()
  await panel.getByTestId('edit-save').click()
  await expect(panel.getByTestId('edit-refused').getByRole('alert')).toHaveText('REFUSED-BY-SERVER')
  await expect(panel).toBeVisible()
  await panel.getByTestId('edit-cancel').click()
  await page.getByTestId('dialog-confirm').click()
  await page.unroute('**/api/admin/folders/*/rules')

  // once the group is deleted, its folder is an ordinary one
  const gone = await page.request.delete(`/api/admin/groups/${group.id}`, { headers: { [CSRF_HEADER]: '1' } })
  expect(gone.status()).toBe(204)
  await page.reload()
  await choose(page, 'groups/영업팀')
  await expect(del('groups/영업팀')).toHaveCount(1)
  await expect(why()).toHaveCount(0)
  expect(realErrors(errors).filter((e) => !/status of 400/.test(e))).toEqual([])
})
