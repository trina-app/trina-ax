// The sidebar sized like Claude's, the account menu above the profile line (who is signed in, Settings, Usage,
// Sign out; the theme is chosen in Settings) and Settings as a dialog over the page it was opened from (components/Sidebar.tsx,
// components/settings/SettingsDialog.tsx, App.tsx useSettingsOverlay): addresses, Esc and ✕, the keyboard staying in
// the dialog and coming back, the search, a phone's full-screen list, and no serious accessibility problems.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { DICTS } from '../../src/i18n'
import { reset, signIn } from './helpers'
import { accountButton, chatList, navChatList, navLists, openAccountMenu, openSettings, openTab, openTrinaRow, openUsage, phoneTrinaHome, settingsDialog, tabBar, tabButton } from './nav'

const t = DICTS.en

async function start(page: Page) {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
}

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

test('the account menu opens above the profile line (beside the rail\'s photo), moves with the keyboard, and the theme is not in it', async ({ page }) => {
  await start(page)
  const button = accountButton(page)
  const menu = await openAccountMenu(page)
  const m = (await menu.boundingBox())!
  const b = (await button.boundingBox())!
  // the rail's photo: the menu to its right
  expect(m.x).toBeGreaterThanOrEqual(b.x + b.width - 1)
  await expect(page.getByTestId('account-who')).toHaveText(/\S/)
  // first, as in Slack: set yourself away (docs/DECISIONS.md "접속 상태")
  // then my status message (docs/DECISIONS.md "상태 메시지"): "Set your status" while I have none; Usage is in Settings
  // and Deleted history in the 트리나 list
  await expect(menu.getByRole('menuitem')).toHaveText([t['presence.setAway'], t['status.set'], t['sidebar.settings'], t['auth.logout']])
  await expect(menu.getByRole('menuitem', { name: t['presence.setAway'] })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('menuitem', { name: t['status.set'] })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('menuitem', { name: t['sidebar.settings'] })).toBeFocused()
  await page.keyboard.press('End')
  await expect(page.getByTestId('logout')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(button).toBeFocused()

  // the theme is chosen in Settings (one place), not in this menu
  await openSettings(page)
  const dialog = page.getByRole('dialog', { name: t['settings.title'] })
  const themes = dialog.getByRole('radiogroup', { name: t['settings.theme'] })
  await themes.getByRole('radio', { name: t['settings.theme.dark'] }).click()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect(themes.getByRole('radio', { name: t['settings.theme.dark'] })).toHaveAttribute('aria-checked', 'true')
  await themes.getByRole('radio', { name: t['settings.theme.light'] }).click()
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await button.click()
  await audit(page, 'account menu')
  await page.keyboard.press('Escape')
  // Usage is the person's own usage, in Settings (everyone's is Admin > Usage)
  await openUsage(page)
  await expect(page).toHaveURL(/\/settings\/usage$/)
  await expect(page.getByTestId('my-usage')).toBeVisible()
})

test('Settings opens as a dialog over the page, keeps the keyboard inside, and Esc or ✕ goes back', async ({ page }) => {
  await start(page)
  await openTrinaRow(page, 'projects')
  await expect(page).toHaveURL(/\/projects$/)
  await openSettings(page)
  await expect(page).toHaveURL(/\/settings$/)
  const dialog = page.getByRole('dialog', { name: t['settings.title'] })
  await expect(dialog).toBeVisible()
  // the page it was opened from stays under it
  await expect(page.getByTestId('project-new')).toBeAttached()
  await expect(dialog.getByRole('heading', { name: t['settings.profile'] })).toBeVisible()
  // the keyboard stays in the dialog
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true)
  }
  // the search narrows the list by name; a section opens on the right and the address follows
  await dialog.getByTestId('settings-search').fill(t['aiApps.title'])
  await expect(dialog.getByTestId('settings-menu').getByRole('link')).toHaveText([t['aiApps.title']])
  // (Connectors is not in Settings: it is its own item of the sidebar)
  await dialog.getByTestId('settings-search').fill('zzz')
  await expect(dialog.getByTestId('settings-no-match')).toBeVisible()
  // Esc: back to the page under it, and the keyboard back on the account button
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page).toHaveURL(/\/projects$/)
  await expect(accountButton(page)).toBeFocused()
  // the browser's back button after closing does not open it again
  await page.goBack()
  await expect(page.getByRole('dialog', { name: t['settings.title'] })).toHaveCount(0)
})

test('a Settings address opened directly shows the dialog over Home; ✕ closes it there', async ({ page }) => {
  await start(page)
  await page.goto('/settings/memory')
  const dialog = page.getByRole('dialog', { name: t['settings.title'] })
  await expect(dialog.getByRole('heading', { name: t['settings.memory'] })).toBeVisible()
  await expect(page.getByTestId('composer-input')).toBeAttached()
  await page.getByTestId('settings-close').click()
  await expect(dialog).toHaveCount(0)
  await expect(page).toHaveURL(/\/$/)
  // an address that is not a section opens the profile
  await page.goto('/settings/nothing-here')
  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.getByRole('dialog').getByRole('heading', { name: t['settings.profile'] })).toBeVisible()
})

test('on a phone Settings is the 나 tab: the list first with my photo row on top, the profile one step down, the tab bar stays, no search or ✕, every section in its group, and sign-out at the end', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 })
  await start(page)
  await page.goto('/rooms')
  await openTab(page, 'me')
  await expect(page).toHaveURL(/\/settings$/)
  const dialog = settingsDialog(page)
  const box = (await dialog.boundingBox())!
  expect(Math.round(box.width)).toBe(390)
  await expect(tabBar(dialog)).toBeVisible()
  await expect(dialog.getByTestId('settings-close')).toBeHidden()
  await expect(dialog.getByTestId('settings-logout')).toBeVisible()
  await dialog.getByTestId('settings-me').click()
  await expect(page).toHaveURL(/\/settings\/profile$/)
  await expect(dialog.getByRole('heading', { name: t['settings.profile'] })).toBeVisible()
  await dialog.getByTestId('settings-back').click()
  await expect(page).toHaveURL(/\/settings$/)
  await expect(dialog.getByTestId('settings-menu')).toBeVisible()
  await expect(dialog.getByTestId('settings-search')).toBeHidden()
  // the connections show in their group (no "더 보기" row on a phone any more: docs/DECISIONS.md "Admin and Settings on
  // phones")
  const menu = dialog.getByTestId('settings-menu')
  await expect(menu.getByRole('link', { name: t['aiApps.title'] })).toBeVisible()
  await expect(dialog.getByTestId('settings-more')).toHaveCount(0)
  // Connectors is a section of Settings (QA TC-400), the first row of Connections; the drawer has none
  await expect(menu.getByRole('link', { name: t['integrations.title'], exact: true })).toHaveCount(1)
  await expect(dialog.getByTestId('settings-group-connections').getByRole('link').first()).toHaveAttribute('href', '/settings/connectors')
  await audit(page, 'settings list at phone width')
  // the tab bar is the way out
  await tabButton(page, 'chats').click()
  await expect(dialog).toHaveCount(0)
  await expect(page).toHaveURL(/\/rooms$/)
})

for (const scheme of ['light', 'dark'] as const) {
  test(`the Settings dialog has no serious accessibility problems (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await start(page)
    for (const path of ['/settings/profile', '/settings/ai-apps', '/settings/notifications']) {
      await page.goto(path)
      await expect(page.getByRole('dialog', { name: t['settings.title'] })).toBeVisible()
      await page.waitForTimeout(300)
      await audit(page, `${path} ${scheme}`)
    }
  })
}

test('on a wide window a page\'s column is centred beside the sidebar; on a phone it is full width', async ({ page }) => {
  await start(page)
  for (const path of ['/skills', '/projects']) {
    await page.setViewportSize({ width: 1800, height: 900 })
    await page.goto(path)
    const column = page.locator(path === '/skills' ? '[data-testid="skills-header"]' : '[data-sticky-header] > div').first()
    await expect(column).toBeVisible()
    const main = (await page.locator('#main').boundingBox())!
    const c = (await column.boundingBox())!
    expect(Math.abs(c.x - main.x - (main.x + main.width - (c.x + c.width)))).toBeLessThanOrEqual(24)
    expect(c.width).toBeLessThan(main.width - 200)
    await page.setViewportSize({ width: 390, height: 760 })
    // a phone's Projects is the 프로젝트 tab's list from edge to edge under the phone's bar, without the page header
    // (measured once the page has laid out at the new width: read right after the resize, a loaded machine got a
    // transient state, 46 px)
    const phoneColumn = path === '/skills' ? column : page.getByTestId('phone-projects-list')
    await expect.poll(async () => Math.round((await phoneColumn.boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(390 - 2 * 24)
  }
})

async function someChats(page: Page) {
  const post = (path: string, data: object) => page.request.post(path, { headers: { [CSRF_HEADER]: '1' }, data })
  const project = ((await (await post('/api/projects', { name: 'Launch', scope: 'team', folderPath: 'launch', instructions: '' })).json()) as { id: string }).id
  expect((await post('/api/chats', { projectId: project, title: 'Plan the launch' })).ok()).toBeTruthy()
  expect((await post('/api/chats', { title: 'Weekly notes' })).ok()).toBeTruthy()
  await page.goto('/')
}

test('the 트리나 list\'s filter, group and sort like Claude\'s, remembered and reset', async ({ page }) => {
  await start(page)
  await someChats(page)
  const side = await navLists(page)
  const list = navChatList(page)
  const titles = () => list.locator('li a[href^="/c/"]').allTextContents()
  await expect(list).toContainText('Plan the launch')
  // the menu: four rows with their current values, two groups
  await side.getByTestId('recents-filter').click()
  const menu = page.getByTestId('recents-filter-menu')
  await expect(menu.getByRole('menuitem')).toHaveText([
    `${t['sidebar.view.status']}${t['sidebar.status.all']}`,
    `${t['sidebar.view.activity']}${t['sidebar.activity.all']}`,
    `${t['sidebar.view.group']}${t['sidebar.group.none']}`,
    `${t['sidebar.view.sort']}${t['sidebar.sort.updated']}`,
  ])
  await expect(menu.getByRole('separator')).toHaveCount(1)
  await expect(side.getByTestId('recents-filter-dot')).toHaveCount(0)
  await page.keyboard.press('Escape')
  const choose = async (key: string, id: string) => {
    if (!(await page.getByTestId('recents-filter-menu').isVisible())) await side.getByTestId('recents-filter').click()
    await page.getByTestId(`recents-view-${key}`).click()
    await expect(page.getByTestId(`recents-${key}-${id}`)).toBeVisible()
    await page.getByTestId(`recents-${key}-${id}`).click()
  }
  // Status
  await choose('status', 'project')
  await expect.poll(titles).toEqual(['Plan the launch'])
  await choose('status', 'noProject')
  await expect.poll(titles).toEqual(['Weekly notes'])
  await choose('status', 'waiting')
  await expect(side.getByTestId('recents-no-match')).toHaveText(t['sidebar.filter.none'])
  // "Confidential" only while Safe operations 1A is on or a chat is confidential (QA TC-1031; trina-panel.spec.ts)
  await page.getByTestId('recents-view-status').click()
  await expect(page.getByTestId('recents-status-waiting')).toBeVisible()
  await expect(page.getByTestId('recents-status-confidential')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await choose('status', 'all')
  // Last activity: both were made just now
  for (const id of ['today', 'week', 'month', 'all']) {
    await choose('activity', id)
    await expect(list).toContainText('Weekly notes')
  }
  // Group by: None by default, the flat list (the owner, 2026-11-14); by date, by project one choice away
  await choose('group', 'date')
  await expect(list.getByRole('heading', { level: 3 })).toHaveText([t['sidebar.today']])
  await choose('group', 'project')
  await expect(list.getByTestId('history-group')).toHaveCount(2)
  // by date again for the sorts (by project the groups set the order)
  await choose('group', 'date')
  // Sort by
  await choose('sort', 'title')
  await expect.poll(titles).toEqual(['Plan the launch', 'Weekly notes'])
  await choose('sort', 'created')
  await expect.poll(titles).toEqual(['Weekly notes', 'Plan the launch'])
  // what is not at its default: a dot and a dim label; remembered; reset
  await page.keyboard.press('Escape')
  await expect(side.getByTestId('recents-filter-dot')).toBeVisible()
  await expect(side.getByTestId('recents-filter-label')).toContainText(t['sidebar.group.date'])
  await expect(side.getByTestId('recents-filter-label')).toContainText(t['sidebar.sort.created'])
  await page.reload()
  await expect(side.getByTestId('recents-filter-label')).toContainText(t['sidebar.sort.created'])
  await side.getByTestId('recents-filter-clear').click()
  await expect(side.getByTestId('recents-filter-label')).toHaveCount(0)
  await expect(side.getByTestId('recents-filter-dot')).toHaveCount(0)
  // back to the 트리나 list, flat
  await expect(side.getByTestId('trina-list')).toBeVisible()
})

test('the Recents menu with the keyboard: Enter, arrows, → into a choice, ← and Esc back', async ({ page }) => {
  await start(page)
  await someChats(page)
  const side = await navLists(page)
  await side.getByTestId('recents-filter').focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('recents-view-status')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByTestId('recents-view-activity')).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('recents-activity-all')).toBeFocused()
  await expect(page.getByTestId('recents-activity-all')).toHaveAttribute('aria-checked', 'true')
  await audit(page, 'recents menu and submenu')
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('recents-submenu')).toHaveCount(0)
  await expect(page.getByTestId('recents-view-activity')).toBeFocused()
  await page.keyboard.press('Enter')
  await page.keyboard.press('ArrowDown')
  await expect(page.getByTestId('recents-activity-today')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('recents-view-activity')).toBeFocused()
  await expect(page.getByTestId('recents-view-activity')).toContainText(t['sidebar.today'])
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('recents-filter-menu')).toHaveCount(0)
  await expect(side.getByTestId('recents-filter')).toBeFocused()
  await expect(side.getByTestId('recents-filter-label')).toContainText(t['sidebar.today'])
})

test('a recent chat shows its ⋯ menu on hover or focus, and a quick view after resting on it', async ({ page }) => {
  await start(page)
  await someChats(page)
  const side = await navLists(page)
  const row = (await chatList(page)).getByRole('listitem').filter({ hasText: 'Weekly notes' })
  const more = row.getByRole('button', { name: t['chat.menu'] })
  await expect(more).toHaveCSS('opacity', '0')
  await row.hover()
  await expect(more).toHaveCSS('opacity', '1')
  // the quick view: not at once, then beside the sidebar, decorative, gone on leave and on Esc
  await expect(page.getByTestId('chat-peek')).toHaveCount(0)
  await expect(page.getByTestId('chat-peek')).toBeVisible({ timeout: 2000 })
  const peek = page.getByTestId('chat-peek')
  await expect(peek).toHaveAttribute('aria-hidden', 'true')
  await expect(peek).toContainText('Weekly notes')
  expect((await peek.boundingBox())!.x).toBeGreaterThanOrEqual((await side.boundingBox())!.x + (await side.boundingBox())!.width)
  await page.mouse.move(900, 500)
  await expect(peek).toHaveCount(0)
  await row.hover()
  await expect(page.getByTestId('chat-peek')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('chat-peek')).toHaveCount(0)
  // the ⋯ menu has the chat's actions (a pin first, then its link; a chat of my own outside a project: the move too)
  await row.hover()
  await more.click()
  // the Trina list has no folders any more: no "Move to folder", the project's move instead
  await expect(row.getByRole('menuitem')).toHaveText([t['chat.pin'], t['rooms.menu.copyLink'], t['chat.rename'], t['chat.project.add'], t['common.delete']])
  await expect(page.getByTestId('row-folder-move')).toHaveCount(0)
})

test('no quick view on a touch screen; the filter is on the 트리나 tab', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 760 }, hasTouch: true, isMobile: true, locale: 'ko-KR' })
  const page = await context.newPage()
  await start(page)
  await someChats(page)
  const list = await chatList(page)
  await expect(phoneTrinaHome(page).getByTestId('recents-filter')).toBeVisible()
  await list.getByRole('listitem').filter({ hasText: 'Weekly notes' }).hover()
  await page.waitForTimeout(800)
  await expect(page.getByTestId('chat-peek')).toHaveCount(0)
  await context.close()
})
