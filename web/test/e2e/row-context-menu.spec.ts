// A right-click on a list row opens that row's "···" menu (rooms/MenuButton.tsx useRowMenu;
// docs/AGENTS/plan/20261128-1102-row-context-menu.md): the same items in the same order, at the pointer and inside the
// window, the event cancelled (so the desktop app shows no menu of its own as well), one menu at a time, Esc gives the
// keyboard back to the row. At 1440: a project's chat row in the Projects panel (the owner's ask), a Trina history row
// and a file row; Shift+F10 opens it from the keyboard; a text box keeps the browser's menu. At 390: a long press on a
// project's chat row opens the same items as its "···", as a sheet.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { openRail, reset, signIn } from './helpers'
import { chatRow, openTab } from './nav'

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' })

const H = { [CSRF_HEADER]: '1' }
async function project(page: Page, name: string): Promise<string> {
  const r = await page.request.post('/api/projects', { headers: H, data: { name, scope: 'team', instructions: '', participants: [{ subjectType: 'user', subjectId: 'bob' }] } })
  expect(r.status()).toBe(201)
  return ((await r.json()) as { id: string }).id
}
async function chat(page: Page, data: { title: string; projectId?: string }): Promise<string> {
  const r = await page.request.post('/api/chats', { headers: H, data })
  expect(r.ok()).toBeTruthy()
  return ((await r.json()) as { id: string }).id
}
/** the open menu's items, by test id */
const menuIds = (page: Page) => page.getByRole('menu').getByRole('menuitem').evaluateAll((es) => es.map((e) => e.getAttribute('data-testid')))
/** the last contextmenu event on the page: was it cancelled (no browser menu, no desktop app menu) */
const watchContextMenu = (page: Page) => page.evaluate(() => {
  document.addEventListener('contextmenu', (e) => { (window as unknown as { lastMenuCancelled: boolean }).lastMenuCancelled = e.defaultPrevented })
})
const lastCancelled = (page: Page) => page.evaluate(() => (window as unknown as { lastMenuCancelled?: boolean }).lastMenuCancelled)

/** a right-click at `dx, dy` inside `target`: the menu has the "···" items, its top left at the pointer, in the window */
async function rightClickOpens(page: Page, target: Locator, more: Locator, dx = 24, dy = 8) {
  // the "···" first: its items
  await target.hover()
  await more.click()
  await expect(page.getByRole('menu')).toBeVisible()
  const viaMore = await menuIds(page)
  expect(viaMore.length).toBeGreaterThan(1)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  // the right-click: the same items in the same order, at the pointer
  const box = (await target.boundingBox())!
  await target.click({ button: 'right', position: { x: dx, y: dy } })
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  expect(await menuIds(page)).toEqual(viaMore)
  expect(await lastCancelled(page)).toBe(true)
  const m = (await menu.boundingBox())!
  // (its top left at the pointer, 4 px under it: MenuButton menuSpot's gap)
  expect(Math.abs(m.x - (box.x + dx))).toBeLessThanOrEqual(2)
  expect(Math.abs(m.y - (box.y + dy + 4))).toBeLessThanOrEqual(2)
  const vp = page.viewportSize()!
  expect(m.x + m.width).toBeLessThanOrEqual(vp.width)
  expect(m.y + m.height).toBeLessThanOrEqual(vp.height)
  return viaMore
}

test.describe('at 1440', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("the Projects panel: a project's chat row opens its \"···\" on a right-click, at the pointer; Esc gives the keyboard back", async ({ page }) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page)
    const p = await project(page, 'Quotes')
    await chat(page, { title: 'Quote for Acme', projectId: p })
    await chat(page, { title: 'Quote for Globex', projectId: p })
    await page.reload()
    await watchContextMenu(page)
    await openRail(page, 'projects')
    const panel = page.getByTestId('projects-panel')
    const projectLi = panel.locator('li').filter({ has: page.getByTestId('projects-panel-row').filter({ hasText: 'Quotes' }) })
    // the project's own row: its "···" items (rename, members, link, leave, delete); clear of its ▸ at the left
    await rightClickOpens(page, projectLi.getByTestId('projects-panel-row'), projectLi.getByTestId('projects-panel-menu'), 90, 10)
    await page.keyboard.press('Escape')
    await projectLi.getByTestId('projects-panel-fold').click()
    const chatLi = panel.getByTestId('projects-panel-chats').locator('li').filter({ hasText: 'Quote for Acme' })
    const link = chatLi.getByTestId('projects-panel-chat')
    const ids = await rightClickOpens(page, link, chatLi.getByTestId('projects-panel-chat-menu'))
    // the history row's items, in the one order (components/menus/entityMenu.tsx)
    expect(ids[0]).toBe('projects-panel-chat-pin')
    expect(ids).toContain('projects-panel-chat-copy-link')
    expect(ids.at(-1)).toBe('projects-panel-chat-delete')
    // one menu at a time: a right-click on the other chat moves the menu there
    const other = panel.getByTestId('projects-panel-chats').locator('li').filter({ hasText: 'Quote for Globex' })
    await other.getByTestId('projects-panel-chat').click({ button: 'right', position: { x: 30, y: 8 } })
    await expect(page.getByRole('menu')).toHaveCount(1)
    await expect(other.getByRole('menu')).toBeVisible()
    // Esc closes it and the keyboard is on the row again
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(other.getByTestId('projects-panel-chat')).toBeFocused()
    // a click outside closes it too
    await link.click({ button: 'right', position: { x: 24, y: 8 } })
    await expect(page.getByRole('menu')).toBeVisible()
    await page.mouse.click(900, 450)
    await expect(page.getByRole('menu')).toHaveCount(0)
    // a pick runs the item: 상단에 고정 / Pin
    await link.click({ button: 'right', position: { x: 24, y: 8 } })
    await page.getByRole('menu').getByTestId('projects-panel-chat-pin').click()
    await link.click({ button: 'right', position: { x: 24, y: 8 } })
    await expect(page.getByRole('menu').getByTestId('projects-panel-chat-unpin')).toBeVisible()
  })

  test('a Trina history row: a right-click and Shift+F10 open the "···"; near the window\'s edge it stays inside', async ({ page }) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page)
    const id = await chat(page, { title: 'Budget review' })
    await page.reload()
    await watchContextMenu(page)
    const row = await chatRow(page, { id })
    const link = row.locator(`a[href="/c/${id}"]`)
    const ids = await rightClickOpens(page, link, row.getByTestId('chat-row-menu'))
    await page.keyboard.press('Escape')
    // the keyboard: Shift+F10 on the focused row, by its "···"
    await link.focus()
    await page.keyboard.press('Shift+F10')
    await expect(page.getByRole('menu')).toBeVisible()
    expect(await menuIds(page)).toEqual(ids)
    await page.keyboard.press('Escape')
    await expect(link).toBeFocused()
    // a short window: at the pointer the menu would run off the bottom, so it goes above it
    const at = (await link.boundingBox())!
    await page.setViewportSize({ width: 1440, height: Math.round(at.y + at.height + 40) })
    await link.click({ button: 'right', position: { x: 24, y: 8 } })
    const m = (await page.getByRole('menu').boundingBox())!
    expect(m.y + m.height).toBeLessThanOrEqual(page.viewportSize()!.height)
    expect(m.y).toBeGreaterThanOrEqual(0)
  })

  test('a file row opens its "···" at the pointer; Shift and a text box keep the browser\'s menu', async ({ page }) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page, { username: 'bob', password: 'bob password 1' })
    await page.goto('/files?path=marketing')
    await watchContextMenu(page)
    const row = page.getByTestId('file-row').filter({ hasText: 'notes.txt' })
    await expect(row).toBeVisible()
    const name = row.getByRole('button', { name: /notes\.txt/ }).first()
    const ids = await rightClickOpens(page, name, row.getByTestId('file-menu'))
    expect(ids).toContain('file-trash')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    // Shift+right-click: the browser's own menu, not ours
    await name.click({ button: 'right', modifiers: ['Shift'] })
    expect(await lastCancelled(page)).toBe(false)
    await expect(page.getByRole('menu')).toHaveCount(0)
    // a text box (the search field): the browser's own
    const search = page.getByRole('searchbox').first()
    await search.click({ button: 'right' })
    expect(await lastCancelled(page)).toBe(false)
    await expect(page.getByRole('menu')).toHaveCount(0)
  })
})

test.describe('at 390', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('a long press on a project\'s chat row opens the same items as its "···", as a sheet, and opens no chat', async ({ page }) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page)
    const p = await project(page, 'Quotes')
    await chat(page, { title: 'Quote for Acme', projectId: p })
    await page.reload()
    await openTab(page, 'projects')
    const list = page.getByTestId('projects-list')
    const projectLi = list.locator('li').filter({ has: page.getByTestId('projects-panel-row').filter({ hasText: 'Quotes' }) })
    await projectLi.getByTestId('projects-panel-fold').click()
    const chatLi = list.getByTestId('projects-panel-chats').locator('li').filter({ hasText: 'Quote for Acme' })
    // the "···" (always there on a phone): its items
    await chatLi.getByTestId('projects-panel-chat-menu').click()
    const sheet = page.getByRole('menu')
    await expect(sheet).toBeVisible()
    const viaMore = await menuIds(page)
    await expect(sheet.getByTestId('menu-sheet-title')).toHaveText('Quote for Acme')
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
    const url = page.url()
    // a long press with a finger on the row
    const link = chatLi.getByTestId('projects-panel-chat')
    const b = (await link.boundingBox())!
    const at = { button: 0, pointerType: 'touch', isPrimary: true, clientX: b.x + 40, clientY: b.y + b.height / 2 }
    await link.dispatchEvent('pointerdown', at)
    await page.waitForTimeout(650)
    await link.dispatchEvent('pointerup', at)
    // the finger lifting is no tap on the row
    await link.dispatchEvent('click', at)
    await expect(sheet).toBeVisible()
    expect(await menuIds(page)).toEqual(viaMore)
    await expect(sheet.getByTestId('menu-sheet-title')).toHaveText('Quote for Acme')
    // a sheet from the bottom of the screen, 48 px rows
    const box = (await sheet.boundingBox())!
    expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(840)
    expect((await sheet.getByRole('menuitem').first().boundingBox())!.height).toBeGreaterThanOrEqual(48)
    expect(page.url()).toBe(url)
  })
})
