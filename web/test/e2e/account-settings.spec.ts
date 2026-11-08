// The sidebar sized like Claude's, the account menu above the profile line (who is signed in, Settings, Usage,
// Sign out; the theme is chosen in Settings) and Settings as a dialog over the page it was opened from (components/Sidebar.tsx,
// components/settings/SettingsDialog.tsx, App.tsx useSettingsOverlay): addresses, Esc and ✕, the keyboard staying in
// the dialog and coming back, the search, a phone's full-screen list, and no serious accessibility problems.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { DICTS } from '../../src/i18n'
import { reset, signIn } from './helpers'

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

test('the sidebar is as wide as Claude\'s, with 14 px rows of 36 px', async ({ page }) => {
  await start(page)
  const side = page.getByRole('navigation', { name: t['sidebar.label'] })
  // the column is 280 px, its right border included
  expect(Math.round((await side.locator('..').boundingBox())!.width)).toBe(280)
  // 트리나에게 묻기 is the one text row; 프로젝트 is an icon of the same height
  const newChat = side.getByTestId('new-chat')
  expect(Math.round((await newChat.boundingBox())!.height)).toBe(36)
  expect(await newChat.evaluate((el) => getComputedStyle(el).fontSize)).toBe('14px')
  const projects = side.getByRole('link', { name: t['sidebar.projects'] })
  expect(Math.round((await projects.boundingBox())!.height)).toBe(36)
  expect(await side.getByTestId('recents-toggle').evaluate((el) => getComputedStyle(el.closest('h2')!).fontSize)).toBe('12px')
})

test('the account menu opens above the profile line, moves with the keyboard, and the theme is not in it', async ({ page }) => {
  await start(page)
  const button = page.getByTestId('account-menu')
  await button.click()
  const menu = page.getByTestId('account-dropdown')
  await expect(menu).toBeVisible()
  expect((await menu.boundingBox())!.y + (await menu.boundingBox())!.height).toBeLessThanOrEqual((await button.boundingBox())!.y + 1)
  await expect(page.getByTestId('account-who')).toHaveText(/\S/)
  // first, as in Slack: set yourself away (docs/DECISIONS.md "접속 상태")
  await expect(menu.getByRole('menuitem')).toHaveText([t['presence.setAway'], t['sidebar.settings'], t['sidebar.usage'], t['sidebar.trash'], t['auth.logout']])
  await expect(menu.getByRole('menuitem', { name: t['presence.setAway'] })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('menuitem', { name: t['sidebar.settings'] })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('menuitem', { name: t['sidebar.usage'] })).toBeFocused()
  await page.keyboard.press('End')
  await expect(page.getByTestId('logout')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(button).toBeFocused()

  // the theme is chosen in Settings (one place), not in this menu
  await button.click()
  await page.getByTestId('account-settings').click()
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
  // Usage is the person's own usage, in Settings (everyone's is Admin > Usage)
  await page.getByTestId('account-usage').click()
  await expect(page).toHaveURL(/\/settings\/usage$/)
  await expect(page.getByTestId('my-usage')).toBeVisible()
})

test('Settings opens as a dialog over the page, keeps the keyboard inside, and Esc or ✕ goes back', async ({ page }) => {
  await start(page)
  await page.getByRole('link', { name: t['sidebar.projects'] }).click()
  await expect(page).toHaveURL(/\/projects$/)
  await page.getByTestId('account-menu').click()
  await page.getByTestId('account-settings').click()
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
  await dialog.getByTestId('settings-search').fill('mc')
  await expect(dialog.getByTestId('settings-menu').getByRole('link')).toHaveText([/커넥터|Connectors/])
  await dialog.getByTestId('settings-menu').getByRole('link', { name: /커넥터|Connectors/ }).click()
  await expect(page).toHaveURL(/\/settings\/connectors$/)
  await expect(dialog.getByTestId('connectors-header').getByRole('heading', { name: /커넥터|Connectors/ })).toBeVisible()
  await dialog.getByTestId('settings-search').fill('zzz')
  await expect(dialog.getByTestId('settings-no-match')).toBeVisible()
  // Esc: back to the page under it, and the keyboard back on the account button
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page).toHaveURL(/\/projects$/)
  await expect(page.getByTestId('account-menu')).toBeFocused()
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

test('on a phone Settings is the 나 tab: the list first with my photo row on top, the profile one step down, the tab bar stays, no search or ✕, the rarer sections behind 더 보기, and sign-out at the end', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 })
  await start(page)
  await page.goto('/rooms')
  await page.getByTestId('tab-me').click()
  await expect(page).toHaveURL(/\/settings$/)
  const dialog = page.getByRole('dialog', { name: t['settings.title'] })
  const box = (await dialog.boundingBox())!
  expect(Math.round(box.width)).toBe(390)
  await expect(dialog.getByTestId('bottom-tabs')).toBeVisible()
  await expect(dialog.getByTestId('settings-close')).toBeHidden()
  await expect(dialog.getByTestId('settings-logout')).toBeVisible()
  await dialog.getByTestId('settings-me').click()
  await expect(page).toHaveURL(/\/settings\/profile$/)
  await expect(dialog.getByRole('heading', { name: t['settings.profile'] })).toBeVisible()
  await dialog.getByTestId('settings-back').click()
  await expect(page).toHaveURL(/\/settings$/)
  await expect(dialog.getByTestId('settings-menu')).toBeVisible()
  await expect(dialog.getByTestId('settings-search')).toBeHidden()
  const menu = dialog.getByTestId('settings-menu')
  await expect(menu.getByRole('link', { name: t['integrations.title'] })).toBeHidden()
  await dialog.getByTestId('settings-more').click()
  await expect(menu.getByRole('link', { name: t['integrations.title'] })).toBeVisible()
  await audit(page, 'settings list at phone width')
  // the tab bar is the way out
  await dialog.getByTestId('tab-chats').click()
  await expect(dialog).toHaveCount(0)
  await expect(page).toHaveURL(/\/rooms$/)
})

for (const scheme of ['light', 'dark'] as const) {
  test(`the Settings dialog has no serious accessibility problems (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await start(page)
    for (const path of ['/settings/profile', '/settings/connectors', '/settings/notifications']) {
      await page.goto(path)
      await expect(page.getByRole('dialog', { name: t['settings.title'] })).toBeVisible()
      await page.waitForTimeout(300)
      await audit(page, `${path} ${scheme}`)
    }
  })
}

test('Deleted chats: in the account menu on a wide screen; on a phone a row of the drawer, which has no 파일 row or account menu (sign-out is in the 나 tab)', async ({ page }) => {
  await start(page)
  await page.setViewportSize({ width: 1360, height: 820 })
  await page.goto('/')
  let side = page.getByRole('navigation', { name: t['sidebar.label'] }).last()
  await expect(side.getByRole('link', { name: t['sidebar.trash'] })).toHaveCount(0)
  await side.getByTestId('account-menu').click()
  await side.getByTestId('account-trash').click()
  await expect(page).toHaveURL(/\/trash$/)
  await expect(page.getByRole('heading', { level: 1, name: t['trash.title'] })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 760 })
  await page.goto('/')
  await page.getByRole('button', { name: t['sidebar.open'] }).click()
  side = page.getByRole('navigation', { name: t['sidebar.label'] }).last()
  await expect(side.getByTestId('account-menu')).toBeHidden()
  await expect(side.getByRole('link', { name: t['sidebar.files'] })).toHaveCount(0)
  await side.getByRole('link', { name: t['sidebar.trash'] }).click()
  await expect(page).toHaveURL(/\/trash$/)
  await expect(page.getByRole('heading', { level: 1, name: t['trash.title'] })).toBeVisible()
})

test('on a wide window a page\'s column is centred beside the sidebar; on a phone it is full width', async ({ page }) => {
  await start(page)
  for (const path of ['/skills', '/projects']) {
    await page.setViewportSize({ width: 1800, height: 900 })
    await page.goto(path)
    const main = (await page.locator('#main').boundingBox())!
    const column = page.locator(path === '/skills' ? '[data-testid="skills-header"]' : '[data-sticky-header] > div').first()
    await expect(column).toBeVisible()
    const c = (await column.boundingBox())!
    expect(Math.abs(c.x - main.x - (main.x + main.width - (c.x + c.width)))).toBeLessThanOrEqual(24)
    expect(c.width).toBeLessThan(main.width - 200)
    await page.setViewportSize({ width: 390, height: 760 })
    expect(Math.round((await column.boundingBox())!.width)).toBeGreaterThanOrEqual(390 - 2 * 24)
  }
})

async function someChats(page: Page) {
  const post = (path: string, data: object) => page.request.post(path, { headers: { [CSRF_HEADER]: '1' }, data })
  const project = ((await (await post('/api/projects', { name: 'Launch', scope: 'team', folderPath: 'launch', instructions: '' })).json()) as { id: string }).id
  expect((await post('/api/chats', { projectId: project, title: 'Plan the launch' })).ok()).toBeTruthy()
  expect((await post('/api/chats', { title: 'Weekly notes' })).ok()).toBeTruthy()
  await page.goto('/')
}

test('Recents folds away; filter, group and sort like Claude\'s, remembered and reset', async ({ page }) => {
  await start(page)
  await someChats(page)
  const side = page.getByRole('navigation', { name: t['sidebar.label'] })
  const list = side.getByTestId('recents-list')
  const titles = () => list.getByRole('listitem').allTextContents()
  await expect(list).toContainText('Plan the launch')
  // fold and unfold, remembered after a reload
  await side.getByTestId('recents-toggle').click()
  await expect(side.getByTestId('recents-toggle')).toHaveAttribute('aria-expanded', 'false')
  await expect(list).toBeHidden()
  await page.reload()
  await expect(side.getByTestId('recents-list')).toBeHidden()
  await side.getByTestId('recents-toggle').click()
  await expect(list).toBeVisible()
  // the menu: four rows with their current values, two groups
  await side.getByTestId('recents-filter').click()
  const menu = page.getByTestId('recents-filter-menu')
  await expect(menu.getByRole('menuitem')).toHaveText([
    `${t['sidebar.view.status']}${t['sidebar.status.all']}`,
    `${t['sidebar.view.activity']}${t['sidebar.activity.all']}`,
    `${t['sidebar.view.group']}${t['sidebar.group.date']}`,
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
  await choose('status', 'confidential')
  await expect(side.getByTestId('recents-no-match')).toBeVisible()
  await choose('status', 'all')
  // Last activity: both were made just now
  for (const id of ['today', 'week', 'month', 'all']) {
    await choose('activity', id)
    await expect(list).toContainText('Weekly notes')
  }
  // Group by
  await choose('group', 'project')
  // newest first: the chat without a project was made last
  await expect(list.getByRole('heading', { level: 3 })).toHaveText([t['sidebar.noProject'], 'Launch'])
  await choose('group', 'none')
  await expect(list.getByRole('heading', { level: 3 })).toHaveCount(0)
  // Sort by
  await choose('sort', 'title')
  await expect.poll(titles).toEqual(['Plan the launch', 'Weekly notes'])
  await choose('sort', 'created')
  await expect.poll(titles).toEqual(['Weekly notes', 'Plan the launch'])
  // what is not at its default: a dot and a dim label; remembered; reset
  await page.keyboard.press('Escape')
  await expect(side.getByTestId('recents-filter-dot')).toBeVisible()
  await expect(side.getByTestId('recents-filter-label')).toContainText(t['sidebar.group.none'])
  await expect(side.getByTestId('recents-filter-label')).toContainText(t['sidebar.sort.created'])
  await page.reload()
  await expect(side.getByTestId('recents-filter-label')).toContainText(t['sidebar.sort.created'])
  await side.getByTestId('recents-filter-clear').click()
  await expect(side.getByTestId('recents-filter-label')).toHaveCount(0)
  await expect(side.getByTestId('recents-filter-dot')).toHaveCount(0)
  // PROTOTYPE (desktop sidebar): back to the five latest, without date groups; "모두 보기" shows them by date
  await expect(side.getByTestId('ai-chats-latest')).toBeVisible()
  await expect(list.getByRole('heading', { level: 3 })).toHaveCount(0)
})

test('the Recents menu with the keyboard: Enter, arrows, → into a choice, ← and Esc back', async ({ page }) => {
  await start(page)
  await someChats(page)
  const side = page.getByRole('navigation', { name: t['sidebar.label'] })
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
  const side = page.getByRole('navigation', { name: t['sidebar.label'] })
  const row = side.getByRole('listitem').filter({ hasText: 'Weekly notes' })
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
  // the ⋯ menu has the chat's actions (a chat of my own outside a project: the move too)
  await row.hover()
  await more.click()
  await expect(row.getByRole('menuitem')).toHaveText([t['chat.rename'], t['chat.project.add'], t['common.delete']])
})

test('no quick view on a touch screen; the filter is in the phone drawer', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 760 }, hasTouch: true, isMobile: true, locale: 'ko-KR' })
  const page = await context.newPage()
  await start(page)
  await someChats(page)
  await page.getByRole('button', { name: DICTS.en['sidebar.open'] }).or(page.getByRole('button', { name: DICTS.ko['sidebar.open'] })).first().click()
  const side = page.getByRole('navigation', { name: t['sidebar.label'] }).last()
  await expect(side.getByTestId('recents-filter')).toBeVisible()
  await side.getByRole('listitem').filter({ hasText: 'Weekly notes' }).hover()
  await page.waitForTimeout(800)
  await expect(page.getByTestId('chat-peek')).toHaveCount(0)
  await context.close()
})
