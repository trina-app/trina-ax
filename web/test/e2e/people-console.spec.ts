// Admin › People laid out like the Claude Console's Members: the title with a count, one line, Invite on the right, a
// search box and a Role filter, then a quiet table where the owner changes a role in the row and everything else is in
// the row's "…". Groups and Folder permissions use the same header. Phone width, both themes and the keyboard too.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { DICTS, translate } from '../../src/i18n'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const t = DICTS.ko
const PHONE = { width: 390, height: 844 }

const post = async (page: Page, url: string, data: unknown) => {
  const r = await page.request.post(url, { headers: { [CSRF_HEADER]: '1' }, data })
  expect(r.status(), url).toBe(201)
  return r.json()
}
/** two more people (made up): an admin with an email, and a member in a group */
async function seed(page: Page) {
  const g = await post(page, '/api/admin/groups', { name: '디자인팀', description: '화면과 브랜드', memberIds: [] })
  await post(page, '/api/admin/users', { name: 'Carol Kim', username: 'carol', email: 'carol@example.com', role: 'admin', groupIds: [], temporaryPassword: 'maple2026' })
  await post(page, '/api/admin/users', { name: 'Dana Lee', username: 'dana', email: null, role: 'member', groupIds: [g.id], temporaryPassword: 'river2468' })
}
async function audit(page: Page, where: string) {
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => {}))))
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}
const rowOf = (page: Page, name: string) => page.getByTestId('members-table').getByRole('row').filter({ hasText: name })

test('Members: title with the count, one line, Invite; search and the Role filter narrow the table', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await seed(page)
  await page.goto('/admin/members')
  const header = page.getByTestId('members-header')
  await expect(header.getByRole('heading', { level: 2 })).toHaveText(`${t['members.title']}4`)
  await expect(page.getByTestId('members-count')).toHaveText('4')
  await expect(header).toContainText(t['members.pageDesc'])
  await expect(page.getByTestId('invite-new')).toHaveText(t['members.inviteToTeam'])
  // the columns, like the Console: name · username · role · skills · (last seen) · "…"
  const cols = page.getByTestId('members-table').getByRole('columnheader')
  await expect(cols.first()).toHaveText(t['auth.name'])
  await expect(cols.nth(1)).toHaveText(t['auth.username'])
  await expect(cols.nth(2)).toHaveText(t['members.role'])
  // the email under the username; the group under the name
  await expect(rowOf(page, 'Carol Kim')).toContainText('carol@example.com')
  await expect(rowOf(page, 'Dana Lee')).toContainText('디자인팀')
  const rows = page.getByTestId('members-table').locator('tbody tr')
  await expect(rows).toHaveCount(4)

  // search: name, username or email, any letter case
  const search = page.getByTestId('member-search')
  await search.fill('EXAMPLE.com')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('Carol Kim')
  await search.fill('dan')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('Dana Lee')
  await search.fill('nobody-like-this')
  await expect(page.getByTestId('members-no-match')).toHaveText(t['members.noMatch'])
  // Escape empties the box
  await search.press('Escape')
  await expect(search).toHaveValue('')
  await expect(rows).toHaveCount(4)

  // the Role filter: a pill "역할 전체 ⌄"
  const role = page.getByTestId('member-role-filter')
  await expect(page.getByTestId('member-role-filter-pill')).toContainText(t['members.role'])
  await role.selectOption('admin')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('Carol Kim')
  await role.selectOption('owner')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('Olga')
  await role.selectOption('all')
  await expect(rows).toHaveCount(4)

  // no inline invite form: no link yet, so no Invite links section either
  await expect(page.getByTestId('team-link-card')).toHaveCount(0)
  await expect(page.getByTestId('invite-links')).toHaveCount(0)
  await page.getByTestId('invite-new').click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  expect(realErrors(errors)).toEqual([])
})

test('Members: "Team invite link" opens a popup; make, copy, and the page lists it quietly', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/admin/members')
  const opener = page.getByTestId('team-link-open')
  await expect(opener).toHaveText(t['teamLink.title'])
  await opener.click()
  const dialog = page.getByRole('dialog', { name: t['teamLink.title'] })
  await expect(dialog).toBeVisible()
  // the same form as before, in the popup: groups, how many, how long, a skill, the member note, Make invite link
  await expect(dialog.getByTestId('team-link-form')).toBeVisible()
  await expect(dialog.getByTestId('team-link-uses-input')).toHaveAttribute('placeholder', '20')
  await dialog.getByTestId('team-link-create').click()
  // after making it, the popup shows the link with Copy
  const url = (await dialog.getByTestId('team-link-url').innerText()).trim()
  expect(url).toMatch(/\/join#t=tl[0-9a-f]+$/)
  await dialog.getByRole('button', { name: t['teamLink.copyLink'] }).first().click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url)
  // Done closes it, focus goes back to the button
  await page.getByTestId('team-link-done').click()
  await expect(dialog).toHaveCount(0)
  await expect(opener).toBeFocused()
  // the page lists it in a quiet row: uses, Copy, and "…" (settings or turn off)
  const row = page.getByTestId('team-link-row')
  await expect(row).toContainText(translate('ko', 'teamLink.uses', { used: 0, max: 20 }))
  await row.getByRole('button', { name: t['teamLink.copyLink'] }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url)
  // Esc closes the popup too
  await row.getByTestId('member-more').click()
  await page.getByRole('menu').getByTestId('team-link-row-open').click()
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  // "…" › Turn link off asks first, then the row (and the empty section) go away
  await row.getByTestId('member-more').click()
  await page.getByRole('menu').getByTestId('team-link-row-revoke').click()
  await page.getByTestId('dialog-confirm').click()
  await expect(page.getByTestId('team-link-row')).toHaveCount(0)
  await expect(page.getByTestId('invite-links')).toHaveCount(0)
  expect(realErrors(errors)).toEqual([])
})

test('Members: the owner changes a role in the row; others read it; the rest is in "…"', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await seed(page)
  await page.goto('/admin/members')
  // yourself (the owner) and the owner: plain text, no select
  await expect(rowOf(page, 'Olga').getByRole('combobox')).toHaveCount(0)
  await expect(page.getByTestId('member-role-olga')).toHaveText(t['role.owner'])
  // Bob: a select named for him; choosing Admin saves at once
  const bobRole = page.getByTestId('member-role-bob')
  await expect(bobRole).toHaveAccessibleName(translate('ko', 'members.roleFor', { name: 'Bob' }))
  await expect(bobRole).toHaveValue('member')
  const saved = page.waitForResponse((r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname === '/api/admin/users/bob')
  await bobRole.selectOption('admin')
  expect((await saved).request().postDataJSON()).toEqual({ role: 'admin' })
  await expect(page.getByRole('status').filter({ hasText: translate('ko', 'members.roleChanged', { name: 'Bob', role: t['role.admin'] }) })).toBeVisible()
  await expect(bobRole).toHaveValue('admin')
  // back to member: the team link hint comes too (as with the edit dialog)
  await bobRole.selectOption('member')
  await expect(page.getByRole('status').filter({ hasText: t['teamLink.adminHint'] })).toBeVisible()
  await expect(bobRole).toHaveValue('member')

  // "…": Folders they see for anyone; the actions only for people you manage
  await rowOf(page, 'Olga').getByTestId('member-more').click()
  await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText([t['accessView.membersLink']])
  await page.keyboard.press('Escape')
  await expect(rowOf(page, 'Olga').getByTestId('member-more')).toBeFocused()
  await rowOf(page, 'Bob').getByTestId('member-more').click()
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem')).toHaveText([t['accessView.membersLink'], t['common.edit'], t['members.reset'], t['members.resetLinkButton'], t['members.disable'], t['common.delete']])
  // arrow keys move through the items
  await expect(menu.getByRole('menuitem').first()).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByTestId('edit-member-bob')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toContainText('Bob')
  await page.keyboard.press('Escape')
  // Folders they see opens the read-only person view on Bob
  await rowOf(page, 'Bob').getByTestId('member-more').click()
  await page.getByRole('menu').getByTestId('member-access-link').click()
  await expect(page).toHaveURL(/\/admin\/folders\?.*view=people.*person=bob/)
  expect(realErrors(errors)).toEqual([])
})

test('Members: an admin reads every role as text (only the owner changes roles)', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const promoted = await page.request.patch('/api/admin/users/bob', { headers: { [CSRF_HEADER]: '1' }, data: { role: 'admin' } })
  expect(promoted.ok()).toBe(true)
  await page.context().clearCookies()
  await signIn(page, { username: 'bob', password: 'bob password 1' })
  await page.goto('/admin/members')
  await expect(page.getByTestId('members-table')).toBeVisible()
  await expect(page.getByTestId('members-table').getByRole('combobox')).toHaveCount(0)
  await expect(page.getByTestId('member-role-bob')).toHaveText(t['role.admin'])
  await expect(page.getByTestId('member-role-olga')).toHaveText(t['role.owner'])
})

test('Groups: title with the count, search, quiet rows; Edit and Delete in "…"', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await seed(page)
  await page.goto('/admin/groups')
  const rows = page.getByTestId('group-list').locator('li')
  await expect(rows).toHaveCount(2) // 재무팀 and 디자인팀
  await expect(page.getByTestId('groups-count')).toHaveText('2')
  await expect(page.getByTestId('groups-header')).toContainText(t['groups.desc'])
  const design = rows.filter({ hasText: '디자인팀' })
  await expect(design).toContainText('화면과 브랜드')
  await expect(design).toContainText(translate('ko', 'groups.memberCount', { n: 1 }))
  await expect(design).toContainText('Dana Lee')
  // search by name or description
  await page.getByTestId('group-search').fill('브랜드')
  await expect(rows).toHaveCount(1)
  await page.getByTestId('group-search').fill('없는 그룹')
  await expect(page.getByTestId('groups-no-match')).toHaveText(t['groups.noMatch'])
  await page.getByTestId('group-search').fill('')
  // "…" › Edit opens the group's dialog
  await design.getByTestId('member-more').click()
  await page.getByRole('menu').getByTestId('group-edit').click()
  await expect(page.getByTestId('group-name')).toHaveValue('디자인팀')
  await page.keyboard.press('Escape')
  expect(realErrors(errors)).toEqual([])
})

test('Folder permissions: the same header, with the by folder / by person switch under the line', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/admin/folders')
  const header = page.getByTestId('folders-header')
  await expect(header).toContainText(t['folders.pageDesc'])
  await header.getByRole('tab', { name: t['accessView.byPerson'] }).click()
  await expect(page).toHaveURL(/view=people/)
})

test('People pages at phone width: stacked rows, nothing sticks out', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await seed(page)
  await page.setViewportSize(PHONE)
  await page.goto('/admin/members')
  await expect(page.getByTestId('members-list')).toBeVisible()
  await expect(page.getByTestId('members-table')).toHaveCount(0)
  await expect(page.getByTestId('member-card-carol')).toContainText('carol@example.com')
  await expect(page.getByTestId('member-card-bob').getByTestId('member-role-bob')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width)
  await page.goto('/admin/groups')
  await expect(page.getByTestId('group-list')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width)
  expect(realErrors(errors)).toEqual([])
})

for (const scheme of ['light', 'dark'] as const) {
  test(`People pages: no serious accessibility problems (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await reset(page)
    await signIn(page)
    await seed(page)
    await page.goto('/admin/members')
    await expect(page.getByTestId('members-table')).toBeVisible()
    await audit(page, 'members')
    await rowOf(page, 'Bob').getByTestId('member-more').click()
    await audit(page, 'members (menu open)')
    await page.keyboard.press('Escape')
    await page.getByTestId('team-link-open').click()
    await expect(page.getByRole('dialog').getByTestId('team-link-form')).toBeVisible()
    await audit(page, 'team invite link popup')
    await page.keyboard.press('Escape')
    await page.goto('/admin/groups')
    await expect(page.getByTestId('group-list')).toBeVisible()
    await audit(page, 'groups')
    await page.goto('/admin/folders')
    await expect(page.getByTestId('folders-header')).toBeVisible()
    await audit(page, 'folders')
    await page.setViewportSize(PHONE)
    await page.goto('/admin/members')
    await expect(page.getByTestId('members-list')).toBeVisible()
    await audit(page, 'members (phone)')
  })
}
