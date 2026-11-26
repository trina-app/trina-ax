// Renaming a project where people look for it (docs/decisions/20261116-project-rename-in-place.md), at 1440 and 390 px
// with axe on each screen:
// - a computer: a click on the page's big name turns it into a field (Enter saves, Esc puts it back, leaving it saves);
//   under the pointer it shows the tip "이름 바꾸기"; the list beside the rail and the breadcrumb show the new name;
// - the "···" of the project's row in the list beside the rail (and a right-click on it): 이름 바꾸기, the open page
//   follows;
// - a phone: a tap on the project's name in the top bar opens the rename prompt; the 프로젝트 tab's rows have "···" too;
// - Bob, a member who does not manage the project: plain text on the page and in the bar, no 이름 바꾸기 in the row's menu.
// SHOT_DIR: where the screenshots go (none without it).
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { DICTS, translate } from '../../src/i18n'

const t = DICTS.ko
const H = { [CSRF_HEADER]: '1' }
const BOB = { username: 'bob', password: 'bob password 1' }

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}
const shot = async (page: Page, name: string) => { if (process.env.SHOT_DIR) await page.screenshot({ path: path.join(process.env.SHOT_DIR, `${name}.png`) }) }

/** a team project the owner makes, with Bob in it */
async function project(page: Page, name: string) {
  const r = await page.request.post('/api/projects', { headers: H, data: { name, scope: 'team', instructions: '', participants: [{ subjectType: 'user', subjectId: 'bob' }] } })
  expect(r.status()).toBe(201)
  return ((await r.json()) as { id: string }).id
}
const nameOnServer = async (page: Page, id: string) => ((await (await page.request.get(`/api/projects/${id}`)).json()) as { name: string }).name
const row = (page: Page, name: string) => page.getByTestId('projects-panel-row').filter({ hasText: name }).locator('xpath=..')

const DESK = { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' as const }
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' as const }

test.describe('rename a project at 1440', () => {
  test.use(DESK)

  test('a click on the big name: a field with the name, Enter saves, Esc puts it back, leaving it saves', async ({ page }) => {
    await reset(page)
    await signIn(page)
    const id = await project(page, 'Launch')
    await page.goto(`/projects/${id}`)
    const title = page.getByTestId('project-title')
    const name = title.getByTestId('project-title-rename')
    await expect(page.getByRole('heading', { level: 1, name: 'Launch' })).toBeVisible()
    // under the pointer: a text cursor, a fill and the tip
    await expect(name).toHaveCSS('cursor', 'text')
    await name.hover()
    await expect(page.getByRole('tooltip')).toHaveText(t['chat.rename'])
    await shot(page, 'title-hover-1440')
    await name.click()
    const field = title.getByTestId('project-title-input')
    await expect(field).toBeFocused()
    await expect(field).toHaveValue('Launch')
    await expect(field).toHaveAccessibleName(t['projects.name'])
    await audit(page, 'title field')
    await shot(page, 'title-editing-1440')
    // Esc: back as it was, nothing sent
    await field.fill('Launch 2027')
    await field.press('Escape')
    await expect(field).toHaveCount(0)
    await expect(name).toHaveText('Launch')
    await expect(name).toBeFocused()
    expect(await nameOnServer(page, id)).toBe('Launch')
    // Enter: saved, on the page, in the breadcrumb and in the list beside the rail
    await name.click()
    await field.fill('  Launch 2027  ')
    await field.press('Enter')
    await expect(field).toHaveCount(0)
    await expect(name).toHaveText('Launch 2027')
    await expect(name).toBeFocused()
    await expect(page.getByTestId('project-menu')).toHaveText('Launch 2027')
    await expect(page.getByTestId('projects-panel').getByTestId('projects-panel-name')).toContainText(['Launch 2027'])
    await expect.poll(() => nameOnServer(page, id)).toBe('Launch 2027')
    // leaving the field saves; an emptied field changes nothing
    await name.click()
    await field.fill('Launch spring')
    // (the empty end of the top line: nothing there takes the click)
    await page.getByTestId('project-topline').click({ position: { x: 700, y: 24 } })
    await expect(field).toHaveCount(0)
    await expect(name).toHaveText('Launch spring')
    await expect.poll(() => nameOnServer(page, id)).toBe('Launch spring')
    await name.click()
    await field.fill('   ')
    await field.press('Enter')
    await expect(name).toHaveText('Launch spring')
    // the name's menu at the top keeps its items
    await page.getByTestId('project-menu').click()
    await expect(page.getByTestId('project-edit')).toBeVisible()
  })

  test('the row\'s "···" in the list beside the rail: 이름 바꾸기, and the open page follows', async ({ page }) => {
    await reset(page)
    await signIn(page)
    const id = await project(page, 'Launch')
    await page.goto(`/projects/${id}`)
    const r = row(page, 'Launch')
    const more = r.getByTestId('projects-panel-menu')
    await page.mouse.move(0, 0)
    await expect(more).toHaveCSS('opacity', '0')
    await r.hover()
    await expect(more).toHaveCSS('opacity', '1')
    await expect(more).toHaveAccessibleName(translate('ko', 'rooms.menu.rowLabel', { name: 'Launch' }))
    await more.click()
    const menu = r.getByRole('menu')
    await expect(menu.getByRole('menuitem')).toHaveText([t['rooms.menu.copyLink'], t['chat.rename'], t['projects.participants'], t['projects.leave'], t['files.moveToTrash']])
    await audit(page, 'row menu open')
    await shot(page, 'row-menu-1440')
    await menu.getByRole('menuitem', { name: t['chat.rename'] }).click()
    const dialog = page.getByRole('dialog')
    const field = dialog.getByLabel(t['projects.name'])
    await expect(field).toHaveValue('Launch')
    await field.fill('Launch 2027')
    await dialog.getByTestId('dialog-confirm').click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId('project-title-rename')).toHaveText('Launch 2027')
    await expect(row(page, 'Launch 2027')).toHaveCount(1)
    await expect.poll(() => nameOnServer(page, id)).toBe('Launch 2027')
    // a right-click on the row opens the same menu
    await row(page, 'Launch 2027').getByTestId('projects-panel-row').click({ button: 'right' })
    await expect(row(page, 'Launch 2027').getByRole('menuitem', { name: t['chat.rename'] })).toBeVisible()
    await page.keyboard.press('Escape')
  })
})

test.describe('rename a project at 390', () => {
  test.use(PHONE)

  test('a tap on the name in the top bar opens the rename prompt; the 프로젝트 tab\'s rows have "···" with 이름 바꾸기', async ({ page }) => {
    await reset(page)
    await signIn(page)
    const id = await project(page, 'Launch')
    await page.goto(`/projects/${id}`)
    const bar = page.getByTestId('topbar-title')
    await expect(bar).toHaveText('Launch')
    await expect(bar).toHaveAccessibleName(translate('ko', 'projects.renameNamed', { name: 'Launch' }))
    // the big name is the bar's (here for screen readers only, never a field)
    await expect(page.getByTestId('project-title-rename')).toHaveCount(0)
    await audit(page, 'phone project page')
    await bar.tap()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: t['chat.rename'] })).toBeVisible()
    const field = dialog.getByLabel(t['projects.name'])
    await expect(field).toHaveValue('Launch')
    await shot(page, 'phone-rename-prompt-390')
    await field.fill('Launch 2027')
    await dialog.getByTestId('dialog-confirm').tap()
    await expect(dialog).toHaveCount(0)
    await expect(bar).toHaveText('Launch 2027')
    await expect.poll(() => nameOnServer(page, id)).toBe('Launch 2027')

    // the 프로젝트 tab's list: each row's "···" (always shown on a phone), a bottom sheet with the name on top
    await page.goto('/projects')
    const r = row(page, 'Launch 2027')
    const more = r.getByTestId('projects-panel-menu')
    await expect(more).toHaveCSS('opacity', '1')
    await more.tap()
    await expect(r.getByTestId('menu-sheet-title')).toHaveText('Launch 2027')
    await shot(page, 'phone-row-sheet-390')
    await audit(page, 'phone row sheet')
    await r.getByRole('menuitem', { name: t['chat.rename'] }).tap()
    const again = page.getByRole('dialog')
    await again.getByLabel(t['projects.name']).fill('Launch spring')
    await again.getByTestId('dialog-confirm').tap()
    await expect(row(page, 'Launch spring')).toHaveCount(1)
    await expect.poll(() => nameOnServer(page, id)).toBe('Launch spring')
  })
})

for (const vp of [{ name: '1440', phone: false, use: DESK }, { name: '390', phone: true, use: PHONE }]) {
  test.describe(`no rename for a member who does not manage the project at ${vp.name}`, () => {
    test.use(vp.use)
    const asBob = async (browser: Browser): Promise<Page> => {
      const ctx = await browser.newContext({ locale: 'ko-KR', serviceWorkers: 'block', ...vp.use })
      const b = await ctx.newPage()
      await signIn(b, BOB)
      return b
    }

    test('Bob reads the name as plain text and has no 이름 바꾸기 in the row\'s menu', async ({ page, browser }) => {
      await reset(page)
      await signIn(page)
      const id = await project(page, 'Launch')
      const b = await asBob(browser)
      await b.goto(`/projects/${id}`)
      if (vp.phone) {
        const bar = b.getByTestId('topbar-title')
        await expect(bar).toHaveText('Launch')
        await expect(bar).not.toHaveAttribute('data-press', '')
        await bar.tap()
        await expect(b.getByRole('dialog')).toHaveCount(0)
      } else {
        await expect(b.getByRole('heading', { level: 1, name: 'Launch' })).toBeVisible()
        await expect(b.getByTestId('project-title-rename')).toHaveCount(0)
        await b.getByTestId('project-title').click()
        await expect(b.getByTestId('project-title-input')).toHaveCount(0)
      }
      await audit(b, 'member project page')
      if (vp.phone) await b.goto('/projects')
      const r = row(b, 'Launch')
      if (!vp.phone) await r.hover()
      await r.getByTestId('projects-panel-menu').click()
      const items = r.getByRole('menuitem')
      await expect(items.first()).toBeVisible()
      await expect(r.getByRole('menuitem', { name: t['chat.rename'] })).toHaveCount(0)
      await expect(items).toHaveText([t['rooms.menu.copyLink'], t['projects.leave']])
      await shot(b, `member-row-menu-${vp.name}`)
      await b.context().close()
      expect(await nameOnServer(page, id)).toBe('Launch')
    })
  })
}
