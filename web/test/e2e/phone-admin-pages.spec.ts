// Admin on a phone (390×844, touch), the level below each page (QA TC-267 to TC-270; pages/admin/adminScreens.ts):
// - TC-267: a connector, a plugin, a folder, its rule editor, a person in By person and an engine are pages with their
//   own address, pushed over the page they come from: ‹ and the browser's (the iPhone's swipe) Back go one level up, and
//   the bar names the page; no second "← back" link under the bar.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'en-US' })

const t = DICTS.en
const historyLength = (page: Page) => page.evaluate(() => history.length)
const bar = (page: Page) => page.getByTestId('admin-bar-title')
const backLabel = (page: Page) => page.getByTestId('admin-back-label')

/** Admin's list from the 나 tab, then one of its rows */
async function openAdminPage(page: Page, id: string, url: RegExp) {
  await page.getByTestId('tab-me').click()
  await page.getByTestId('settings-admin').click()
  await expect(page.getByTestId('admin-phone-root')).toBeVisible()
  await page.getByTestId(`admin-row-${id}`).click()
  await expect(page).toHaveURL(url)
}

test.beforeEach(async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
})

test('Connectors: a connector is a page of its own; ‹ and Back return to Connectors, then to Admin', async ({ page }) => {
  await openAdminPage(page, 'connectors', /\/admin\/connectors$/)
  const length = await historyLength(page)
  await page.locator('[data-testid="connector-card"][data-id="gmail"]').getByTestId('connector-open').click()
  await expect(page).toHaveURL(/\/admin\/connectors\/gmail$/)
  expect(await historyLength(page)).toBe(length + 1)
  await expect(page.getByTestId('gapp-admin-detail')).toBeVisible()
  await expect(bar(page)).toHaveText('Gmail')
  await expect(backLabel(page)).toHaveText(t['admin.integrations'])
  // the bar's ‹ is the way back: the card's own "← Connected apps" is not shown
  await expect(page.getByTestId('connector-back')).toBeHidden()
  await page.getByTestId('admin-back').click()
  await expect(page).toHaveURL(/\/admin\/connectors$/)
  await expect(page.getByTestId('connector-discover')).toBeVisible()
  // a listed service: the same, and the browser's Back (the iPhone's swipe)
  await page.locator('[data-testid="connector-card"][data-id="notion"]').getByTestId('connector-open').click()
  await expect(page).toHaveURL(/\/admin\/connectors\/notion$/)
  await expect(bar(page)).toHaveText('Notion')
  await page.goBack()
  await expect(page).toHaveURL(/\/admin\/connectors$/)
  await page.goBack()
  await expect(page).toHaveURL(/\/admin$/)
})

test('Connectors: a connector\'s address opened from outside has Connectors and Admin under it', async ({ page }) => {
  await page.goto('/admin/connectors/google-drive')
  await expect(page.getByTestId('drive-admin-detail')).toBeVisible()
  await expect(bar(page)).toHaveText('Google Drive')
  await page.goBack()
  await expect(page).toHaveURL(/\/admin\/connectors$/)
  await page.goBack()
  await expect(page).toHaveURL(/\/admin$/)
  // an address of a connector there is not: the list
  await page.goto('/admin/connectors/nothing-like-it')
  await expect(page).toHaveURL(/\/admin\/connectors$/)
})

test('Plugins: a plugin is a page of its own under "‹ Plugins"', async ({ page }) => {
  await openAdminPage(page, 'plugins', /\/admin\/plugins$/)
  const card = page.getByTestId('plugin-catalog').first()
  const name = (await card.getByTestId('plugin-open').locator('.truncate').first().textContent())!.trim()
  await card.getByTestId('plugin-open').click()
  await expect(page).toHaveURL(/\/admin\/plugins\/[^/]+$/)
  await expect(page.getByTestId('plugin-detail')).toBeVisible()
  await expect(bar(page)).toHaveText(name)
  await expect(backLabel(page)).toHaveText(t['admin.plugins'])
  await expect(page.getByTestId('plugin-back')).toBeHidden()
  await page.goBack()
  await expect(page).toHaveURL(/\/admin\/plugins$/)
  await expect(page.getByTestId('plugins-catalog')).toBeVisible()
})

test('Folder permissions: a folder and its rule editor are entries of their own; Back goes editor → folder → tree', async ({ page }) => {
  await openAdminPage(page, 'folders', /\/admin\/folders$/)
  const tree = page.getByTestId('folder-tree')
  const length = await historyLength(page)
  await tree.locator('[role="treeitem"][data-path="marketing"]').click()
  await expect(page).toHaveURL(/folder=marketing/)
  expect(await historyLength(page)).toBe(length + 1)
  await expect(page.getByTestId('folder-detail')).toBeVisible()
  await expect(bar(page)).toHaveText('marketing')
  await expect(backLabel(page)).toHaveText(t['admin.folders'])
  // no second way back under the bar, no page header (its line, Add folder, the two views) on the folder's page
  await expect(page.getByTestId('folder-detail-back')).toBeHidden()
  await expect(page.getByTestId('folder-rule-new')).toHaveCount(0)
  // the rule editor: pushed too, under the same bar (no full-screen panel with its own ←)
  await page.getByTestId('folder-detail-edit').click()
  await expect(page).toHaveURL(/rules=marketing/)
  expect(await historyLength(page)).toBe(length + 2)
  const panel = page.getByTestId('edit-panel')
  await expect(panel).toBeVisible()
  await expect(panel).not.toHaveAttribute('role', 'dialog')
  await expect(page.getByTestId('edit-back')).toHaveCount(0)
  // marketing has no rules yet: "Set rules" (a folder with rules: "Change rules")
  await expect(bar(page)).toHaveText(t['accessTree.addRules'])
  await expect(page.getByTestId('phone-page-bar')).toBeVisible()
  // the swipe (Back): the editor goes, the folder is there; once more: the tree
  await page.goBack()
  await expect(page).not.toHaveURL(/rules=/)
  await expect(panel).toHaveCount(0)
  await expect(page.getByTestId('folder-detail')).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(/\/admin\/folders$/)
  await expect(tree).toBeVisible()
  // Cancel in the editor goes back to the folder too (its entry goes, nothing is left over it)
  await tree.locator('[role="treeitem"][data-path="marketing"]').click()
  await page.getByTestId('folder-detail-edit').click()
  await expect(panel).toBeVisible()
  await page.getByTestId('edit-cancel').click()
  await expect(panel).toHaveCount(0)
  await expect(page).not.toHaveURL(/rules=/)
  expect(await historyLength(page)).toBe(length + 2)
  await page.getByTestId('admin-back').click()
  await expect(page).toHaveURL(/\/admin\/folders$/)
})

test('Folder permissions: ‹ from an editor with changes asks first', async ({ page }) => {
  await page.goto('/admin/folders?folder=marketing')
  await expect(page.getByTestId('folder-detail')).toBeVisible()
  await page.getByTestId('folder-detail-edit').click()
  const panel = page.getByTestId('edit-panel')
  await expect(panel).toBeVisible()
  await panel.locator('[data-testid^="edit-basic-"]').filter({ hasNot: page.locator('input:checked') }).first().click()
  await expect(page.getByTestId('edit-save')).toBeEnabled()
  await page.getByTestId('admin-back').click()
  const ask = page.getByRole('dialog', { name: t['accessEdit.discardTitle'] })
  await expect(ask).toBeVisible()
  await ask.getByRole('button', { name: t['common.cancel'] }).click()
  await expect(panel).toBeVisible()
  await page.getByTestId('admin-back').click()
  await ask.getByRole('button', { name: t['accessEdit.discard'] }).click()
  await expect(panel).toHaveCount(0)
  await expect(page.getByTestId('folder-detail')).toBeVisible()
})

test('Folder permissions › By person: the list alone, a person a page of their own', async ({ page }) => {
  await page.goto('/admin/folders?view=people')
  const option = page.locator('[data-testid="access-person-option"][data-person="bob"]')
  await expect(option).toBeVisible()
  await expect(page.getByTestId('access-answer')).toBeHidden()
  await option.click()
  await expect(page).toHaveURL(/person=bob/)
  await expect(page.getByTestId('access-person')).toBeVisible()
  await expect(option).toBeHidden()
  await expect(bar(page)).toHaveText('Bob')
  await page.goBack()
  await expect(option).toBeVisible()
})

test('Providers: an engine is a row that opens its own page; a server command is left to a computer', async ({ page }) => {
  await openAdminPage(page, 'providers', /\/admin\/providers$/)
  const row = page.locator('[data-testid="engine-row"][data-engine="codex"]')
  await expect(row).toBeVisible()
  expect(Math.round((await row.boundingBox())!.height)).toBeGreaterThanOrEqual(48)
  // no accordion on a phone
  await expect(page.getByTestId('engine-open')).toHaveCount(0)
  await row.click()
  await expect(page).toHaveURL(/\/admin\/providers\/codex$/)
  await expect(page.getByTestId('engine-page')).toBeVisible()
  await expect(bar(page)).toHaveText('Codex')
  await expect(backLabel(page)).toHaveText(t['admin.providers'])
  await expect(page.getByTestId('engine-switch-codex')).toBeVisible()
  // "Run `codex login --device-auth` on the server Mac" is a computer's job
  await expect(page.getByTestId('engine-on-computer')).toHaveText(t['admin.onComputer'])
  await page.goBack()
  await expect(page).toHaveURL(/\/admin\/providers$/)
  // the old ?engine= address opens the engine's page on a phone
  await page.goto('/admin/providers?engine=claude-code')
  await expect(page).toHaveURL(/\/admin\/providers\/claude-code$/)
  await expect(bar(page)).toHaveText('Claude Code')
})

// - TC-268: a person's and a group's row opens their page; row ⋯ and a page button's ⌄ are bottom sheets (48 px rows,
//   delete last); a member never reaches them.
const H = { [CSRF_HEADER]: '1' }

test('Members: a row opens the person\'s page (role, groups, folders, actions with delete last); Back to the list', async ({ page }) => {
  await openAdminPage(page, 'members', /\/admin\/members$/)
  await page.getByTestId('member-card-bob').getByTestId('row-open').click()
  await expect(page).toHaveURL(/\/admin\/members\/bob$/)
  const person = page.getByTestId('member-page')
  await expect(person).toBeVisible()
  await expect(bar(page)).toHaveText('Bob')
  await expect(backLabel(page)).toHaveText(t['admin.members'])
  await expect(page.getByTestId('members-list')).toBeHidden()
  await expect(person.getByTestId('member-page-role')).toContainText(t['members.role'])
  await expect(person.getByTestId('member-page-folders')).toHaveAttribute('href', /view=people&person=bob/)
  const actions = person.getByTestId('member-page-actions').getByRole('button')
  await expect(actions.last()).toHaveAttribute('data-testid', 'delete-member-bob')
  for (const b of await actions.all()) expect(Math.round((await b.boundingBox())!.height)).toBeGreaterThanOrEqual(44)
  await page.goBack()
  await expect(page).toHaveURL(/\/admin\/members$/)
  await expect(page.getByTestId('members-list')).toBeVisible()
})

test('Members: ⋯ and Invite ⌄ are bottom sheets with 48 px rows, delete last', async ({ page }) => {
  await openAdminPage(page, 'members', /\/admin\/members$/)
  await page.getByTestId('member-card-bob').getByTestId('member-more').click()
  const sheet = page.getByRole('menu')
  await expect(sheet).toBeVisible()
  // the sheet sits on the bottom of the screen, as wide as it
  const box = (await sheet.boundingBox())!
  expect(Math.round(box.x)).toBe(0)
  expect(Math.round(box.y + box.height)).toBeGreaterThan(800)
  await expect(page.getByTestId('menu-sheet-title')).toHaveText('Bob')
  const items = sheet.getByRole('menuitem')
  for (const it of await items.all()) expect(Math.round((await it.boundingBox())!.height)).toBeGreaterThanOrEqual(44)
  await expect(items.last()).toHaveAttribute('data-testid', 'delete-member-bob')
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  // the page's ⌄: the other ways to invite
  await page.getByTestId('invite-new-more').click()
  await expect(sheet).toBeVisible()
  expect(Math.round((await sheet.boundingBox())!.x)).toBe(0)
  await expect(sheet.getByTestId('member-add')).toBeVisible()
  expect(Math.round((await sheet.getByTestId('member-add').boundingBox())!.height)).toBeGreaterThanOrEqual(44)
  await sheet.getByTestId('member-add').click()
  await expect(page.getByRole('dialog')).toBeVisible()
})

test('Groups: a row opens the group\'s page with its members, Edit and Delete', async ({ page }) => {
  expect((await page.request.post('/api/admin/groups', { headers: H, data: { name: 'Sales', description: 'The sales team', memberIds: ['bob'] } })).ok()).toBeTruthy()
  await openAdminPage(page, 'groups', /\/admin\/groups$/)
  await page.getByTestId('group-row').filter({ hasText: 'Sales' }).getByTestId('row-open').click()
  await expect(page).toHaveURL(/\/admin\/groups\/[^/]+$/)
  const group = page.getByTestId('group-page')
  await expect(group).toContainText('The sales team')
  await expect(group.getByTestId('group-page-members')).toContainText('Bob')
  await expect(bar(page)).toHaveText('Sales')
  await group.getByTestId('group-edit').click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByTestId('admin-back').click()
  await expect(page).toHaveURL(/\/admin\/groups$/)
})

test('an admin gets the same pages; a member opening one lands at home', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true, withAdmin: true })
  await signIn(page, { username: 'dana', password: 'dana password 1' })
  await page.goto('/admin/members/bob')
  await expect(page.getByTestId('member-page')).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(/\/admin\/members$/)
  await page.goto('/admin/connectors/notion')
  await expect(page.getByTestId('connector-detail')).toBeVisible()
  await page.context().clearCookies()
  await signIn(page, { username: 'bob', password: 'bob password 1' })
  await page.goto('/admin/members/olga')
  await expect(page).not.toHaveURL(/\/admin/)
})
