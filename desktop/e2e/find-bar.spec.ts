// Cmd/Ctrl+F (Edit › Find…): the find bar over the screen in front (main/find-bar.ts, common/find-bar.ts). It searches
// the team page or the in-app browser's tab, whichever has the keyboard; the selection fills it; "N of M"; Enter / Cmd+G
// next, Shift+Enter / Shift+Cmd+G back; Esc closes it and clears the highlights. The bar's own text is in its own view,
// so it never counts itself. The menu items are clicked here: keys made up by a test never reach the macOS menu (the
// system's key equivalents need a real key press).
// With SHOTS_DIR set, review screenshots of the window are saved there (wide and narrow, light and dark).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { ACME, addTeam, answer, call, close, launch, newTurn, newUserData, paneViews, result, SHOP, signIn, stopLeftoverApps, view, windowShot } from './helpers'

stopLeftoverApps()

const SHOTS = process.env.SHOTS_DIR

const menu = (app: ElectronApplication, id: 'find' | 'find-next' | 'find-prev') =>
  app.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu()!.getMenuItemById(id)!
    ;(item.click as () => void)()
  }, id)

const findBar = (app: ElectronApplication) => view(app, (u) => u.endsWith('/findbar.html'))

/** where the bar's view is in the window, or null when it is not in it */
const barBox = (app: ElectronApplication) =>
  app.evaluate(({ BaseWindow }) => {
    const win = BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!
    const kids = win.contentView.children as (Electron.View & { webContents?: Electron.WebContents })[]
    const at = kids.findIndex((v) => v.webContents && !v.webContents.isDestroyed() && v.webContents.getURL().endsWith('/findbar.html'))
    return at < 0 ? null : { ...kids[at]!.getBounds(), top: at === kids.length - 1 }
  })

/** give a view the keyboard the way a click into it would */
const focusView = (app: ElectronApplication, prefix: string) =>
  app.evaluate(({ BaseWindow }, prefix) => {
    const win = BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!
    const v = (win.contentView.children as (Electron.View & { webContents?: Electron.WebContents })[]).find((x) => x.webContents?.getURL().startsWith(prefix))!
    v.webContents!.focus()
  }, prefix)

async function theme(app: ElectronApplication, page: Page, dark: boolean) {
  await app.evaluate(({ nativeTheme }, d) => {
    nativeTheme.themeSource = d ? 'dark' : 'light'
  }, dark)
  for (const p of app.windows()) if (p.url().startsWith('mycel-ui:')) await p.emulateMedia({ colorScheme: dark ? 'dark' : 'light' })
  await page.evaluate((d) => {
    document.documentElement.style.background = d ? '#0e0c0b' : ''
    document.documentElement.style.color = d ? '#f6f2ea' : ''
  }, dark)
}

const TEXT = `<main id="doc" style="font: 15px/1.6 system-ui; padding: 24px 32px; max-width: 760px">
  <h1>Weekly notes</h1>
  <p>The apple order for the cafe goes out on Monday. Sana checks the apple prices first.</p>
  <p id="sel">Quarterly banana report</p>
  <p>Last week the apple delivery came late; the driver called at noon.</p>
  <input id="box" value="pear" />
</main>`

test('Cmd+F on the team page: selection, N of M, next / previous, no self-match, Esc closes', async () => {
  test.setTimeout(150_000)
  const app = await launch(newUserData())
  try {
    const page = await signIn(await addTeam(app, 'acme.localhost:19151', ACME))
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setContentSize(1440, 900))
    await page.evaluate((html) => {
      document.body.innerHTML = html
    }, TEXT)
    await focusView(app, ACME)

    // Edit › Find… with nothing selected: an empty field with the keyboard in it
    await menu(app, 'find')
    const bar = await findBar(app)
    const field = bar.getByTestId('find-field')
    await expect(field).toBeFocused()
    await expect(field).toHaveValue('')
    await expect(field).toHaveAttribute('aria-label', '이 화면에서 찾기')

    // over the team page's top-right corner, above every other view
    const box = (await barBox(app))!
    const views = await paneViews(app)
    expect(box.top).toBe(true)
    expect(box.x + box.width).toBeLessThanOrEqual(views.page!.x + views.page!.width)
    expect(box.x).toBeGreaterThan(views.page!.x + views.page!.width / 2)
    expect(box.y).toBe(views.page!.y)

    // typing searches: three on the page; the field's own "apple" is not one of them
    await field.fill('apple')
    await expect(bar.getByTestId('find-count')).toHaveText('1/3')
    await field.press('Enter')
    await expect(bar.getByTestId('find-count')).toHaveText('2/3')
    await field.press('Shift+Enter')
    await expect(bar.getByTestId('find-count')).toHaveText('1/3')
    await field.press(process.platform === 'darwin' ? 'Meta+g' : 'Control+g')
    await expect(bar.getByTestId('find-count')).toHaveText('2/3')
    // the menu's Find Next / Find Previous (Cmd+G, Shift+Cmd+G while the page has the keyboard)
    await menu(app, 'find-next')
    await expect(bar.getByTestId('find-count')).toHaveText('3/3')
    await menu(app, 'find-next')
    await expect(bar.getByTestId('find-count')).toHaveText('1/3')
    await menu(app, 'find-prev')
    await expect(bar.getByTestId('find-count')).toHaveText('3/3')
    // the buttons
    await bar.getByTestId('find-next').click()
    await expect(bar.getByTestId('find-count')).toHaveText('1/3')
    await bar.getByTestId('find-prev').click()
    await expect(bar.getByTestId('find-count')).toHaveText('3/3')

    // a word that is not there; the text in an input of the page is found (as in a browser), the bar's own is not
    await field.fill('kiwi')
    await expect(bar.getByTestId('find-count')).toHaveText('결과 없음')
    await expect(bar.getByTestId('find-next')).toBeDisabled()
    await field.fill('')
    await expect(bar.getByTestId('find-count')).toHaveText('')

    // Esc: the bar leaves the window and the keyboard goes back to the page
    await field.fill('apple')
    await expect(bar.getByTestId('find-count')).toHaveText('1/3')
    await field.press('Escape')
    await expect.poll(() => barBox(app)).toBeNull()
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true)

    // the selection fills it (its first line), and is searched at once
    await page.evaluate(() => {
      const r = document.createRange()
      r.selectNodeContents(document.getElementById('sel')!)
      getSelection()!.removeAllRanges()
      getSelection()!.addRange(r)
    })
    await menu(app, 'find')
    await expect(field).toHaveValue('Quarterly banana report')
    await expect(bar.getByTestId('find-count')).toHaveText('1/1')
    await expect(field).toBeFocused()

    // Cmd+F again in the open bar: the same page, the text selected for typing over
    await menu(app, 'find')
    await expect.poll(() => bar.evaluate(() => { const i = document.querySelector('input')!; return [i.selectionStart, i.selectionEnd] })).toEqual([0, 'Quarterly banana report'.length])

    // the language follows the app
    await page.evaluate(() => (window as any).mycelDesktop.setLocale('en'))
    await expect(field).toHaveAttribute('aria-label', 'Find on this page')
    await expect(bar.getByTestId('find-count')).toHaveText('1 of 1')

    // a new word: Chromium starts it where the page's selection is, as a browser does (not always the first)
    await field.fill('apple')
    await expect(bar.getByTestId('find-count')).toHaveText(/^[1-3] of 3$/)
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true })
      for (const dark of [false, true]) {
        await theme(app, page, dark)
        await page.waitForTimeout(300)
        await windowShot(app, join(SHOTS, `find-page-1440-${dark ? 'dark' : 'light'}.png`))
      }
      await theme(app, page, false)
    }

    // the team list over the page (Team › Teams…): the bar goes with the page
    await app.evaluate(({ Menu }) => {
      const items = Menu.getApplicationMenu()!.items.flatMap((m) => m.submenu?.items ?? [])
      ;(items.find((i) => i.label === 'Teams…')!.click as () => void)()
    })
    await expect.poll(() => barBox(app)).toBeNull()
  } finally {
    await close(app)
  }
})

test('Cmd+F in the in-app browser searches its tab; the bar sits over the tab and goes when the browser closes', async () => {
  test.setTimeout(150_000)
  const app = await launch(newUserData())
  try {
    const page = await signIn(await addTeam(app, 'acme.localhost:19151', ACME))
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setContentSize(1440, 900))
    await page.evaluate((html) => {
      document.body.innerHTML = html
    }, TEXT)
    newTurn()
    const nav = await call(ACME, 'navigate', { url: `${SHOP}/` })
    await answer(app, '이번만 허용', 'site')
    expect((await result(ACME, nav.callId)).result.ok).toBe(true)
    await expect.poll(async () => (await paneViews(app)).tab?.visible).toBe(true)

    // the keyboard in the tab: Cmd+F searches the shop page, not the team page
    await focusView(app, SHOP)
    await menu(app, 'find')
    const bar = await findBar(app)
    const field = bar.getByTestId('find-field')
    await field.fill('Proto Shop')
    await expect(bar.getByTestId('find-count')).toHaveText(/^1\/\d+$/)
    await field.fill('apple')
    await expect(bar.getByTestId('find-count')).toHaveText('결과 없음')
    const v = await paneViews(app)
    const box = (await barBox(app))!
    expect(box.x).toBeGreaterThanOrEqual(v.tab!.x)
    expect(box.x + box.width).toBeLessThanOrEqual(v.tab!.x + v.tab!.width)
    expect(box.y).toBe(v.tab!.y)
    expect(box.top).toBe(true)

    // the team page has the keyboard: Cmd+F moves the bar there
    await field.press('Escape')
    await focusView(app, ACME)
    await menu(app, 'find')
    await field.fill('apple')
    await expect(bar.getByTestId('find-count')).toHaveText('1/3')
    const onPage = (await barBox(app))!
    expect(onPage.x + onPage.width).toBeLessThanOrEqual(v.page!.x + v.page!.width)

    // a narrow window: the team page beside the browser is narrow, the bar still fits inside it
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setContentSize(900, 640))
    await expect.poll(async () => (await paneViews(app)).page!.width).toBeLessThan(700)
    await expect.poll(async () => {
      const p = (await paneViews(app)).page!
      const b = (await barBox(app))!
      return b.x >= p.x && b.x + b.width <= p.x + p.width && b.top
    }).toBe(true)
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true })
      for (const dark of [false, true]) {
        await theme(app, page, dark)
        await page.waitForTimeout(300)
        await windowShot(app, join(SHOTS, `find-page-narrow-900-${dark ? 'dark' : 'light'}.png`))
      }
      await theme(app, page, false)
      // the bar over the in-app browser's tab, narrow
      await field.press('Escape')
      await focusView(app, SHOP)
      await menu(app, 'find')
      await field.fill('shop')
      await expect(bar.getByTestId('find-count')).toHaveText(/^1\/\d+$/)
      for (const dark of [false, true]) {
        await theme(app, page, dark)
        await page.waitForTimeout(300)
        await windowShot(app, join(SHOTS, `find-tab-narrow-900-${dark ? 'dark' : 'light'}.png`))
      }
      await theme(app, page, false)
      await field.press('Escape')
      await focusView(app, ACME)
      await menu(app, 'find')
    }

    // the browser closes under a bar over its tab: the bar closes; over the page it stays
    await field.press('Escape')
    await focusView(app, SHOP)
    await menu(app, 'find')
    await expect.poll(async () => (await barBox(app))?.x ?? 0).toBeGreaterThanOrEqual((await paneViews(app)).tab!.x)
    await (await view(app, (u) => u.endsWith('/pane.html'))).getByTestId('pane-close').click()
    await expect.poll(() => barBox(app)).toBeNull()
  } finally {
    await close(app)
  }
})

test('a closed find bar leaves the keyboard alone: the page keeps it after the bar was used and closed', async () => {
  const app = await launch(newUserData())
  try {
    const page = await signIn(await addTeam(app, 'acme.localhost:19151', ACME))
    await page.evaluate((html) => {
      document.body.innerHTML = html
    }, TEXT)
    await focusView(app, ACME)
    await menu(app, 'find')
    const bar = await findBar(app)
    await bar.getByTestId('find-field').fill('apple')
    await bar.getByTestId('find-field').press('Escape')
    await expect.poll(() => barBox(app)).toBeNull()
    await page.locator('#box').focus()
    // another view of the app takes the keyboard and gives it back: the page's field still has it
    await app.evaluate(({ BaseWindow }) => {
      const win = BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!
      win.blur()
      win.focus()
    })
    await expect.poll(() => page.evaluate(() => document.hasFocus() && document.activeElement?.id)).toBe('box')
  } finally {
    await close(app)
  }
})
