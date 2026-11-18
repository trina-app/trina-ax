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

    // the toolbar's renderer ends: the page is not left on screen without it, and the toolbar comes back by itself
    await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getURL().endsWith('/pane.html'))!.forcefullyCrashRenderer())
    // (Playwright keeps the crashed target: the reloaded toolbar is read through the main process)
    const toolbar = () =>
      app.evaluate(({ webContents }) => {
        const w = webContents.getAllWebContents().find((x) => x.getURL().endsWith('/pane.html'))
        return w && !w.isCrashed() && !w.isLoading()
          ? w.executeJavaScript(`({ close: !!document.querySelector('[data-testid=pane-close]'), tab: document.querySelector('[data-testid=pane-tab]')?.textContent ?? '' })`)
          : null
      })
    await expect.poll(toolbar, { timeout: 15_000 }).toEqual({ close: true, tab: expect.stringContaining('Slow page') })
    await expect.poll(async () => (await paneViews(app)).tab?.visible).toBe(true)
    const again = await paneViews(app)
    expect(again.toolbar).not.toBeNull()
    expect(again.page!.width).toBe(open.page!.width)
    // and its ✕ still closes the browser
    await app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().find((x) => x.getURL().endsWith('/pane.html'))!.executeJavaScript(`document.querySelector('[data-testid=pane-close]').click()`),
    )
    await expect.poll(async () => (await paneViews(app)).page?.width).toBe(1440)
  } finally {
    await close(app)
  }
})
