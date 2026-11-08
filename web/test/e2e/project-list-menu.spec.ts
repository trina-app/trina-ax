// The "…" on each card of the Projects list (이름 바꾸기, 링크 복사, 삭제 with the project page's own confirm), and
// "프로젝트로 옮기기…" in a chat row's "…" in the sidebar (the phone's drawer), which a shared project chat never offers.
// At 1440 and 390 px wide (a touch phone: the card's "…" always shows and opens a bottom sheet), with axe on each screen.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { DICTS, translate } from '../../src/i18n'

const t = DICTS.ko
const post = (page: Page, path: string, data: object) => page.request.post(path, { headers: { [CSRF_HEADER]: '1' }, data })
const patch = (page: Page, path: string, data: object) => page.request.patch(path, { headers: { [CSRF_HEADER]: '1' }, data })

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

/** a team project; `share`: its chats shared with its people */
async function project(page: Page, name: string, folderPath: string, share = false) {
  const r = await post(page, '/api/projects', { name, scope: 'team', folderPath, instructions: `${name}: answer in short bullet points.` })
  expect(r.status()).toBe(201)
  const id = ((await r.json()) as { id: string }).id
  if (share) expect((await patch(page, `/api/projects/${id}`, { shareChats: true })).ok()).toBeTruthy()
  return id
}
async function chat(page: Page, title: string, projectId?: string) {
  const r = await post(page, '/api/chats', { title, ...(projectId ? { projectId } : {}) })
  expect(r.ok()).toBeTruthy()
  return (await r.json()) as { id: string; projectId: string | null; shared?: unknown }
}

const card = (page: Page, name: string) => page.getByTestId('project-card').filter({ has: page.getByRole('link', { name: new RegExp(`^${name}`) }) })
/** the card's "…" opened: on a computer it shows on hover and opens a menu at the button; on a touch phone it always
 * shows and opens a bottom sheet with the project's name on top */
async function openCard(page: Page, name: string, phone: boolean) {
  const more = card(page, name).getByTestId('project-card-menu')
  if (phone) {
    await expect(more).toHaveCSS('opacity', '1')
  } else {
    await page.mouse.move(0, 0)
    await expect(more).toHaveCSS('opacity', '0')
    await card(page, name).hover()
    await expect(more).toHaveCSS('opacity', '1')
  }
  await more.click()
  const menu = card(page, name).getByRole('menu')
  await expect(menu).toBeVisible()
  if (phone) await expect(card(page, name).getByTestId('menu-sheet-title')).toHaveText(name)
  return menu
}

for (const vp of [{ name: '1440', phone: false, use: { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' as const } }, { name: '390', phone: true, use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' as const } }]) {
  test.describe(`the Projects list menu at ${vp.name}`, () => {
    test.use(vp.use)

    test('rename from the list: the small prompt with the name in it, and the card shows the new name', async ({ page }) => {
      await reset(page)
      await signIn(page)
      const id = await project(page, 'Launch', 'marketing')
      await page.goto('/projects')
      const menu = await openCard(page, 'Launch', vp.phone)
      await expect(menu.getByRole('menuitem')).toHaveText([t['chat.rename'], t['rooms.menu.copyLink'], t['common.delete']])
      await audit(page, 'card menu open')
      await menu.getByRole('menuitem', { name: t['chat.rename'] }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByRole('heading', { name: t['chat.rename'] })).toBeVisible()
      const field = dialog.getByLabel(t['projects.name'])
      await expect(field).toHaveValue('Launch')
      await expect(field).toBeFocused()
      await audit(page, 'rename dialog')
      await field.fill('Launch 2027')
      await dialog.getByTestId('dialog-confirm').click()
      await expect(dialog).toHaveCount(0)
      await expect(card(page, 'Launch 2027')).toBeVisible()
      expect(((await (await page.request.get(`/api/projects/${id}`)).json()) as { name: string }).name).toBe('Launch 2027')
      // the card still opens the project
      await card(page, 'Launch 2027').getByRole('link').click()
      await expect(page).toHaveURL(new RegExp(`/projects/${id}$`))
      await expect(page.getByRole('heading', { level: 1, name: 'Launch 2027' })).toBeVisible()
    })

    test('copy link: the project page\'s full address on this origin, with a toast', async ({ page }) => {
      await reset(page)
      await signIn(page)
      const id = await project(page, 'Launch', 'marketing')
      await page.goto('/projects')
      const menu = await openCard(page, 'Launch', vp.phone)
      await menu.getByRole('menuitem', { name: t['rooms.menu.copyLink'] }).click()
      await expect(page.getByText(t['rooms.menu.linkCopied'])).toBeVisible()
      await expect(menu).toHaveCount(0)
      const origin = new URL(page.url()).origin
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${origin}/projects/${id}`)
    })

    test('delete from the list: the project page\'s confirm, with the shared chats line only when it has some', async ({ page }) => {
      await reset(page)
      await signIn(page)
      const launch = await project(page, 'Launch', 'marketing', true)
      const shared = await chat(page, 'Launch plan (shared)', launch)
      expect(shared.shared).toBeTruthy()
      await project(page, 'Budget', 'finance')
      await page.goto('/projects')
      await expect(page.getByTestId('project-card')).toHaveCount(2)

      // no shared chats: the plain confirm; cancel keeps it
      let menu = await openCard(page, 'Budget', vp.phone)
      await menu.getByRole('menuitem', { name: t['common.delete'] }).click()
      let dialog = page.getByRole('dialog')
      await expect(dialog.getByRole('heading')).toHaveText(translate('ko', 'projects.deleteTitle', { name: 'Budget' }))
      await expect(dialog).toContainText(t['projects.deleteBody'])
      await expect(dialog.getByTestId('project-delete-shared')).toHaveCount(0)
      await dialog.getByRole('button', { name: t['common.cancel'], exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect(page.getByTestId('project-card')).toHaveCount(2)

      // shared chats: the line that says they go too; delete
      menu = await openCard(page, 'Launch', vp.phone)
      await menu.getByRole('menuitem', { name: t['common.delete'] }).click()
      dialog = page.getByRole('dialog')
      await expect(dialog).toContainText(t['projects.deleteBodyShared'])
      await expect(dialog.getByTestId('project-delete-shared')).toHaveText(translate('ko', 'projects.deleteShared', { n: 1 }))
      await audit(page, 'delete confirm with shared chats')
      await dialog.getByTestId('dialog-confirm').click()
      await expect(dialog).toHaveCount(0)
      await expect(page.getByTestId('project-card')).toHaveCount(1)
      await expect(card(page, 'Launch')).toHaveCount(0)
      expect((await page.request.get(`/api/projects/${launch}`)).status()).toBe(404)
      expect((await page.request.get(`/api/chats/${shared.id}`)).status()).toBe(404)
      // the keyboard is on the card that is left, not lost on the page
      if (!vp.phone) await expect(card(page, 'Budget').getByRole('link')).toBeFocused()
    })

    if (!vp.phone)
      test('keyboard: the "…" comes after the card\'s link, Enter opens the menu, Esc closes it and gives the keyboard back', async ({ page }) => {
        await reset(page)
        await signIn(page)
        await project(page, 'Launch', 'marketing')
        await page.goto('/projects')
        await card(page, 'Launch').getByRole('link').focus()
        await page.keyboard.press('Tab')
        const more = card(page, 'Launch').getByTestId('project-card-menu')
        await expect(more).toBeFocused()
        await expect(more).toHaveAccessibleName(translate('ko', 'rooms.menu.rowLabel', { name: 'Launch' }))
        await expect(more).toHaveCSS('opacity', '1')
        await page.keyboard.press('Enter')
        await expect(card(page, 'Launch').getByRole('menuitem').first()).toBeFocused()
        await page.keyboard.press('Escape')
        await expect(card(page, 'Launch').getByRole('menu')).toHaveCount(0)
        await expect(more).toBeFocused()
      })
  })

  test.describe(`move a chat from its row in the sidebar at ${vp.name}`, () => {
    test.use(vp.use)

    /** the history's row of the chat with this title (the drawer on a phone), its "…" opened */
    async function rowMenu(page: Page, title: string): Promise<{ row: Locator; menu: Locator }> {
      if (vp.phone && !(await page.locator('[data-drawer]').isVisible())) await page.getByTestId('menu-open').click()
      const list = page.locator(vp.phone ? '[data-drawer]' : 'body').getByTestId('recents-list')
      const row = list.getByRole('listitem').filter({ hasText: title })
      await row.hover()
      await row.getByRole('button', { name: t['chat.menu'], exact: true }).click()
      const menu = row.getByRole('menu')
      await expect(menu).toBeVisible()
      return { row, menu }
    }

    test('"프로젝트로 옮기기…" opens the move dialog; the chat moves, and its row then says "프로젝트 바꾸기…"', async ({ page }) => {
      await reset(page)
      await signIn(page)
      const id = await project(page, 'Launch', 'marketing')
      const c = await chat(page, 'Competitor notes')
      await page.goto('/')
      let { row, menu } = await rowMenu(page, 'Competitor notes')
      await expect(menu.getByRole('menuitem')).toHaveText([t['chat.rename'], t['chat.project.add'], t['common.delete']])
      await audit(page, 'chat row menu open')
      await menu.getByRole('menuitem', { name: t['chat.project.add'] }).click()
      const dialog = page.getByRole('dialog', { name: t['chat.project.title'] })
      await expect(dialog).toBeVisible()
      await dialog.getByRole('radio', { name: /Launch/ }).check()
      await audit(page, 'move dialog')
      await dialog.getByTestId('chat-project-save').click()
      await expect(dialog).toHaveCount(0)
      await expect(page.getByText(translate('ko', 'chat.project.moved', { name: 'Launch' }))).toBeVisible()
      await expect.poll(async () => ((await (await page.request.get(`/api/chats/${c.id}`)).json()) as { projectId: string | null }).projectId).toBe(id)
      // a computer: the keyboard back on the row's "…"
      if (!vp.phone) await expect(row.getByRole('button', { name: t['chat.menu'], exact: true })).toBeFocused()
      ;({ row, menu } = await rowMenu(page, 'Competitor notes'))
      await expect(menu.getByRole('menuitem', { name: t['chat.project.change'] })).toBeVisible()
      // the chat itself now names its project before its title
      await row.getByRole('button', { name: t['chat.menu'], exact: true }).click()
      await row.getByRole('link').click()
      await expect(page.getByTestId('chat-project')).toHaveText('Launch')
    })

    test('a shared project chat has no move in its row\'s "…" (it stays in its project)', async ({ page }) => {
      await reset(page)
      await signIn(page)
      const id = await project(page, 'Launch', 'marketing', true)
      const shared = await chat(page, 'Launch plan (shared)', id)
      expect(shared.shared).toBeTruthy()
      await chat(page, 'Competitor notes')
      await page.goto('/')
      const { menu } = await rowMenu(page, 'Launch plan (shared)')
      // mine: rename and delete, never the move
      await expect(menu.getByRole('menuitem')).toHaveText([t['chat.rename'], t['common.delete']])
      await expect(menu.getByTestId('chat-row-move')).toHaveCount(0)
      await audit(page, 'shared chat row menu open')
    })
  })
}
