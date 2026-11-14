// Admin › Folder permissions › What <person> can open (docs/DECISIONS.md "드라이브처럼 공유 P1.5"), read only: each
// folder with Viewer / Editor and why (Everyone at <team>, In <group>, Added by name), then Can't open (group folders of
// other groups as one count line); the owner and admins one line. The person is in the address
// (`?view=people&person=<id>`), so Members' link and Back work; on a phone the person is a page of their own. The invite
// dialog's "Folders this person will see" is the same answer for someone about to be invited. The answers are the
// server's (the mock runs server/src/policy/access.ts and server/src/admin/access-rows.ts).
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { TOP_FOLDER_LABELS } from '@mycel/shared'
import { DICTS, translate } from '../../src/i18n'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const t = DICTS.en
const en = (k: keyof typeof DICTS.en, p?: Record<string, string | number>) => translate('en', k, p)
const H = { [CSRF_HEADER]: '1' }
const call = async (page: Page, method: 'post' | 'patch', url: string, data: unknown) => {
  const r = await page.request[method](url, { headers: H, data })
  expect(r.ok(), `${method} ${url}: ${r.status()}`).toBeTruthy()
  return r.json().catch(() => null)
}
const everyone = (access: 'read' | 'write') => ({ subjectType: 'everyone', subjectId: null, access })
/** a folder's rules replaced, as the Share dialog saves them */
const putRules = async (page: Page, path: string, rules: unknown[], limited?: boolean) => {
  const items = ((await (await page.request.get('/api/admin/folders')).json()) as { items: { id: string; path: string }[] }).items
  const r = await page.request.put(`/api/admin/folders/${items.find((f) => f.path === path)!.id}/rules`, { headers: H, data: { rules, ...(limited !== undefined ? { limited } : {}) } })
  expect(r.ok(), `put ${path}: ${r.status()}`).toBeTruthy()
}

/**
 * Bob (member, Sales): shared (everyone at Acme can edit), groups/Sales (his group's own folder), marketing (limited:
 * Sales can view), secret (Bob added by name, Editor); finance (재무팀) and docs he cannot open. Carol: a member in no
 * group. Ops: a group nobody is in. Dan: switched off, in Sales.
 */
async function team(page: Page) {
  const sales = (await call(page, 'post', '/api/admin/groups', { name: 'Sales', memberIds: ['bob'] })) as { id: string }
  await call(page, 'patch', '/api/admin/users/bob', { groupIds: [sales.id] })
  await call(page, 'post', '/api/admin/groups', { name: 'Ops', memberIds: [] })
  await call(page, 'post', '/api/admin/users', { username: 'carol', name: 'Carol', role: 'member', groupIds: [], temporaryPassword: 'tiger4271x' })
  await call(page, 'post', '/api/admin/users', { username: 'dan', name: 'Dan', role: 'member', groupIds: [sales.id], temporaryPassword: 'tiger4271x' })
  await call(page, 'patch', '/api/admin/users/dan', { status: 'disabled' })
  await call(page, 'post', '/api/admin/folders', { path: 'shared', create: true, rules: [everyone('write')] })
  await call(page, 'post', '/api/admin/folders', { path: 'marketing', create: false, rules: [{ subjectType: 'group', subjectId: sales.id, access: 'read' }], limited: true })
  await call(page, 'post', '/api/admin/folders', { path: 'secret', create: false, rules: [{ subjectType: 'user', subjectId: 'bob', access: 'write' }] })
  return sales
}

const answer = (page: Page) => page.getByTestId('access-answer')
const row = (page: Page, path: string) => answer(page).locator(`[data-testid="access-row"][data-path="${path}"]`)
const option = (page: Page, person: string) => page.getByTestId('access-person-option').and(page.locator(`[data-person="${person}"]`))
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.scrollingElement!.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)

test.beforeEach(async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true, withAdmin: true })
})

test('a member: each folder they can open with the role and why, then what they cannot open; links and Back', async ({ page }) => {
  const errors = watchConsole(page)
  await signIn(page)
  await team(page)
  await page.goto('/admin/folders')
  await page.getByRole('tab', { name: t['folders.tabPerson'], exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/folders\?view=people$/)
  await expect(answer(page)).toContainText(t['folders.pickPerson'])
  // the people: active first by name, the one switched off last and said so
  expect(await page.getByTestId('access-person-option').evaluateAll((els) => els.map((e) => e.getAttribute('data-person')))).toEqual(['bob', 'carol', 'dana', 'eve', 'olga', 'dan'])
  await expect(option(page, 'dan')).toContainText(t['folderAccess.switchedOff'])

  await option(page, 'bob').click()
  await expect(page).toHaveURL(/\/admin\/folders\?view=people&person=bob$/)
  await expect(option(page, 'bob')).toHaveAttribute('aria-current', 'true')
  await expect(page.getByTestId('access-person-title')).toHaveText(en('folders.whatCanOpen', { name: 'Bob' }))
  await expect(page.getByTestId('access-person')).toContainText(`${t['role.member']} · Sales · ${t['folders.aiSame']}`)
  // what he can open, in Files' order and names, each with Viewer / Editor and why
  const open = page.getByTestId('access-open').getByTestId('access-row')
  await expect.poll(() => open.evaluateAll((els) => els.map((e) => `${e.getAttribute('data-path')}:${e.getAttribute('data-access')}`))).toEqual(['shared:write', 'groups/Sales:write', 'marketing:read', 'secret:write'])
  await expect(row(page, 'shared').getByTestId('folder-crumbs')).toHaveText(TOP_FOLDER_LABELS.shared.en)
  await expect(row(page, 'shared').getByTestId('access-row-why')).toHaveText(en('folders.everyoneAt', { team: 'Acme' }))
  await expect(row(page, 'shared')).toContainText(t['folderAccess.canEdit'])
  await expect(row(page, 'groups/Sales').getByTestId('access-row-why')).toHaveText(en('folders.reasonGroup', { group: 'Sales' }))
  await expect(row(page, 'marketing').getByTestId('access-row-why')).toHaveText(en('folders.reasonGroup', { group: 'Sales' }))
  await expect(row(page, 'marketing')).toContainText(t['folderAccess.canView'])
  await expect(row(page, 'secret').getByTestId('access-row-why')).toHaveText(t['folders.reasonPerson'])
  // what he cannot open: finance (only 재무팀) and docs, never named for a reason he has; Ops' folder as a count line
  for (const p of ['finance', 'docs']) {
    await expect(page.getByTestId('access-closed').locator(`[data-testid="access-row"][data-path="${p}"]`)).toHaveAttribute('data-access', 'none')
    await expect(row(page, p).getByTestId('access-row-why')).toHaveText(t['folders.cantNotAdded'])
  }
  await expect(row(page, 'groups/Ops')).toHaveCount(0)
  await expect(page.getByTestId('access-closed-groups')).toHaveText(en('folders.cantGroups', { n: 1 }))
  // no personal folder and no rule words
  for (const w of ['users/', 'Personal', 'No access', 'Rule']) await expect(answer(page)).not.toContainText(w)

  // Carol (no group): only what everyone opens; marketing is limited and she was not added; both group folders counted
  await option(page, 'carol').click()
  await expect(page).toHaveURL(/person=carol$/)
  await expect(page.getByTestId('access-person-title')).toHaveText(en('folders.whatCanOpen', { name: 'Carol' }))
  await expect.poll(() => page.getByTestId('access-open').getByTestId('access-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-path')))).toEqual(['shared'])
  await expect(row(page, 'marketing')).toHaveAttribute('data-access', 'none')
  await expect(row(page, 'marketing').getByTestId('access-row-why')).toHaveText(t['folders.cantLimited'])
  await expect(row(page, 'secret').getByTestId('access-row-why')).toHaveText(t['folders.cantNotAdded'])
  await expect(page.getByTestId('access-closed-groups')).toHaveText(en('folders.cantGroups', { n: 2 }))

  // Back goes to the person before; the address opens a person directly
  await page.goBack()
  await expect(page.getByTestId('access-person-title')).toHaveText(en('folders.whatCanOpen', { name: 'Bob' }))
  await page.goto('/admin/folders?view=people&person=carol')
  await expect(page.getByTestId('access-person-title')).toHaveText(en('folders.whatCanOpen', { name: 'Carol' }))
  expect(realErrors(errors)).toEqual([])
})

test('a change in the Share dialog shows in what a person can open', async ({ page }) => {
  await signIn(page)
  await team(page)
  // Carol is added to marketing by name, as the Share dialog saves it
  await putRules(page, 'marketing', [{ subjectType: 'user', subjectId: 'carol', access: 'write' }], true)
  await page.goto('/admin/folders?view=people&person=carol')
  await expect(row(page, 'marketing')).toHaveAttribute('data-access', 'write')
  await expect(row(page, 'marketing').getByTestId('access-row-why')).toHaveText(t['folders.reasonPerson'])
  // and Bob, whose group is no longer on it, cannot open it now
  await page.goto('/admin/folders?view=people&person=bob')
  await expect(row(page, 'marketing')).toHaveAttribute('data-access', 'none')
  await expect(row(page, 'marketing').getByTestId('access-row-why')).toHaveText(t['folders.cantLimited'])
})

test('the owner and admins: one line, no list; a person switched off; someone unknown; search', async ({ page }) => {
  await signIn(page)
  await team(page)
  await page.goto('/admin/folders?view=people&person=olga')
  await expect(page.getByTestId('access-person-title')).toHaveText(en('folders.whatCanOpen', { name: 'Olga' }))
  await expect(page.getByTestId('access-staff-line')).toHaveText(en('folders.staffLine', { role: t['role.owner'] }))
  await expect(page.getByTestId('access-row')).toHaveCount(0)
  await option(page, 'dana').click()
  await expect(page.getByTestId('access-staff-line')).toHaveText(en('folders.staffLine', { role: t['role.admin'] }))
  // switched off: what they would open, said as switched off
  await option(page, 'dan').click()
  await expect(page.getByTestId('access-person')).toContainText(t['folderAccess.switchedOff'])
  await expect(row(page, 'groups/Sales')).toHaveAttribute('data-access', 'write')
  // nobody by that id: said, with the list to choose from
  await page.goto('/admin/folders?view=people&person=nobody')
  await expect(answer(page)).toContainText(t['accessView.unknownPerson'])
  // search: by name and by group
  await page.getByTestId('access-person-search').fill('car')
  await expect(page.getByTestId('access-person-option')).toHaveCount(1)
  await expect(option(page, 'carol')).toBeVisible()
  await page.getByTestId('access-person-search').fill('sales')
  expect(await page.getByTestId('access-person-option').evaluateAll((els) => els.map((e) => e.getAttribute('data-person')))).toEqual(['bob', 'dan'])
  await page.getByTestId('access-person-search').fill('nobody here')
  await expect(page.getByText(t['accessView.noMatch'], { exact: true })).toBeVisible()
  // the tab and its search box are kept apart from the Folders tab's
  await page.getByRole('tab', { name: t['folders.tabFolders'], exact: true }).click()
  await expect(page.getByTestId('folders-search')).toHaveValue('')
})

test('Members: "Folders they see" opens the person; the invite previews what someone new will open', async ({ page }) => {
  const errors = watchConsole(page)
  await signIn(page)
  await team(page)
  await page.goto('/admin/members')
  await page.getByTestId('members-table').getByRole('row').filter({ hasText: 'Bob' }).getByTestId('member-more').click()
  await page.getByRole('menuitem', { name: t['accessView.membersLink'], exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/folders\?view=people&person=bob$/)
  await expect(page.getByTestId('access-person-title')).toHaveText(en('folders.whatCanOpen', { name: 'Bob' }))

  await page.goto('/admin/members')
  await page.getByTestId('invite-new').click()
  const dialog = page.getByRole('dialog', { name: t['members.invite'] })
  const toggle = dialog.getByTestId('new-person-preview-toggle')
  await expect(toggle).toHaveText(t['accessView.preview'])
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(dialog.getByTestId('new-person-preview')).toHaveCount(0)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  const preview = dialog.getByTestId('new-person-preview')
  const openPaths = () => preview.getByTestId('access-open').getByTestId('access-row').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-path')}:${e.getAttribute('data-access')}`))
  // in no group: what everyone at Acme opens, and no title or face (nobody yet)
  await expect.poll(openPaths).toEqual(['shared:write'])
  await expect(preview.getByTestId('access-person-title')).toHaveCount(0)
  await expect(preview.locator('[data-testid="access-row"][data-path="marketing"]')).toHaveAttribute('data-access', 'none')
  // with Sales: Sales' own folder and marketing, by the group
  await dialog.getByRole('checkbox', { name: 'Sales' }).check()
  await expect.poll(openPaths).toEqual(['shared:write', 'groups/Sales:write', 'marketing:read'])
  await expect(preview.locator('[data-testid="access-row"][data-path="marketing"]').getByTestId('access-row-why')).toHaveText(en('folders.reasonGroup', { group: 'Sales' }))
  // never a folder someone is added to by name
  await expect(preview.locator('[data-testid="access-row"][data-path="secret"]')).toHaveAttribute('data-access', 'none')
  // unchecked again: the same answer as before
  await dialog.getByRole('checkbox', { name: 'Sales' }).uncheck()
  await expect.poll(openPaths).toEqual(['shared:write'])
  // folded again
  await toggle.click()
  await expect(preview).toHaveCount(0)
  expect(realErrors(errors)).toEqual([])
})

test('the invite preview for an admin: every team folder', async ({ page }) => {
  await signIn(page)
  await team(page)
  await page.goto('/admin/members')
  await page.getByTestId('invite-new').click()
  const dialog = page.getByRole('dialog', { name: t['members.invite'] })
  await dialog.getByRole('combobox', { name: t['members.role'], exact: true }).selectOption('admin')
  await dialog.getByTestId('new-person-preview-toggle').click()
  const preview = dialog.getByTestId('new-person-preview')
  for (const p of ['shared', 'marketing', 'secret', 'finance']) await expect(preview.locator(`[data-testid="access-row"][data-path="${p}"]`)).not.toHaveAttribute('data-access', 'none')
  await expect(preview.getByTestId('access-closed')).toHaveCount(0)
})

for (const locale of ['ko', 'es'] as const) {
  test(`375px wide: the list, then the person's answer as a page of its own; nothing wider than the screen (${locale})`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await reset(page, { teamLocale: locale, usersFollowTeam: true })
    await signIn(page)
    await team(page)
    await page.goto('/admin/folders?view=people')
    // (the two tabs fold into one button when their words do not fit: Spanish at 375px)
    await expect(page.getByTestId('access-person-search')).toHaveAttribute('placeholder', DICTS[locale]['folders.findPerson'])
    await option(page, 'bob').click()
    await expect(page).toHaveURL(/person=bob/)
    await expect(row(page, 'marketing')).toBeVisible()
    // a phone: the person is a page over the list, not under it
    await expect(page.getByTestId('access-person-list')).toBeHidden()
    await noOverflow(page)
    for (const r of await page.getByTestId('access-row').all()) {
      const b = (await r.boundingBox())!
      expect(b.x + b.width).toBeLessThanOrEqual(375)
    }
    await page.goBack()
    await expect(page.getByTestId('access-person-list')).toBeVisible()
    await expect(page.getByTestId('access-person')).toHaveCount(0)
  })
}
