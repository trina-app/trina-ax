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
  await expect(backLabel(page)).toHaveText(t['admin.team.integrations'])
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
  await expect(backLabel(page)).toHaveText(t['admin.team.providers'])
  await expect(page.getByTestId('engine-switch-codex')).toBeVisible()
  // its accounts, with Add account
  await expect(page.getByTestId('engine-page').locator('[data-testid^="provider-accounts-"]')).toBeVisible()
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

test('Groups: ⋯ is a bottom sheet, delete last; Usage limits ⌄ is a sheet too; By person\'s segments are 44 px', async ({ page }) => {
  expect((await page.request.post('/api/admin/groups', { headers: H, data: { name: 'Sales', description: '', memberIds: [] } })).ok()).toBeTruthy()
  await page.goto('/admin/groups')
  await page.getByTestId('group-row').filter({ hasText: 'Sales' }).getByTestId('member-more').click()
  const sheet = page.getByRole('menu')
  await expect(sheet).toBeVisible()
  expect(Math.round((await sheet.boundingBox())!.x)).toBe(0)
  await expect(sheet.getByRole('menuitem').last()).toHaveAttribute('data-testid', 'group-delete')
  for (const it of await sheet.getByRole('menuitem').all()) expect(Math.round((await it.boundingBox())!.height)).toBeGreaterThanOrEqual(44)
  await page.keyboard.press('Escape')
  // Usage › Usage limits ⌄: Download CSV in the sheet
  await page.goto('/admin/usage')
  await expect(page.getByTestId('usage-limits-link-more')).toBeEnabled()
  await page.getByTestId('usage-limits-link-more').click()
  await expect(sheet).toBeVisible()
  expect(Math.round((await sheet.boundingBox())!.x)).toBe(0)
  await expect(sheet.getByTestId('usage-csv')).toBeVisible()
  await page.keyboard.press('Escape')
  // Folder permissions: By folder / By person, each 44 px tall
  await page.goto('/admin/folders')
  for (const tab of await page.getByRole('tab').all()) expect(Math.round((await tab.boundingBox())!.height)).toBeGreaterThanOrEqual(44)
})

// - TC-269: the remaining pages in phone layouts. (System is left to the session changing its backup and storage parts.)
test('Plugins: flat rows, the title once; a plugin\'s page has its name on its own line with the buttons under it', async ({ page }) => {
  await page.goto('/admin/plugins')
  await expect(page.getByTestId('plugins-header').getByRole('heading', { name: t['admin.plugins'] })).toHaveClass(/sr-only/)
  const card = page.getByTestId('plugin-catalog').first()
  // no grey frame around a row
  expect(await card.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
  expect(Math.round((await card.getByTestId('plugin-open').boundingBox())!.height)).toBeGreaterThanOrEqual(44)
  const install = page.getByTestId('plugin-install-file')
  if (await install.count()) expect(Math.round((await install.boundingBox())!.width)).toBeLessThanOrEqual(48)
  await card.getByTestId('plugin-open').click()
  const detail = page.getByTestId('plugin-detail')
  const name = (await detail.getByRole('heading').first().boundingBox())!
  expect(name.width).toBeGreaterThan(150)
  const button = (await detail.getByRole('button').filter({ hasNotText: /^$/ }).last().boundingBox())!
  expect(button.y).toBeGreaterThanOrEqual(name.y + name.height - 1)
})

test('Activity log: a row opens the record\'s page; Filters open in a sheet; Back to the list', async ({ page }) => {
  await openAdminPage(page, 'audit', /\/admin\/audit$/)
  const header = page.getByTestId('activity-header')
  const before = (await header.boundingBox())!.height
  await page.getByTestId('activity-more-toggle').click()
  const sheet = page.getByRole('dialog', { name: t['activity.filters'] })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByTestId('activity-kinds')).toBeVisible()
  // the part that stays at the top did not grow
  expect(Math.round((await header.boundingBox())!.height)).toBe(Math.round(before))
  await sheet.getByTestId('activity-more-done').click()
  await expect(sheet).toHaveCount(0)
  const row = page.getByTestId('activity-row').first()
  expect(Math.round((await row.getByRole('button').boundingBox())!.height)).toBeGreaterThanOrEqual(48)
  await row.getByRole('button').click()
  await expect(page).toHaveURL(/\/admin\/audit\/[^/?]+/)
  await expect(page.getByTestId('activity-record')).toBeVisible()
  await expect(page.getByTestId('activity-detail')).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(/\/admin\/audit$/)
  await expect(page.getByTestId('audit-list')).toBeVisible()
})

test('Usage: the breakdown is list rows, not a table', async ({ page }) => {
  await page.goto('/admin/usage')
  await expect(page.getByTestId('usage-rows').or(page.getByTestId('usage-none'))).toBeVisible()
  await expect(page.getByTestId('usage-table')).toHaveCount(0)
  if (await page.getByTestId('usage-row').count()) await expect(page.getByTestId('usage-total')).toBeVisible()
})

test('AI apps: tappable rows, no outline Connect buttons; Claude Code and Codex are set up on a computer', async ({ page }) => {
  await page.goto('/admin/ai-apps')
  const list = page.getByTestId('admin-ai-app-list')
  await expect(list).toBeVisible()
  await expect(list.getByRole('button', { name: t['aiApps.connect'], exact: true })).toHaveCount(0)
  for (const id of ['claude-code', 'codex']) {
    await expect(list.getByTestId(`ai-app-${id}`)).toContainText(t['admin.onComputer'])
    await expect(list.getByTestId(`ai-app-connect-${id}`)).toHaveCount(0)
  }
  const claude = list.getByTestId('ai-app-connect-claude')
  expect(Math.round((await claude.boundingBox())!.height)).toBeGreaterThanOrEqual(48)
  await claude.click()
  await expect(page.getByRole('dialog')).toBeVisible()
})

test('page intros: the line is not cut beside the button; the scope line once, on the list; Team … names', async ({ page }) => {
  await openAdminPage(page, 'members', /\/admin\/members$/)
  const desc = (await page.getByTestId('members-header-desc').boundingBox())!
  const actions = (await page.getByTestId('members-header-actions').boundingBox())!
  expect(actions.y).toBeGreaterThanOrEqual(desc.y + desc.height - 1)
  expect(desc.width).toBeGreaterThan(300)
  await expect(page.getByTestId('admin-content').getByTestId('page-scope')).toHaveCount(0)
  await page.getByTestId('admin-back').click()
  await expect(page.getByTestId('page-scope')).toHaveCount(1)
  // the team's versions of what the 나 list has for the person
  await expect(page.getByTestId('admin-row-providers')).toContainText(t['admin.team.providers'])
  await expect(page.getByTestId('admin-row-connectors')).toContainText(t['admin.team.integrations'])
  await expect(page.getByTestId('admin-row-ai-apps')).toContainText(t['admin.team.aiApps'])
})

test('Team settings › General: the logo in phone words; the update window as two time pickers', async ({ page }) => {
  await page.goto('/admin/settings/general')
  await expect(page.getByTestId('team-icon')).toContainText(t['teamIcon.descPhone'].replace('{product}', '').split(' ')[0]!)
  await expect(page.getByTestId('team-icon-previews')).toHaveCount(0)
  await expect(page.getByTestId('update-window-from')).toHaveAttribute('type', 'time')
  await expect(page.getByTestId('update-window-to')).toHaveAttribute('type', 'time')
})

// - TC-270: computer or server setup is not offered as phone forms.
test('Slack, Connectors and engines: a status row and "Set this up on a computer" instead of computer forms', async ({ page }) => {
  // Slack › Replace tokens
  await page.goto('/admin/slack')
  await expect(page.getByTestId('slack-status')).toBeVisible()
  await page.getByTestId('slack-replace').click()
  await expect(page.getByTestId('slack-on-computer')).toContainText(t['admin.onComputer'])
  await expect(page.getByTestId('slack-bot-token')).toHaveCount(0)
  // Connectors › add by address
  await page.goto('/admin/connectors')
  await expect(page.getByTestId('connector-discover')).toBeVisible()
  await expect(page.getByTestId('integration-add')).toHaveCount(0)
  await expect(page.getByTestId('connector-custom')).toHaveCount(0)
  await expect(page.getByTestId('connector-custom-note')).toHaveText(t['admin.onComputerAdd'])
  // AI accounts › an engine's server login text
  await page.goto('/admin/providers/codex')
  await expect(page.getByTestId('engine-on-computer')).toHaveText(t['admin.onComputer'])
  await expect(page.getByTestId('engine-page')).not.toContainText('codex login')
})
