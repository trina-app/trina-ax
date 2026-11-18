// The in-app browser always has its toolbar above the page (common/pane-chrome.ts): the page's title, ↗ (open in the
// person's own browser) and ✕. ✕ closes the browser and gives the space back to the team page; the AI's next page opens
// it again in the same tab. When the toolbar's own page ends (its renderer gone), the page is not left alone on screen:
// the toolbar loads again and the browser comes back with it.
// With SHOTS_DIR set, review screenshots of the whole window are saved there (open and closed, light and dark).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { ACME, addTeam, answer, call, chrome, close, launch, newTurn, newUserData, paneViews, result, SHOP, signIn, stopLeftoverApps, windowShot } from './helpers'

stopLeftoverApps()

const SHOTS = process.env.SHOTS_DIR

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

test('the toolbar shows the page title and ✕; ✕ frees the space; the next page reuses the tab; a lost toolbar comes back', async () => {
  test.setTimeout(120_000)
  const app = await launch(newUserData())
  try {
    const page = await signIn(await addTeam(app, 'acme.localhost:19151', ACME))
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setContentSize(1440, 900))
    // ↗ goes to the system; recorded here instead of opening a real browser
    await app.evaluate(({ shell }) => {
      const opened: string[] = []
      ;(globalThis as any).__opened = opened
      shell.openExternal = async (url: string) => {
        opened.push(url)
      }
    })
    const c = await chrome(app)

    newTurn()
    const first = await call(ACME, 'navigate', { url: `${SHOP}/` })
    await answer(app, '이번만 허용', 'site')
    expect((await result(ACME, first.callId)).result.ok).toBe(true)
    await expect.poll(async () => (await paneViews(app)).tab?.visible).toBe(true)

    // the toolbar above the page: the title, ↗ and ✕; the page starts under it
    await expect(c.getByTestId('pane-tab')).toHaveCount(1)
    await expect(c.getByTestId('pane-tab')).toContainText('Proto Shop')
    await expect(c.getByTestId('pane-close')).toBeVisible()
    await expect(c.getByTestId('pane-close')).toHaveAttribute('aria-label', '브라우저 닫기')
    const open = await paneViews(app)
    const toolbarBottom = await c.evaluate(() => document.getElementById('toolbar')!.getBoundingClientRect().bottom)
    expect(open.tab!.y).toBeGreaterThanOrEqual(Math.floor(toolbarBottom))
    expect(open.page!.width).toBeLessThan(1440)

    // ↗: the page's address in the person's own browser
    await expect(c.getByTestId('pane-open-external')).toBeEnabled()
    await c.getByTestId('pane-open-external').click()
    await expect.poll(() => app.evaluate(() => (globalThis as any).__opened as string[])).toEqual([`${SHOP}/`])

    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true })
      for (const dark of [false, true]) {
        await theme(app, page, dark)
        await page.waitForTimeout(300)
        await windowShot(app, join(SHOTS, `browser-open-${dark ? 'dark' : 'light'}.png`))
      }
      await theme(app, page, false)
    }

    // ✕: the browser closes and the team page takes the whole width again
    await c.getByTestId('pane-close').click()
    await expect.poll(async () => (await paneViews(app)).toolbar).toBeNull()
    const closed = await paneViews(app)
    expect(closed.tab).toBeNull()
    expect(closed.page!.width).toBe(1440)
    if (SHOTS) {
      for (const dark of [false, true]) {
        await theme(app, page, dark)
        await page.waitForTimeout(300)
        await windowShot(app, join(SHOTS, `browser-closed-${dark ? 'dark' : 'light'}.png`))
      }
      await theme(app, page, false)
    }

    // the AI opens another page: the browser opens again, in the same tab
    const second = await call(ACME, 'navigate', { url: `${SHOP}/slow?ms=50` })
    expect((await result(ACME, second.callId)).result.ok).toBe(true)
    await expect.poll(async () => (await paneViews(app)).tab?.url).toContain('/slow')
    await expect(c.getByTestId('pane-tab')).toHaveCount(1)
    await expect(c.getByTestId('pane-tab')).toContainText('Slow page')
    expect((await paneViews(app)).page!.width).toBe(open.page!.width)

    // the toolbar's renderer ends while the AI waits for the person's answer: the page is not left on screen without
    // it (the team page takes the width until the toolbar is back), the toolbar comes back by itself, with the question
    newTurn()
    const asking = await call(ACME, 'navigate', { url: `${SHOP}/` })
    await expect(c.getByTestId('permission-prompt')).toBeVisible()
    await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getURL().endsWith('/pane.html'))!.forcefullyCrashRenderer())
    await expect.poll(async () => (await paneViews(app)).page?.width, { intervals: [20] }).toBe(1440)
    // (Playwright keeps the crashed target: the reloaded toolbar is read and clicked through the main process)
    const inToolbar = (js: string) =>
      app.evaluate(({ webContents }, code) => {
        const w = webContents.getAllWebContents().find((x) => x.getURL().endsWith('/pane.html'))
        return w && !w.isCrashed() && !w.isLoading() ? w.executeJavaScript(code) : null
      }, js)
    const toolbar = () => inToolbar(`({ close: !!document.querySelector('[data-testid=pane-close]'), tab: document.querySelector('[data-testid=pane-tab]')?.textContent ?? '', asks: !!document.querySelector('[data-testid=permission-prompt]') })`)
    await expect.poll(toolbar, { timeout: 15_000 }).toEqual({ close: true, tab: expect.stringContaining('Slow page'), asks: true })
    await expect.poll(async () => (await paneViews(app)).tab?.visible).toBe(true)
    const again = await paneViews(app)
    expect(again.toolbar).not.toBeNull()
    expect(again.page!.width).toBe(open.page!.width)
    // the question shown again is answered there, and the AI's step goes on
    await inToolbar(`[...document.querySelectorAll('[data-testid=permission-prompt] button')].find((b) => b.textContent === '이번만 허용').click()`)
    expect((await result(ACME, asking.callId)).result.ok).toBe(true)
    await expect.poll(toolbar).toEqual({ close: true, tab: expect.stringContaining('Proto Shop'), asks: false })
    // and its ✕ still closes the browser
    await inToolbar(`document.querySelector('[data-testid=pane-close]').click()`)
    await expect.poll(async () => (await paneViews(app)).page?.width).toBe(1440)
  } finally {
    await close(app)
  }
})

test('the 🌐 button with no page yet: the toolbar, one plain line and the address bar; ✕ or 🌐 again closes it', async () => {
  test.setTimeout(90_000)
  const app = await launch(newUserData())
  try {
    const page = await signIn(await addTeam(app, 'acme.localhost:19151', ACME))
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setContentSize(1440, 900))
    const c = await chrome(app)
    // the chat header's 🌐 (web/src/pages/Chat.tsx BrowserToggle) calls this
    const toggle = () => page.evaluate(() => (window as any).mycelDesktop.pane.toggle())
    const pageOpen = () => page.evaluate(async () => ((await (window as any).mycelDesktop.pane.getState()) as { open: boolean } | null)?.open)

    await toggle()
    await expect(c.getByTestId('pane-close')).toBeVisible()
    await expect(c.getByTestId('pane-stage')).toContainText('AI가 브라우저를 쓰면 여기에 보여요')
    await expect(c.getByTestId('pane-address')).toBeVisible()
    await expect(c.getByTestId('pane-open-external')).toBeDisabled()
    await expect.poll(async () => (await paneViews(app)).toolbar).not.toBeNull()
    expect((await paneViews(app)).page!.width).toBeLessThan(1440)
    expect(await pageOpen()).toBe(true)
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true })
      for (const dark of [false, true]) {
        await theme(app, page, dark)
        await page.waitForTimeout(300)
        await windowShot(app, join(SHOTS, `browser-empty-${dark ? 'dark' : 'light'}.png`))
      }
      await theme(app, page, false)
    }

    // ✕ closes it and gives the width back
    await c.getByTestId('pane-close').click()
    await expect.poll(async () => (await paneViews(app)).page?.width).toBe(1440)
    expect((await paneViews(app)).toolbar).toBeNull()
    expect(await pageOpen()).toBe(false)

    // 🌐 opens it again, and 🌐 once more closes it
    await toggle()
    await expect.poll(async () => (await paneViews(app)).page?.width).toBeLessThan(1440)
    await expect(c.getByTestId('pane-close')).toBeVisible()
    await toggle()
    await expect.poll(async () => (await paneViews(app)).page?.width).toBe(1440)
    expect(await pageOpen()).toBe(false)
  } finally {
    await close(app)
  }
})
