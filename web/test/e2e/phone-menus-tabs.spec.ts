// Menus and tabs on a phone (390×844, touch), in Korean and English (QA TC-249, TC-250): every menu below opens as the
// app's one bottom sheet (components/rooms/MenuButton.tsx: a scrim, rows of 44px or more, the destructive one last, over
// the tab bar), and a segmented row of tabs fits the width with no sideways scroll or scrollbar (components/ui.tsx Tabs;
// a row that cannot fit is one picker row that opens a sheet). The screens: the chat and project title ⌄, Team skills'
// tabs and a row's ⋯, Scheduled tasks ("+" and "Edit" in the bar, a red Delete row), the drawer's filter, the search
// overlay (its types and a chat row's ⋯), Activity's tabs and tools. With SHOTS=1 each step is saved in
// $SHOTS_DIR (default test-results/phone-menus-tabs).
import { expect, test, type Locator, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

const W = 390, H = 844
const H_ = { [CSRF_HEADER]: '1' }
const shot = async (page: Page, name: string) => {
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS_DIR ?? 'test-results/phone-menus-tabs'}/${name}.png` })
}

/** The open sheet: full width, from the bottom edge (over the tab bar), every row 44px or more. */
async function isSheet(sheet: Locator) {
  await expect(sheet).toBeVisible()
  const box = (await sheet.boundingBox())!
  expect(Math.round(box.x)).toBe(0)
  expect(Math.round(box.width)).toBe(W)
  expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(H - 1)
  for (const row of await sheet.locator('[role^="menuitem"]').all()) expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  // nothing over it where a finger lands: the first row's middle is the row
  const first = (await sheet.locator('[role^="menuitem"]').first().boundingBox())!
  expect(await sheet.page().evaluate(([x, y]) => !!document.elementFromPoint(x!, y!)?.closest('[role="menu"]'), [first.x + first.width / 2, first.y + first.height / 2])).toBe(true)
}

/** A control is 44px or more both ways. */
async function big(el: Locator) {
  const b = (await el.boundingBox())!
  expect(Math.round(b.height)).toBeGreaterThanOrEqual(44)
  expect(Math.round(b.width)).toBeGreaterThanOrEqual(44)
}

/** The page never scrolls sideways. */
const fitsPage = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

async function start(page: Page, lang: 'ko' | 'en') {
  await reset(page, { teamLocale: lang, usersFollowTeam: true })
  await signIn(page)
}

for (const lang of ['ko', 'en'] as const) {
  const t = DICTS[lang]
  test.describe(`a phone in ${lang}`, () => {
    test.use({ locale: lang === 'ko' ? 'ko-KR' : 'en-US' })

    test('Team skills: the four tabs fit the width, 44px; a row\'s ⋯ is a sheet with the name and no path; the review\'s Preview / Edit fit', async ({ page }) => {
      await start(page, lang)
      expect((await page.request.post('/__test/skills', { headers: H_, data: { files: [{ path: 'skills/weekly-report/SKILL.md', name: 'weekly-report', description: 'Turn the week into a short report' }] } })).ok()).toBeTruthy()
      const me = (await (await page.request.get('/api/me')).json()) as { user: { id: string } }
      const made = await page.request.post('/api/skills/suggestions', { headers: H_, data: { source: { kind: 'file', path: `users/${me.user.id}/tone.md` }, name: 'Mail tone', content: '# Mail tone\n\nShort and kind.' } })
      expect(made.status()).toBe(201)
      await page.goto('/skills')
      const tabs = page.getByTestId('skills-header').getByRole('tablist')
      await expect(tabs.getByRole('tab')).toHaveText([t['skills.tabSkillsShort'], `${t['skills.tabReviewShort']} (1)`, t['skills.tabMineShort'], t['skills.tabChangesShort']])
      // the row is the width of the page (16px each side), never scrolls, every word whole
      const row = (await tabs.boundingBox())!
      expect(Math.round(row.x)).toBe(16)
      expect(Math.round(row.width)).toBe(W - 32)
      expect(await tabs.evaluate((el) => el.scrollWidth <= el.clientWidth && getComputedStyle(el).overflowX !== 'auto')).toBe(true)
      for (const tab of await tabs.getByRole('tab').all()) {
        expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(44)
        expect(await tab.locator('span').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      }
      expect(await fitsPage(page)).toBe(true)
      await shot(page, `${lang}-skills-tabs`)
      // the review tab: the suggestion's dialog, Preview / Edit as one segmented row of 44px
      await tabs.getByRole('tab', { name: new RegExp(t['skills.tabReviewShort']) }).click()
      await page.getByTestId('review-open').first().click()
      const dialog = page.getByTestId('review-dialog')
      const toggles = dialog.getByRole('tablist')
      await expect(toggles.getByRole('tab')).toHaveText([t['skills.preview'], t['skills.edit']])
      for (const tab of await toggles.getByRole('tab').all()) expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      await toggles.getByRole('tab', { name: t['skills.edit'] }).click()
      await expect(dialog.getByTestId('review-content')).toBeVisible()
      await shot(page, `${lang}-skills-review`)
      await page.keyboard.press('Escape')

      // a row's ⋯: 44px, a sheet with the skill's name on top, its three actions, and no path
      await tabs.getByRole('tab', { name: t['skills.tabSkillsShort'] }).click()
      const more = page.getByTestId('skill-row').filter({ hasText: 'weekly-report' }).getByTestId('skill-more')
      await big(more)
      await more.click()
      const sheet = page.getByRole('menu')
      await isSheet(sheet)
      await expect(sheet.getByTestId('menu-sheet-title')).toHaveText('/weekly-report')
      await expect(sheet.getByRole('menuitem')).toHaveText([t['skills.use'], t['skills.viewFile'], t['skills.move']])
      await expect(page.getByTestId('skill-path')).toHaveCount(0)
      await shot(page, `${lang}-skills-more`)
      await sheet.getByTestId('skill-file').click()
      await expect(page).toHaveURL(/\/files\?path=skills%2Fweekly-report/)
    })

    test('Activity: four tabs share the width, 44px, words only; Unreads a filled pill; the search in the top bar', async ({ page }) => {
      await start(page, lang)
      await page.goto('/activity')
      const tabs = page.getByTestId('activity-tabs')
      const names = [t['feed.tab.all'], t['feed.tab.dmsShort'], t['feed.tab.mentions'], t['feed.tab.threads']]
      await expect(tabs.getByRole('tab')).toHaveCount(4)
      for (const [i, name] of names.entries()) await expect(tabs.getByRole('tab').nth(i)).toHaveAccessibleName(name)
      expect(await tabs.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      const widths: number[] = []
      for (const tab of await tabs.getByRole('tab').all()) {
        const b = (await tab.boundingBox())!
        expect(b.height).toBeGreaterThanOrEqual(44)
        expect(b.x + b.width).toBeLessThanOrEqual(W)
        widths.push(Math.round(b.width))
        await expect(tab.locator('svg')).toBeHidden()
        expect(await tab.locator('span.truncate').first().evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      }
      expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1)
      // the tools: a filled pill (no outline) and the gear, 44px; the search is the bar's one action
      const unreads = page.getByTestId('activity-unreads')
      expect((await unreads.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      expect(await unreads.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe('rgba(0, 0, 0, 0)')
      await big(page.getByTestId('activity-settings-phone'))
      const search = page.getByTestId('phone-page-bar').getByTestId('activity-search-open')
      await big(search)
      await shot(page, `${lang}-activity`)
      await search.click()
      await expect(page.getByTestId('activity-search')).toBeFocused()
      expect((await page.getByTestId('activity-search').boundingBox())!.height).toBeGreaterThanOrEqual(44)
      await expect(page.getByTestId('activity-search-open')).toHaveCount(0)
      await shot(page, `${lang}-activity-search`)
      await page.getByTestId('activity-search-clear').click()
      await expect(page.getByTestId('phone-page-bar').getByTestId('activity-search-open')).toBeVisible()
      expect(await fitsPage(page)).toBe(true)
    })

    test('search: the types are one picker that opens a sheet; no row lit before a tap; a chat row\'s ⋯ is a sheet', async ({ page }) => {
      await start(page, lang)
      await page.getByTestId('composer-input').fill('quarterly budget notes')
      await page.getByTestId('send').click()
      await expect(page.locator('[data-testid="assistant-message"][data-status="done"]')).toHaveCount(1)
      await page.getByTestId('chat-back').click()
      await page.getByTestId('menu-open').click()
      await page.getByRole('button', { name: t['sidebar.search'] }).first().click()
      const palette = page.getByTestId('search-palette')
      await expect(palette).toBeVisible()
      // no row of chips that scrolls: one picker, 44px
      await expect(palette.getByRole('tablist')).toHaveCount(0)
      const type = palette.getByTestId('search-type')
      await expect(type).toHaveText(t['search.tab.all'])
      expect((await type.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      // the first row is not drawn as already tapped
      const first = palette.getByRole('option').first()
      await expect(first).toBeVisible()
      expect(await first.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
      await shot(page, `${lang}-search`)
      await type.click()
      const sheet = page.getByRole('menu', { name: t['search.types'] })
      await isSheet(sheet)
      await expect(sheet.getByRole('menuitemradio')).toHaveText(['all', 'chats', 'projects', 'files', 'skills', 'scheduled', 'mcp'].map((x) => t[`search.tab.${x}` as keyof typeof t]))
      await expect(sheet.getByRole('menuitemradio', { checked: true })).toHaveText(t['search.tab.all'])
      await shot(page, `${lang}-search-types`)
      await sheet.getByTestId('search-type-chats').click()
      await expect(sheet).toHaveCount(0)
      await expect(type).toHaveText(t['search.tab.chats'])
      // a chat row: its ⋯ is 44px on every chat row, and opens a sheet with the chat's name and Delete last
      const row = palette.getByRole('option').filter({ hasText: 'quarterly budget notes' }).first()
      const more = row.getByTestId('search-row-more')
      await big(more)
      await more.click()
      const actions = page.getByRole('menu', { name: t['search.rowActions'] })
      await isSheet(actions)
      await expect(actions.getByTestId('menu-sheet-title')).toContainText('quarterly budget notes')
      await expect(actions.getByRole('menuitem')).toHaveText([t['chat.rename'], t['rooms.menu.copyLink'], t['common.delete']])
      await shot(page, `${lang}-search-row`)
      // a tap on the scrim closes the sheet, the search stays
      await page.mouse.click(W / 2, 40)
      await expect(actions).toHaveCount(0)
      await expect(palette).toBeVisible()
      // a long press on the row opens the same sheet; the finger lifting opens no chat
      const at = { button: 0, pointerType: 'touch', isPrimary: true, clientX: 100, clientY: 100 }
      await row.dispatchEvent('pointerdown', at)
      await page.waitForTimeout(650)
      await row.dispatchEvent('pointerup', at)
      await isSheet(actions)
      await expect(palette).toBeVisible()
      await page.waitForTimeout(450)
      await page.mouse.click(W / 2, 40)
      await expect(actions).toHaveCount(0)
      expect(await fitsPage(page)).toBe(true)
    })

    test('Scheduled tasks: "+" in the bar opens a sheet; a task has Edit in the bar and a red Delete row', async ({ page }) => {
      await reset(page, { teamLocale: lang, usersFollowTeam: true })
      expect((await page.request.post('/__test/schedule', { data: {} })).ok()).toBeTruthy()
      await signIn(page)
      await page.goto('/scheduled')
      await expect(page.getByTestId('schedule-item')).toHaveCount(1)
      await expect(page.getByTestId('new-task')).toHaveCount(0)
      const add = page.getByTestId('phone-page-bar').getByTestId('new-task-phone')
      await big(add)
      expect((await page.getByTestId('scheduled-search').boundingBox())!.height).toBeGreaterThanOrEqual(44)
      await shot(page, `${lang}-scheduled`)
      await add.click()
      const sheet = page.getByRole('menu')
      await isSheet(sheet)
      await expect(sheet.getByTestId('menu-sheet-title')).toHaveText(t['scheduled.newTask'])
      await expect(sheet.getByRole('menuitem')).toHaveText([t['scheduled.newInChat'], t['scheduled.newFromTemplate']])
      await shot(page, `${lang}-scheduled-new`)
      await sheet.getByTestId('new-task-template').click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await page.keyboard.press('Escape')

      await page.getByTestId('schedule-item').click()
      await expect(page.getByTestId('schedule-view')).toBeVisible()
      // no second bar with the name as a menu: Edit is in the top bar, Delete a red row at the end
      await expect(page.getByTestId('scheduled-topline')).toBeHidden()
      const edit = page.getByTestId('phone-page-bar').getByTestId('schedule-edit-bar')
      await expect(edit).toHaveText(t['common.edit'])
      expect((await edit.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      const del = page.getByTestId('schedule-delete-row')
      await del.scrollIntoViewIfNeeded()
      await expect(del).toHaveText(t['schedules.delete'])
      expect((await del.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      expect(await del.evaluate((el) => getComputedStyle(el).color)).toBe(await page.evaluate(() => { const e = document.createElement('span'); e.className = 'text-danger'; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c }))
      await shot(page, `${lang}-scheduled-task`)
      await edit.click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await page.keyboard.press('Escape')
      await del.click()
      await page.getByRole('dialog').getByRole('button', { name: t['schedules.delete'] }).click()
      await expect(page).toHaveURL(/\/scheduled$/)
      await expect(page.getByTestId('scheduled-empty')).toBeVisible()
    })

    test('the chat and project title ⌄ open a sheet with the name on top, Delete last', async ({ page }) => {
      await start(page, lang)
      await page.getByTestId('composer-input').fill('weekly sync notes')
      await page.getByTestId('send').click()
      await expect(page.locator('[data-testid="assistant-message"][data-status="done"]')).toHaveCount(1)
      const title = page.getByTestId('chat-menu')
      expect((await title.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      await title.click()
      const sheet = page.getByRole('menu')
      await isSheet(sheet)
      await expect(sheet.getByTestId('menu-sheet-title')).toHaveText(await title.innerText())
      await expect(sheet.getByRole('menuitem').last()).toHaveText(t['common.delete'])
      await shot(page, `${lang}-chat-title`)
      await sheet.getByTestId('chat-rename').click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await page.keyboard.press('Escape')

      const p = await page.request.post('/api/projects', { headers: H_, data: { name: 'Launch plan', scope: 'team', folderPath: 'marketing', instructions: '' } })
      const id = ((await p.json()) as { id: string }).id
      await page.goto(`/projects/${id}`)
      const name = page.getByTestId('project-menu')
      expect((await name.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      await name.click()
      await isSheet(page.getByRole('menu'))
      await expect(page.getByRole('menu').getByTestId('menu-sheet-title')).toHaveText('Launch plan')
      await expect(page.getByRole('menu').getByRole('menuitem').last()).toHaveText(t['common.delete'])
      await shot(page, `${lang}-project-title`)
      await page.getByTestId('project-edit').click()
      await expect(page.getByRole('dialog')).toBeVisible()
    })

    test('the drawer\'s filter: four rows with their values as a sheet, a row\'s choices as a second sheet', async ({ page }) => {
      await start(page, lang)
      await page.getByTestId('composer-input').fill('first chat')
      await page.getByTestId('send').click()
      await expect(page.locator('[data-testid="assistant-message"][data-status="done"]')).toHaveCount(1)
      await page.getByTestId('chat-back').click()
      await page.getByTestId('menu-open').click()
      const drawer = page.locator('[data-drawer]')
      const filter = drawer.getByTestId('recents-filter')
      // a small square in the line of 트리나 기록, taking taps from 44px around it (touch-hit)
      expect(await filter.evaluate((el) => { const a = getComputedStyle(el, '::after'); return Math.min(parseFloat(a.width), parseFloat(a.height)) })).toBeGreaterThanOrEqual(44)
      await filter.click()
      const sheet = page.getByRole('menu', { name: t['sidebar.filter'] })
      await isSheet(sheet)
      await expect(sheet.getByRole('menuitem')).toHaveText([
        `${t['sidebar.view.status']}· ${t['sidebar.status.all']}`,
        `${t['sidebar.view.activity']}· ${t['sidebar.activity.all']}`,
        `${t['sidebar.view.group']}· ${t['sidebar.group.date']}`,
        `${t['sidebar.view.sort']}· ${t['sidebar.sort.updated']}`,
      ])
      await shot(page, `${lang}-drawer-filter`)
      await sheet.getByTestId('recents-view-sort').click()
      const choices = page.getByRole('menu', { name: t['sidebar.view.sort'] })
      await isSheet(choices)
      await expect(choices.getByRole('menuitemradio', { checked: true })).toHaveText(t['sidebar.sort.updated'])
      await shot(page, `${lang}-drawer-filter-sort`)
      await choices.getByTestId('recents-sort-title').click()
      await expect(choices).toHaveCount(0)
      await expect(drawer.getByTestId('recents-filter-dot')).toBeVisible()
      await filter.click()
      await expect(page.getByRole('menu', { name: t['sidebar.filter'] }).getByTestId('recents-view-sort')).toContainText(t['sidebar.sort.title'])
    })

    test('Folder permissions: its two tabs fit the width as one segmented row', async ({ page }) => {
      await start(page, lang)
      await page.goto('/admin/folders')
      const tabs = page.getByRole('tablist', { name: t['accessView.tabs'] })
      await expect(tabs.getByRole('tab')).toHaveText([t['accessView.byFolder'], t['accessView.byPerson']])
      expect(await tabs.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      for (const tab of await tabs.getByRole('tab').all()) expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      expect(await fitsPage(page)).toBe(true)
      await shot(page, `${lang}-folders-tabs`)
    })
  })
}

test('a narrow phone: tabs whose words do not fit their share become one picker row with a sheet', async ({ page }) => {
  const t = DICTS.en
  await page.setViewportSize({ width: 280, height: 653 })
  await start(page, 'en')
  await page.goto('/skills')
  const header = page.getByTestId('skills-header')
  await expect(header.getByRole('tablist')).toHaveCount(0)
  const picker = header.getByTestId('tabs-picker')
  await expect(picker).toHaveText(t['skills.tabSkills'])
  expect((await picker.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await picker.click()
  const sheet = page.getByRole('menu', { name: t['skills.title'] })
  await expect(sheet.getByRole('menuitemradio')).toHaveText([t['skills.tabSkills'], t['skills.tabReview'], t['skills.tabMine'], t['skills.tabChanges']])
  await expect(sheet.getByRole('menuitemradio', { checked: true })).toHaveText(t['skills.tabSkills'])
  await sheet.getByTestId('tabs-pick-mine').click()
  await expect(picker).toHaveText(t['skills.tabMine'])
  // the panel is named by the picker (the chosen tab's place)
  await expect(page.getByRole('tabpanel')).toHaveAccessibleName(`${t['skills.title']}: ${t['skills.tabMine']}`)
  expect(await fitsPage(page)).toBe(true)
  await shot(page, 'en-skills-picker')
})
